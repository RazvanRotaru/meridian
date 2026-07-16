import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ReviewFileRow } from "../../derive/reviewFiles";
import { ReviewFilesSection } from "./ReviewFilesSection";

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
});
