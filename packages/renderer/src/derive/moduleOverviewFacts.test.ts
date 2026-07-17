import { describe, expect, it } from "vitest";
import {
  type GraphArtifact,
  type GraphEdge,
  type GraphNode,
  type GraphStructureFacts,
} from "@meridian/core";
import { buildGraphIndex, type GraphIndex } from "../graph/graphIndex";
import { buildBlockDeps } from "./blockDeps";
import { buildModuleGraph } from "./moduleGraph";
import { deriveModuleTree, type ModuleGroupData, type ModuleTree } from "./moduleTree";
import { deriveUiTree } from "./uiTree";

const NODES: GraphNode[] = [
  node("pkg:a", "package", null, "orders", ["npm-package"]),
  node("pkg:a/index.ts", "module", "pkg:a", "index.ts"),
  node("pkg:a/index.ts#place", "function", "pkg:a/index.ts", "place"),
  node("pkg:a/worker.ts", "module", "pkg:a", "worker.ts"),
  node("pkg:b", "package", null, "billing", ["npm-package"]),
  node("pkg:b/index.ts", "module", "pkg:b", "index.ts"),
  node("pkg:b/index.ts#charge", "function", "pkg:b/index.ts", "charge"),
];

const EDGES: GraphEdge[] = [
  edge("import:orders-billing", "pkg:a/index.ts", "pkg:b/index.ts", "imports", 2),
  edge("call:place-charge", "pkg:a/index.ts#place", "pkg:b/index.ts#charge", "calls", 3),
];

describe("authoritative module overview facts", () => {
  const fullIndex = buildGraphIndex(artifact(NODES, EDGES));
  const projectedIndex = projectionIndex(fullIndex.structure);

  it("keeps complete root totals and typed evidence when only overview roots are resident", () => {
    const full = mapTree(fullIndex);
    const projected = mapTree(projectedIndex);

    expect(projected.nodes.map((entry) => entry.id)).toEqual(["pkg:a", "pkg:b"]);
    expect(projected.nodes.map((entry) => entry.data as ModuleGroupData)).toMatchObject([
      { label: "orders", fileCount: 2, ca: 0, ce: 1 },
      { label: "billing", fileCount: 1, ca: 1, ce: 0 },
    ]);
    expect(projected.edges).toEqual([
      expect.objectContaining({
        source: "pkg:a",
        target: "pkg:b",
        category: "dep",
        relationKind: "calls",
        weight: 3,
        crossPackage: true,
        underlyingEdgeIds: ["call:place-charge"],
      }),
      expect.objectContaining({
        source: "pkg:a",
        target: "pkg:b",
        category: "import",
        relationKind: "imports",
        weight: 2,
        crossPackage: true,
        underlyingEdgeIds: ["import:orders-billing"],
      }),
    ]);

    // Full artifacts run through the same complete-revision facts instead of a second renderer
    // derivation, so local and projected navigation have identical overview semantics.
    expect(projected.nodes).toEqual(full.nodes);
    expect(projected.edges).toEqual(full.edges);
  });

  it("uses the same overview facts as the UI lens's no-renders fallback", () => {
    const map = mapTree(projectedIndex);
    const ui = uiTree(projectedIndex);

    expect(ui.nodes).toEqual(map.nodes);
    expect(ui.edges).toEqual(map.edges);
  });
});

function mapTree(index: GraphIndex): ModuleTree {
  return deriveModuleTree(
    index,
    null,
    new Set(),
    buildModuleGraph(index),
    buildBlockDeps(index),
    {},
    new Set(),
    new Set(),
    false,
  );
}

function uiTree(index: GraphIndex): ModuleTree {
  return deriveUiTree(
    index,
    null,
    new Set(),
    buildModuleGraph(index),
    buildBlockDeps(index),
    {},
  );
}

function projectionIndex(fullStructure: GraphStructureFacts): GraphIndex {
  const projectedNodes = NODES.filter((entry) => entry.kind === "package");
  return buildGraphIndex(artifact(projectedNodes, []), {
    artifactComplete: false,
    graphSummary: {
      schemaVersion: "1.1.0",
      generatedAt: "2026-07-16T00:00:00.000Z",
      nodeCount: NODES.length,
      edgeCount: EDGES.length,
    },
    structure: {
      ...fullStructure,
      hierarchyById: new Map(projectedNodes.map((entry) => [entry.id, fullStructure.hierarchyById.get(entry.id)!])),
    },
  });
}

function artifact(nodes: GraphNode[], edges: GraphEdge[]): GraphArtifact {
  return {
    schemaVersion: "1.1.0",
    generatedAt: "2026-07-16T00:00:00.000Z",
    generator: { name: "test", version: "0" },
    target: { name: "fixture", root: ".", language: "typescript" },
    nodes,
    edges,
  };
}

function node(
  id: string,
  kind: string,
  parentId: string | null,
  displayName: string,
  tags?: string[],
): GraphNode {
  return {
    id,
    kind,
    parentId,
    displayName,
    qualifiedName: id,
    location: { file: id, startLine: 1 },
    ...(tags === undefined ? {} : { tags }),
  };
}

function edge(
  id: string,
  source: string,
  target: string,
  kind: string,
  weight: number,
): GraphEdge {
  return { id, source, target, kind, weight, resolution: "resolved" };
}
