/**
 * The composition graph spec: which units earn a scorecard, the coupling wires between them,
 * the smell-driven card sizing, and the distance→colour health scale. Fixtures are hand-built
 * graphs so each rule is pinned independently of any extractor.
 */

import { describe, expect, it } from "vitest";
import type { GraphEdge, GraphNode } from "@meridian/core";
import {
  colorForDistance,
  colorForRisk,
  deriveCompositionGraph,
  sizeFor,
  HEALTH_AMBER,
  HEALTH_GREEN,
  HEALTH_RED,
  type CompNodeData,
} from "./compositionGraph";
import type { Smell, UnitMetrics } from "./composition";
import type { BehaviorData } from "./behavior";

function node(id: string, kind: string, parentId?: string, file = "f.ts"): GraphNode {
  return {
    id,
    kind,
    qualifiedName: id,
    displayName: id,
    parentId: parentId ?? null,
    location: { file, startLine: 1 },
  } as GraphNode;
}

function edge(source: string, target: string, kind = "calls"): GraphEdge {
  return { id: `${kind}:${source}->${target}`, source, target, kind } as GraphEdge;
}

function dataWith(smells: Smell[]): CompNodeData {
  return { unitId: "u", kind: "class", label: "U", metrics: { smells } as UnitMetrics };
}

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
    const spec = deriveCompositionGraph(nodes, edges, { root: "ts:a" });
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
    const spec = deriveCompositionGraph(nodes, edges, { root: null });
    expect(unitIds(spec.nodes)).toEqual(["ts:a", "ts:a#K", "ts:b", "ts:c"]);
    expect(unitData(spec.nodes, "ts:b")?.boundary).toBeFalsy();
  });

  it("falls back to the whole system when the root id is stale/invalid", () => {
    const { nodes, edges } = rootingFixture();
    const spec = deriveCompositionGraph(nodes, edges, { root: "ts:does-not-exist" });
    expect(unitIds(spec.nodes)).toEqual(["ts:a", "ts:a#K", "ts:b", "ts:c"]);
  });

  it("keeps the root's own unit even with 0 members and 0 couplings", () => {
    // ts:x is a memberless, uncoupled module (dropped whole-system) — but as the root it's never hidden.
    const nodes = [node("ts:x", "module"), node("ts:x#K", "class", "ts:x")];
    const spec = deriveCompositionGraph(nodes, [], { root: "ts:x" });
    expect(unitIds(spec.nodes)).toEqual(["ts:x"]);
    expect(unitData(spec.nodes, "ts:x")?.boundary).toBeFalsy();
  });
});

describe("deriveCompositionGraph blast radius", () => {
  // a → b → c → d: rooting at d, only c couples directly; a and b reach d transitively.
  function dependencyChain(): { nodes: GraphNode[]; edges: GraphEdge[] } {
    const nodes = ["ts:a", "ts:b", "ts:c", "ts:d"].flatMap((id) => [
      node(id, "module"),
      node(`${id}#f`, "function", id),
    ]);
    return {
      nodes,
      edges: [edge("ts:a#f", "ts:b#f"), edge("ts:b#f", "ts:c#f"), edge("ts:c#f", "ts:d#f")],
    };
  }

  it("keeps only the 1-hop neighbour by default", () => {
    const { nodes, edges } = dependencyChain();
    const spec = deriveCompositionGraph(nodes, edges, { root: "ts:d" });
    expect(unitIds(spec.nodes)).toEqual(["ts:c", "ts:d"]);
    expect(unitData(spec.nodes, "ts:c")?.boundary).toBe(true);
  });

  it("shows every transitive dependent as boundary when blastRadius is on", () => {
    const { nodes, edges } = dependencyChain();
    const spec = deriveCompositionGraph(nodes, edges, { root: "ts:d", blastRadius: true });
    expect(unitIds(spec.nodes)).toEqual(["ts:a", "ts:b", "ts:c", "ts:d"]);
    for (const dependent of ["ts:a", "ts:b", "ts:c"]) {
      expect(unitData(spec.nodes, dependent)?.boundary).toBe(true);
    }
    expect(unitData(spec.nodes, "ts:d")?.boundary).toBeFalsy();
  });

  it("excludes units the root merely depends on (forward-only reach)", () => {
    const { nodes, edges } = dependencyChain();
    const spec = deriveCompositionGraph(nodes, edges, { root: "ts:b", blastRadius: true });
    // Only ts:a depends on ts:b; ts:c / ts:d are what ts:b depends ON, so they stay out.
    expect(unitIds(spec.nodes)).toEqual(["ts:a", "ts:b"]);
  });

  it("terminates on a dependency cycle among the dependents", () => {
    const nodes = ["ts:a", "ts:b", "ts:d"].flatMap((id) => [node(id, "module"), node(`${id}#f`, "function", id)]);
    const edges = [edge("ts:a#f", "ts:b#f"), edge("ts:b#f", "ts:a#f"), edge("ts:b#f", "ts:d#f")];
    const spec = deriveCompositionGraph(nodes, edges, { root: "ts:d", blastRadius: true });
    expect(unitIds(spec.nodes)).toEqual(["ts:a", "ts:b", "ts:d"]);
  });
});

describe("deriveCompositionGraph behavior overlay", () => {
  // Two coupled modules plus an uncoupled pair — each in its own file so the joins are per-unit.
  function behaviorFixture(): { nodes: GraphNode[]; edges: GraphEdge[] } {
    const nodes = [
      node("ts:a", "module", undefined, "src/a.ts"),
      node("ts:a#f", "function", "ts:a", "src/a.ts"),
      node("ts:b", "module", undefined, "src/b.ts"),
      node("ts:b#g", "function", "ts:b", "src/b.ts"),
      node("ts:c", "module", undefined, "src/c.ts"),
      node("ts:c#h", "function", "ts:c", "src/c.ts"),
    ];
    return { nodes, edges: [edge("ts:a#f", "ts:b#g")] };
  }

  function behaviorWith(overrides: Partial<BehaviorData>): BehaviorData {
    return { commitsAnalyzed: 50, churnByFile: new Map(), coChange: [], ...overrides };
  }

  it("joins churn onto unit cards by module file", () => {
    const { nodes, edges } = behaviorFixture();
    const behavior = behaviorWith({ churnByFile: new Map([["src/a.ts", 12]]) });
    const spec = deriveCompositionGraph(nodes, edges, { root: null, behavior });
    expect(unitData(spec.nodes, "ts:a")?.churn).toBe(12);
    expect(unitData(spec.nodes, "ts:b")?.churn).toBeUndefined();
  });

  it("emits a co-change ghost edge only for a structurally uncoupled visible pair", () => {
    const { nodes, edges } = behaviorFixture();
    const behavior = behaviorWith({
      coChange: [
        { a: "src/a.ts", b: "src/c.ts", count: 5, ratio: 0.8 }, // no coupling wire → ghost.
        { a: "src/a.ts", b: "src/b.ts", count: 4, ratio: 0.6 }, // already coupled a→b → no ghost.
      ],
    });
    const spec = deriveCompositionGraph(nodes, edges, { root: null, behavior });
    const ghosts = spec.edges.filter((e) => e.changeCoupling);
    expect(ghosts).toEqual([
      { id: "cochange:ts:a<->ts:c", source: "ts:a", target: "ts:c", inheritanceOnly: false, crossBoundary: false, changeCoupling: true },
    ]);
  });

  it("suppresses the ghost when a coupling wire exists in the OPPOSITE direction", () => {
    const { nodes } = behaviorFixture();
    const behavior = behaviorWith({ coChange: [{ a: "src/a.ts", b: "src/b.ts", count: 4, ratio: 0.6 }] });
    const spec = deriveCompositionGraph(nodes, [edge("ts:b#g", "ts:a#f")], { root: null, behavior });
    expect(spec.edges.filter((e) => e.changeCoupling)).toEqual([]);
  });

  it("drops a ghost whose far unit is not visible in the rooted view", () => {
    const { nodes, edges } = behaviorFixture();
    const behavior = behaviorWith({ coChange: [{ a: "src/a.ts", b: "src/c.ts", count: 5, ratio: 0.8 }] });
    // Rooted at ts:a: ts:c is neither inside the root nor a coupling neighbour, so no ghost.
    const spec = deriveCompositionGraph(nodes, edges, { root: "ts:a", behavior });
    expect(unitIds(spec.nodes)).not.toContain("ts:c");
    expect(spec.edges.filter((e) => e.changeCoupling)).toEqual([]);
  });

  it("emits neither churn nor ghosts without behavior data", () => {
    const { nodes, edges } = behaviorFixture();
    const spec = deriveCompositionGraph(nodes, edges, { root: null });
    expect(unitData(spec.nodes, "ts:a")?.churn).toBeUndefined();
    expect(spec.edges.filter((e) => e.changeCoupling)).toEqual([]);
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

describe("colorForRisk", () => {
  it("is green only when Ca < 3 and there is no SDP violation", () => {
    expect(colorForRisk(0, 0)).toBe(HEALTH_GREEN);
    expect(colorForRisk(2, 0)).toBe(HEALTH_GREEN);
  });

  it("is amber when one signal creeps without either red trigger", () => {
    expect(colorForRisk(3, 0)).toBe(HEALTH_AMBER); // Ca leaves the green band
    expect(colorForRisk(0, 1)).toBe(HEALTH_AMBER); // any SDP violation ends the green
    expect(colorForRisk(5, 2)).toBe(HEALTH_AMBER); // both elevated, neither at the red line
  });

  it("is red when either Ca ≥ 6 or SDP violations ≥ 3", () => {
    expect(colorForRisk(6, 0)).toBe(HEALTH_RED);
    expect(colorForRisk(0, 3)).toBe(HEALTH_RED);
    expect(colorForRisk(9, 5)).toBe(HEALTH_RED);
  });
});
