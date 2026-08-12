import { describe, expect, it, vi } from "vitest";
import {
  submitPullRequestReviewWithFetch,
  type ReviewCommentInput,
  type SubmitReviewRequest,
} from "./github-review";

function request(comment: ReviewCommentInput): SubmitReviewRequest {
  return {
    owner: "org",
    repo: "repo",
    prNumber: 7,
    comments: [comment],
    event: "COMMENT",
    token: "token",
  };
}

describe("submitPullRequestReviewWithFetch range boundary", () => {
  it.each([
    { path: "a.ts", startLine: 1, line: 2, side: "RIGHT", body: "missing start side" },
    { path: "a.ts", startSide: "RIGHT", line: 2, side: "RIGHT", body: "missing start line" },
    { path: "a.ts", startLine: 0, startSide: "RIGHT", line: 2, side: "RIGHT", body: "zero start" },
    { path: "a.ts", startLine: 2, startSide: "RIGHT", line: 2, side: "RIGHT", body: "empty range" },
    { path: "a.ts", startLine: 3, startSide: "LEFT", line: 0, side: "RIGHT", body: "bad end" },
  ] as unknown as ReviewCommentInput[])("rejects malformed range metadata before calling GitHub", async (comment) => {
    const fetchImpl = vi.fn<typeof fetch>();

    await expect(submitPullRequestReviewWithFetch(fetchImpl, request(comment))).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
