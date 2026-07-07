/**
 * Creating and serving the in-memory graphs behind the web flow. `/api/generate` clones + extracts
 * a source into an artifact kept under a deterministic id; `/api/graph|meta` and `/view` read it
 * back, and the extracted source dir is retained under the same id so `/api/source` can serve code
 * slices. The clone token is resolved by precedence — an explicit pasted token, else the signed-in
 * session's token, else the environment — so sign-in and manual tokens both feed the vetted path.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { GraphArtifact } from "@meridian/core";
import { extractToArtifact } from "../extract-pipeline";
import { resolveSource } from "./clone";
import type { SourceRequest } from "./clone";
import { sendHtml, sendJson } from "./http-response";
import { injectViewBoot } from "./web-boot";
import type { ReviewBoot } from "./web-boot";
import { sessionTokenFor } from "./web-auth";
import { parsePullRequestUrl } from "./github-parse";
import type { PullRequestRef } from "./github-parse";
import { stripSubdirPrefix } from "./pr-files";
import { WebError } from "./web-error";
import { artifactId, parseGenerateRequest, readJsonBody } from "./web-request";
import type { GenerateRequest } from "./web-request";
import type { Context } from "./web-server";

export async function handleGenerate(ctx: Context, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const parsed = parseGenerateRequest(await readJsonBody(request));
  const token = parsed.token ?? sessionTokenFor(ctx, request) ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  const pr = parsed.kind === "github" ? parsePullRequestUrl(parsed.value) : null;
  const source = await resolveSource(sourceRequestFor(parsed, pr), ctx.cwd, token);
  // A successful generate retains the source (so `/api/source` can read it) and defers cleanup to
  // process exit; only a failure removes the temp clone now. A local path's cleanup is a no-op, so
  // this never deletes the user's own directory.
  let retained = false;
  try {
    const { artifact, warnings } = await extractToArtifact({
      absoluteRoot: source.dir,
      cwd: source.dir, // records target.root as "." — never leaks the temp clone path
      language: parsed.lang,
      depth: "function",
      materializeBoundary: false,
      targetName: source.target, // the repo label (e.g. "sindresorhus/ky"), not the temp dir
    });
    // Fetch the PR file list before committing anything, so a failure still cleans up the clone.
    const review = pr ? await buildReview(ctx, pr, parsed.subdir, token) : null;
    const id = artifactId(parsed);
    ctx.graphs.set(id, artifact);
    ctx.sourceRoots.set(id, source.dir);
    if (review) {
      // Store the whole boot (incl. `truncated`) so `/view` re-injects it on reload.
      ctx.reviews.set(id, review);
    }
    ctx.tempCleanups.add(source.cleanup);
    retained = true;
    sendJson(response, 200, generateBody(id, source.target, artifact, warnings, review));
  } finally {
    if (!retained) {
      source.cleanup();
    }
  }
}

/** A PR URL clones its head by number; every other source keeps the branch/ref path unchanged. */
function sourceRequestFor(parsed: GenerateRequest, pr: PullRequestRef | null): SourceRequest {
  if (pr) {
    return { kind: "github", value: `${pr.owner}/${pr.repo}`, subdir: parsed.subdir, prNumber: pr.prNumber };
  }
  return { kind: parsed.kind, value: parsed.value, ref: parsed.ref, subdir: parsed.subdir };
}

async function buildReview(
  ctx: Context,
  pr: PullRequestRef,
  subdir: string | undefined,
  token: string | undefined,
): Promise<ReviewBoot> {
  if (!ctx.github) {
    throw new WebError(400, "reviewing a pull request needs GitHub API access — configure MERIDIAN_GITHUB_CLIENT_ID");
  }
  const { files, truncated } = await ctx.github.fetchPullRequestFiles({ owner: pr.owner, repo: pr.repo, prNumber: pr.prNumber, token });
  const affectedFiles = stripSubdirPrefix(files, subdir);
  return { affectedFiles, reviewScopeRef: `pr${pr.prNumber}`, truncated };
}

function generateBody(
  id: string,
  target: string,
  artifact: GraphArtifact,
  warnings: string[],
  review: ReviewBoot | null,
): Record<string, unknown> {
  const counts = { nodes: artifact.nodes.length, edges: artifact.edges.length };
  const base = { id, target, counts, warnings };
  if (!review) {
    return base;
  }
  return { ...base, review: { affectedFiles: review.affectedFiles.length, truncated: review.truncated ?? false, scopeRef: review.reviewScopeRef } };
}

export function sendGraph(ctx: Context, response: ServerResponse, id: string | null): void {
  const artifact = lookup(ctx, id);
  if (!artifact) {
    sendJson(response, 404, { error: "unknown graph id" });
    return;
  }
  sendJson(response, 200, artifact);
}

export function sendMeta(ctx: Context, response: ServerResponse, id: string | null): void {
  const artifact = lookup(ctx, id);
  if (!artifact) {
    sendJson(response, 404, { error: "unknown graph id" });
    return;
  }
  sendJson(response, 200, {
    schemaVersion: artifact.schemaVersion,
    generatedAt: artifact.generatedAt,
    nodeCount: artifact.nodes.length,
    hasOverlay: false,
    environments: [],
  });
}

export function sendView(ctx: Context, response: ServerResponse, id: string | null): void {
  if (!lookup(ctx, id)) {
    sendHtml(response, "<!doctype html><meta charset=utf-8><title>Meridian</title><p>Unknown graph id.</p>", 404);
    return;
  }
  sendHtml(response, injectViewBoot(ctx.rendererIndex, id as string, ctx.reviews.get(id as string)));
}

function lookup(ctx: Context, id: string | null): GraphArtifact | undefined {
  return id ? ctx.graphs.get(id) : undefined;
}
