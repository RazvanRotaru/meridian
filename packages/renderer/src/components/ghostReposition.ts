/**
 * Paint-time, SELECTION-RELATIVE ghost placement. The layout lays out ALL of a level's ghosts at once,
 * so a selected node's ghosts land far down a shared global band. Here — after the paint pass has
 * pruned to the complete LIT neighbourhood (and optionally grouped sibling crowds) — we reposition
 * those presented ghosts around the lit subgraph's own small bounding box, so they sit right beside
 * the selected code, outside the local perimeter, never across the whole graph. Pure: no store, no React.
 */

import type { Edge, Node } from "@xyflow/react";
import {
  bandGhostsOutside,
  boundingBoxOf,
  absoluteRectOf,
  placeGhostHierarchy,
  type GhostHierarchyGroup,
  type GhostItem,
  type Rect,
  type Side,
} from "../layout/ghostBandPlacement";

// A core node counts as LIT (part of the selection's neighbourhood) unless the emphasis pass dimmed it.
const LIT_OPACITY_FLOOR = 0.5;

/** Move every visible ghost to sit just outside the LIT subgraph, beside the node it belongs to. */
export function repositionLitGhosts(nodes: Node[], edges: Edge[]): Node[] {
  const ghosts = nodes.filter((node) => node.type === "ghost");
  if (ghosts.length === 0) {
    return nodes;
  }
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const ghostIds = new Set(ghosts.map((ghost) => ghost.id));
  // A lit node's footprint is its OUTERMOST container's full rect, not its own card: a selection
  // inside an expanded frame must band its ghosts outside the whole FRAME (with the routing gutter
  // between them), never on top of the frame's other members.
  const litRects = nodes.filter((node) => node.type !== "ghost" && isLit(node)).map((node) => absoluteRectOf(topAncestor(node, byId), byId));
  if (litRects.length === 0) {
    return nodes; // nothing lit (e.g. no selection) — ghosts are hidden anyway, leave them.
  }
  const box = boundingBoxOf(litRects);
  const anchorOf = anchorByGhost(edges, ghostIds, byId);
  const hierarchy = resolveHierarchyLinks(hierarchyLinks(edges, byId), anchorOf);
  const hierarchyMemberIds = new Set(hierarchy.map((link) => link.memberId));
  const bandedGhosts = ghosts.filter((ghost) => !hierarchyMemberIds.has(ghost.id));
  const items: GhostItem[] = [];
  for (const ghost of bandedGhosts) {
    const info = anchorOf.get(ghost.id);
    const anchor = info ? byId.get(info.anchorId) : undefined;
    if (!info || !anchor) {
      continue; // no lit drawn anchor — leave the ghost where layout put it.
    }
    const rect = absoluteRectOf(anchor, byId);
    const size = sizeOf(ghost);
    items.push({
      id: ghost.id,
      side: info.side,
      anchorCx: rect.x + rect.width / 2,
      anchorCy: rect.y + rect.height / 2,
      ...size,
      ...(isExpandableGhostParent(ghost) ? { outerColumn: true } : {}),
    });
  }
  const positions = bandGhostsOutside(box, items);
  nudgeClearOfEdges(items, positions, coreSegments(edges, ghostIds, byId));
  const occupied = [...litRects, ...bandedGhosts.map((ghost) => positionedRect(ghost, positions, byId))];
  const hierarchyPositions = placeGhostHierarchy(hierarchyGroups(hierarchy, positions, byId), occupied);
  for (const [id, position] of hierarchyPositions) {
    positions.set(id, position);
  }
  return nodes.map((node) => {
    const pos = positions.get(node.id);
    return pos ? { ...node, position: pos, parentId: undefined } : node;
  });
}

interface GhostHierarchyLink {
  parentId: string;
  memberId: string;
  side: Side;
  preferredSide?: Side;
}

/** Read the small paint-only hierarchy contract emitted for an expanded parent group. The canonical
 * marker is `edgeRole: "ghost-hierarchy"`; the boolean alias keeps the helper compatible with the
 * initial contract draft. Ordinary ghost↔ghost dependency edges retain their normal semantics. */
function hierarchyLinks(edges: readonly Edge[], byId: ReadonlyMap<string, Node>): GhostHierarchyLink[] {
  const links: GhostHierarchyLink[] = [];
  for (const edge of edges) {
    const data = (edge.data ?? {}) as { edgeRole?: unknown; ghostHierarchy?: unknown; ghostDirection?: unknown };
    if (data.edgeRole !== "ghost-hierarchy" && data.ghostHierarchy !== true) continue;
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    if (!source || !target || source.type !== "ghost" || target.type !== "ghost") continue;
    const sourceGroup = isGhostGroup(source);
    const targetGroup = isGhostGroup(target);
    if (sourceGroup === targetGroup) continue;
    const parent = sourceGroup ? source : target;
    const member = sourceGroup ? target : source;
    const declared = data.ghostDirection === "incoming" || data.ghostDirection === "outgoing"
      ? data.ghostDirection
      : sourceGroup ? "outgoing" : "incoming";
    const memberDirection = (member.data as { ghostDirection?: unknown }).ghostDirection;
    const preferredSide = memberDirection === "incoming" || memberDirection === "outgoing"
      ? (memberDirection === "outgoing" ? "right" : "left")
      : undefined;
    links.push({
      parentId: parent.id,
      memberId: member.id,
      side: declared === "outgoing" ? "right" : "left",
      ...(preferredSide === undefined ? {} : { preferredSide }),
    });
  }
  return links.sort(
    (a, b) => a.memberId.localeCompare(b.memberId) || a.parentId.localeCompare(b.parentId) || a.side.localeCompare(b.side),
  );
}

/** A bidirectional exact member can have two presentation edges but only one React Flow card. Its
 * declared primary direction wins, then its parent's band side, then stable order. */
function resolveHierarchyLinks(
  links: readonly GhostHierarchyLink[],
  anchorOf: ReadonlyMap<string, { anchorId: string; side: Side }>,
): GhostHierarchyLink[] {
  const byMember = new Map<string, GhostHierarchyLink[]>();
  for (const link of links) {
    if (!anchorOf.has(link.parentId)) continue; // no normal-band parent anchor, so keep the child ordinary.
    const candidates = byMember.get(link.memberId) ?? [];
    candidates.push(link);
    byMember.set(link.memberId, candidates);
  }
  return [...byMember.values()].map((candidates) => {
    const preferred = candidates.find((candidate) => candidate.preferredSide === candidate.side);
    if (preferred) return preferred;
    const matchingParentSide = candidates.find((candidate) => anchorOf.get(candidate.parentId)?.side === candidate.side);
    return matchingParentSide ?? candidates[0];
  });
}

function hierarchyGroups(
  links: readonly GhostHierarchyLink[],
  positions: ReadonlyMap<string, { x: number; y: number }>,
  byId: ReadonlyMap<string, Node>,
): GhostHierarchyGroup[] {
  const groups = new Map<string, GhostHierarchyGroup>();
  for (const link of links) {
    const parent = byId.get(link.parentId);
    const member = byId.get(link.memberId);
    const parentPosition = positions.get(link.parentId);
    if (!parent || !member || !parentPosition) continue;
    const parentSize = sizeOf(parent);
    const key = `${link.side}\u0000${link.parentId}`;
    const group = groups.get(key) ?? {
      parentId: link.parentId,
      side: link.side,
      parent: { ...parentPosition, ...parentSize },
      members: [],
    };
    group.members.push({ id: member.id, ...sizeOf(member) });
    groups.set(key, group);
  }
  return [...groups.values()];
}

function isGhostGroup(node: Node): boolean {
  return typeof (node.data as { ghostGroupId?: unknown }).ghostGroupId === "string";
}

function isExpandableGhostParent(node: Node): boolean {
  const data = node.data as { ghostRole?: unknown; groupedGhostCount?: unknown };
  return data.ghostRole === "parent-anchor"
    && typeof data.groupedGhostCount === "number"
    && data.groupedGhostCount > 0;
}

function positionedRect(
  node: Node,
  positions: ReadonlyMap<string, { x: number; y: number }>,
  byId: ReadonlyMap<string, Node>,
): Rect {
  const position = positions.get(node.id);
  return position ? { ...position, ...sizeOf(node) } : absoluteRectOf(node, byId);
}

// Best-effort: slide each side's column FURTHER out (in whole steps) until no ghost in it crosses a
// wire between two drawn nodes — the whole column moves together so it stays a tidy stack. Bounded, so a
// column boxed in by wires stops after a few steps rather than flying away.
const SHIFT_STEP = 150;
const MAX_SHIFTS = 10;

function nudgeClearOfEdges(items: GhostItem[], positions: Map<string, { x: number; y: number }>, segments: Segment[]): void {
  if (segments.length === 0) {
    return;
  }
  for (const side of ["left", "right"] as const) {
    const sideItems = items.filter((item) => item.side === side);
    const dir = side === "right" ? 1 : -1;
    let shift = 0;
    for (let step = 0; step <= MAX_SHIFTS; step += 1) {
      shift = step * SHIFT_STEP * dir;
      const clear = sideItems.every((item) => {
        const pos = positions.get(item.id);
        return !pos || !segments.some((seg) => segmentHitsRect(seg, { x: pos.x + shift, y: pos.y, width: item.width, height: item.height }));
      });
      if (clear) {
        break;
      }
    }
    if (shift !== 0) {
      for (const item of sideItems) {
        const pos = positions.get(item.id);
        if (pos) {
          positions.set(item.id, { x: pos.x + shift, y: pos.y });
        }
      }
    }
  }
}

type Segment = [{ x: number; y: number }, { x: number; y: number }];

/** Segments for every LIT wire between two DRAWN nodes (a ghost's own wire is skipped — it may cross). */
function coreSegments(edges: Edge[], ghostIds: ReadonlySet<string>, byId: ReadonlyMap<string, Node>): Segment[] {
  const segments: Segment[] = [];
  for (const edge of edges) {
    if (ghostIds.has(edge.source) || ghostIds.has(edge.target)) {
      continue;
    }
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    if (source && target) {
      segments.push([centerOf(source, byId), centerOf(target, byId)]);
    }
  }
  return segments;
}

function centerOf(node: Node, byId: ReadonlyMap<string, Node>): { x: number; y: number } {
  const rect = absoluteRectOf(node, byId);
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

/** Does a segment touch a rect? True if an endpoint is inside, or the segment crosses any rect edge. */
function segmentHitsRect(seg: Segment, rect: { x: number; y: number; width: number; height: number }): boolean {
  const [a, b] = seg;
  if (pointInRect(a, rect) || pointInRect(b, rect)) {
    return true;
  }
  const tl = { x: rect.x, y: rect.y };
  const tr = { x: rect.x + rect.width, y: rect.y };
  const bl = { x: rect.x, y: rect.y + rect.height };
  const br = { x: rect.x + rect.width, y: rect.y + rect.height };
  return segmentsCross(a, b, tl, tr) || segmentsCross(a, b, tr, br) || segmentsCross(a, b, br, bl) || segmentsCross(a, b, bl, tl);
}

const pointInRect = (p: { x: number; y: number }, r: { x: number; y: number; width: number; height: number }): boolean =>
  p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height;

type P = { x: number; y: number };
const cross = (o: P, a: P, b: P): number => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

/** Standard segment-segment intersection via orientation signs. */
function segmentsCross(a: P, b: P, c: P, d: P): boolean {
  const d1 = cross(c, d, a);
  const d2 = cross(c, d, b);
  const d3 = cross(a, b, c);
  const d4 = cross(a, b, d);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/**
 * Per ghost, its drawn anchor and its SIDE by import direction: a wire drawn→ghost means the selection
 * imports the ghost (a DEPENDENCY → right); ghost→drawn means the ghost imports the selection (a CALLER
 * → left). A ghost seen both ways takes the majority (tie → right). Anchor = smallest drawn id on the side.
 */
function anchorByGhost(edges: Edge[], ghostIds: ReadonlySet<string>, byId: ReadonlyMap<string, Node>): Map<string, { anchorId: string; side: Side }> {
  const dependencyOf = new Map<string, string[]>(); // drawn→ghost (RIGHT)
  const callerOf = new Map<string, string[]>(); //     ghost→drawn (LEFT)
  for (const edge of edges) {
    if (ghostIds.has(edge.target) && byId.has(edge.source) && !ghostIds.has(edge.source)) {
      add(dependencyOf, edge.target, edge.source);
    } else if (ghostIds.has(edge.source) && byId.has(edge.target) && !ghostIds.has(edge.target)) {
      add(callerOf, edge.source, edge.target);
    }
  }
  const anchor = new Map<string, { anchorId: string; side: Side }>();
  for (const ghostId of ghostIds) {
    const dep = dependencyOf.get(ghostId) ?? [];
    const call = callerOf.get(ghostId) ?? [];
    if (dep.length === 0 && call.length === 0) {
      continue;
    }
    const side: Side = dep.length >= call.length ? "right" : "left";
    const anchors = side === "right" ? dep : call;
    anchor.set(ghostId, { anchorId: [...anchors].sort()[0], side });
  }
  return anchor;
}

function add(map: Map<string, string[]>, key: string, value: string): void {
  const list = map.get(key) ?? [];
  list.push(value);
  map.set(key, list);
}

const isLit = (node: Node): boolean => ((node.style?.opacity as number | undefined) ?? 1) > LIT_OPACITY_FLOOR;

/** The topmost drawn ancestor (the root frame holding this node), or the node itself at root. */
function topAncestor(node: Node, byId: ReadonlyMap<string, Node>): Node {
  let current = node;
  const seen = new Set<string>([node.id]);
  while (current.parentId && !seen.has(current.parentId)) {
    const parent = byId.get(current.parentId);
    if (!parent) {
      break;
    }
    seen.add(parent.id);
    current = parent;
  }
  return current;
}

function sizeOf(node: Node): { width: number; height: number } {
  const style = (node.style ?? {}) as { width?: number; height?: number };
  return { width: style.width ?? 0, height: style.height ?? 0 };
}
