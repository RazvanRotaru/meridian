import { createHash } from "node:crypto";
import { join } from "node:path";
import { resolveLocalSource } from "./clone";
import { syntheticSourceFingerprintForFiles } from "./synthetic-fingerprint";
import { cachedRemoteGraph, webAnalysisKey } from "./web-cache";
import { createStageDirectory, removeEntry } from "./web-cache-storage";
import { throwIfAborted } from "./web-cancellation";
import { localArtifactId, remoteArtifactId } from "./web-request";
import type { GenerateRequest } from "./web-request";
import type { Context } from "./web-server";
import { artifactSourceFor } from "./web-source";

export interface GenerateResult {
  id: string;
  target: string;
  counts: { nodes: number; edges: number };
  warnings: string[];
  cache: "hit" | "miss" | "bypass";
  checkoutCache: "hit" | "miss" | "bypass";
}

type GenerateStage = "cache" | "source" | "extract";
type StageReporter = (stage: GenerateStage) => void | Promise<void>;

/** Resolve, cache when remote, extract when needed, and register one graph with its source tree. */
export function generateGraph(
  ctx: Context,
  request: GenerateRequest,
  token: string | undefined,
  onStage: StageReporter = () => {},
  signal?: AbortSignal,
): Promise<GenerateResult> {
  return request.kind === "github"
    ? generateRemote(ctx, request, token, onStage, signal)
    : generateLocal(ctx, request, onStage, signal);
}

async function generateRemote(
  ctx: Context,
  request: GenerateRequest,
  token: string | undefined,
  onStage: StageReporter,
  signal?: AbortSignal,
): Promise<GenerateResult> {
  await onStage("cache");
  throwIfAborted(signal);
  const effectiveRequest = ctx.refreshCache ? { ...request, refresh: true } : request;
  const credentialKey = token ? createHash("sha256").update(token).digest("hex") : "anonymous";
  const jobKey = remoteGenerationJobKey(effectiveRequest, credentialKey);
  return ctx.analysisCoordinator.run<GenerateResult, GenerateStage>(
    `remote:${jobKey}`,
    async ({ signal: jobSignal, report, runPreparation, runAnalysis }) => {
      const cached = await cachedRemoteGraph({
        cacheRoot: ctx.cacheRoot,
        repositories: ctx.repositories,
        request: effectiveRequest,
        cwd: ctx.cwd,
        token,
        signal: jobSignal,
        onClone: () => report("source"),
        onExtract: () => report("extract"),
        runPreparation,
        runAnalysis,
        repositoryAnalysis: ctx.repositoryAnalysis,
        repositoryArtifactRestamp: ctx.repositoryArtifactRestamp,
      });
      let leaseOwned = true;
      try {
        throwIfAborted(jobSignal);
        const id = remoteArtifactId(
          cached.checkout.repositoryKey,
          cached.checkout.commit,
          cached.analysisKey,
          request.ref,
          cached.snapshotDigest,
        );
        // Publication belongs to the shared job: identical waiters receive immutable result data,
        // never the same single-owner workspace lease.
        leaseOwned = false;
        ctx.graphStore.publish({
          id,
          material: cached.material,
          metadata: {
            sourceRoot: cached.sourceDir,
            sourceLease: cached.checkout.sourceLease,
            source: artifactSourceFor(request),
            synthetic: noSyntheticCapability(),
          },
        });
        return {
          id,
          target: cached.target,
          counts: {
            nodes: cached.facts.summary.nodeCount,
            edges: cached.facts.summary.edgeCount,
          },
          warnings: cached.warnings,
          cache: cached.cache,
          checkoutCache: cached.checkout.cache,
        };
      } finally {
        if (leaseOwned) cached.checkout.sourceLease.release();
      }
    },
    { signal, onProgress: onStage },
  );
}

async function generateLocal(
  ctx: Context,
  request: GenerateRequest,
  onStage: StageReporter,
  signal?: AbortSignal,
): Promise<GenerateResult> {
  await onStage("source");
  throwIfAborted(signal);
  const source = resolveLocalSource(request, ctx.cwd);
  const jobKey = createHash("sha256").update(JSON.stringify({
    sourceDir: source.dir,
    target: source.target,
  })).digest("hex");
  return ctx.analysisCoordinator.run<GenerateResult, GenerateStage>(
    `local:${jobKey}`,
    async ({ signal: jobSignal, report, runAnalysis }) => {
      report("extract");
      let stage: string | undefined;
      try {
        const result = await runAnalysis(async () => {
          const analysisStage = createStageDirectory(join(ctx.graphStore.rootPath, "analysis"));
          // Admission can discard a late success after cancellation, so ownership must escape now.
          stage = analysisStage;
          try {
            return await ctx.repositoryAnalysis({
              absoluteRoot: source.dir,
              cwd: source.dir,
              targetName: source.target,
            }, {
              artifactOutputPath: join(analysisStage, "artifact.json"),
              signal: jobSignal,
            });
          } catch (error) {
            removeEntry(analysisStage);
            stage = undefined;
            throw error;
          }
        });
        throwIfAborted(jobSignal);
        const synthetic = await localSyntheticCapability(ctx, source.dir, result.sourceFiles);
        const id = localArtifactId(source.dir, result.material.byteDigest, synthetic);
        ctx.graphStore.publish({
          id,
          material: result.material,
          metadata: {
            sourceRoot: source.dir,
            source: artifactSourceFor(request),
            synthetic,
          },
        });
        return {
          id,
          target: source.target,
          counts: { nodes: result.summary.nodeCount, edges: result.summary.edgeCount },
          warnings: result.warnings,
          cache: "bypass",
          checkoutCache: "bypass",
        };
      } finally {
        if (stage !== undefined) removeEntry(stage);
      }
    },
    { signal, onProgress: onStage },
  );
}

function remoteGenerationJobKey(request: GenerateRequest, credentialKey: string): string {
  return createHash("sha256").update(JSON.stringify({
    kind: request.kind,
    value: request.value,
    ref: request.ref ?? "",
    subdir: request.subdir ?? "",
    analysisKey: webAnalysisKey(request),
    credentialKey,
    refresh: request.refresh === true,
  })).digest("hex");
}

function noSyntheticCapability() {
  return { scenarios: [], sourceFingerprint: null, trust: null };
}

async function localSyntheticCapability(
  ctx: Context,
  sourceRoot: string,
  sourceFiles: readonly string[],
) {
  if (!ctx.allowSyntheticExecution) return noSyntheticCapability();
  const {
    loadSyntheticScenarios,
    syntheticExecutionRuntimeSupported,
  } = await import("./synthetic-execution");
  if (!syntheticExecutionRuntimeSupported()) return noSyntheticCapability();
  const scenarios = loadSyntheticScenarios(sourceRoot);
  return {
    scenarios,
    sourceFingerprint: scenarios.length > 0
      ? syntheticSourceFingerprintForFiles(sourceRoot, sourceFiles)
      : null,
    trust: { mode: "local" as const },
  };
}
