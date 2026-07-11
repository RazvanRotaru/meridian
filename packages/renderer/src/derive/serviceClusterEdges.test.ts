import { describe, expect, it } from "vitest";
import type { GraphArtifact, GraphNode } from "@meridian/core";
import type { CouplingEdge } from "@meridian/design-metrics";
import { buildGraphIndex } from "../graph/graphIndex";
import { clusterCouplingEdges, frameIdOf } from "./serviceClusterEdges";

function node(id: string, kind: string, parentId?: string): GraphNode {
  return {
    id,
    kind,
    qualifiedName: id,
    displayName: id,
    parentId: parentId ?? null,
    location: { file: id.includes("a") ? "a.ts" : "b.ts", startLine: 1 },
  } as GraphNode;
}

describe("clusterCouplingEdges", () => {
  it("keeps every relationship kind, weight, and evidence trail after frame lifting", () => {
    const a = "ts:a.ts#AService";
    const b = "ts:b.ts#BService";
    const index = buildGraphIndex({
      nodes: [node("ts:a.ts", "module"), node(a, "class", "ts:a.ts"), node("ts:b.ts", "module"), node(b, "class", "ts:b.ts")],
      edges: [],
    } as unknown as GraphArtifact);
    const coupling: CouplingEdge = {
      source: a,
      target: b,
      kinds: new Set(["calls", "implements"]),
      evidenceByKind: new Map([
        ["calls", { weight: 4, underlyingEdgeIds: ["calls@a|b"] }],
        ["implements", { weight: 1, underlyingEdgeIds: ["implements@a|b"] }],
      ]),
      inheritanceOnly: false,
    };
    const visible = new Set([frameIdOf(a), frameIdOf(b)]);
    const edges = clusterCouplingEdges([coupling], new Map([[a, a], [b, b]]), visible, index);

    expect(edges).toHaveLength(2);
    expect(edges.find((edge) => edge.depKind === "calls")).toMatchObject({
      source: frameIdOf(a),
      target: frameIdOf(b),
      weight: 4,
      underlyingEdgeIds: ["calls@a|b"],
    });
    expect(edges.find((edge) => edge.depKind === "implements")).toMatchObject({
      weight: 1,
      underlyingEdgeIds: ["implements@a|b"],
    });
  });
});
