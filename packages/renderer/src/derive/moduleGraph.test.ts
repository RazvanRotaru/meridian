/**
 * The module import graph: which edges become file-to-file adjacency (resolved `imports` only),
 * endpoint lifting to owning files, self-loop dropping, and how the blast-radius root is resolved.
 * Fixtures are hand-built graphs so each rule is pinned independent of any extractor.
 */

import { describe, expect, it } from "vitest";
import type { GraphArtifact, GraphEdge, GraphNode } from "@meridian/core";
import { buildGraphIndex } from "../graph/graphIndex";
import { buildModuleGraph, resolveModuleRoot, weightKey } from "./moduleGraph";

function node(id: string, kind: string, parentId?: string, displayName?: string): GraphNode {
  return {
    id,
    kind,
    qualifiedName: id,
    displayName: displayName ?? id,
    parentId: parentId ?? null,
    location: { file: "f.ts", startLine: 1 },
  } as GraphNode;
}

function importEdge(source: string, target: string, resolution = "resolved"): GraphEdge {
  return { id: `imports:${source}->${target}`, source, target, kind: "imports", resolution } as GraphEdge;
}

function indexOf(nodes: GraphNode[], edges: GraphEdge[] = []) {
  return buildGraphIndex({ nodes, edges } as GraphArtifact);
}

const twoModules = [node("ts:a", "module"), node("ts:b", "module")];

describe("buildModuleGraph", () => {
  it("folds a resolved import into forward, reverse, and weight maps", () => {
    const graph = buildModuleGraph(indexOf(twoModules, [importEdge("ts:a", "ts:b")]));
    expect([...(graph.out.get("ts:a") ?? [])]).toEqual(["ts:b"]);
    expect([...(graph.in.get("ts:b") ?? [])]).toEqual(["ts:a"]);
    expect(graph.weight.get(weightKey("ts:a", "ts:b"))).toBe(1);
  });

  it("counts every module node as a file, imported or not", () => {
    const graph = buildModuleGraph(indexOf([...twoModules, node("ts:c", "module")]));
    expect(graph.fileIds).toEqual(new Set(["ts:a", "ts:b", "ts:c"]));
  });

  it("ignores non-import edges and unresolved imports", () => {
    const nodes = twoModules;
    const edges = [
      { id: "calls:ts:a->ts:b", source: "ts:a", target: "ts:b", kind: "calls" } as GraphEdge,
      importEdge("ts:a", "ts:b", "unresolved"),
    ];
    const graph = buildModuleGraph(indexOf(nodes, edges));
    expect(graph.out.get("ts:a")).toBeUndefined();
  });

  it("lifts a member endpoint to its owning module", () => {
    const nodes = [
      node("ts:a", "module"),
      node("ts:a#f", "function", "ts:a"),
      node("ts:b", "module"),
      node("ts:b#g", "function", "ts:b"),
    ];
    const graph = buildModuleGraph(indexOf(nodes, [importEdge("ts:a#f", "ts:b#g")]));
    expect([...(graph.out.get("ts:a") ?? [])]).toEqual(["ts:b"]);
  });

  it("drops a self-loop, including one formed by lifting both endpoints into one file", () => {
    const nodes = [node("ts:a", "module"), node("ts:a#f", "function", "ts:a"), node("ts:a#g", "function", "ts:a")];
    const graph = buildModuleGraph(indexOf(nodes, [importEdge("ts:a#f", "ts:a#g"), importEdge("ts:a", "ts:a")]));
    expect(graph.out.get("ts:a")).toBeUndefined();
  });

  it("accumulates weight across repeated imports of the same pair", () => {
    const edges = [importEdge("ts:a", "ts:b"), importEdge("ts:a", "ts:b")];
    const graph = buildModuleGraph(indexOf(twoModules, edges));
    expect(graph.weight.get(weightKey("ts:a", "ts:b"))).toBe(2);
    expect([...(graph.out.get("ts:a") ?? [])]).toEqual(["ts:b"]);
  });
});

describe("resolveModuleRoot", () => {
  it("prefers the first entryModules id that is a real module", () => {
    const index = indexOf([node("ts:main.ts", "module"), node("ts:b", "module")]);
    expect(resolveModuleRoot(index, ["ts:missing", "ts:b"])).toBe("ts:b");
  });

  it("falls back to the shallowest entry-named module", () => {
    const nodes = [node("ts:src/app.ts", "module"), node("ts:main.ts", "module"), node("ts:util/x.ts", "module")];
    expect(resolveModuleRoot(indexOf(nodes), undefined)).toBe("ts:main.ts");
  });

  it("falls back to the most-imported module when no name matches", () => {
    const nodes = [node("ts:foo.ts", "module"), node("ts:bar.ts", "module"), node("ts:baz.ts", "module")];
    const edges = [importEdge("ts:foo.ts", "ts:baz.ts"), importEdge("ts:bar.ts", "ts:baz.ts")];
    expect(resolveModuleRoot(indexOf(nodes, edges), undefined)).toBe("ts:baz.ts");
  });

  it("returns null when there is nothing importable to centre on", () => {
    const nodes = [node("ts:foo.ts", "module"), node("ts:bar.ts", "module")];
    expect(resolveModuleRoot(indexOf(nodes), undefined)).toBeNull();
  });
});
