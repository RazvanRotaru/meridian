/**
 * Wire ATTRIBUTION: every aggregated Map wire keeps the artifact edge ids it stands for
 * (`underlyingEdgeIds`), so the Wire Inspector can resolve a clicked strand back to real
 * symbol→symbol links and their call sites. Pinned per wire family: code-dep wires (liftDepEdges),
 * import wires (the synthetic `mimp:` pair expands through the module graph's recorded edge ids),
 * and ghost wires (ghostDepWires).
 */

import { describe, expect, it } from "vitest";
import type { GraphArtifact, GraphEdge, GraphNode } from "@meridian/core";
import { buildGraphIndex } from "../graph/graphIndex";
import { buildBlockDeps, liftDepEdges } from "./blockDeps";
import { buildModuleGraph } from "./moduleGraph";
import { deriveModuleTree } from "./moduleTree";
import { ghostDepWires } from "./ghostDeps";

function node(id: string, kind: string, parentId?: string): GraphNode {
  return { id, kind, qualifiedName: id, displayName: id, parentId: parentId ?? null, location: { file: "f.ts", startLine: 1 } } as GraphNode;
}

function edge(id: string, source: string, target: string, kind: string): GraphEdge {
  return { id, source, target, kind, resolution: "resolved", weight: 1 } as GraphEdge;
}

// One npm package, two files; f1 holds two functions that both call f2's function.
function fixture() {
  const nodes = [
    { ...node("ts:pkg", "package"), tags: ["npm-package"] } as GraphNode,
    node("ts:pkg/f1.ts", "module", "ts:pkg"),
    node("ts:pkg/f1.ts#a", "function", "ts:pkg/f1.ts"),
    node("ts:pkg/f1.ts#b", "function", "ts:pkg/f1.ts"),
    node("ts:pkg/f2.ts", "module", "ts:pkg"),
    node("ts:pkg/f2.ts#run", "function", "ts:pkg/f2.ts"),
  ];
  const edges = [
    edge("call:a", "ts:pkg/f1.ts#a", "ts:pkg/f2.ts#run", "calls"),
    edge("call:b", "ts:pkg/f1.ts#b", "ts:pkg/f2.ts#run", "calls"),
    edge("imp:1", "ts:pkg/f1.ts", "ts:pkg/f2.ts", "imports"),
    edge("imp:2", "ts:pkg/f1.ts#a", "ts:pkg/f2.ts#run", "imports"),
  ];
  const index = buildGraphIndex({ nodes, edges } as GraphArtifact);
  return { index, graph: buildModuleGraph(index), blockDeps: buildBlockDeps(index) };
}

describe("wire attribution — underlyingEdgeIds survive every aggregation", () => {
  it("liftDepEdges merges two symbol calls into one file wire, keeping BOTH artifact ids", () => {
    const { index, blockDeps } = fixture();
    const visible = new Set(["ts:pkg/f1.ts", "ts:pkg/f2.ts"]);
    const lifted = liftDepEdges(blockDeps, visible, index, () => true);
    const wire = lifted.find((w) => w.kind === "calls");
    expect(wire?.weight).toBe(2);
    expect(wire?.underlyingEdgeIds.sort()).toEqual(["call:a", "call:b"]);
  });

  it("the module graph records the real `imports` edge ids per file pair", () => {
    const { graph } = fixture();
    const ids = [...graph.edgeIds.values()].flat().sort();
    expect(ids).toEqual(["imp:1", "imp:2"]); // the member-level import lifts to its owning file
  });

  it("import wires in the derived tree expand their synthetic pair ids back to artifact ids", () => {
    const { index, graph, blockDeps } = fixture();
    const tree = deriveModuleTree(index, "ts:pkg", new Set(), graph, blockDeps, {});
    const importWire = tree.edges.find((e) => e.category === "import");
    expect(importWire?.underlyingEdgeIds?.sort()).toEqual(["imp:1", "imp:2"]);
  });

  it("ghost wires carry the artifact ids of the edges that left the level", () => {
    const { index, blockDeps } = fixture();
    // Only f1's symbols are drawn: both calls leave the level and ghost onto f2's function.
    const visible = new Set(["ts:pkg/f1.ts", "ts:pkg/f1.ts#a", "ts:pkg/f1.ts#b"]);
    const { wires } = ghostDepWires(blockDeps, [], visible, index, () => true, new Set());
    expect(wires).toHaveLength(2); // one per drawn source symbol
    expect(wires.flatMap((w) => w.underlyingEdgeIds).sort()).toEqual(["call:a", "call:b"]);
  });
});
