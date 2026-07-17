import { describe, expect, it } from "vitest";
import { deriveGraphStructure, type GraphArtifact, type GraphNode } from "@meridian/core";
import { buildGraphIndex } from "../../graph/graphIndex";
import { countKinds } from "./ControlPanelHeader";

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

describe("ControlPanelHeader counts", () => {
  it("counts structural Python roots beside npm TypeScript roots", () => {
    const nodes = [
      node("ts:web", "package", null, ["npm-package"]),
      node("ts:web/index.ts", "module", "ts:web"),
      node("py:backend", "package"),
      node("py:backend.app", "module", "py:backend"),
    ];
    const index = buildGraphIndex({ nodes, edges: [] } as unknown as GraphArtifact);

    expect(countKinds(index)).toEqual({ packages: 2, files: 2 });
  });

  it("does not call a package-less module a package", () => {
    const nodes = [node("py:settings", "module")];
    const index = buildGraphIndex({ nodes, edges: [] } as unknown as GraphArtifact);

    expect(countKinds(index)).toEqual({ packages: 0, files: 1 });
  });

  it("keeps repository totals stable while the active index is a bounded slice", () => {
    const allNodes = [
      node("ts:src", "package"),
      node("ts:src/a.ts", "module", "ts:src"),
      node("ts:tests", "package"),
      node("ts:tests/a.test.ts", "module", "ts:tests"),
    ];
    const structure = deriveGraphStructure(allNodes, []);
    const visible = allNodes.slice(0, 2);
    const index = buildGraphIndex(
      { nodes: visible, edges: [] } as unknown as GraphArtifact,
      {
        structure: {
          ...structure,
          hierarchyById: new Map(visible.map((entry) => [entry.id, structure.hierarchyById.get(entry.id)!])),
          moduleOverviewRootIds: ["ts:src"],
        },
      },
    );

    expect(countKinds(index)).toEqual({ packages: 2, files: 2 });
  });
});
