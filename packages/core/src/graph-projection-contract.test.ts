import { describe, expect, it } from "vitest";
import {
  GRAPH_PROJECTION_PROTOCOL_VERSION,
  GRAPH_PROJECTION_REQUEST_FIELDS,
  canonicalGraphProjectionRequestJson,
  graphProjectionIdentityPreimage,
  isGraphProjectionReviewCursor,
  type GraphProjectionContractRequest,
} from "./graph-projection-contract";

const REQUEST: GraphProjectionContractRequest = {
  version: GRAPH_PROJECTION_PROTOCOL_VERSION,
  view: "review",
  filePaths: ["src/a.ts"],
  reviewCursor: null,
  focusIds: ["ts:a"],
  expandedIds: [],
  extraIds: [],
  causalIds: [],
  serviceExpandedLeadIds: [],
  depth: 1,
  includeTests: false,
  includeReachability: true,
  maxNodes: 5_000,
  maxEdges: 20_000,
  maxResponseBytes: 16 * 1024 * 1024,
};

describe("graph projection contract", () => {
  it("serializes the exact field set in one protocol-defined order", () => {
    const serialized = canonicalGraphProjectionRequestJson(REQUEST);
    expect(Object.keys(JSON.parse(serialized) as object)).toEqual(GRAPH_PROJECTION_REQUEST_FIELDS);
  });

  it("derives the same identity preimage regardless of object insertion order", () => {
    const reverseOrder = Object.fromEntries(
      Object.entries(REQUEST).reverse(),
    ) as unknown as GraphProjectionContractRequest;

    expect(canonicalGraphProjectionRequestJson(reverseOrder))
      .toBe(canonicalGraphProjectionRequestJson(REQUEST));
    expect(graphProjectionIdentityPreimage("a".repeat(64), reverseOrder))
      .toBe(graphProjectionIdentityPreimage("a".repeat(64), REQUEST));
  });

  it("accepts only canonical bounded review coordinates", () => {
    expect(isGraphProjectionReviewCursor("page:0")).toBe(true);
    expect(isGraphProjectionReviewCursor("file:99999")).toBe(true);
    expect(isGraphProjectionReviewCursor("file:01")).toBe(false);
    expect(isGraphProjectionReviewCursor("page:100000")).toBe(false);
    expect(isGraphProjectionReviewCursor("file:-1")).toBe(false);
  });
});
