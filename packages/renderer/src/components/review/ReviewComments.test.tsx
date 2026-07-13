import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { PrGitHubComment } from "../../state/prTypes";
import { reviewCommentThreadOrder } from "./ExistingReviewComments";
import { CommentComposer } from "./ReviewComments";
import { reviewActionDisabled, reviewSuccessLabel } from "./ReviewSubmissionFooter";

describe("CommentComposer", () => {
  it("prefills an edit and names its save action", () => {
    const markup = renderToStaticMarkup(
      <CommentComposer
        placeholder="Edit comment…"
        initialBody="Keep this useful context"
        submitLabel="Save changes"
        compact
        onAdd={() => undefined}
        onCancel={() => undefined}
      />,
    );

    expect(markup).toContain("Keep this useful context");
    expect(markup).toContain("Save changes");
    expect(markup).toContain("Edit comment…");
  });

  it("renders a mutation error without discarding the reply", () => {
    const markup = renderToStaticMarkup(
      <CommentComposer
        placeholder="Reply…"
        initialBody="Still here"
        submitLabel="Add reply"
        error="GitHub rejected the comment"
        onAdd={() => false}
        onCancel={() => undefined}
      />,
    );

    expect(markup).toContain("Still here");
    expect(markup).toContain("Add reply");
    expect(markup).toContain("GitHub rejected the comment");
  });
});

describe("reviewCommentThreadOrder", () => {
  it("places replies directly after their root while retaining orphaned replies", () => {
    const rootA = githubComment(1, null);
    const rootB = githubComment(2, null);
    const replyA = githubComment(3, 1);
    const orphan = githubComment(4, 999);

    expect(reviewCommentThreadOrder([rootA, rootB, replyA, orphan]).map((comment) => comment.id)).toEqual([1, 3, 2, 4]);
  });
});

describe("review submission decisions", () => {
  it("requires drafts for comment and a summary for request changes, but not for approval", () => {
    expect(reviewActionDisabled("COMMENT", 0, "")).toBe(true);
    expect(reviewActionDisabled("COMMENT", 1, "")).toBe(false);
    expect(reviewActionDisabled("APPROVE", 0, "")).toBe(false);
    expect(reviewActionDisabled("REQUEST_CHANGES", 2, "  ")).toBe(true);
    expect(reviewActionDisabled("REQUEST_CHANGES", 0, "Blocking issue")).toBe(false);
  });

  it("names the submitted decision", () => {
    expect(reviewSuccessLabel("COMMENT")).toBe("Comments submitted");
    expect(reviewSuccessLabel("APPROVE")).toBe("Pull request approved");
    expect(reviewSuccessLabel("REQUEST_CHANGES")).toBe("Changes requested");
  });
});

function githubComment(id: number, inReplyToId: number | null): PrGitHubComment {
  return {
    id,
    inReplyToId,
    viewerCanEdit: false,
    path: "src/example.ts",
    line: 1,
    side: "RIGHT",
    body: `comment-${id}`,
    author: "octo",
    updatedAt: "2026-07-13T00:00:00.000Z",
    url: "",
  };
}
