/**
 * levelChildren: the navigable cards a breadcrumb segment's dropdown offers — exactly the frontier
 * the Map draws at that focus, filtered to what a double-click would zoom into (folders + files).
 * So the menu always mirrors the boxes on screen: npm packages at the overview, folder/file children
 * deeper, nothing for a file focus (its children are code, not navigation targets).
 */

import { describe, expect, it } from "vitest";
import type { GraphArtifact, GraphEdge, GraphNode } from "@meridian/core";
import { buildGraphIndex } from "../graph/graphIndex";
import { buildModuleGraph } from "./moduleGraph";
import { levelChildren } from "./breadcrumbNav";

function node(id: string, kind: string, parentId?: string, displayName?: string): GraphNode {
  return { id, kind, qualifiedName: id, displayName: displayName ?? id, parentId: parentId ?? null, location: { file: "f.ts", startLine: 1 } } as GraphNode;
}
function npmPkg(id: string, displayName: string, parentId?: string): GraphNode {
  return { ...node(id, "package", parentId, displayName), tags: ["npm-package"] } as GraphNode;
}
function importEdge(source: string, target: string): GraphEdge {
  return { id: `imports:${source}->${target}`, source, target, kind: "imports", resolution: "resolved" } as GraphEdge;
}

// pkgA{src{index.ts, api{h.ts}}} + pkgB{src{b.ts}}, cross-imported so both packages own graph files.
const NODES: GraphNode[] = [
  npmPkg("ts:pkgA", "pkgA"),
  node("ts:pkgA/src", "package", "ts:pkgA", "src"),
  node("ts:pkgA/src/index.ts", "module", "ts:pkgA/src", "index.ts"),
  node("ts:pkgA/src/api", "package", "ts:pkgA/src", "api"),
  node("ts:pkgA/src/api/h.ts", "module", "ts:pkgA/src/api", "h.ts"),
  npmPkg("ts:pkgB", "pkgB"),
  node("ts:pkgB/src", "package", "ts:pkgB", "src"),
  node("ts:pkgB/src/b.ts", "module", "ts:pkgB/src", "b.ts"),
];
const EDGES: GraphEdge[] = [
  importEdge("ts:pkgA/src/index.ts", "ts:pkgA/src/api/h.ts"),
  importEdge("ts:pkgA/src/index.ts", "ts:pkgB/src/b.ts"),
];

function fixture() {
  const index = buildGraphIndex({ nodes: NODES, edges: EDGES } as GraphArtifact);
  return { index, graph: buildModuleGraph(index) };
}

describe("levelChildren", () => {
  it("at the overview (null focus) lists the npm-package cards", () => {
    const { index, graph } = fixture();
    expect(levelChildren(index, graph, null)).toEqual([
      { id: "ts:pkgA", label: "pkgA" },
      { id: "ts:pkgB", label: "pkgB" },
    ]);
  });

  it("inside a package lists its folder/file children (what you can go into)", () => {
    const { index, graph } = fixture();
    expect(levelChildren(index, graph, "ts:pkgA/src")).toEqual([
      { id: "ts:pkgA/src/index.ts", label: "index.ts" },
      { id: "ts:pkgA/src/api", label: "api" },
    ]);
  });

  it("a lone-child package still lists that child", () => {
    const { index, graph } = fixture();
    expect(levelChildren(index, graph, "ts:pkgA")).toEqual([{ id: "ts:pkgA/src", label: "src" }]);
  });

  it("is empty for a file focus (its children are code, not navigation targets)", () => {
    const { index, graph } = fixture();
    expect(levelChildren(index, graph, "ts:pkgA/src/index.ts")).toEqual([]);
  });

  it("excludes hidden (test) ids so the menu matches the cards the Map actually draws", () => {
    const { index, graph } = fixture();
    expect(levelChildren(index, graph, null, new Set(["ts:pkgB"]))).toEqual([{ id: "ts:pkgA", label: "pkgA" }]);
  });

  it("skips a folder that owns no source file (the Map draws nothing for it)", () => {
    const nodes: GraphNode[] = [
      node("ts:src", "package", undefined, "src"),
      node("ts:src/a.ts", "module", "ts:src", "a.ts"),
      node("ts:src/empty", "package", "ts:src", "empty"),
    ];
    const index = buildGraphIndex({ nodes, edges: [] as GraphEdge[] } as GraphArtifact);
    const graph = buildModuleGraph(index);
    expect(levelChildren(index, graph, "ts:src")).toEqual([{ id: "ts:src/a.ts", label: "a.ts" }]);
  });
});
