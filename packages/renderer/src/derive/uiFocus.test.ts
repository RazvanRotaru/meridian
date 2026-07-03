import { describe, expect, it } from "vitest";
import type { GraphArtifact, GraphEdge, GraphNode } from "@meridian/core";
import { buildGraphIndex } from "../graph/graphIndex";
import { uiFocusTarget } from "./uiFocus";

function node(id: string, kind: string, parentId: string | null): GraphNode {
  return { id, kind, qualifiedName: id, displayName: id, parentId, location: { file: "f", startLine: 1 } };
}

function renders(source: string, target: string): GraphEdge {
  return { id: `renders@${source}|${target}`, source, target, kind: "renders", resolution: "resolved" };
}

function index(edges: GraphEdge[]) {
  const nodes: GraphNode[] = [
    node("ts:src", "package", null),
    node("ts:src/ui", "package", "ts:src"),
    node("ts:src/ui/App.tsx", "module", "ts:src/ui"),
    node("ts:src/ui/App.tsx#App", "function", "ts:src/ui/App.tsx"),
    node("ts:src/ui/Layout.tsx", "module", "ts:src/ui"),
    node("ts:src/ui/Layout.tsx#Layout", "function", "ts:src/ui/Layout.tsx"),
    node("ts:src/ui/Nav.tsx", "module", "ts:src/ui"),
    node("ts:src/ui/Nav.tsx#Nav", "function", "ts:src/ui/Nav.tsx"),
    node("ts:src/main.tsx", "module", "ts:src"),
    node("ts:src/main.tsx#main", "function", "ts:src/main.tsx"),
  ];
  const artifact = { nodes, edges } as unknown as GraphArtifact;
  return buildGraphIndex(artifact);
}

describe("uiFocusTarget", () => {
  it("descends past an outlier entry point to the real component container", () => {
    const edges = [
      renders("ts:src/ui/App.tsx#App", "ts:src/ui/Layout.tsx#Layout"),
      renders("ts:src/ui/App.tsx#App", "ts:src/ui/Nav.tsx#Nav"),
      renders("ts:src/ui/Layout.tsx#Layout", "ts:src/ui/Nav.tsx#Nav"),
      renders("ts:src/main.tsx#main", "ts:src/ui/App.tsx#App"),
    ];
    expect(uiFocusTarget(index(edges))).toBe("ts:src/ui");
  });

  it("returns null when there is no composition to show", () => {
    expect(uiFocusTarget(index([]))).toBeNull();
  });

  it("returns null when the only participant is a childless leaf (would blank the canvas)", () => {
    const nodes = [
      node("ts:src", "package", null),
      node("ts:src/App.tsx", "module", "ts:src"),
      node("ts:src/App.tsx#App", "function", "ts:src/App.tsx"),
    ];
    // App composes only external/library components, so the sole in-graph participant is a leaf.
    const edges = [renders("ts:src/App.tsx#App", "ext:router#Route")];
    const artifact = { nodes, edges } as unknown as GraphArtifact;
    expect(uiFocusTarget(buildGraphIndex(artifact))).toBeNull();
  });

  it("terminates on a self-parent participant instead of spinning forever", () => {
    const nodes = [node("ts:X", "function", "ts:X")]; // a self-parent the lenient viewer tolerates
    const artifact = { nodes, edges: [renders("ts:X", "ts:X")] } as unknown as GraphArtifact;
    // The assertion is simply that this returns at all (a hang would time the test out).
    expect(uiFocusTarget(buildGraphIndex(artifact))).not.toBeUndefined();
  });
});
