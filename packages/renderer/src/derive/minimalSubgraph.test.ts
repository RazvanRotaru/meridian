/**
 * The minimal subgraph the overlay grows: a SEED (the only permanent node) + its always-shown 1-hop
 * ring as GHOST nodes, a single [+n] stub on any node with hidden neighbours, further GHOST nodes
 * revealed by an expansion, and the collapsed containment frame. Import wires connect any two visible files.
 */

import { describe, expect, it } from "vitest";
import type { GraphArtifact, GraphEdge, GraphNode } from "@meridian/core";
import { buildGraphIndex } from "../graph/graphIndex";
import { buildModuleGraph } from "./moduleGraph";
import type { ModuleCardData } from "./moduleLevel";
import { buildMinimalSubgraph, type MinimalStubData, type MinimalSubgraphNode } from "./minimalSubgraph";

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

function build(nodes: GraphNode[], edges: GraphEdge[], seeds: string[], kept: string[] = [], expanded: string[] = [], onMap?: string[]) {
  const index = buildGraphIndex({ nodes, edges } as unknown as GraphArtifact);
  // Default onMap to every module node in the fixture, so the auto 1-hop ring behaves as if the whole
  // fixture was on the Module map. Callers pass an explicit subset to exercise the on-map restriction.
  const onMapIds = new Set(onMap ?? nodes.filter((node) => node.kind === "module").map((node) => node.id));
  return buildMinimalSubgraph(index, buildModuleGraph(index), new Set(seeds), new Set(kept), expanded, onMapIds);
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
  it("shows a seed (the only permanent node) with its full 1-hop ring as ghosts", () => {
    const { nodes } = build(NODES, EDGES, ["m:a"]);
    expect(nodeById(nodes, "m:a")?.tier).toBe("seed");
    expect(nodeById(nodes, "m:b")?.tier).toBe("ghost"); // a imports b
    expect(nodeById(nodes, "m:e")?.tier).toBe("ghost"); // e imports a
    expect(nodeById(nodes, "m:c")).toBeUndefined(); // 2 hops out, not shown
  });

  it("restricts the seed's auto 1-hop ring to neighbours that were on the Module map", () => {
    // Only a and b were on the map; e imports a but is off-map, so it must not auto-show.
    const { nodes } = build(NODES, EDGES, ["m:a"], [], [], ["m:a", "m:b"]);
    expect(nodeById(nodes, "m:b")?.tier).toBe("ghost"); // on-map neighbour still shown
    expect(nodeById(nodes, "m:e")).toBeUndefined(); // off-map neighbour excluded from the auto ring
  });

  it("puts one [+n] stub on a node with hidden neighbours, none where all are shown", () => {
    const { nodes } = build(NODES, EDGES, ["m:a"]);
    // b's import of c is hidden → one stub with count 1 (b's importer a is already shown).
    expect((nodeById(nodes, "stub:m:b")?.data as MinimalStubData).count).toBe(1);
    // a's and e's whole 1-hop is shown → no stubs on them.
    expect(nodeById(nodes, "stub:m:a")).toBeUndefined();
    expect(nodeById(nodes, "stub:m:e")).toBeUndefined();
  });

  it("draws import wires only between two visible files", () => {
    const { edges } = build(NODES, EDGES, ["m:a"]);
    const imports = edges.filter((edge) => edge.kind === "import").map((edge) => edge.id);
    expect(imports).toContain("min:m:e->m:a");
    expect(imports).toContain("min:m:a->m:b");
    expect(imports).not.toContain("min:m:b->m:c"); // c is not visible
  });

  it("flags an import wire crossPackage when its two files sit in different package frames", () => {
    // a lives in p:src, x lives in a sibling package p:lib; a imports x → a cross-package wire.
    const nodes = [
      pkg("p:root", "root", null),
      pkg("p:src", "src", "p:root"),
      pkg("p:lib", "lib", "p:root"),
      mod("m:a", "src/a.ts", "p:src"),
      mod("m:x", "lib/x.ts", "p:lib"),
    ];
    const edges = [importEdge("m:a", "m:x")];
    const built = build(nodes, edges, ["m:a"]);
    const cross = built.edges.find((edge) => edge.id === "min:m:a->m:x");
    expect(cross?.crossPackage).toBe(true);
  });

  it("leaves a same-package import wire's crossPackage false", () => {
    // All fixture files live in p:src, so a→b is same-package.
    const { edges } = build(NODES, EDGES, ["m:a"]);
    const same = edges.find((edge) => edge.id === "min:m:a->m:b");
    expect(same?.crossPackage).toBe(false);
  });

  it("reveals an expansion's neighbours as ghosts, one hop past the frontier", () => {
    const { nodes } = build(NODES, EDGES, ["m:a"], [], ["m:b"]);
    expect(nodeById(nodes, "m:c")?.tier).toBe("ghost"); // b's hidden neighbour, revealed
    expect(nodeById(nodes, "m:d")).toBeUndefined(); // still one hop further
    // The freshly-revealed ghost carries its own stub.
    expect((nodeById(nodes, "stub:m:c")?.data as MinimalStubData).count).toBe(1);
  });

  it("renders a drilled-through ghost as persistent (kept), its neighbour as the new ghost", () => {
    const { nodes } = build(NODES, EDGES, ["m:a"], ["m:c"], ["m:b", "m:c"]);
    expect(nodeById(nodes, "m:c")?.tier).toBe("persistent"); // committed by drilling through it
    expect(nodeById(nodes, "m:d")?.tier).toBe("ghost"); // c's newly-revealed neighbour
  });

  it("reveals a file's hidden importer AND importee in one expansion (both directions at once)", () => {
    // s → f, u → f, f → w: seeding s shows only f (its lone import). f then has a hidden importer (u)
    // and a hidden importee (w) — one stub, count 2 — and expanding f reveals BOTH.
    const nodes = [
      pkg("p:root", "root", null),
      pkg("p:src", "src", "p:root"),
      mod("m:s", "src/s.ts", "p:src"),
      mod("m:f", "src/f.ts", "p:src"),
      mod("m:u", "src/u.ts", "p:src"),
      mod("m:w", "src/w.ts", "p:src"),
    ];
    const edges = [importEdge("m:s", "m:f"), importEdge("m:u", "m:f"), importEdge("m:f", "m:w")];
    expect((nodeById(build(nodes, edges, ["m:s"]).nodes, "stub:m:f")?.data as MinimalStubData).count).toBe(2);
    const expanded = build(nodes, edges, ["m:s"], [], ["m:f"]);
    expect(nodeById(expanded.nodes, "m:u")?.tier).toBe("ghost"); // hidden importer, revealed
    expect(nodeById(expanded.nodes, "m:w")?.tier).toBe("ghost"); // hidden importee, revealed
  });

  it("resets to the seed base when there are no expansions", () => {
    const { nodes } = build(NODES, EDGES, ["m:a"]);
    const files = nodes.filter((node) => node.kind === "file").map((node) => node.id).sort();
    expect(files).toEqual(["m:a", "m:b", "m:e"]);
  });

  it("nests visible files under a collapsed containment frame", () => {
    const { nodes } = build(NODES, EDGES, ["m:a"]);
    const frame = nodes.find((node) => node.kind === "group");
    expect(frame?.collapsedLabel).toBe("root/src");
    expect(nodeById(nodes, "m:a")?.parentId).toBe(frame?.id);
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
  return buildMinimalSubgraph(index, graph, new Set(["m:a"]), new Set(), [], onMapIds, {
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
