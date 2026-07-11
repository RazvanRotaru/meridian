/**
 * Presentation-only edges drawn by the module canvas. They explain canvas structure (currently an
 * expanded ghost parent's member spokes), but are not graph relationships: they must never join
 * semantic reach, salience, cycle, highway, hover, or evidence-inspection passes.
 */

import type { Edge } from "@xyflow/react";

export const GHOST_HIERARCHY_EDGE_ROLE = "ghost-hierarchy";

/** Recognize the typed role and the short-lived legacy boolean used by early grouping prototypes. */
export function isGhostHierarchyEdge(edge: Edge): boolean {
  const data = edge.data as { edgeRole?: unknown; ghostHierarchy?: unknown } | undefined;
  return data?.edgeRole === GHOST_HIERARCHY_EDGE_ROLE || data?.ghostHierarchy === true;
}

/** Defensive interaction predicate for callers that may receive a mixed edge array. */
export function isInteractiveSemanticEdge(edge: Edge): boolean {
  return !isGhostHierarchyEdge(edge);
}

export interface PartitionedPresentationEdges {
  semanticEdges: Edge[];
  hierarchyEdges: Edge[];
}

/** Stable partition: semantic order and hierarchy order are both retained. When there are no
 * hierarchy spokes, return the input as the semantic array so the common path allocates nothing. */
export function partitionPresentationEdges(edges: Edge[]): PartitionedPresentationEdges {
  if (!edges.some(isGhostHierarchyEdge)) {
    return { semanticEdges: edges, hierarchyEdges: [] };
  }
  const semanticEdges: Edge[] = [];
  const hierarchyEdges: Edge[] = [];
  for (const edge of edges) {
    (isGhostHierarchyEdge(edge) ? hierarchyEdges : semanticEdges).push(edge);
  }
  return { semanticEdges, hierarchyEdges };
}
