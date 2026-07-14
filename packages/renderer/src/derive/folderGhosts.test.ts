import { describe, expect, it } from "vitest";
import type { GraphArtifact, GraphEdge, GraphNode } from "@meridian/core";
import { buildGraphIndex } from "../graph/graphIndex";
import { buildBlockDeps } from "./blockDeps";
import type { GhostData } from "./ghostDeps";
import { buildModuleGraph } from "./moduleGraph";
import { deriveModuleTree } from "./moduleTree";
import type { ModuleTree } from "./moduleTreeTypes";
import { deriveUiTree } from "./uiTree";

function node(id: string, kind: string, parentId: string | null, displayName = id): GraphNode {
  return {
    id,
    kind,
    parentId,
    displayName,
    qualifiedName: id.startsWith("ts:") ? id.slice(3) : id,
    location: { file: id, startLine: 1 },
  } as GraphNode;
}

function relationship(
  id: string,
  kind: string,
  source: string,
  target: string,
  weight = 1,
): GraphEdge {
  return { id, kind, source, target, weight, resolution: "resolved" } as GraphEdge;
}

function mapTree(nodes: GraphNode[], edges: GraphEdge[], focus: string): ModuleTree {
  const index = buildGraphIndex({ nodes, edges } as GraphArtifact);
  return deriveModuleTree(
    index,
    focus,
    new Set(),
    buildModuleGraph(index),
    buildBlockDeps(index),
    {},
    new Set(),
    new Set(),
    false,
  );
}

function uiTree(nodes: GraphNode[], edges: GraphEdge[], focus: string): ModuleTree {
  const index = buildGraphIndex({ nodes, edges } as GraphArtifact);
  return deriveUiTree(index, focus, new Set(), buildModuleGraph(index), buildBlockDeps(index), {});
}

function packageGhostIds(tree: ModuleTree): string[] {
  return tree.nodes
    .filter((entry) => entry.kind === "ghost" && (entry.data as GhostData).ghostKind === "package")
    .map((entry) => entry.id)
    .sort();
}

describe("folder ghosts — Map package-only frontier", () => {
  it("does not project a hidden contract method's implementedBy edge onto folder ghosts", () => {
    const nodes = [
      node("ts:app", "package", null),
      node("ts:app/contracts", "package", "ts:app"),
      node("ts:app/contracts/store.ts", "module", "ts:app/contracts"),
      node("ts:app/contracts/store.ts#Store", "interface", "ts:app/contracts/store.ts"),
      node("ts:app/contracts/store.ts#Store.save", "method", "ts:app/contracts/store.ts#Store"),
      node("ts:app/unused", "package", "ts:app"),
      node("ts:app/unused/u.ts", "module", "ts:app/unused"),
      node("ts:lib", "package", null),
      node("ts:lib/repository", "package", "ts:lib"),
      node("ts:lib/repository/repository.ts", "module", "ts:lib/repository"),
      node("ts:lib/repository/repository.ts#Repository", "class", "ts:lib/repository/repository.ts"),
      node("ts:lib/repository/repository.ts#Repository.save", "method", "ts:lib/repository/repository.ts#Repository"),
    ];
    const edge = relationship(
      "implemented-by:save",
      "implementedBy",
      "ts:app/contracts/store.ts#Store.save",
      "ts:lib/repository/repository.ts#Repository.save",
    );

    const tree = mapTree(nodes, [edge], "ts:app");
    expect(packageGhostIds(tree)).toEqual([]);
    expect(tree.edges.some((entry) => entry.depKind === "implementedBy")).toBe(false);
  });

  it("aggregates descendant imports/couplings into one comparable-depth peer folder", () => {
    const nodes = [
      node("ts:app", "package", null, "app"),
      node("ts:app/feature", "package", "ts:app", "feature"),
      node("ts:app/feature/a.ts", "module", "ts:app/feature", "a.ts"),
      node("ts:app/feature/a.ts#run", "function", "ts:app/feature/a.ts", "run"),
      node("ts:app/unused", "package", "ts:app", "unused"),
      node("ts:app/unused/u.ts", "module", "ts:app/unused", "u.ts"),
      node("ts:lib", "package", null, "lib"),
      node("ts:lib/domain", "package", "ts:lib", "domain"),
      node("ts:lib/domain/deep", "package", "ts:lib/domain", "deep"),
      node("ts:lib/domain/deep/one.ts", "module", "ts:lib/domain/deep", "one.ts"),
      node("ts:lib/domain/deep/one.ts#work", "function", "ts:lib/domain/deep/one.ts", "work"),
      node("ts:lib/domain/deep/two.ts", "module", "ts:lib/domain/deep", "two.ts"),
    ];
    const edges = [
      relationship("imp:one", "imports", "ts:app/feature/a.ts", "ts:lib/domain/deep/one.ts", 2),
      relationship("imp:two", "imports", "ts:app/feature/a.ts", "ts:lib/domain/deep/two.ts", 3),
      relationship("call:work", "calls", "ts:app/feature/a.ts#run", "ts:lib/domain/deep/one.ts#work", 4),
    ];

    const tree = mapTree(nodes, edges, "ts:app");
    expect(tree.nodes.filter((entry) => entry.kind !== "ghost").map((entry) => entry.id)).toEqual([
      "ts:app/feature",
      "ts:app/unused",
    ]);
    // The anchor is the second package in its chain, so the far endpoint rises to lib/domain — not
    // its files/symbols and not the deeper folder that happens to contain them.
    expect(packageGhostIds(tree)).toEqual(["ts:lib/domain"]);
    expect((tree.nodes.find((entry) => entry.id === "ts:lib/domain")?.data as GhostData).members).toEqual([
      "ts:lib/domain/deep/one.ts",
      "ts:lib/domain/deep/two.ts",
    ]);
    expect(tree.nodes.some((entry) => entry.id === "ts:lib/domain/deep")).toBe(false);
    expect(tree.nodes.some((entry) => entry.id.endsWith("one.ts") || entry.id.endsWith("#work"))).toBe(false);

    const imports = tree.edges.find((edge) => edge.ghost && edge.depKind === "imports");
    expect(imports).toMatchObject({
      source: "ts:app/feature",
      target: "ts:lib/domain",
      weight: 5,
      underlyingEdgeIds: ["imp:one", "imp:two"],
    });
    expect(tree.edges.find((edge) => edge.ghost && edge.depKind === "calls")).toMatchObject({
      source: "ts:app/feature",
      target: "ts:lib/domain",
      weight: 4,
      underlyingEdgeIds: ["call:work"],
    });
  });

  it("does not ghost a folder when both descendant endpoints lift to visible folder peers", () => {
    const nodes = [
      node("ts:app", "package", null),
      node("ts:app/feature", "package", "ts:app"),
      node("ts:app/feature/a.ts", "module", "ts:app/feature"),
      node("ts:app/other", "package", "ts:app"),
      node("ts:app/other/b.ts", "module", "ts:app/other"),
    ];
    const tree = mapTree(
      nodes,
      [relationship("imp:internal", "imports", "ts:app/feature/a.ts", "ts:app/other/b.ts")],
      "ts:app",
    );

    expect(packageGhostIds(tree)).toEqual([]);
    expect(tree.edges.filter((edge) => edge.ghost)).toEqual([]);
    expect(tree.edges.find((edge) => edge.category === "import")).toMatchObject({
      source: "ts:app/feature",
      target: "ts:app/other",
    });
  });

  it("keeps every incoming and outgoing folder peer beyond the former twenty-item window", () => {
    const nodes: GraphNode[] = [
      node("ts:app", "package", null),
      node("ts:app/feature", "package", "ts:app"),
      node("ts:app/feature/a.ts", "module", "ts:app/feature"),
      node("ts:app/unused", "package", "ts:app"),
      node("ts:app/unused/u.ts", "module", "ts:app/unused"),
    ];
    const edges: GraphEdge[] = [];
    for (const direction of ["in", "out"] as const) {
      for (let i = 0; i < 22; i += 1) {
        const root = `ts:${direction}${i}`;
        const peer = `${root}/peer`;
        const file = `${peer}/p.ts`;
        nodes.push(node(root, "package", null), node(peer, "package", root), node(file, "module", peer));
        const source = direction === "out" ? "ts:app/feature/a.ts" : file;
        const target = direction === "out" ? file : "ts:app/feature/a.ts";
        // Equal scores intentionally exercise the stable peer-id tie break.
        edges.push(relationship(`${direction}:${i}`, "imports", source, target));
      }
    }

    const tree = mapTree(nodes, edges.reverse(), "ts:app");
    const expected = [
      ...Array.from({ length: 22 }, (_, index) => `ts:in${index}/peer`),
      ...Array.from({ length: 22 }, (_, index) => `ts:out${index}/peer`),
    ].sort();
    expect(packageGhostIds(tree)).toEqual(expected);
    const ghostEdges = tree.edges.filter((edge) => edge.ghost);
    expect(ghostEdges).toHaveLength(44);
    expect(ghostEdges.filter((edge) => edge.target === "ts:app/feature")).toHaveLength(22);
    expect(ghostEdges.filter((edge) => edge.source === "ts:app/feature")).toHaveLength(22);
    expect(ghostEdges.every((edge) => edge.underlyingEdgeIds?.length === 1)).toBe(true);
  });
});

describe("folder ghosts — UI package-only frontier", () => {
  it("projects descendant renders relationships onto peer folders", () => {
    const nodes = [
      node("ts:app", "package", null),
      node("ts:app/ui", "package", "ts:app"),
      node("ts:app/ui/App.tsx", "module", "ts:app/ui"),
      node("ts:app/ui/App.tsx#App", "function", "ts:app/ui/App.tsx"),
      node("ts:app/unused", "package", "ts:app"),
      node("ts:app/unused/u.ts", "module", "ts:app/unused"),
      node("ts:lib", "package", null),
      node("ts:lib/components", "package", "ts:lib"),
      node("ts:lib/components/deep", "package", "ts:lib/components"),
      node("ts:lib/components/deep/Button.tsx", "module", "ts:lib/components/deep"),
      node("ts:lib/components/deep/Button.tsx#Button", "function", "ts:lib/components/deep/Button.tsx"),
    ];
    const edge = relationship(
      "renders:button",
      "renders",
      "ts:app/ui/App.tsx#App",
      "ts:lib/components/deep/Button.tsx#Button",
      3,
    );

    const tree = uiTree(nodes, [edge], "ts:app");
    expect(packageGhostIds(tree)).toEqual(["ts:lib/components"]);
    expect(tree.edges.find((entry) => entry.ghost)).toMatchObject({
      source: "ts:app/ui",
      target: "ts:lib/components",
      weight: 3,
      depKind: "renders",
      underlyingEdgeIds: ["renders:button"],
    });
  });
});
