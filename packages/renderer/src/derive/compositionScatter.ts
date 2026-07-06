/**
 * Map composition units to plot coordinates for the A/I main-sequence scatter — the pure geometry
 * behind `MainSequenceScatter`, testable without React. Instability (I) runs left→right; Abstractness
 * (A) runs bottom→top (SVG y is inverted so A=1 sits at the top). Points at the same (I,A) are common
 * (most TypeScript units land on A=0), so a tiny deterministic jitter fans overlapping dots apart.
 */

import type { UnitMetrics } from "@meridian/design-metrics";

export interface ScatterPoint {
  id: string;
  x: number;
  y: number;
  distance: number;
  label: string;
}

// A small deterministic offset pattern (px), applied by point INDEX — never Math.random / Date.now,
// so the chart is byte-stable across re-renders. Index 0 maps to (0,0) so a lone/first point lands
// exactly on its (I,A), which the tests pin. The dy phase (i*2) also yields 0 at index 0.
const JITTER = [0, 2, -2, 3, -3, 1, -1];

function jitterFor(index: number): { dx: number; dy: number } {
  return { dx: JITTER[index % JITTER.length], dy: JITTER[(index * 2) % JITTER.length] };
}

/**
 * Place each unit inside a [0..w] × [0..h] box, inset by `pad`: I=0 → x=pad, I=1 → x=w-pad; A=1 →
 * y=pad (top), A=0 → y=h-pad (bottom). A tiny index-jitter separates co-located dots; the result is
 * clamped back into the box so a jittered edge point never spills out.
 */
export function scatterPoints(metrics: UnitMetrics[], w: number, h: number, pad: number): ScatterPoint[] {
  const innerW = w - 2 * pad;
  const innerH = h - 2 * pad;
  return metrics.map((unit, index) => {
    const { dx, dy } = jitterFor(index);
    const x = clamp(pad + unit.instability * innerW + dx, 0, w);
    const y = clamp(h - pad - unit.abstractness * innerH + dy, 0, h);
    return { id: unit.id, x, y, distance: unit.distance, label: unit.displayName };
  });
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
