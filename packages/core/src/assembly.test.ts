import { describe, expect, it } from "vitest";
import { aggregateEdges, collapseToDepth, type RawGraphEdge } from "./assembly";
import type { GraphEdge, GraphNode } from "./types";

function raw(source: string, target: string, line: number, kind = "calls"): RawGraphEdge {
  return { source, target, kind, resolution: "resolved", callSite: { file: "f.py", line } };
}

function node(id: string, kind: string, parentId?: string): GraphNode {
  return { id, kind, qualifiedName: id, displayName: id, parentId, location: { file: "f.py", startLine: 1 } };
}

describe("aggregateEdges", () => {
  it("folds repeated call sites into one weighted edge", () => {
    const edges = aggregateEdges([raw("py:m#A.f", "py:m#B.g", 3), raw("py:m#A.f", "py:m#B.g", 9)]);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ id: "calls@py:m#A.f|py:m#B.g", weight: 2 });
    expect(edges[0]!.callSites).toHaveLength(2);
  });

  it("preserves exact syntax ranges through aggregation and depth collapse", () => {
    const ranged: RawGraphEdge = {
      ...raw("py:m#A.f", "py:m#B.g", 3),
      callSite: { file: "f.py", line: 3, col: 4, endLine: 5, endCol: 9 },
    };
    const aggregated = aggregateEdges([ranged]);
    expect(aggregated[0]!.callSites).toEqual([ranged.callSite]);
    expect(collapseToDepth([
      node("py:m", "module"),
      node("py:m#A", "class", "py:m"),
      node("py:m#A.f", "method", "py:m#A"),
      node("py:m#B", "class", "py:m"),
      node("py:m#B.g", "method", "py:m#B"),
    ], aggregated, "class").edges[0]!.callSites).toEqual([ranged.callSite]);
  });

  it("keeps different kinds between the same pair separate", () => {
    const edges = aggregateEdges([raw("py:m#A", "py:m#B", 1, "calls"), raw("py:m#A", "py:m#B", 1, "instantiates")]);
    expect(edges.map((edge) => edge.kind).sort()).toEqual(["calls", "instantiates"]);
  });
});

describe("collapseToDepth", () => {
  const nodes: GraphNode[] = [
    node("py:m", "module"),
    node("py:m#A", "class", "py:m"),
    node("py:m#A.f", "method", "py:m#A"),
    node("py:m#B", "class", "py:m"),
    node("py:m#B.g", "method", "py:m#B"),
  ];
  const edges: GraphEdge[] = aggregateEdges([raw("py:m#A.f", "py:m#B.g", 3)]);

  it("re-points a cross-class call to the surviving class ancestors", () => {
    const result = collapseToDepth(nodes, edges, "class");
    expect(result.nodes.map((entry) => entry.id)).toEqual(["py:m", "py:m#A", "py:m#B"]);
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0]).toMatchObject({ id: "calls@py:m#A|py:m#B", source: "py:m#A", target: "py:m#B" });
  });

  it("drops an edge that collapses onto a single surviving box", () => {
    const result = collapseToDepth(nodes, edges, "module");
    expect(result.nodes.map((entry) => entry.id)).toEqual(["py:m"]);
    expect(result.edges).toEqual([]);
  });

  it("returns the graph untouched when nothing is deeper than the depth", () => {
    expect(collapseToDepth(nodes, edges, "function")).toEqual({ nodes, edges });
  });

  it("keeps a boundary (ext:) edge target through collapse instead of dropping it", () => {
    const boundaryEdges = aggregateEdges([raw("py:m#A.f", "ext:lib#thing", 1)]);
    const result = collapseToDepth(nodes, boundaryEdges, "class");
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0]).toMatchObject({ source: "py:m#A", target: "ext:lib#thing" });
  });

  it("drops implementedBy when its method endpoints do not survive", () => {
    const implementationEdges = aggregateEdges([
      raw("py:m#A.f", "py:m#B.g", 3, "implementedBy"),
    ]);
    const result = collapseToDepth(nodes, implementationEdges, "class");
    expect(result.edges).toEqual([]);
  });
});
