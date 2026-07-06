/**
 * Component-design metrics. Fixtures are hand-built graphs (nodes + edges) so every rule — unit
 * partitioning, Ca/Ce coupling, instability/abstractness/distance, LCOM4 cohesion, and each smell
 * threshold — is pinned independently of any extractor or example artifact.
 */

import { describe, expect, it } from "vitest";
import type { GraphEdge, GraphNode } from "@meridian/core";
import { computeCompositionMetrics, rankRefactorCandidates, type UnitMetrics } from "./composition";

interface NodeExtra {
  parentId?: string;
  displayName?: string;
  file?: string;
  tags?: string[];
}

function node(id: string, kind: string, extra: NodeExtra = {}): GraphNode {
  return {
    id,
    kind,
    qualifiedName: id,
    displayName: extra.displayName ?? id,
    parentId: extra.parentId ?? null,
    tags: extra.tags,
    location: { file: extra.file ?? "f.ts", startLine: 1 },
  } as GraphNode;
}

function edge(source: string, target: string, kind = "calls"): GraphEdge {
  return { id: `${kind}:${source}->${target}`, source, target, kind } as GraphEdge;
}

function metricOf(nodes: GraphNode[], edges: GraphEdge[], unitId: string): UnitMetrics {
  const metric = computeCompositionMetrics(nodes, edges).get(unitId);
  if (!metric) {
    throw new Error(`no metrics for ${unitId}`);
  }
  return metric;
}

describe("member assignment (enclosingUnit)", () => {
  // module M { function top { function inner }, class A { m1 { function nested }, m2 } }
  const nodes = [
    node("ts:m", "module"),
    node("ts:m#top", "function", { parentId: "ts:m" }),
    node("ts:m#top.inner", "function", { parentId: "ts:m#top" }),
    node("ts:m#A", "class", { parentId: "ts:m" }),
    node("ts:m#A.m1", "method", { parentId: "ts:m#A" }),
    node("ts:m#A.m1.nested", "function", { parentId: "ts:m#A.m1" }),
    node("ts:m#A.m2", "method", { parentId: "ts:m#A" }),
  ];

  it("counts a class's methods (and functions nested in them) as the class's members", () => {
    expect(metricOf(nodes, [], "ts:m#A").members).toBe(3); // m1, m2, nested
  });

  it("counts a module's top-level functions (and functions nested in them) as the module's members", () => {
    expect(metricOf(nodes, [], "ts:m").members).toBe(2); // top, top.inner — the class is not a member
  });
});

describe("coupling (Ce / Ca)", () => {
  // module m { class A { a1, a2 }, class B { b1 } }; a1 calls b1 (cross-unit) and a2 (self).
  const nodes = [
    node("ts:m", "module"),
    node("ts:m#A", "class", { parentId: "ts:m" }),
    node("ts:m#A.a1", "method", { parentId: "ts:m#A" }),
    node("ts:m#A.a2", "method", { parentId: "ts:m#A" }),
    node("ts:m#B", "class", { parentId: "ts:m" }),
    node("ts:m#B.b1", "method", { parentId: "ts:m#B" }),
  ];
  const edges = [edge("ts:m#A.a1", "ts:m#B.b1"), edge("ts:m#A.a1", "ts:m#A.a2")];

  it("counts a cross-unit call toward the source's Ce and the target's Ca", () => {
    expect(metricOf(nodes, edges, "ts:m#A").ce).toBe(1);
    expect(metricOf(nodes, edges, "ts:m#B").ca).toBe(1);
  });

  it("does not count a self-internal call toward Ce or Ca", () => {
    const a = metricOf(nodes, edges, "ts:m#A");
    expect(a.ca).toBe(0);
    expect(metricOf(nodes, edges, "ts:m#B").ce).toBe(0);
  });
});

describe("instability I = Ce / (Ca + Ce)", () => {
  const nodes = [
    node("ts:a", "module"),
    node("ts:a#f", "function", { parentId: "ts:a" }),
    node("ts:b", "module"),
    node("ts:b#g", "function", { parentId: "ts:b" }),
  ];
  const edges = [edge("ts:a#f", "ts:b#g")]; // a → b

  it("is 1 for a purely outbound unit and 0 for a purely inbound one", () => {
    expect(metricOf(nodes, edges, "ts:a").instability).toBe(1);
    expect(metricOf(nodes, edges, "ts:b").instability).toBe(0);
  });

  it("is 0 when the unit has no coupling at all (Ca + Ce === 0)", () => {
    const lone = [node("ts:x", "module"), node("ts:x#h", "function", { parentId: "ts:x" })];
    expect(metricOf(lone, [], "ts:x").instability).toBe(0);
  });
});

describe("abstractness A", () => {
  it("is 1 for an interface regardless of members", () => {
    const nodes = [node("ts:i#I", "interface")];
    expect(metricOf(nodes, [], "ts:i#I").abstractness).toBe(1);
  });

  it("is the abstract-tagged share of members for a class (1 of 2 → 0.5)", () => {
    const nodes = [
      node("ts:m#C", "class"),
      node("ts:m#C.a", "method", { parentId: "ts:m#C", tags: ["abstract"] }),
      node("ts:m#C.b", "method", { parentId: "ts:m#C" }),
    ];
    expect(metricOf(nodes, [], "ts:m#C").abstractness).toBe(0.5);
  });

  it("is 0 for a module of plain functions", () => {
    const nodes = [node("ts:m", "module"), node("ts:m#f", "function", { parentId: "ts:m" })];
    expect(metricOf(nodes, [], "ts:m").abstractness).toBe(0);
  });
});

describe("distance D = |A + I − 1|", () => {
  const nodes = [
    node("ts:a", "module"),
    node("ts:a#f", "function", { parentId: "ts:a" }),
    node("ts:b", "module"),
    node("ts:b#g", "function", { parentId: "ts:b" }),
  ];
  const edges = [edge("ts:a#f", "ts:b#g")];

  it("is 0 on the main sequence (A=0, I=1) and 1 at the corner (A=0, I=0)", () => {
    expect(metricOf(nodes, edges, "ts:a").distance).toBe(0); // |0 + 1 − 1|
    expect(metricOf(nodes, edges, "ts:b").distance).toBe(1); // |0 + 0 − 1|
  });
});

describe("cohesion (LCOM4)", () => {
  // Class with two disconnected call clusters: m1→m2 and m3→m4.
  const fragmented = [
    node("ts:m#C", "class"),
    node("ts:m#C.m1", "method", { parentId: "ts:m#C" }),
    node("ts:m#C.m2", "method", { parentId: "ts:m#C" }),
    node("ts:m#C.m3", "method", { parentId: "ts:m#C" }),
    node("ts:m#C.m4", "method", { parentId: "ts:m#C" }),
  ];
  const fragmentedEdges = [edge("ts:m#C.m1", "ts:m#C.m2"), edge("ts:m#C.m3", "ts:m#C.m4")];

  it("splits two disconnected call clusters into 2 components at cohesion 0.67 (not low enough to flag)", () => {
    const c = metricOf(fragmented, fragmentedEdges, "ts:m#C");
    expect(c.lcomComponents).toBe(2);
    expect(c.cohesion).toBe(0.67); // 1 − (2 − 1) / (4 − 1)
    expect(c.smells).not.toContain("low-cohesion"); // 0.67 > 0.34 — the rule flags fragmentation relative to size
  });

  it("collapses a fully chained class into 1 component with cohesion 1", () => {
    const chainEdges = [
      edge("ts:m#C.m1", "ts:m#C.m2"),
      edge("ts:m#C.m2", "ts:m#C.m3"),
      edge("ts:m#C.m3", "ts:m#C.m4"),
    ];
    const c = metricOf(fragmented, chainEdges, "ts:m#C");
    expect(c.lcomComponents).toBe(1);
    expect(c.cohesion).toBe(1);
    expect(c.smells).not.toContain("low-cohesion");
  });
});

describe("smells", () => {
  it("fires god-module on a hub with Ca ≥ 5 and Ce ≥ 5, not on its leaf callers", () => {
    const nodes: GraphNode[] = [node("H", "module"), node("H#h", "function", { parentId: "H" })];
    const edges: GraphEdge[] = [];
    for (let i = 0; i < 5; i += 1) {
      nodes.push(node(`C${i}`, "module"), node(`C${i}#c`, "function", { parentId: `C${i}` }));
      nodes.push(node(`E${i}`, "module"), node(`E${i}#e`, "function", { parentId: `E${i}` }));
      edges.push(edge(`C${i}#c`, "H#h"), edge("H#h", `E${i}#e`));
    }
    const hub = metricOf(nodes, edges, "H");
    expect([hub.ca, hub.ce]).toEqual([5, 5]);
    expect(hub.smells).toContain("god-module");
    expect(metricOf(nodes, edges, "C0").smells).not.toContain("god-module");
  });

  it("fires zone-of-pain on a concrete, heavily depended-upon unit, not on its callers", () => {
    const nodes: GraphNode[] = [node("P", "module"), node("P#p", "function", { parentId: "P" })];
    const edges: GraphEdge[] = [];
    for (let i = 0; i < 3; i += 1) {
      nodes.push(node(`D${i}`, "module"), node(`D${i}#d`, "function", { parentId: `D${i}` }));
      edges.push(edge(`D${i}#d`, "P#p")); // Ca(P) = 3, Ce(P) = 0 → A = 0, I = 0
    }
    expect(metricOf(nodes, edges, "P").smells).toContain("zone-of-pain");
    expect(metricOf(nodes, edges, "D0").smells).not.toContain("zone-of-pain"); // I = 1
  });

  it("fires zone-of-uselessness on an abstract unit nothing depends on, not on the depended-upon one", () => {
    const nodes = [node("ts:u#U", "interface"), node("ts:u#V", "interface")];
    const edges = [edge("ts:u#U", "ts:u#V", "extends")]; // U → V: I(U) = 1, A(U) = 1
    expect(metricOf(nodes, edges, "ts:u#U").smells).toContain("zone-of-uselessness");
    expect(metricOf(nodes, edges, "ts:u#V").smells).not.toContain("zone-of-uselessness"); // I(V) = 0
  });

  it("fires low-cohesion when a 4-member unit fragments into 3 components (cohesion 0.33 ≤ 0.34)", () => {
    const nodes = [
      node("ts:m#C", "class"),
      node("ts:m#C.m1", "method", { parentId: "ts:m#C" }),
      node("ts:m#C.m2", "method", { parentId: "ts:m#C" }),
      node("ts:m#C.m3", "method", { parentId: "ts:m#C" }),
      node("ts:m#C.m4", "method", { parentId: "ts:m#C" }),
    ]; // m1→m2 cluster + m3 + m4 isolated → 3 components
    const edges = [edge("ts:m#C.m1", "ts:m#C.m2")];
    const c = metricOf(nodes, edges, "ts:m#C");
    expect(c.lcomComponents).toBe(3);
    expect(c.cohesion).toBe(0.33); // 1 − (3 − 1) / (4 − 1)
    expect(c.smells).toContain("low-cohesion");
  });

  it("does not fire low-cohesion on a cohesive unit with one stray member (the CartService case)", () => {
    // 6 members: m1..m5 form one call cluster + a stray m6 → 2 components, cohesion 0.8.
    // The old `lcomComponents ≥ 2` rule flagged this false positive; the cohesion-ratio rule does not.
    const nodes = [
      node("ts:m#Cart", "class"),
      node("ts:m#Cart.m1", "method", { parentId: "ts:m#Cart" }),
      node("ts:m#Cart.m2", "method", { parentId: "ts:m#Cart" }),
      node("ts:m#Cart.m3", "method", { parentId: "ts:m#Cart" }),
      node("ts:m#Cart.m4", "method", { parentId: "ts:m#Cart" }),
      node("ts:m#Cart.m5", "method", { parentId: "ts:m#Cart" }),
      node("ts:m#Cart.m6", "method", { parentId: "ts:m#Cart" }),
    ];
    const edges = [
      edge("ts:m#Cart.m1", "ts:m#Cart.m2"),
      edge("ts:m#Cart.m2", "ts:m#Cart.m3"),
      edge("ts:m#Cart.m3", "ts:m#Cart.m4"),
      edge("ts:m#Cart.m4", "ts:m#Cart.m5"),
    ]; // m6 has no internal calls
    const c = metricOf(nodes, edges, "ts:m#Cart");
    expect(c.members).toBe(6);
    expect(c.lcomComponents).toBe(2);
    expect(c.cohesion).toBe(0.8); // 1 − (2 − 1) / (6 − 1)
    expect(c.smells).not.toContain("low-cohesion");
  });

  it("does not fire low-cohesion below the member threshold even when fragmented", () => {
    const nodes = [
      node("ts:m#C", "class"),
      node("ts:m#C.m1", "method", { parentId: "ts:m#C" }),
      node("ts:m#C.m2", "method", { parentId: "ts:m#C" }),
      node("ts:m#C.m3", "method", { parentId: "ts:m#C" }),
    ]; // 3 members, no internal calls → 3 components, but members < 4
    const c = metricOf(nodes, [], "ts:m#C");
    expect(c.lcomComponents).toBe(3);
    expect(c.smells).not.toContain("low-cohesion");
  });
});

describe("external fan-out", () => {
  it("counts distinct external/unresolved/absent targets toward externalFanout, not Ce", () => {
    const nodes = [node("ts:m", "module"), node("ts:m#f", "function", { parentId: "ts:m" })];
    const edges = [
      edge("ts:m#f", "ext:lib#x"),
      edge("ts:m#f", "unresolved:?"),
      edge("ts:m#f", "ts:absent#y"), // in-graph shape but no such node
      edge("ts:m#f", "ext:lib#x"), // duplicate — counted once
    ];
    const m = metricOf(nodes, edges, "ts:m");
    expect(m.externalFanout).toBe(3);
    expect(m.ce).toBe(0);
  });
});

describe("rankRefactorCandidates", () => {
  const nodes: GraphNode[] = [node("H", "module"), node("H#h", "function", { parentId: "H" })];
  const edges: GraphEdge[] = [];
  for (let i = 0; i < 5; i += 1) {
    nodes.push(node(`C${i}`, "module"), node(`C${i}#c`, "function", { parentId: `C${i}` }));
    nodes.push(node(`E${i}`, "module"), node(`E${i}#e`, "function", { parentId: `E${i}` }));
    edges.push(edge(`C${i}#c`, "H#h"), edge("H#h", `E${i}#e`));
  }

  it("ranks the god-module hub first, from a Map or an array", () => {
    const metrics = computeCompositionMetrics(nodes, edges);
    expect(rankRefactorCandidates(metrics)[0].id).toBe("H");
    expect(rankRefactorCandidates([...metrics.values()])[0].id).toBe("H");
  });
});
