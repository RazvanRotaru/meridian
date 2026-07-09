/**
 * Off-ELK placement for Module-map GHOST cards. A ghost is the off-level far end of a code-dependency
 * wire (an off-screen definition or caller); feeding it to ELK gives it a layer slot and pushes the
 * real frames apart, so instead we lay the core out with ELK and then hang each ghost RIGHT BESIDE the
 * drawn node its wire touches (its ANCHOR) — close enough to stay on screen, never banished to the far
 * edge of a big graph.
 *
 * A node's ghosts form a small vertical fan just off the anchor: an OUTGOING dependency (wire
 * drawn→ghost) fans to the anchor's RIGHT, an INCOMING caller (wire ghost→drawn) to its LEFT. Ghosts of
 * the same anchor are centred on it; ghosts are pushed down past any already-placed ghost so no two
 * overlap. Pure: id-sorted, no clock/random.
 */

import type { Node } from "@xyflow/react";
import type { ModuleTreeEdge, VisibleModuleNode } from "../derive/moduleTree";
import type { GhostData } from "../derive/ghostDeps";
import { ghostSize } from "./moduleLevelLayout";

// Horizontal clearance between the anchor card and its ghost fan, and the vertical gap between stacked
// ghosts. Small, so ghosts sit next to the node they belong to (a short pan at most, not a far band).
const GAP = 52;
const V_GAP = 22;

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
interface Group {
  anchor: Rect;
  direction: Direction;
  ghosts: VisibleModuleNode[];
}

/**
 * Place every ghost in a fan beside its anchor. `coreNodes` are the ELK-laid React Flow nodes
 * (positions are parent-relative inside frames); ghosts are emitted as ROOT nodes at absolute
 * positions next to the anchor's edge, pushed down so no two ghosts overlap.
 */
export function placeGhostBands(ghosts: VisibleModuleNode[], ghostWires: ModuleTreeEdge[], coreNodes: Node[]): Node[] {
  if (ghosts.length === 0 || coreNodes.length === 0) {
    return [];
  }
  const anchoring = anchoringByGhost(ghostWires, new Set(ghosts.map((ghost) => ghost.id)));
  const rects = anchorRects(coreNodes);
  const groups = groupByAnchor(ghosts, anchoring, rects);
  const placed: Rect[] = [];
  const out: Node[] = [];
  for (const key of [...groups.keys()].sort()) {
    const group = groups.get(key)!;
    out.push(...placeFan(group, placed));
  }
  return out;
}

/** Group a direction's ghosts under their shared anchor, so each anchor's ghosts fan together. */
function groupByAnchor(ghosts: VisibleModuleNode[], anchoring: Map<string, Anchoring>, rects: Map<string, Rect>): Map<string, Group> {
  const groups = new Map<string, Group>();
  for (const ghost of ghosts) {
    const anchor = anchoring.get(ghost.id);
    const rect = anchor ? rects.get(anchor.anchorId) : undefined;
    if (!anchor || !rect) {
      continue; // an unwired ghost (pruned at paint) or one whose anchor isn't drawn has nowhere to hang.
    }
    const key = `${anchor.anchorId}|${anchor.direction}`;
    (groups.get(key) ?? setGet(groups, key, { anchor: rect, direction: anchor.direction, ghosts: [] })).ghosts.push(ghost);
  }
  return groups;
}

/** Stack a group's ghosts in a column beside the anchor, centred on it, each pushed below any overlap. */
function placeFan(group: Group, placed: Rect[]): Node[] {
  const ghosts = [...group.ghosts].sort((a, b) => a.id.localeCompare(b.id));
  const sizes = ghosts.map((ghost) => ghostSize(ghost.data as GhostData));
  const total = sizes.reduce((sum, size) => sum + size.height, 0) + V_GAP * (ghosts.length - 1);
  let y = group.anchor.y + group.anchor.height / 2 - total / 2;
  const out: Node[] = [];
  ghosts.forEach((ghost, i) => {
    const size = sizes[i];
    const x = group.direction === "right" ? group.anchor.x + group.anchor.width + GAP : group.anchor.x - GAP - size.width;
    const rect = pushBelow({ x, y, ...size }, placed);
    placed.push(rect);
    out.push(toGhostNode(ghost, rect));
    y = rect.y + size.height + V_GAP;
  });
  return out;
}

/** Slide a rect straight down until it clears every already-placed ghost (keeps the fan's column x). */
function pushBelow(rect: Rect, placed: Rect[]): Rect {
  let candidate = rect;
  let guard = 0;
  while (guard < 1000 && placed.some((other) => overlaps(candidate, other))) {
    const blocker = placed.find((other) => overlaps(candidate, other))!;
    candidate = { ...candidate, y: blocker.y + blocker.height + V_GAP };
    guard += 1;
  }
  return candidate;
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

function setGet<K, V>(map: Map<K, V>, key: K, value: V): V {
  map.set(key, value);
  return value;
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

/** Emit a ghost as a ROOT React Flow node at its fan spot; `data` is passed through untouched. */
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
