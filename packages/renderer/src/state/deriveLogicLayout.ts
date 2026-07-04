/**
 * The Logic-tab derive pipeline behind one call: flow tree -> graph spec -> nested ELK graph ->
 * awaited layout -> React Flow nodes/edges. Kept pure of store concerns so the store can wrap it
 * in a stale-layout guard, exactly like `deriveLayout` does for the call graph.
 */

import type { FlowPath, LogicFlows } from "@meridian/core";
import type { GraphIndex } from "../graph/graphIndex";
import {
  collectModuleDefinitions,
  definitionNodeData,
  deriveLogicGraph,
  deriveLogicGraphFromBodies,
  type LogicNodeSpec,
} from "../derive/logicGraph";
import { buildLogicElkGraph, toReactFlowLogic, type LogicReactFlowGraph, type LogicRfNode } from "../layout/logicElk";
import { runElkLayout } from "../layout/elkLayout";

export async function deriveLogicLayout(
  rootId: string,
  flows: LogicFlows,
  index: GraphIndex,
  expandedLogic: ReadonlySet<string>,
  options: { hideGreyed: boolean },
  // When set, chart ONLY this container's bodies as a focused sub-view (the DIVE gesture) instead
  // of the whole callable flow rooted at `rootId`.
  focus?: { id: string; bodies: FlowPath[] },
): Promise<LogicReactFlowGraph> {
  const flow = await layoutFlow(rootId, flows, index, expandedLogic, options, focus);
  // A module mostly EXPORTS callables; its top-level load-flow is thin (often empty), so the
  // methods it defines never show as steps. When a module root is open (not a container dive),
  // ALSO render those definitions as a disconnected grid below the flow — hence no early return on
  // an empty module flow, and definitions are declarations, not exec steps (no parent, no edges).
  if (!focus && index.nodesById.get(rootId)?.kind === "module") {
    const defs = definitionGrid(rootId, flow.nodes, flows, index);
    return { nodes: [...flow.nodes, ...defs], edges: flow.edges };
  }
  return flow;
}

/** The ELK-laid-out load/callable flow; empty (no ELK run) when the flow spec has no drawable steps. */
async function layoutFlow(
  rootId: string,
  flows: LogicFlows,
  index: GraphIndex,
  expandedLogic: ReadonlySet<string>,
  options: { hideGreyed: boolean },
  focus?: { id: string; bodies: FlowPath[] },
): Promise<LogicReactFlowGraph> {
  const spec = focus
    ? deriveLogicGraphFromBodies(focus.id, focus.bodies, flows, index, expandedLogic, options)
    : deriveLogicGraph(rootId, flows, index, expandedLogic, options);
  if (spec.nodes.length === 0) {
    return { nodes: [], edges: [] };
  }
  const laidOut = await runElkLayout(buildLogicElkGraph(spec));
  const specById = new Map<string, LogicNodeSpec>(spec.nodes.map((node) => [node.id, node]));
  return toReactFlowLogic(laidOut, specById, spec.edges);
}

// The definition grid geometry: a fixed COLS-wide grid of uniform cells, hand-positioned (NOT via
// ELK) so the disconnected definitions pack tidily rather than fanning out as isolated islands.
const COLS = 4;
const DEF_W = 220;
const DEF_H = 56;
const GAP_X = 24;
const GAP_Y = 20;
// A clear gap below the deepest flow node, so the grid reads as a separate "defined here" band.
const GRID_TOP_GAP = 80;

/**
 * The module's defined callables as a grid of disconnected "definition" nodes, placed below the
 * flow. Each carries `targetId`/`expandable` (via `definitionNodeData`) so the view's existing
 * single-click selection (→ jump-to-flow ghosts) and double-click drill work with no extra wiring.
 */
function definitionGrid(
  rootId: string,
  flowNodes: LogicRfNode[],
  flows: LogicFlows,
  index: GraphIndex,
): LogicRfNode[] {
  const defs = collectModuleDefinitions(index, rootId);
  const y0 = flowBottom(flowNodes) + GRID_TOP_GAP;
  return defs.map((id, i) => ({
    id: `${rootId}::def/${id}`,
    type: "block" as const,
    position: { x: (i % COLS) * (DEF_W + GAP_X), y: y0 + Math.floor(i / COLS) * (DEF_H + GAP_Y) },
    width: DEF_W,
    height: DEF_H,
    data: definitionNodeData(id, flows, index),
  }));
}

// The flow's bottom edge: the max bottom (y + height) over TOP-LEVEL nodes only — a nested child's
// position is parent-relative, so its container already accounts for it. 0 when the flow is empty.
function flowBottom(flowNodes: LogicRfNode[]): number {
  return flowNodes
    .filter((node) => node.parentId === undefined)
    .reduce((max, node) => Math.max(max, node.position.y + (node.height ?? 0)), 0);
}
