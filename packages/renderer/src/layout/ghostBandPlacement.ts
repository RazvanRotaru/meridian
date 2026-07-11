/**
 * Off-ELK placement for Module-map GHOST cards. A ghost is the off-level far end of a code-dependency
 * wire (an off-screen definition or caller). It must NEVER sit inside the graph's perimeter — on a card
 * or in a gap — so ghosts hang just OUTSIDE a bounding box, each past the box edge NEAREST its anchor so
 * a left-hand node's ghosts don't fly across a wide graph.
 *
 * `bandGhostsOutside` is the reusable core (place ids past a box, by anchor). At LAYOUT time
 * `placeGhostBands` runs it over the whole level as a fallback; the real placement is
 * SELECTION-RELATIVE and happens at PAINT time (see components/ghostReposition), where only the
 * selection's complete lit neighbourhood exists and the box is the small lit subgraph — so a
 * node's ghosts land right beside it. Pure: id-sorted, no random.
 */

import type { Node } from "@xyflow/react";
import type { ModuleTreeEdge, VisibleModuleNode } from "../derive/moduleTree";
import type { GhostData } from "../derive/ghostDeps";
import { ghostSize } from "./moduleLevelLayout";

// Clearance between the box and the first ghost column, plus gaps within the bounded-height grid.
const GAP = 56;
const V_GAP = 20;
const H_GAP = 24;
/** Showing every related ghost must not create a single viewport-crushing tower. Fill at most eight
 * rows beside the graph, then grow into another column farther outward. */
export const MAX_GHOST_ROWS_PER_COLUMN = 8;

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}
// LEFT = ghosts that IMPORT the selection (its callers); RIGHT = ghosts it imports (its dependencies) —
// the reader's left-to-right "who calls this → this → what it calls" convention.
export type Side = "left" | "right";

/** One ghost to place: its id, its side (by import direction), its anchor's absolute centre, its size.
 * Expandable parent anchors request an outer column so their disclosed children can continue
 * growing away from the core instead of reaching back across a column of ordinary ghosts. */
export interface GhostItem {
  id: string;
  side: Side;
  anchorCx: number;
  anchorCy: number;
  width: number;
  height: number;
  outerColumn?: boolean;
}

/** One expanded paint-time parent group and the exact children it discloses. The parent already
 * occupies the ordinary outside band; members must grow farther outward on the same side. */
export interface GhostHierarchyGroup {
  parentId: string;
  side: Side;
  parent: Rect;
  members: Array<{ id: string; width: number; height: number }>;
}

/**
 * The core: position each ghost in compact bounded-height COLUMNS just outside `box`, on the side
 * its import direction dictates (importers left, dependencies right). A side fills eight rows in
 * anchor order, then grows outward into another column instead of forcing fitView to zoom around a
 * single unbounded tower. Returns each ghost's top-left by id; outside the box, never inside it.
 */
export function bandGhostsOutside(box: Rect, items: GhostItem[]): Map<string, { x: number; y: number }> {
  const bySide: Record<Side, GhostItem[]> = { left: [], right: [] };
  for (const item of items) {
    bySide[item.side].push(item);
  }
  const out = new Map<string, { x: number; y: number }>();
  packColumns(bySide.left, "left", box, out);
  packColumns(bySide.right, "right", box, out);
  return out;
}

// Expanded members sit closer together than unrelated roots, so the group reads as one disclosed
// family. Large families still fan into bounded-height columns instead of rebuilding a tall tower.
const HIERARCHY_GAP = 38;
const HIERARCHY_V_GAP = 10;
const HIERARCHY_H_GAP = 18;

/**
 * Place exact members beyond their already-banded parent groups. A hierarchy edge's direction
 * chooses the side: outgoing parent→child grows right, incoming child→parent mirrors left. Groups,
 * members and occupied rects are sorted/checked deterministically; a colliding member column moves
 * one pitch farther outward until it clears the core, every parent card and earlier families.
 */
export function placeGhostHierarchy(
  groups: readonly GhostHierarchyGroup[],
  occupiedRects: readonly Rect[] = [],
): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>();
  const occupied = [...occupiedRects];
  const ordered = [...groups].sort(
    (a, b) => a.side.localeCompare(b.side) || a.parent.y - b.parent.y || a.parent.x - b.parent.x || a.parentId.localeCompare(b.parentId),
  );
  for (const group of ordered) {
    const members = [...group.members].sort((a, b) => a.id.localeCompare(b.id));
    let nearEdge = group.side === "right"
      ? group.parent.x + group.parent.width + HIERARCHY_GAP
      : group.parent.x - HIERARCHY_GAP;
    for (let start = 0; start < members.length; start += MAX_GHOST_ROWS_PER_COLUMN) {
      const column = members.slice(start, start + MAX_GHOST_ROWS_PER_COLUMN);
      const width = column.reduce((max, member) => Math.max(max, member.width), 0);
      const height = column.reduce((sum, member) => sum + member.height, 0) + HIERARCHY_V_GAP * (column.length - 1);
      const y = group.parent.y + group.parent.height / 2 - height / 2;
      let x = group.side === "right" ? nearEdge : nearEdge - width;
      const outwardStep = (width + HIERARCHY_H_GAP) * (group.side === "right" ? 1 : -1);
      while (occupied.some((rect) => overlapsRect({ x, y, width, height }, rect))) {
        x += outwardStep;
      }
      let memberY = y;
      for (const member of column) {
        positions.set(member.id, { x, y: memberY });
        occupied.push({ x, y: memberY, width: member.width, height: member.height });
        memberY += member.height + HIERARCHY_V_GAP;
      }
      nearEdge = group.side === "right" ? x + width + HIERARCHY_H_GAP : x - HIERARCHY_H_GAP;
    }
  }
  return positions;
}

function overlapsRect(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

/**
 * Columns are ordered by anchor Y, with the first closest to the graph. When a lane actually needs
 * multiple columns, ordinary ghosts fill the inner capacity first and expandable parent anchors
 * occupy the outermost column(s). Spare capacity in those outer columns can still hold ordinary
 * ghosts, so prioritisation never widens the lane by itself. Each column is centred on its own
 * anchors' mean Y, grows up and down, and uses its widest member as the horizontal pitch.
 */
function packColumns(items: GhostItem[], side: Side, box: Rect, out: Map<string, { x: number; y: number }>): void {
  if (items.length === 0) {
    return;
  }
  const ordered = [...items].sort((a, b) => a.anchorCy - b.anchorCy || a.id.localeCompare(b.id));
  const columns = prioritizedColumns(ordered);
  let outwardOffset = 0;
  for (const column of columns) {
    const maxWidth = column.reduce((max, item) => Math.max(max, item.width), 0);
    const totalHeight = column.reduce((sum, item) => sum + item.height, 0) + V_GAP * (column.length - 1);
    const meanAnchorY = column.reduce((sum, item) => sum + item.anchorCy, 0) / column.length;
    const x = side === "right"
      ? box.x + box.width + GAP + outwardOffset
      : box.x - GAP - outwardOffset - maxWidth;
    let y = meanAnchorY - totalHeight / 2;
    for (const item of column) {
      out.set(item.id, { x, y });
      y += item.height + V_GAP;
    }
    outwardOffset += maxWidth + H_GAP;
  }
}

function chunkColumns(items: readonly GhostItem[]): GhostItem[][] {
  const columns: GhostItem[][] = [];
  for (let start = 0; start < items.length; start += MAX_GHOST_ROWS_PER_COLUMN) {
    columns.push(items.slice(start, start + MAX_GHOST_ROWS_PER_COLUMN));
  }
  return columns;
}

/** Reserve only the column capacity already required by the total item count. Parents occupy the
 * final K columns; ordinary overflow may share them, but no parent can remain in an inner column. */
function prioritizedColumns(ordered: readonly GhostItem[]): GhostItem[][] {
  const regular = ordered.filter((item) => item.outerColumn !== true);
  const outer = ordered.filter((item) => item.outerColumn === true);
  if (ordered.length <= MAX_GHOST_ROWS_PER_COLUMN || regular.length === 0 || outer.length === 0) {
    return chunkColumns(ordered);
  }
  const totalColumnCount = Math.ceil(ordered.length / MAX_GHOST_ROWS_PER_COLUMN);
  const outerColumnCount = Math.ceil(outer.length / MAX_GHOST_ROWS_PER_COLUMN);
  const innerCapacity = (totalColumnCount - outerColumnCount) * MAX_GHOST_ROWS_PER_COLUMN;
  const inner = regular.slice(0, innerCapacity);
  const outerPool = [...regular.slice(innerCapacity), ...outer];
  return [...chunkColumns(inner), ...chunkColumns(outerPool)].map((column) =>
    column.sort((a, b) => a.anchorCy - b.anchorCy || a.id.localeCompare(b.id)),
  );
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
    items.push({
      id: ghost.id,
      side: info.side,
      anchorCx: anchor.x + anchor.width / 2,
      anchorCy: anchor.y + anchor.height / 2,
      ...size,
      ...(isExpandableParentData(ghost.data) ? { outerColumn: true } : {}),
    });
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

function isExpandableParentData(data: unknown): boolean {
  const candidate = data as { ghostRole?: unknown; groupedGhostCount?: unknown };
  return candidate.ghostRole === "parent-anchor"
    && typeof candidate.groupedGhostCount === "number"
    && candidate.groupedGhostCount > 0;
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
