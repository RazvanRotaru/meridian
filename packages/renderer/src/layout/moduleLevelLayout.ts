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
import type { BlockData } from "../derive/moduleLevel";

const GROUP_HEIGHT = 76;
const GROUP_MIN_WIDTH = 172;
const GROUP_MAX_WIDTH = 320;
const WIDTH_PER_FILE = 3;
const FILE_WIDTH = 210;
const FILE_HEIGHT = 54;
// A memberless unit is a compact identity card; a unit with members is an ELK container (frame).
const UNIT_LEAF_WIDTH = 200;
const UNIT_LEAF_HEIGHT = 42;
// Code blocks (methods, functions, type definitions) are small fixed nodes sized to one label,
// widened a little with the label so long names don't clip.
const BLOCK_MIN_WIDTH = 132;
const BLOCK_MAX_WIDTH = 220;
const BLOCK_WIDTH_PER_CHAR = 7;
const BLOCK_BASE_WIDTH = 46;
const BLOCK_HEIGHT = 30;

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

/** A collapsed group sizes with its file count; file cards, unit leaf cards, and code blocks are
 * fixed (blocks widen a little with their label). Expanded groups, file frames, and unit frames
 * are ELK-sized around their children. */
function leafSize(node: VisibleModuleNode): { width: number; height: number } {
  if (node.kind === "block") {
    return blockSize(node.data as BlockData);
  }
  if (node.kind === "unit") {
    return { width: UNIT_LEAF_WIDTH, height: UNIT_LEAF_HEIGHT };
  }
  if (node.kind === "file") {
    return { width: FILE_WIDTH, height: FILE_HEIGHT };
  }
  return { width: groupWidth(fileCountOf(node)), height: GROUP_HEIGHT };
}

function blockSize(data: BlockData): { width: number; height: number } {
  const width = Math.max(BLOCK_MIN_WIDTH, Math.min(BLOCK_MAX_WIDTH, BLOCK_BASE_WIDTH + data.label.length * BLOCK_WIDTH_PER_CHAR));
  return { width, height: BLOCK_HEIGHT };
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
