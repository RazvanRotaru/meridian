import { describe, expect, it } from "vitest";
import type { Edge, Node } from "@xyflow/react";
import { RIBBON_EDGE_TYPE, type RibbonEdgeData } from "../../layout/parallelWires";
import { GHOST_HIERARCHY_EDGE_TYPE } from "../edges/GhostHierarchyEdge";
import { prepareCanvasEdges } from "./presentationEdgePipeline";

const node = (id: string): Node => ({ id, position: { x: 0, y: 0 }, data: {} });
const semantic = (id: string, source: string, target: string, kind = "calls"): Edge => ({
  id,
  source,
  target,
  data: { category: "dep", depKind: kind, weight: 1 },
  style: { opacity: 1 },
});
const hierarchy = (id: string, source: string, target: string): Edge => ({
  id,
  source,
  target,
  type: GHOST_HIERARCHY_EDGE_TYPE,
  data: { edgeRole: "ghost-hierarchy", presentationOnly: true },
  interactionWidth: 0,
});

describe("presentation-safe canvas edge preparation", () => {
  it("folds semantic same-pair strands but leaves the hierarchy spoke outside the ribbon", () => {
    const calls = semantic("calls", "core", "parent", "calls");
    const refs = semantic("refs", "core", "parent", "references");
    const spoke = hierarchy("spoke", "parent", "member");

    const result = prepareCanvasEdges(
      [calls, spoke, refs],
      [node("core"), node("parent"), node("member")],
      new Set(),
      false,
      { bundling: false, routing: false, spooling: false },
    );

    expect(result.hierarchyEdges).toEqual([spoke]);
    expect(result.hierarchyEdges[0]).toBe(spoke);
    expect(result.semanticEdges).toHaveLength(1);
    expect(result.semanticEdges[0].type).toBe(RIBBON_EDGE_TYPE);
    expect(((result.semanticEdges[0].data as RibbonEdgeData).members ?? []).map((edge) => edge.id).sort())
      .toEqual(["calls", "refs"]);
  });

  it("does not let a hierarchy spoke push a five-wire semantic fan over the spool threshold", () => {
    const fan = Array.from({ length: 5 }, (_, index) => semantic(`semantic-${index}`, `source-${index}`, "hub"));
    const spoke = hierarchy("sixth-but-not-semantic", "parent", "hub");
    const result = prepareCanvasEdges(
      [...fan, spoke],
      [...fan.map((edge) => node(edge.source)), node("hub"), node("parent")],
      new Set(),
      true,
      { bundling: false, routing: false, spooling: true },
    );

    expect(result.semanticEdges.every((edge) => edge.type === undefined)).toBe(true);
    expect(result.hierarchyEdges).toEqual([spoke]);
    expect(result.hierarchyEdges[0]).toBe(spoke);
  });
});
