/**
 * SpoolEdge — the fan-hub router for Visual Highways (see layout/edgeSpooling.ts). Every edge stays
 * its own element (hover, click, emphasis all still work per-wire); only the PATH changes: the hub
 * end runs straight through a GATHER point computed purely from the hub's handle position, so all of
 * a hub's wires overlap into one visible trunk for the final stretch and fan out only in open canvas.
 */

import { BaseEdge, getBezierPath, Position, type EdgeProps } from "@xyflow/react";
import type { SpoolEdgeData } from "../../layout/edgeSpooling";
import { pairLaneOf, WirePulse } from "./WireEdge";

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
/** GEOMETRY VETO + CLAMP: control points must always stay BETWEEN the free end and the gather —
 * a pull longer than the available room folds the curve backward (the S-loop artifact). Every pull
 * is clamped to the free span minus this margin; when even that leaves no room, the gather drops
 * and the wire draws plain. So short spans get gentle direct curves, long hauls keep full trunks,
 * and a fold is impossible at ANY distance by construction. */
const PULL_MARGIN = 24;

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
  interactionWidth,
}: EdgeProps) {
  const spoolEnd = (data as SpoolEdgeData).spoolEnd;
  // Same-pair strands keep their parallel lane through the spool: gathers derive from these
  // endpoints, so the whole trunk-and-fan shifts with the lane and the strands never re-overlap.
  const lane = pairLaneOf(data);
  const source: Point = { x: sourceX, y: sourceY + lane };
  const target: Point = { x: targetX, y: targetY + lane };
  // A gather point derives ONLY from its hub's handle, so every wire of that hub shares it exactly.
  // A gather whose free end has no forward room at all (behind the gather, or within PULL_MARGIN of
  // it) drops — the trunk cannot exist without folding the wire backward.
  let sourceGather = spoolEnd !== "target" ? outward(source, sourcePosition, TRUNK) : null;
  let targetGather = spoolEnd !== "source" ? outward(target, targetPosition, TRUNK) : null;
  if (targetGather && axisRoom(sourceGather ?? source, targetGather, targetPosition) < PULL_MARGIN * 2) {
    targetGather = null;
  }
  if (sourceGather && axisRoom(targetGather ?? target, sourceGather, sourcePosition) < PULL_MARGIN * 2) {
    sourceGather = null;
  }
  // Neither end can gather sanely → this wire is a plain curve, exactly as if it were never spooled.
  if (!sourceGather && !targetGather) {
    const [plain] = getBezierPath({ sourceX, sourceY: source.y, targetX, targetY: target.y, sourcePosition, targetPosition });
    return (
      <>
        <BaseEdge id={id} path={plain} style={style} markerEnd={markerEnd} interactionWidth={interactionWidth} />
        <WirePulse path={plain} style={style} data={data} />
      </>
    );
  }
  const from = sourceGather ?? source;
  const to = targetGather ?? target;
  // Control points extend along each end's outward axis, so the curve joins the straight trunk
  // segments tangentially (no kink where the fan meets the trunk). A gather end wants the adaptive
  // span-scaled pull (long wires ride the trunk axis early); a raw end a modest departure — and
  // EVERY pull is clamped to the free room so a control point can never cross back over the far end.
  const span = Math.hypot(to.x - from.x, to.y - from.y);
  const room = Math.max(axisRoom(from, to, targetGather ? targetPosition : sourcePosition), 0);
  const adaptive = Math.min(APPROACH_MAX, Math.max(APPROACH_MIN, span * APPROACH_FRACTION));
  const c1 = outward(from, sourcePosition, clampPull(sourceGather ? adaptive : PULL, room));
  const c2 = outward(to, targetPosition, clampPull(targetGather ? adaptive : PULL, room));
  const path = [
    `M ${source.x} ${source.y}`,
    sourceGather ? `L ${sourceGather.x} ${sourceGather.y}` : "",
    `C ${c1.x} ${c1.y} ${c2.x} ${c2.y} ${to.x} ${to.y}`,
    targetGather ? `L ${target.x} ${target.y}` : "",
  ].join(" ");
  return (
    <>
      <BaseEdge id={id} path={path} style={style} markerEnd={markerEnd} interactionWidth={interactionWidth} />
      <WirePulse path={path} style={style} data={data} />
    </>
  );
}

/** A pull that always fits: never longer than the free room minus the margin, never negative. */
function clampPull(pull: number, room: number): number {
  return Math.max(Math.min(pull, room - PULL_MARGIN), 0);
}

/** How much forward room `free` has on the APPROACH side of `gather` (the side the hub handle
 * faces): positive = the curve can arrive moving forward; ≤ 0 = it would have to fold back. */
function axisRoom(free: Point, gather: Point, hubPosition: Position): number {
  switch (hubPosition) {
    case Position.Left:
      return gather.x - free.x;
    case Position.Right:
      return free.x - gather.x;
    case Position.Top:
      return gather.y - free.y;
    default:
      return free.y - gather.y;
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
