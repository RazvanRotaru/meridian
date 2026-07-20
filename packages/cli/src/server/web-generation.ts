import { createHash } from "node:crypto";
import type { GraphArtifact } from "@meridian/core";
import { analyzeRepository } from "../repository-analysis";
import { resolveSource } from "./clone";
import { cachedRemoteGraph, webAnalysisKey } from "./web-cache";
import { materializeValidatedArtifact } from "./web-graph-store";
import {
  loadSyntheticScenarios,
  syntheticExecutionRuntimeSupported,
  syntheticSourceFingerprint,
} from "./synthetic-execution";
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
): Promise<GenerateResult> {
  return request.kind === "github"
    ? generateRemote(ctx, request, token, onStage)
    : generateLocal(ctx, request, onStage);
}

async function generateRemote(
  ctx: Context,
  request: GenerateRequest,
  token: string | undefined,
  onStage: StageReporter,
): Promise<GenerateResult> {
  await onStage("cache");
  const effectiveRequest = ctx.refreshCache ? { ...request, refresh: true } : request;
  const credentialKey = token ? createHash("sha256").update(token).digest("hex") : "anonymous";
  const jobKey = remoteGenerationJobKey(effectiveRequest, credentialKey);
  let pending = ctx.cacheJobs.get(jobKey);
  if (!pending) {
    pending = cachedRemoteGraph({
      cacheRoot: ctx.cacheRoot,
      request: effectiveRequest,
      cwd: ctx.cwd,
      token,
      onClone: () => onStage("source"),
      onExtract: () => onStage("extract"),
    });
    ctx.cacheJobs.set(jobKey, pending);
  }
  try {
    const cached = await pending;
    const id = remoteArtifactId(
      cached.checkout.repositoryKey,
      cached.checkout.commit,
      cached.analysisKey,
      request.ref,
      cached.snapshotDigest,
    );
    ctx.graphStore.publish({
      id,
      material: cached.material,
      metadata: {
        sourceRoot: cached.sourceDir,
        source: artifactSourceFor(request),
        synthetic: noSyntheticCapability(),
      },
    });
    return {
      id,
      target: cached.target,
      counts: { nodes: cached.artifact.nodes.length, edges: cached.artifact.edges.length },
      warnings: cached.warnings,
      cache: cached.cache,
      checkoutCache: cached.checkout.cache,
    };
  } finally {
    if (ctx.cacheJobs.get(jobKey) === pending) {
      ctx.cacheJobs.delete(jobKey);
    }
  }
}

async function generateLocal(ctx: Context, request: GenerateRequest, onStage: StageReporter): Promise<GenerateResult> {
  await onStage("source");
  const source = await resolveSource(request, ctx.cwd);
  try {
    await onStage("extract");
    const { artifact, warnings } = await analyzeRepository({
      absoluteRoot: source.dir,
      cwd: source.dir,
      targetName: source.target,
    });
    const synthetic = localSyntheticCapability(ctx, source.dir, artifact);
    const material = materializeValidatedArtifact(artifact);
    const id = localArtifactId(source.dir, material.byteDigest, synthetic);
    ctx.graphStore.publish({
      id,
      material,
      metadata: {
        sourceRoot: source.dir,
        source: artifactSourceFor(request),
        synthetic,
      },
    });
    return {
      id,
      target: source.target,
      counts: { nodes: artifact.nodes.length, edges: artifact.edges.length },
      warnings,
      cache: "bypass",
      checkoutCache: "bypass",
    };
  } finally {
    source.cleanup();
  }
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

function localSyntheticCapability(
  ctx: Context,
  sourceRoot: string,
  artifact: GraphArtifact,
) {
  if (!ctx.allowSyntheticExecution || !syntheticExecutionRuntimeSupported()) {
    return noSyntheticCapability();
  }
  const scenarios = loadSyntheticScenarios(sourceRoot);
  return {
    scenarios,
    sourceFingerprint: scenarios.length > 0 ? syntheticSourceFingerprint(sourceRoot, artifact) : null,
    trust: { mode: "local" as const },
  };
}
