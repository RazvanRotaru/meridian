/** WireEdge — the Map's default curve with its static label and interaction chrome. */

import { BaseEdge, getBezierPath, type EdgeProps } from "@xyflow/react";
import { WireLabel, wireLabelText } from "./WireLabel";

export const WIRE_EDGE_TYPE = "wire";

export function WireEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, style, markerEnd, data, interactionWidth }: EdgeProps) {
  if (isHiddenWire(data)) {
    return null;
  }
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });
  return (
    <>
      <BaseEdge id={id} path={path} style={style} markerEnd={markerEnd} interactionWidth={interactionWidth} />
      <WireLabel x={labelX} y={labelY} text={wireLabelText(data)} style={style} data={data} />
    </>
  );
}

/** A wire the surface declared HIDDEN (an unlit commons strand) renders nothing at all — an
 * opacity-0 SVG path still hit-tests its stroke, so it must not exist rather than be transparent. */
export function isHiddenWire(data: EdgeProps["data"]): boolean {
  return (data as { hidden?: boolean } | undefined)?.hidden === true;
}
