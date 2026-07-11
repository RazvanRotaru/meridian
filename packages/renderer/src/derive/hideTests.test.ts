/**
 * Hide-tests behavior: the index's path-heuristic test set, and the edge pre-filter that stops a
 * hidden test's calls re-materializing as edges from its still-visible package. (The old ui lens's
 * computeVisible subtree hiding died with the phase-C unification — the module surfaces exclude
 * `hiddenIds` in their own walk, covered by the module-tree tests.)
 */

import { describe, expect, it } from "vitest";
import type { GraphArtifact, GraphEdge, GraphNode } from "@meridian/core";
import { buildGraphIndex } from "../graph/graphIndex";
import { liftEdges } from "./liftEdges";

function node(id: string, kind: string, file: string, parentId?: string): GraphNode {
  return { id, kind, qualifiedName: id, displayName: id, parentId, location: { file, startLine: 1 } };
}

function callsEdge(source: string, target: string): GraphEdge {
  return { id: `calls@${source}|${target}`, source, target, kind: "calls", resolution: "resolved" };
}

// src/{svc.ts, svc.test.ts}: the test file's node carries the "test" tag path-derived.
const NODES: GraphNode[] = [
  node("ts:src", "package", "src"),
  node("ts:src/svc.ts", "module", "src/svc.ts", "ts:src"),
  node("ts:src/svc.ts#place", "function", "src/svc.ts", "ts:src/svc.ts"),
  node("ts:src/svc.test.ts", "module", "src/svc.test.ts", "ts:src"),
  node("ts:src/svc.test.ts#t1", "function", "src/svc.test.ts", "ts:src/svc.test.ts"),
];

const EDGES: GraphEdge[] = [callsEdge("ts:src/svc.test.ts#t1", "ts:src/svc.ts#place")];

const ARTIFACT: GraphArtifact = {
  schemaVersion: "1.0.0",
  generatedAt: "2026-07-03T00:00:00.000Z",
  generator: { name: "test", version: "0" },
  target: { name: "fixture", root: ".", language: "typescript" },
  nodes: NODES,
  edges: EDGES,
};

const index = buildGraphIndex(ARTIFACT);

describe("graphIndex.testIds", () => {
  it("collects the test module and its members from the path heuristic alone", () => {
    expect(index.testIds).toEqual(new Set(["ts:src/svc.test.ts", "ts:src/svc.test.ts#t1"]));
  });
});

describe("edge filtering for hidden tests (pre-filter BEFORE lifting)", () => {
  it("drops a test->prod edge instead of lifting it to the visible package", () => {
    const hidden = index.testIds;
    // The drawn frontier with tests hidden: the package and the prod file's subtree only.
    const visible = new Set(["ts:src", "ts:src/svc.ts", "ts:src/svc.ts#place"]);
    const filtered = EDGES.filter((edge) => !hidden.has(edge.source) && !hidden.has(edge.target));
    expect(liftEdges(filtered, visible, index.parentOf)).toEqual([]);
    // WITHOUT the pre-filter the edge would survive by lifting its test endpoint to ts:src.
    expect(liftEdges(EDGES, visible, index.parentOf)).toHaveLength(1);
  });
});
