import { describe, expect, it } from "vitest";
import type { GraphArtifact, GraphEdge, GraphNode, ReviewContext } from "@meridian/core";
import { buildGraphIndex } from "../graph/graphIndex";
import { deriveReviewProjection } from "./reviewProjection";

function node(
  id: string,
  kind: string,
  file: string,
  parentId: string | null,
  lines: { start: number; end: number } = { start: 1, end: 20 },
): GraphNode {
  return {
    id,
    kind,
    qualifiedName: id,
    displayName: id.split("#").pop() ?? id,
    parentId,
    location: { file, startLine: lines.start, endLine: lines.end },
  };
}

const PROD_FILE = "ts:src/service.ts";
const PROD_FLOW = `${PROD_FILE}#run`;
const TEST_FILE = "ts:src/service.test.ts";
const TEST_FLOW = `${TEST_FILE}#coversRun`;

const ARTIFACT = {
  schemaVersion: "1.0.0",
  generatedAt: "2026-07-12T00:00:00.000Z",
  generator: { name: "test", version: "0" },
  target: { name: "fixture", root: ".", language: "typescript" },
  nodes: [
    node(PROD_FILE, "module", "src/service.ts", null),
    node(PROD_FLOW, "function", "src/service.ts", PROD_FILE),
    node(TEST_FILE, "module", "src/service.test.ts", null),
    node(TEST_FLOW, "function", "src/service.test.ts", TEST_FILE),
  ],
  edges: [
    { id: "test-calls-prod", source: TEST_FLOW, target: PROD_FLOW, kind: "calls", resolution: "resolved" },
  ] as GraphEdge[],
  extensions: {
    logicFlow: {
      [PROD_FLOW]: [],
      [TEST_FLOW]: [{ kind: "call", label: "run", target: PROD_FLOW, resolution: "resolved" }],
    },
  },
} as unknown as GraphArtifact;

const CONTEXT: ReviewContext = {
  changedFiles: [
    { path: "src/service.ts", status: "modified", hunks: [{ start: 1, end: 2 }] },
    { path: "src/service.test.ts", status: "modified", hunks: [{ start: 1, end: 2 }] },
    { path: "src/new.spec.ts", status: "added" },
  ],
  baseRef: "main",
  baseSha: null,
  headRef: "feature",
  reviewKey: "repo|pr-1",
  warnings: [],
};

describe("deriveReviewProjection", () => {
  it("removes test files, affected nodes, and test-owned impacted flows without losing raw context", () => {
    const index = buildGraphIndex(ARTIFACT);
    const projection = deriveReviewProjection(CONTEXT, ARTIFACT, index, { baseIndex: null, showTests: false });

    expect(projection.visibleContext.changedFiles.map((file) => file.path)).toEqual(["src/service.ts"]);
    expect(projection.files.map((file) => file.path)).toEqual(["src/service.ts"]);
    expect(projection.affected.map((node) => node.nodeId)).toEqual([PROD_FLOW]);
    expect(projection.review.rows.some((row) => row.flow.flowId === TEST_FLOW)).toBe(false);
    expect(projection.review.context).toBe(CONTEXT);
    expect(projection.excludedTestFileCount).toBe(2);
  });

  it("restores the complete review when tests are shown", () => {
    const projection = deriveReviewProjection(CONTEXT, ARTIFACT, buildGraphIndex(ARTIFACT), { baseIndex: null, showTests: true });

    expect(projection.visibleContext).toBe(CONTEXT);
    expect(projection.files.map((file) => file.path)).toEqual([
      "src/service.test.ts",
      "src/service.ts",
      "src/new.spec.ts",
    ]);
    expect(projection.excludedTestFileCount).toBe(0);
  });

  it("derives impacted flows from exact changed blocks, not their unchanged file siblings", () => {
    const cartFile = "src/cartService.ts";
    const cartModuleId = "ts:src/cartService.ts";
    const cartClassId = `${cartModuleId}#CartService`;
    const addItemId = `${cartClassId}.addItem`;
    const getCartId = `${cartClassId}.getCart`;
    const updateCartId = "ts:src/cartRoutes.ts#updateCart";
    const placeOrderId = "ts:src/checkoutService.ts#placeOrder";
    const artifact = {
      schemaVersion: "1.0.0",
      generatedAt: "2026-07-12T00:00:00.000Z",
      generator: { name: "test", version: "0" },
      target: { name: "fixture", root: ".", language: "typescript" },
      nodes: [
        node(cartModuleId, "module", cartFile, null, { start: 1, end: 40 }),
        node(cartClassId, "class", cartFile, cartModuleId, { start: 3, end: 30 }),
        node(addItemId, "method", cartFile, cartClassId, { start: 10, end: 15 }),
        node(getCartId, "method", cartFile, cartClassId, { start: 20, end: 25 }),
        node(updateCartId, "function", "src/cartRoutes.ts", null, { start: 5, end: 8 }),
        node(placeOrderId, "function", "src/checkoutService.ts", null, { start: 5, end: 8 }),
      ],
      edges: [],
      extensions: {
        logicFlow: {
          [addItemId]: [],
          [getCartId]: [],
          [updateCartId]: [{ kind: "call", label: "addItem", target: addItemId, resolution: "resolved" }],
          [placeOrderId]: [{ kind: "call", label: "getCart", target: getCartId, resolution: "resolved" }],
        },
      },
    } as unknown as GraphArtifact;
    const context: ReviewContext = {
      changedFiles: [{ path: cartFile, status: "modified", hunks: [{ start: 12, end: 12 }] }],
      baseRef: "main",
      baseSha: null,
      headRef: "feature",
      reviewKey: "repo|pr-sibling",
      warnings: [],
    };

    const projection = deriveReviewProjection(context, artifact, buildGraphIndex(artifact), {
      baseIndex: null,
      showTests: true,
    });

    expect(projection.affected.map((entry) => entry.nodeId)).toEqual([addItemId]);
    expect(projection.review.rows.map((row) => [row.flow.flowId, row.group])).toEqual([
      [addItemId, "changed"],
      [updateCartId, "impacted"],
    ]);
    expect(projection.review.rows.some((row) => row.flow.flowId === getCartId)).toBe(false);
    expect(projection.review.rows.some((row) => row.flow.flowId === placeOrderId)).toBe(false);
  });
});
