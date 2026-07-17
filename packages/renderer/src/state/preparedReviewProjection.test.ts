import { describe, expect, it } from "vitest";
import type { GraphArtifact, GraphProjectionReviewSide } from "@meridian/core";
import { buildGraphIndex } from "../graph/graphIndex";
import {
  OVERVIEW_PROJECTION_REQUEST,
  type GraphProjectionRequest,
  type LoadedGraphProjection,
  type LoadedReviewProjection,
} from "../graph/graphProjectionClient";
import { assertPreparedReviewProjectionFacts } from "./preparedReviewProjection";
import { reviewProjectionFactsForTest } from "./reviewProjectionTestSupport";
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
});

function reviewPair(request: GraphProjectionRequest): LoadedReviewProjection {
  const head = projection("head", request);
  const mergeBase = projection("mergeBase", request);
  return {
    key: "pair",
    projectionId: "head\0base",
    head,
    mergeBase,
    serializedBytes: 2,
    residentBytes: 2,
  };
}

function projection(side: GraphProjectionReviewSide, request: GraphProjectionRequest): LoadedGraphProjection {
  return {
    key: side,
    projectionId: side,
    graphId: side,
    request,
    artifact: ARTIFACT,
    index: buildGraphIndex(ARTIFACT),
    reachability: null,
    review: reviewProjectionFactsForTest(FILES, request, side, ARTIFACT),
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
