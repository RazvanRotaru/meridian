import { describe, expect, it } from "vitest";
import type {
  GraphArtifact,
  GraphProjectionReviewFacts,
  GraphProjectionReviewSide,
  GraphProjectionReviewTestClassification,
} from "@meridian/core";
import { buildGraphIndex } from "../graph/graphIndex";
import {
  OVERVIEW_PROJECTION_REQUEST,
  type GraphProjectionRequest,
  type LoadedGraphProjection,
  type LoadedReviewProjection,
} from "../graph/graphProjectionClient";
import {
  assertPreparedReviewProjectionFacts,
  preparedReviewOverviewCoverage,
  preparedReviewTestClassifications,
  preparedReviewTestVerdicts,
} from "./preparedReviewProjection";
import {
  reviewProjectionFactsForTest,
  reviewProjectionMetadataForTest,
} from "./reviewProjectionTestSupport";
import type { PreparedChangedFile } from "./prPreparation";

const ARTIFACT: GraphArtifact = {
  schemaVersion: "1.0.0",
  generatedAt: "2026-07-17T00:00:00.000Z",
  generator: { name: "test", version: "1" },
  target: { name: "fixture", root: ".", language: "typescript" },
  nodes: [],
  edges: [],
};

const FILES: PreparedChangedFile[] = [
  ...Array.from({ length: 64 }, (_value, index) => ({
    path: `src/${String(index).padStart(3, "0")}.ts`,
    status: "modified" as const,
  })),
  { path: "src/zzz-new.ts", status: "renamed", previousPath: "src/zzz-old.ts" },
];

describe("prepared review projection facts", () => {
  it("checks every entry on a page beyond page one against its canonical handoff index", () => {
    const request = reviewRequest("page:1");
    const pair = reviewPair(request);

    expect(() => assertPreparedReviewProjectionFacts(pair, FILES, "page:1")).not.toThrow();

    const entry = pair.mergeBase.review!.page!.entries[0]!;
    const mismatched = {
      ...pair,
      mergeBase: {
        ...pair.mergeBase,
        review: {
          ...pair.mergeBase.review!,
          page: {
            ...pair.mergeBase.review!.page!,
            entries: [{ ...entry, previousPath: "src/wrong-old.ts" }],
          },
        },
      },
    } satisfies LoadedReviewProjection;
    expect(() => assertPreparedReviewProjectionFacts(mismatched, FILES, "page:1"))
      .toThrow("page does not match its handoff manifest index");
  });

  it("checks a selected rename beyond page one on both comparison sides", () => {
    const request = reviewRequest("file:64");
    const pair = reviewPair(request);

    expect(() => assertPreparedReviewProjectionFacts(pair, FILES, "file:64")).not.toThrow();

    const selection = pair.head.review!.selection!;
    const mismatched = {
      ...pair,
      head: {
        ...pair.head,
        review: {
          ...pair.head.review!,
          selection: {
            ...selection,
            entry: { ...selection.entry, previousPath: "src/wrong-old.ts" },
          },
        },
      },
    } satisfies LoadedReviewProjection;
    expect(() => assertPreparedReviewProjectionFacts(mismatched, FILES, "file:64"))
      .toThrow("selection does not match its handoff manifest index");
  });

  it("retains paired coverage while giving graph-backed HEAD test truth precedence", () => {
    const request = reviewRequest("page:1");
    const pair = withOverviewEntries(
      reviewPair(request),
      [{ index: 64, state: "deferred", isTest: false }],
      [{ index: 64, state: "filtered", isTest: true }],
    );

    expect(preparedReviewOverviewCoverage(pair, FILES, "page:1")).toEqual({
      contextId: pair.head.review!.contextId,
      pageIndex: 1,
      entries: [{
        index: 64,
        head: { state: "deferred", isTest: false },
        mergeBase: { state: "filtered", isTest: true },
        isTest: false,
      }],
    });
  });

  it("falls back to merge-base truth and then to the canonical current-path heuristic", () => {
    const request = reviewRequest("page:1");
    const pair = withOverviewEntries(
      reviewPair(request),
      [{ index: 64, state: "unmapped", isTest: null }],
      [{ index: 64, state: "filtered", isTest: true }],
    );
    expect(preparedReviewOverviewCoverage(pair, FILES, "page:1")?.entries[0]?.isTest).toBe(true);

    const heuristicFiles: PreparedChangedFile[] = [{ path: "src/ordinary.test.ts", status: "modified" }];
    const heuristicRequest = reviewRequest("page:0");
    const heuristicPair = reviewPair(heuristicRequest, heuristicFiles);
    expect(preparedReviewOverviewCoverage(
      heuristicPair,
      heuristicFiles,
      "page:0",
    )?.entries[0]?.isTest).toBe(true);
  });

  it("does not retain overview metadata for an exact-file coordinate", () => {
    const request = reviewRequest("file:64");
    expect(preparedReviewOverviewCoverage(reviewPair(request), FILES, "file:64")).toBeNull();
  });

  it("joins full-manifest verdicts beyond the current page to canonical and previous paths", () => {
    const request = reviewRequest("file:64");
    const pair = withTestClassifications(
      reviewPair(request),
      [{ index: 1, isTest: false }, { index: 64, isTest: true }],
      [{ index: 1, isTest: true }, { index: 2, isTest: true }, { index: 64, isTest: false }],
    );
    const classifications = preparedReviewTestClassifications(pair, FILES, "file:64");

    expect(classifications.entries).toEqual([
      { index: 1, isTest: false },
      { index: 2, isTest: true },
      { index: 64, isTest: true },
    ]);
    expect([...preparedReviewTestVerdicts(classifications, FILES)]).toEqual([
      ["src/001.ts", false],
      ["src/002.ts", true],
      ["src/zzz-new.ts", true],
      ["src/zzz-old.ts", true],
    ]);
  });
});

function reviewPair(
  request: GraphProjectionRequest,
  files: readonly PreparedChangedFile[] = FILES,
): LoadedReviewProjection {
  const head = projection("head", request, files);
  const mergeBase = projection("mergeBase", request, files);
  return {
    key: "pair",
    projectionId: "head\0base",
    head,
    mergeBase,
    reviewMetadata: reviewProjectionMetadataForTest(files, "head", "mergeBase", ARTIFACT),
    reviewMetadataResidentBytes: 1,
    serializedBytes: 2,
    residentBytes: 2,
  };
}

type OverviewEntries = NonNullable<GraphProjectionReviewFacts["overview"]>["entries"];

function withOverviewEntries(
  pair: LoadedReviewProjection,
  headEntries: OverviewEntries,
  mergeBaseEntries: OverviewEntries,
): LoadedReviewProjection {
  return {
    ...pair,
    head: {
      ...pair.head,
      review: {
        ...pair.head.review!,
        overview: { entries: headEntries },
      },
    },
    mergeBase: {
      ...pair.mergeBase,
      review: {
        ...pair.mergeBase.review!,
        overview: { entries: mergeBaseEntries },
      },
    },
  };
}

function withTestClassifications(
  pair: LoadedReviewProjection,
  head: readonly GraphProjectionReviewTestClassification[],
  mergeBase: readonly GraphProjectionReviewTestClassification[],
): LoadedReviewProjection {
  const byIndex = new Map(mergeBase.map((entry) => [entry.index, entry.isTest] as const));
  for (const entry of head) byIndex.set(entry.index, entry.isTest);
  return {
    ...pair,
    reviewMetadata: {
      ...pair.reviewMetadata,
      testClassifications: [...byIndex]
        .sort(([left], [right]) => left - right)
        .map(([index, isTest]) => ({ index, isTest })),
    },
  };
}

function projection(
  side: GraphProjectionReviewSide,
  request: GraphProjectionRequest,
  files: readonly PreparedChangedFile[],
): LoadedGraphProjection {
  return {
    key: side,
    projectionId: side,
    graphId: side,
    request,
    artifact: ARTIFACT,
    index: buildGraphIndex(ARTIFACT),
    reachability: null,
    review: reviewProjectionFactsForTest(files, request, side, ARTIFACT),
    serializedBytes: 1,
    residentBytes: 1,
  };
}

function reviewRequest(reviewCursor: string): GraphProjectionRequest {
  return {
    ...OVERVIEW_PROJECTION_REQUEST,
    view: "review",
    filePaths: [],
    reviewCursor,
  };
}
