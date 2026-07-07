/**
 * deriveLevel: one containment level of the Module map. focus=null is the package overview; a package
 * focus yields its children (dirs as groups, files as file cards) with imports folded to that level,
 * chain-collapsing single-directory levels. Fixtures are hand-built so each rule is pinned exactly.
 */

import { describe, expect, it } from "vitest";
import type { GraphArtifact, GraphEdge, GraphNode } from "@meridian/core";
import { buildGraphIndex } from "../graph/graphIndex";
import { buildModuleGraph } from "./moduleGraph";
import { deriveLevel } from "./moduleLevel";

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

function levelOf(nodes: GraphNode[], edges: GraphEdge[], focus: string | null) {
  const index = buildGraphIndex({ nodes, edges } as GraphArtifact);
  return deriveLevel(index, focus, buildModuleGraph(index));
}

// pkgA{index, util} + pkgA/src/cli{run}; plus pkgB and pkgC as separate npm packages, cross-imported.
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
    importEdge("ts:pkgA/src/index.ts", "ts:pkgA/src/cli/run.ts"), // into the cli subdir (a group)
    importEdge("ts:pkgA/src/index.ts", "ts:pkgA/src/util.ts"), // sibling file
    importEdge("ts:pkgA/src/index.ts", "ts:pkgB/src/b.ts"), // cross-package (out of focus)
    importEdge("ts:pkgB/src/b.ts", "ts:pkgC/src/c.ts"),
  ];
  return { nodes, edges };
}

describe("deriveLevel — overview (focus null)", () => {
  it("is the npm-package graph: groups only, no files", () => {
    const { nodes, edges } = fixture();
    const level = levelOf(nodes, edges, null);
    expect(level.effectiveFocus).toBeNull();
    expect(level.groups.map((g) => g.id)).toEqual(["ts:pkgA", "ts:pkgB", "ts:pkgC"]);
    expect(level.files).toEqual([]);
    expect(level.edges.length).toBeGreaterThan(0);
  });
});

describe("deriveLevel — package focus", () => {
  it("chain-collapses a single-directory level (pkgA → pkgA/src)", () => {
    const { nodes, edges } = fixture();
    const level = levelOf(nodes, edges, "ts:pkgA");
    expect(level.effectiveFocus).toBe("ts:pkgA/src");
  });

  it("renders sub-directories as groups and files as file cards", () => {
    const { nodes, edges } = fixture();
    const level = levelOf(nodes, edges, "ts:pkgA");
    expect(level.groups.map((g) => g.id)).toEqual(["ts:pkgA/src/cli"]);
    expect(level.groups[0].data.fileCount).toBe(1);
    expect(level.files.map((f) => f.id)).toEqual(["ts:pkgA/src/index.ts", "ts:pkgA/src/util.ts"]);
  });

  it("lifts imports to this level's children and flags group-involved wires as crossFrame", () => {
    const { nodes, edges } = fixture();
    const level = levelOf(nodes, edges, "ts:pkgA");
    const wires = level.edges.map((e) => `${e.source}->${e.target}:${e.crossFrame}`);
    // index.ts → cli/run.ts lifts to index.ts → cli (a group, so crossFrame); index.ts → util.ts is
    // file↔file cohesion (not crossFrame). The cross-package import to pkgB leaves the focus, so it's
    // not drawn at this level.
    expect(wires).toContain("ts:pkgA/src/index.ts->ts:pkgA/src/cli:true");
    expect(wires).toContain("ts:pkgA/src/index.ts->ts:pkgA/src/util.ts:false");
    expect(level.edges.some((e) => e.target === "ts:pkgB/src/b.ts")).toBe(false);
  });

  it("is empty for a focus that is not a package node", () => {
    const { nodes, edges } = fixture();
    const level = levelOf(nodes, edges, "ts:pkgA/src/index.ts");
    expect(level.groups).toEqual([]);
    expect(level.files).toEqual([]);
  });
});
