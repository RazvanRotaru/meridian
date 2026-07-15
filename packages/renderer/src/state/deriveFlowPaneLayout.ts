import type { FlowPath, LogicFlows } from "@meridian/core";
import type { GraphIndex } from "../graph/graphIndex";
import type { FlowSelectionRef } from "../derive/flowBlocks";
import { stepsAt } from "../derive/flowBlocks";
import { deriveLogicGraphFromBodies, type LogicGraphOptions, type LogicNodeSpec } from "../derive/logicGraph";
import { buildOwnerLookup } from "../derive/logicOwner";
import { buildLogicElkGraph, toReactFlowLogic, type LogicReactFlowGraph } from "../layout/logicElk";
import { runElkLayout } from "../layout/elkLayout";
import { deriveLogicLayout } from "./deriveLogicLayout";
import { collapseLogicEdges } from "../derive/collapseLogicEdges";

export async function deriveFlowPaneLayout(
  ref: FlowSelectionRef,
  flows: LogicFlows,
  index: GraphIndex,
  expansionOverrides: ReadonlySet<string> = new Set<string>(),
  options: Pick<LogicGraphOptions, "changedStatusForSource"> = {},
  collapsedEdges: ReadonlySet<string> = new Set<string>(),
): Promise<LogicReactFlowGraph> {
  if (ref.blockPath.length === 0) {
    return deriveLogicLayout(ref.rootId, flows, index, expansionOverrides, {
      hideGreyed: false,
      nestByService: false,
      ...options,
    }, undefined, collapsedEdges);
  }
  const steps = stepsAt(flows, ref);
  if (!steps || steps.length === 0) {
    return { nodes: [], edges: [] };
  }
  const ownerLookup = buildOwnerLookup([...index.nodesById.values()], index.edges);
  const canonicalSpec = deriveLogicGraphFromBodies(
    selectionPrefix(ref),
    [selectedBody(steps)],
    flows,
    index,
    expansionOverrides,
    { hideGreyed: false, nestByService: false, sourceOwnerId: ref.rootId, ...options },
    ownerLookup,
  );
  const spec = collapseLogicEdges(canonicalSpec, collapsedEdges);
  if (spec.nodes.length === 0) {
    return { nodes: [], edges: [] };
  }
  const laidOut = await runElkLayout(buildLogicElkGraph(spec));
  const specById = new Map<string, LogicNodeSpec>(spec.nodes.map((node) => [node.id, node]));
  return toReactFlowLogic(laidOut, specById, spec.edges);
}

function selectedBody(body: FlowPath["body"]): FlowPath {
  return { label: "selected block", body };
}

function selectionPrefix(ref: FlowSelectionRef): string {
  const path = ref.blockPath.map((segment) => segment.path === undefined ? String(segment.step) : `${segment.step}-${segment.path}`).join(".");
  return `${ref.rootId}::flow-pane/${path}`;
}
