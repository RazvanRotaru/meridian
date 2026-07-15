import { join } from "node:path";
import { resolveSource } from "./clone";
import { cachedRemoteGraph, webAnalysisKey } from "./web-cache";
import { artifactId, remoteArtifactId } from "./web-request";
import type { GenerateRequest } from "./web-request";
import type { Context } from "./web-server";
import { artifactSourceFor } from "./web-source";
import { createStageDirectory, removeEntry } from "./web-cache-storage";
import type { SerializablePipelineRequest } from "./extraction-worker";

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
    signal,
    extractionAdmitted,
    onClone: () => onStage("source"),
    onExtract: () => onStage("extract"),
  });
  const id = remoteArtifactId(
    cached.checkout.repositoryKey,
    cached.checkout.commit,
    cached.analysisKey,
    cached.generationId,
    cached.checkout.branch ?? "",
  );
  ctx.inspectionSnapshots.publish({
    id,
    artifactPath: cached.artifactPath,
    graphSummary: cached.graphSummary,
    vcsBranch: cached.checkout.branch,
    sourceRoot: cached.checkout.repoDir,
    sourceSubdir: request.subdir,
    source: artifactSourceFor(request),
  });
  return {
    id,
    target: cached.target,
    counts: { nodes: cached.graphSummary.nodeCount, edges: cached.graphSummary.edgeCount },
    warnings: cached.warnings,
    cache: cached.cache,
    checkoutCache: cached.checkout.cache,
  };
}

async function generateLocal(
  ctx: Context,
  request: GenerateRequest,
  onStage: StageReporter,
  signal: AbortSignal | undefined,
  extractionAdmitted: boolean,
): Promise<GenerateResult> {
  await onStage("source");
  const source = await resolveSource(request, ctx.cwd);
  let retained = false;
  const outputDirectory = createStageDirectory(join(ctx.cacheRoot, "local-artifacts"));
  const artifactOutputPath = join(outputDirectory, "artifact.json");
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
    if (extracted.artifactPath !== artifactOutputPath) throw new Error("local extraction wrote outside its cache stage");
    // Local sources have no commit/generation id, so the analysis key is part of their durable
    // identity. Otherwise two concurrent language/settings variants overwrite the same graph id.
    const id = artifactId(request, "", webAnalysisKey(request));
    ctx.localGraphFiles.set(id, {
      artifactPath: artifactOutputPath,
      graphSummary: extracted.graphSummary,
      projectionDirectory: extracted.projectionDirectory,
    });
    ctx.sourceRoots.set(id, source.dir);
    ctx.sources.set(id, artifactSourceFor(request));
    ctx.tempCleanups.add(() => {
      source.cleanup();
      removeEntry(outputDirectory);
    });
    retained = true;
    return {
      id,
      target: source.target,
      counts: { nodes: extracted.graphSummary.nodeCount, edges: extracted.graphSummary.edgeCount },
      warnings: extracted.warnings,
      cache: "bypass",
      checkoutCache: "bypass",
    };
  } finally {
    if (!retained) {
      source.cleanup();
      removeEntry(outputDirectory);
    }
  }
}
