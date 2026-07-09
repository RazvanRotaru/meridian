/**
 * Lay the minimal review graph out with the shared nested-ELK primitives (same engine as the module
 * map and logic flow): `layered` left→right so a caller sits left of what it calls, with file/class
 * frames recursing as ELK containers that hold their block leaves parent-relative — exactly React
 * Flow's parentId semantics. `INCLUDE_CHILDREN` lives on the ROOT ONLY (per-subgraph throws).
 * Deterministic: ELK layered is stable and no Math.random/Date is used.
 */

import type { ElkNode } from "elkjs/lib/elk-api";
import type { Edge, Node } from "@xyflow/react";
import { runElkLayout } from "../layout/elkLayout";
import { buildNestedElkGraph, emitReactFlowNodes, parentRelativePlacement, type ElkNestAdapter } from "../layout/elkNesting";
import type { GraphIndex } from "../graph/graphIndex";
import { deriveReviewNodeGraph, type ReviewGraphNode, type ReviewNodeGraph } from "../derive/reviewNodeGraph";
import type { ChangedFile } from "@meridian/core";

const BLOCK_WIDTH = 232;
const BLOCK_HEIGHT = 60;

const ROOT_OPTIONS: Record<string, string> = {
  "elk.algorithm": "layered",
  "elk.direction": "RIGHT",
  "elk.hierarchyHandling": "INCLUDE_CHILDREN",
  "elk.spacing.nodeNode": "40",
  "elk.layered.spacing.nodeNodeBetweenLayers": "110",
  "elk.spacing.edgeNode": "26",
};

// Top padding leaves room for a frame's title bar; React Flow draws nothing there itself.
const CONTAINER_OPTIONS: Record<string, string> = { "elk.padding": "[top=42,left=16,bottom=16,right=16]" };

const adapter: ElkNestAdapter<ReviewGraphNode> = {
  id: (node) => node.id,
  parentId: (node) => node.parentId,
  isContainer: (node) => node.isContainer,
  leafSize: () => ({ width: BLOCK_WIDTH, height: BLOCK_HEIGHT }),
  containerOptions: CONTAINER_OPTIONS,
};

export interface ReviewNodeLayout {
  nodes: Node[];
  edges: Edge[];
  affectedIds: Set<string>;
  unmapped: ChangedFile[];
}

/** Derive the code-block graph for the changed set and run it through ELK into React Flow shape. */
export async function deriveReviewNodeLayout(index: GraphIndex, changedFiles: readonly ChangedFile[]): Promise<ReviewNodeLayout> {
  const graph = deriveReviewNodeGraph(index, changedFiles);
  if (graph.nodes.length === 0) {
    return { nodes: [], edges: [], affectedIds: graph.affectedIds, unmapped: graph.unmapped };
  }
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const laid = await runElkLayout(buildNestedElkGraph(graph.nodes, graph.edges, adapter, ROOT_OPTIONS));
  const placed = emitReactFlowNodes(laid, (elkNode, parentId) => toNode(elkNode, parentId, byId));
  return { nodes: placed, edges: graph.edges.map(toEdge), affectedIds: graph.affectedIds, unmapped: graph.unmapped };
}

function toNode(elkNode: ElkNode, parentId: string | undefined, byId: Map<string, ReviewGraphNode>): Node | null {
  const node = byId.get(elkNode.id);
  if (!node) {
    return null;
  }
  const placement = parentRelativePlacement(elkNode, parentId);
  return {
    id: node.id,
    type: node.kind,
    position: placement.position,
    style: { width: placement.width, height: placement.height },
    data: { ...node.data, isContainer: node.isContainer },
    ...(placement.parentId ? { parentId: placement.parentId, extent: placement.extent } : {}),
  };
}

function toEdge(edge: ReviewNodeGraph["edges"][number]): Edge {
  return { id: edge.id, source: edge.source, target: edge.target, data: { kind: edge.kind } };
}
