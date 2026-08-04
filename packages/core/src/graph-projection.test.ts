import { describe, expect, expectTypeOf, it } from "vitest";
import { SCHEMA_VERSION, type GraphNode } from "./types";
import {
  GRAPH_PROJECTION_VERSION,
  GRAPH_SYMBOL_SEARCH_VERSION,
  type CompactGraphSymbolEntry,
  type GraphProjectionCounts,
  type GraphProjectionRequestV1,
  type GraphProjectionV1,
  type GraphSymbolSearchResultV1,
} from "./graph-projection";

const fileNode: GraphNode = {
  id: "ts:src/orders.ts",
  kind: "module",
  qualifiedName: "src/orders.ts",
  displayName: "orders.ts",
  location: { file: "src/orders.ts", startLine: 1 },
};

const symbol: CompactGraphSymbolEntry = {
  id: "ts:src/orders.ts#createOrder",
  fileId: fileNode.id,
  displayName: "createOrder",
  qualifiedName: "src/orders.ts.createOrder",
  kind: "function",
  file: "src/orders.ts",
  isPrivateMethod: false,
  stepCount: 4,
};

describe("graph projection protocol", () => {
  it("pins independent projection and symbol-search protocol versions", () => {
    expect(GRAPH_PROJECTION_VERSION).toBe(1);
    expect(GRAPH_SYMBOL_SEARCH_VERSION).toBe(1);
    expectTypeOf(GRAPH_PROJECTION_VERSION).toEqualTypeOf<1>();
    expectTypeOf(GRAPH_SYMBOL_SEARCH_VERSION).toEqualTypeOf<1>();
  });

  it("carries canonical artifact metadata and separate full/slice completeness", () => {
    const projection = {
      version: GRAPH_PROJECTION_VERSION,
      graphId: "graph-head",
      seedGraphId: "graph-base",
      generation: "review-42:head:3",
      requestedDepth: 1,
      prefetchDepth: 2,
      loadedDepth: 1,
      schemaVersion: SCHEMA_VERSION,
      generatedAt: "2026-07-31T08:00:00.000Z",
      generator: { name: "meridian", version: "0.1.0" },
      target: { name: "orders", root: ".", language: "typescript" },
      nodes: [fileNode],
      edges: [],
      rootFileIds: [fileNode.id],
      readyFileIds: [fileNode.id],
      loadedFileIds: [fileNode.id],
      frontier: [{ fileId: fileNode.id, hasMore: true, completeThroughDepth: 1 }],
      counts: {
        full: { nodes: 80, edges: 120, files: 20 },
        slice: { nodes: 1, edges: 0, files: 1 },
      },
    } satisfies GraphProjectionV1;

    expect(projection.counts).toEqual({
      full: { nodes: 80, edges: 120, files: 20 },
      slice: { nodes: 1, edges: 0, files: 1 },
    });
    expect(projection.frontier[0]).toEqual({
      fileId: fileNode.id,
      hasMore: true,
      completeThroughDepth: 1,
    });
    expect(projection.seedGraphId).toBe("graph-base");
    expectTypeOf(projection.counts.full).toMatchTypeOf<GraphProjectionCounts>();
  });

  it("uses the same absolute depth horizon in projection requests", () => {
    const changedFilesRequest = {
      version: GRAPH_PROJECTION_VERSION,
      graphId: "graph-head",
      roots: { kind: "changed-files", seedGraphId: "graph-head" },
      requestedDepth: 1,
      prefetchDepth: 3,
    } satisfies GraphProjectionRequestV1;
    const explicitFilesRequest = {
      ...changedFilesRequest,
      roots: { kind: "files", fileIds: [fileNode.id] },
    } satisfies GraphProjectionRequestV1;

    expect(changedFilesRequest.prefetchDepth).toBe(3);
    expect(changedFilesRequest.roots).toEqual({
      kind: "changed-files",
      seedGraphId: "graph-head",
    });
    expect(explicitFilesRequest.roots).toEqual({
      kind: "files",
      fileIds: [fileNode.id],
    });
  });

  it("keeps symbol-index completeness independent from returned matches", () => {
    const result = {
      version: GRAPH_SYMBOL_SEARCH_VERSION,
      graphId: "graph-head",
      generation: "review-42:head:3",
      complete: false,
      indexedSymbolCount: 500,
      totalSymbolCount: 2_000,
      symbols: [symbol],
    } satisfies GraphSymbolSearchResultV1;

    expect(result.symbols).toEqual([symbol]);
    expect(result.indexedSymbolCount).toBeGreaterThan(result.symbols.length);
    expectTypeOf(result.symbols).toEqualTypeOf<CompactGraphSymbolEntry[]>();
  });
});
