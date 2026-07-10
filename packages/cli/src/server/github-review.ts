/**
 * The one GitHub WRITE: submit a pull-request review. Split from github.ts (the read client) so
 * each stays a small single-purpose module. Anchors are new-side lines (`side: "RIGHT"`) derived
 * from the same parsed hunks the renderer shows, so they land inside the diff; an empty review
 * body is omitted — GitHub accepts a comment-only review but rejects an empty `body` string.
 */

import { parseReviewSubmitted } from "./github-parse";
import { postApi, repoApi } from "./github-http";

/** One inline comment of a submitted review, anchored to a new-side line of the PR diff. */
export interface ReviewCommentInput {
  path: string;
  line: number;
  body: string;
}

export interface SubmitReviewRequest {
  owner: string;
  repo: string;
  prNumber: number;
  /** Review-level body (unanchorable notes fold in here); omitted from the POST when empty. */
  body: string;
  comments: ReviewCommentInput[];
  /** Required: reviews are a write — the caller must have resolved a token before getting here. */
  token: string;
}

export interface SubmitReviewResult {
  url: string | null;
}

export function submitPullRequestReview(request: SubmitReviewRequest): Promise<SubmitReviewResult> {
  return submitPullRequestReviewWithFetch(globalThis.fetch, request);
}

export async function submitPullRequestReviewWithFetch(
  fetchImpl: typeof fetch,
  request: SubmitReviewRequest,
): Promise<SubmitReviewResult> {
  const payload: Record<string, unknown> = {
    event: "COMMENT",
    comments: request.comments.map((comment) => ({ path: comment.path, line: comment.line, side: "RIGHT", body: comment.body })),
  };
  if (request.body.trim().length > 0) {
    payload.body = request.body;
  }
  const url = repoApi(request.owner, request.repo, `/pulls/${request.prNumber}/reviews`);
  return parseReviewSubmitted(await postApi(fetchImpl, url, payload, request.token));
}
