import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ChangedDiffLine } from "@meridian/core";
import type { ReviewFileRow } from "../../derive/reviewFiles";
import type { PrGitHubComment } from "../../state/prTypes";
import { reviewCommentHasCanvasPlacement, ReviewFilesSection } from "./ReviewFilesSection";

const FILE: ReviewFileRow = {
  path: "src/bootstrap-host.ts",
  status: "modified",
  moduleId: "ts:src/bootstrap-host.ts",
  isTest: false,
  units: [],
  fingerprint: "bootstrap-host",
  blastRadius: 0,
  deletedImpact: null,
};

const STATE = {
  reviewFiles: [FILE],
  reviewFilesSort: "path" as const,
  reviewUnitTicks: {},
  reviewFileTicks: {},
  reviewComments: [],
  review: null,
  prReviewed: null,
  reviewCommentRangesByFile: {},
  reviewDiffLinesByFile: {},
  prDiscussion: null,
  reviewCommentsVisible: false,
  reviewPathScope: null,
  reviewFocusedSubgraph: null,
  reviewGroups: null,
  reviewActiveGroupId: null,
  index: { nodesById: new Map() },
  prPreparedArtifactCurrent: true,
};

vi.mock("../../state/StoreContext", () => ({
  useBlueprint: (selector: (state: typeof STATE) => unknown) => selector(STATE),
  useBlueprintActions: () => ({
    setReviewFilesSort: () => undefined,
    toggleReviewFileViewed: () => undefined,
    addReviewComment: () => undefined,
    setReviewLit: () => undefined,
    focusReviewFile: () => undefined,
    selectReviewNode: () => undefined,
    showReviewFile: () => Promise.resolve(),
  }),
}));

describe("ReviewFilesSection", () => {
  it("offers a reversible focus mode without replacing the Files changed disclosure", () => {
    const overview = renderToStaticMarkup(
      <ReviewFilesSection expanded={false} onExpandedChange={() => undefined} />,
    );
    const focused = renderToStaticMarkup(
      <ReviewFilesSection expanded onExpandedChange={() => undefined} />,
    );

    expect(overview).toContain('aria-label="Expand files list"');
    expect(overview).toContain('aria-pressed="false"');
    expect(overview).toContain('aria-expanded="true"');
    expect(focused).toContain('aria-label="Restore review overview"');
    expect(focused).toContain('aria-pressed="true"');
    expect(focused).toContain('title="Restore review scope and affected flows"');
    expect(focused).toContain("bootstrap-host.ts");
  });

  it("moves only exact, renderable deleted-line comments from the full rail fallback", () => {
    const deletion: ChangedDiffLine = {
      kind: "deleted",
      oldLine: 12,
      newLine: null,
      beforeNewLine: 12,
      text: "removed",
    };
    const comment: PrGitHubComment = {
      id: 1,
      inReplyToId: null,
      path: FILE.path,
      line: 12,
      side: "LEFT",
      body: "why remove this?",
      author: "octo",
      viewerCanEdit: false,
      updatedAt: "2026-07-24T00:00:00Z",
      url: "https://github.com/o/r/pull/1#discussion_r1",
    };

    expect(reviewCommentHasCanvasPlacement(FILE, comment, [deletion])).toBe(true);
    expect(reviewCommentHasCanvasPlacement(FILE, { ...comment, line: 13 }, [deletion])).toBe(false);
    expect(reviewCommentHasCanvasPlacement(FILE, { ...comment, url: "" }, [deletion])).toBe(false);
    expect(reviewCommentHasCanvasPlacement({ ...FILE, moduleId: null }, comment, [deletion])).toBe(false);
  });
});
