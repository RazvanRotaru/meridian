/**
 * Submit one pull-request review without losing comments GitHub cannot anchor to a diff line.
 * Inline-only reviews use GitHub's atomic REST create endpoint directly. A review containing file
 * comments is assembled as one PENDING review: REST creates it with the summary and valid inline
 * comments, GraphQL attaches FILE threads, and REST submits the requested event. Any failure after
 * creation rolls back only that newly-created pending review.
 */

import { parseReviewSubmitted } from "./github-parse";
import {
  deleteApi,
  getApiPage,
  GitHubReviewValidationError,
  postApi,
  postGraphql,
  repoApi,
} from "./github-http";
import { WebError } from "./web-error";

/** One inline comment anchored to a new-side line of the PR diff. */
export interface ReviewCommentInput {
  path: string;
  line: number;
  body: string;
}

/** One GitHub FILE-subject review thread. `label` retains the requested semantic/line location. */
export interface ReviewFileCommentInput {
  path: string;
  label: string | null;
  body: string;
}

export type PullRequestReviewEvent = "COMMENT" | "APPROVE" | "REQUEST_CHANGES";

export interface SubmitReviewRequest {
  owner: string;
  repo: string;
  prNumber: number;
  comments: ReviewCommentInput[];
  fileComments?: ReviewFileCommentInput[];
  event: PullRequestReviewEvent;
  body?: string;
  /** Commit whose diff the renderer reviewed. Pinning it closes the latest-head submit race. */
  commitId?: string;
  /** Required: reviews are a write — the caller must have resolved a token before getting here. */
  token: string;
}

export interface SubmitReviewResult {
  url: string | null;
  /** True when GitHub rejected an inline anchor and every inline draft was retried as a FILE thread. */
  forced: boolean;
  /** True when a caller-visible pending review had to be submitted before creating this review. */
  pendingMerged: boolean;
}

interface SubmitAttempt {
  forced: boolean;
  pendingRecovered: boolean;
}

interface CreatedPendingReview {
  id: number;
  nodeId: string;
}

interface VisiblePendingReview {
  id: number;
}

const ADD_FILE_REVIEW_THREAD = `
mutation AddPullRequestReviewThread($reviewId: ID!, $path: String!, $body: String!) {
  addPullRequestReviewThread(input: {
    pullRequestReviewId: $reviewId
    subjectType: FILE
    path: $path
    body: $body
  }) {
    thread { id }
  }
}`;

export function submitPullRequestReview(request: SubmitReviewRequest): Promise<SubmitReviewResult> {
  return submitPullRequestReviewWithFetch(globalThis.fetch, request);
}

export function submitPullRequestReviewWithFetch(
  fetchImpl: typeof fetch,
  request: SubmitReviewRequest,
): Promise<SubmitReviewResult> {
  return submitWithRecovery(fetchImpl, request, { forced: false, pendingRecovered: false });
}

async function submitWithRecovery(
  fetchImpl: typeof fetch,
  request: SubmitReviewRequest,
  attempt: SubmitAttempt,
): Promise<SubmitReviewResult> {
  const reviewsUrl = repoApi(request.owner, request.repo, `/pulls/${request.prNumber}/reviews`);
  try {
    const submitted = (request.fileComments?.length ?? 0) === 0
      ? await submitDirectReview(fetchImpl, reviewsUrl, request)
      : await submitReviewWithFileThreads(fetchImpl, reviewsUrl, request);
    return {
      ...submitted,
      forced: attempt.forced,
      pendingMerged: attempt.pendingRecovered,
    };
  } catch (error) {
    if (!(error instanceof GitHubReviewValidationError)) {
      throw error;
    }
    if (error.kind === "pending-review" && !attempt.pendingRecovered) {
      const pending = await findVisiblePendingReview(fetchImpl, reviewsUrl, request.token);
      if (pending === null) {
        throw error;
      }
      // Do not rewrite or append to the caller's existing draft. Submitting only the event keeps
      // its body and attached comments intact, then frees GitHub's one-pending-review slot.
      await postApi(fetchImpl, `${reviewsUrl}/${pending.id}/events`, { event: "COMMENT" }, request.token);
      return submitWithRecovery(fetchImpl, request, { ...attempt, pendingRecovered: true });
    }
    if (error.kind === "anchor" && !attempt.forced && request.comments.length > 0) {
      // GitHub does not identify the invalid member of an inline batch. Retry once with the entire
      // inline set represented as honest FILE threads; the first rejected create was non-mutating.
      return submitWithRecovery(fetchImpl, {
        ...request,
        comments: [],
        fileComments: [
          ...(request.fileComments ?? []),
          ...request.comments.map(inlineAsFileComment),
        ],
      }, { ...attempt, forced: true });
    }
    throw error;
  }
}

async function submitDirectReview(
  fetchImpl: typeof fetch,
  reviewsUrl: string,
  request: SubmitReviewRequest,
): Promise<{ url: string | null }> {
  return parseReviewSubmitted(await postApi(
    fetchImpl,
    reviewsUrl,
    directReviewPayload(request),
    request.token,
  ));
}

async function submitReviewWithFileThreads(
  fetchImpl: typeof fetch,
  reviewsUrl: string,
  request: SubmitReviewRequest,
): Promise<{ url: string | null }> {
  const rawCreated = await postApi(
    fetchImpl,
    reviewsUrl,
    pendingReviewPayload(request),
    request.token,
  );
  const created = await parseCreatedPendingReview(fetchImpl, reviewsUrl, request.token, rawCreated);
  try {
    for (const comment of request.fileComments ?? []) {
      await addFileReviewThread(fetchImpl, created.nodeId, comment, request.commitId, request.token);
    }
    return parseReviewSubmitted(await postApi(
      fetchImpl,
      `${reviewsUrl}/${created.id}/events`,
      { event: request.event },
      request.token,
    ));
  } catch (error) {
    await rollbackPendingReview(fetchImpl, reviewsUrl, created.id, request.token);
    throw error;
  }
}

function directReviewPayload(request: SubmitReviewRequest): Record<string, unknown> {
  return {
    ...(request.commitId ? { commit_id: request.commitId } : {}),
    event: request.event,
    comments: inlinePayload(request.comments),
    ...(request.body ? { body: request.body } : {}),
  };
}

function pendingReviewPayload(request: SubmitReviewRequest): Record<string, unknown> {
  return {
    ...(request.commitId ? { commit_id: request.commitId } : {}),
    comments: inlinePayload(request.comments),
    ...(request.body ? { body: request.body } : {}),
  };
}

function inlinePayload(comments: readonly ReviewCommentInput[]): Array<Record<string, unknown>> {
  return comments.map((comment) => ({
    path: comment.path,
    line: comment.line,
    side: "RIGHT",
    body: comment.body,
  }));
}

function inlineAsFileComment(comment: ReviewCommentInput): ReviewFileCommentInput {
  return {
    path: comment.path,
    label: `L${comment.line}`,
    body: comment.body,
  };
}

async function parseCreatedPendingReview(
  fetchImpl: typeof fetch,
  reviewsUrl: string,
  token: string,
  value: unknown,
): Promise<CreatedPendingReview> {
  const record = asRecord(value);
  const id = record.id;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) {
    throw new WebError(502, "GitHub returned an invalid pending review");
  }
  if (typeof record.node_id !== "string" || record.node_id.trim().length === 0) {
    await rollbackPendingReview(fetchImpl, reviewsUrl, id, token);
    throw new WebError(502, "GitHub returned an invalid pending review");
  }
  return { id, nodeId: record.node_id };
}

async function addFileReviewThread(
  fetchImpl: typeof fetch,
  reviewNodeId: string,
  comment: ReviewFileCommentInput,
  commitId: string | undefined,
  token: string,
): Promise<void> {
  const result = await postGraphql(fetchImpl, {
    query: ADD_FILE_REVIEW_THREAD,
    variables: {
      reviewId: reviewNodeId,
      path: comment.path,
      body: fileThreadBody(comment, commitId),
    },
  }, token);
  const data = asRecord(asRecord(result).data);
  const mutation = asRecord(data.addPullRequestReviewThread);
  const thread = asRecord(mutation.thread);
  if (typeof thread.id !== "string" || thread.id.length === 0) {
    throw new WebError(502, "GitHub could not attach a file-level review comment");
  }
}

function fileThreadBody(comment: ReviewFileCommentInput, commitId: string | undefined): string {
  const location: string[] = [];
  if (comment.label !== null) {
    location.push(codeSpan(comment.label));
  }
  if (commitId) {
    // This is the commit the submitted review targets. A draft explicitly labelled "previous
    // revision" may originate before it, so avoid claiming every FILE thread was authored there.
    location.push(`review commit ${codeSpan(commitId.slice(0, 7))}`);
  }
  return location.length === 0
    ? comment.body
    : `**Meridian location:** ${location.join(" · ")}\n\n${comment.body}`;
}

async function rollbackPendingReview(
  fetchImpl: typeof fetch,
  reviewsUrl: string,
  reviewId: number,
  token: string,
): Promise<void> {
  try {
    await deleteApi(fetchImpl, `${reviewsUrl}/${reviewId}`, token);
  } catch {
    // Preserve the original GraphQL/submission error. This DELETE targets only the review created
    // in this transaction; a rollback failure must never trigger mutation of another draft.
  }
}

async function findVisiblePendingReview(
  fetchImpl: typeof fetch,
  reviewsUrl: string,
  token: string,
): Promise<VisiblePendingReview | null> {
  const pending = new Map<number, VisiblePendingReview>();
  let complete = false;
  for (let page = 1; page <= 20; page += 1) {
    const separator = reviewsUrl.includes("?") ? "&" : "?";
    const result = await getApiPage(fetchImpl, `${reviewsUrl}${separator}per_page=100&page=${page}`, token);
    if (!Array.isArray(result.json)) {
      return null;
    }
    for (const value of result.json) {
      const review = visiblePendingReview(value);
      if (review !== null) {
        pending.set(review.id, review);
      }
    }
    if (!result.hasNext) {
      complete = true;
      break;
    }
  }
  return complete && pending.size === 1 ? [...pending.values()][0] : null;
}

function visiblePendingReview(value: unknown): VisiblePendingReview | null {
  const record = asRecord(value);
  return record.state === "PENDING"
    && typeof record.id === "number"
    && Number.isSafeInteger(record.id)
    && record.id > 0
    ? { id: record.id }
    : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

/** A CommonMark code span whose fence remains valid even for unusual labels. */
function codeSpan(value: string): string {
  const singleLine = value.replace(/\s+/g, " ").trim();
  const longestRun = [...singleLine.matchAll(/`+/g)].reduce((longest, match) => Math.max(longest, match[0].length), 0);
  const fence = "`".repeat(longestRun + 1);
  const padding = singleLine.startsWith("`") || singleLine.endsWith("`") ? " " : "";
  return `${fence}${padding}${singleLine}${padding}${fence}`;
}
