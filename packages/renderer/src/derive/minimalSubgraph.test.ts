/**
 * The minimal subgraph the overlay EXTRACTS: the member working set (any kind — a selected package
 * stays ONE card) plus its on-map 1-hop import ring as GHOST nodes. Origin members render seed-tier,
 * promoted members persistent, ghosts ghost-tier. Import wires connect any two visible boxes.
 */

import { describe, expect, it } from "vitest";
import type { GraphArtifact, GraphEdge, GraphNode } from "@meridian/core";
import { buildGraphIndex } from "../graph/graphIndex";
import { buildModuleGraph } from "./moduleGraph";
import type { ModuleCardData } from "./moduleLevel";
import { buildMinimalSubgraph, type MinimalSubgraphNode } from "./minimalSubgraph";

function pkg(id: string, name: string, parentId: string | null): GraphNode {
  return { id, kind: "package", qualifiedName: id, displayName: name, parentId, location: { file: name, startLine: 1 } } as GraphNode;
}

function mod(id: string, file: string, parentId: string | null): GraphNode {
  return { id, kind: "module", qualifiedName: id, displayName: id, parentId, location: { file, startLine: 1 } } as GraphNode;
}

function fn(id: string, name: string, parentId: string): GraphNode {
  return { id, kind: "function", qualifiedName: id, displayName: name, parentId, location: { file: name, startLine: 1 } } as GraphNode;
}

function importEdge(source: string, target: string): GraphEdge {
  return { id: `imports:${source}->${target}`, source, target, kind: "imports", resolution: "resolved" } as GraphEdge;
}

/** members default to origin; onMap defaults to every module in the fixture (as if the whole map was
 * on screen). Pass explicit args to exercise promotion (members ⊋ origin) and the on-map restriction. */
function build(nodes: GraphNode[], edges: GraphEdge[], members: string[], origin: string[] = members, onMap?: string[]) {
  const index = buildGraphIndex({ nodes, edges } as unknown as GraphArtifact);
  const onMapIds = new Set(onMap ?? nodes.filter((node) => node.kind === "module").map((node) => node.id));
  return buildMinimalSubgraph(index, buildModuleGraph(index), new Set(members), new Set(origin), onMapIds);
}

function nodeById(nodes: MinimalSubgraphNode[], id: string): MinimalSubgraphNode | undefined {
  return nodes.find((node) => node.id === id);
}

// a → b → c → d, and e → a. (source imports target.)
const NODES = [
  pkg("p:root", "root", null),
  pkg("p:src", "src", "p:root"),
  mod("m:a", "src/a.ts", "p:src"),
  mod("m:b", "src/b.ts", "p:src"),
  mod("m:c", "src/c.ts", "p:src"),
  mod("m:d", "src/d.ts", "p:src"),
  mod("m:e", "src/e.ts", "p:src"),
];
const EDGES = [importEdge("m:a", "m:b"), importEdge("m:b", "m:c"), importEdge("m:c", "m:d"), importEdge("m:e", "m:a")];

describe("buildMinimalSubgraph", () => {
  it("extracts a single file member with its full on-map 1-hop ring as ghosts", () => {
    const { nodes } = build(NODES, EDGES, ["m:a"]);
    expect(nodeById(nodes, "m:a")?.tier).toBe("seed");
    expect(nodeById(nodes, "m:b")?.tier).toBe("ghost"); // a imports b
    expect(nodeById(nodes, "m:e")?.tier).toBe("ghost"); // e imports a
    expect(nodeById(nodes, "m:c")).toBeUndefined(); // 2 hops out, not shown
  });

  it("restricts the ghost ring to neighbours that were on the Module map", () => {
    // Only a and b were on the map; e imports a but is off-map, so it must not show as a ghost.
    const { nodes } = build(NODES, EDGES, ["m:a"], ["m:a"], ["m:a", "m:b"]);
    expect(nodeById(nodes, "m:b")?.tier).toBe("ghost"); // on-map neighbour still shown
    expect(nodeById(nodes, "m:e")).toBeUndefined(); // off-map neighbour excluded from the ring
  });

  it("draws import wires only between two visible boxes", () => {
    const { edges } = build(NODES, EDGES, ["m:a"]);
    const imports = edges.filter((edge) => edge.kind === "import").map((edge) => edge.id);
    expect(imports).toContain("min:m:e->m:a");
    expect(imports).toContain("min:m:a->m:b");
    expect(imports).not.toContain("min:m:b->m:c"); // c is not visible
  });

  it("renders a promoted member (in members, not origin) persistent, its new neighbour a ghost", () => {
    // b was promoted from a ghost: members = {a, b}, origin = {a}. c is now b's newly-revealed ghost.
    const { nodes } = build(NODES, EDGES, ["m:a", "m:b"], ["m:a"]);
    expect(nodeById(nodes, "m:a")?.tier).toBe("seed");
    expect(nodeById(nodes, "m:b")?.tier).toBe("persistent");
    expect(nodeById(nodes, "m:c")?.tier).toBe("ghost"); // reached one hop past the original ring
  });

  it("nests visible file members under a collapsed containment frame", () => {
    const { nodes } = build(NODES, EDGES, ["m:a"]);
    const frame = nodes.find((node) => node.kind === "group" && node.tier === null);
    expect(frame?.collapsedLabel).toBe("root/src");
    expect(nodeById(nodes, "m:a")?.parentId).toBe(frame?.id);
  });
});

// a lives in p:src, x lives in a sibling package p:lib; a imports x.
const CROSS_NODES = [
  pkg("p:root", "root", null),
  pkg("p:src", "src", "p:root"),
  pkg("p:lib", "lib", "p:root"),
  mod("m:a", "src/a.ts", "p:src"),
  mod("m:x", "lib/x.ts", "p:lib"),
];
const CROSS_EDGES = [importEdge("m:a", "m:x")];

describe("buildMinimalSubgraph — group members and cross-package wires", () => {
  it("flags an import wire crossPackage when its two files sit in different package frames", () => {
    const cross = build(CROSS_NODES, CROSS_EDGES, ["m:a"]).edges.find((edge) => edge.id === "min:m:a->m:x");
    expect(cross?.crossPackage).toBe(true);
  });

  it("leaves a same-package import wire's crossPackage false", () => {
    const same = build(NODES, EDGES, ["m:a"]).edges.find((edge) => edge.id === "min:m:a->m:b");
    expect(same?.crossPackage).toBe(false);
  });

  it("extracts a selected PACKAGE as ONE leaf card, never a frame of its files", () => {
    // p:src selected; its files stay folded onto the one card (no m:a/m:b file cards for it).
    const { nodes } = build(CROSS_NODES, CROSS_EDGES, ["p:src"], ["p:src"], ["m:x"]);
    const card = nodeById(nodes, "p:src");
    expect(card?.kind).toBe("group");
    expect(card?.tier).toBe("seed"); // a leaf card carries a tier (a frame would be null)
    expect(card?.parentId).toBeNull(); // flat, not nested in a p:root frame
    expect(nodeById(nodes, "m:a")).toBeUndefined(); // its files are NOT decomposed
  });

  it("gives a group member a lifted ghost ring: its files' outside imports show as on-map boxes", () => {
    // p:src's file a imports x. With only m:x on the map, x shows as a file ghost; the wire lifts to p:src.
    const fileGhost = build(CROSS_NODES, CROSS_EDGES, ["p:src"], ["p:src"], ["m:x"]);
    expect(nodeById(fileGhost.nodes, "m:x")?.tier).toBe("ghost");
    expect(fileGhost.edges.find((edge) => edge.id === "min:p:src->m:x")?.crossPackage).toBe(true);
    // With only the package p:lib on the map, the same neighbour lifts to a package GHOST card instead.
    const pkgGhost = build(CROSS_NODES, CROSS_EDGES, ["p:src"], ["p:src"], ["p:lib"]);
    const ghostCard = nodeById(pkgGhost.nodes, "p:lib");
    expect(ghostCard?.kind).toBe("group");
    expect(ghostCard?.tier).toBe("ghost");
  });
});

// foo()/bar() live in a.ts, baz() in b.ts, qux() in c.ts; imports run a → b → c, so with member a the
// overlay shows a + b and keeps c two hops out (off the overlay).
const DEP_NODES = [
  pkg("p:root", "root", null),
  pkg("p:src", "src", "p:root"),
  mod("m:a", "src/a.ts", "p:src"),
  mod("m:b", "src/b.ts", "p:src"),
  mod("m:c", "src/c.ts", "p:src"),
  fn("fn:foo", "foo", "m:a"),
  fn("fn:bar", "bar", "m:a"),
  fn("fn:baz", "baz", "m:b"),
  fn("fn:qux", "qux", "m:c"),
];
const DEP_IMPORTS = [importEdge("m:a", "m:b"), importEdge("m:b", "m:c")];

function callsEdge(source: string, target: string): GraphEdge {
  return { id: `calls:${source}->${target}`, source, target, kind: "calls", resolution: "resolved" } as GraphEdge;
}

function buildWithCoupling(coupling: GraphEdge[]) {
  const index = buildGraphIndex({ nodes: DEP_NODES, edges: DEP_IMPORTS } as unknown as GraphArtifact);
  const onMapIds = new Set(DEP_NODES.filter((node) => node.kind === "module").map((node) => node.id));
  return buildMinimalSubgraph(index, buildModuleGraph(index), new Set(["m:a"]), new Set(["m:a"]), onMapIds, {
    expanded: new Set(),
    blockDeps: { edges: coupling },
    flows: {},
  });
}

describe("buildMinimalSubgraph — per-kind dep wires between visible files", () => {
  it("lifts a cross-file coupling to a per-kind dep wire, alongside the pair's import wire", () => {
    const { edges } = buildWithCoupling([callsEdge("fn:foo", "fn:baz")]);
    const dep = edges.find((edge) => edge.kind === "dep");
    expect(dep).toMatchObject({ id: "dep:calls:m:a->m:b", source: "m:a", target: "m:b", depKind: "calls", weight: 1 });
    // The import wire is still minted here — the paint's suppressRedundantImports hides it, like the Map.
    expect(edges.map((edge) => edge.id)).toContain("min:m:a->m:b");
  });

  it("mints nothing for a coupling whose target file is not on the overlay", () => {
    const { edges } = buildWithCoupling([callsEdge("fn:foo", "fn:qux")]);
    expect(edges.filter((edge) => edge.kind === "dep")).toEqual([]);
  });

  it("mints no self-wire for an intra-file coupling", () => {
    const { edges } = buildWithCoupling([callsEdge("fn:foo", "fn:bar")]);
    expect(edges.filter((edge) => edge.kind === "dep")).toEqual([]);
  });
});

// a.ts declares foo() and bar() and imports b.ts — so a's card is an expandable container.
const CODE_NODES = [
  pkg("p:root", "root", null),
  pkg("p:src", "src", "p:root"),
  mod("m:a", "src/a.ts", "p:src"),
  mod("m:b", "src/b.ts", "p:src"),
  fn("fn:foo", "foo", "m:a"),
  fn("fn:bar", "bar", "m:a"),
];
const CODE_EDGES = [importEdge("m:a", "m:b")];

function buildExpanded(expandedIds: string[]) {
  const index = buildGraphIndex({ nodes: CODE_NODES, edges: CODE_EDGES } as unknown as GraphArtifact);
  const graph = buildModuleGraph(index);
  const onMapIds = new Set(CODE_NODES.filter((node) => node.kind === "module").map((node) => node.id));
  return buildMinimalSubgraph(index, graph, new Set(["m:a"]), new Set(["m:a"]), onMapIds, {
    expanded: new Set(expandedIds),
    blockDeps: { edges: [] },
    flows: {},
  });
}

describe("buildMinimalSubgraph — in-place file expansion", () => {
  it("marks a file that declares code as an expandable container", () => {
    const data = nodeById(buildExpanded([]).nodes, "m:a")?.data as ModuleCardData;
    expect(data.isContainer).toBe(true);
    expect(data.unitCount).toBe(2);
    expect(data.isExpanded).toBe(false);
  });

  it("yields an expanded file's declarations as nested nodes parented to the file", () => {
    const spec = buildExpanded(["m:a"]);
    expect((nodeById(spec.nodes, "m:a")?.data as ModuleCardData).isExpanded).toBe(true);
    const expansion = spec.expansions.find((exp) => exp.fileId === "m:a");
    expect(expansion?.nodes[0].id).toBe("m:a"); // the frame node leads (parents before children)
    expect(expansion?.nodes.find((node) => node.id === "fn:foo")?.parentId).toBe("m:a");
    expect(expansion?.nodes.find((node) => node.id === "fn:bar")?.parentId).toBe("m:a");
  });

  it("drops the nested children when the file collapses again", () => {
    expect(buildExpanded(["m:a"]).expansions).toHaveLength(1);
    expect(buildExpanded([]).expansions).toHaveLength(0);
  });
});
