/**
 * The mutable canvas the Metro walk draws onto — the one place that holds the growing line/station/
 * label arrays, the left→right cursor, and the running extents. Kept apart from the walk so the
 * algorithm (metroLayout.ts) reads as control-flow intent, not array bookkeeping. Pure, no React.
 */

import { FLOW_COLORS } from "./flowViewModel";
import type { MetroKind, MetroLabel, MetroLine, MetroSpec, MetroStation } from "./metroSpec";
import { BASE_Y, DETACH_Y, ENTRY_X, LANE_GAP, MARGIN_X, MIN_HEIGHT, TOP_MARGIN, departTo } from "./metroSpec";

export interface MetroCanvas {
  /** The shared left→right time cursor; every handler reads and advances it. */
  cursor: number;
  line(d: string, color: string, o?: Partial<MetroLine>): void;
  label(x: number, y: number, text: string, color: string): void;
  mark(s: MetroStation): void;
  terminus(x: number, y: number, color: string, name: string): void;
  junction(x: number, y: number): void;
  /** Register a fire-and-forget station; its dashed lane to the right edge is emitted at finish. */
  detach(x: number, y: number): void;
  /** Clamp a lane y into the canvas and record it as the new lower bound. */
  clampY(y: number): number;
  finish(): MetroSpec;
}

export function createCanvas(): MetroCanvas {
  const lines: MetroLine[] = [];
  const stations: MetroStation[] = [];
  const labels: MetroLabel[] = [];
  const detached: Array<{ x: number; y: number }> = [];
  let maxX = ENTRY_X;
  let maxY = BASE_Y;

  const seen = (x: number, y: number): void => {
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  };

  const canvas: MetroCanvas = {
    cursor: ENTRY_X,
    line(d, color, o = {}) {
      lines.push({ d, color, width: 5, ...o });
    },
    label(x, y, text, color) {
      labels.push({ x, y, text, color });
      seen(x, y);
    },
    mark(s) {
      stations.push(s);
      seen(s.x, s.y);
    },
    terminus(x, y, color, name) {
      canvas.mark({ x, y, kind: "terminus" as MetroKind, color, name, labelSide: -1, target: null });
    },
    junction(x, y) {
      canvas.mark({ x, y, kind: "junction" as MetroKind, color: FLOW_COLORS.branch, labelSide: 1, target: null });
    },
    detach(x, y) {
      detached.push({ x, y });
    },
    clampY(y) {
      const v = Math.max(TOP_MARGIN, y);
      maxY = Math.max(maxY, v);
      return v;
    },
    finish() {
      const rightEdge = maxX + MARGIN_X;
      detached.forEach(({ x, y }, i) => {
        const laneY = DETACH_Y + i * LANE_GAP;
        canvas.line(departTo(x, y, laneY, rightEdge), FLOW_COLORS.detached, { dash: true, width: 4, arrow: true });
        canvas.label(rightEdge - 150, laneY - 15, "still running →", FLOW_COLORS.detached);
        maxY = Math.max(maxY, laneY);
      });
      return { width: rightEdge + 40, height: Math.max(MIN_HEIGHT, maxY + 60), lines, stations, labels };
    },
  };
  return canvas;
}
