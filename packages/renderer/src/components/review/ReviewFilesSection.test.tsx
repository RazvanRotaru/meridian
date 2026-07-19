import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ReviewFileRow } from "../../derive/reviewFiles";
import { ReviewFilesSection, reviewFileProjectionState } from "./ReviewFilesSection";

const FILE: ReviewFileRow = {
  path: "src/bootstrap-host.ts",
  status: "modified",
  moduleId: "ts:src/bootstrap-host.ts",
  isTest: false,
  units: [],
  blastRadius: 0,
  deletedImpact: null,
};

const UNMATCHED_ADDED_FILE: ReviewFileRow = {
  path: "src/new-unmatched.ts",
  status: "added",
  moduleId: null,
  isTest: false,
  units: [],
  blastRadius: 0,
  deletedImpact: null,
};

const STATE = {
  reviewFiles: [FILE, UNMATCHED_ADDED_FILE],
  reviewProgressCatalog: {
    reviewKey: "fixture",
    revisionKey: "revision",
    order: [FILE.path, UNMATCHED_ADDED_FILE.path],
    byPath: new Map([
      [FILE.path, { path: FILE.path, fingerprint: "whole-file", units: [] }],
      [UNMATCHED_ADDED_FILE.path, {
        path: UNMATCHED_ADDED_FILE.path,
        fingerprint: "whole-file",
        units: [],
      }],
    ]),
  },
  reviewFilesSort: "path" as const,
  reviewUnitTicks: {},
  reviewFileTicks: {},
  reviewComments: [],
  review: null,
  prReviewed: null,
  prPreparedHead: null,
  prPreparedMergeBase: null,
  prPreparedReviewCursor: null,
  prPreparedChangedFiles: [],
  prPreparedProjectionPending: null,
  prPreparedProjectionError: null,
  reviewCommentRangesByFile: {},
  prDiscussion: null,
  reviewCommentsVisible: false,
  reviewPathScope: null,
  reviewFocusedSubgraph: null,
  reviewGroups: null,
  reviewActiveGroupId: null,
  index: { nodesById: new Map() },
};

vi.mock("../../state/StoreContext", () => ({
  useBlueprint: (selector: (state: typeof STATE) => unknown) => selector(STATE),
  useBlueprintActions: () => ({
    setReviewFilesSort: () => undefined,
    focusReviewOverview: () => Promise.resolve(),
    toggleReviewFileViewed: () => undefined,
    addReviewComment: () => undefined,
    setReviewLit: () => undefined,
    focusReviewFile: () => undefined,
    selectReviewNode: () => undefined,
    showReviewFile: () => Promise.resolve(),
  }),
}));

describe("ReviewFilesSection", () => {
  it("distinguishes unloaded and loading prepared rows from an honestly unmatched committed file", () => {
    const base = {
      prepared: true,
      moduleId: null,
      committedPath: "src/committed.ts",
      pendingPath: "src/loading.ts",
      errorPath: "src/error.ts",
    };
    expect(reviewFileProjectionState({ ...base, path: "src/unloaded.ts" })).toBe("unloaded");
    expect(reviewFileProjectionState({ ...base, path: "src/loading.ts" })).toBe("loading");
    expect(reviewFileProjectionState({ ...base, path: "src/error.ts" })).toBe("error");
    expect(reviewFileProjectionState({ ...base, path: "src/committed.ts" })).toBe("committed-unmatched");
    expect(reviewFileProjectionState({
      ...base,
      path: "src/committed.ts",
      moduleId: "ts:src/committed.ts",
    })).toBe("committed-matched");
  });

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
    expect(focused).toContain('aria-label="Restore review sections"');
    expect(focused).toContain('aria-pressed="true"');
    expect(focused).toContain('title="Restore review scope and affected flows"');
    expect(focused).toContain("bootstrap-host.ts");
  });

  it("describes every unmatched file as extractor-unmatched without a base-graph fallback", () => {
    const markup = renderToStaticMarkup(<ReviewFilesSection />);

    expect(markup).toContain("not extracted · view source");
    expect(markup).toContain("The extractor produced no graph node for this file");
    expect(markup).not.toContain("Extract head graph");
    expect(markup).not.toContain("base graph");
    expect(markup).not.toContain("new file · view source");
  });
});
