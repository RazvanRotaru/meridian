import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ReviewUnitRow } from "../../derive/reviewFiles";
import { UnitRow } from "./ReviewUnitRow";

vi.mock("../../state/StoreContext", () => ({
  useBlueprintActions: () => ({
    toggleReviewUnitTick: () => undefined,
    addReviewComment: () => undefined,
    setReviewLit: () => undefined,
    selectReviewNode: () => undefined,
    deleteReviewComment: () => undefined,
    updateReviewComment: () => undefined,
  }),
  useBlueprint: (selector: (state: unknown) => unknown) => selector({
    prReviewed: null,
    review: null,
    reviewFiles: [],
    reviewCommentRangesByFile: {},
  }),
}));

describe("UnitRow", () => {
  it("labels a base-only declaration as deleted and never opens a new-side comment composer", () => {
    const unit: ReviewUnitRow = {
      nodeId: "ts:src/a.ts#removed",
      displayName: "removed",
      kind: "method",
      startLine: 25,
      endLine: 30,
      sourceSide: "base",
      depth: 1,
      isTest: false,
      fingerprint: "base:25:30",
    };

    const markup = renderToStaticMarkup(
      <UnitRow
        unit={unit}
        path="src/a.ts"
        viewState="todo"
        drafts={[]}
        composer={{ path: "src/a.ts", nodeId: unit.nodeId }}
        onComposer={() => undefined}
      />,
    );

    expect(markup).toContain('aria-label="Deleted in this pull request"');
    expect(markup).toContain("deleted in this pull request");
    expect(markup).not.toContain("Add a comment");
    expect(markup).not.toContain("Comment on removed");
    expect(markup).not.toContain("<textarea");
  });
});
