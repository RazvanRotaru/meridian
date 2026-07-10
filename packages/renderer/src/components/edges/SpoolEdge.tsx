/**
 * SpoolEdge — the fan-hub router for Visual Highways (see layout/edgeSpooling.ts). Every edge stays
 * its own element (hover, click, emphasis all still work per-wire); only the PATH changes: the hub
 * end runs straight through a GATHER point computed purely from the hub's handle position, so all of
 * a hub's wires overlap into one visible trunk for the final stretch and fan out only in open canvas.
 */

import { BaseEdge, Position, type EdgeProps } from "@xyflow/react";
import type { SpoolEdgeData } from "../../layout/edgeSpooling";

/** Length of the straight shared-trunk segment at a hub's handle. */
const TRUNK = 90;
/** Bezier control pull for the free span between gather points. */
const PULL = 80;

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
  const sourceGather = spoolEnd !== "target" ? outward(source, sourcePosition, TRUNK) : null;
  const targetGather = spoolEnd !== "source" ? outward(target, targetPosition, TRUNK) : null;
  const from = sourceGather ?? source;
  const to = targetGather ?? target;
  // Control points extend along each end's outward axis, so the curve joins the straight trunk
  // segments tangentially (no kink where the fan meets the trunk).
  const c1 = outward(from, sourcePosition, PULL);
  const c2 = outward(to, targetPosition, PULL);
  const path = [
    `M ${source.x} ${source.y}`,
    sourceGather ? `L ${sourceGather.x} ${sourceGather.y}` : "",
    `C ${c1.x} ${c1.y} ${c2.x} ${c2.y} ${to.x} ${to.y}`,
    targetGather ? `L ${target.x} ${target.y}` : "",
  ].join(" ");
  return <BaseEdge id={id} path={path} style={style} markerEnd={markerEnd} />;
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
