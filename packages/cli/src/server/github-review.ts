/**
 * Submit a pull-request review. Split from github.ts so the review payload remains a small,
 * single-purpose unit. Anchors are new-side lines (`side: "RIGHT"`) derived
 * from the same parsed hunks the renderer shows, so they land inside the diff. Reviews created here
 * keep every user draft as an individual inline GitHub comment while the review event carries the
 * final decision (comment, approve, or request changes).
 */

import { parseReviewSubmitted } from "./github-parse";
import { postApi, repoApi } from "./github-http";

/** One inline comment of a submitted review, anchored to a new-side line of the PR diff. */
export interface ReviewCommentInput {
  path: string;
  line: number;
  body: string;
}

export type PullRequestReviewEvent = "COMMENT" | "APPROVE" | "REQUEST_CHANGES";

export interface SubmitReviewRequest {
  owner: string;
  repo: string;
  prNumber: number;
  comments: ReviewCommentInput[];
  event: PullRequestReviewEvent;
  body?: string;
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
  const payload = {
    event: request.event,
    comments: request.comments.map((comment) => ({ path: comment.path, line: comment.line, side: "RIGHT", body: comment.body })),
    ...(request.body ? { body: request.body } : {}),
  };
  const url = repoApi(request.owner, request.repo, `/pulls/${request.prNumber}/reviews`);
  return parseReviewSubmitted(await postApi(fetchImpl, url, payload, request.token));
}
