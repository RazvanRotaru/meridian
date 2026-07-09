import { describe, expect, it } from "vitest";
import type { GraphArtifact, GraphEdge, GraphNode, LogicFlows } from "@meridian/core";
import { buildGraphIndex } from "../graph/graphIndex";
import { buildBlockDeps } from "./blockDeps";
import { moduleChildContainerIds } from "./moduleChildContainers";
import { buildModuleGraph } from "./moduleGraph";
import { deriveModuleTree } from "./moduleTree";

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

function treeOf(nodes: GraphNode[], edges: GraphEdge[], focus: string | null, expanded: string[], flows: LogicFlows = {}) {
  const index = buildGraphIndex({ nodes, edges } as GraphArtifact);
  return deriveModuleTree(index, { kind: "focus", focus }, new Set(expanded), buildModuleGraph(index), buildBlockDeps(index), flows);
}

function packageFixture(): { nodes: GraphNode[]; edges: GraphEdge[] } {
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
    importEdge("ts:pkgA/src/index.ts", "ts:pkgA/src/util.ts"),
    importEdge("ts:pkgA/src/index.ts", "ts:pkgB/src/b.ts"),
  ];
  return { nodes, edges };
}

function codeFixture(): { nodes: GraphNode[]; edges: GraphEdge[]; flows: LogicFlows } {
  return {
    nodes: [
      npmPkg("ts:pkg", "pkg"),
      node("ts:pkg/src", "package", "ts:pkg", "src"),
      node("ts:pkg/src/svc.ts", "module", "ts:pkg/src", "svc.ts"),
      node("ts:pkg/src/svc.ts#OrderService", "class", "ts:pkg/src/svc.ts", "OrderService"),
      node("ts:pkg/src/svc.ts#OrderService.place", "method", "ts:pkg/src/svc.ts#OrderService", "place"),
      node("ts:pkg/src/svc.ts#helper", "function", "ts:pkg/src/svc.ts", "helper"),
    ],
    edges: [],
    flows: {
      "ts:pkg/src/svc.ts#OrderService.place": [{ kind: "call", label: "charge", target: null, resolution: "unresolved" }],
      "ts:pkg/src/svc.ts#helper": [{ kind: "call", label: "audit", target: null, resolution: "unresolved" }],
    },
  };
}

describe("moduleChildContainerIds", () => {
  it("returns root package containers when the target is the overview level", () => {
    const { nodes, edges } = packageFixture();
    const tree = treeOf(nodes, edges, null, []);
    expect(moduleChildContainerIds(tree, null)).toEqual(["ts:pkgA", "ts:pkgB"]);
  });

  it("returns direct child containers of an expanded package", () => {
    const { nodes, edges } = packageFixture();
    const tree = treeOf(nodes, edges, null, ["ts:pkgA"]);
    expect(moduleChildContainerIds(tree, "ts:pkgA")).toEqual(["ts:pkgA/src"]);
  });

  it("returns direct file child containers, including units but not their members", () => {
    const { nodes, edges, flows } = codeFixture();
    const tree = treeOf(nodes, edges, "ts:pkg", ["ts:pkg/src/svc.ts", "ts:pkg/src/svc.ts#OrderService"], flows);
    expect(tree.nodes.filter((n) => n.parentId === "ts:pkg/src/svc.ts").map((n) => n.kind)).toEqual(["unit", "block"]);
    expect(moduleChildContainerIds(tree, "ts:pkg/src/svc.ts")).toEqual([
      "ts:pkg/src/svc.ts#OrderService",
      "ts:pkg/src/svc.ts#helper",
    ]);
  });

  it("returns unit child block containers", () => {
    const { nodes, edges, flows } = codeFixture();
    const tree = treeOf(nodes, edges, "ts:pkg", ["ts:pkg/src/svc.ts", "ts:pkg/src/svc.ts#OrderService"], flows);
    expect(moduleChildContainerIds(tree, "ts:pkg/src/svc.ts#OrderService")).toEqual(["ts:pkg/src/svc.ts#OrderService.place"]);
  });

  it("never returns flow steps as child containers", () => {
    const { nodes, edges, flows } = codeFixture();
    const placeId = "ts:pkg/src/svc.ts#OrderService.place";
    const tree = treeOf(nodes, edges, "ts:pkg", ["ts:pkg/src/svc.ts", "ts:pkg/src/svc.ts#OrderService", placeId], flows);
    expect(tree.nodes.some((n) => n.kind === "step" && n.parentId === placeId)).toBe(true);
    expect(moduleChildContainerIds(tree, placeId)).toEqual([]);
  });

  it("returns already-expanded direct child containers so collapse can target them", () => {
    const { nodes, edges } = packageFixture();
    const tree = treeOf(nodes, edges, null, ["ts:pkgA", "ts:pkgA/src"]);
    expect(tree.nodes.find((n) => n.id === "ts:pkgA/src")?.isExpanded).toBe(true);
    expect(moduleChildContainerIds(tree, "ts:pkgA")).toEqual(["ts:pkgA/src"]);
  });
});
