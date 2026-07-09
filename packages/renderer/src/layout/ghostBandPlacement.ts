/**
 * Off-ELK placement for Module-map GHOST cards. A ghost is the off-level far end of a code-dependency
 * wire (an off-screen definition or caller); feeding it to ELK gives it a layer slot and pushes the
 * real frames apart, so instead we lay the core out with ELK and then hang every ghost in a band
 * COMPLETELY OUTSIDE the core's bounding box — a ghost must NEVER sit inside the graph's perimeter, on
 * top of a card or in a gap between cards.
 *
 * Direction picks the side: an OUTGOING dependency (wire drawn→ghost) bands just past the RIGHT edge, an
 * INCOMING caller (wire ghost→drawn) just past the LEFT edge. Within a band ghosts are ordered by their
 * anchor's Y so each sits across from the node it belongs to, and packed downward so no two overlap.
 * Being outside the box, a ghost can never overlap a real card. Pure: id-sorted, no clock/random.
 */

import type { Node } from "@xyflow/react";
import type { ModuleTreeEdge, VisibleModuleNode } from "../derive/moduleTree";
import type { GhostData } from "../derive/ghostDeps";
import { ghostSize } from "./moduleLevelLayout";

// Clearance between the core's bounding box and the ghost band, and the vertical gap between stacked
// ghosts. Small, so the band sits just OUTSIDE the perimeter rather than banished far away.
const GAP = 60;
const V_GAP = 20;

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
  size: { width: number; height: number };
}

/**
 * Place every ghost in a band OUTSIDE the core's bounding box. `coreNodes` are the ELK-laid React Flow
 * nodes (positions are parent-relative inside frames); ghosts are emitted as ROOT nodes just past the
 * core's left/right edge, so they can never overlap the graph, and packed within the band so no two
 * ghosts overlap either.
 */
export function placeGhostBands(ghosts: VisibleModuleNode[], ghostWires: ModuleTreeEdge[], coreNodes: Node[]): Node[] {
  if (ghosts.length === 0 || coreNodes.length === 0) {
    return [];
  }
  const anchoring = anchoringByGhost(ghostWires, new Set(ghosts.map((ghost) => ghost.id)));
  const rects = anchorRects(coreNodes);
  const box = boundingBox([...rects.values()]);
  const right: BandEntry[] = [];
  const left: BandEntry[] = [];
  for (const ghost of ghosts) {
    const anchor = anchoring.get(ghost.id);
    const anchorRect = anchor ? rects.get(anchor.anchorId) : undefined;
    if (!anchor || !anchorRect) {
      continue; // an unwired ghost (pruned at paint) or one whose anchor isn't drawn has nowhere to hang.
    }
    const entry: BandEntry = { ghost, anchorY: anchorRect.y + anchorRect.height / 2, size: ghostSize(ghost.data as GhostData) };
    (anchor.direction === "right" ? right : left).push(entry);
  }
  return [...placeBand(right, "right", box), ...placeBand(left, "left", box)];
}

/**
 * Stack a band's ghosts in one column just outside the box, ordered by anchor Y so each sits across from
 * its anchor. Each ghost wants its anchor's row but is pushed below the previous ghost so the column
 * never overlaps — a monotonic pack (entries are Y-sorted, so the cursor only moves down).
 */
function placeBand(entries: BandEntry[], direction: Direction, box: Rect): Node[] {
  entries.sort((a, b) => a.anchorY - b.anchorY || a.ghost.id.localeCompare(b.ghost.id));
  const out: Node[] = [];
  let cursorY = -Infinity;
  for (const entry of entries) {
    const { size } = entry;
    const x = direction === "right" ? box.x + box.width + GAP : box.x - GAP - size.width;
    const y = Math.max(entry.anchorY - size.height / 2, cursorY);
    cursorY = y + size.height + V_GAP;
    out.push(toGhostNode(entry.ghost, { x, y, ...size }));
  }
  return out;
}

/** The absolute bounding box enclosing every core node. */
function boundingBox(rects: Rect[]): Rect {
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
