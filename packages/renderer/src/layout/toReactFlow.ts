/**
 * Map the laid-out ELK tree to React Flow nodes/edges.
 *
 * The DFS-preorder walk and the parent-relative coordinate mapping live in `elkNesting`; this
 * module only turns a visible node into the container/leaf React Flow shape and builds the edges.
 */

import type { ElkNode } from "elkjs/lib/elk-api";
import type { LiftedEdge, VisibleNode } from "../derive/types";
import { arrowMarker, wireColorForKind } from "../theme/edgeColors";
import { emitReactFlowNodes, parentRelativePlacement } from "./elkNesting";
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
  const nodes = emitReactFlowNodes(laidOut, (elkNode, parentId) => {
    const visibleNode = visibleById.get(elkNode.id);
    return visibleNode ? toReactFlowNode(elkNode, parentId, visibleNode) : null;
  });
  return { nodes, edges: liftedEdges.map(toReactFlowEdge) };
}

function toReactFlowNode(
  elkNode: ElkNode,
  parentId: string | undefined,
  visibleNode: VisibleNode,
): BlueprintNode {
  return {
    id: elkNode.id,
    type: visibleNode.isContainer ? "container" : "leaf",
    ...parentRelativePlacement(elkNode, parentId),
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
    markerEnd: arrowMarker(wireColorForKind(edge.kind)),
    data: {
      kind: edge.kind,
      weight: edge.weight,
      underlyingEdgeIds: edge.underlyingEdgeIds,
      lifted: edge.lifted,
      resolved: edge.resolved,
    },
  };
}
