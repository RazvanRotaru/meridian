/**
 * CycleEdge — one wire for MUTUAL coupling (see layout/cycleFusion.ts): `A⇄B` draws once with an
 * arrowhead at BOTH ends and a soft tension underlay, instead of two curves the reader must match
 * up. The underlay is the smell marker — mutual dependency is a design tension — kept as a wide,
 * low-opacity halo so the wire's own kind colour still tells the relationship. No direction
 * streak (the whole point is that it flows both ways); the lit chip says `⇄ kind ×fwd/×back`.
 */

import { BaseEdge, getBezierPath, type EdgeProps } from "@xyflow/react";
import type { CycleEdgeData } from "../../layout/cycleFusion";
import { isHiddenWire } from "./WireEdge";
import { WireLabel } from "./WireLabel";

/** The tension halo: a desaturated warning red, never used by the kind/status palettes. */
const TENSION = "#B3554E";

export function CycleEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, style, markerEnd, markerStart, data }: EdgeProps) {
  if (isHiddenWire(data)) {
    return null;
  }
  const cycle = data as CycleEdgeData;
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });
  const width = (style?.strokeWidth as number) ?? 1.5;
  const opacity = (style?.opacity as number) ?? 1;
  const dash = style?.strokeDasharray;
  return (
    <>
      {/* Keep the tension halo's gaps phase-aligned with a semantic boundary dash; a solid halo
          underneath a dashed main stroke would visually fill the gaps and make the cycle read solid. */}
      <path d={path} fill="none" stroke={TENSION} strokeWidth={width + 4} strokeOpacity={0.28 * opacity} strokeDasharray={dash} strokeLinecap="round" pointerEvents="none" />
      <BaseEdge id={id} path={path} style={style} markerEnd={markerEnd} markerStart={markerStart} interactionWidth={14} />
      <WireLabel x={labelX} y={labelY} text={cycleLabelText(cycle)} style={style} data={data} color={TENSION} />
    </>
  );
}

function cycleLabelText(cycle: CycleEdgeData): string {
  const kind = cycle.depKind ?? "wire";
  return `⇄ ${kind} ×${cycle.forwardWeight}/×${cycle.backwardWeight}`;
}
