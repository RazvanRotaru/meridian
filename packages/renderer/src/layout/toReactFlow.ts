/**
 * Map the laid-out ELK tree to React Flow nodes/edges.
 *
 * ELK child coordinates are PARENT-RELATIVE, which is exactly React Flow's parentId
 * semantics, so {x,y} maps straight through with `parentId` + `extent: "parent"`. Nodes are
 * emitted in DFS preorder (parents first) because React Flow requires a parent to appear
 * before its children. The nested ELK output is NOT flattened.
 */

import { MarkerType } from "@xyflow/react";
import type { ElkExtendedEdge, ElkNode } from "elkjs/lib/elk-api";
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
  const routes = routesById(laidOut.edges ?? []);
  return { nodes, edges: liftedEdges.map((edge) => toReactFlowEdge(edge, routes.get(edge.id))) };
}

/** Flatten each routed edge's first section into start -> bends -> end, keyed by edge id. */
function routesById(elkEdges: ElkExtendedEdge[]): Map<string, Array<{ x: number; y: number }>> {
  const routes = new Map<string, Array<{ x: number; y: number }>>();
  for (const edge of elkEdges) {
    const section = edge.sections?.[0];
    if (!section) {
      continue;
    }
    routes.set(edge.id, [section.startPoint, ...(section.bendPoints ?? []), section.endPoint]);
  }
  return routes;
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

function toReactFlowEdge(
  edge: LiftedEdge,
  points: Array<{ x: number; y: number }> | undefined,
): BlueprintEdge {
  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    type: "blueprint",
    markerEnd: { type: MarkerType.ArrowClosed, color: wireColorForKind(edge.kind), width: 12, height: 12 },
    data: {
      kind: edge.kind,
      weight: edge.weight,
      underlyingEdgeIds: edge.underlyingEdgeIds,
      lifted: edge.lifted,
      resolved: edge.resolved,
      highlight: "rest",
      points,
    },
  };
}
