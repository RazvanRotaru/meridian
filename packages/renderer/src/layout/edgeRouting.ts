/**
 * Gutter-bus routing — HOW a frame-crossing wire travels, not just where it ends. A wire whose
 * target sits INSIDE an expanded frame used to sweep across the frame interior (and with spooling,
 * a whole fan swept from one gather knot), passing BEHIND the member cards. Instead: the wire now
 * enters through a GATE on the frame's boundary edge, rides a vertical RAIL inside the frame's
 * padding gutter — a column no card ever occupies — and peels off horizontally into its target at
 * the target's own height. Wires sharing the rail overlap into a visible bus bar along the frame
 * edge: the highway made literal, with every strand still individually hover/emphasis-addressable.
 *
 * A pure paint pass over styled edges: it computes an SVG path per routed edge (geometry from the
 * placed nodes) and retypes it; styles, ids, and interactivity are untouched. Only edges whose
 * target lies inside an expanded frame that does NOT also contain the source are routed — everything
 * else (open-canvas wires, frame-to-frame trunks, intra-frame wires) keeps its normal curve.
 */

import type { Edge, Node } from "@xyflow/react";

export const ROUTED_EDGE_TYPE = "routed";

export interface RoutedEdgeData extends Record<string, unknown> {
  /** The full SVG path the RoutedEdge component draws verbatim. */
  routedPath: string;
}

/** The rail's x-inset from the frame's left border — inside the padding gutter, clear of cards. */
const RAIL_INSET = 12;
/** Corner radius where the wire turns onto / off the rail. */
const CORNER = 8;
/** Horizontal control pull for the free curve outside the frame. */
const PULL = 90;

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function routeFrameEdges(edges: Edge[], nodes: Node[]): Edge[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const rects = new Map<string, Rect>();
  const frameIds = new Set<string>();
  for (const node of nodes) {
    rects.set(node.id, absoluteRect(node, byId));
    if (node.parentId) {
      frameIds.add(node.parentId);
    }
  }
  return edges.map((edge) => {
    if (edge.type !== undefined) {
      return edge; // container highways (bundle) and anything already custom keep their renderer
    }
    const path = routedPath(edge, byId, rects, frameIds);
    return path === null ? edge : { ...edge, type: ROUTED_EDGE_TYPE, data: { ...edge.data, routedPath: path } };
  });
}

/** The bus path for a frame-crossing edge, or null when this edge has nothing to route around. */
function routedPath(edge: Edge, byId: Map<string, Node>, rects: Map<string, Rect>, frameIds: Set<string>): string | null {
  const source = rects.get(edge.source);
  const target = rects.get(edge.target);
  if (!source || !target) {
    return null;
  }
  // The OUTERMOST expanded frame around the target that does not also contain the source: the
  // boundary the wire must cross. None → open canvas or intra-frame; not ours to route.
  const frame = entryFrame(edge.source, edge.target, byId, rects, frameIds);
  if (!frame) {
    return null;
  }
  const sy = source.y + source.h / 2;
  const ty = target.y + target.h / 2;
  // Enter from whichever side of the frame the source sits on; the rail runs in that side's gutter.
  const fromLeft = source.x + source.w / 2 <= frame.x + frame.w / 2;
  const sx = fromLeft ? source.x + source.w : source.x;
  const gateX = fromLeft ? frame.x : frame.x + frame.w;
  const railX = fromLeft ? frame.x + RAIL_INSET : frame.x + frame.w - RAIL_INSET;
  const tx = fromLeft ? target.x : target.x + target.w;
  // The gate sits at the source's height, clamped into the frame's edge span, so the outside leg
  // stays flat and gates from different sources spread along the boundary instead of knotting.
  const gateY = clamp(sy, frame.y + CORNER * 2, frame.y + frame.h - CORNER * 2);
  const dir = ty >= gateY ? 1 : -1;
  const inward = fromLeft ? 1 : -1;
  // Degenerate rail (target right at gate height): a plain flat entry needs no bus.
  if (Math.abs(ty - gateY) < CORNER * 2) {
    return [
      `M ${sx} ${sy}`,
      `C ${sx + inward * PULL} ${sy} ${gateX - inward * PULL} ${ty} ${gateX} ${ty}`,
      `L ${tx} ${ty}`,
    ].join(" ");
  }
  return [
    // Free curve outside the frame, arriving flat at the gate.
    `M ${sx} ${sy}`,
    `C ${sx + inward * PULL} ${sy} ${gateX - inward * PULL} ${gateY} ${gateX} ${gateY}`,
    // Through the gate, corner onto the rail.
    `L ${railX - inward * CORNER} ${gateY}`,
    `Q ${railX} ${gateY} ${railX} ${gateY + dir * CORNER}`,
    // Ride the rail — the shared bus segment — to the target's height.
    `L ${railX} ${ty - dir * CORNER}`,
    // Corner off the rail, straight into the target's handle.
    `Q ${railX} ${ty} ${railX + inward * CORNER} ${ty}`,
    `L ${tx} ${ty}`,
  ].join(" ");
}

/** The outermost EXPANDED-frame ancestor of `targetId` that is not also an ancestor of `sourceId`. */
function entryFrame(
  sourceId: string,
  targetId: string,
  byId: Map<string, Node>,
  rects: Map<string, Rect>,
  frameIds: Set<string>,
): Rect | null {
  const sourceAncestors = ancestorsOf(sourceId, byId);
  let outermost: Rect | null = null;
  let current = byId.get(targetId)?.parentId;
  const seen = new Set<string>();
  while (current && !seen.has(current)) {
    if (sourceAncestors.has(current)) {
      break; // shared container — from here up the frame holds BOTH ends
    }
    if (frameIds.has(current)) {
      outermost = rects.get(current) ?? outermost;
    }
    seen.add(current);
    current = byId.get(current)?.parentId;
  }
  return outermost;
}

function ancestorsOf(id: string, byId: Map<string, Node>): Set<string> {
  const ancestors = new Set<string>();
  let current = byId.get(id)?.parentId;
  while (current && !ancestors.has(current)) {
    ancestors.add(current);
    current = byId.get(current)?.parentId;
  }
  return ancestors;
}

/** Absolute canvas-space rect: `position` summed up the parentId chain, size from the ELK style. */
function absoluteRect(node: Node, byId: Map<string, Node>): Rect {
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
  return { x, y, w: style.width ?? 0, h: style.height ?? 0 };
}

const clamp = (value: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, value));
