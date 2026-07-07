/**
 * Lay the Module-map's containment tree out as a NESTED dependency diagram: ELK `layered` left→right
 * so importers sit left of what they import, with expanded group cards recursing as ELK containers
 * (their children placed INSIDE them, parent-relative — exactly React Flow's parentId semantics).
 * Built on the shared `elkNesting` primitives, same as the call/logic graphs, so `INCLUDE_CHILDREN`
 * lives on the ROOT ONLY (setting it per-subgraph throws). Collapsed group cards size by file count;
 * file cards are fixed. Deterministic — ELK layered is stable and no Math.random/Date is used.
 */

import type { ElkNode } from "elkjs/lib/elk-api";
import type { Edge, Node } from "@xyflow/react";
import { runElkLayout } from "./elkLayout";
import { buildNestedElkGraph, emitReactFlowNodes, parentRelativePlacement, type ElkNestAdapter } from "./elkNesting";
import type { ModuleTreeEdge, VisibleModuleNode } from "../derive/moduleTree";
import type { UnitCardData } from "../derive/moduleLevel";

const GROUP_HEIGHT = 76;
const GROUP_MIN_WIDTH = 172;
const GROUP_MAX_WIDTH = 320;
const WIDTH_PER_FILE = 3;
const FILE_WIDTH = 210;
const FILE_HEIGHT = 54;
// Unit cards size with their content: header + a methods band + a uses band (UnitCardNode's rows).
export const UNIT_MEMBERS_SHOWN = 5;
export const UNIT_DEPS_SHOWN = 3;
const UNIT_WIDTH = 216;
const UNIT_HEADER_HEIGHT = 40;
const UNIT_SECTION_HEADER = 16;
const UNIT_ROW_HEIGHT = 15;
const UNIT_MORE_HEIGHT = 12;
const UNIT_PADDING = 12;

const ROOT_OPTIONS: Record<string, string> = {
  "elk.algorithm": "layered",
  "elk.direction": "RIGHT",
  "elk.hierarchyHandling": "INCLUDE_CHILDREN",
  "elk.spacing.nodeNode": "44",
  "elk.layered.spacing.nodeNodeBetweenLayers": "120",
  "elk.spacing.edgeNode": "28",
};

// Top padding leaves room for an expanded group's title bar; React Flow draws nothing there itself.
const CONTAINER_OPTIONS: Record<string, string> = { "elk.padding": "[top=44,left=18,bottom=18,right=18]" };

const adapter: ElkNestAdapter<VisibleModuleNode> = {
  id: (node) => node.id,
  parentId: (node) => node.parentId,
  isContainer: (node) => node.isExpanded,
  leafSize: (node) => leafSize(node),
  containerOptions: CONTAINER_OPTIONS,
};

/** Run ELK over the nested tree and map the placed (parent-relative) coordinates to React Flow. */
export async function layoutModuleTree(nodes: VisibleModuleNode[], edges: ModuleTreeEdge[]): Promise<{ nodes: Node[]; edges: Edge[] }> {
  if (nodes.length === 0) {
    return { nodes: [], edges: [] };
  }
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const laid = await runElkLayout(buildNestedElkGraph(nodes, edges, adapter, ROOT_OPTIONS));
  const placed = emitReactFlowNodes(laid, (elkNode, parentId) => toNode(elkNode, parentId, byId));
  return { nodes: placed, edges: edges.map(toEdge) };
}

/** A collapsed group sizes with its file count; a file card is fixed; a unit card sizes with its
 * member/dependency rows. Expanded groups and file frames are ELK-sized around their children. */
function leafSize(node: VisibleModuleNode): { width: number; height: number } {
  if (node.kind === "unit") {
    return unitSize(node.data as UnitCardData);
  }
  if (node.kind === "file") {
    return { width: FILE_WIDTH, height: FILE_HEIGHT };
  }
  return { width: groupWidth(fileCountOf(node)), height: GROUP_HEIGHT };
}

/** Reserve exactly the bands UnitCardNode draws, so the card never clips its rows. */
function unitSize(data: UnitCardData): { width: number; height: number } {
  return { width: UNIT_WIDTH, height: UNIT_HEADER_HEIGHT + bandHeight(data.members.length, UNIT_MEMBERS_SHOWN) + bandHeight(data.deps.length, UNIT_DEPS_SHOWN) + UNIT_PADDING };
}

function bandHeight(count: number, cap: number): number {
  if (count === 0) {
    return 0;
  }
  const shown = Math.min(count, cap);
  return UNIT_SECTION_HEADER + shown * UNIT_ROW_HEIGHT + (count > cap ? UNIT_MORE_HEIGHT : 0);
}

function fileCountOf(node: VisibleModuleNode): number {
  return (node.data as { fileCount?: number }).fileCount ?? 0;
}

/** Bigger directories get wider boxes, clamped so the largest can't dwarf the smallest off-screen. */
function groupWidth(fileCount: number): number {
  return Math.max(GROUP_MIN_WIDTH, Math.min(GROUP_MAX_WIDTH, GROUP_MIN_WIDTH + fileCount * WIDTH_PER_FILE));
}

/** Map one placed ELK node back to a React Flow node, wired to its parent frame when nested. */
function toNode(elkNode: ElkNode, parentId: string | undefined, byId: Map<string, VisibleModuleNode>): Node | null {
  const node = byId.get(elkNode.id);
  if (!node) {
    return null;
  }
  const placement = parentRelativePlacement(elkNode, parentId);
  return {
    id: node.id,
    type: node.kind,
    position: placement.position,
    style: { width: placement.width, height: placement.height },
    data: node.data,
    ...(placement.parentId ? { parentId: placement.parentId, extent: placement.extent } : {}),
  };
}

function toEdge(edge: ModuleTreeEdge): Edge {
  return { id: edge.id, source: edge.source, target: edge.target, data: { weight: edge.weight, crossFrame: edge.crossFrame, category: edge.category } };
}
