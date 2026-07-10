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
  const [path] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });
  return (
    <>
      <BaseEdge id={id} path={path} style={style} markerEnd={markerEnd} interactionWidth={interactionWidth} />
      <WirePulse path={path} style={style} data={data} />
    </>
  );
}

/** One pulse cycle's duration; two dots half a cycle apart keep a long path readable end to end. */
const PULSE_SECONDS = 1.6;
const PULSE_RADIUS = 2.6;
/** A canvas-dark outline ring: the dot must stay visible RIDING ON a lit stripe band (a bare ink
 * dot on a bright solid cable has no edge to read motion against — it only flashed in dash gaps). */
const PULSE_RING = "#0E1116";

interface PulseProps {
  path: string;
  style: EdgeProps["style"];
  data: EdgeProps["data"];
}

/** The dots' one meaning is DIRECTION, so they wear the app's neutral ink — never a kind colour,
 * which would read as data ("a reference traveling") the renderer can't honestly claim. */
const PULSE_INK = "#E6EDF3";

/** The drifting direction dots, rendered by every Map edge component when its wire is lit. */
export function WirePulse({ path, style, data }: PulseProps) {
  if (!path || style?.opacity !== 1 || (data as { pulse?: boolean } | undefined)?.pulse !== true) {
    return null;
  }
  return (
    <>
      <PulseDot path={path} fill={PULSE_INK} beginSeconds={0} />
      <PulseDot path={path} fill={PULSE_INK} beginSeconds={-PULSE_SECONDS / 2} />
    </>
  );
}

function PulseDot({ path, fill, beginSeconds }: { path: string; fill: string; beginSeconds: number }) {
  return (
    <circle r={PULSE_RADIUS} fill={fill} stroke={PULSE_RING} strokeWidth={1.6} opacity={0.95} pointerEvents="none">
      <animateMotion dur={`${PULSE_SECONDS}s`} begin={`${beginSeconds}s`} repeatCount="indefinite" path={path} />
    </circle>
  );
}
