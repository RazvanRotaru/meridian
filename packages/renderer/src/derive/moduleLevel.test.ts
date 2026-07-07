/**
 * Helpers behind the Module-map containment tree (`moduleTree.ts`): `collapseChain` (descend through
 * single-directory levels), `fileData` (per-file card data from the import graph), and `basename`.
 * Fixtures are hand-built so each rule is pinned exactly.
 */

import { describe, expect, it } from "vitest";
import type { GraphArtifact, GraphEdge, GraphNode } from "@meridian/core";
import { buildGraphIndex } from "../graph/graphIndex";
import { buildModuleGraph } from "./moduleGraph";
import { basename, collapseChain, fileData } from "./moduleLevel";

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
  ];
  const edges = [
    importEdge("ts:pkgA/src/index.ts", "ts:pkgA/src/util.ts"), // sibling file
    importEdge("ts:pkgA/src/index.ts", "ts:pkgB/src/b.ts"), // cross-package
  ];
  return { nodes, edges };
}

const NO_UNITS = { isContainer: false, isExpanded: false, unitCount: 0 };

function indexOf(nodes: GraphNode[], edges: GraphEdge[]) {
  return buildGraphIndex({ nodes, edges } as GraphArtifact);
}

describe("collapseChain", () => {
  it("descends through a single-directory level (pkgA → pkgA/src)", () => {
    const { nodes, edges } = fixture();
    expect(collapseChain(indexOf(nodes, edges), "ts:pkgA")).toBe("ts:pkgA/src");
  });

  it("stops where a level branches (pkgA/src has files + a subdir)", () => {
    const { nodes, edges } = fixture();
    expect(collapseChain(indexOf(nodes, edges), "ts:pkgA/src")).toBe("ts:pkgA/src");
  });
});

describe("fileData", () => {
  it("reads label/path and the in/out import degrees from the module graph", () => {
    const { nodes, edges } = fixture();
    const index = indexOf(nodes, edges);
    const data = fileData("ts:pkgA/src/index.ts", buildModuleGraph(index), index, null, NO_UNITS);
    expect(data.label).toBe("index.ts");
    expect(data.fullPath).toBe("pkgA/src/index.ts");
    expect(data.outCount).toBe(2); // imports util.ts and pkgB/b.ts
    expect(data.inCount).toBe(0);
    expect(data.isEntry).toBe(false);
  });

  it("flags the package entry module as an entry card", () => {
    const { nodes, edges } = fixture();
    const index = indexOf(nodes, edges);
    const data = fileData("ts:pkgA/src/index.ts", buildModuleGraph(index), index, "ts:pkgA/src/index.ts", NO_UNITS);
    expect(data.isEntry).toBe(true);
    expect(data.category).toBe("entry");
  });
});

describe("basename", () => {
  it("returns the last path segment", () => {
    expect(basename("pkgA/src/index.ts")).toBe("index.ts");
    expect(basename("index.ts")).toBe("index.ts");
  });
});
