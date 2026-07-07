/**
 * deriveModuleTree: the Module map's inline-expandable containment tree. focus=null is the npm-package
 * overview; expanding a group nests its children (parentId) in DFS preorder; a collapsed sibling stays
 * folded; imports lift to the visible frontier (internal imports self-loop away). Fixtures are
 * hand-built so each rule is pinned exactly (mirrors moduleLevel.test.ts).
 */

import { describe, expect, it } from "vitest";
import type { GraphArtifact, GraphEdge, GraphNode } from "@meridian/core";
import { buildGraphIndex } from "../graph/graphIndex";
import { buildModuleGraph } from "./moduleGraph";
import { deriveModuleTree, type ModuleGroupData } from "./moduleTree";

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

function npmPkg(id: string, displayName: string, parentId?: string): GraphNode {
  return { ...node(id, "package", parentId, displayName), tags: ["npm-package"] } as GraphNode;
}

function importEdge(source: string, target: string): GraphEdge {
  return { id: `imports:${source}->${target}`, source, target, kind: "imports", resolution: "resolved" } as GraphEdge;
}

// pkgA{src{index, util, cli{run}}} + pkgB{src{b}} + pkgC{src{c}}, cross-imported.
function fixture(): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes = [
    npmPkg("ts:pkgA", "pkgA"),
    node("ts:pkgA/src", "package", "ts:pkgA", "src"),
    node("ts:pkgA/src/index.ts", "module", "ts:pkgA/src", "index.ts"),
    node("ts:pkgA/src/util.ts", "module", "ts:pkgA/src", "util.ts"),
    node("ts:pkgA/src/cli", "package", "ts:pkgA/src", "cli"),
    node("ts:pkgA/src/cli/run.ts", "module", "ts:pkgA/src/cli", "run.ts"),
    npmPkg("ts:pkgB", "pkgB"),
    node("ts:pkgB/src", "package", "ts:pkgB", "src"),
    node("ts:pkgB/src/b.ts", "module", "ts:pkgB/src", "b.ts"),
    npmPkg("ts:pkgC", "pkgC"),
    node("ts:pkgC/src", "package", "ts:pkgC", "src"),
    node("ts:pkgC/src/c.ts", "module", "ts:pkgC/src", "c.ts"),
  ];
  const edges = [
    importEdge("ts:pkgA/src/index.ts", "ts:pkgA/src/cli/run.ts"), // into the cli subdir (internal to pkgA)
    importEdge("ts:pkgA/src/index.ts", "ts:pkgA/src/util.ts"), // sibling file (internal to pkgA)
    importEdge("ts:pkgA/src/index.ts", "ts:pkgB/src/b.ts"), // cross-package
    importEdge("ts:pkgB/src/b.ts", "ts:pkgC/src/c.ts"),
  ];
  return { nodes, edges };
}

function treeOf(nodes: GraphNode[], edges: GraphEdge[], focus: string | null, expanded: string[]) {
  const index = buildGraphIndex({ nodes, edges } as GraphArtifact);
  return deriveModuleTree(index, focus, new Set(expanded), buildModuleGraph(index));
}

describe("deriveModuleTree — overview (focus null)", () => {
  it("roots are the npm packages, top-level (no parent), collapsed", () => {
    const { nodes, edges } = fixture();
    const tree = treeOf(nodes, edges, null, []);
    expect(tree.effectiveFocus).toBeNull();
    expect(tree.nodes.map((n) => n.id)).toEqual(["ts:pkgA", "ts:pkgB", "ts:pkgC"]);
    expect(tree.nodes.every((n) => n.parentId === null && n.kind === "package")).toBe(true);
    expect(tree.nodes.every((n) => n.isContainer && !n.isExpanded)).toBe(true);
  });

  it("group fileCount counts the owning package's source files", () => {
    const { nodes, edges } = fixture();
    const pkgA = treeOf(nodes, edges, null, []).nodes.find((n) => n.id === "ts:pkgA");
    expect((pkgA?.data as ModuleGroupData).fileCount).toBe(3); // index, util, run
  });

  it("uses the package-overview ownership fold for collapsed root package counts", () => {
    const nodes = [
      npmPkg("ts:outer", "outer"),
      node("ts:outer/root.ts", "module", "ts:outer", "root.ts"),
      npmPkg("ts:outer/inner", "inner", "ts:outer"),
      node("ts:outer/inner/leaf.ts", "module", "ts:outer/inner", "leaf.ts"),
    ];
    const edges = [importEdge("ts:outer/root.ts", "ts:outer/inner/leaf.ts")];
    const byId = new Map(treeOf(nodes, edges, null, []).nodes.map((n) => [n.id, n.data as ModuleGroupData]));
    expect(byId.get("ts:outer")).toMatchObject({ fileCount: 1, ce: 1, ca: 0 });
    expect(byId.get("ts:outer/inner")).toMatchObject({ fileCount: 1, ce: 0, ca: 1 });
  });

  it("collapsed packages couple as package→package wires; internal imports self-loop away", () => {
    const { nodes, edges } = fixture();
    const wires = treeOf(nodes, edges, null, []).edges.map((e) => `${e.source}->${e.target}:${e.crossFrame}`);
    expect(wires).toContain("ts:pkgA->ts:pkgB:true");
    expect(wires).toContain("ts:pkgB->ts:pkgC:true");
    // index→util and index→run are internal to pkgA, so they collapse to a dropped self-loop.
    expect(wires.some((w) => w.startsWith("ts:pkgA->ts:pkgA"))).toBe(false);
  });
});

describe("deriveModuleTree — inline expansion", () => {
  it("expanding a package nests its child under it, in preorder; siblings stay folded", () => {
    const { nodes, edges } = fixture();
    const tree = treeOf(nodes, edges, null, ["ts:pkgA"]);
    const ids = tree.nodes.map((n) => n.id);
    // pkgA appears before its child; pkgB/pkgC descendants are absent (collapsed).
    expect(ids).toEqual(["ts:pkgA", "ts:pkgA/src", "ts:pkgB", "ts:pkgC"]);
    const src = tree.nodes.find((n) => n.id === "ts:pkgA/src");
    expect(src?.parentId).toBe("ts:pkgA");
    expect(src?.isContainer).toBe(true);
    expect(src?.isExpanded).toBe(false);
    expect(tree.nodes.find((n) => n.id === "ts:pkgA")?.isExpanded).toBe(true);
  });

  it("expanding down to files nests file cards and lifts imports to the frontier", () => {
    const { nodes, edges } = fixture();
    const tree = treeOf(nodes, edges, null, ["ts:pkgA", "ts:pkgA/src"]);
    const files = tree.nodes.filter((n) => n.kind === "file").map((n) => n.id);
    expect(files).toEqual(["ts:pkgA/src/index.ts", "ts:pkgA/src/util.ts"]);
    const cli = tree.nodes.find((n) => n.id === "ts:pkgA/src/cli");
    expect(cli?.parentId).toBe("ts:pkgA/src");
    const wires = tree.edges.map((e) => `${e.source}->${e.target}:${e.crossFrame}`);
    // index→util is file↔file cohesion (not crossFrame); index→run lifts to the collapsed cli group.
    expect(wires).toContain("ts:pkgA/src/index.ts->ts:pkgA/src/util.ts:false");
    expect(wires).toContain("ts:pkgA/src/index.ts->ts:pkgA/src/cli:true");
    // the cross-package import lifts to the still-collapsed pkgB package node.
    expect(wires).toContain("ts:pkgA/src/index.ts->ts:pkgB:true");
  });
});

describe("deriveModuleTree — package focus", () => {
  it("chain-collapses a single-directory focus (pkgA → pkgA/src) as the frontier", () => {
    const { nodes, edges } = fixture();
    const tree = treeOf(nodes, edges, "ts:pkgA", []);
    expect(tree.effectiveFocus).toBe("ts:pkgA/src");
    // Frontier children in source order (index, util, cli); all top-level (no drawn parent).
    expect(tree.nodes.map((n) => n.id)).toEqual(["ts:pkgA/src/index.ts", "ts:pkgA/src/util.ts", "ts:pkgA/src/cli"]);
    expect(tree.nodes.every((n) => n.parentId === null)).toBe(true);
  });
});
