import type { IncomingMessage, ServerResponse } from "node:http";
import {
  fetchCommitChecks,
  fetchFileAtRef,
  fetchPullRequest,
  fetchPullRequestDiscussion,
  fetchPullRequestFiles,
  listPullRequests,
} from "./github";
import { submitPullRequestReview, type ReviewCommentInput } from "./github-review";
import { sendJson } from "./http-response";
import { githubTokenFor } from "./web-auth";
import { WebError } from "./web-error";
import { readJsonBody } from "./web-request";
import type { Context } from "./web-server";
import type { ArtifactSource } from "./web-source";
import { deepestCommonDirectory, partitionExtractionSubdir, restoreExtractionSubdir } from "./web-source";
import type { PrSummary } from "./github-parse";

const GITHUB_SOURCE_ERROR = "pull requests need a GitHub-sourced session";
/** Sanity bound; the 64KB body cap constrains the real payload long before this. */
const MAX_REVIEW_COMMENTS = 100;
const MAX_RELATED_PATHS = 100;
const RELATED_PR_PAGES = 3;
const RELATED_PR_CONCURRENCY = 4;
const HEAD_SHA = /^[0-9a-f]{7,40}$/i;

export async function handlePullRequests(
  ctx: Context,
  request: IncomingMessage,
  response: ServerResponse,
  query: URLSearchParams,
): Promise<void> {
  const source = githubSource(ctx, query.get("id"));
  if (!source) {
    sendJson(response, 404, { error: GITHUB_SOURCE_ERROR });
    return;
  }
  const state = parseState(query.get("state"));
  const page = parsePositiveInt(query.get("page"), "page");
  const token = githubTokenFor(ctx, request);
  const result = await listPullRequests({ owner: source.owner, repo: source.repo, state, page, token });
  sendJson(response, 200, result);
}

interface RelatedPr {
  number: number;
  title: string;
  author: string;
  headRef: string;
  updatedAt: string;
  draft: boolean;
  matchCount: number;
  matchedPaths: string[];
}

interface RelatedPrCandidate {
  pr: PrSummary;
  paths: string[];
}

/**
 * POST /api/prs/related — scan at most 90 open PRs for exact path intersections. Browser paths
 * are extraction-relative, so comparison restores the extraction prefix while cached/result paths
 * stay in the renderer's extraction-relative vocabulary.
 */
export async function handleRelatedPullRequests(
  ctx: Context,
  request: IncomingMessage,
  response: ServerResponse,
  query: URLSearchParams,
): Promise<void> {
  const source = githubSource(ctx, query.get("id"));
  if (!source) {
    sendJson(response, 404, { error: GITHUB_SOURCE_ERROR });
    return;
  }
  const requested = parseRelatedPaths(await readJsonBody(request), source.subdir);
  if (requested.size === 0) {
    sendJson(response, 200, { results: [], scanned: 0, hasMore: false, skipped: 0 });
    return;
  }

  const token = githubTokenFor(ctx, request);
  const prs: PrSummary[] = [];
  let hasMore = false;
  for (let page = 1; page <= RELATED_PR_PAGES; page += 1) {
    const result = await listPullRequests({ owner: source.owner, repo: source.repo, state: "open", page, token });
    prs.push(...result.prs);
    hasMore = result.hasMore;
    if (!hasMore) {
      break;
    }
  }

  const results: RelatedPr[] = [];
  let skipped = 0;
  for (let offset = 0; offset < prs.length; offset += RELATED_PR_CONCURRENCY) {
    const batch = prs.slice(offset, offset + RELATED_PR_CONCURRENCY);
    const candidates = await Promise.all(
      batch.map(async (pr): Promise<RelatedPrCandidate | null> => {
        try {
          return { pr, paths: await relatedPathsForPr(ctx, source, pr, token) };
        } catch {
          return null;
        }
      }),
    );
    for (const candidate of candidates) {
      if (!candidate) {
        skipped += 1;
        continue;
      }
      const matchedPaths = candidate.paths.filter((path) => requested.has(repoRelativePath(path, source.subdir)));
      if (matchedPaths.length > 0) {
        results.push(toRelatedPr(candidate.pr, matchedPaths));
      }
    }
  }
  results.sort((left, right) => right.matchCount - left.matchCount || right.number - left.number);
  sendJson(response, 200, { results, scanned: prs.length, hasMore, skipped });
}

async function relatedPathsForPr(
  ctx: Context,
  source: Extract<ArtifactSource, { kind: "github" }>,
  pr: PrSummary,
  token: string | undefined,
): Promise<string[]> {
  const key = `${source.owner}/${source.repo}#${pr.number}`;
  const cached = ctx.prFilesCache.get(key);
  if (cached?.updatedAt === pr.updatedAt) {
    return cached.paths;
  }
  // An old file list must never remain usable after GitHub reports a newer PR summary.
  ctx.prFilesCache.delete(key);
  const fetched = await fetchPullRequestFiles({ owner: source.owner, repo: source.repo, prNumber: pr.number, token });
  const paths = dedupeSafePaths(partitionExtractionSubdir(fetched.files, source.subdir).inside.map((file) => file.path));
  ctx.prFilesCache.set(key, { updatedAt: pr.updatedAt, paths });
  return paths;
}

function parseRelatedPaths(raw: unknown, subdir: string | undefined): Set<string> {
  const body = asRecord(raw);
  if (!Array.isArray(body.paths)) {
    throw new WebError(400, `paths must be an array capped at ${MAX_RELATED_PATHS} entries`);
  }
  const restored: string[] = [];
  for (const path of body.paths.slice(0, MAX_RELATED_PATHS)) {
    if (!isFilledString(path)) {
      throw new WebError(400, "each path must be a non-empty string");
    }
    if (hasParentSegment(path)) {
      continue;
    }
    const normalized = repoRelativePath(path, subdir);
    if (normalized.length > 0 && !hasParentSegment(normalized)) {
      restored.push(normalized);
    }
  }
  return new Set(restored);
}

function repoRelativePath(path: string, subdir: string | undefined): string {
  return normalizeRelatedPath(restoreExtractionSubdir(path, subdir));
}

function dedupeSafePaths(paths: string[]): string[] {
  return [...new Set(paths.map(normalizeRelatedPath).filter((path) => path.length > 0 && !hasParentSegment(path)))];
}

function normalizeRelatedPath(path: string): string {
  return path
    .trim()
    .replace(/\\/g, "/")
    .split("/")
    .filter((segment) => segment.length > 0 && segment !== ".")
    .join("/");
}

function hasParentSegment(path: string): boolean {
  return path.replace(/\\/g, "/").split("/").includes("..");
}

function toRelatedPr(pr: PrSummary, matchedPaths: string[]): RelatedPr {
  return {
    number: pr.number,
    title: pr.title,
    author: pr.author,
    headRef: pr.headRef,
    updatedAt: pr.updatedAt,
    draft: pr.draft,
    matchCount: matchedPaths.length,
    matchedPaths: matchedPaths.slice(0, 10),
  };
}

export async function handlePullRequestFiles(
  ctx: Context,
  request: IncomingMessage,
  response: ServerResponse,
  query: URLSearchParams,
): Promise<void> {
  const source = githubSource(ctx, query.get("id"));
  if (!source) {
    sendJson(response, 404, { error: GITHUB_SOURCE_ERROR });
    return;
  }
  const prNumber = parsePositiveInt(query.get("n"), "n");
  const result = await fetchPullRequestFiles({ owner: source.owner, repo: source.repo, prNumber, token: githubTokenFor(ctx, request) });
  const { inside: files, outside } = partitionExtractionSubdir(result.files, source.subdir);
  sendJson(response, 200, {
    files,
    truncated: result.truncated,
    totalFiles: result.files.length,
    outsideCount: outside.length,
    suggestedSubdir: deepestCommonDirectory(outside),
  });
}

export async function handlePullRequestOne(
  ctx: Context,
  request: IncomingMessage,
  response: ServerResponse,
  query: URLSearchParams,
): Promise<void> {
  const source = githubSource(ctx, query.get("id"));
  if (!source) {
    sendJson(response, 404, { error: GITHUB_SOURCE_ERROR });
    return;
  }
  // Parse before fetchPullRequest can interpolate the number into GitHub's outbound URL path.
  const number = parsePositiveInt(query.get("n"), "n");
  const pr = await fetchPullRequest(globalThis.fetch, { owner: source.owner, repo: source.repo, number, token: githubTokenFor(ctx, request) });
  sendJson(response, 200, { pr });
}

export async function handlePullRequestComments(
  ctx: Context,
  request: IncomingMessage,
  response: ServerResponse,
  query: URLSearchParams,
): Promise<void> {
  const source = githubSource(ctx, query.get("id"));
  if (!source) {
    sendJson(response, 404, { error: GITHUB_SOURCE_ERROR });
    return;
  }
  // This validation must precede fetchPullRequestDiscussion, where the number enters URL paths.
  const prNumber = parsePositiveInt(query.get("n"), "n");
  const result = await fetchPullRequestDiscussion({
    owner: source.owner,
    repo: source.repo,
    prNumber,
    token: githubTokenFor(ctx, request),
  });
  const comments = partitionExtractionSubdir(result.comments, source.subdir).inside;
  sendJson(response, 200, { ...result, comments });
}

export async function handlePullRequestChecks(
  ctx: Context,
  request: IncomingMessage,
  response: ServerResponse,
  query: URLSearchParams,
): Promise<void> {
  const source = githubSource(ctx, query.get("id"));
  if (!source) {
    sendJson(response, 404, { error: GITHUB_SOURCE_ERROR });
    return;
  }
  // Validate both attacker-controlled path inputs before fetchCommitChecks constructs its URL.
  parsePositiveInt(query.get("n"), "n");
  const sha = parseHeadSha(query.get("sha"));
  const checks = await fetchCommitChecks({ owner: source.owner, repo: source.repo, sha, token: githubTokenFor(ctx, request) });
  sendJson(response, 200, checks);
}

/**
 * One changed file's text at the PR head ref, for the review code panel. The graph stays the base
 * clone (the instant overlay); this fetches just the file being opened — so opening `</>` on a
 * PR-changed unit shows the PR's actual head code + its head-relative diff, with no re-clone or
 * re-extract. The browser knows the path subdir-STRIPPED; the repo-root prefix is restored here.
 */
export async function handlePullRequestFileContent(
  ctx: Context,
  request: IncomingMessage,
  response: ServerResponse,
  query: URLSearchParams,
): Promise<void> {
  const source = githubSource(ctx, query.get("id"));
  if (!source) {
    sendJson(response, 404, { error: GITHUB_SOURCE_ERROR });
    return;
  }
  const ref = query.get("ref");
  const file = query.get("path");
  if (!ref || ref.length > 200 || !file || file.split("/").includes("..")) {
    throw new WebError(400, "ref and path are required");
  }
  const repoPath = restoreExtractionSubdir(file, source.subdir);
  const result = await fetchFileAtRef({ owner: source.owner, repo: source.repo, ref, path: repoPath, token: githubTokenFor(ctx, request) });
  sendJson(response, 200, { file, code: result.code, truncated: result.truncated });
}

/**
 * POST /api/prs/review — submit a COMMENT review to the PR. The one GitHub WRITE in the server:
 * it requires a resolved token (401 otherwise, never an anonymous call). Anchored `comments`
 * become inline diff comments; anchorless `notes` fold into the review body. Both carry paths the
 * browser knows subdir-STRIPPED, so the repo-root prefix is restored here — for notes too, which
 * is exactly why the body is assembled server-side rather than shipped as prose.
 */
export async function handleSubmitReview(
  ctx: Context,
  request: IncomingMessage,
  response: ServerResponse,
  query: URLSearchParams,
): Promise<void> {
  const source = githubSource(ctx, query.get("id"));
  if (!source) {
    sendJson(response, 404, { error: GITHUB_SOURCE_ERROR });
    return;
  }
  const body = parseSubmitReviewBody(await readJsonBody(request));
  const token = githubTokenFor(ctx, request);
  if (!token) {
    throw new WebError(401, "submitting a review requires a GitHub sign-in");
  }
  const comments = body.comments.map((comment) => ({ ...comment, path: restoreExtractionSubdir(comment.path, source.subdir) }));
  const reviewBody = body.notes
    .map((note) => `**${restoreExtractionSubdir(note.path, source.subdir)}**${note.label ? ` · ${note.label}` : ""}: ${note.body}`)
    .join("\n\n");
  const result = await submitPullRequestReview({ owner: source.owner, repo: source.repo, prNumber: body.number, body: reviewBody, comments, token });
  sendJson(response, 200, result);
}

/** A review note without a diff line to stand on; folds into the review body, path restored. */
interface ReviewNoteInput {
  path: string;
  label: string | null;
  body: string;
}

interface SubmitReviewBody {
  number: number;
  comments: ReviewCommentInput[];
  notes: ReviewNoteInput[];
}

function parseSubmitReviewBody(raw: unknown): SubmitReviewBody {
  if (typeof raw !== "object" || raw === null) {
    throw new WebError(400, "request body must be a JSON object");
  }
  const record = raw as Record<string, unknown>;
  if (typeof record.number !== "number" || !Number.isSafeInteger(record.number) || record.number <= 0) {
    throw new WebError(400, "number must be a positive integer");
  }
  const comments = boundedArray(record.comments, "comments").map(parseComment);
  const notes = boundedArray(record.notes, "notes").map(parseNote);
  if (comments.length === 0 && notes.length === 0) {
    throw new WebError(400, "a review needs at least one comment");
  }
  return { number: record.number, comments, notes };
}

function boundedArray(raw: unknown, name: string): unknown[] {
  if (raw === undefined) {
    return [];
  }
  if (!Array.isArray(raw) || raw.length > MAX_REVIEW_COMMENTS) {
    throw new WebError(400, `${name} must be an array of at most ${MAX_REVIEW_COMMENTS}`);
  }
  return raw;
}

function parseComment(entry: unknown): ReviewCommentInput {
  const comment = asRecord(entry);
  const { path, line, body } = comment;
  const validLine = typeof line === "number" && Number.isSafeInteger(line) && line > 0;
  if (!isFilledString(path) || !validLine || !isFilledString(body)) {
    throw new WebError(400, "each comment needs a path, a positive line, and a non-empty body");
  }
  return { path, line: line as number, body };
}

function parseNote(entry: unknown): ReviewNoteInput {
  const note = asRecord(entry);
  const { path, label, body } = note;
  if (!isFilledString(path) || !isFilledString(body)) {
    throw new WebError(400, "each note needs a path and a non-empty body");
  }
  return { path, label: isFilledString(label) ? label : null, body };
}

function asRecord(entry: unknown): Record<string, unknown> {
  return typeof entry === "object" && entry !== null ? (entry as Record<string, unknown>) : {};
}

function isFilledString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function githubSource(ctx: Context, id: string | null): Extract<ArtifactSource, { kind: "github" }> | null {
  const source = id ? ctx.sources.get(id) : undefined;
  return source?.kind === "github" ? source : null;
}

function parseState(state: string | null): "open" | "closed" {
  if (state === "open" || state === "closed") {
    return state;
  }
  throw new WebError(400, "state must be 'open' or 'closed'");
}

function parsePositiveInt(raw: string | null, name: string): number {
  const value = raw && /^[1-9]\d*$/.test(raw) ? Number(raw) : 0;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new WebError(400, `${name} must be a positive integer`);
  }
  return value;
}

function parseHeadSha(raw: string | null): string {
  if (!raw || !HEAD_SHA.test(raw)) {
    throw new WebError(400, "sha must be a 7 to 40 character hexadecimal commit id");
  }
  return raw;
}
