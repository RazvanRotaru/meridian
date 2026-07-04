/**
 * The composition graph spec: which units earn a scorecard, the coupling wires between them,
 * the smell-driven card sizing, and the distance→colour health scale. Fixtures are hand-built
 * graphs so each rule is pinned independently of any extractor.
 */

import { describe, expect, it } from "vitest";
import type { GraphEdge, GraphNode } from "@meridian/core";
import {
  colorForDistance,
  deriveCompositionGraph,
  sizeFor,
  HEALTH_AMBER,
  HEALTH_GREEN,
  HEALTH_RED,
  type CompNodeData,
} from "./compositionGraph";
import type { Smell, UnitMetrics } from "./composition";

function node(id: string, kind: string, parentId?: string): GraphNode {
  return {
    id,
    kind,
    qualifiedName: id,
    displayName: id,
    parentId: parentId ?? null,
    location: { file: "f.ts", startLine: 1 },
  } as GraphNode;
}

function edge(source: string, target: string, kind = "calls"): GraphEdge {
  return { id: `${kind}:${source}->${target}`, source, target, kind } as GraphEdge;
}

function dataWith(smells: Smell[]): CompNodeData {
  return { unitId: "u", kind: "class", label: "U", metrics: { smells } as UnitMetrics };
}

describe("deriveCompositionGraph", () => {
  it("yields two unit nodes and one coupling edge for a two-unit dependency", () => {
    const nodes = [
      node("ts:a", "module"),
      node("ts:a#f", "function", "ts:a"),
      node("ts:b", "module"),
      node("ts:b#g", "function", "ts:b"),
    ];
    const spec = deriveCompositionGraph(nodes, [edge("ts:a#f", "ts:b#g")]);
    expect(spec.nodes.map((n) => n.id).sort()).toEqual(["ts:a", "ts:b"]);
    expect(spec.edges).toHaveLength(1);
    expect(spec.edges[0]).toMatchObject({ id: "couple:ts:a->ts:b", source: "ts:a", target: "ts:b", inheritanceOnly: false });
  });

  it("drops an empty, uncoupled unit but keeps a coupling endpoint with no members", () => {
    // A module holding a class (0 members, no couplings) is dropped; the two interfaces are
    // memberless but joined by extends, so both survive as coupling endpoints.
    const nodes = [
      node("ts:m", "module"),
      node("ts:m#C", "class", "ts:m"),
      node("ts:m#C.c1", "method", "ts:m#C"),
      node("ts:i", "module"),
      node("ts:i#I", "interface", "ts:i"),
      node("ts:i#J", "interface", "ts:i"),
    ];
    const spec = deriveCompositionGraph(nodes, [edge("ts:i#I", "ts:i#J", "extends")]);
    const ids = spec.nodes.map((n) => n.id).sort();
    expect(ids).toContain("ts:m#C"); // has a member
    expect(ids).toContain("ts:i#I"); // coupling endpoint, 0 members
    expect(ids).toContain("ts:i#J");
    expect(ids).not.toContain("ts:m"); // empty + uncoupled
    expect(ids).not.toContain("ts:i");
    expect(spec.edges[0].inheritanceOnly).toBe(true);
  });
});

describe("sizeFor", () => {
  it("keeps a fixed width and grows taller with smell chip rows", () => {
    const zero = sizeFor(dataWith([]));
    const two = sizeFor(dataWith(["god-module", "low-cohesion"]));
    expect(zero.width).toBe(240);
    expect(two.width).toBe(240);
    expect(two.height).toBeGreaterThan(zero.height);
  });
});

describe("colorForDistance", () => {
  it("steps green → amber → red across the threshold boundaries", () => {
    expect(colorForDistance(0)).toBe(HEALTH_GREEN);
    expect(colorForDistance(0.2)).toBe(HEALTH_GREEN);
    expect(colorForDistance(0.21)).toBe(HEALTH_AMBER);
    expect(colorForDistance(0.5)).toBe(HEALTH_AMBER);
    expect(colorForDistance(0.69)).toBe(HEALTH_AMBER);
    expect(colorForDistance(0.7)).toBe(HEALTH_RED);
    expect(colorForDistance(1)).toBe(HEALTH_RED);
  });
});
