/**
 * Off-ELK placement for Module-map GHOST cards. A ghost is the off-level far end of a code-dependency
 * wire (an off-screen definition or caller); feeding it to ELK gives it a layer slot and pushes the
 * real frames apart, so instead we lay the core out with ELK and then hang every ghost on a RING
 * around the drawn node its wire touches (its ANCHOR). Each ghost sits at a FIXED radius from its
 * anchor — the user's ask: "shown each at the same distance from the selected node" — so a node's
 * ghosts read as an evenly-spaced band, not a layer of the graph.
 *
 * Direction encodes the wire's meaning: an OUTGOING dependency (wire drawn→ghost) rings to the
 * anchor's RIGHT, an INCOMING caller (wire ghost→drawn) to its LEFT. Pure: id-sorted, no clock/random.
 */

import type { Node } from "@xyflow/react";
import type { ModuleTreeEdge, VisibleModuleNode } from "../derive/moduleTree";
import type { GhostData } from "../derive/ghostDeps";
import { ghostSize } from "./moduleLevelLayout";

// The innermost ring clears a typical anchor card; when a ring's arc fills, ghosts wrap to the next
// ring RING_STEP farther out. The arc is capped short of vertical so ghosts stay clearly to the side.
const RING_RADIUS = 360;
const RING_STEP = 220;
const V_GAP = 28;
const MAX_ARC_SIN = Math.sin((72 * Math.PI) / 180);
const MAX_RINGS = 200;

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
 * Place every ghost on a ring around its anchor. `coreNodes` are the ELK-laid React Flow nodes
 * (positions are parent-relative inside frames); ghosts are emitted as ROOT nodes at absolute
 * positions. Ghosts never overlap each other or a core card — an occupied candidate is pushed to the
 * next free vertical slot, then the next outer ring.
 */
export function placeGhostRing(ghosts: VisibleModuleNode[], ghostWires: ModuleTreeEdge[], coreNodes: Node[]): Node[] {
  const centers = anchorCenters(coreNodes);
  const anchoring = anchoringByGhost(ghostWires, new Set(ghosts.map((ghost) => ghost.id)));
  const occupied = coreNodes.map((node) => absoluteRect(node, coreNodes));
  const out: Node[] = [];
  for (const ghost of sortForPlacement(ghosts, anchoring)) {
    const anchor = anchoring.get(ghost.id);
    const center = anchor ? centers.get(anchor.anchorId) : undefined;
    if (!anchor || !center) {
      continue; // a ghost whose anchor isn't a placed core node has nowhere to hang.
    }
    const rect = placeOnRing(center, anchor.direction, ghostSize(ghost.data as GhostData), occupied);
    occupied.push(rect);
    out.push(toGhostNode(ghost, rect));
  }
  return out;
}

/** Sort by (anchorId, direction, id) so placement — and thus the resolved ring layout — is stable. */
function sortForPlacement(ghosts: VisibleModuleNode[], anchoring: Map<string, Anchoring>): VisibleModuleNode[] {
  return [...ghosts].sort((a, b) => {
    const ax = anchoring.get(a.id);
    const bx = anchoring.get(b.id);
    return (ax?.anchorId ?? "").localeCompare(bx?.anchorId ?? "") || (ax?.direction ?? "").localeCompare(bx?.direction ?? "") || a.id.localeCompare(b.id);
  });
}

/**
 * The anchor + side for each ghost. A ghost wire drawn→ghost is an OUTGOING dependency (ghost on the
 * RIGHT); ghost→drawn is an INCOMING caller (ghost on the LEFT). A ghost reachable from both sides
 * takes the side with more wires (tie → right); its anchor is the smallest drawn id on that side.
 */
function anchoringByGhost(ghostWires: ModuleTreeEdge[], ghostIds: ReadonlySet<string>): Map<string, Anchoring> {
  const rightAnchors = new Map<string, string[]>();
  const leftAnchors = new Map<string, string[]>();
  for (const wire of ghostWires) {
    // Exactly one endpoint is a ghost. A drawn→ghost wire names the ghost as target (an OUTGOING
    // dependency, ring RIGHT); a ghost→drawn wire names it as source (an INCOMING caller, ring LEFT).
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
      continue; // an unwired ghost never renders (pruned at paint) — nothing to anchor.
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

/**
 * Find the first free spot on a ring of radius R around `center`, on the given side. Vertical slots
 * step out from the anchor's row (0, +v, -v, …) keeping every ghost the SAME distance R from the
 * anchor (x = R·cos, y = R·sin); when the arc fills — no slot within it is free — the ring grows by
 * RING_STEP. The far-out fallback guarantees termination.
 */
function placeOnRing(center: { x: number; y: number }, direction: Direction, size: { width: number; height: number }, occupied: Rect[]): Rect {
  const sign = direction === "right" ? 1 : -1;
  const step = size.height + V_GAP;
  for (let ring = 0; ring < MAX_RINGS; ring += 1) {
    const radius = RING_RADIUS + ring * RING_STEP;
    const maxDy = radius * MAX_ARC_SIN;
    for (const dy of slots(maxDy, step)) {
      const cos = Math.sqrt(Math.max(0, 1 - (dy / radius) ** 2));
      const rect = rectAt(center.x + sign * radius * cos, center.y + dy, size);
      if (!occupied.some((other) => overlaps(rect, other))) {
        return rect;
      }
    }
  }
  return rectAt(center.x + sign * (RING_RADIUS + MAX_RINGS * RING_STEP), center.y, size);
}

/** Vertical slot offsets within the ring's arc: 0, +step, -step, +2·step, … capped at ±maxDy. */
function slots(maxDy: number, step: number): number[] {
  const offsets = [0];
  for (let k = 1; k * step <= maxDy; k += 1) {
    offsets.push(k * step, -k * step);
  }
  return offsets;
}

function rectAt(cx: number, cy: number, size: { width: number; height: number }): Rect {
  return { x: cx - size.width / 2, y: cy - size.height / 2, width: size.width, height: size.height };
}

/** Absolute CENTER of every core node, keyed by id (positions are parent-relative inside frames). */
function anchorCenters(coreNodes: Node[]): Map<string, { x: number; y: number }> {
  const centers = new Map<string, { x: number; y: number }>();
  for (const node of coreNodes) {
    const rect = absoluteRect(node, coreNodes);
    centers.set(node.id, { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
  }
  return centers;
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

/** Emit a ghost as a ROOT React Flow node at its ring spot; `data` is passed through untouched. */
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
export const GHOST_RING_RADIUS = RING_RADIUS;
