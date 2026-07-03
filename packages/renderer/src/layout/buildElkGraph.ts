/**
 * Build the visible set as a NESTED ELK graph that mirrors React Flow's parentId nesting.
 *
 * Containers recurse as ELK children with padding for the title bar; leaf/collapsed nodes
 * carry a fixed size. `elk.hierarchyHandling: INCLUDE_CHILDREN` is set on the ROOT ONLY —
 * setting it per-subgraph throws UnsupportedGraphException — and ALL lifted edges live on
 * the root graph so the layered algorithm can route them across container boundaries.
 */

import type { ElkExtendedEdge, ElkNode } from "elkjs/lib/elk-api";
import type { LiftedEdge } from "../derive/types";
import type { VisibleNode } from "../derive/types";
import { boxSize } from "./nodeSize";

export const ELK_ROOT_ID = "__blueprint_root__";

const ROOT_LAYOUT_OPTIONS: Record<string, string> = {
  "elk.algorithm": "layered",
  "elk.direction": "RIGHT",
  "elk.hierarchyHandling": "INCLUDE_CHILDREN",
  "elk.layered.spacing.nodeNodeBetweenLayers": "64",
  "elk.spacing.nodeNode": "34",
  "elk.padding": "[top=28,left=28,bottom=28,right=28]",
};

// Top padding leaves room for the container's title bar; React Flow draws nothing there itself.
const CONTAINER_LAYOUT_OPTIONS: Record<string, string> = {
  "elk.padding": "[top=46,left=18,bottom=18,right=18]",
};

export function buildElkGraph(visible: VisibleNode[], edges: LiftedEdge[]): ElkNode {
  const elkById = new Map<string, ElkNode>(visible.map((node) => [node.id, toElkNode(node)]));
  const visibleIds = new Set(visible.map((node) => node.id));
  const roots: ElkNode[] = [];
  for (const node of visible) {
    attachToParent(node, elkById, visibleIds, roots);
  }
  return rootGraph(roots, edges);
}

function attachToParent(
  visibleNode: VisibleNode,
  elkById: Map<string, ElkNode>,
  visibleIds: ReadonlySet<string>,
  roots: ElkNode[],
): void {
  const elkNode = elkById.get(visibleNode.id);
  if (!elkNode) {
    return;
  }
  const parentId = visibleNode.node.parentId;
  const parentElk = parentId ? elkById.get(parentId) : undefined;
  if (parentId && visibleIds.has(parentId) && parentElk) {
    parentElk.children?.push(elkNode);
    return;
  }
  roots.push(elkNode);
}

function toElkNode(visibleNode: VisibleNode): ElkNode {
  if (visibleNode.isExpanded) {
    return { id: visibleNode.id, children: [], layoutOptions: CONTAINER_LAYOUT_OPTIONS };
  }
  const { width, height } = boxSize(visibleNode);
  return { id: visibleNode.id, width, height };
}

function rootGraph(children: ElkNode[], edges: LiftedEdge[]): ElkNode {
  return {
    id: ELK_ROOT_ID,
    layoutOptions: ROOT_LAYOUT_OPTIONS,
    children,
    edges: edges.map(toElkEdge),
  };
}

function toElkEdge(edge: LiftedEdge): ElkExtendedEdge {
  return { id: edge.id, sources: [edge.source], targets: [edge.target] };
}
