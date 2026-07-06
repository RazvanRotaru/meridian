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
import { buildLogicElkGraph, toReactFlowLogic, type DefGroupData, type LogicReactFlowGraph, type LogicRfNode } from "../layout/logicElk";
import { runElkLayout } from "../layout/elkLayout";

export async function deriveLogicLayout(
  rootId: string,
  flows: LogicFlows,
  index: GraphIndex,
  expandedLogic: ReadonlySet<string>,
  options: { hideGreyed: boolean; inlineDepth: number },
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
    const defs = definitionGroups(rootId, flow.nodes, flows, index);
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
  options: { hideGreyed: boolean; inlineDepth: number },
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

// The definition-frame geometry: uniform method cells packed into a COLS-wide grid INSIDE each
// frame, all hand-positioned (NOT via ELK) — ELK would splay a 20-method group into one wide row,
// and frames are structural groups, not exec nodes ELK routes wires through.
const COLS = 4;
const DEF_W = 200;
const DEF_H = 52;
const GAP_X = 16;
const GAP_Y = 14;
const PAD = 14;
const TITLE_H = 32;
// Vertical gap between stacked frames, and the clear band below the load-flow before the first one.
const GROUP_GAP = 44;
const FLOW_GAP = 80;

// A module's callables grouped by their owner (object/class node, or the module itself for
// top-level functions) — one titled frame each. `defIds` keep `collectModuleDefinitions`' order.
interface DefGroup {
  parentId: string;
  label: string;
  kind: string;
  defIds: string[];
}

/**
 * The module's defined callables as titled FRAMES stacked below the flow — one per owner
 * (object/class) plus a trailing "functions" frame for top-level functions — each holding its
 * methods in a compact grid. Each method carries `targetId`/`expandable` (via `definitionNodeData`)
 * so the view's single-click selection (→ jump-to-flow ghosts) and double-click drill keep working
 * with no extra wiring. Emitted frame-BEFORE-children so React Flow sees a parent before its kids.
 */
function definitionGroups(
  moduleId: string,
  flowNodes: LogicRfNode[],
  flows: LogicFlows,
  index: GraphIndex,
): LogicRfNode[] {
  const out: LogicRfNode[] = [];
  let frameY = flowBottom(flowNodes) + FLOW_GAP;
  for (const group of groupDefinitions(index, moduleId)) {
    const n = group.defIds.length;
    const cols = Math.min(COLS, n);
    const rows = Math.ceil(n / cols);
    const width = 2 * PAD + cols * DEF_W + (cols - 1) * GAP_X;
    const height = TITLE_H + 2 * PAD + rows * DEF_H + (rows - 1) * GAP_Y;
    const frameId = `${moduleId}::defgroup/${group.parentId}`;
    const data: DefGroupData = { targetId: null, label: group.label, kind: group.kind, childCount: n };
    out.push({ id: frameId, type: "defgroup", position: { x: 0, y: frameY }, width, height, data });
    group.defIds.forEach((defId, i) => {
      out.push({
        id: `${moduleId}::def/${defId}`,
        type: "block",
        parentId: frameId,
        extent: "parent",
        position: { x: PAD + (i % cols) * (DEF_W + GAP_X), y: TITLE_H + PAD + Math.floor(i / cols) * (DEF_H + GAP_Y) },
        width: DEF_W,
        height: DEF_H,
        data: definitionNodeData(defId, flows, index),
      });
    });
    frameY += height + GROUP_GAP;
  }
  return out;
}

/**
 * Group a module's callables by their immediate container: `parentOf.get(defId)` is the owning
 * object/class node for a method, and the module itself for a top-level function. Object/class
 * groups come first (sorted by label); the top-level `functions` group (kind "module") sorts last.
 * Order WITHIN a group follows `collectModuleDefinitions` (already sorted by display name).
 */
export function groupDefinitions(index: GraphIndex, moduleId: string): DefGroup[] {
  const byParent = new Map<string, DefGroup>();
  for (const defId of collectModuleDefinitions(index, moduleId)) {
    const parentId = index.parentOf.get(defId) ?? moduleId;
    const group = byParent.get(parentId) ?? { parentId, ...groupHeader(parentId, moduleId, index), defIds: [] };
    group.defIds.push(defId);
    byParent.set(parentId, group);
  }
  const groups = [...byParent.values()];
  const functions = groups.filter((g) => g.parentId === moduleId);
  const owned = groups.filter((g) => g.parentId !== moduleId).sort((a, b) => a.label.localeCompare(b.label));
  return [...owned, ...functions];
}

// A group's title: the owner's display name + kind, or "functions"/"module" for the top-level group
// (top-level functions parent to the module node itself). "module" kind lets the frame tag them
// "FUNCTIONS" without a second flag.
function groupHeader(parentId: string, moduleId: string, index: GraphIndex): { label: string; kind: string } {
  if (parentId === moduleId) {
    return { label: "functions", kind: "module" };
  }
  const owner = index.nodesById.get(parentId);
  return { label: owner?.displayName ?? parentId, kind: owner?.kind ?? "object" };
}

// The flow's bottom edge: the max bottom (y + height) over TOP-LEVEL nodes only — a nested child's
// position is parent-relative, so its container already accounts for it. 0 when the flow is empty.
function flowBottom(flowNodes: LogicRfNode[]): number {
  return flowNodes
    .filter((node) => node.parentId === undefined)
    .reduce((max, node) => Math.max(max, node.position.y + (node.height ?? 0)), 0);
}
