/**
 * WireEdge — the Map's default curve, plus DIRECTION for lit strands: two small dots drift along
 * the path from source to target (SMIL animateMotion over the exact drawn geometry). Motion is the
 * one direction encoding that survives density — arrowheads vanish under overlap, and animating
 * dashes would corrupt the dash vocabulary (dash = crosses a package boundary). Dots require BOTH
 * a lit wire (opacity 1 — a selection's strands) AND the surface's `data.pulse` opt-in (the Map
 * sets it; the minimal overlay — where most wires are lit at rest by construction — does not), so
 * the canvas stays calm and the frame budget only ever pays for a deliberate selection.
 */

import { BaseEdge, getBezierPath, type EdgeProps } from "@xyflow/react";

export const WIRE_EDGE_TYPE = "wire";

export function WireEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, style, markerEnd, data, interactionWidth }: EdgeProps) {
  // Same-pair strands ride parallel LANES (assignPairLanes) instead of overlapping into one line —
  // a vertical shift at both ends keeps the strands parallel along the whole curve.
  const lane = pairLaneOf(data);
  const [path] = getBezierPath({ sourceX, sourceY: sourceY + lane, targetX, targetY: targetY + lane, sourcePosition, targetPosition });
  return (
    <>
      <BaseEdge id={id} path={path} style={style} markerEnd={markerEnd} interactionWidth={interactionWidth} />
      <WirePulse path={path} style={style} data={data} />
    </>
  );
}

/** The strand's lane offset within its same-pair cable (0 = alone or centered). */
export function pairLaneOf(data: EdgeProps["data"]): number {
  return (data as { pairLane?: number } | undefined)?.pairLane ?? 0;
}

/** One pulse cycle's duration; two dots half a cycle apart keep a long path readable end to end. */
const PULSE_SECONDS = 1.6;
const PULSE_RADIUS = 2.4;

interface PulseProps {
  path: string;
  style: EdgeProps["style"];
  data: EdgeProps["data"];
}

/** The drifting direction dots, rendered by every Map edge component when its wire is lit. */
export function WirePulse({ path, style, data }: PulseProps) {
  if (!path || style?.opacity !== 1 || (data as { pulse?: boolean } | undefined)?.pulse !== true) {
    return null;
  }
  const fill = typeof style.stroke === "string" ? style.stroke : "#E6EDF3";
  return (
    <>
      <PulseDot path={path} fill={fill} beginSeconds={0} />
      <PulseDot path={path} fill={fill} beginSeconds={-PULSE_SECONDS / 2} />
    </>
  );
}

function PulseDot({ path, fill, beginSeconds }: { path: string; fill: string; beginSeconds: number }) {
  return (
    <circle r={PULSE_RADIUS} fill={fill} opacity={0.9} pointerEvents="none">
      <animateMotion dur={`${PULSE_SECONDS}s`} begin={`${beginSeconds}s`} repeatCount="indefinite" path={path} />
    </circle>
  );
}
