/**
 * Map the laid-out ELK tree to React Flow nodes/edges.
 *
 * ELK child coordinates are PARENT-RELATIVE, which is exactly React Flow's parentId
 * semantics, so {x,y} maps straight through with `parentId` + `extent: "parent"`. Nodes are
 * emitted in DFS preorder (parents first) because React Flow requires a parent to appear
 * before its children. The nested ELK output is NOT flattened.
 */

import { MarkerType } from "@xyflow/react";
import type { ElkNode } from "elkjs/lib/elk-api";
import type { LiftedEdge, VisibleNode } from "../derive/types";
import { wireColorForKind } from "../theme/edgeColors";
import { ELK_ROOT_ID } from "./buildElkGraph";
import type { BlueprintEdge, BlueprintNode } from "./rfTypes";

export interface ReactFlowGraph {
  nodes: BlueprintNode[];
  edges: BlueprintEdge[];
}

export function toReactFlow(
  laidOut: ElkNode,
  visibleById: Map<string, VisibleNode>,
  liftedEdges: LiftedEdge[],
): ReactFlowGraph {
  const nodes: BlueprintNode[] = [];
  emitChildren(laidOut.children ?? [], undefined, visibleById, nodes);
  return { nodes, edges: liftedEdges.map(toReactFlowEdge) };
}

function emitChildren(
  elkNodes: ElkNode[],
  parentId: string | undefined,
  visibleById: Map<string, VisibleNode>,
  out: BlueprintNode[],
): void {
  for (const elkNode of elkNodes) {
    const visibleNode = visibleById.get(elkNode.id);
    if (!visibleNode || elkNode.id === ELK_ROOT_ID) {
      continue;
    }
    out.push(toReactFlowNode(elkNode, parentId, visibleNode));
    emitChildren(elkNode.children ?? [], elkNode.id, visibleById, out);
  }
}

function toReactFlowNode(
  elkNode: ElkNode,
  parentId: string | undefined,
  visibleNode: VisibleNode,
): BlueprintNode {
  return {
    id: elkNode.id,
    type: visibleNode.isContainer ? "container" : "leaf",
    position: { x: elkNode.x ?? 0, y: elkNode.y ?? 0 },
    width: elkNode.width,
    height: elkNode.height,
    ...(parentId ? { parentId, extent: "parent" as const } : {}),
    data: {
      node: visibleNode.node,
      isContainer: visibleNode.isContainer,
      isExpanded: visibleNode.isExpanded,
      childCount: visibleNode.childCount,
    },
  };
}

function toReactFlowEdge(edge: LiftedEdge): BlueprintEdge {
  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    type: "blueprint",
    // Resolved wires get marching-ants dashes; unresolved wires stay static + dim (honesty).
    animated: edge.resolved,
    markerEnd: { type: MarkerType.ArrowClosed, color: wireColorForKind(edge.kind), width: 18, height: 18 },
    data: {
      kind: edge.kind,
      weight: edge.weight,
      underlyingEdgeIds: edge.underlyingEdgeIds,
      lifted: edge.lifted,
      resolved: edge.resolved,
    },
  };
}
