/**
 * Helpers behind the Module-map containment tree (`moduleTree.ts`): `collapseChain` (descend through
 * single-directory levels), `fileData` (per-file card data from the import graph), and `basename`.
 * Fixtures are hand-built so each rule is pinned exactly.
 */

import { describe, expect, it } from "vitest";
import { deriveGraphStructure } from "@meridian/core";
import type { GraphArtifact, GraphEdge, GraphNode } from "@meridian/core";
import { buildGraphIndex } from "../graph/graphIndex";
import { buildModuleGraph } from "./moduleGraph";
import { basename, blockData, collapseChain, fileData, unitData } from "./moduleLevel";

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

  it("stops at a bounded projection frontier whose sole directory has undisclosed children", () => {
    const root = npmPkg("ts:repo", "repo");
    const services = node("ts:repo/services", "package", root.id, "services");
    const structure = deriveGraphStructure([root, services], []);
    const hierarchyById = new Map(structure.hierarchyById);
    hierarchyById.set(services.id, {
      isTest: false,
      childKindCounts: { module: 2 },
      descendantSourceFileCount: 2,
      ownedSourceFileCount: 2,
    });
    const artifact: GraphArtifact = {
      schemaVersion: "1.0.0",
      generatedAt: "2026-07-17T00:00:00.000Z",
      generator: { name: "test", version: "1" },
      target: { name: "frontier", root: ".", language: "typescript" },
      nodes: [root, services],
      edges: [],
    };
    const index = buildGraphIndex(artifact, {
      structure: {
        ...structure,
        hierarchyById,
        repositorySummary: {
          overviewPackageCount: 1,
          sourceFileCount: 2,
          testSourceFileCount: 0,
        },
      },
      artifactComplete: false,
    });

    expect(index.childrenOf(services.id)).toEqual([]);
    expect(index.childCount(services.id)).toBe(2);
    expect(collapseChain(index, root.id)).toBe(root.id);
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

describe("code node semantics", () => {
  it("carries artifact kind, modifiers, and Promise result into Map card data", () => {
    const callable = node("ts:work.ts#Worker.load", "method", undefined, "load");
    callable.signature = "load(): Promise<Result>";
    callable.tags = ["async", "public", "static"];
    const index = indexOf([callable], []);

    expect(blockData(callable.id, index, { expandable: true, emptyFlow: false, childCount: 1, isExpanded: false })).toMatchObject({
      blockKind: "method",
      semantics: { modifiers: ["async", "static"], returnsPromise: true },
    });
  });

  it("retains high-signal modifiers on class/interface/object cards", () => {
    const owner = node("ts:work.ts#Worker", "class", undefined, "Worker");
    owner.tags = ["abstract", "export"];
    const index = indexOf([owner], []);

    expect(unitData(owner.id, index, {
      memberCount: 2,
      isContainer: true,
      isExpanded: false,
    }).semantics).toEqual({ modifiers: ["abstract"] });
  });

  it("keeps callable expansion capability independent from an honest zero child count", () => {
    const callable = node("ts:work.ts#Worker.pollOrder", "method", undefined, "pollOrder");
    const index = indexOf([callable], []);

    expect(blockData(callable.id, index, {
      expandable: true,
      emptyFlow: true,
      childCount: 0,
      isExpanded: true,
    })).toMatchObject({
      callable: true,
      expandable: true,
      emptyFlow: true,
      childCount: 0,
      isExpanded: true,
    });
  });
});

describe("basename", () => {
  it("returns the last path segment", () => {
    expect(basename("pkgA/src/index.ts")).toBe("index.ts");
    expect(basename("index.ts")).toBe("index.ts");
  });
});
