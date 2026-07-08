import { describe, expect, it } from "vitest";
import type { GraphArtifact, GraphEdge, GraphNode } from "@meridian/core";
import { buildGraphIndex } from "../graph/graphIndex";
import { buildBlockDeps } from "./blockDeps";
import { buildModuleGraph } from "./moduleGraph";
import { deriveModuleTree } from "./moduleTree";

function node(id: string, kind: string, parentId?: string, displayName?: string): GraphNode {
  return {
    id,
    kind,
    qualifiedName: id,
    displayName: displayName ?? id,
    parentId: parentId ?? null,
    location: { file: "f.ts", startLine: 1 },
  } as GraphNode;
}

function treeOf(nodes: GraphNode[], edges: GraphEdge[], focus: string | null) {
  const index = buildGraphIndex({ nodes, edges } as GraphArtifact);
  return deriveModuleTree(index, focus, new Set(), buildModuleGraph(index), buildBlockDeps(index), {});
}

describe("deriveModuleTree — file focus", () => {
  it("renders the focused file's declarations as roots", () => {
    const nodes = [
      node("ts:pkg", "package", undefined, "pkg"),
      node("ts:pkg/src", "package", "ts:pkg", "src"),
      node("ts:pkg/src/svc.ts", "module", "ts:pkg/src", "svc.ts"),
      node("ts:pkg/src/svc.ts#OrderService", "class", "ts:pkg/src/svc.ts", "OrderService"),
      node("ts:pkg/src/svc.ts#OrderService.place", "method", "ts:pkg/src/svc.ts#OrderService", "place"),
      node("ts:pkg/src/svc.ts#helper", "function", "ts:pkg/src/svc.ts", "helper"),
    ];
    const tree = treeOf(nodes, [], "ts:pkg/src/svc.ts");
    expect(tree.effectiveFocus).toBe("ts:pkg/src/svc.ts");
    expect(tree.nodes.map((n) => ({ id: n.id, kind: n.kind, parentId: n.parentId }))).toEqual([
      { id: "ts:pkg/src/svc.ts#OrderService", kind: "unit", parentId: null },
      { id: "ts:pkg/src/svc.ts#OrderService.place", kind: "block", parentId: "ts:pkg/src/svc.ts#OrderService" },
      { id: "ts:pkg/src/svc.ts#helper", kind: "block", parentId: null },
    ]);
  });
});
