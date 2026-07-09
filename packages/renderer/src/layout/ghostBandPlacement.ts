/**
 * Off-ELK placement for Module-map GHOST cards. A ghost is the off-level far end of a code-dependency
 * wire (an off-screen definition or caller). It must NEVER sit inside the graph's perimeter — on a card
 * or in a gap — so ghosts hang just OUTSIDE a bounding box, each past the box edge NEAREST its anchor so
 * a left-hand node's ghosts don't fly across a wide graph.
 *
 * `bandGhostsOutside` is the reusable core (place ids past a box, by anchor). At LAYOUT time
 * `placeGhostBands` runs it over the whole level as a fallback; the real placement is SELECTION-RELATIVE
 * and happens at PAINT time (see components/ghostReposition), where only the few lit ghosts exist and
 * the box is the small lit subgraph — so a node's ghosts land right beside it. Pure: id-sorted, no random.
 */

import type { Node } from "@xyflow/react";
import type { ModuleTreeEdge, VisibleModuleNode } from "../derive/moduleTree";
import type { GhostData } from "../derive/ghostDeps";
import { ghostSize } from "./moduleLevelLayout";

// Clearance between the box and the ghost column, and the vertical gap between stacked ghosts.
const GAP = 56;
const V_GAP = 20;

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}
// LEFT = ghosts that IMPORT the selection (its callers); RIGHT = ghosts it imports (its dependencies) —
// the reader's left-to-right "who calls this → this → what it calls" convention.
export type Side = "left" | "right";

/** One ghost to place: its id, its side (by import direction), its anchor's absolute centre, its size. */
export interface GhostItem {
  id: string;
  side: Side;
  anchorCx: number;
  anchorCy: number;
  width: number;
  height: number;
}

/**
 * The core: position each ghost in a COMPACT COLUMN just outside `box`, on the side its import direction
 * dictates (importers left, dependencies right) — vertical, because a stack of wide file cards is far
 * tidier than a row that runs off screen. Ghosts on a side are ordered by their anchor's Y and packed
 * downward so none overlap. Returns each ghost's top-left by id; outside the box, never on a card inside.
 */
export function bandGhostsOutside(box: Rect, items: GhostItem[]): Map<string, { x: number; y: number }> {
  const bySide: Record<Side, GhostItem[]> = { left: [], right: [] };
  for (const item of items) {
    bySide[item.side].push(item);
  }
  const out = new Map<string, { x: number; y: number }>();
  packColumn(bySide.left, "left", box, out);
  packColumn(bySide.right, "right", box, out);
  return out;
}

/**
 * A column just past the side, ordered by anchor Y and CENTRED on the anchors' mean Y — so a tall column
 * grows up AND down, leveraging the empty space above and below the graph instead of only stacking
 * downward off screen. Ghosts never overlap (fixed pitch). One column x, so it reads as a tidy stack.
 */
function packColumn(items: GhostItem[], side: Side, box: Rect, out: Map<string, { x: number; y: number }>): void {
  if (items.length === 0) {
    return;
  }
  items.sort((a, b) => a.anchorCy - b.anchorCy || a.id.localeCompare(b.id));
  const maxWidth = items.reduce((max, item) => Math.max(max, item.width), 0);
  const totalHeight = items.reduce((sum, item) => sum + item.height, 0) + V_GAP * (items.length - 1);
  const meanAnchorY = items.reduce((sum, item) => sum + item.anchorCy, 0) / items.length;
  const x = side === "right" ? box.x + box.width + GAP : box.x - GAP - maxWidth;
  let y = meanAnchorY - totalHeight / 2;
  for (const item of items) {
    out.set(item.id, { x, y });
    y += item.height + V_GAP;
  }
}

/**
 * Layout-time fallback: band every ghost outside the whole level's box (mostly hidden at rest and
 * overridden by the paint-time, selection-relative placement). Emits ghosts as ROOT React Flow nodes.
 */
export function placeGhostBands(ghosts: VisibleModuleNode[], ghostWires: ModuleTreeEdge[], coreNodes: Node[]): Node[] {
  if (ghosts.length === 0 || coreNodes.length === 0) {
    return [];
  }
  const anchoring = anchoringByGhost(ghostWires, new Set(ghosts.map((ghost) => ghost.id)));
  const rects = anchorRects(coreNodes);
  const box = boundingBoxOf([...rects.values()]);
  const sizeById = new Map(ghosts.map((ghost) => [ghost.id, ghostSize(ghost.data as GhostData)]));
  const items: GhostItem[] = [];
  for (const ghost of ghosts) {
    const info = anchoring.get(ghost.id);
    const anchor = info ? rects.get(info.anchorId) : undefined;
    if (!info || !anchor) {
      continue;
    }
    const size = sizeById.get(ghost.id)!;
    items.push({ id: ghost.id, side: info.side, anchorCx: anchor.x + anchor.width / 2, anchorCy: anchor.y + anchor.height / 2, ...size });
  }
  const positions = bandGhostsOutside(box, items);
  return ghosts
    .map((ghost) => {
      const pos = positions.get(ghost.id);
      const size = sizeById.get(ghost.id)!;
      return pos ? toGhostNode(ghost, { ...pos, ...size }) : null;
    })
    .filter((node): node is Node => node !== null);
}

/**
 * Per ghost, its anchor (the drawn node its wire touches) and its SIDE by import direction: a wire
 * drawn→ghost means the selection imports the ghost (a DEPENDENCY → right); ghost→drawn means the ghost
 * imports the selection (a CALLER → left). A ghost seen both ways takes the majority (tie → right).
 */
function anchoringByGhost(ghostWires: ModuleTreeEdge[], ghostIds: ReadonlySet<string>): Map<string, { anchorId: string; side: Side }> {
  const dependencyOf = new Map<string, string[]>(); // drawn→ghost: anchors that import the ghost (RIGHT)
  const callerOf = new Map<string, string[]>(); //     ghost→drawn: anchors the ghost imports    (LEFT)
  for (const wire of ghostWires) {
    if (ghostIds.has(wire.target)) {
      push(dependencyOf, wire.target, wire.source);
    } else if (ghostIds.has(wire.source)) {
      push(callerOf, wire.source, wire.target);
    }
  }
  const anchoring = new Map<string, { anchorId: string; side: Side }>();
  for (const ghostId of ghostIds) {
    const dep = dependencyOf.get(ghostId) ?? [];
    const call = callerOf.get(ghostId) ?? [];
    if (dep.length === 0 && call.length === 0) {
      continue;
    }
    const side: Side = dep.length >= call.length ? "right" : "left";
    const anchors = side === "right" ? dep : call;
    anchoring.set(ghostId, { anchorId: [...anchors].sort()[0], side });
  }
  return anchoring;
}

function push(map: Map<string, string[]>, ghostId: string, anchorId: string): void {
  const list = map.get(ghostId) ?? [];
  list.push(anchorId);
  map.set(ghostId, list);
}

/** Absolute rect of every core node, keyed by id (positions are parent-relative inside frames). */
function anchorRects(coreNodes: Node[]): Map<string, Rect> {
  const byId = new Map(coreNodes.map((node) => [node.id, node]));
  const rects = new Map<string, Rect>();
  for (const node of coreNodes) {
    rects.set(node.id, absoluteRectOf(node, byId));
  }
  return rects;
}

/** A node's absolute rect: sum `position` up the `parentId` chain, size from `style`. */
export function absoluteRectOf(node: Node, byId: ReadonlyMap<string, Node>): Rect {
  let x = node.position.x;
  let y = node.position.y;
  let parentId = node.parentId;
  const seen = new Set<string>([node.id]);
  while (parentId && !seen.has(parentId)) {
    const parent = byId.get(parentId);
    if (!parent) {
      break;
    }
    x += parent.position.x;
    y += parent.position.y;
    seen.add(parentId);
    parentId = parent.parentId;
  }
  const style = (node.style ?? {}) as { width?: number; height?: number };
  return { x, y, width: style.width ?? 0, height: style.height ?? 0 };
}

/** The bounding box enclosing every rect. */
export function boundingBoxOf(rects: Rect[]): Rect {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const rect of rects) {
    minX = Math.min(minX, rect.x);
    minY = Math.min(minY, rect.y);
    maxX = Math.max(maxX, rect.x + rect.width);
    maxY = Math.max(maxY, rect.y + rect.height);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** Emit a ghost as a ROOT React Flow node at its spot; `data` is passed through untouched. */
function toGhostNode(ghost: VisibleModuleNode, rect: Rect): Node {
  return {
    id: ghost.id,
    type: "ghost",
    position: { x: rect.x, y: rect.y },
    style: { width: rect.width, height: rect.height },
    data: ghost.data,
  };
}
