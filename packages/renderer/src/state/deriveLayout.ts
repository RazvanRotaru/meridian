/**
 * The full derive pipeline behind one call: visible set -> lifted edges -> nested ELK graph
 * -> awaited layout -> React Flow nodes/edges. Kept pure of store concerns so the store can
 * apply its stale-layout guard around it.
 */

import type { GraphEdge } from "@meridian/core";
import type { GraphIndex } from "../graph/graphIndex";
import { computeVisible, computeVisibleWithin, visibleIdSet } from "../derive/computeVisible";
import { liftEdges } from "../derive/liftEdges";
import { selectEdgesForMode, type ViewMode } from "../derive/edgeSelection";
import { flowKeepSet, forwardReachable } from "../derive/flowReach";
import type { VisibleNode } from "../derive/types";
import { buildElkGraph } from "../layout/buildElkGraph";
import { runElkLayout } from "../layout/elkLayout";
import { toReactFlow, type ReactFlowGraph } from "../layout/toReactFlow";

export interface FlowScope {
  rootId: string;
  /** null == follow the whole flow; a number caps the hops from the entry. */
  depth: number | null;
}

export async function deriveLayout(
  index: GraphIndex,
  expanded: ReadonlySet<string>,
  focusId: string | null,
  viewMode: ViewMode,
  flow: FlowScope | null = null,
): Promise<ReactFlowGraph> {
  if (flow && index.nodesById.has(flow.rootId)) {
    return deriveFlowLayout(index, viewMode, flow);
  }
  const visible = computeVisible(index, expanded, focusId);
  const edges = scopeEdges(selectEdgesForMode(index.edges, viewMode), focusId, index);
  const liftedEdges = liftEdges(edges, visibleIdSet(visible), index.parentOf);
  const elkGraph = buildElkGraph(visible, liftedEdges);
  const laidOut = await runElkLayout(elkGraph);
  return toReactFlow(laidOut, byId(visible), liftedEdges);
}

// One isolated flow: the reachable set is drawn fully expanded to its functions, and only edges
// wholly inside the flow survive — so the same nodes never carry a second flow's wires.
async function deriveFlowLayout(index: GraphIndex, viewMode: ViewMode, flow: FlowScope): Promise<ReactFlowGraph> {
  const reachable = forwardReachable(index, flow.rootId, viewMode, flow.depth ?? undefined);
  const visible = computeVisibleWithin(index, flowKeepSet(reachable, index));
  const edges = selectEdgesForMode(index.edges, viewMode).filter(
    (edge) => reachable.has(edge.source) && reachable.has(edge.target),
  );
  const liftedEdges = liftEdges(edges, visibleIdSet(visible), index.parentOf);
  const laidOut = await runElkLayout(buildElkGraph(visible, liftedEdges));
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
