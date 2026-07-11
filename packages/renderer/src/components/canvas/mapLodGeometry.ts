import type { Node } from "@xyflow/react";
import { absoluteRectOf, boundingBoxOf } from "../../layout/ghostBandPlacement";

export interface GraphRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Screen-space chrome reserved around the structural graph when it becomes one parent node. */
export const PARENT_FRAME_HEADER_PX = 34;
const PARENT_FRAME_SIDE_PX = 18;
const PARENT_FRAME_BODY_TOP_PX = 16;
const PARENT_FRAME_BOTTOM_PX = 18;

/** Bounds of the structural graph in absolute flow coordinates. Nested nodes are parent-relative,
 * so their ancestor positions must be accumulated before taking the bounds. Off-level ghost cards
 * do not move the parent frame; if a surface somehow consists only of ghosts, they are the safe
 * fallback rather than returning no enclosure. */
export function structuralGraphBounds(nodes: readonly Node[]): GraphRect | null {
  const structural = nodes.filter((node) => node.type !== "ghost");
  const candidates = structural.length > 0 ? structural : nodes;
  if (candidates.length === 0) {
    return null;
  }
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const box = boundingBoxOf(candidates.map((node) => absoluteRectOf(node, byId)));
  if (![box.x, box.y, box.width, box.height].every(Number.isFinite)) {
    return null;
  }
  return box;
}

/** A parent-node rect that encloses `bounds` while keeping its header and gutters a stable size on
 * screen. The ViewportPortal applies canvas zoom later, so pixel chrome becomes flow-space distance
 * by dividing through the current zoom. */
export function enclosingParentFrame(bounds: GraphRect, zoom: number): GraphRect {
  const safeZoom = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  const side = PARENT_FRAME_SIDE_PX / safeZoom;
  const top = (PARENT_FRAME_HEADER_PX + PARENT_FRAME_BODY_TOP_PX) / safeZoom;
  const bottom = PARENT_FRAME_BOTTOM_PX / safeZoom;
  return {
    x: bounds.x - side,
    y: bounds.y - top,
    width: bounds.width + side * 2,
    height: bounds.height + top + bottom,
  };
}
