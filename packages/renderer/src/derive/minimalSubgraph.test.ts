/**
 * The minimal subgraph the overlay grows: seeds + their always-shown 1-hop ring as PERSISTENT nodes,
 * directional [+n] stubs on any node with hidden neighbours, GHOST nodes revealed by an expansion,
 * and the collapsed containment frame. Import wires connect any two visible files.
 */

import { describe, expect, it } from "vitest";
import type { GraphArtifact, GraphEdge, GraphNode } from "@meridian/core";
import { buildGraphIndex } from "../graph/graphIndex";
import { buildModuleGraph } from "./moduleGraph";
import { buildMinimalSubgraph, type ExpansionEntry, type MinimalStubData, type MinimalSubgraphNode } from "./minimalSubgraph";

function pkg(id: string, name: string, parentId: string | null): GraphNode {
  return { id, kind: "package", qualifiedName: id, displayName: name, parentId, location: { file: name, startLine: 1 } } as GraphNode;
}

function mod(id: string, file: string, parentId: string | null): GraphNode {
  return { id, kind: "module", qualifiedName: id, displayName: id, parentId, location: { file, startLine: 1 } } as GraphNode;
}

function importEdge(source: string, target: string): GraphEdge {
  return { id: `imports:${source}->${target}`, source, target, kind: "imports", resolution: "resolved" } as GraphEdge;
}

function build(nodes: GraphNode[], edges: GraphEdge[], seeds: string[], kept: string[] = [], expanded: ExpansionEntry[] = []) {
  const index = buildGraphIndex({ nodes, edges } as unknown as GraphArtifact);
  return buildMinimalSubgraph(index, buildModuleGraph(index), new Set(seeds), new Set(kept), expanded);
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
  it("shows a seed plus its full 1-hop ring as persistent, nothing deeper", () => {
    const { nodes } = build(NODES, EDGES, ["m:a"]);
    expect(nodeById(nodes, "m:a")?.tier).toBe("seed");
    expect(nodeById(nodes, "m:b")?.tier).toBe("persistent"); // a imports b
    expect(nodeById(nodes, "m:e")?.tier).toBe("persistent"); // e imports a
    expect(nodeById(nodes, "m:c")).toBeUndefined(); // 2 hops out, not shown
  });

  it("puts a directional [+n] stub on a node with hidden neighbours, none where all are shown", () => {
    const { nodes } = build(NODES, EDGES, ["m:a"]);
    // b's import of c is hidden → an out-stub with count 1; b's importer (a) is shown → no in-stub.
    const bOut = nodeById(nodes, "stub:m:b|out");
    expect((bOut?.data as MinimalStubData).count).toBe(1);
    expect(nodeById(nodes, "stub:m:b|in")).toBeUndefined();
    // a's whole 1-hop is shown → no stubs on the seed at all.
    expect(nodeById(nodes, "stub:m:a|out")).toBeUndefined();
    expect(nodeById(nodes, "stub:m:a|in")).toBeUndefined();
  });

  it("draws import wires only between two visible files", () => {
    const { edges } = build(NODES, EDGES, ["m:a"]);
    const imports = edges.filter((edge) => edge.kind === "import").map((edge) => edge.id);
    expect(imports).toContain("min:m:e->m:a");
    expect(imports).toContain("min:m:a->m:b");
    expect(imports).not.toContain("min:m:b->m:c"); // c is not visible
  });

  it("reveals an expansion's neighbours as ghosts, one hop past the frontier", () => {
    const { nodes } = build(NODES, EDGES, ["m:a"], [], [{ id: "m:b", direction: "out" }]);
    expect(nodeById(nodes, "m:c")?.tier).toBe("ghost"); // b's out-neighbour, revealed
    expect(nodeById(nodes, "m:d")).toBeUndefined(); // still one hop further
    // The freshly-revealed ghost carries its own outward stub.
    expect((nodeById(nodes, "stub:m:c|out")?.data as MinimalStubData).count).toBe(1);
  });

  it("renders a drilled-through ghost as persistent (kept), its neighbour as the new ghost", () => {
    const { nodes } = build(NODES, EDGES, ["m:a"], ["m:c"], [
      { id: "m:b", direction: "out" },
      { id: "m:c", direction: "out" },
    ]);
    expect(nodeById(nodes, "m:c")?.tier).toBe("persistent"); // committed by drilling through it
    expect(nodeById(nodes, "m:d")?.tier).toBe("ghost"); // c's newly-revealed neighbour
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
