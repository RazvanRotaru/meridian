/**
 * The Service-composition derive pipeline behind one call: graph nodes/edges -> scorecard graph
 * spec -> flat ELK graph -> awaited layout -> React Flow nodes/edges. Kept pure of store concerns
 * so the store can wrap it in a stale-layout guard, exactly like `deriveLogicLayout`.
 */

import type { GraphEdge, GraphNode } from "@meridian/core";
import { deriveCompositionGraph, type CompNodeSpec, type CompositionViewOptions } from "../derive/compositionGraph";
import { buildCompositionElkGraph, toReactFlowComposition, type CompositionReactFlowGraph } from "../layout/compositionElk";
import { runElkLayout } from "../layout/elkLayout";

export async function deriveCompositionLayout(
  nodes: GraphNode[],
  edges: GraphEdge[],
  view: CompositionViewOptions = { root: null },
): Promise<CompositionReactFlowGraph> {
  const spec = deriveCompositionGraph(nodes, edges, view);
  if (spec.nodes.length === 0) {
    return { nodes: [], edges: [] };
  }
  const laidOut = await runElkLayout(buildCompositionElkGraph(spec));
  const specById = new Map<string, CompNodeSpec>(spec.nodes.map((node) => [node.id, node]));
  return toReactFlowComposition(laidOut, specById, spec.edges);
}
