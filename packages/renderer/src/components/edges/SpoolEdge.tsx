/**
 * SpoolEdge — the fan-hub router for Visual Highways (see layout/edgeSpooling.ts). Every edge stays
 * its own element (hover, click, emphasis all still work per-wire); only the PATH changes: the hub
 * end runs straight through a GATHER point computed purely from the hub's handle position, so all of
 * a hub's wires overlap into one visible trunk for the final stretch and fan out only in open canvas.
 */

import { BaseEdge, getBezierPath, Position, type EdgeProps } from "@xyflow/react";
import type { SpoolEdgeData } from "../../layout/edgeSpooling";

/** Length of the straight shared-trunk segment at a hub's handle. Fixed and hub-derived on purpose:
 * every wire of the hub must share the gather point EXACTLY, so the trunk can't scale per-wire. */
const TRUNK = 90;
/** Bezier control pull at a RAW handle (the non-hub end): modest, a normal departure curve. */
const PULL = 80;
/** Control pull at a GATHER end scales with the wire's span (clamped): the control point rides the
 * trunk AXIS, so a long wire flattens onto that shared line early and the trunk reads at overview
 * zoom — the fixed 90px segment alone vanished on large canvases. Sharing survives because every
 * wire's control sits on the SAME axis; only its distance along it differs. */
const APPROACH_MIN = 80;
const APPROACH_MAX = 480;
const APPROACH_FRACTION = 0.35;
/** GEOMETRY VETO: a trunk only makes sense when the far end has this much forward room to approach
 * the gather point. A source sitting closer than this (a ghost card hugging its hub) would force
 * the wire to curve BACKWARD into the gather — the S-loop artifact — so it draws plain instead. */
const MIN_FREE_SPAN = 40;

interface Point {
  x: number;
  y: number;
}

export function SpoolEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style,
  markerEnd,
  data,
}: EdgeProps) {
  const spoolEnd = (data as SpoolEdgeData).spoolEnd;
  const source: Point = { x: sourceX, y: sourceY };
  const target: Point = { x: targetX, y: targetY };
  // A gather point derives ONLY from its hub's handle, so every wire of that hub shares it exactly.
  // The geometry veto drops a gather whose approach would fold backward (see MIN_FREE_SPAN).
  let sourceGather = spoolEnd !== "target" ? outward(source, sourcePosition, TRUNK) : null;
  let targetGather = spoolEnd !== "source" ? outward(target, targetPosition, TRUNK) : null;
  if (targetGather && !hasApproachRoom(sourceGather ?? source, targetGather, targetPosition)) {
    targetGather = null;
  }
  if (sourceGather && !hasApproachRoom(targetGather ?? target, sourceGather, sourcePosition)) {
    sourceGather = null;
  }
  // Neither end can gather sanely → this wire is a plain curve, exactly as if it were never spooled.
  if (!sourceGather && !targetGather) {
    const [plain] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });
    return <BaseEdge id={id} path={plain} style={style} markerEnd={markerEnd} />;
  }
  const from = sourceGather ?? source;
  const to = targetGather ?? target;
  // Control points extend along each end's outward axis, so the curve joins the straight trunk
  // segments tangentially (no kink where the fan meets the trunk). A gather end gets the adaptive
  // span-scaled pull (long wires ride the trunk axis early); a raw end keeps the modest departure.
  const span = Math.hypot(to.x - from.x, to.y - from.y);
  const approach = Math.min(APPROACH_MAX, Math.max(APPROACH_MIN, span * APPROACH_FRACTION));
  const c1 = outward(from, sourcePosition, sourceGather ? approach : PULL);
  const c2 = outward(to, targetPosition, targetGather ? approach : PULL);
  const path = [
    `M ${source.x} ${source.y}`,
    sourceGather ? `L ${sourceGather.x} ${sourceGather.y}` : "",
    `C ${c1.x} ${c1.y} ${c2.x} ${c2.y} ${to.x} ${to.y}`,
    targetGather ? `L ${target.x} ${target.y}` : "",
  ].join(" ");
  return <BaseEdge id={id} path={path} style={style} markerEnd={markerEnd} />;
}

/** True when `free` sits far enough on the APPROACH side of `gather` (the side the hub handle
 * faces) that the curve arrives forward instead of folding back on itself. */
function hasApproachRoom(free: Point, gather: Point, hubPosition: Position): boolean {
  switch (hubPosition) {
    case Position.Left:
      return free.x <= gather.x - MIN_FREE_SPAN;
    case Position.Right:
      return free.x >= gather.x + MIN_FREE_SPAN;
    case Position.Top:
      return free.y <= gather.y - MIN_FREE_SPAN;
    default:
      return free.y >= gather.y + MIN_FREE_SPAN;
  }
}

/** `distance` px outward from a handle, along the side the handle faces. */
function outward(point: Point, position: Position, distance: number): Point {
  switch (position) {
    case Position.Left:
      return { x: point.x - distance, y: point.y };
    case Position.Right:
      return { x: point.x + distance, y: point.y };
    case Position.Top:
      return { x: point.x, y: point.y - distance };
    default:
      return { x: point.x, y: point.y + distance };
  }
}
