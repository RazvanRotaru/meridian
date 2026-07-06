/**
 * Paint-time transforms for the Module-map surface: HIDE cards by category / test-status, and
 * EMPHASIZE the wires around the active (selected or hovered) card. Both are pure over the already
 * laid-out React Flow arrays — positions are NEVER touched, so filtering or highlighting reshuffles
 * nothing. Kept out of the view component so the rules are small, named, and unit-testable.
 */

import { type Edge, type Node } from "@xyflow/react";
import { arrowMarker } from "../theme/edgeColors";
import type { ModuleCardData } from "../derive/moduleMap";
import type { ModuleCategory } from "../derive/moduleCategory";

// A cross-package import is the coupling signal (warm gold, mirroring composition's cross-boundary
// wire); a same-frame import is expected cohesion (a quiet grey that recedes).
const CROSS_FRAME_COLOR = "#C9A24B";
const INTERNAL_COLOR = "#5B6675";
const SELECT_ACCENT = "#6BE38A";
const DIM_EDGE_OPACITY = 0.12;
const DIM_NODE_OPACITY = 0.28;
const BASE_WIDTH = 1.5;
const EMPHASIS_WIDTH = 2.5;

export interface HideOptions {
  hiddenCategories: ReadonlySet<ModuleCategory>;
  showTests: boolean;
  testIds: ReadonlySet<string>;
}

/**
 * Drop the file cards a filter hides (a category toggled off, or test code with tests hidden), the
 * wires touching them, and any frame left with no visible card — WITHOUT moving anything. A frame
 * survives as long as one of its file children does, so a kept card never points at a removed parent.
 */
export function filterVisible(nodes: Node[], edges: Edge[], options: HideOptions): { nodes: Node[]; edges: Edge[] } {
  const hiddenCards = hiddenCardIds(nodes, options);
  const liveFrames = liveFrameIds(nodes, hiddenCards);
  const keptNodes = nodes.filter((node) =>
    node.type === "frame" ? liveFrames.has(node.id) : !hiddenCards.has(node.id),
  );
  const keptEdges = edges.filter((edge) => !hiddenCards.has(edge.source) && !hiddenCards.has(edge.target));
  return { nodes: keptNodes, edges: keptEdges };
}

function hiddenCardIds(nodes: Node[], options: HideOptions): Set<string> {
  const hidden = new Set<string>();
  for (const node of nodes) {
    if (node.type === "file" && isHidden(node, options)) {
      hidden.add(node.id);
    }
  }
  return hidden;
}

function isHidden(node: Node, options: HideOptions): boolean {
  if (!options.showTests && options.testIds.has(node.id)) {
    return true;
  }
  return options.hiddenCategories.has((node.data as ModuleCardData).category);
}

function liveFrameIds(nodes: Node[], hiddenCards: ReadonlySet<string>): Set<string> {
  const live = new Set<string>();
  for (const node of nodes) {
    if (node.type === "file" && !hiddenCards.has(node.id) && node.parentId) {
      live.add(node.parentId);
    }
  }
  return live;
}

/**
 * Anti-clutter emphasis: EVERY wire is dim by default, so the map reads as cards until the reader
 * points at one. With an active card, its incident wires light to full opacity and every file card
 * NOT one hop away fades — its import neighbourhood stands out. Frames never dim.
 */
export function emphasize(nodes: Node[], edges: Edge[], activeId: string | null): { nodes: Node[]; edges: Edge[] } {
  const styledEdges = edges.map((edge) => styleEdge(edge, activeId !== null && isIncident(edge, activeId)));
  if (activeId === null) {
    return { nodes, edges: styledEdges };
  }
  const connected = connectedIds(edges, activeId);
  const styledNodes = nodes.map((node) =>
    node.type === "frame" || connected.has(node.id) ? node : dimNode(node),
  );
  return { nodes: styledNodes, edges: styledEdges };
}

function isIncident(edge: Edge, id: string): boolean {
  return edge.source === id || edge.target === id;
}

/** The active card plus every card one import hop away (either direction) — its neighbourhood. */
function connectedIds(edges: Edge[], activeId: string): Set<string> {
  const ids = new Set<string>([activeId]);
  for (const edge of edges) {
    if (edge.source === activeId) {
      ids.add(edge.target);
    } else if (edge.target === activeId) {
      ids.add(edge.source);
    }
  }
  return ids;
}

function styleEdge(edge: Edge, lit: boolean): Edge {
  const color = isCrossFrame(edge) ? CROSS_FRAME_COLOR : INTERNAL_COLOR;
  const stroke = lit ? SELECT_ACCENT : color;
  return {
    ...edge,
    style: { stroke, strokeWidth: lit ? EMPHASIS_WIDTH : BASE_WIDTH, opacity: lit ? 1 : DIM_EDGE_OPACITY },
    markerEnd: arrowMarker(stroke, 14),
  };
}

function isCrossFrame(edge: Edge): boolean {
  return (edge.data as { crossFrame?: boolean } | undefined)?.crossFrame === true;
}

function dimNode(node: Node): Node {
  return { ...node, style: { ...node.style, opacity: DIM_NODE_OPACITY } };
}
