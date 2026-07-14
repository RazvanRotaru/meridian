import { createHash } from "node:crypto";
import type { GraphArtifact } from "@meridian/core";
import { analyzeRepository } from "../repository-analysis";
import { resolveSource } from "./clone";
import { cachedRemoteGraph, webAnalysisKey } from "./web-cache";
import { artifactId, remoteArtifactId } from "./web-request";
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
  const jobKey = `${artifactId(effectiveRequest, "", webAnalysisKey(effectiveRequest))}:${credentialKey}:${effectiveRequest.refresh === true}`;
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
    const id = remoteArtifactId(cached.checkout.repositoryKey, cached.checkout.commit, cached.analysisKey);
    registerGraph(ctx, id, cached.artifact, cached.sourceDir, request);
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
  let retained = false;
  try {
    await onStage("extract");
    const { artifact, warnings } = await analyzeRepository({
      absoluteRoot: source.dir,
      cwd: source.dir,
      language: request.lang,
      targetName: source.target,
    });
    const id = artifactId(request);
    registerGraph(ctx, id, artifact, source.dir, request);
    ctx.tempCleanups.add(source.cleanup);
    retained = true;
    return {
      id,
      target: source.target,
      counts: { nodes: artifact.nodes.length, edges: artifact.edges.length },
      warnings,
      cache: "bypass",
      checkoutCache: "bypass",
    };
  } finally {
    if (!retained) {
      source.cleanup();
    }
  }
}

function registerGraph(
  ctx: Context,
  id: string,
  artifact: GraphArtifact,
  sourceDir: string,
  request: GenerateRequest,
): void {
  ctx.graphs.set(id, artifact);
  ctx.sourceRoots.set(id, sourceDir);
  ctx.sources.set(id, artifactSourceFor(request, artifact.target.language));
}
