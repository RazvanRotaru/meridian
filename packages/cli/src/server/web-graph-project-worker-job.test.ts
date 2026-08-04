import { describe, expect, it } from "vitest";
import {
  assertGraphProjectMergeInputBudget,
  assertGraphSourceIndexUsage,
  isBoundedGraphProjectionRequest,
  isGraphProjectWorkerRequest,
  isGraphProjectWorkerResponse,
  MAX_GRAPH_PROJECT_OUTPUT_FILES,
  MAX_GRAPH_PROJECT_MERGED_ROOTS,
  MAX_GRAPH_PROJECT_OUTPUT_BYTES,
  MAX_GRAPH_PROJECT_ROOT_BYTES,
  MAX_GRAPH_PROJECT_ROOTS,
  MAX_GRAPH_SOURCE_BYTES,
  MAX_GRAPH_SYMBOL_ENTRIES,
  MAX_GRAPH_TOPOLOGY_ADJACENCY,
  remainingGraphSourceIndexLimits,
  type GraphProjectWorkerRequest,
} from "./web-graph-project-worker-job";

const digest = "a".repeat(64);
const graph = { graphId: "head", path: "/tmp/head.json", bytes: 10, sha256: digest };

describe("graph projection worker protocol", () => {
  it("accepts exact changed-file, explicit-file, and cross-graph path projection coordinates", () => {
    expect(isGraphProjectWorkerRequest(projectRequest())).toBe(true);
    expect(isBoundedGraphProjectionRequest({
      version: 1,
      graphId: "head",
      roots: { kind: "files", fileIds: ["m:a"] },
      requestedDepth: 6,
      prefetchDepth: 9,
    })).toBe(true);
    expect(isGraphProjectWorkerRequest(mergeRequest())).toBe(true);
    expect(isBoundedGraphProjectionRequest({
      version: 1,
      graphId: "head",
      roots: { kind: "file-paths", paths: ["src/live.ts"] },
      requestedDepth: 1,
      prefetchDepth: 3,
    })).toBe(true);
  });

  it("rejects unbounded horizons, root lists and missing changed-file seed artifacts", () => {
    expect(isBoundedGraphProjectionRequest({
      version: 1,
      graphId: "head",
      roots: { kind: "files", fileIds: ["m:a"] },
      requestedDepth: 2,
      prefetchDepth: 6,
    })).toBe(false);
    expect(isBoundedGraphProjectionRequest({
      version: 1,
      graphId: "head",
      roots: { kind: "files", fileIds: Array.from({ length: MAX_GRAPH_PROJECT_ROOTS + 1 }, (_, i) => `m:${i}`) },
      requestedDepth: 1,
      prefetchDepth: 1,
    })).toBe(false);
    expect(isGraphProjectWorkerRequest({ ...projectRequest(), seedGraph: null })).toBe(false);
    expect(isGraphProjectWorkerRequest({
      ...projectRequest(),
      projectionOutputMaxBytes: null,
    })).toBe(false);
    expect(isGraphProjectWorkerRequest({
      ...projectRequest(),
      projectionOutputMaxBytes: MAX_GRAPH_PROJECT_OUTPUT_BYTES + 1,
    })).toBe(false);
    expect(isGraphProjectWorkerRequest({
      ...projectRequest(),
      projection: { ...projectRequest().projection!, graphId: "other" },
    })).toBe(false);
    // The IPC envelope permits a stable logical generation for independently serialized partial
    // slices. The disposable worker still requires the matching in-artifact lineage proof.
    expect(isGraphProjectWorkerRequest({ ...projectRequest(), generation: "b".repeat(64) })).toBe(true);
    expect(isBoundedGraphProjectionRequest({
      version: 1,
      graphId: "head",
      roots: { kind: "file-paths", paths: ["src/live.ts", "src/live.ts"] },
      requestedDepth: 1,
      prefetchDepth: 3,
    })).toBe(false);
  });

  it("bounds multibyte root IDs to the public HTTP transport budget", () => {
    expect(MAX_GRAPH_PROJECT_ROOT_BYTES).toBe(60_000);
    const root = (index: number) => `ts:src/${index}-${"界".repeat(1_300)}.ts`;
    expect(isBoundedGraphProjectionRequest({
      version: 1,
      graphId: "head",
      roots: { kind: "files", fileIds: Array.from({ length: 15 }, (_, index) => root(index)) },
      requestedDepth: 1,
      prefetchDepth: 3,
    })).toBe(true);
    expect(isBoundedGraphProjectionRequest({
      version: 1,
      graphId: "head",
      roots: { kind: "files", fileIds: Array.from({ length: 16 }, (_, index) => root(index)) },
      requestedDepth: 1,
      prefetchDepth: 3,
    })).toBe(false);
    expect(isBoundedGraphProjectionRequest({
      version: 1,
      graphId: "head",
      roots: { kind: "files", fileIds: [`ts:${"界".repeat(1_365)}`] },
      requestedDepth: 1,
      prefetchDepth: 3,
    })).toBe(false);
  });

  it("validates bounded terminal file facts and operation-specific outputs", () => {
    expect(isGraphProjectWorkerResponse({
      type: "result",
      result: {
        id: "projection-test",
        operation: "project",
        graphId: "head",
        generation: digest,
        projection: {
          path: "/tmp/project.json",
          bytes: 100,
          sha256: digest,
          nodes: 10,
          edges: 12,
          files: 3,
          roots: 1,
          completeRoots: 1,
          loadedDepth: 1,
        },
        symbols: null,
        topology: null,
      },
    })).toBe(true);
    expect(isGraphProjectWorkerResponse({
      type: "result",
      result: {
        id: "projection-test",
        operation: "project",
        graphId: "head",
        generation: digest,
        projection: null,
        symbols: null,
        topology: null,
      },
    })).toBe(false);
    const merged = {
      type: "result",
      result: {
        id: "projection-merge",
        operation: "merge",
        graphId: "head",
        generation: digest,
        projection: {
          path: "/tmp/merged.json",
          bytes: 100,
          sha256: digest,
          nodes: 600,
          edges: 0,
          files: 513,
          roots: 513,
          completeRoots: 513,
          loadedDepth: 1,
        },
        symbols: null,
        topology: null,
      },
    };
    expect(MAX_GRAPH_PROJECT_MERGED_ROOTS).toBe(20_000);
    expect(isGraphProjectWorkerResponse(merged)).toBe(true);
    expect(isGraphProjectWorkerResponse({
      ...merged,
      result: { ...merged.result, operation: "project" },
    })).toBe(false);
    expect(isGraphProjectWorkerResponse({
      ...merged,
      result: {
        ...merged.result,
        projection: {
          ...merged.result.projection,
          roots: MAX_GRAPH_PROJECT_MERGED_ROOTS,
          completeRoots: MAX_GRAPH_PROJECT_MERGED_ROOTS,
        },
      },
    })).toBe(true);
  });

  it("rejects merge shards whose aggregate staging size exceeds one projection budget", () => {
    const oversizedInputs = [
      { path: "/tmp/one.json", bytes: Math.floor(MAX_GRAPH_PROJECT_OUTPUT_BYTES / 2) + 1, sha256: digest },
      { path: "/tmp/two.json", bytes: Math.floor(MAX_GRAPH_PROJECT_OUTPUT_BYTES / 2) + 1, sha256: digest },
    ];
    expect(isGraphProjectWorkerRequest({
      ...mergeRequest(),
      projectionInputs: oversizedInputs,
    })).toBe(false);
    expect(() => assertGraphProjectMergeInputBudget(oversizedInputs)).toThrow(/aggregate byte limit/);
  });

  it("never rounds an exhausted mixed-language source budget back up to one", () => {
    expect(() => remainingGraphSourceIndexLimits({
      sourceFileCount: MAX_GRAPH_PROJECT_OUTPUT_FILES,
      sourceBytes: 1,
      symbolCount: 1,
      adjacencyEntries: 1,
    })).toThrow(/exhausted its aggregate/);
    expect(() => remainingGraphSourceIndexLimits({
      sourceFileCount: 1,
      sourceBytes: MAX_GRAPH_SOURCE_BYTES,
      symbolCount: 1,
      adjacencyEntries: 1,
    })).toThrow(/exhausted its aggregate/);
    expect(remainingGraphSourceIndexLimits({
      sourceFileCount: MAX_GRAPH_PROJECT_OUTPUT_FILES - 1,
      sourceBytes: MAX_GRAPH_SOURCE_BYTES - 1,
      symbolCount: MAX_GRAPH_SYMBOL_ENTRIES - 1,
      adjacencyEntries: MAX_GRAPH_TOPOLOGY_ADJACENCY - 1,
    })).toEqual({
      maxFiles: 1,
      maxSourceBytes: 1,
      maxSymbols: 1,
      maxAdjacencyEntries: 1,
    });
    expect(() => assertGraphSourceIndexUsage({
      sourceFileCount: MAX_GRAPH_PROJECT_OUTPUT_FILES + 1,
      sourceBytes: 1,
      symbolCount: 1,
      adjacencyEntries: 1,
    })).toThrow(/exceeded its aggregate/);
  });
});

function projectRequest(): GraphProjectWorkerRequest {
  return {
    type: "project",
    id: "projection-test",
    graph,
    seedGraph: graph,
    generation: digest,
    projection: {
      version: 1,
      graphId: "head",
      roots: { kind: "changed-files", seedGraphId: "head" },
      requestedDepth: 1,
      prefetchDepth: 3,
    },
    projectionOutputPath: "/tmp/project.json",
    projectionOutputMaxBytes: MAX_GRAPH_PROJECT_OUTPUT_BYTES,
    symbolOutputPath: null,
    symbolSourceRoot: null,
    topologyOutputPath: null,
  };
}

function mergeRequest(): GraphProjectWorkerRequest {
  return {
    type: "merge",
    id: "projection-merge",
    graph,
    seedGraph: null,
    generation: digest,
    projection: {
      version: 1,
      graphId: "head",
      roots: { kind: "changed-files", seedGraphId: "head" },
      requestedDepth: 1,
      prefetchDepth: 3,
    },
    projectionOutputPath: "/tmp/merged.json",
    projectionOutputMaxBytes: MAX_GRAPH_PROJECT_OUTPUT_BYTES,
    symbolOutputPath: null,
    symbolSourceRoot: null,
    topologyOutputPath: null,
    projectionInputs: [
      { path: "/tmp/one.json", bytes: 10, sha256: digest },
      { path: "/tmp/two.json", bytes: 10, sha256: digest },
    ],
  };
}
