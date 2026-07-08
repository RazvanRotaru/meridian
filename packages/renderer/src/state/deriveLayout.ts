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
  hidden: ReadonlySet<string> = new Set(),
  flow: FlowScope | null = null,
): Promise<ReactFlowGraph> {
  const effectiveHidden = withModeHidden(index, viewMode, hidden);
  if (flow && index.nodesById.has(flow.rootId)) {
    return deriveFlowLayout(index, viewMode, flow, effectiveHidden);
  }
  const visible = computeVisible(index, expanded, focusId, effectiveHidden);
  const edges = scopeEdges(selectEdgesForMode(index.edges, viewMode), focusId, index).filter(
    // An edge touching a hidden node must not lift to the node's visible ancestor — that
    // would re-draw the hidden code's calls as coming from its package. It disappears with it.
    (edge) => !effectiveHidden.has(edge.source) && !effectiveHidden.has(edge.target),
  );
  const liftedEdges = liftEdges(edges, visibleIdSet(visible), index.parentOf);
  const elkGraph = buildElkGraph(visible, liftedEdges);
  const laidOut = await runElkLayout(elkGraph);
  return toReactFlow(laidOut, byId(visible), liftedEdges);
}

// One isolated flow: the reachable set is drawn fully expanded to its functions, and only edges
// wholly inside the flow survive — so the same nodes never carry a second flow's wires. Hidden
// (e.g. test) nodes are pruned from the reachable set so the flow view honors the Tests toggle too.
async function deriveFlowLayout(
  index: GraphIndex,
  viewMode: ViewMode,
  flow: FlowScope,
  hidden: ReadonlySet<string>,
): Promise<ReactFlowGraph> {
  const forward = forwardReachable(index, flow.rootId, viewMode, flow.depth ?? undefined);
  const reachable = hidden.size === 0 ? forward : new Set([...forward].filter((id) => !hidden.has(id)));
  const visible = computeVisibleWithin(index, flowKeepSet(reachable, index));
  const edges = selectEdgesForMode(index.edges, viewMode).filter(
    (edge) => reachable.has(edge.source) && reachable.has(edge.target),
  );
  const liftedEdges = liftEdges(edges, visibleIdSet(visible), index.parentOf);
  const laidOut = await runElkLayout(buildElkGraph(visible, liftedEdges));
  return toReactFlow(laidOut, byId(visible), liftedEdges);
}

// UI composition draws the React render tree; IPC channel pseudo-nodes carry only `sends`/`handles`
// wires (the service graph), never `renders`. Left in, every channel is an orphan card — hundreds of
// them stack into one disconnected column that reads as a blank canvas. So the UI mode hides them,
// folding the channel ids into the caller's hidden set (which also lifts any edge that touched one).
export function withModeHidden(index: GraphIndex, viewMode: ViewMode, hidden: ReadonlySet<string>): ReadonlySet<string> {
  if (viewMode !== "ui") {
    return hidden;
  }
  const merged = new Set(hidden);
  for (const node of index.nodesById.values()) {
    if (node.kind === "channel") {
      merged.add(node.id);
    }
  }
  return merged;
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
