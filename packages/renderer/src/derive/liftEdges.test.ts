/**
 * The headless correctness core of liftEdges: edge projection onto visible boxes. (The old ui
 * lens's computeVisible walk was retired with the phase-C canvas unification — the module surfaces
 * derive their frontier through the codeWalk instead — so the visible sets here are literal.)
 */

import { describe, expect, it } from "vitest";
import type { GraphArtifact, GraphEdge, GraphNode } from "@meridian/core";
import { buildGraphIndex } from "../graph/graphIndex";
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

// The collapsed-roots frontier: only the two package boxes are drawn.
const ROOTS_VISIBLE: ReadonlySet<string> = new Set(["ts:p", "ts:q"]);

describe("liftEdges", () => {
  it("lifts both endpoints to visible packages and aggregates by source->target->kind", () => {
    const lifted = liftEdges(EDGES, ROOTS_VISIBLE, index.parentOf);
    expect(lifted).toHaveLength(1);
    const [edge] = lifted;
    expect(edge.source).toBe("ts:p");
    expect(edge.target).toBe("ts:q");
    expect(edge.weight).toBe(4); // 1 + 3, summed across the two lifted calls
    expect(edge.underlyingEdgeIds).toHaveLength(2);
    expect(edge.lifted).toBe(true);
  });

  it("drops self-loops created by lifting (f->f2 collapses inside one package)", () => {
    const lifted = liftEdges(EDGES, ROOTS_VISIBLE, index.parentOf);
    expect(lifted.some((edge) => edge.source === edge.target)).toBe(false);
  });

  it("drops edges whose endpoint cannot be lifted (external pseudo-targets)", () => {
    const lifted = liftEdges(EDGES, ROOTS_VISIBLE, index.parentOf);
    expect(lifted.flatMap((edge) => edge.underlyingEdgeIds)).not.toContain(
      "calls@ts:p/m.ts#C.f|ext:lib/index.ts#x",
    );
  });

  it("keeps method-level edges direct and unlifted when fully expanded", () => {
    const visible = new Set([
      "ts:p",
      "ts:p/m.ts",
      "ts:p/m.ts#C",
      "ts:p/m.ts#C.f",
      "ts:p/m.ts#C.f2",
      "ts:q",
      "ts:q/n.ts",
      "ts:q/n.ts#g",
    ]);
    const lifted = liftEdges(EDGES, visible, index.parentOf);
    const direct = lifted.find((edge) => edge.source === "ts:p/m.ts#C.f" && edge.target === "ts:q/n.ts#g");
    expect(direct?.lifted).toBe(false);
    expect(direct?.weight).toBe(1);
    const intra = lifted.find((edge) => edge.target === "ts:p/m.ts#C.f2");
    expect(intra?.source).toBe("ts:p/m.ts#C.f");
  });

  it("drops edges that leave a focus-scoped subtree before lifting (the dive-in projection)", () => {
    // Mirrors a focus scope on ts:p: pre-filter to intra-subtree edges, then lift onto its frontier.
    const visible = new Set(["ts:p/m.ts", "ts:p/m.ts#C", "ts:p/m.ts#C.f", "ts:p/m.ts#C.f2"]);
    const scoped = EDGES.filter(
      (edge) => index.isWithinFocus("ts:p", edge.source) && index.isWithinFocus("ts:p", edge.target),
    );
    const lifted = liftEdges(scoped, visible, index.parentOf);
    // Only the intra-subtree f->f2 survives; f->g, f2->g and f->ext all leave ts:p.
    expect(lifted).toHaveLength(1);
    expect(lifted[0].source).toBe("ts:p/m.ts#C.f");
    expect(lifted[0].target).toBe("ts:p/m.ts#C.f2");
  });
});
