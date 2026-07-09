/**
 * Off-ELK placement for Module-map GHOST cards. A ghost is the off-level far end of a code-dependency
 * wire (an off-screen definition or caller); feeding it to ELK gives it a layer slot and pushes the
 * real frames apart, so instead we lay the core out with ELK and then drop each ghost at the NEAREST
 * CLEAR SPOT beside the drawn node its wire touches (its ANCHOR).
 *
 * "Nearest clear" is the whole game: a ghost MUST NOT overlap any real card or another ghost, but it
 * should sit as close to its anchor as an overlap-free spot allows — never a far banished band, never
 * on top of a neighbour. From the anchor's side (OUTGOING dependency → RIGHT, INCOMING caller → LEFT) we
 * scan vertical slots at the anchor's row, then step outward one column at a time, taking the first spot
 * that clears everything placed so far. Pure: id-sorted, no clock/random.
 */

import type { Node } from "@xyflow/react";
import type { ModuleTreeEdge, VisibleModuleNode } from "../derive/moduleTree";
import type { GhostData } from "../derive/ghostDeps";
import { ghostSize } from "./moduleLevelLayout";

// The first column sits GAP past the anchor's edge; a blocked column steps COL_STEP farther out. Vertical
// slots step by the ghost's height + V_GAP, scanning up to MAX_DY above/below the anchor row before the
// column is abandoned. The caps are generous safety bounds — a clear spot is almost always found early.
const GAP = 40;
const COL_STEP = 150;
const V_GAP = 20;
const MAX_DY = 6000;
const MAX_COLS = 600;

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}
type Direction = "right" | "left";
interface Anchoring {
  anchorId: string;
  direction: Direction;
}

/**
 * Place every ghost at the nearest overlap-free spot beside its anchor. `coreNodes` are the ELK-laid
 * React Flow nodes (positions are parent-relative inside frames); ghosts are emitted as ROOT nodes at
 * absolute positions. `occupied` seeds with EVERY core card, so a ghost never lands on the graph, and
 * grows with each placed ghost, so no two ghosts overlap either.
 */
export function placeGhostBands(ghosts: VisibleModuleNode[], ghostWires: ModuleTreeEdge[], coreNodes: Node[]): Node[] {
  if (ghosts.length === 0 || coreNodes.length === 0) {
    return [];
  }
  const anchoring = anchoringByGhost(ghostWires, new Set(ghosts.map((ghost) => ghost.id)));
  const rects = anchorRects(coreNodes);
  const occupied: Rect[] = [...rects.values()];
  const out: Node[] = [];
  for (const ghost of sortForPlacement(ghosts, anchoring)) {
    const anchor = anchoring.get(ghost.id);
    const anchorRect = anchor ? rects.get(anchor.anchorId) : undefined;
    if (!anchor || !anchorRect) {
      continue; // an unwired ghost (pruned at paint) or one whose anchor isn't drawn has nowhere to hang.
    }
    const rect = nearestClearSpot(anchorRect, anchor.direction, ghostSize(ghost.data as GhostData), occupied);
    occupied.push(rect);
    out.push(toGhostNode(ghost, rect));
  }
  return out;
}

/** Sort by (anchorId, direction, id) so the greedy placement — and its resolved layout — is stable. */
function sortForPlacement(ghosts: VisibleModuleNode[], anchoring: Map<string, Anchoring>): VisibleModuleNode[] {
  return [...ghosts].sort((a, b) => {
    const ax = anchoring.get(a.id);
    const bx = anchoring.get(b.id);
    return (ax?.anchorId ?? "").localeCompare(bx?.anchorId ?? "") || (ax?.direction ?? "").localeCompare(bx?.direction ?? "") || a.id.localeCompare(b.id);
  });
}

/**
 * The first spot on the anchor's side that overlaps nothing. Column 0 sits GAP past the anchor edge; at
 * each column we scan vertical slots out from the anchor's row (0, +v, -v, …) and take the first free
 * one, else step to the next column farther out. Guarantees an overlap-free result, as near as possible.
 */
function nearestClearSpot(anchor: Rect, direction: Direction, size: { width: number; height: number }, occupied: Rect[]): Rect {
  const sign = direction === "right" ? 1 : -1;
  const rowY = anchor.y + anchor.height / 2 - size.height / 2;
  const firstX = direction === "right" ? anchor.x + anchor.width + GAP : anchor.x - GAP - size.width;
  const step = size.height + V_GAP;
  for (let col = 0; col < MAX_COLS; col += 1) {
    const x = firstX + sign * col * COL_STEP;
    for (let dy = 0; dy <= MAX_DY; dy += step) {
      for (const y of dy === 0 ? [rowY] : [rowY + dy, rowY - dy]) {
        const rect = { x, y, ...size };
        if (!occupied.some((other) => overlaps(rect, other))) {
          return rect;
        }
      }
    }
  }
  return { x: firstX + sign * MAX_COLS * COL_STEP, y: rowY, ...size };
}

/**
 * The anchor + side for each ghost. A ghost wire drawn→ghost is an OUTGOING dependency (RIGHT); a
 * ghost→drawn wire is an INCOMING caller (LEFT). A ghost reachable from both sides takes the side with
 * more wires (tie → right); its anchor is the smallest drawn id on that side.
 */
function anchoringByGhost(ghostWires: ModuleTreeEdge[], ghostIds: ReadonlySet<string>): Map<string, Anchoring> {
  const rightAnchors = new Map<string, string[]>();
  const leftAnchors = new Map<string, string[]>();
  for (const wire of ghostWires) {
    if (ghostIds.has(wire.target)) {
      push(rightAnchors, wire.target, wire.source);
    } else if (ghostIds.has(wire.source)) {
      push(leftAnchors, wire.source, wire.target);
    }
  }
  const anchoring = new Map<string, Anchoring>();
  for (const ghostId of ghostIds) {
    const right = rightAnchors.get(ghostId) ?? [];
    const left = leftAnchors.get(ghostId) ?? [];
    if (right.length === 0 && left.length === 0) {
      continue;
    }
    const direction: Direction = right.length >= left.length ? "right" : "left";
    const anchors = direction === "right" ? right : left;
    anchoring.set(ghostId, { anchorId: [...anchors].sort()[0], direction });
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
  const rects = new Map<string, Rect>();
  for (const node of coreNodes) {
    rects.set(node.id, absoluteRect(node, coreNodes));
  }
  return rects;
}

/** A core node's absolute rect: sum `position` up the `parentId` chain, size from `style`. */
function absoluteRect(node: Node, coreNodes: Node[]): Rect {
  const byId = ABS_CACHE.get(coreNodes) ?? cacheById(coreNodes);
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

// Memoise the id lookup per node array so the O(n) absolute walk isn't O(n²) over rebuilds.
const ABS_CACHE = new WeakMap<Node[], Map<string, Node>>();
function cacheById(coreNodes: Node[]): Map<string, Node> {
  const byId = new Map(coreNodes.map((node) => [node.id, node]));
  ABS_CACHE.set(coreNodes, byId);
  return byId;
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
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

export type { Rect as GhostRect };
