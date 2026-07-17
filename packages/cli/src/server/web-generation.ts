import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { resolveLocalSource } from "./repository-source";
import { cachedRemoteGraph, webAnalysisKey } from "./web-cache";
import { artifactId, remoteArtifactId } from "./web-request";
import type { GenerateRequest } from "./web-request";
import type { Context } from "./web-server";
import { artifactSourceFor } from "./web-source";
import { createPrivateDirectory } from "./web-cache-storage";
import type { SerializablePipelineRequest } from "./extraction-worker";
import { GRAPH_PROJECTION_DIRECTORY } from "./graph-projection-bundle";
import {
  finalizedGenerationDirectory,
  localArtifactGenerations,
} from "./graph-cache-layout";
import {
  freezeGraphGenerationDirectory,
  sealGraphGeneration,
  verifyExistingGraphGeneration,
} from "./graph-generation-verifier";
import type { GraphGenerationLease } from "./graph-generation-lifecycle";
import { withOwnershipCleanup } from "./ownership-cleanup";

export interface GenerateResult {
  id: string;
  target: string;
  counts: { nodes: number; edges: number };
  warnings: string[];
  cache: "hit" | "miss" | "bypass";
  checkoutCache: "hit" | "miss" | "bypass";
}

export type GenerateStage = "cache" | "source" | "extract";
type StageReporter = (stage: GenerateStage) => void | Promise<void>;

/** Resolve, cache when remote, extract when needed, and register one graph with its source tree. */
export function generateGraph(
  ctx: Context,
  request: GenerateRequest,
  token: string | undefined,
  onStage: StageReporter = () => {},
  signal?: AbortSignal,
  extractionAdmitted = false,
): Promise<GenerateResult> {
  return request.kind === "github"
    ? generateRemote(ctx, request, token, onStage, signal, extractionAdmitted)
    : generateLocal(ctx, request, onStage, signal, extractionAdmitted);
}

async function generateRemote(
  ctx: Context,
  request: GenerateRequest,
  token: string | undefined,
  onStage: StageReporter,
  signal: AbortSignal | undefined,
  extractionAdmitted: boolean,
): Promise<GenerateResult> {
  await onStage("cache");
  const effectiveRequest = ctx.refreshCache ? { ...request, refresh: true } : request;
  // The bounded lifecycle scheduler is the singleflight owner. Keeping a second promise map here
  // would couple the shared work to whichever outer subscriber arrived first, so cancelling that
  // subscriber could abort another lifecycle job that happened to reuse this promise.
  const cached = await cachedRemoteGraph({
    cacheRoot: ctx.cacheRoot,
    request: effectiveRequest,
    cwd: ctx.cwd,
    token,
    tokenIsExplicit: request.token !== undefined,
    repositoryMirrors: ctx.repositoryMirrors,
    runExtraction: ctx.runExtraction,
    generationLifecycle: ctx.graphGenerationLifecycle,
    signal,
    extractionAdmitted,
    onPrepareSource: () => onStage("source"),
    onExtract: () => onStage("extract"),
  });
  const id = remoteArtifactId(
    cached.checkout.repositoryKey,
    cached.checkout.commit,
    cached.analysisKey,
    cached.generationId,
    cached.checkout.branch ?? "",
  );
  return withOwnershipCleanup(
    async () => {
      await ctx.graphCapabilities.publish({
        id,
        generation: cached.verifiedGeneration,
        vcsBranch: cached.checkout.branch,
        sourceRoot: cached.checkout.repoDir,
        sourceSubdir: request.subdir,
        source: artifactSourceFor(request),
        sourceLease: cached.checkout.sourceLease,
      }, { signal });
      if (cached.cache === "miss") ctx.graphGenerationMaintenance.notePublication();
      return {
        id,
        target: cached.target,
        counts: { nodes: cached.graphSummary.nodeCount, edges: cached.graphSummary.edgeCount },
        warnings: cached.warnings,
        cache: cached.cache,
        checkoutCache: cached.checkout.cache,
      };
    },
    [
      () => cached.generationLease.release(),
      () => cached.checkout.sourceOperation.release(),
    ],
    "remote graph publication",
  );
}

async function generateLocal(
  ctx: Context,
  request: GenerateRequest,
  onStage: StageReporter,
  signal: AbortSignal | undefined,
  extractionAdmitted: boolean,
): Promise<GenerateResult> {
  await onStage("source");
  const source = resolveLocalSource(request.value, ctx.cwd);
  const generationsRoot = localArtifactGenerations(ctx.cacheRoot);
  createPrivateDirectory(generationsRoot);
  const stage = await ctx.graphGenerationLifecycle.reserveStage(signal);
  const artifactOutputPath = join(stage.directory, "artifact.json");
  let generationLease: GraphGenerationLease | undefined;
  let publishedNewGeneration = false;
  let result: GenerateResult | undefined;
  let operationFailed = false;
  let operationError: unknown;
  try {
    await onStage("extract");
    const extractionRequest: SerializablePipelineRequest = {
      absoluteRoot: source.dir,
      cwd: source.dir,
      depth: "function",
      includeExternal: true,
      materializeBoundary: true,
      valueRefs: process.env.MERIDIAN_VALUE_REFS === "1",
      targetName: source.target,
    };
    const extracted = await ctx.runExtraction(extractionRequest, {
      artifactOutputPath,
      signal,
      admitted: extractionAdmitted,
    });
    if (extracted.artifactPath !== artifactOutputPath
      || extracted.projectionDirectory !== join(stage.directory, GRAPH_PROJECTION_DIRECTORY)) {
      throw new Error("local extraction wrote outside its cache stage");
    }
    const revision = { kind: "content", contentId: extracted.projectionContentId } as const;
    const sealed = await sealGraphGeneration({
      cacheRoot: ctx.cacheRoot,
      stage,
      artifactPath: extracted.artifactPath,
      projectionDirectory: extracted.projectionDirectory,
      artifactBytes: extracted.artifactBytes,
      artifactSha256: extracted.artifactSha256,
      projectionBytes: extracted.projectionBytes,
      projectionSha256: extracted.projectionSha256,
      projectionContentId: extracted.projectionContentId,
      graphSummary: extracted.graphSummary,
      revision,
    }, signal);
    const generationId = createHash("sha256").update(JSON.stringify({
      artifactSha256: sealed.artifactSha256,
      projectionSha256: sealed.projectionSha256,
      projectionContentId: sealed.projectionContentId,
    })).digest("hex");
    const generationDirectory = finalizedGenerationDirectory(
      dirname(generationsRoot),
      generationId,
    );
    generationLease = await ctx.graphGenerationLifecycle.acquire(generationDirectory, {
      purpose: "publication",
      allowMissing: true,
      signal,
    });
    // A collision is the expected content-addressed deduplication path. In either case, only the
    // exact sealed final generation is adopted below; stage bytes are never used after publication.
    publishedNewGeneration = await stage.publish(generationLease, signal);
    if (publishedNewGeneration) {
      freezeGraphGenerationDirectory(ctx.cacheRoot, generationDirectory);
    }
    const generation = await verifyExistingGraphGeneration({
      cacheRoot: ctx.cacheRoot,
      artifactPath: join(generationDirectory, "artifact.json"),
      projectionDirectory: join(generationDirectory, GRAPH_PROJECTION_DIRECTORY),
      artifactBytes: sealed.artifactBytes,
      artifactSha256: sealed.artifactSha256,
      projectionBytes: sealed.projectionBytes,
      projectionSha256: sealed.projectionSha256,
      projectionContentId: sealed.projectionContentId,
      graphSummary: sealed.graphSummary,
      revision,
    }, signal);
    // The graph id names the exact sealed content, so a local directory that changes produces a
    // new immutable capability instead of rebinding a process-local session entry.
    const id = artifactId(request, generationId, webAnalysisKey(request));
    await ctx.graphCapabilities.publish({
      id,
      generation,
      sourceRoot: source.dir,
      source: artifactSourceFor(request),
    }, { signal });
    if (publishedNewGeneration) ctx.graphGenerationMaintenance.notePublication();
    result = {
      id,
      target: source.target,
      counts: { nodes: extracted.graphSummary.nodeCount, edges: extracted.graphSummary.edgeCount },
      warnings: extracted.warnings,
      cache: "bypass",
      checkoutCache: "bypass",
    };
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }

  const errors: unknown[] = operationFailed ? [operationError] : [];
  try {
    await stage.release();
  } catch (error) {
    errors.push(error);
  }
  if (generationLease) {
    try {
      await generationLease.release();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(errors, "local generation and lifecycle cleanup failed");
  }
  return result!;
}
