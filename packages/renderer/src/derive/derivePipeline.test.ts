/**
 * The headless correctness core: computeVisible (progressive disclosure) and liftEdges (edge
 * projection onto visible boxes). These are the parts we CAN verify without a browser.
 */

import { describe, expect, it } from "vitest";
import type { GraphArtifact, GraphEdge, GraphNode } from "@meridian/core";
import { buildGraphIndex } from "../graph/graphIndex";
import { computeVisible, visibleIdSet } from "./computeVisible";
import { liftEdges } from "./liftEdges";

function node(id: string, kind: string, parentId?: string): GraphNode {
  return { id, kind, qualifiedName: id, displayName: id, parentId, location: { file: id, startLine: 1 } };
}

function callsEdge(source: string, target: string, weight: number, resolution?: GraphEdge["resolution"]): GraphEdge {
  return { id: `calls@${source}|${target}`, source, target, kind: "calls", weight, resolution };
}

// A two-package fixture: P{M{C{f,f2}}} and Q{N{g}}, with cross/intra edges plus one external.
const NODES: GraphNode[] = [
  node("ts:p", "package"),
  node("ts:p/m.ts", "module", "ts:p"),
  node("ts:p/m.ts#C", "class", "ts:p/m.ts"),
  node("ts:p/m.ts#C.f", "method", "ts:p/m.ts#C"),
  node("ts:p/m.ts#C.f2", "method", "ts:p/m.ts#C"),
  node("ts:q", "package"),
  node("ts:q/n.ts", "module", "ts:q"),
  node("ts:q/n.ts#g", "function", "ts:q/n.ts"),
];

const EDGES: GraphEdge[] = [
  callsEdge("ts:p/m.ts#C.f", "ts:q/n.ts#g", 1),
  callsEdge("ts:p/m.ts#C.f2", "ts:q/n.ts#g", 3),
  callsEdge("ts:p/m.ts#C.f", "ts:p/m.ts#C.f2", 2),
  callsEdge("ts:p/m.ts#C.f", "ext:lib/index.ts#x", 5, "external"),
];

const ARTIFACT: GraphArtifact = {
  schemaVersion: "1.0.0",
  generatedAt: "2026-06-27T00:00:00.000Z",
  generator: { name: "test", version: "0" },
  target: { name: "fixture", root: ".", language: "typescript" },
  nodes: NODES,
  edges: EDGES,
};

const index = buildGraphIndex(ARTIFACT);

describe("computeVisible", () => {
  it("shows only collapsed roots when nothing is expanded", () => {
    const visible = computeVisible(index, new Set());
    expect(visible.map((entry) => entry.id)).toEqual(["ts:p", "ts:q"]);
    expect(visible.every((entry) => entry.isContainer && !entry.isExpanded)).toBe(true);
    expect(visible[0].childCount).toBe(1);
  });

  it("descends only into expanded containers, parent before children (preorder)", () => {
    const visible = computeVisible(index, new Set(["ts:p"]));
    expect(visible.map((entry) => entry.id)).toEqual(["ts:p", "ts:p/m.ts", "ts:q"]);
    expect(visible[0].isExpanded).toBe(true);
    expect(visible[1].isExpanded).toBe(false);
  });

  it("reveals a leaf only once its whole ancestor chain is expanded", () => {
    const expanded = new Set(["ts:p", "ts:p/m.ts", "ts:p/m.ts#C"]);
    const visible = computeVisible(index, expanded);
    expect(visible.map((entry) => entry.id)).toEqual([
      "ts:p",
      "ts:p/m.ts",
      "ts:p/m.ts#C",
      "ts:p/m.ts#C.f",
      "ts:p/m.ts#C.f2",
      "ts:q",
    ]);
    const leaf = visible.find((entry) => entry.id === "ts:p/m.ts#C.f");
    expect(leaf?.isContainer).toBe(false);
  });
});

describe("liftEdges", () => {
  it("lifts both endpoints to visible packages and aggregates by source->target->kind", () => {
    const visible = visibleIdSet(computeVisible(index, new Set()));
    const lifted = liftEdges(EDGES, visible, index.parentOf);
    expect(lifted).toHaveLength(1);
    const [edge] = lifted;
    expect(edge.source).toBe("ts:p");
    expect(edge.target).toBe("ts:q");
    expect(edge.weight).toBe(4); // 1 + 3, summed across the two lifted calls
    expect(edge.underlyingEdgeIds).toHaveLength(2);
    expect(edge.lifted).toBe(true);
  });

  it("drops self-loops created by lifting (f->f2 collapses inside one package)", () => {
    const visible = visibleIdSet(computeVisible(index, new Set()));
    const lifted = liftEdges(EDGES, visible, index.parentOf);
    expect(lifted.some((edge) => edge.source === edge.target)).toBe(false);
  });

  it("drops edges whose endpoint cannot be lifted (external pseudo-targets)", () => {
    const visible = visibleIdSet(computeVisible(index, new Set()));
    const lifted = liftEdges(EDGES, visible, index.parentOf);
    expect(lifted.flatMap((edge) => edge.underlyingEdgeIds)).not.toContain(
      "calls@ts:p/m.ts#C.f|ext:lib/index.ts#x",
    );
  });

  it("keeps method-level edges direct and unlifted when fully expanded", () => {
    const expanded = new Set(["ts:p", "ts:p/m.ts", "ts:p/m.ts#C", "ts:q", "ts:q/n.ts"]);
    const visible = visibleIdSet(computeVisible(index, expanded));
    const lifted = liftEdges(EDGES, visible, index.parentOf);
    const direct = lifted.find((edge) => edge.source === "ts:p/m.ts#C.f" && edge.target === "ts:q/n.ts#g");
    expect(direct?.lifted).toBe(false);
    expect(direct?.weight).toBe(1);
    const intra = lifted.find((edge) => edge.target === "ts:p/m.ts#C.f2");
    expect(intra?.source).toBe("ts:p/m.ts#C.f");
  });
});

// Mirrors deriveLayout's edge handling while focused: scope to the subtree, then lift.
function liftedUnderFocus(focusId: string, expanded: Set<string>) {
  const visible = visibleIdSet(computeVisible(index, expanded, focusId));
  const scoped = EDGES.filter(
    (edge) => index.isWithinFocus(focusId, edge.source) && index.isWithinFocus(focusId, edge.target),
  );
  return liftEdges(scoped, visible, index.parentOf);
}

describe("computeVisible under a dive-in focus", () => {
  it("roots at the focus node's CHILDREN and never draws the focus node itself", () => {
    const visible = computeVisible(index, new Set(), "ts:p");
    expect(visible.map((entry) => entry.id)).toEqual(["ts:p/m.ts"]);
    expect(visible.some((entry) => entry.id === "ts:p")).toBe(false);
    expect(visible[0].depth).toBe(0); // the focus children become the new top level
  });

  it("still descends into expanded containers within the focus, parent before children", () => {
    const expanded = new Set(["ts:p/m.ts", "ts:p/m.ts#C"]);
    const visible = computeVisible(index, expanded, "ts:p");
    expect(visible.map((entry) => entry.id)).toEqual([
      "ts:p/m.ts",
      "ts:p/m.ts#C",
      "ts:p/m.ts#C.f",
      "ts:p/m.ts#C.f2",
    ]);
  });
});

describe("edges under a dive-in focus", () => {
  it("drops edges that leave the focus subtree (cross-package + external both go)", () => {
    const expanded = new Set(["ts:p/m.ts", "ts:p/m.ts#C"]);
    const lifted = liftedUnderFocus("ts:p", expanded);
    // Only the intra-subtree f->f2 survives; f->g, f2->g and f->ext all leave ts:p.
    expect(lifted).toHaveLength(1);
    expect(lifted[0].source).toBe("ts:p/m.ts#C.f");
    expect(lifted[0].target).toBe("ts:p/m.ts#C.f2");
  });

  it("collapses an intra-subtree edge to a dropped self-loop when the box stays closed", () => {
    // Focused on ts:p with nothing expanded, f and f2 both lift to the one visible module box.
    const lifted = liftedUnderFocus("ts:p", new Set());
    expect(lifted).toEqual([]);
  });
});
