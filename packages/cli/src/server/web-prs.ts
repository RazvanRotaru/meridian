import type { IncomingMessage, ServerResponse } from "node:http";
import {
  editPullRequestComment,
  fetchCommitChecks,
  fetchFileAtRef,
  fetchPullRequest,
  fetchPullRequestDiscussion,
  fetchPullRequestFiles,
  listPullRequests,
  replyToPullRequestComment,
} from "./github";
import {
  submitPullRequestReview,
  type PullRequestReviewEvent,
  type ReviewCommentInput,
  type ReviewFileCommentInput,
} from "./github-review";
import { sendJson } from "./http-response";
import { githubTokenFor, githubUserFor } from "./web-auth";
import { WebError } from "./web-error";
import { readJsonBody } from "./web-request";
import type { Context } from "./web-server";
import type { ArtifactSource } from "./web-source";
import { deepestCommonDirectory, partitionExtractionSubdir, restoreExtractionSubdir } from "./web-source";
import type { PrSummary } from "./github-parse";

const GITHUB_SOURCE_ERROR = "pull requests need a GitHub-sourced session";
/** Sanity bound; the 64KB body cap constrains the real payload long before this. */
const MAX_REVIEW_COMMENTS = 100;
const MAX_REVIEW_BODY_LENGTH = 10_000;
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
  const search = query.get("q")?.trim() ?? "";
  const page = search ? 1 : parsePositiveInt(query.get("page"), "page");
  const token = githubTokenFor(ctx, request);
  const result = await listPullRequests({
    owner: source.owner,
    repo: source.repo,
    state,
    page,
    token,
    ...(search ? { query: search } : {}),
  });
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
 * are extraction-relative, so comparison restores the extraction prefix. Cached paths stay
 * repo-root-relative while result paths use the requesting renderer's extraction-relative vocabulary.
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
  const requested = parseRelatedPaths(await readJsonBody(request, ctx.shutdownSignal), source.subdir);
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
  let repoPaths: string[];
  if (cached?.updatedAt === pr.updatedAt && cached.headSha === pr.headSha) {
    repoPaths = cached.paths;
  } else {
    // An old file list must never remain usable after GitHub reports a newer PR summary.
    ctx.prFilesCache.delete(key);
    const fetched = await fetchPullRequestFiles({ owner: source.owner, repo: source.repo, prNumber: pr.number, token });
    repoPaths = dedupeSafePaths(fetched.files.map((file) => file.path));
    ctx.prFilesCache.set(key, { updatedAt: pr.updatedAt, headSha: pr.headSha, paths: repoPaths });
  }
  return partitionExtractionSubdir(repoPaths.map((path) => ({ path })), source.subdir).inside.map((file) => file.path);
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
  sendJson(response, 200, await pullRequestDiscussion(ctx, request, source, prNumber));
}

/** Edit an authored review comment or reply to a top-level review thread, then refresh the rail. */
export async function handlePullRequestCommentMutation(
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
  const body = parseCommentMutationBody(await readJsonBody(request, ctx.shutdownSignal));
  const token = githubTokenFor(ctx, request);
  if (!token) {
    throw new WebError(401, "editing or replying to a comment requires a GitHub sign-in");
  }
  const mutation = {
    owner: source.owner,
    repo: source.repo,
    prNumber: body.number,
    commentId: body.commentId,
    body: body.body,
    token,
  };
  if (body.action === "edit") {
    await editPullRequestComment(mutation);
  } else {
    await replyToPullRequestComment(mutation);
  }
  sendJson(response, 200, await pullRequestDiscussion(ctx, request, source, body.number));
}

async function pullRequestDiscussion(
  ctx: Context,
  request: IncomingMessage,
  source: Extract<ArtifactSource, { kind: "github" }>,
  prNumber: number,
): Promise<Record<string, unknown>> {
  const result = await fetchPullRequestDiscussion({
    owner: source.owner,
    repo: source.repo,
    prNumber,
    token: githubTokenFor(ctx, request),
  });
  const viewer = githubUserFor(ctx, request)?.login.toLowerCase() ?? null;
  const comments = partitionExtractionSubdir(result.comments, source.subdir).inside.map((comment) => ({
    ...comment,
    viewerCanEdit: viewer !== null && comment.author.toLowerCase() === viewer,
  }));
  return { ...result, comments };
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
  sendJson(response, 200, { file, ...result });
}

interface CommentMutationBody {
  number: number;
  action: "edit" | "reply";
  commentId: number;
  body: string;
}

function parseCommentMutationBody(raw: unknown): CommentMutationBody {
  const record = asRecord(raw);
  const number = positiveBodyInteger(record.number, "number");
  const commentId = positiveBodyInteger(record.commentId, "commentId");
  if (record.action !== "edit" && record.action !== "reply") {
    throw new WebError(400, "action must be 'edit' or 'reply'");
  }
  if (!isFilledString(record.body)) {
    throw new WebError(400, "body must be a non-empty string");
  }
  return { number, action: record.action, commentId, body: record.body.trim() };
}

function positiveBodyInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new WebError(400, `${name} must be a positive integer`);
  }
  return value;
}

/**
 * POST /api/prs/review — submit a comment, approval, or changes-requested review. This GitHub write:
 * it requires a resolved token (401 otherwise, never an anonymous call). API-safe entries become
 * inline diff comments; structured file comments become real GitHub FILE-subject review threads.
 * Requesting changes still requires an explicit review-level summary.
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
  const body = parseSubmitReviewBody(await readJsonBody(request, ctx.shutdownSignal));
  const token = githubTokenFor(ctx, request);
  if (!token) {
    throw new WebError(401, "submitting a review requires a GitHub sign-in");
  }
  const comments = body.comments.map((comment) => ({ ...comment, path: restoreExtractionSubdir(comment.path, source.subdir) }));
  const fileComments = body.fileComments.map((comment) => ({
    ...comment,
    path: restoreExtractionSubdir(comment.path, source.subdir),
  }));
  const result = await submitPullRequestReview({
    owner: source.owner,
    repo: source.repo,
    prNumber: body.number,
    comments,
    fileComments,
    event: body.event,
    body: body.body,
    commitId: body.commitId,
    token,
  });
  sendJson(response, 200, result);
}

interface SubmitReviewBody {
  number: number;
  comments: ReviewCommentInput[];
  fileComments: ReviewFileCommentInput[];
  event: PullRequestReviewEvent;
  body?: string;
  commitId?: string;
}

function parseSubmitReviewBody(raw: unknown): SubmitReviewBody {
  if (typeof raw !== "object" || raw === null) {
    throw new WebError(400, "request body must be a JSON object");
  }
  const record = raw as Record<string, unknown>;
  if (typeof record.number !== "number" || !Number.isSafeInteger(record.number) || record.number <= 0) {
    throw new WebError(400, "number must be a positive integer");
  }
  const event = parseReviewEvent(record.event);
  const body = optionalReviewBody(record.body);
  const comments = boundedArray(record.comments, "comments").map(parseComment);
  if (record.notes !== undefined) {
    throw new WebError(400, "notes are not supported; use fileComments for file-level review threads");
  }
  const fileComments = boundedArray(record.fileComments, "fileComments").map(parseFileComment);
  const commitId = optionalCommitId(record.commitId);
  if (event === "COMMENT" && comments.length === 0 && fileComments.length === 0 && body === undefined) {
    throw new WebError(400, "a comment review needs at least one inline comment, file comment, or body");
  }
  if (event === "REQUEST_CHANGES" && body === undefined) {
    throw new WebError(400, "requesting changes requires a review summary");
  }
  return { number: record.number, comments, fileComments, event, body, commitId };
}

function parseReviewEvent(value: unknown): PullRequestReviewEvent {
  if (value === undefined || value === "COMMENT") return "COMMENT";
  if (value === "APPROVE" || value === "REQUEST_CHANGES") return value;
  throw new WebError(400, "event must be COMMENT, APPROVE, or REQUEST_CHANGES");
}

function optionalReviewBody(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || value.trim().length === 0 || value.length > MAX_REVIEW_BODY_LENGTH) {
    throw new WebError(400, `body must be a non-empty string of at most ${MAX_REVIEW_BODY_LENGTH} characters`);
  }
  return value.trim();
}

function optionalCommitId(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || !HEAD_SHA.test(value.trim())) {
    throw new WebError(400, "commitId must be a 7 to 40 character hexadecimal commit id");
  }
  return value.trim();
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
  const { path, line, body, side = "RIGHT" } = comment;
  const validLine = typeof line === "number" && Number.isSafeInteger(line) && line > 0;
  if (!isFilledString(path) || !validLine || (side !== "LEFT" && side !== "RIGHT") || !isFilledString(body)) {
    throw new WebError(400, "each comment needs a path, a positive line, LEFT or RIGHT side, and a non-empty body");
  }
  return { path, line: line as number, side, body };
}

function parseFileComment(entry: unknown): ReviewFileCommentInput {
  const comment = asRecord(entry);
  const { path, label, body } = comment;
  if (
    !isFilledString(path)
    || (label !== undefined && label !== null && !isFilledString(label))
    || !isFilledString(body)
  ) {
    throw new WebError(400, "each file comment needs a path, optional label, and non-empty body");
  }
  return { path, label: label === undefined ? null : label, body };
}

function asRecord(entry: unknown): Record<string, unknown> {
  return typeof entry === "object" && entry !== null ? (entry as Record<string, unknown>) : {};
}

function isFilledString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function githubSource(ctx: Context, id: string | null): Extract<ArtifactSource, { kind: "github" }> | null {
  const registration = id ? ctx.graphStore.acquire(id) : undefined;
  try {
    const source = registration?.descriptor.source;
    return source?.kind === "github" ? source : null;
  } finally {
    registration?.release();
  }
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
