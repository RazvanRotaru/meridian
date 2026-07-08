/**
 * The minimal containment subgraph: ancestor-union minimality (unrelated packages stay out), 1-hop
 * boundary neighbors in BOTH directions with a per-seed cap and a toggle, import wires restricted to
 * affected<->affected and affected<->boundary (never boundary<->boundary), and the collapsed frame.
 */

import { describe, expect, it } from "vitest";
import type { GraphArtifact, GraphEdge, GraphNode } from "@meridian/core";
import { buildGraphIndex } from "../graph/graphIndex";
import { buildModuleGraph } from "./moduleGraph";
import { buildMinimalSubgraph, stampChangeStatuses, type MinimalSubgraphNode } from "./minimalSubgraph";

function pkg(id: string, name: string, parentId: string | null): GraphNode {
  return { id, kind: "package", qualifiedName: id, displayName: name, parentId, location: { file: name, startLine: 1 } } as GraphNode;
}

function mod(id: string, file: string, parentId: string | null): GraphNode {
  return { id, kind: "module", qualifiedName: id, displayName: id, parentId, location: { file, startLine: 1 } } as GraphNode;
}

function importEdge(source: string, target: string): GraphEdge {
  return { id: `imports:${source}->${target}`, source, target, kind: "imports", resolution: "resolved" } as GraphEdge;
}

function build(nodes: GraphNode[], edges: GraphEdge[], seeds: string[], options = {}) {
  const index = buildGraphIndex({ nodes, edges } as unknown as GraphArtifact);
  return buildMinimalSubgraph(index, buildModuleGraph(index), new Set(seeds), options);
}

function byId(nodes: MinimalSubgraphNode[], id: string): MinimalSubgraphNode {
  const found = nodes.find((node) => node.id === id);
  if (!found) throw new Error(`missing node ${id}`);
  return found;
}

const NODES = [
  pkg("p:root", "root", null),
  pkg("p:src", "src", "p:root"),
  pkg("p:lib", "lib", "p:root"),
  mod("m:a", "src/a.ts", "p:src"),
  mod("m:b", "src/b.ts", "p:src"),
  mod("m:c", "src/c.ts", "p:src"),
  mod("m:d", "lib/d.ts", "p:lib"),
];
// a imports b (context), c imports a (blast radius), b imports c (boundary<->boundary), d isolated.
const EDGES = [importEdge("m:a", "m:b"), importEdge("m:c", "m:a"), importEdge("m:b", "m:c")];

describe("buildMinimalSubgraph", () => {
  it("keeps only the affected subtree plus its boundary — unrelated packages stay out", () => {
    const result = build(NODES, EDGES, ["m:a"]);
    expect(result.keptNodeIds).toEqual(["m:a", "m:b", "m:c", "p:root", "p:src"]);
    expect(result.boundaryNodeIds).toEqual(["m:b", "m:c"]);
  });

  it("pulls boundary neighbors from both import directions and flags them", () => {
    const nodes = build(NODES, EDGES, ["m:a"]).spec.nodes;
    expect(byId(nodes, "m:a").isBoundary).toBe(false);
    expect(byId(nodes, "m:b").isBoundary).toBe(true); // a -> b (imported context)
    expect(byId(nodes, "m:c").isBoundary).toBe(true); // c -> a (importer / blast radius)
  });

  it("folds only affected-touching import wires and drops boundary<->boundary", () => {
    const edges = build(NODES, EDGES, ["m:a"]).spec.edges;
    expect(edges.map((edge) => edge.id)).toEqual(["min:m:a->m:b", "min:m:c->m:a"]);
  });

  it("collapses the lone package chain into one frame with the joined label", () => {
    const nodes = build(NODES, EDGES, ["m:a"]).spec.nodes;
    expect(nodes.some((node) => node.id === "p:root")).toBe(false);
    const frame = byId(nodes, "p:src");
    expect(frame.kind).toBe("group");
    expect(frame.collapsedLabel).toBe("root/src");
    expect(frame.parentId).toBeNull();
    expect((frame.data as { fileCount: number }).fileCount).toBe(3);
    expect(byId(nodes, "m:a").parentId).toBe("p:src");
  });

  it("caps boundary fan-out per seed", () => {
    const nodes = [mod("m:s", "s.ts", null), ...[1, 2, 3, 4, 5].map((n) => mod(`m:n${n}`, `n${n}.ts`, null))];
    const edges = [1, 2, 3, 4, 5].map((n) => importEdge("m:s", `m:n${n}`));
    const result = build(nodes, edges, ["m:s"], { boundaryCap: 2 });
    expect(result.boundaryNodeIds).toEqual(["m:n1", "m:n2"]);
  });

  it("balances the cap so importers (blast radius) survive many context imports that sort first", () => {
    const nodes = [mod("m:s", "s.ts", null), ...["a1", "a2", "a3", "z1"].map((n) => mod(`m:${n}`, `${n}.ts`, null))];
    // seed imports 3 context files (all sort before the importer); z1 imports the seed (blast radius).
    const edges = [
      importEdge("m:s", "m:a1"),
      importEdge("m:s", "m:a2"),
      importEdge("m:s", "m:a3"),
      importEdge("m:z1", "m:s"),
    ];
    const result = build(nodes, edges, ["m:s"], { boundaryCap: 2 });
    expect(result.boundaryNodeIds).toContain("m:z1"); // the importer is not starved by the earlier-sorting imports
    expect(result.boundaryNodeIds).toHaveLength(2); // still honors the per-seed cap
  });

  it("omits boundary entirely when includeBoundary is false", () => {
    const result = build(NODES, EDGES, ["m:a"], { includeBoundary: false });
    expect(result.boundaryNodeIds).toEqual([]);
    expect(result.keptNodeIds).toEqual(["m:a", "p:root", "p:src"]);
    expect(result.spec.edges).toEqual([]);
  });

  it("constructs without change statuses — diff semantics are a review-side stamp", () => {
    const nodes = build(NODES, EDGES, ["m:a"]).spec.nodes;
    expect(nodes.every((node) => node.changeStatus === undefined)).toBe(true);
  });
});

describe("stampChangeStatuses", () => {
  it("tints seed files by the status map, defaulting absent entries to modified", () => {
    const spec = build(NODES, EDGES, ["m:a", "m:b"], { includeBoundary: false }).spec;
    const stamped = stampChangeStatuses(spec, { "src/a.ts": "added" });
    expect(byId(stamped.nodes, "m:a").changeStatus).toBe("added");
    expect(byId(stamped.nodes, "m:b").changeStatus).toBe("modified");
  });

  it("never stamps boundary neighbours or group frames", () => {
    const spec = build(NODES, EDGES, ["m:a"]).spec;
    const stamped = stampChangeStatuses(spec, {});
    expect(byId(stamped.nodes, "m:b").changeStatus).toBeUndefined(); // boundary context
    expect(byId(stamped.nodes, "p:src").changeStatus).toBeUndefined(); // containment frame
  });
});
