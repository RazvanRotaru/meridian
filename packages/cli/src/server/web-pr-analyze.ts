/**
 * POST /api/pr/analyze — resolve a PR's immutable head/base pair, reuse or create its persistent
 * checkout and changed-node graph, then stream real miss stages to the browser as NDJSON.
 *
 * This is the PR-review sibling of `/api/generate` (web-graph.ts): it stores the artifact under a
 * deterministic `pr-` id in `ctx.graphs`/`ctx.sourceRoots`/`ctx.sources` so the browser then loads
 * it with `GET /api/graph?id=` and slices code with `GET /api/source?id=`. Unlike generate it needs
 * FULL commit/tree history (a shallow clone can't resolve `merge-base` against the base branch),
 * while a blobless partial clone keeps the persistent miss smaller. Cache identity includes both
 * revisions, so a head force-push or base update cannot reuse a stale diff.
 */

import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { GraphArtifact } from "@meridian/core";
import { readJsonBody } from "./web-request";
import { parsePrAnalyzeRequest } from "./web-pr-request";
import type { PrAnalyzeRequest } from "./web-pr-request";
import { githubTokenFor } from "./web-auth";
import { WebError } from "./web-error";
import type { ArtifactSource } from "./web-source";
import type { Context } from "./web-server";
import { cachedPrGraph } from "./web-pr-cache";

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
    const graphId = storeArtifact(ctx, cached.artifact, source, cached.sourceDir, body, cached.headSha, cached.baseSha);
    writeLine(response, doneLine(graphId, cached.headSha, cached.artifact, cached.warnings, cached.cache));
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
): string {
  const graphId = prGraphId(source, body, headSha, baseSha);
  ctx.graphs.set(graphId, artifact);
  ctx.sourceRoots.set(graphId, sourceDir);
  ctx.sources.set(graphId, { kind: "github", owner: source.owner, repo: source.repo, subdir: source.subdir });
  return graphId;
}

/** The terminal `done` line: the new graph id, the analyzed head commit, counts, changed files, warnings. */
function doneLine(graphId: string, headSha: string, artifact: GraphArtifact, warnings: string[], cache: "hit" | "miss"): Record<string, unknown> {
  return {
    stage: "done",
    graphId,
    headSha,
    counts: { nodes: artifact.nodes.length, edges: artifact.edges.length },
    changedFiles: changedFilesOf(artifact),
    warnings,
    cache,
  };
}

/** Derive `{ path, status }[]` from the diff's per-file ranges stamped into `extensions.changedSince`. */
function changedFilesOf(artifact: GraphArtifact): { path: string; status: string }[] {
  const changedSince = (artifact.extensions?.changedSince ?? null) as { files?: Record<string, unknown> } | null;
  const files = changedSince?.files ?? {};
  return Object.keys(files)
    .sort()
    .map((path) => ({ path, status: "modified" }));
}

/** Deterministic per-commit id: a force-pushed ref can never replace a stale client's artifact. */
function prGraphId(source: GitHubSource, body: PrAnalyzeRequest, headSha: string, baseSha: string): string {
  const key = ["pr", source.owner, source.repo, source.subdir ?? "", body.prNumber, body.headRef, headSha, baseSha].join(" ");
  const keyDigest = createHash("sha1").update(key).digest("hex").slice(0, 12);
  return `pr-${keyDigest}-${headSha}`;
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
  const source = ctx.sources.get(id);
  if (source?.kind !== "github") {
    throw new WebError(404, "pull request analysis needs a GitHub-sourced session");
  }
  return source;
}
