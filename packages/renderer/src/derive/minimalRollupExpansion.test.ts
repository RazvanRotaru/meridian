import { describe, expect, it } from "vitest";
import type { GraphArtifact, GraphNode } from "@meridian/core";
import { buildGraphIndex } from "../graph/graphIndex";
import type { ModuleTree, ModuleTreeEdge, VisibleModuleNode } from "./moduleTree";
import { minimalRollupExpansions } from "./minimalRollupExpansion";

const ROOT = "p:root";
const SRC = "p:src";
const NESTED = "p:src/nested";
const FILE_A = "m:a";
const FILE_B = "m:b";

function artifactNode(id: string, kind: "package" | "module", parentId: string | null): GraphNode {
  return {
    id,
    kind,
    qualifiedName: id,
    displayName: id,
    parentId,
    location: { file: id, startLine: 1 },
  } as GraphNode;
}

const index = buildGraphIndex({
  nodes: [
    artifactNode(ROOT, "package", null),
    artifactNode(SRC, "package", ROOT),
    artifactNode(FILE_A, "module", SRC),
    artifactNode(NESTED, "package", SRC),
    artifactNode(FILE_B, "module", NESTED),
  ],
  edges: [],
} as unknown as GraphArtifact);

function node(
  id: string,
  parentId: string | null,
  kind: "package" | "file",
  depth: number,
  isExpanded: boolean,
): VisibleModuleNode {
  const isContainer = kind === "package";
  return {
    id,
    parentId,
    kind,
    depth,
    isContainer,
    isExpanded,
    childCount: isContainer ? 2 : 0,
    data: kind === "package"
      ? { label: id, fileCount: 2, ca: 0, ce: 0, isContainer, isExpanded }
      : { label: id, fullPath: id, category: "source", inCount: 0, outCount: 0 },
  } as VisibleModuleNode;
}

function edge(id: string, source: string, target: string): ModuleTreeEdge {
  return {
    id,
    source,
    target,
    weight: 1,
    crossFrame: false,
    crossPackage: false,
    outsideView: false,
    category: "import",
    relationKind: "imports",
  };
}

describe("minimalRollupExpansions", () => {
  it("detaches an expanded canonical package while retaining its visible children", () => {
    const tree: ModuleTree = {
      effectiveFocus: null,
      nodes: [
        node(ROOT, null, "package", 0, true),
        node(SRC, ROOT, "package", 1, true),
        node(FILE_A, SRC, "file", 2, false),
        node(NESTED, SRC, "package", 2, false),
      ],
      edges: [
        edge("inside", FILE_A, NESTED),
        edge("outside", ROOT, SRC),
      ],
    };

    const [expansion] = minimalRollupExpansions(tree, index, new Set([SRC]));

    expect(expansion.rootId).toBe(SRC);
    expect(expansion.frontierIds).toEqual([FILE_A, NESTED]);
    expect(expansion.nodes).toEqual([
      expect.objectContaining({ id: SRC, parentId: null, depth: 0, isExpanded: true }),
      expect.objectContaining({ id: FILE_A, parentId: SRC, depth: 1 }),
      expect.objectContaining({ id: NESTED, parentId: SRC, depth: 1 }),
    ]);
    expect(expansion.edges.map((candidate) => candidate.id)).toEqual(["inside"]);
  });

  it("lets the ancestor-most open rollup own a nested open rollup exactly once", () => {
    const tree: ModuleTree = {
      effectiveFocus: null,
      nodes: [
        node(ROOT, null, "package", 0, true),
        node(SRC, ROOT, "package", 1, true),
        node(FILE_A, SRC, "file", 2, false),
        node(NESTED, SRC, "package", 2, true),
        node(FILE_B, NESTED, "file", 3, false),
      ],
      edges: [],
    };

    const expansions = minimalRollupExpansions(tree, index, new Set([SRC, NESTED]));

    expect(expansions).toHaveLength(1);
    expect(expansions[0].rootId).toBe(SRC);
    expect(expansions[0].frontierIds).toEqual([FILE_A, FILE_B]);
    expect(expansions[0].nodes.map((candidate) => candidate.id)).toEqual([SRC, FILE_A, NESTED, FILE_B]);
  });
});
