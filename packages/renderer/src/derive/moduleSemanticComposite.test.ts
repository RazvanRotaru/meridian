import type { Edge, Node } from "@xyflow/react";
import { describe, expect, it } from "vitest";
import {
  composeSemanticStackLayouts,
  prepareSemanticModuleStack,
  retainSemanticStackFromDepth,
  semanticLayerClass,
  SEMANTIC_CONTEXT_CLASS,
  SEMANTIC_CONTEXT_EDGE_CLASS,
  SEMANTIC_DETAIL_CLASS,
  SEMANTIC_DETAIL_EDGE_CLASS,
  SEMANTIC_LAYER_CLASS,
  SEMANTIC_PARENT_CLASS,
  type LaidModuleGraph,
  type ModuleSemanticStack,
  type SemanticAncestorLevel,
} from "./moduleSemanticComposite";
import type { ModuleTree, ModuleTreeEdge, VisibleModuleNode } from "./moduleTreeTypes";

const ANCHOR = "ts:packages/app";
const ROOT_ANCHOR = "ts:packages";
const DETAIL_A = "ts:packages/app/src/a.ts";
const DETAIL_A_UNIT = "ts:packages/app/src/a.ts#A";
const DETAIL_B = "ts:packages/app/src/b.ts";
const INBOUND_NEIGHBOUR = "ts:packages/consumer";
const OUTBOUND_NEIGHBOUR = "ts:packages/library";
const UNRELATED = "ts:packages/unrelated";
const ROOT_NEIGHBOUR = "ts:other-system";
const GHOST = "ts:packages/ghost/src/definition.ts#outside";

function packageNode(id: string): VisibleModuleNode {
  return {
    id,
    parentId: null,
    kind: "package",
    isContainer: true,
    isExpanded: false,
    depth: 0,
    childCount: 1,
    data: {
      label: id.split("/").pop() ?? id,
      fileCount: 1,
      ca: 0,
      ce: 0,
      isContainer: true,
      isExpanded: false,
    },
  };
}

function fileNode(id: string): VisibleModuleNode {
  return {
    id,
    parentId: null,
    kind: "file",
    isContainer: false,
    isExpanded: false,
    depth: 0,
    childCount: 0,
    data: {
      label: id.split("/").pop() ?? id,
      fullPath: id,
      category: "app",
      inCount: 0,
      outCount: 0,
      isEntry: false,
      isContainer: false,
      isExpanded: false,
      unitCount: 0,
    },
  };
}

function unitNode(id: string, parentId: string): VisibleModuleNode {
  return {
    id,
    parentId,
    kind: "unit",
    isContainer: false,
    isExpanded: false,
    depth: 1,
    childCount: 0,
    data: {
      label: "A",
      unitKind: "class",
      memberCount: 0,
      isContainer: false,
      isExpanded: false,
      isFrame: false,
    },
  };
}

function ghostNode(id: string): VisibleModuleNode {
  return {
    id,
    parentId: null,
    kind: "ghost",
    isContainer: false,
    isExpanded: false,
    depth: 0,
    childCount: 0,
    data: { label: "outside", context: "ghost.ts", ghostKind: "function" },
  };
}

function wire(
  id: string,
  source: string,
  target: string,
  overrides: Partial<ModuleTreeEdge> = {},
): ModuleTreeEdge {
  return {
    id,
    source,
    target,
    weight: 1,
    crossFrame: false,
    crossPackage: false,
    outsideView: false,
    category: "import",
    ...overrides,
  };
}

function level(depth: number, focus: string | null, anchorId: string): SemanticAncestorLevel {
  return { depth, focus, effectiveFocus: focus, anchorId, label: anchorId.split("/").pop() ?? anchorId };
}

function sourceFixture(): {
  detailTree: ModuleTree;
  outerTrees: Array<{ level: SemanticAncestorLevel; tree: ModuleTree }>;
} {
  return {
    detailTree: {
      nodes: [fileNode(DETAIL_A), unitNode(DETAIL_A_UNIT, DETAIL_A), fileNode(DETAIL_B), ghostNode(GHOST)],
      edges: [
        wire("detail-kept", DETAIL_A, DETAIL_B),
        wire("detail-ghost", DETAIL_A, GHOST, { ghost: true, outsideView: true }),
        wire("detail-outside", DETAIL_B, "ts:outside/not-drawn.ts", { outsideView: true }),
      ],
      effectiveFocus: "ts:packages/app/src",
    },
    outerTrees: [
      {
        level: level(1, "ts:packages", ANCHOR),
        tree: {
          nodes: [
            packageNode(INBOUND_NEIGHBOUR),
            packageNode(ANCHOR),
            packageNode(OUTBOUND_NEIGHBOUR),
            packageNode(UNRELATED),
            ghostNode(GHOST),
          ],
          edges: [
            wire("outer-in", INBOUND_NEIGHBOUR, ANCHOR, { crossPackage: true }),
            wire("outer-out", ANCHOR, OUTBOUND_NEIGHBOUR, { crossPackage: true }),
            wire("outer-nonincident", INBOUND_NEIGHBOUR, UNRELATED, { crossPackage: true }),
            wire("outer-ghost", ANCHOR, GHOST, { ghost: true, outsideView: true }),
          ],
          effectiveFocus: "ts:packages",
        },
      },
      {
        level: level(2, null, ROOT_ANCHOR),
        tree: {
          nodes: [packageNode(ROOT_ANCHOR), packageNode(ROOT_NEIGHBOUR)],
          edges: [wire("root-wire", ROOT_ANCHOR, ROOT_NEIGHBOUR, { crossPackage: true })],
          effectiveFocus: null,
        },
      },
    ],
  };
}

function preparedFixture(): ModuleSemanticStack {
  const { detailTree, outerTrees } = sourceFixture();
  return prepareSemanticModuleStack(detailTree, outerTrees);
}

describe("prepareSemanticModuleStack", () => {
  it("keeps detail and every real ancestor graph as separate canonical trees", () => {
    const stack = preparedFixture();

    expect(stack.layers).toHaveLength(3);
    expect(stack.ancestors.map(({ depth, focus, anchorId }) => ({ depth, focus, anchorId }))).toEqual([
      { depth: 1, focus: "ts:packages", anchorId: ANCHOR },
      { depth: 2, focus: null, anchorId: ROOT_ANCHOR },
    ]);
    expect(stack.layers[0].tree.nodes.map((node) => node.id)).toEqual([DETAIL_A, DETAIL_A_UNIT, DETAIL_B, GHOST]);
    expect(stack.layers[0].tree.nodes.find((node) => node.id === DETAIL_A_UNIT)?.parentId).toBe(DETAIL_A);
    expect(stack.layers[1].tree.nodes.map((node) => node.id)).toEqual([
      INBOUND_NEIGHBOUR,
      ANCHOR,
      OUTBOUND_NEIGHBOUR,
      UNRELATED,
    ]);
    expect(stack.layers[1].tree.nodes.find((node) => node.id === ANCHOR)).toMatchObject({
      parentId: null,
      isExpanded: false,
    });
    expect(stack.layers[2].tree.nodes.map((node) => node.id)).toEqual([ROOT_ANCHOR, ROOT_NEIGHBOUR]);

    expect(stack.layers[0].tree.edges.map((edge) => edge.id)).toEqual([
      "semantic:layer:0:detail-kept",
      "semantic:layer:0:detail-ghost",
    ]);
    expect(stack.layers[1].tree.edges.map((edge) => edge.id)).toEqual([
      "semantic:layer:1:outer-in",
      "semantic:layer:1:outer-out",
      "semantic:layer:1:outer-nonincident",
    ]);
    expect(stack.layers[2].tree.edges.map((edge) => edge.id)).toEqual(["semantic:layer:2:root-wire"]);
  });

  it("applies detail-wins-peer and outer-anchor-wins collision policy across the stack", () => {
    const detailChild = `${OUTBOUND_NEIGHBOUR}#Pinned`;
    const detailTree: ModuleTree = {
      nodes: [fileNode(OUTBOUND_NEIGHBOUR), unitNode(detailChild, OUTBOUND_NEIGHBOUR), fileNode(ROOT_ANCHOR), fileNode(DETAIL_B)],
      edges: [wire("anchor-collision", ROOT_ANCHOR, DETAIL_B)],
      effectiveFocus: "ts:packages/app/src",
    };
    const outerTrees = sourceFixture().outerTrees;

    const stack = prepareSemanticModuleStack(detailTree, outerTrees);

    // The pinned detail copy wins over a non-anchor peer at depth 1 and keeps its child.
    expect(stack.layers[0].tree.nodes.find((node) => node.id === OUTBOUND_NEIGHBOUR)).toMatchObject({ kind: "file" });
    expect(stack.layers[0].tree.nodes.find((node) => node.id === detailChild)?.parentId).toBe(OUTBOUND_NEIGHBOUR);
    expect(stack.layers[1].tree.nodes.some((node) => node.id === OUTBOUND_NEIGHBOUR)).toBe(false);
    // The depth-2 anchor wins its accidental detail copy, while unrelated detail survives.
    expect(stack.layers[0].tree.nodes.map((node) => node.id)).toEqual([OUTBOUND_NEIGHBOUR, detailChild, DETAIL_B]);
    expect(stack.layers[0].tree.edges).toEqual([]);
    expect(stack.layers[2].nodeIds.has(ROOT_ANCHOR)).toBe(true);
  });

  it("truncates at a missing anchor because farther graphs cannot align through it", () => {
    const { detailTree, outerTrees } = sourceFixture();
    const missing = [
      outerTrees[0],
      { ...outerTrees[1], level: level(2, null, "ts:missing") },
    ];

    const stack = prepareSemanticModuleStack(detailTree, missing);

    expect(stack.layers).toHaveLength(2);
    expect(stack.ancestors.map((entry) => entry.anchorId)).toEqual([ANCHOR]);
  });
});

describe("composeSemanticStackLayouts", () => {
  it("rigidly aligns every ancestor anchor to the preceding graph and stamps depth metadata", () => {
    const stack = preparedFixture();
    const detail: LaidModuleGraph = {
      nodes: [
        laidNode(DETAIL_A, 100, 80, 200, 100),
        laidNode(DETAIL_A_UNIT, 20, 30, 50, 30, { parentId: DETAIL_A }),
        laidNode(DETAIL_B, 400, 120, 100, 60),
        laidNode(GHOST, -1_000, -1_000, 100, 40, { type: "ghost" }),
      ],
      edges: laidEdges(stack.layers[0].tree.edges, "semantic:layer:0:detail-kept"),
    };
    const parent: LaidModuleGraph = {
      nodes: [
        laidNode(INBOUND_NEIGHBOUR, 0, 0, 120, 60),
        laidNode(ANCHOR, 300, 100, 160, 80, { className: "existing-node-class" }),
        laidNode(OUTBOUND_NEIGHBOUR, 600, 20, 180, 60),
        laidNode(UNRELATED, 900, 200, 140, 60),
      ],
      edges: laidEdges(stack.layers[1].tree.edges, "semantic:layer:1:outer-in"),
    };
    const grandparent: LaidModuleGraph = {
      nodes: [laidNode(ROOT_ANCHOR, 100, 100, 200, 100), laidNode(ROOT_NEIGHBOUR, 500, 50, 180, 80)],
      edges: laidEdges(stack.layers[2].tree.edges, "semantic:layer:2:root-wire"),
    };

    const composed = composeSemanticStackLayouts([detail, parent, grandparent], stack);
    expect(composed).not.toBeNull();
    const node = (id: string) => composed?.nodes.find((candidate) => candidate.id === id);

    // Detail centre=(300,130); parent anchor centre was (380,140), so depth 1 moves (-80,-10).
    expect(node(ANCHOR)?.position).toEqual({ x: 220, y: 90 });
    expect(node(INBOUND_NEIGHBOUR)?.position).toEqual({ x: -80, y: -10 });
    expect(node(UNRELATED)?.position).toEqual({ x: 820, y: 190 });
    // Shifted depth-1 bounds are x=-80..960, y=-10..250, centre=(440,120). The depth-2 anchor
    // centre was (200,150), so the complete grandparent layer moves (+240,-30).
    expect(node(ROOT_ANCHOR)?.position).toEqual({ x: 340, y: 70 });
    expect(node(ROOT_NEIGHBOUR)?.position).toEqual({ x: 740, y: 20 });
    expect(node(DETAIL_A_UNIT)?.position).toEqual({ x: 20, y: 30 });

    expect(node(ANCHOR)?.className).toContain(SEMANTIC_PARENT_CLASS);
    expect(node(ANCHOR)?.className).toContain(semanticLayerClass(1));
    expect(node(ROOT_ANCHOR)?.className).toContain(semanticLayerClass(2));
    expect(node(INBOUND_NEIGHBOUR)?.className).toContain(SEMANTIC_CONTEXT_CLASS);
    expect(node(DETAIL_A)?.className).toContain(SEMANTIC_DETAIL_CLASS);
    expect(node(DETAIL_A)?.className).toContain(SEMANTIC_LAYER_CLASS);
    expect(node(DETAIL_A)?.data).toMatchObject({ semanticDepth: 0, semanticRole: "detail" });
    expect(node(ANCHOR)?.data).toMatchObject({ semanticDepth: 1, semanticRole: "anchor", semanticAnchorId: ANCHOR });
    expect(node(ROOT_NEIGHBOUR)?.data).toMatchObject({
      semanticDepth: 2,
      semanticRole: "context",
      semanticAnchorId: ROOT_ANCHOR,
    });
    expect(new Set(composed?.nodes.map((candidate) => candidate.id)).size).toBe(composed?.nodes.length);
    expect(composed?.nodes[0].data.semanticDepth).toBe(2);
    expect(composed?.nodes.at(-1)?.data.semanticDepth).toBe(0);

    const detailEdge = composed?.edges.find((edge) => edge.id === "semantic:layer:0:detail-kept");
    const parentEdge = composed?.edges.find((edge) => edge.id === "semantic:layer:1:outer-in");
    const rootEdge = composed?.edges.find((edge) => edge.id === "semantic:layer:2:root-wire");
    expect(detailEdge?.className).toContain(SEMANTIC_DETAIL_EDGE_CLASS);
    expect(detailEdge?.data).toMatchObject({ semanticDepth: 0, semanticRole: "detail" });
    expect(parentEdge?.className).toContain(SEMANTIC_CONTEXT_EDGE_CLASS);
    expect(parentEdge?.data).toMatchObject({ semanticDepth: 1, semanticRole: "context" });
    expect(rootEdge?.className).toContain(semanticLayerClass(2));
  });
});

describe("retainSemanticStackFromDepth", () => {
  it("consumes inner layers without moving or renumbering the committed parent stack", () => {
    const inner = laidNode("inner", 1, 2, 10, 10, { data: { semanticDepth: 0 } });
    const parent = laidNode("parent", 20, 30, 10, 10, { data: { semanticDepth: 1 } });
    const outer = laidNode("outer", 40, 50, 10, 10, { data: { semanticDepth: 2 } });
    const parentEdge: Edge = {
      id: "parent-edge",
      source: "parent",
      target: "parent",
      data: { semanticDepth: 1 },
    };
    const crossLayerEdge: Edge = {
      id: "cross-layer-edge",
      source: "inner",
      target: "parent",
      data: { semanticDepth: 1 },
    };
    const outerEdge: Edge = {
      id: "outer-edge",
      source: "outer",
      target: "outer",
      data: { semanticDepth: 2 },
    };

    const retained = retainSemanticStackFromDepth(
      { nodes: [outer, parent, inner], edges: [outerEdge, parentEdge, crossLayerEdge] },
      1,
    );

    expect(retained?.nodes).toEqual([outer, parent]);
    expect(retained?.nodes[0]).toBe(outer);
    expect(retained?.nodes[1]).toBe(parent);
    expect(retained?.edges).toEqual([outerEdge, parentEdge]);
    expect(retained?.nodes.map((node) => node.data.semanticDepth)).toEqual([2, 1]);
    expect(retainSemanticStackFromDepth({ nodes: [inner], edges: [] }, 1)).toBeNull();
    expect(retainSemanticStackFromDepth({ nodes: [inner], edges: [] }, 1.5)).toBeNull();
  });
});

function laidNode(
  id: string,
  x: number,
  y: number,
  width: number,
  height: number,
  extra: Partial<Node> = {},
): Node {
  return {
    id,
    position: { x, y },
    style: { width, height },
    data: {},
    ...extra,
  };
}

function laidEdges(edges: ModuleTreeEdge[], classedId: string): Edge[] {
  return edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    className: edge.id === classedId ? "existing-edge-class" : undefined,
  }));
}
