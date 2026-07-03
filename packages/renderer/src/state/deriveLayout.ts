/**
 * The full derive pipeline behind one call: visible set -> lifted edges -> nested ELK graph
 * -> awaited layout -> React Flow nodes/edges. Kept pure of store concerns so the store can
 * apply its stale-layout guard around it.
 */

import type { GraphEdge } from "@meridian/core";
import type { GraphIndex } from "../graph/graphIndex";
import { computeVisible, visibleIdSet } from "../derive/computeVisible";
import { liftEdges } from "../derive/liftEdges";
import { selectEdgesForMode, type ViewMode } from "../derive/edgeSelection";
import type { VisibleNode } from "../derive/types";
import { buildElkGraph } from "../layout/buildElkGraph";
import { runElkLayout } from "../layout/elkLayout";
import { toReactFlow, type ReactFlowGraph } from "../layout/toReactFlow";

export async function deriveLayout(
  index: GraphIndex,
  expanded: ReadonlySet<string>,
  focusId: string | null,
  viewMode: ViewMode,
): Promise<ReactFlowGraph> {
  const visible = computeVisible(index, expanded, focusId);
  const edges = scopeEdges(selectEdgesForMode(index.edges, viewMode), focusId, index);
  const liftedEdges = liftEdges(edges, visibleIdSet(visible), index.parentOf);
  const elkGraph = buildElkGraph(visible, liftedEdges);
  const laidOut = await runElkLayout(elkGraph);
  return toReactFlow(laidOut, byId(visible), liftedEdges);
}

// While focused, keep only edges wholly inside the box; a wire leaving the subtree is dropped
// (endpoints then lift to their nearest visible ancestor WITHIN the focus scope, never above it).
function scopeEdges(edges: GraphEdge[], focusId: string | null, index: GraphIndex): GraphEdge[] {
  if (focusId === null) {
    return edges;
  }
  return edges.filter(
    (edge) => index.isWithinFocus(focusId, edge.source) && index.isWithinFocus(focusId, edge.target),
  );
}

function byId(visible: VisibleNode[]): Map<string, VisibleNode> {
  return new Map(visible.map((node) => [node.id, node]));
}
