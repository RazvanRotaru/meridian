/**
 * The Logic-tab derive pipeline behind one call: flow tree -> graph spec -> nested ELK graph ->
 * awaited layout -> React Flow nodes/edges. Kept pure of store concerns so the store can wrap it
 * in a stale-layout guard, exactly like `deriveLayout` does for the call graph.
 */

import type { LogicFlows } from "@meridian/core";
import type { GraphIndex } from "../graph/graphIndex";
import { deriveLogicGraph, type LogicNodeSpec } from "../derive/logicGraph";
import { buildLogicElkGraph, toReactFlowLogic, type LogicReactFlowGraph } from "../layout/logicElk";
import { runElkLayout } from "../layout/elkLayout";

export async function deriveLogicLayout(
  rootId: string,
  flows: LogicFlows,
  index: GraphIndex,
  expandedLogic: ReadonlySet<string>,
  options: { hideGreyed: boolean },
): Promise<LogicReactFlowGraph> {
  const spec = deriveLogicGraph(rootId, flows, index, expandedLogic, options);
  if (spec.nodes.length === 0) {
    return { nodes: [], edges: [] };
  }
  const laidOut = await runElkLayout(buildLogicElkGraph(spec));
  const specById = new Map<string, LogicNodeSpec>(spec.nodes.map((node) => [node.id, node]));
  return toReactFlowLogic(laidOut, specById, spec.edges);
}
