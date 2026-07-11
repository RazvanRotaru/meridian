/**
 * The midpoint CHIP a LIT wire wears at reading zoom (wire-legibility plan, W4): `calls ×7` right
 * on the strand — attribution without even hovering. Only lit wires carry one (the canvas at rest
 * stays clean), only surfaces that opted into wire chrome (`data.pulse`, the Map), and the
 * orientation tier hides them via the existing `lod-hide` rule — at that altitude the wires are
 * shapes, not statements. Rendered as SVG inside the edge, so it inherits the canvas transform.
 */

import type { EdgeProps } from "@xyflow/react";
import { MONO } from "../nodes/modulemap/frameChrome";

const FONT_SIZE = 9;
const PAD_X = 5;
const PAD_Y = 2.5;

interface WireLabelProps {
  x: number;
  y: number;
  text: string;
  style: EdgeProps["style"];
  data: EdgeProps["data"];
  /** Chip accent (defaults to the wire's stroke); the cycle chip passes its tension colour. */
  color?: string;
}

export function WireLabel({ x, y, text, style, data, color }: WireLabelProps) {
  if (style?.opacity !== 1 || (data as { pulse?: boolean } | undefined)?.pulse !== true || !text) {
    return null;
  }
  const ink = color ?? (typeof style.stroke === "string" ? style.stroke : "#9AA4B2");
  const width = text.length * FONT_SIZE * 0.62 + PAD_X * 2;
  const height = FONT_SIZE + PAD_Y * 2;
  return (
    <g className="lod-hide" pointerEvents="none">
      <rect x={x - width / 2} y={y - height / 2} width={width} height={height} rx={4} fill="#161B22" stroke="#30363d" strokeWidth={1} />
      <text x={x} y={y + FONT_SIZE * 0.36} textAnchor="middle" fontFamily={MONO} fontSize={FONT_SIZE} fontWeight={700} fill={ink}>
        {text}
      </text>
    </g>
  );
}

/** The chip text for an ordinary wire: its kind, with ×N only when the aggregate is plural. */
export function wireLabelText(data: EdgeProps["data"]): string {
  const d = data as { depKind?: string; category?: string; weight?: number } | undefined;
  const kind = d?.depKind ?? d?.category ?? "";
  if (!kind || kind === "flow") {
    return "";
  }
  const weight = d?.weight ?? 1;
  return weight > 1 ? `${kind} ×${weight}` : kind;
}
