import { describe, expect, it } from "vitest";
import type { PrGitHubComment } from "../state/prTypes";
import {
  DEFAULT_REVIEW_COMMENT_FILTER,
  filterReviewComments,
  reviewCommentAuthors,
  reviewCommentFilterForComments,
} from "./reviewCommentFilter";

describe("review comment filters", () => {
  it("keeps only viewer-authored comments in authored mode", () => {
    const comments = [comment(1), comment(2, { viewerCanEdit: true, inReplyToId: 1 }), comment(3)];
    expect(filterReviewComments(comments, {
      subject: { kind: "viewer" },
      mode: "authored",
    }).map((entry) => entry.id)).toEqual([2]);
  });

  it("keeps complete threads the viewer participated in", () => {
    const comments = [
      comment(1),
      comment(2, { viewerCanEdit: true, inReplyToId: 1 }),
      comment(3, { inReplyToId: 1 }),
      comment(4),
      comment(5, { inReplyToId: 4 }),
    ];
    expect(filterReviewComments(comments, {
      subject: { kind: "viewer" },
      mode: "participated",
    }).map((entry) => entry.id)).toEqual([1, 2, 3]);
  });

  it("treats an authored root as participation in its thread", () => {
    const comments = [comment(1, { viewerCanEdit: true }), comment(2, { inReplyToId: 1 }), comment(3)];
    expect(filterReviewComments(comments, {
      subject: { kind: "viewer" },
      mode: "participated",
    }).map((entry) => entry.id)).toEqual([1, 2]);
  });

  it("filters any selected author by comments or complete participated threads", () => {
    const comments = [
      comment(1, { author: "Alice" }),
      comment(2, { author: "bob", inReplyToId: 1 }),
      comment(3, { author: "carol", inReplyToId: 1 }),
      comment(4, { author: "bob" }),
      comment(5, { author: "ALICE", inReplyToId: 4 }),
      comment(6, { author: "carol" }),
    ];
    const alice = { kind: "author", login: "alice" } as const;

    expect(filterReviewComments(comments, { subject: alice, mode: "authored" }).map((entry) => entry.id))
      .toEqual([1, 5]);
    expect(filterReviewComments(comments, { subject: alice, mode: "participated" }).map((entry) => entry.id))
      .toEqual([1, 2, 3, 4, 5]);
  });

  it("unions a selected author's root and reply threads without duplicating comments", () => {
    const comments = [
      comment(1, { author: "alice" }),
      comment(2, { author: "Bob", inReplyToId: 1 }),
      comment(3, { author: "bob" }),
      comment(4, { author: "alice", inReplyToId: 3 }),
    ];

    expect(filterReviewComments(comments, {
      subject: { kind: "author", login: "BOB" },
      mode: "participated",
    }).map((entry) => entry.id)).toEqual([1, 2, 3, 4]);
  });

  it("deduplicates author choices case-insensitively and marks the viewer", () => {
    const comments = [
      comment(1, { author: "Zoe" }),
      comment(2, { author: "alice" }),
      comment(3, { author: "ALICE", viewerCanEdit: true }),
      comment(4, { author: "bob" }),
    ];

    expect(reviewCommentAuthors(comments)).toEqual([
      { login: "alice", isViewer: true },
      { login: "bob", isViewer: false },
      { login: "Zoe", isViewer: false },
    ]);
  });

  it("clears only an explicit author missing from a refreshed discussion", () => {
    const comments = [comment(1, { author: "alice" })];
    const alice = { subject: { kind: "author", login: "ALICE" }, mode: "participated" } as const;
    const missing = { subject: { kind: "author", login: "bob" }, mode: "authored" } as const;
    const viewer = { subject: { kind: "viewer" }, mode: "participated" } as const;

    expect(reviewCommentFilterForComments(alice, comments)).toBe(alice);
    expect(reviewCommentFilterForComments(missing, comments)).toBe(DEFAULT_REVIEW_COMMENT_FILTER);
    expect(reviewCommentFilterForComments(viewer, comments)).toBe(viewer);
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
