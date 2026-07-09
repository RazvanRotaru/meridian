import { describe, expect, it } from "vitest";
import { layoutModuleTree } from "./moduleLevelLayout";
import type { VisibleModuleNode, ModuleTreeEdge } from "../derive/moduleTree";

/** A collapsed leaf file card at the frontier. */
function fileLeaf(id: string): VisibleModuleNode {
  return {
    id,
    parentId: null,
    kind: "file",
    isContainer: false,
    isExpanded: false,
    depth: 0,
    childCount: 0,
    data: { label: id, category: "domain", isEntry: false, isContainer: false, inCount: 0, outCount: 0 } as never,
  };
}

/** An EXPANDED file card (an ELK container) holding one block child — the shape a seeded card takes
 * the moment the reader expands it in the minimal-graph overlay. */
function expandedFileWithBlock(fileId: string, blockId: string): VisibleModuleNode[] {
  return [
    {
      id: fileId,
      parentId: null,
      kind: "file",
      isContainer: true,
      isExpanded: true,
      depth: 0,
      childCount: 1,
      data: { label: fileId, category: "domain", isEntry: false, isContainer: true, inCount: 0, outCount: 0 } as never,
    },
    {
      id: blockId,
      parentId: fileId,
      kind: "block",
      isContainer: false,
      isExpanded: false,
      depth: 1,
      childCount: 0,
      data: { label: blockId, blockKind: "method", callable: true, hasFlow: false } as never,
    },
  ];
}

describe("layoutModuleTree — seeded surface (minimal graph)", () => {
  it("lays out a seeded graph with an EXPANDED container without throwing (ELK INCLUDE_CHILDREN consistency)", async () => {
    // Regression: SEEDED_ROOT_OPTIONS switched the root to INTERACTIVE crossing-minimization while
    // INCLUDE_CHILDREN nested the expanded card's block — leaving the child on the default LAYER_SWEEP
    // made ELK throw UnsupportedGraphException, so expanding a card in the overlay did nothing.
    const nodes: VisibleModuleNode[] = [fileLeaf("A"), ...expandedFileWithBlock("B", "B#run")];
    const edges: ModuleTreeEdge[] = [
      { id: "A->B", source: "A", target: "B", weight: 1, crossFrame: false, category: "import" },
    ];
    const seedPositions = { A: { x: 0, y: 0 }, B: { x: 300, y: 0 } };

    const result = await layoutModuleTree(nodes, edges, seedPositions);

    // The expanded card and its nested block both make it through the layout.
    expect(result.nodes.map((node) => node.id).sort()).toEqual(["A", "B", "B#run"]);
    const block = result.nodes.find((node) => node.id === "B#run");
    expect(block?.parentId).toBe("B");
  });
});
