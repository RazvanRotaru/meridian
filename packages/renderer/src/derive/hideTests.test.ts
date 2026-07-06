/**
 * Hide-tests behavior: test subtrees vanish from the visible set, and their edges are
 * filtered BEFORE lifting so a hidden test's calls never re-materialize as edges from its
 * still-visible package.
 */

import { describe, expect, it } from "vitest";
import type { GraphArtifact, GraphEdge, GraphNode } from "@meridian/core";
import { buildGraphIndex } from "../graph/graphIndex";
import { computeVisible, visibleIdSet } from "./computeVisible";
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

describe("computeVisible with hidden test ids", () => {
  it("removes hidden subtrees and corrects the parent's child count", () => {
    const visible = computeVisible(index, new Set(["ts:src", "ts:src/svc.ts"]), null, index.testIds);
    expect(visible.map((entry) => entry.id)).toEqual(["ts:src", "ts:src/svc.ts", "ts:src/svc.ts#place"]);
    expect(visible[0].childCount).toBe(1); // svc.test.ts no longer counted
  });

  it("keeps everything when nothing is hidden", () => {
    const visible = computeVisible(index, new Set(["ts:src"]), null);
    expect(visible.map((entry) => entry.id)).toEqual(["ts:src", "ts:src/svc.ts", "ts:src/svc.test.ts"]);
  });
});

describe("edge filtering for hidden tests (mirrors deriveLayout)", () => {
  it("drops a test->prod edge instead of lifting it to the visible package", () => {
    const hidden = index.testIds;
    const visible = visibleIdSet(computeVisible(index, new Set(["ts:src", "ts:src/svc.ts"]), null, hidden));
    const filtered = EDGES.filter((edge) => !hidden.has(edge.source) && !hidden.has(edge.target));
    expect(liftEdges(filtered, visible, index.parentOf)).toEqual([]);
    // WITHOUT the pre-filter the edge would survive by lifting its test endpoint to ts:src.
    expect(liftEdges(EDGES, visible, index.parentOf)).toHaveLength(1);
  });
});
