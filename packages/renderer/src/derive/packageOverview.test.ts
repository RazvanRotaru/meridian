/**
 * The whole-repo package overview: files collapse to their owning npm package, cross-package imports
 * aggregate into weighted package pairs (self-pairs dropped), and Ca/Ce count distinct package
 * neighbours. Fixtures are hand-built package/module graphs so each rule is pinned without an extractor.
 */

import { describe, expect, it } from "vitest";
import type { GraphArtifact, GraphEdge, GraphNode } from "@meridian/core";
import { buildGraphIndex } from "../graph/graphIndex";
import { derivePackageOverview, packageEntryModule } from "./packageOverview";

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

function indexOf(nodes: GraphNode[], edges: GraphEdge[]) {
  return buildGraphIndex({ nodes, edges } as GraphArtifact);
}

// pkgA{index,helper} → pkgB{b} (twice) and pkgC{c}; pkgB{b} → pkgC{c}; plus a same-package import.
function threePackageFixture(): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes = [
    npmPkg("ts:pkgA", "pkgA"),
    node("ts:pkgA/src", "package", "ts:pkgA", "src"),
    node("ts:pkgA/src/index.ts", "module", "ts:pkgA/src", "index.ts"),
    node("ts:pkgA/src/helper.ts", "module", "ts:pkgA/src", "helper.ts"),
    npmPkg("ts:pkgB", "pkgB"),
    node("ts:pkgB/src", "package", "ts:pkgB", "src"),
    node("ts:pkgB/src/b.ts", "module", "ts:pkgB/src", "b.ts"),
    npmPkg("ts:pkgC", "pkgC"),
    node("ts:pkgC/src", "package", "ts:pkgC", "src"),
    node("ts:pkgC/src/c.ts", "module", "ts:pkgC/src", "c.ts"),
  ];
  const edges = [
    importEdge("ts:pkgA/src/index.ts", "ts:pkgA/src/helper.ts"), // same package — dropped from pairs
    importEdge("ts:pkgA/src/index.ts", "ts:pkgB/src/b.ts"),
    importEdge("ts:pkgA/src/helper.ts", "ts:pkgB/src/b.ts"), // → pkgA→pkgB weight 2
    importEdge("ts:pkgA/src/index.ts", "ts:pkgC/src/c.ts"),
    importEdge("ts:pkgB/src/b.ts", "ts:pkgC/src/c.ts"),
  ];
  return { nodes, edges };
}

describe("derivePackageOverview", () => {
  it("emits one node per owning npm package with its file count and Ca/Ce", () => {
    const { nodes, edges } = threePackageFixture();
    const spec = derivePackageOverview(indexOf(nodes, edges));
    const byId = new Map(spec.nodes.map((n) => [n.id, n.data]));
    expect([...byId.keys()]).toEqual(["ts:pkgA", "ts:pkgB", "ts:pkgC"]);
    expect(byId.get("ts:pkgA")).toMatchObject({ fileCount: 2, ce: 2, ca: 0 });
    expect(byId.get("ts:pkgB")).toMatchObject({ fileCount: 1, ce: 1, ca: 1 });
    expect(byId.get("ts:pkgC")).toMatchObject({ fileCount: 1, ce: 0, ca: 2 });
  });

  it("aggregates cross-package imports into weighted pairs and drops the same-package import", () => {
    const { nodes, edges } = threePackageFixture();
    const spec = derivePackageOverview(indexOf(nodes, edges));
    const pairs = spec.edges.map((e) => `${e.source}->${e.target}:${e.weight}`);
    expect(pairs).toEqual(["ts:pkgA->ts:pkgB:2", "ts:pkgA->ts:pkgC:1", "ts:pkgB->ts:pkgC:1"]);
    expect(spec.edges.some((e) => e.source === e.target)).toBe(false);
  });

  it("counts a file toward its NEAREST npm package, not an outer workspace-root package", () => {
    // An outer `monorepo` npm package wraps `pkgA`; the file's nearest npm package is pkgA, so the
    // workspace root owns zero files and drops out of the overview (mirrors the real `packages/` root).
    const nodes = [
      npmPkg("ts:monorepo", "monorepo"),
      npmPkg("ts:monorepo/pkgA", "pkgA", "ts:monorepo"),
      node("ts:monorepo/pkgA/x.ts", "module", "ts:monorepo/pkgA", "x.ts"),
    ];
    const spec = derivePackageOverview(indexOf(nodes, []));
    expect(spec.nodes.map((n) => n.id)).toEqual(["ts:monorepo/pkgA"]);
  });

  it("yields no nodes when nothing is tagged as an npm package", () => {
    const nodes = [node("ts:x", "package", undefined, "x"), node("ts:x/a.ts", "module", "ts:x", "a.ts")];
    expect(derivePackageOverview(indexOf(nodes, [])).nodes).toEqual([]);
  });
});

describe("packageEntryModule", () => {
  it("prefers a conventional entry-named module within the package", () => {
    const { nodes, edges } = threePackageFixture();
    expect(packageEntryModule(indexOf(nodes, edges), "ts:pkgA")).toBe("ts:pkgA/src/index.ts");
  });

  it("falls back to the shallowest module when none is entry-named", () => {
    const nodes = [
      npmPkg("ts:pkgD", "pkgD"),
      node("ts:pkgD/deep", "package", "ts:pkgD", "deep"),
      node("ts:pkgD/top.ts", "module", "ts:pkgD", "top.ts"),
      node("ts:pkgD/deep/inner.ts", "module", "ts:pkgD/deep", "inner.ts"),
    ];
    expect(packageEntryModule(indexOf(nodes, []), "ts:pkgD")).toBe("ts:pkgD/top.ts");
  });

  it("returns null for a package that owns no module", () => {
    expect(packageEntryModule(indexOf([npmPkg("ts:empty", "empty")], []), "ts:empty")).toBeNull();
  });
});
