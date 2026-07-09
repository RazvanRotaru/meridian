/**
 * Off-ELK placement for Module-map GHOST cards. A ghost is the off-level far end of a code-dependency
 * wire (an off-screen definition or caller); feeding it to ELK gives it a layer slot and pushes the
 * real frames apart, so instead we lay the core out with ELK and then hang every ghost in a BAND
 * COMPLETELY OUTSIDE the core's bounding box — never intermixed with, or overlapping, the real graph.
 *
 * Direction encodes the wire's meaning: an OUTGOING dependency (wire drawn→ghost) lands in the RIGHT
 * band (just past the core's right edge), an INCOMING caller (wire ghost→drawn) in the LEFT band. Within
 * a band the ghosts stack in a single column ordered by their anchor's Y, greedily packed so none
 * overlap. Pure: id-sorted, no clock/random.
 */

import type { Node } from "@xyflow/react";
import type { ModuleTreeEdge, VisibleModuleNode } from "../derive/moduleTree";
import type { GhostData } from "../derive/ghostDeps";
import { ghostSize } from "./moduleLevelLayout";

// Horizontal clearance between the core's bounding box and the ghost band, and the vertical gap
// between stacked ghosts in a band.
const BAND_GAP = 140;
const V_GAP = 24;

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
interface BandEntry {
  ghost: VisibleModuleNode;
  anchorY: number;
}

/**
 * Place every ghost in a band OUTSIDE the core. `coreNodes` are the ELK-laid React Flow nodes
 * (positions are parent-relative inside frames); ghosts are emitted as ROOT nodes at absolute
 * positions past the core's left/right edge, so they never overlap the graph or each other.
 */
export function placeGhostBands(ghosts: VisibleModuleNode[], ghostWires: ModuleTreeEdge[], coreNodes: Node[]): Node[] {
  if (ghosts.length === 0 || coreNodes.length === 0) {
    return [];
  }
  const anchoring = anchoringByGhost(ghostWires, new Set(ghosts.map((ghost) => ghost.id)));
  const centers = anchorCenters(coreNodes);
  const box = boundingBox(coreNodes);
  const right: BandEntry[] = [];
  const left: BandEntry[] = [];
  for (const ghost of ghosts) {
    const anchor = anchoring.get(ghost.id);
    if (!anchor) {
      continue; // an unwired ghost never renders (pruned at paint) — nothing to anchor.
    }
    const anchorY = centers.get(anchor.anchorId)?.y ?? box.y;
    (anchor.direction === "right" ? right : left).push({ ghost, anchorY });
  }
  return [...placeBand(right, "right", box), ...placeBand(left, "left", box)];
}

/**
 * Stack a band's ghosts in one column just outside the core, ordered by anchor Y. Each ghost wants to
 * sit at its anchor's row but is pushed down past the previous ghost so the column never overlaps —
 * a monotonic greedy pack (entries are Y-sorted first, so the cursor only moves down).
 */
function placeBand(entries: BandEntry[], direction: Direction, box: Rect): Node[] {
  entries.sort((a, b) => a.anchorY - b.anchorY || a.ghost.id.localeCompare(b.ghost.id));
  const out: Node[] = [];
  let cursorY = box.y;
  for (const { ghost, anchorY } of entries) {
    const size = ghostSize(ghost.data as GhostData);
    const x = direction === "right" ? box.x + box.width + BAND_GAP : box.x - BAND_GAP - size.width;
    const y = Math.max(anchorY - size.height / 2, cursorY);
    cursorY = y + size.height + V_GAP;
    out.push(toGhostNode(ghost, { x, y, ...size }));
  }
  return out;
}

/**
 * The anchor + side for each ghost. A ghost wire drawn→ghost is an OUTGOING dependency (RIGHT band);
 * ghost→drawn is an INCOMING caller (LEFT band). A ghost reachable from both sides takes the side with
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

/** Absolute CENTER-Y of every core node, keyed by id (positions are parent-relative inside frames). */
function anchorCenters(coreNodes: Node[]): Map<string, { y: number }> {
  const centers = new Map<string, { y: number }>();
  for (const node of coreNodes) {
    const rect = absoluteRect(node, coreNodes);
    centers.set(node.id, { y: rect.y + rect.height / 2 });
  }
  return centers;
}

/** The absolute bounding box of every core node. */
function boundingBox(coreNodes: Node[]): Rect {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const node of coreNodes) {
    const rect = absoluteRect(node, coreNodes);
    minX = Math.min(minX, rect.x);
    minY = Math.min(minY, rect.y);
    maxX = Math.max(maxX, rect.x + rect.width);
    maxY = Math.max(maxY, rect.y + rect.height);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
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

/** Emit a ghost as a ROOT React Flow node at its band spot; `data` is passed through untouched. */
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
