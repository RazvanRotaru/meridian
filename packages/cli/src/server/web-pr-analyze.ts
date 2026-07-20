/**
 * POST /api/pr/analyze — resolve a PR's immutable head/base pair, reuse or create its persistent
 * checkout and changed-node graph, then stream real miss stages to the browser as NDJSON.
 *
 * This is the PR-review sibling of `/api/generate` (web-generation.ts): it publishes immutable,
 * disk-backed descriptors for HEAD and its exact merge-base comparison so the browser can load
 * either side with `GET /api/graph?id=` and slice source with `GET /api/source?id=`. Unlike generate
 * it needs FULL commit/tree history (a shallow clone can't resolve `merge-base` against the base
 * branch), while a blobless partial clone keeps the persistent miss smaller. Cache identity includes
 * both revisions, so a head force-push or base update cannot reuse a stale diff.
 */

import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { changedFileManifestFromExtensions } from "@meridian/core";
import type { ChangedFileManifestEntry, GraphArtifact } from "@meridian/core";
import { readJsonBody } from "./web-request";
import { parsePrAnalyzeRequest } from "./web-pr-request";
import type { PrAnalyzeRequest } from "./web-pr-request";
import { githubTokenFor } from "./web-auth";
import { WebError } from "./web-error";
import type { ArtifactSource } from "./web-source";
import type { Context } from "./web-server";
import { cachedPrGraph } from "./web-pr-cache";
import type { VerifiedFileArtifactMaterial } from "./web-graph-store";
import {
  loadSyntheticScenarios,
  syntheticSourceFingerprint,
} from "./synthetic-execution";

type GitHubSource = Extract<ArtifactSource, { kind: "github" }>;

export async function handlePrAnalyze(ctx: Context, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const body = parsePrAnalyzeRequest(await readJsonBody(request));
  const source = requireGitHubSource(ctx, body.id);
  const token = githubTokenFor(ctx, request);
  beginNdjson(response);
  await streamAnalysis(ctx, response, source, token, body);
}

/**
 * The streamed body. Every stage writes a line before the work it names starts, so the browser
 * sees "clone → checkout → extract" progress on a miss; a hit emits only `done`. Any failure
 * collapses to a single safe `error` line, and `/api/source` reads from the persistent checkout.
 */
async function streamAnalysis(
  ctx: Context,
  response: ServerResponse,
  source: GitHubSource,
  token: string | undefined,
  body: PrAnalyzeRequest,
): Promise<void> {
  try {
    const cached = await cachedPrGraph({
      cacheRoot: ctx.cacheRoot,
      source,
      body,
      cwd: ctx.cwd,
      token,
      refresh: ctx.refreshCache,
      onStage: (stage) => writeLine(response, { stage }),
    });
    const stored = storeArtifact(
      ctx,
      cached.artifact,
      source,
      cached.sourceDir,
      body,
      cached.headSha,
      cached.baseSha,
      cached.artifactMaterial,
    );
    const comparisonGraphId = storeComparisonArtifact(
      ctx,
      source,
      cached.comparisonSourceDir,
      body,
      cached.mergeBaseSha,
      cached.comparisonMaterial,
    );
    writeLine(response, doneLine(
      stored.graphId,
      comparisonGraphId,
      cached.headSha,
      cached.mergeBaseSha,
      cached.artifact,
      [...cached.warnings, ...stored.syntheticWarnings],
      cached.cache,
    ));
  } catch (error) {
    writeLine(response, { stage: "error", message: safeMessage(error) });
  } finally {
    response.end();
  }
}

function storeArtifact(
  ctx: Context,
  artifact: GraphArtifact,
  source: GitHubSource,
  sourceDir: string,
  body: PrAnalyzeRequest,
  headSha: string,
  baseSha: string,
  material: VerifiedFileArtifactMaterial,
): { graphId: string; syntheticWarnings: string[] } {
  const sandboxAdmission = ctx.allowSyntheticPrExecution && ctx.syntheticPrSandboxRuntimeSupported();
  let syntheticScenarios = [] as ReturnType<typeof loadSyntheticScenarios>;
  let syntheticFingerprint: string | null = null;
  let syntheticTrustReady = sandboxAdmission;
  const syntheticWarnings: string[] = [];
  if (sandboxAdmission) {
    try {
      syntheticScenarios = loadSyntheticScenarios(sourceDir);
      if (syntheticScenarios.length > 0) {
        syntheticFingerprint = syntheticSourceFingerprint(sourceDir, artifact);
      } else {
        syntheticWarnings.push("Synthetic execution needs a valid meridian.synthetic.json scenario manifest.");
      }
    } catch {
      // A PR controls this file. Never leak parser/path details and never let a malformed manifest
      // prevent review of the graph itself; simply withhold the executable capability.
      syntheticScenarios = [];
      syntheticFingerprint = null;
      syntheticTrustReady = false;
      syntheticWarnings.push("Synthetic execution was disabled because the PR scenario manifest is invalid.");
    }
  }
  const synthetic = {
    scenarios: syntheticFingerprint === null ? [] : syntheticScenarios,
    sourceFingerprint: syntheticFingerprint,
    trust: syntheticTrustReady
      ? { mode: "sandboxed-pr" as const, provenance: { repository: `${source.owner}/${source.repo}`, headSha } }
      : null,
  };
  const syntheticDigest = createHash("sha256").update(JSON.stringify(synthetic)).digest("hex");
  const graphId = prGraphId(source, body, headSha, baseSha, material.byteDigest, syntheticDigest);
  const sourceRoot = ctx.graphStore.descriptor(graphId)?.sourceRoot ?? sourceDir;
  ctx.graphStore.publish({
    id: graphId,
    material,
    metadata: {
      sourceRoot,
      source,
      synthetic,
    },
  });
  return { graphId, syntheticWarnings };
}

function storeComparisonArtifact(
  ctx: Context,
  source: GitHubSource,
  sourceDir: string,
  body: PrAnalyzeRequest,
  mergeBaseSha: string,
  material: VerifiedFileArtifactMaterial,
): string {
  const graphId = prComparisonGraphId(source, body, mergeBaseSha, material.byteDigest);
  // One merge base can be rediscovered through multiple PR cache entries. Its source contents are
  // commit-identical, so keep the first published checkout as the immutable source snapshot rather
  // than rebinding the graph id to a newer filesystem path. Artifact/source mismatches still fail
  // closed in WebGraphStore.publish.
  const sourceRoot = ctx.graphStore.descriptor(graphId)?.sourceRoot ?? sourceDir;
  ctx.graphStore.publish({
    id: graphId,
    material,
    metadata: {
      sourceRoot,
      source,
      synthetic: { scenarios: [], sourceFingerprint: null, trust: null },
    },
  });
  return graphId;
}

/** The terminal `done` line carries immutable ids and commit provenance for both comparison sides. */
function doneLine(
  graphId: string,
  comparisonGraphId: string,
  headSha: string,
  mergeBaseSha: string,
  artifact: GraphArtifact,
  warnings: string[],
  cache: "hit" | "miss",
): Record<string, unknown> {
  return {
    stage: "done",
    graphId,
    comparisonGraphId,
    headSha,
    mergeBaseSha,
    counts: { nodes: artifact.nodes.length, edges: artifact.edges.length },
    changedFiles: changedFilesOf(artifact),
    warnings,
    cache,
  };
}

/** Exact status-rich file inventory from the canonical local Git analysis. */
function changedFilesOf(artifact: GraphArtifact): ChangedFileManifestEntry[] {
  const manifest = changedFileManifestFromExtensions(artifact.extensions);
  if (manifest === null) {
    throw new WebError(422, "pull request analysis did not produce a canonical changed-file manifest");
  }
  return [...manifest].sort((left, right) => left.path.localeCompare(right.path));
}

/** Immutable snapshot id: neither a force-push nor an explicit cache refresh can rebind a client. */
function prGraphId(
  source: GitHubSource,
  body: PrAnalyzeRequest,
  headSha: string,
  baseSha: string,
  artifactDigest: string,
  syntheticDigest: string,
): string {
  const key = [
    "pr",
    source.owner,
    source.repo,
    source.subdir ?? "",
    body.prNumber,
    body.headRef,
    headSha,
    baseSha,
    artifactDigest,
    syntheticDigest,
  ].join(" ");
  const keyDigest = createHash("sha1").update(key).digest("hex").slice(0, 12);
  return `pr-${keyDigest}-${headSha}`;
}

/** The comparison id is pinned to the merge base plus exact extracted snapshot, never a moving ref. */
function prComparisonGraphId(
  source: GitHubSource,
  body: PrAnalyzeRequest,
  mergeBaseSha: string,
  artifactDigest: string,
): string {
  const key = [
    "pr-comparison",
    source.owner,
    source.repo,
    source.subdir ?? "",
    body.prNumber,
    mergeBaseSha,
    artifactDigest,
  ].join(" ");
  const keyDigest = createHash("sha1").update(key).digest("hex").slice(0, 12);
  return `pr-base-${keyDigest}-${mergeBaseSha}`;
}

function beginNdjson(response: ServerResponse): void {
  response.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-cache" });
}

function writeLine(response: ServerResponse, line: Record<string, unknown>): void {
  response.write(`${JSON.stringify(line)}\n`);
}

/** Never echo an unknown error's text (it could carry a path or secret); a WebError is pre-vetted. */
function safeMessage(error: unknown): string {
  if (error instanceof WebError) {
    return error.message;
  }
  return "internal error while analyzing the pull request";
}

function requireGitHubSource(ctx: Context, id: string): GitHubSource {
  const source = ctx.graphStore.descriptor(id)?.source;
  if (source?.kind !== "github") {
    throw new WebError(404, "pull request analysis needs a GitHub-sourced session");
  }
  return source;
}
