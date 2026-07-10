/**
 * WireEdge — the Map's default curve, plus DIRECTION for lit strands: a short light STREAK sweeps
 * along the wire from source to target — current running inside the cable, not an object riding on
 * top of it (drifting dots read as foreign beads scattered over the map). The streak is the wire's
 * own path drawn once more in translucent ink with a travelling dash, so it inherits the exact
 * geometry and width; it moves at CONSTANT pixels-per-second (duration derives from the measured
 * path length — a fixed duration made long wires look "faster" for no reason). Motion is the one
 * direction encoding that survives density — arrowheads vanish under overlap, and animating the
 * wire's own dashes would corrupt the dash vocabulary (dash = crosses a package boundary). Streaks
 * require BOTH a lit wire (opacity 1 — a selection's strands) AND the surface's `data.pulse`
 * opt-in (the Map sets it; the minimal overlay — where most wires are lit at rest by construction
 * — does not), so the canvas stays calm and only a deliberate selection pays the frame budget.
 */

import { useEffect, useRef, useState } from "react";
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

/** The streak's one meaning is DIRECTION, so it glints in neutral ink — never a kind colour. */
const STREAK_INK = "#E6EDF3";
const STREAK_OPACITY = 0.5;
/** The glint's length along the wire, and its constant travel speed. */
const STREAK_LENGTH = 26;
const SPEED_PX_PER_SECOND = 150;

interface PulseProps {
  path: string;
  style: EdgeProps["style"];
  data: EdgeProps["data"];
}

/** The travelling light streak, rendered by every Map edge component when its wire is lit. */
export function WirePulse({ path, style, data }: PulseProps) {
  const streakRef = useRef<SVGPathElement | null>(null);
  const [pathLength, setPathLength] = useState(0);
  const active = Boolean(path) && style?.opacity === 1 && (data as { pulse?: boolean } | undefined)?.pulse === true;
  // The streak path measures ITSELF once mounted; until then it renders invisible (opacity 0).
  useEffect(() => {
    if (active) {
      setPathLength(streakRef.current?.getTotalLength() ?? 0);
    }
  }, [path, active]);
  if (!active) {
    return null;
  }
  const period = pathLength + STREAK_LENGTH;
  const width = Math.max((style?.strokeWidth as number) ?? 2, 2);
  return (
    <path
      ref={streakRef}
      d={path}
      fill="none"
      stroke={STREAK_INK}
      strokeOpacity={pathLength > 0 ? STREAK_OPACITY : 0}
      strokeWidth={width}
      strokeLinecap="round"
      strokeDasharray={`${STREAK_LENGTH} ${Math.max(pathLength, 1)}`}
      pointerEvents="none"
    >
      {pathLength > 0 ? (
        <animate attributeName="stroke-dashoffset" from="0" to={`${-period}`} dur={`${period / SPEED_PX_PER_SECOND}s`} repeatCount="indefinite" />
      ) : null}
    </path>
  );
}
