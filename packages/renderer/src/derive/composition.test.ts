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

  it("splits two disconnected call clusters into 2 components without tripping the SPLIT gate", () => {
    const c = metricOf(fragmented, fragmentedEdges, "ts:m#C");
    expect(c.lcomComponents).toBe(2);
    expect(c.cohesion).toBe(0.67); // 1 − (2 − 1) / (4 − 1)
    expect(c.smells).not.toContain("low-cohesion"); // 4 members / 2 components sits below the 8 / 3 gate
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

  it("excludes the constructor from the LCOM graph, so it cannot glue unrelated clusters", () => {
    // The ctor calls into both clusters — with it counted, everything would collapse to 1 component.
    const nodes = [...fragmented, node("ts:m#C.ctor", "method", { parentId: "ts:m#C", displayName: "constructor" })];
    const edges = [...fragmentedEdges, edge("ts:m#C.ctor", "ts:m#C.m1"), edge("ts:m#C.ctor", "ts:m#C.m3")];
    const c = metricOf(nodes, edges, "ts:m#C");
    expect(c.lcomComponents).toBe(2);
    expect(c.cohesion).toBe(0.67); // denominator is the 4 FILTERED members, matching the components
    expect(c.members).toBe(5); // the displayed size still counts every callable, ctor included
  });

  it("excludes accessor-tagged members from the LCOM graph and the cohesion denominator", () => {
    const nodes = [
      ...fragmented,
      node("ts:m#C.g", "method", { parentId: "ts:m#C", tags: ["get"] }),
      node("ts:m#C.p", "method", { parentId: "ts:m#C", tags: ["property"] }),
    ];
    const c = metricOf(nodes, fragmentedEdges, "ts:m#C");
    expect(c.lcomComponents).toBe(2); // the two accessors would otherwise be 2 extra singletons
    expect(c.cohesion).toBe(0.67);
    expect(c.members).toBe(6);
  });
});

describe("low-cohesion (SPLIT) regate", () => {
  // A class of `memberCount` methods forming disconnected pairs: m0→m1, m2→m3, … (odd leftover
  // member stays a singleton), so components = ceil(memberCount / 2).
  function fragmentedClass(memberCount: number): { nodes: GraphNode[]; edges: GraphEdge[] } {
    const nodes = [node("ts:m#C", "class")];
    const edges: GraphEdge[] = [];
    for (let i = 0; i < memberCount; i += 1) {
      nodes.push(node(`ts:m#C.m${i}`, "method", { parentId: "ts:m#C" }));
      if (i % 2 === 1) {
        edges.push(edge(`ts:m#C.m${i - 1}`, `ts:m#C.m${i}`));
      }
    }
    return { nodes, edges };
  }

  it("fires with 8 members in 4 components (≥ 8 members and ≥ 3 components)", () => {
    const { nodes, edges } = fragmentedClass(8);
    const c = metricOf(nodes, edges, "ts:m#C");
    expect(c.lcomComponents).toBe(4);
    expect(c.smells).toContain("low-cohesion");
  });

  it("does not fire with 7 members even in 4 components (member gate)", () => {
    const { nodes, edges } = fragmentedClass(7);
    const c = metricOf(nodes, edges, "ts:m#C");
    expect(c.lcomComponents).toBe(4);
    expect(c.smells).not.toContain("low-cohesion");
  });

  it("does not fire with 8 members in only 2 components (component gate)", () => {
    const { nodes, edges } = fragmentedClass(8);
    // Chain the pairs into two clusters of 4: {m0..m3} and {m4..m7}.
    edges.push(edge("ts:m#C.m1", "ts:m#C.m2"), edge("ts:m#C.m5", "ts:m#C.m6"));
    const c = metricOf(nodes, edges, "ts:m#C");
    expect(c.lcomComponents).toBe(2);
    expect(c.smells).not.toContain("low-cohesion");
  });

  it("gates on the FILTERED member count: 8 callables where 1 is a constructor do not fire", () => {
    const { nodes, edges } = fragmentedClass(7);
    nodes.push(node("ts:m#C.ctor", "method", { parentId: "ts:m#C", displayName: "constructor" }));
    const c = metricOf(nodes, edges, "ts:m#C");
    expect(c.members).toBe(8);
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

  it("does not fire low-cohesion below the member threshold even when fragmented", () => {
    const nodes = [
      node("ts:m#C", "class"),
      node("ts:m#C.m1", "method", { parentId: "ts:m#C" }),
      node("ts:m#C.m2", "method", { parentId: "ts:m#C" }),
      node("ts:m#C.m3", "method", { parentId: "ts:m#C" }),
    ]; // 3 members, no internal calls → 3 components, but members < 8
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

describe("dependency-cycle smell", () => {
  // Standalone modules whose top-level functions call each other — one unit per module.
  function moduleWeb(links: Array<[string, string]>): { nodes: GraphNode[]; edges: GraphEdge[] } {
    const ids = new Set(links.flat());
    const nodes = [...ids].flatMap((id) => [node(id, "module"), node(`${id}#f`, "function", { parentId: id })]);
    const edges = links.map(([source, target]) => edge(`${source}#f`, `${target}#f`));
    return { nodes, edges };
  }

  it("flags both units of a 2-unit cycle with each other as cyclePeers", () => {
    const { nodes, edges } = moduleWeb([["ts:a", "ts:b"], ["ts:b", "ts:a"]]);
    const a = metricOf(nodes, edges, "ts:a");
    const b = metricOf(nodes, edges, "ts:b");
    expect(a.smells).toContain("dependency-cycle");
    expect(b.smells).toContain("dependency-cycle");
    expect(a.cyclePeers).toEqual(["ts:b"]);
    expect(b.cyclePeers).toEqual(["ts:a"]);
  });

  it("flags all three units of a 3-unit cycle and lists both peers, sorted", () => {
    const { nodes, edges } = moduleWeb([["ts:a", "ts:b"], ["ts:b", "ts:c"], ["ts:c", "ts:a"]]);
    for (const id of ["ts:a", "ts:b", "ts:c"]) {
      expect(metricOf(nodes, edges, id).smells).toContain("dependency-cycle");
    }
    expect(metricOf(nodes, edges, "ts:a").cyclePeers).toEqual(["ts:b", "ts:c"]);
  });

  it("does not flag any unit of an acyclic chain", () => {
    const { nodes, edges } = moduleWeb([["ts:a", "ts:b"], ["ts:b", "ts:c"]]);
    for (const id of ["ts:a", "ts:b", "ts:c"]) {
      const metric = metricOf(nodes, edges, id);
      expect(metric.smells).not.toContain("dependency-cycle");
      expect(metric.cyclePeers).toEqual([]);
    }
  });

  it("keeps a unit outside the cycle clean even when it feeds into one", () => {
    const { nodes, edges } = moduleWeb([["ts:x", "ts:a"], ["ts:a", "ts:b"], ["ts:b", "ts:a"]]);
    expect(metricOf(nodes, edges, "ts:x").smells).not.toContain("dependency-cycle");
    expect(metricOf(nodes, edges, "ts:a").cyclePeers).toEqual(["ts:b"]);
  });
});

describe("SDP violations", () => {
  // A: Ca 3 (x1..x3), Ce 3 (b, c, d) → I = 0.5. Targets: b (I = 2/3), c (I = 0), d (I = 0.8) —
  // two of them are MORE unstable than A, so A leans on shifting ground twice.
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  for (const id of ["A", "B", "C", "D", "X1", "X2", "X3", "L1", "L2", "L3", "L4", "L5", "L6"]) {
    nodes.push(node(id, "module"), node(`${id}#f`, "function", { parentId: id }));
  }
  for (const feeder of ["X1", "X2", "X3"]) {
    edges.push(edge(`${feeder}#f`, "A#f"));
  }
  edges.push(edge("A#f", "B#f"), edge("A#f", "C#f"), edge("A#f", "D#f"));
  edges.push(edge("B#f", "L1#f"), edge("B#f", "L2#f"));
  edges.push(edge("D#f", "L3#f"), edge("D#f", "L4#f"), edge("D#f", "L5#f"), edge("D#f", "L6#f"));

  it("counts only the efferent targets strictly more unstable than the unit itself", () => {
    const a = metricOf(nodes, edges, "A");
    expect(a.instability).toBe(0.5);
    expect(a.sdpViolations).toBe(2); // B and D, not the fully stable C
  });

  it("is 0 for a unit whose dependencies are all at least as stable", () => {
    expect(metricOf(nodes, edges, "B").sdpViolations).toBe(0); // leaves have I = 0
    expect(metricOf(nodes, edges, "C").sdpViolations).toBe(0); // no efferent at all
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

  it("ranks a dependency-cycle unit above the god-module hub", () => {
    const withCycle = [
      ...nodes,
      node("CY1", "module"), node("CY1#f", "function", { parentId: "CY1" }),
      node("CY2", "module"), node("CY2#f", "function", { parentId: "CY2" }),
    ];
    const cycleEdges = [...edges, edge("CY1#f", "CY2#f"), edge("CY2#f", "CY1#f")];
    const ranked = rankRefactorCandidates(computeCompositionMetrics(withCycle, cycleEdges));
    expect(ranked[0].smells).toContain("dependency-cycle");
    expect(ranked[1].smells).toContain("dependency-cycle");
    expect(ranked[2].id).toBe("H");
  });

  describe("churn weighting", () => {
    // The cycle pair (severity 5) outranks the hub (severity 4) statically; heavy churn on the
    // hub multiplies its severity past them (4 × (1 + min(20, 20) / 10) = 12 > 5).
    const withCycle = [
      ...nodes,
      node("CY1", "module"), node("CY1#f", "function", { parentId: "CY1" }),
      node("CY2", "module"), node("CY2#f", "function", { parentId: "CY2" }),
    ];
    const cycleEdges = [...edges, edge("CY1#f", "CY2#f"), edge("CY2#f", "CY1#f")];
    const metrics = computeCompositionMetrics(withCycle, cycleEdges);

    it("multiplies severity by churn, promoting a hot smelly unit", () => {
      const ranked = rankRefactorCandidates(metrics, new Map([["H", 20]]));
      expect(ranked[0].id).toBe("H");
    });

    it("caps the churn multiplier, so runaway churn cannot grow past 3x", () => {
      // At 5 × 3 = 15 the capped cycle units retake the hub's 12 despite 10× more raw churn.
      const ranked = rankRefactorCandidates(metrics, new Map([["H", 20], ["CY1", 200], ["CY2", 200]]));
      expect(ranked[0].smells).toContain("dependency-cycle");
      expect(ranked[2].id).toBe("H");
    });

    it("leaves the ranking unchanged when no churn map is given", () => {
      const bare = rankRefactorCandidates(metrics).map((unit) => unit.id);
      const empty = rankRefactorCandidates(metrics, new Map()).map((unit) => unit.id);
      expect(empty).toEqual(bare);
      expect(bare[0]).not.toBe("H");
    });

    it("cannot promote a smell-free unit — zero severity times anything stays zero", () => {
      const ranked = rankRefactorCandidates(metrics, new Map([["C0", 100]]));
      expect(ranked[0].id).not.toBe("C0");
      expect(ranked[ranked.length - 1].smells).toEqual([]);
    });
  });
});
