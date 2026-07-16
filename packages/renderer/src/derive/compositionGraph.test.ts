/**
 * The composition graph spec: which units earn a scorecard, the coupling wires between them,
 * the smell-driven card sizing, and the distance→colour health scale. Fixtures are hand-built
 * graphs so each rule is pinned independently of any extractor.
 */

import { describe, expect, it } from "vitest";
import type { GraphEdge, GraphNode } from "@meridian/core";
import {
  colorForDistance,
  channelInfoFromId,
  deriveCompositionGraph,
  sizeFor,
  HEALTH_AMBER,
  HEALTH_GREEN,
  HEALTH_RED,
  type CompNodeData,
} from "./compositionGraph";
import type { Smell, UnitMetrics } from "@meridian/design-metrics";

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
  return { unitId: "u", kind: "class", label: "U", metrics: { smells } as UnitMetrics, members: [] };
}

describe("channelInfoFromId", () => {
  it("decodes injective qualified channel ids", () => {
    expect(channelInfoFromId("ipc:postmessage/lane=window-message/channel=type%3Adelegate-ready"))
      .toEqual({ protocol: "postmessage", channel: "type:delegate-ready" });
    expect(channelInfoFromId("ipc:http/channel=GET%20%2Fapi%2Forders"))
      .toEqual({ protocol: "http", channel: "GET /api/orders" });
  });

  it("keeps legacy artifacts readable", () => {
    expect(channelInfoFromId("ipc:http/GET+/api/orders"))
      .toEqual({ protocol: "http", channel: "GET /api/orders" });
  });
});

// The unit scorecard ids, sorted — spec.nodes now also holds cluster frame nodes we filter out here.
function unitIds(specNodes: ReturnType<typeof deriveCompositionGraph>["nodes"]): string[] {
  return specNodes.filter((n) => n.type === "unit").map((n) => n.id).sort();
}

// A single unit scorecard's data, or undefined when that unit isn't drawn.
function unitData(specNodes: ReturnType<typeof deriveCompositionGraph>["nodes"], id: string): CompNodeData | undefined {
  return specNodes.find((n) => n.id === id && n.type === "unit")?.data as CompNodeData | undefined;
}

// A → B → C module chain (A also owns a class K), so C sits two coupling hops from A. The staple
// fixture for the rooting cases below.
function rootingFixture(): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes = [
    node("ts:a", "module"),
    node("ts:a#f", "function", "ts:a"),
    node("ts:a#K", "class", "ts:a"),
    node("ts:a#K.m", "method", "ts:a#K"),
    node("ts:b", "module"),
    node("ts:b#g", "function", "ts:b"),
    node("ts:c", "module"),
    node("ts:c#h", "function", "ts:c"),
  ];
  return { nodes, edges: [edge("ts:a#f", "ts:b#g"), edge("ts:b#g", "ts:c#h")] };
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
    expect(unitIds(spec.nodes)).toEqual(["ts:a", "ts:b"]);
    expect(spec.edges).toHaveLength(1);
    // Both modules are package-less, so they share the "(root)" frame — same cluster, not crossing.
    expect(spec.edges[0]).toMatchObject({ id: "couple:ts:a->ts:b", source: "ts:a", target: "ts:b", inheritanceOnly: false, crossBoundary: false });
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
    const ids = unitIds(spec.nodes);
    expect(ids).toContain("ts:m#C"); // has a member
    expect(ids).toContain("ts:i#I"); // coupling endpoint, 0 members
    expect(ids).toContain("ts:i#J");
    expect(ids).not.toContain("ts:m"); // empty + uncoupled
    expect(ids).not.toContain("ts:i");
    expect(spec.edges[0].inheritanceOnly).toBe(true);
  });
});

describe("deriveCompositionGraph rooting", () => {
  it("roots at a module: its own units + 1-hop neighbours (flagged boundary), 2-hop units absent", () => {
    const { nodes, edges } = rootingFixture();
    const spec = deriveCompositionGraph(nodes, edges, "ts:a");
    // ts:a's own units (the module + its class K) plus the 1-hop neighbour ts:b; ts:c is two hops out.
    expect(unitIds(spec.nodes)).toEqual(["ts:a", "ts:a#K", "ts:b"]);
    expect(unitIds(spec.nodes)).not.toContain("ts:c");
    expect(unitData(spec.nodes, "ts:b")?.boundary).toBe(true);
    expect(unitData(spec.nodes, "ts:a")?.boundary).toBeFalsy();
    expect(unitData(spec.nodes, "ts:a#K")?.boundary).toBeFalsy();
    // Only the root→neighbour wire survives; the neighbour→2-hop wire is dropped with its far end.
    expect(spec.edges).toHaveLength(1);
    expect(spec.edges[0]).toMatchObject({ source: "ts:a", target: "ts:b" });
  });

  it("treats root = null as the whole-system graph with no boundary units", () => {
    const { nodes, edges } = rootingFixture();
    const spec = deriveCompositionGraph(nodes, edges, null);
    expect(unitIds(spec.nodes)).toEqual(["ts:a", "ts:a#K", "ts:b", "ts:c"]);
    expect(unitData(spec.nodes, "ts:b")?.boundary).toBeFalsy();
  });

  it("falls back to the whole system when the root id is stale/invalid", () => {
    const { nodes, edges } = rootingFixture();
    const spec = deriveCompositionGraph(nodes, edges, "ts:does-not-exist");
    expect(unitIds(spec.nodes)).toEqual(["ts:a", "ts:a#K", "ts:b", "ts:c"]);
  });

  it("keeps the root's own unit even with 0 members and 0 couplings", () => {
    // ts:x is a memberless, uncoupled module (dropped whole-system) — but as the root it's never hidden.
    const nodes = [node("ts:x", "module"), node("ts:x#K", "class", "ts:x")];
    const spec = deriveCompositionGraph(nodes, [], "ts:x");
    expect(unitIds(spec.nodes)).toEqual(["ts:x"]);
    expect(unitData(spec.nodes, "ts:x")?.boundary).toBeFalsy();
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

  it("collapses to a compact height when metrics are hidden", () => {
    const shown = sizeFor(dataWith(["god-module", "low-cohesion"]), true);
    const hidden = sizeFor(dataWith(["god-module", "low-cohesion"]), false);
    expect(hidden.width).toBe(240);
    expect(hidden.height).toBeLessThan(shown.height);
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
