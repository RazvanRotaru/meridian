/**
 * Paint-time transforms for the Module-map surface: HIDE file cards by category / test-status, and
 * EMPHASIZE the wires within N import hops of the active (selected) node. Both are pure over the
 * already laid-out React Flow arrays — positions are NEVER touched, so filtering or highlighting
 * reshuffles nothing. Kept out of the view component so the rules are small, named, and testable.
 * A group card is never category-hidden (only file cards are), so an expanded frame and its nested
 * children's parent chain always survive a repaint — React Flow never loses a referenced parent.
 */

import { type Edge, type Node } from "@xyflow/react";
import { arrowMarker } from "../theme/edgeColors";
import type { ModuleCardData } from "../derive/moduleLevel";
import type { ModuleCategory } from "../derive/moduleCategory";

// A cross-frame import (a group is involved) is the coupling signal (warm gold); a same-level
// file↔file import is expected cohesion (a quiet grey that recedes). Unit-dependency wires are
// violet — a separate story from imports — and light in their own accent so selecting a unit
// highlights the edges to its service dependencies' DEFINITIONS distinctly.
const CROSS_FRAME_COLOR = "#C9A24B";
const INTERNAL_COLOR = "#5B6675";
const DEP_COLOR = "#7C6FBF";
const DEP_ACCENT = "#A78BFA";
const SELECT_ACCENT = "#6BE38A";
const DIM_EDGE_OPACITY = 0.12;
// Dependency wires stay faintly readable even unselected, so expanding a file immediately shows
// where its units' dependencies point.
const DIM_DEP_OPACITY = 0.3;
const DIM_NODE_OPACITY = 0.28;
const BASE_WIDTH = 1.5;
const EMPHASIS_WIDTH = 2.5;

export interface HideOptions {
  hiddenCategories: ReadonlySet<ModuleCategory>;
  showTests: boolean;
  testIds: ReadonlySet<string>;
}

/**
 * Drop the file cards a filter hides (a category toggled off, or test code with tests hidden) and
 * the wires touching them — WITHOUT moving anything. Group cards are never category-hidden (a
 * directory has no single category), so the level's structure holds. Hiding closes over drawn
 * DESCENDANTS: an expanded file frame that hides takes its nested unit cards with it, so the
 * toggle's contract holds and React Flow never sees a child whose parent frame vanished.
 */
export function filterVisible(nodes: Node[], edges: Edge[], options: HideOptions): { nodes: Node[]; edges: Edge[] } {
  const hidden = hiddenCardIds(nodes, options);
  if (hidden.size === 0) {
    return { nodes, edges };
  }
  const keptNodes = nodes.filter((node) => !hidden.has(node.id));
  const keptEdges = edges.filter((edge) => !hidden.has(edge.source) && !hidden.has(edge.target));
  return { nodes: keptNodes, edges: keptEdges };
}

function hiddenCardIds(nodes: Node[], options: HideOptions): Set<string> {
  const hidden = new Set<string>();
  // Nodes arrive parents-before-children (a React Flow requirement), so one pass both applies the
  // filters and closes hiding over each hidden card's drawn subtree via parentId membership.
  for (const node of nodes) {
    if (node.parentId && hidden.has(node.parentId)) {
      hidden.add(node.id);
      continue;
    }
    if ((node.type === "file" || node.type === "unit") && isHidden(node, options)) {
      hidden.add(node.id);
    }
  }
  return hidden;
}

function isHidden(node: Node, options: HideOptions): boolean {
  if (!options.showTests && options.testIds.has(node.id)) {
    return true;
  }
  // Unit cards carry no category of their own; they hide with their file frame (subtree closure).
  return options.hiddenCategories.has((node.data as ModuleCardData).category);
}

/**
 * Anti-clutter emphasis: EVERY wire is dim by default, so a level reads as its cards until the
 * reader points at one. With an active node, its import neighbourhood within `radius` hops lights to
 * full opacity and every node outside it fades. `radius` 1 = direct neighbours (the default reach).
 */
export function emphasize(nodes: Node[], edges: Edge[], activeId: string | null, radius: number): { nodes: Node[]; edges: Edge[] } {
  // A selection that is no longer drawn (its frame collapsed, its card filtered away) must read as
  // "nothing selected" — otherwise every node dims with nothing highlighted.
  if (activeId === null || !nodes.some((node) => node.id === activeId)) {
    return { nodes, edges: edges.map((edge) => styleEdge(edge, false)) };
  }
  const near = neighbourhood(edges, activeId, radius);
  const styledEdges = edges.map((edge) => styleEdge(edge, near.has(edge.source) && near.has(edge.target)));
  const styledNodes = nodes.map((node) => (near.has(node.id) ? node : dimNode(node)));
  return { nodes: styledNodes, edges: styledEdges };
}

/** The active node plus every node within `radius` undirected import hops of it. */
function neighbourhood(edges: Edge[], activeId: string, radius: number): Set<string> {
  const reached = new Set<string>([activeId]);
  let frontier = [activeId];
  for (let hop = 0; hop < Math.max(1, radius) && frontier.length > 0; hop += 1) {
    const next: string[] = [];
    for (const edge of edges) {
      pushNeighbour(edge.source, edge.target, frontier, reached, next);
      pushNeighbour(edge.target, edge.source, frontier, reached, next);
    }
    frontier = next;
  }
  return reached;
}

function pushNeighbour(from: string, to: string, frontier: string[], reached: Set<string>, next: string[]): void {
  if (frontier.includes(from) && !reached.has(to)) {
    reached.add(to);
    next.push(to);
  }
}

function styleEdge(edge: Edge, lit: boolean): Edge {
  const dep = isDep(edge);
  const color = dep ? DEP_COLOR : isCrossFrame(edge) ? CROSS_FRAME_COLOR : INTERNAL_COLOR;
  const stroke = lit ? (dep ? DEP_ACCENT : SELECT_ACCENT) : color;
  const dimOpacity = dep ? DIM_DEP_OPACITY : DIM_EDGE_OPACITY;
  return {
    ...edge,
    style: { stroke, strokeWidth: lit ? EMPHASIS_WIDTH : BASE_WIDTH, opacity: lit ? 1 : dimOpacity },
    markerEnd: arrowMarker(stroke, 14),
  };
}

function isCrossFrame(edge: Edge): boolean {
  return (edge.data as { crossFrame?: boolean } | undefined)?.crossFrame === true;
}

function isDep(edge: Edge): boolean {
  return (edge.data as { category?: string } | undefined)?.category === "dep";
}

function dimNode(node: Node): Node {
  return { ...node, style: { ...node.style, opacity: DIM_NODE_OPACITY } };
}
