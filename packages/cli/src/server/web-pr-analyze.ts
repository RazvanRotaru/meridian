/**
 * POST /api/pr/analyze — clone a repo at a PR's head, diff it against the PR base, extract the
 * graph with the touched nodes tagged "changed", store the artifact, and STREAM progress to the
 * browser as NDJSON (one JSON object per line, flushed as work proceeds).
 *
 * This is the PR-review sibling of `/api/generate` (web-graph.ts): it stores the artifact under a
 * fresh id in `ctx.graphs`/`ctx.sourceRoots`/`ctx.sources` so the browser then loads it with
 * `GET /api/graph?id=` and slices code with `GET /api/source?id=`. Unlike generate it needs FULL
 * history (a shallow clone can't resolve `merge-base` against the base branch), so the clone omits
 * `--depth 1 --single-branch`. The token is resolved by the same precedence and never leaks — it
 * travels only in a scrubbed `http.extraHeader`, and any git failure is reduced to a safe message.
 */

import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { GraphArtifact } from "@meridian/core";
import { extractToArtifact } from "../extract-pipeline";
import { base64Auth, runGit, runGitClone } from "./git-exec";
import { parseGitHubSource, sanitizeSubdir } from "./clone";
import { readJsonBody } from "./web-request";
import { githubTokenFor } from "./web-auth";
import { WebError } from "./web-error";
import type { ArtifactSource } from "./web-source";
import type { Context } from "./web-server";

const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

type GitHubSource = Extract<ArtifactSource, { kind: "github" }>;

interface PrAnalyzeRequest {
  id: string;
  prNumber: number;
  baseRef: string;
  headRef: string;
}

export async function handlePrAnalyze(ctx: Context, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const body = parsePrAnalyzeRequest(await readJsonBody(request));
  const source = requireGitHubSource(ctx, body.id);
  const token = githubTokenFor(ctx, request);
  beginNdjson(response);
  await streamAnalysis(ctx, response, source, token, body);
}

/**
 * The streamed body. Every stage writes a line before the work it names starts, so the browser
 * sees "clone → checkout → extract" progress; any failure collapses to a single `error` line and
 * a clean temp-dir removal. The temp clone is retained (cleaned at process exit) only on success,
 * so `/api/source` can keep reading its files — mirroring `/api/generate`.
 */
async function streamAnalysis(
  ctx: Context,
  response: ServerResponse,
  source: GitHubSource,
  token: string | undefined,
  body: PrAnalyzeRequest,
): Promise<void> {
  const label = `${source.owner}/${source.repo}`;
  const tmpRoot = realpathSync.native(mkdtempSync(join(tmpdir(), "blueprint-pr-")));
  const removeTmp = () => rmSync(tmpRoot, { recursive: true, force: true });
  let retained = false;
  try {
    writeLine(response, { stage: "clone", message: `Cloning ${label}...` });
    await cloneFullHistory(parseGitHubSource(label), tmpRoot, token);

    writeLine(response, { stage: "checkout", message: `Fetching PR #${body.prNumber} head + base...` });
    await checkoutPrHead(tmpRoot, body.baseRef, body.prNumber, token);

    writeLine(response, { stage: "extract", message: "Extracting modified nodes..." });
    const { artifact, warnings } = await extractPr(tmpRoot, source, body.baseRef, label);

    const graphId = storeArtifact(ctx, artifact, source, tmpRoot, body, removeTmp);
    retained = true;
    writeLine(response, doneLine(graphId, artifact, warnings));
  } catch (error) {
    writeLine(response, { stage: "error", message: safeMessage(error) });
  } finally {
    if (!retained) {
      removeTmp();
    }
    response.end();
  }
}

/** A full clone (no `--depth 1`) so `git diff --merge-base <base>` has the history it needs. */
async function cloneFullHistory(url: string, dir: string, token?: string): Promise<void> {
  const args: string[] = [];
  if (token) {
    args.push("-c", `http.extraHeader=AUTHORIZATION: basic ${base64Auth(token)}`);
  }
  args.push("-c", "core.longpaths=true", "clone", "--no-tags", "--", url, dir);
  await runGitClone(args, token);
}

/**
 * Make the PR head the working tree and the base branch reachable. Fetch the base first (it lands
 * in `refs/remotes/origin/<base>`, our `changedSince` ref), then the PR head into FETCH_HEAD, then
 * detach onto FETCH_HEAD — so a fork's head resolves without depending on a local branch name.
 */
async function checkoutPrHead(cwd: string, baseRef: string, prNumber: number, token?: string): Promise<void> {
  await runGit(["fetch", "origin", baseRef], { cwd, token });
  await runGit(["fetch", "origin", `pull/${prNumber}/head`], { cwd, token });
  await runGit(["checkout", "--detach", "FETCH_HEAD"], { cwd });
}

/** Extract from the (optionally subdir'd) clone, tagging nodes the PR touched vs `origin/<base>`. */
async function extractPr(
  cloneDir: string,
  source: GitHubSource,
  baseRef: string,
  label: string,
): Promise<{ artifact: GraphArtifact; warnings: string[] }> {
  const root = sanitizeSubdir(cloneDir, source.subdir);
  const { artifact, warnings } = await extractToArtifact({
    absoluteRoot: root,
    cwd: root, // records target.root as "." — never leaks the temp clone path
    depth: "function",
    materializeBoundary: false,
    targetName: label,
    changedSince: `origin/${baseRef}`,
  });
  return { artifact, warnings };
}

function storeArtifact(
  ctx: Context,
  artifact: GraphArtifact,
  source: GitHubSource,
  tmpRoot: string,
  body: PrAnalyzeRequest,
  removeTmp: () => void,
): string {
  const graphId = prGraphId(source, body);
  ctx.graphs.set(graphId, artifact);
  ctx.sourceRoots.set(graphId, sanitizeSubdir(tmpRoot, source.subdir));
  ctx.sources.set(graphId, { kind: "github", owner: source.owner, repo: source.repo, subdir: source.subdir });
  ctx.tempCleanups.add(removeTmp);
  return graphId;
}

/** The terminal `done` line: the new graph id, its counts, the changed files, and any warnings. */
function doneLine(graphId: string, artifact: GraphArtifact, warnings: string[]): Record<string, unknown> {
  return {
    stage: "done",
    graphId,
    counts: { nodes: artifact.nodes.length, edges: artifact.edges.length },
    changedFiles: changedFilesOf(artifact),
    warnings,
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

/** Deterministic id so re-analyzing the same PR head overwrites rather than accumulating clones. */
function prGraphId(source: GitHubSource, body: PrAnalyzeRequest): string {
  const key = ["pr", source.owner, source.repo, source.subdir ?? "", body.prNumber, body.headRef].join(" ");
  return `pr-${createHash("sha1").update(key).digest("hex").slice(0, 12)}`;
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

function parsePrAnalyzeRequest(body: unknown): PrAnalyzeRequest {
  if (typeof body !== "object" || body === null) {
    throw new WebError(400, "request body must be a JSON object");
  }
  const raw = body as Record<string, unknown>;
  return {
    id: requireString(raw.id, "id"),
    prNumber: requirePositiveInt(raw.prNumber, "prNumber"),
    baseRef: requireRef(raw.baseRef, "baseRef"),
    headRef: requireRef(raw.headRef, "headRef"),
  };
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new WebError(400, `${name} is required`);
  }
  return value.trim();
}

function requireRef(value: unknown, name: string): string {
  const ref = requireString(value, name);
  if (!SAFE_REF.test(ref)) {
    throw new WebError(400, `${name} contains illegal characters`);
  }
  return ref;
}

function requirePositiveInt(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new WebError(400, `${name} must be a positive integer`);
  }
  return value;
}
