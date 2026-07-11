/**
 * The minimal subgraph the overlay EXTRACTS: the member working set (any kind — a selected package
 * stays ONE card) ringed by the Map's OWN ghost projection — off-member couplings chart as symbol
 * satellites at their exact semantic endpoints, never as peer boxes. Origin members render
 * seed-tier, promoted members persistent. Import/dep wires connect member boxes.
 */

import { describe, expect, it } from "vitest";
import type { GraphArtifact, GraphEdge, GraphNode } from "@meridian/core";
import { buildGraphIndex } from "../graph/graphIndex";
import { buildModuleGraph } from "./moduleGraph";
import type { ModuleCardData } from "./moduleLevel";
import type { GhostData } from "./ghostDeps";
import { buildMinimalSubgraph, type MinimalSubgraphNode } from "./minimalSubgraph";

function pkg(id: string, name: string, parentId: string | null): GraphNode {
  return { id, kind: "package", qualifiedName: id, displayName: name, parentId, location: { file: name, startLine: 1 } } as GraphNode;
}

function npmPkg(id: string, name: string, parentId: string | null): GraphNode {
  return { ...pkg(id, name, parentId), tags: ["npm-package"] } as GraphNode;
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

function callsEdge(source: string, target: string): GraphEdge {
  return { id: `calls:${source}->${target}`, source, target, kind: "calls", resolution: "resolved" } as GraphEdge;
}

/** members default to origin; `coupling` feeds the blockDeps substrate the ghost projection reads. */
function build(nodes: GraphNode[], edges: GraphEdge[], members: string[], origin: string[] = members, coupling: GraphEdge[] = []) {
  const index = buildGraphIndex({ nodes, edges: [...edges, ...coupling] } as unknown as GraphArtifact);
  return buildMinimalSubgraph(index, buildModuleGraph(index), new Set(members), new Set(origin), {
    expanded: new Set(),
    blockDeps: { edges: coupling },
    flows: {},
  });
}

function nodeById(nodes: MinimalSubgraphNode[], id: string): MinimalSubgraphNode | undefined {
  return nodes.find((node) => node.id === id);
}

// a → b → c → d, and e → a (source imports target); foo()/bar() in a, baz() in b, qux() in c.
const NODES = [
  npmPkg("p:root", "root", null),
  pkg("p:src", "src", "p:root"),
  mod("m:a", "src/a.ts", "p:src"),
  mod("m:b", "src/b.ts", "p:src"),
  mod("m:c", "src/c.ts", "p:src"),
  mod("m:d", "src/d.ts", "p:src"),
  mod("m:e", "src/e.ts", "p:src"),
  fn("fn:foo", "foo", "m:a"),
  fn("fn:bar", "bar", "m:a"),
  fn("fn:baz", "baz", "m:b"),
  fn("fn:qux", "qux", "m:c"),
];
const EDGES = [importEdge("m:a", "m:b"), importEdge("m:b", "m:c"), importEdge("m:c", "m:d"), importEdge("m:e", "m:a")];

describe("buildMinimalSubgraph", () => {
  it("extracts members only — an import neighbour never joins as a peer box", () => {
    const { nodes } = build(NODES, EDGES, ["m:a"]);
    expect(nodeById(nodes, "m:a")?.tier).toBe("seed");
    expect(nodeById(nodes, "m:b")).toBeUndefined(); // a imports b, but only couplings ghost
    expect(nodeById(nodes, "m:e")).toBeUndefined(); // e imports a — same
  });

  it("charts an off-member coupling as a symbol SATELLITE, wired per coupling kind", () => {
    const { nodes, edges } = build(NODES, EDGES, ["m:a"], ["m:a"], [callsEdge("fn:foo", "fn:baz")]);
    const satellite = nodeById(nodes, "fn:baz");
    expect(satellite?.kind).toBe("ghost");
    expect(satellite?.tier).toBeNull();
    expect((satellite?.data as GhostData).ghostKind).toBe("function");
    expect(edges.find((edge) => edge.ghost === true)).toMatchObject({
      id: "gdep:calls:m:a->fn:baz",
      source: "m:a",
      target: "fn:baz",
      depKind: "calls",
      weight: 1,
      crossFrame: false,
      crossPackage: false,
      outsideView: true,
      underlyingEdgeIds: ["calls:fn:foo->fn:baz"],
    });
  });

  it("keeps a same-folder pair as separate semantic satellites", () => {
    const coupling = [callsEdge("fn:foo", "fn:baz"), callsEdge("fn:bar", "fn:qux")]; // homes m:b + m:c, both under p:src
    const { nodes, edges } = build(NODES, EDGES, ["m:a"], ["m:a"], coupling);
    expect(nodeById(nodes, "fn:baz")?.kind).toBe("ghost");
    expect(nodeById(nodes, "fn:qux")?.kind).toBe("ghost");
    expect(nodes.filter((node) => node.kind === "ghost").map((node) => node.id).sort()).toEqual(["fn:baz", "fn:qux"]);
    expect(edges.filter((edge) => edge.ghost === true).map((edge) => edge.id).sort()).toEqual([
      "gdep:calls:m:a->fn:baz",
      "gdep:calls:m:a->fn:qux",
    ]);
  });

  it("keeps every semantic ghost beyond the former twenty-item evidence window", () => {
    const targets = Array.from({ length: 23 }, (_, index) => {
      const fileId = `m:peer-${index}`;
      const functionId = `fn:peer-${index}`;
      return {
        nodes: [mod(fileId, `src/peer-${index}.ts`, "p:src"), fn(functionId, `peer${index}`, fileId)],
        edge: callsEdge("fn:foo", functionId),
      };
    });
    const coupling = targets.map(({ edge }) => edge);
    const { nodes, edges } = build(
      [...NODES, ...targets.flatMap(({ nodes: peerNodes }) => peerNodes)],
      EDGES,
      ["m:a"],
      ["m:a"],
      coupling,
    );
    const ghosts = nodes.filter((node) => node.kind === "ghost");
    const ghostWires = edges.filter((edge) => edge.ghost === true);

    expect(ghosts).toHaveLength(23);
    expect(ghosts.every((node) => (node.data as GhostData).ghostKind === "function")).toBe(true);
    expect(ghostWires).toHaveLength(23);
    expect(ghostWires.every((edge) => edge.underlyingEdgeIds?.length === 1)).toBe(true);
  });

  it("draws import wires only between two member boxes", () => {
    const { edges } = build(NODES, EDGES, ["m:a", "m:b"]);
    const imports = edges.filter((edge) => edge.kind === "import").map((edge) => edge.id);
    expect(imports).toContain("min:m:a->m:b");
    expect(imports).not.toContain("min:m:b->m:c"); // c is not a member
    expect(imports).not.toContain("min:m:e->m:a"); // e is not a member
  });

  it("renders a promoted member (in members, not origin) persistent", () => {
    const { nodes } = build(NODES, EDGES, ["m:a", "m:b"], ["m:a"]);
    expect(nodeById(nodes, "m:a")?.tier).toBe("seed");
    expect(nodeById(nodes, "m:b")?.tier).toBe("persistent");
  });

  it("nests member files under a collapsed containment frame", () => {
    const { nodes } = build(NODES, EDGES, ["m:a"]);
    const frame = nodes.find((node) => node.kind === "group" && node.tier === null);
    expect(frame?.collapsedLabel).toBe("root/src");
    expect(nodeById(nodes, "m:a")?.parentId).toBe(frame?.id);
  });
});

// a lives in p:src, x lives in a sibling package p:lib; a imports x; a1() in a calls x1() in x.
const CROSS_NODES = [
  npmPkg("p:root", "root", null),
  pkg("p:src", "src", "p:root"),
  pkg("p:lib", "lib", "p:root"),
  mod("m:a", "src/a.ts", "p:src"),
  mod("m:x", "lib/x.ts", "p:lib"),
  fn("fn:a1", "a1", "m:a"),
  fn("fn:x1", "x1", "m:x"),
];
const CROSS_EDGES = [importEdge("m:a", "m:x")];

// Two package.json-backed siblings under one workspace container: the original a→x endpoints really
// do cross npm ownership (unlike CROSS_NODES, whose src/lib directories share p:root ownership).
const BETWEEN_PACKAGE_NODES = [
  pkg("p:workspace", "workspace", null),
  npmPkg("p:app", "app", "p:workspace"),
  mod("m:pa", "app/a.ts", "p:app"),
  fn("fn:pa", "a", "m:pa"),
  npmPkg("p:library", "library", "p:workspace"),
  mod("m:px", "library/x.ts", "p:library"),
  fn("fn:px", "x", "m:px"),
];
const BETWEEN_PACKAGE_IMPORTS = [importEdge("m:pa", "m:px")];

describe("buildMinimalSubgraph — group members and cross-package wires", () => {
  it("keeps a directory-frame crossing separate from true npm-package ownership", () => {
    const cross = build(CROSS_NODES, CROSS_EDGES, ["m:a", "m:x"]).edges.find((edge) => edge.id === "min:m:a->m:x");
    expect(cross).toMatchObject({ crossFrame: true, crossPackage: false, outsideView: false });
  });

  it("leaves a same-directory, same-package import solid on both boundary axes", () => {
    const same = build(NODES, EDGES, ["m:a", "m:b"]).edges.find((edge) => edge.id === "min:m:a->m:b");
    expect(same).toMatchObject({ crossFrame: false, crossPackage: false, outsideView: false });
  });

  it("flags a true npm-package crossing from the original files, before member-box lifting", () => {
    const cross = build(BETWEEN_PACKAGE_NODES, BETWEEN_PACKAGE_IMPORTS, ["m:pa", "m:px"]).edges.find(
      (edge) => edge.id === "min:m:pa->m:px",
    );
    expect(cross).toMatchObject({
      crossFrame: true,
      crossPackage: true,
      outsideView: false,
      underlyingEdgeIds: ["imports:m:pa->m:px"],
    });
  });

  it("computes dep package crossing from its original symbol edge, not the drawn member boxes", () => {
    const samePackage = build(CROSS_NODES, CROSS_EDGES, ["m:a", "m:x"], ["m:a", "m:x"], [callsEdge("fn:a1", "fn:x1")])
      .edges.find((edge) => edge.id === "dep:calls:m:a->m:x");
    expect(samePackage).toMatchObject({ crossFrame: false, crossPackage: false, outsideView: false });

    const crossPackage = build(
      BETWEEN_PACKAGE_NODES,
      BETWEEN_PACKAGE_IMPORTS,
      ["m:pa", "m:px"],
      ["m:pa", "m:px"],
      [callsEdge("fn:pa", "fn:px")],
    ).edges.find((edge) => edge.id === "dep:calls:m:pa->m:px");
    expect(crossPackage).toMatchObject({
      crossFrame: false,
      crossPackage: true,
      outsideView: false,
      underlyingEdgeIds: ["calls:fn:pa->fn:px"],
    });
  });

  it("extracts a selected PACKAGE as ONE leaf card, never a frame of its files", () => {
    // p:src selected; its files stay folded onto the one card (no m:a file card for it).
    const { nodes } = build(CROSS_NODES, CROSS_EDGES, ["p:src"]);
    const card = nodeById(nodes, "p:src");
    expect(card?.kind).toBe("group");
    expect(card?.tier).toBe("seed"); // a leaf card carries a tier (a frame would be null)
    expect(card?.parentId).toBeNull(); // flat, not nested in a p:root frame
    expect(nodeById(nodes, "m:a")).toBeUndefined(); // its files are NOT decomposed
  });

  it("gives a group member a satellite ring: its files' outside couplings ghost, wires lifted to its card", () => {
    // a1() inside p:src's file calls x1() in lib/x.ts: the symbol charts as a satellite, the wire
    // anchors at the package card (nearestVisible lifts the inner caller onto the member box).
    const { nodes, edges } = build(CROSS_NODES, CROSS_EDGES, ["p:src"], ["p:src"], [callsEdge("fn:a1", "fn:x1")]);
    const satellite = nodeById(nodes, "fn:x1");
    expect(satellite?.kind).toBe("ghost");
    expect((satellite?.data as GhostData).ghostKind).toBe("function");
    expect(edges.find((edge) => edge.ghost === true)).toMatchObject({ id: "gdep:calls:p:src->fn:x1", source: "p:src", target: "fn:x1" });
  });
});

// foo()/bar() live in a.ts, baz() in b.ts, qux() in c.ts; imports run a → b → c.
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

function buildWithCoupling(coupling: GraphEdge[], members: string[] = ["m:a", "m:b"]) {
  const index = buildGraphIndex({ nodes: DEP_NODES, edges: [...DEP_IMPORTS, ...coupling] } as unknown as GraphArtifact);
  return buildMinimalSubgraph(index, buildModuleGraph(index), new Set(members), new Set(members), {
    expanded: new Set(),
    blockDeps: { edges: coupling },
    flows: {},
  });
}

describe("buildMinimalSubgraph — per-kind dep wires between member files", () => {
  it("lifts a cross-file coupling to a per-kind dep wire, alongside the pair's import wire", () => {
    const { edges } = buildWithCoupling([callsEdge("fn:foo", "fn:baz")]);
    const dep = edges.find((edge) => edge.kind === "dep" && edge.ghost !== true);
    expect(dep).toMatchObject({
      id: "dep:calls:m:a->m:b",
      source: "m:a",
      target: "m:b",
      depKind: "calls",
      weight: 1,
      underlyingEdgeIds: ["calls:fn:foo->fn:baz"],
    });
    // The import wire is still minted here — the paint's suppressRedundantImports hides it, like the Map.
    expect(edges.map((edge) => edge.id)).toContain("min:m:a->m:b");
  });

  it("routes a coupling whose target file is off the member set to the GHOST projection instead", () => {
    const { edges } = buildWithCoupling([callsEdge("fn:foo", "fn:qux")]);
    expect(edges.filter((edge) => edge.kind === "dep" && edge.ghost !== true)).toEqual([]);
    expect(edges.find((edge) => edge.ghost === true)?.id).toBe("gdep:calls:m:a->fn:qux");
  });

  it("mints no wire at all for an intra-file coupling", () => {
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
  return buildMinimalSubgraph(index, graph, new Set(["m:a"]), new Set(["m:a"]), {
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
