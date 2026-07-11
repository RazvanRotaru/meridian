import { describe, expect, it } from "vitest";
import type { Edge } from "@xyflow/react";
import { GHOST_HIERARCHY_EDGE_TYPE } from "../edges/GhostHierarchyEdge";
import { isGhostHierarchyEdge, isInteractiveSemanticEdge, partitionPresentationEdges } from "./presentationEdges";

const edge = (id: string, data: Record<string, unknown> = {}): Edge => ({
  id,
  source: `${id}:source`,
  target: `${id}:target`,
  data,
});

describe("presentation edge classification", () => {
  it("recognizes the canonical role and the legacy boolean", () => {
    expect(isGhostHierarchyEdge(edge("role", { edgeRole: "ghost-hierarchy" }))).toBe(true);
    expect(isGhostHierarchyEdge(edge("legacy", { ghostHierarchy: true }))).toBe(true);
    expect(isGhostHierarchyEdge(edge("semantic", { category: "dep" }))).toBe(false);
    expect(isInteractiveSemanticEdge(edge("role", { edgeRole: "ghost-hierarchy" }))).toBe(false);
    expect(isInteractiveSemanticEdge(edge("semantic", { category: "dep" }))).toBe(true);
  });

  it("partitions stably and preserves every hierarchy edge by identity", () => {
    const semanticA = edge("semantic-a", { category: "dep" });
    const hierarchyA = { ...edge("hierarchy-a", { edgeRole: "ghost-hierarchy" }), type: GHOST_HIERARCHY_EDGE_TYPE };
    const semanticB = edge("semantic-b", { category: "import" });
    const hierarchyB = edge("hierarchy-b", { ghostHierarchy: true });

    const result = partitionPresentationEdges([semanticA, hierarchyA, semanticB, hierarchyB]);

    expect(result.semanticEdges).toEqual([semanticA, semanticB]);
    expect(result.hierarchyEdges).toEqual([hierarchyA, hierarchyB]);
    expect(result.hierarchyEdges[0]).toBe(hierarchyA);
    expect(result.hierarchyEdges[1]).toBe(hierarchyB);
  });

  it("returns the original semantic array on the ordinary no-spoke path", () => {
    const edges = [edge("one"), edge("two")];
    expect(partitionPresentationEdges(edges)).toEqual({ semanticEdges: edges, hierarchyEdges: [] });
    expect(partitionPresentationEdges(edges).semanticEdges).toBe(edges);
  });
});
