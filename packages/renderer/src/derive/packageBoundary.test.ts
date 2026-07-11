import { describe, expect, it } from "vitest";
import type { GraphArtifact, GraphEdge, GraphNode } from "@meridian/core";
import { buildGraphIndex } from "../graph/graphIndex";
import {
  crossesPackageBoundary,
  npmPackageIdOf,
  packageScopeOf,
  underlyingEdgesCrossPackage,
} from "./packageBoundary";

function node(id: string, kind: string, parentId: string | null = null, tags?: string[]): GraphNode {
  return {
    id,
    kind,
    qualifiedName: id,
    displayName: id,
    parentId,
    location: { file: id, startLine: 1 },
    ...(tags ? { tags } : {}),
  };
}

function edge(id: string, source: string, target: string): GraphEdge {
  return { id, source, target, kind: "calls", resolution: "resolved" };
}

const NODES: GraphNode[] = [
  node("ts:src", "package"),
  node("ts:src/a.ts", "module", "ts:src"),
  node("ts:packages", "package"),
  node("ts:packages/a", "package", "ts:packages", ["npm-package"]),
  node("ts:packages/a/src", "package", "ts:packages/a"),
  node("ts:packages/a/src/a.ts", "module", "ts:packages/a/src"),
  node("ts:packages/a/nested", "package", "ts:packages/a", ["npm-package"]),
  node("ts:packages/a/nested/n.ts", "module", "ts:packages/a/nested"),
  node("ts:packages/b", "package", "ts:packages", ["npm-package"]),
  node("ts:packages/b/b.ts", "module", "ts:packages/b"),
  node("sys:web", "system"),
  node("ts:web/src", "package", "sys:web"),
  node("ts:web/src/a.ts", "module", "ts:web/src"),
  node("sys:api", "system"),
  node("ts:api/src", "package", "sys:api"),
  node("ts:api/src/a.ts", "module", "ts:api/src"),
];

const EDGES = [
  edge("same-root", "ts:src/a.ts", "ts:src"),
  edge("same-package", "ts:packages/a/src/a.ts", "ts:packages/a"),
  edge("cross-package", "ts:packages/a/src/a.ts", "ts:packages/b/b.ts"),
];

const INDEX = buildGraphIndex({ nodes: NODES, edges: EDGES } as GraphArtifact);

describe("packageBoundary", () => {
  it("uses the nearest npm-package ancestor, including a nested package", () => {
    expect(npmPackageIdOf("ts:packages/a/src/a.ts", INDEX.nodesById)).toBe("ts:packages/a");
    expect(npmPackageIdOf("ts:packages/a/nested/n.ts", INDEX.nodesById)).toBe("ts:packages/a/nested");
  });

  it("treats untagged single-package code as one implicit artifact-root package", () => {
    expect(packageScopeOf("ts:src/a.ts", INDEX)).toBe(packageScopeOf("ts:src", INDEX));
    expect(crossesPackageBoundary("ts:src/a.ts", "ts:src", INDEX)).toBe(false);
  });

  it("uses system ancestors to keep linked implicit roots distinct", () => {
    expect(packageScopeOf("ts:web/src/a.ts", INDEX)).not.toBe(packageScopeOf("ts:api/src/a.ts", INDEX));
    expect(crossesPackageBoundary("ts:web/src/a.ts", "ts:api/src/a.ts", INDEX)).toBe(true);
  });

  it("classifies boundary pseudo-ids and unknown endpoints as outside every package", () => {
    expect(crossesPackageBoundary("ts:src/a.ts", "ext:lib/index.d.ts#run", INDEX)).toBe(true);
    expect(crossesPackageBoundary("ts:src/a.ts", "unresolved:?", INDEX)).toBe(true);
    expect(crossesPackageBoundary("ts:src/a.ts", "ts:missing.ts#run", INDEX)).toBe(true);
  });

  it("classifies aggregates from their original artifact edges, with any crossing constituent winning", () => {
    expect(underlyingEdgesCrossPackage(["same-root", "same-package"], INDEX)).toBe(false);
    expect(underlyingEdgesCrossPackage(["same-package", "cross-package"], INDEX)).toBe(true);
  });
});
