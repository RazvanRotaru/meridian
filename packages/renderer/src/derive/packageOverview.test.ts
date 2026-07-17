import { describe, expect, it } from "vitest";
import type { GraphArtifact, GraphNode } from "@meridian/core";
import { buildGraphIndex } from "../graph/graphIndex";
import { packageEntryModule } from "./packageOverview";

describe("packageEntryModule", () => {
  it("prefers a conventional entry-named module within the package", () => {
    const nodes = [
      npmPackage("ts:pkgA", "pkgA"),
      node("ts:pkgA/src", "package", "ts:pkgA", "src"),
      node("ts:pkgA/src/helper.ts", "module", "ts:pkgA/src", "helper.ts"),
      node("ts:pkgA/src/index.ts", "module", "ts:pkgA/src", "index.ts"),
    ];
    expect(packageEntryModule(indexOf(nodes), "ts:pkgA")).toBe("ts:pkgA/src/index.ts");
  });

  it("falls back to the shallowest module when none is entry-named", () => {
    const nodes = [
      npmPackage("ts:pkgD", "pkgD"),
      node("ts:pkgD/deep", "package", "ts:pkgD", "deep"),
      node("ts:pkgD/top.ts", "module", "ts:pkgD", "top.ts"),
      node("ts:pkgD/deep/inner.ts", "module", "ts:pkgD/deep", "inner.ts"),
    ];
    expect(packageEntryModule(indexOf(nodes), "ts:pkgD")).toBe("ts:pkgD/top.ts");
  });

  it("returns null for a package that owns no module", () => {
    expect(packageEntryModule(indexOf([npmPackage("ts:empty", "empty")]), "ts:empty")).toBeNull();
  });
});

function indexOf(nodes: GraphNode[]) {
  const artifact: GraphArtifact = {
    schemaVersion: "1.1.0",
    generatedAt: "2026-07-16T00:00:00.000Z",
    generator: { name: "test", version: "0" },
    target: { name: "fixture", root: ".", language: "typescript" },
    nodes,
    edges: [],
  };
  return buildGraphIndex(artifact);
}

function node(id: string, kind: string, parentId?: string, displayName?: string): GraphNode {
  return {
    id,
    kind,
    qualifiedName: id,
    displayName: displayName ?? id,
    parentId: parentId ?? null,
    location: { file: id, startLine: 1 },
  };
}

function npmPackage(id: string, displayName: string, parentId?: string): GraphNode {
  return { ...node(id, "package", parentId, displayName), tags: ["npm-package"] };
}
