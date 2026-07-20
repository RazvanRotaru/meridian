import { describe, expect, it } from "vitest";
import type { PrGitHubComment } from "../state/prTypes";
import { filterReviewComments } from "./reviewCommentFilter";

describe("review comment filters", () => {
  it("keeps only viewer-authored comments in Mine", () => {
    const comments = [comment(1), comment(2, { viewerCanEdit: true, inReplyToId: 1 }), comment(3)];
    expect(filterReviewComments(comments, "mine").map((entry) => entry.id)).toEqual([2]);
  });

  it("keeps complete threads the viewer participated in", () => {
    const comments = [
      comment(1),
      comment(2, { viewerCanEdit: true, inReplyToId: 1 }),
      comment(3, { inReplyToId: 1 }),
      comment(4),
      comment(5, { inReplyToId: 4 }),
    ];
    expect(filterReviewComments(comments, "participated").map((entry) => entry.id)).toEqual([1, 2, 3]);
  });

  it("treats an authored root as participation in its thread", () => {
    const comments = [comment(1, { viewerCanEdit: true }), comment(2, { inReplyToId: 1 }), comment(3)];
    expect(filterReviewComments(comments, "participated").map((entry) => entry.id)).toEqual([1, 2]);
  });
});

function comment(id: number, override: Partial<PrGitHubComment> = {}): PrGitHubComment {
  return {
    id,
    inReplyToId: null,
    path: "src/a.ts",
    line: 1,
    side: "RIGHT",
    body: `comment ${id}`,
    author: "reviewer",
    viewerCanEdit: false,
    updatedAt: "2026-07-16T10:00:00Z",
    url: "",
    ...override,
  };
}
