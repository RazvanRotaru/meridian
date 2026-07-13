import { describe, expect, it } from "vitest";
import type { Edge, Node } from "@xyflow/react";
import { RIBBON_EDGE_TYPE, type RibbonEdgeData } from "../../layout/parallelWires";
import { BUNDLE_EDGE_TYPE } from "../../layout/edgeBundling";
import { SPOOL_EDGE_TYPE } from "../../layout/edgeSpooling";
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

  it("keeps a selected fan strand direct while the unselected remainder still uses its highway", () => {
    const fan = Array.from({ length: 7 }, (_, index) => semantic(`e${index}`, `source-${index}`, "hub"));
    const result = prepareCanvasEdges(
      fan,
      [...fan.map((edge) => node(edge.source)), node("hub")],
      new Set(["source-0"]),
      true,
      { bundling: false, routing: false, spooling: true },
    );

    expect(result.semanticEdges.find((edge) => edge.id === "e0")?.type).toBeUndefined();
    expect(result.semanticEdges.filter((edge) => edge.id !== "e0")
      .every((edge) => edge.type === SPOOL_EDGE_TYPE)).toBe(true);
  });

  it("restores exact node-to-node strands when highways are disabled", () => {
    const frame = (id: string): Node => ({ id, position: { x: 0, y: 0 }, data: {} });
    const child = (id: string, parentId: string): Node => ({
      id,
      parentId,
      position: { x: 0, y: 0 },
      data: {},
    });
    const nodes = [
      frame("left"),
      frame("right"),
      ...Array.from({ length: 4 }, (_, index) => child(`a${index}`, "left")),
      ...Array.from({ length: 4 }, (_, index) => child(`b${index}`, "right")),
    ];
    const exact = Array.from({ length: 4 }, (_, index) => semantic(`e${index}`, `a${index}`, `b${index}`));

    const highways = prepareCanvasEdges(
      exact,
      nodes,
      new Set(),
      true,
      { bundling: true, routing: false, spooling: false },
    ).semanticEdges;
    const direct = prepareCanvasEdges(
      exact,
      nodes,
      new Set(),
      false,
      { bundling: true, routing: true, spooling: true },
    ).semanticEdges;

    expect(highways).toHaveLength(1);
    expect(highways[0].type).toBe(BUNDLE_EDGE_TYPE);
    expect(direct.map(({ id, source, target, type }) => ({ id, source, target, type }))).toEqual(
      exact.map(({ id, source, target }) => ({ id, source, target, type: undefined })),
    );
  });
});
