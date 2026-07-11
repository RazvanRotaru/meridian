/**
 * The WEIGHT FLOOR (wire-legibility plan, W4): the relationship pills filter by KIND; this fades
 * by STRENGTH. On a dense level, weight-1 strands (a single call site, a lone import) are mostly
 * texture — when the level draws more than the threshold, they fade further toward the canvas so
 * the heavy structural couplings pop first. A pure paint pass over styled edges: it only lowers
 * the DIM opacity of unlit, weight-1 wires — lit wires, hidden commons strands (opacity 0), and
 * flow/IPC wires (already deliberate signals) are untouched. Sparse levels change nothing: with
 * few wires, every strand earns its ink.
 */

import type { Edge } from "@xyflow/react";

/** Fade kicks in only when a level draws MORE wires than this — sparse levels keep every strand. */
const FADE_MIN_WIRES = 32;
/** Where weight-1 strands settle on a dense level (rest dim is 0.4 — still present, clearly minor). */
const FAINT_OPACITY = 0.16;

export function fadeFaintWires(edges: Edge[]): Edge[] {
  if (edges.length <= FADE_MIN_WIRES) {
    return edges;
  }
  return edges.map((edge) => {
    const data = edge.data as { weight?: number; category?: string } | undefined;
    const opacity = (edge.style as { opacity?: number } | undefined)?.opacity;
    const faintable =
      (data?.weight ?? 1) <= 1 &&
      (data?.category === "dep" || data?.category === "import") &&
      typeof opacity === "number" &&
      opacity > FAINT_OPACITY &&
      opacity < 1;
    return faintable ? { ...edge, style: { ...edge.style, opacity: FAINT_OPACITY } } : edge;
  });
}
