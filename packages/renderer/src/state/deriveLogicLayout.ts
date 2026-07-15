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
  logicNodeSize,
  type LogicGraphOptions,
  type LogicNodeSpec,
} from "../derive/logicGraph";
import { buildOwnerLookup, type OwnerLookup } from "../derive/logicOwner";
import { buildLogicElkGraph, toReactFlowLogic, type DefGroupData, type LogicReactFlowGraph, type LogicRfNode } from "../layout/logicElk";
import { runElkLayout } from "../layout/elkLayout";
import { collapseLogicEdges } from "../derive/collapseLogicEdges";

export async function deriveLogicLayout(
  rootId: string,
  flows: LogicFlows,
  index: GraphIndex,
  expandedLogic: ReadonlySet<string>,
  options: LogicGraphOptions & { nestByService: boolean },
  // When set, chart ONLY this container's bodies as a focused sub-view (the DIVE gesture) instead
  // of the whole callable flow rooted at `rootId`.
  focus?: { id: string; bodies: FlowPath[] },
  collapsedEdges: ReadonlySet<string> = new Set<string>(),
): Promise<LogicReactFlowGraph> {
  // Built ONCE per relayout and threaded into every node builder: it maps a call target to its owning
  // Service-composition unit (health + smell), the seam that links the two views.
  const ownerLookup = buildOwnerLookup([...index.nodesById.values()], index.edges);
  const flow = await layoutFlow(rootId, flows, index, expandedLogic, options, ownerLookup, focus, collapsedEdges);
  // A module mostly EXPORTS callables; its top-level load-flow is thin (often empty), so the
  // methods it defines never show as steps. When a module root is open (not a container dive),
  // ALSO render those definitions as a disconnected grid below the flow — hence no early return on
  // an empty module flow. Collapsed declarations have no wires; an expanded declaration owns its
  // callable's independently laid-out child flow and internal wires.
  if (!focus && index.nodesById.get(rootId)?.kind === "module") {
    const defs = await definitionGroups(rootId, flow.nodes, flows, index, ownerLookup, expandedLogic, options, collapsedEdges);
    return { nodes: [...flow.nodes, ...defs.nodes], edges: [...flow.edges, ...defs.edges] };
  }
  return flow;
}

/** The ELK-laid-out load/callable flow; empty (no ELK run) when the flow spec has no drawable steps. */
async function layoutFlow(
  rootId: string,
  flows: LogicFlows,
  index: GraphIndex,
  expandedLogic: ReadonlySet<string>,
  options: LogicGraphOptions & { nestByService: boolean },
  ownerLookup: OwnerLookup,
  focus?: { id: string; bodies: FlowPath[] },
  collapsedEdges: ReadonlySet<string> = new Set<string>(),
): Promise<LogicReactFlowGraph> {
  // Entry/exit end-caps frame a callable's flow only: a container DIVE (`focus`) charts sub-chains
  // with no single entry, and a module's top-level flow is a load sequence that nothing "calls" — so
  // both opt out of terminals (a module still gets its def-grid below, appended in deriveLogicLayout).
  const withTerminals = index.nodesById.get(rootId)?.kind !== "module";
  const canonicalSpec = focus
    ? deriveLogicGraphFromBodies(
        focus.id,
        focus.bodies,
        flows,
        index,
        expandedLogic,
        { ...options, sourceOwnerId: rootId },
        ownerLookup,
      )
    : deriveLogicGraph(rootId, flows, index, expandedLogic, { ...options, withTerminals }, ownerLookup);
  const spec = collapseLogicEdges(canonicalSpec, collapsedEdges);
  if (spec.nodes.length === 0) {
    return { nodes: [], edges: [] };
  }
  const laidOut = await runElkLayout(buildLogicElkGraph(spec));
  const specById = new Map<string, LogicNodeSpec>(spec.nodes.map((node) => [node.id, node]));
  return toReactFlowLogic(laidOut, specById, spec.edges);
}

// The definition-frame geometry: collapsed method cells are uniform; expanded cells grow around
// their own ELK-laid-out callable flow. The surrounding grid remains hand-positioned — feeding a
// 20-method declaration group to ELK would splay it into one wide row.
const COLS = 4;
const DEF_W = 200;
const DEF_H = 52;
const GAP_X = 16;
const GAP_Y = 14;
const PAD = 14;
const TITLE_H = 32;
// Expanded definition cells reuse a root-level callable layout. Its first children already clear
// the card header via ELK's root padding; retain a small trailing gutter around their far edges.
const EXPANDED_RIGHT_PAD = 16;
const EXPANDED_BOTTOM_PAD = 16;
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

interface LaidOutDefinition {
  occurrenceId: string;
  width: number;
  height: number;
  data: ReturnType<typeof definitionNodeData>;
  children: LogicRfNode[];
  edges: LogicReactFlowGraph["edges"];
}

/**
 * The module's defined callables as titled FRAMES stacked below the flow — one per owner
 * (object/class) plus a trailing "functions" frame for top-level functions — each holding its
 * methods in a compact grid. Each method carries `targetId`/`expandable` (via `definitionNodeData`)
 * so the view's single-click selection (→ jump-to-flow ghosts) and double-click drill keep working
 * with no extra wiring. Emitted frame-BEFORE-children so React Flow sees a parent before its kids.
 */
async function definitionGroups(
  moduleId: string,
  flowNodes: LogicRfNode[],
  flows: LogicFlows,
  index: GraphIndex,
  ownerLookup: OwnerLookup,
  expandedLogic: ReadonlySet<string>,
  options: LogicGraphOptions & { nestByService: boolean },
  collapsedEdges: ReadonlySet<string>,
): Promise<LogicReactFlowGraph> {
  const nodes: LogicRfNode[] = [];
  const edges: LogicReactFlowGraph["edges"] = [];
  let frameY = flowBottom(flowNodes) + FLOW_GAP;
  for (const group of groupDefinitions(index, moduleId)) {
    const n = group.defIds.length;
    if (n === 0) {
      continue;
    }
    const frameId = `${moduleId}::defgroup/${group.parentId}`;
    // Definition-owner frames follow the same default-XOR convention as Logic control containers:
    // they preserve the historical open presentation, while membership in `expandedLogic` folds
    // this particular occurrence. Keeping the child's overrides untouched means reopening restores
    // exactly the callable cells that were expanded before their owner frame was collapsed.
    const isExpanded = !expandedLogic.has(frameId);
    const data: DefGroupData = {
      targetId: null,
      label: group.label,
      kind: group.kind,
      childCount: n,
      expandable: true,
      isExpanded,
      isContainer: isExpanded,
    };
    if (!isExpanded) {
      nodes.push({
        id: frameId,
        type: "defgroup",
        position: { x: 0, y: frameY },
        width: DEF_W,
        height: TITLE_H,
        data,
      });
      frameY += TITLE_H + GROUP_GAP;
      continue;
    }

    const definitions = await Promise.all(
      group.defIds.map((defId) => layoutDefinition(moduleId, defId, flows, index, ownerLookup, expandedLogic, options, collapsedEdges)),
    );
    const cols = Math.min(COLS, n);
    const rows = Math.ceil(n / cols);
    // An expanded callable may be much larger than a collapsed neighbour. Size each grid column and
    // row from its largest member so cells never overlap and collapsing deterministically restores
    // the compact uniform grid.
    const columnWidths = Array.from({ length: cols }, () => DEF_W);
    const rowHeights = Array.from({ length: rows }, () => DEF_H);
    definitions.forEach((definition, i) => {
      const column = i % cols;
      const row = Math.floor(i / cols);
      columnWidths[column] = Math.max(columnWidths[column], definition.width);
      rowHeights[row] = Math.max(rowHeights[row], definition.height);
    });
    const columnX = offsets(columnWidths, GAP_X);
    const rowY = offsets(rowHeights, GAP_Y);
    const width = 2 * PAD + sum(columnWidths) + (cols - 1) * GAP_X;
    const height = TITLE_H + 2 * PAD + sum(rowHeights) + (rows - 1) * GAP_Y;
    nodes.push({ id: frameId, type: "defgroup", position: { x: 0, y: frameY }, width, height, data });
    definitions.forEach((definition, i) => {
      nodes.push({
        id: definition.occurrenceId,
        type: "block",
        parentId: frameId,
        extent: "parent",
        position: { x: PAD + columnX[i % cols], y: TITLE_H + PAD + rowY[Math.floor(i / cols)] },
        width: definition.width,
        height: definition.height,
        data: definition.data,
      });
      // Parents must precede children in React Flow. `layoutDefinition` keeps the callable layout's
      // own preorder intact and reparents only its roots, so nested loop/call/service frames survive.
      nodes.push(...definition.children);
      edges.push(...definition.edges);
    });
    frameY += height + GROUP_GAP;
  }
  return { nodes, edges };
}

/** Lay out one module-definition occurrence. Definition ids are view-occurrence ids, while every
 * child retains the callable graph's stable semantic id; only top-level children move under the
 * occurrence. Edge ids need an occurrence namespace because every independent graph starts at e0. */
async function layoutDefinition(
  moduleId: string,
  defId: string,
  flows: LogicFlows,
  index: GraphIndex,
  ownerLookup: OwnerLookup,
  expandedLogic: ReadonlySet<string>,
  options: LogicGraphOptions & { nestByService: boolean },
  collapsedEdges: ReadonlySet<string>,
): Promise<LaidOutDefinition> {
  const occurrenceId = `${moduleId}::def/${defId}`;
  const data = definitionNodeData(defId, flows, index, ownerLookup, expandedLogic.has(occurrenceId));
  const ownSize = logicNodeSize(data, "block");
  const headerWidth = Math.max(DEF_W, ownSize.width);
  if (!data.isExpanded) {
    return { occurrenceId, width: headerWidth, height: DEF_H, data, children: [], edges: [] };
  }

  const flow = await layoutFlow(defId, flows, index, expandedLogic, options, ownerLookup, undefined, collapsedEdges);
  const children = flow.nodes.map((node) => (
    node.parentId === undefined ? { ...node, parentId: occurrenceId, extent: "parent" as const } : node
  ));
  const { width, height } = expandedDefinitionSize(children, occurrenceId, headerWidth, ownSize.height);
  return {
    occurrenceId,
    width,
    height,
    data,
    children,
    edges: flow.edges.map((edge) => ({ ...edge, id: `${occurrenceId}::${edge.id}` })),
  };
}

/** The separately laid-out callable has no RF root node whose dimensions we can reuse. Its roots
 * already contain every nested descendant, so their far edges are the definition container's safe
 * size floor. Ignore non-finite layout values defensively rather than poisoning the whole grid. */
function expandedDefinitionSize(
  nodes: LogicRfNode[],
  occurrenceId: string,
  headerWidth: number,
  ownHeight: number,
): { width: number; height: number } {
  let right = 0;
  let bottom = 0;
  for (const node of nodes) {
    if (node.parentId === occurrenceId) {
      right = Math.max(right, safeNumber(node.position.x) + safeNumber(node.width));
      bottom = Math.max(bottom, safeNumber(node.position.y) + safeNumber(node.height));
    }
  }
  return {
    width: Math.max(headerWidth, right + EXPANDED_RIGHT_PAD),
    height: Math.max(DEF_H, ownHeight, bottom + EXPANDED_BOTTOM_PAD),
  };
}

function safeNumber(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
}

function offsets(sizes: number[], gap: number): number[] {
  const out: number[] = [];
  let current = 0;
  for (const size of sizes) {
    out.push(current);
    current += size + gap;
  }
  return out;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
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
