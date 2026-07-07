/**
 * The serializable output of the Metro projection and the geometry primitives that build it — kept
 * apart from the walk (metroLayout.ts) so the algorithm reads as intent, not string arithmetic.
 *
 * A metro spec is a PLAIN object: polylines (SVG path `d`s), station marks, and free captions, all
 * in one coordinate space. The view renders it verbatim; tests assert on it directly. No React.
 */

import type { NodeId } from "@meridian/core";

/** A station mark — the transit-map dots/bars/interchanges. (Loops are enclosures, not marks.) */
export type MetroKind = "station" | "interchange" | "terminus" | "junction";

export interface MetroStation {
  x: number;
  y: number;
  kind: MetroKind;
  color: string;
  name?: string;
  sub?: string;
  /** Which side the HTML label sits on to dodge collisions: -1 above the line, +1 below. */
  labelSide: 1 | -1;
  /** By-target selection key (same contract as the exec graph); null when clicking is a no-op. */
  target?: NodeId | null;
  /** Resolved to a callee that ships its own flow — a double-click drills in. */
  expandable?: boolean;
}

export interface MetroLine {
  d: string;
  color: string;
  dash?: boolean;
  width?: number;
  arrow?: boolean;
  /** Paint AFTER the plain lines — a recolored segment riding on top of the trunk (loop bodies). */
  over?: boolean;
}

export interface MetroLabel {
  x: number;
  y: number;
  text: string;
  color: string;
}

export interface MetroSpec {
  width: number;
  height: number;
  lines: MetroLine[];
  stations: MetroStation[];
  labels: MetroLabel[];
}

// Left→right time axis; lanes are vertical offsets from a base exec thread. Tuned to the POC look.
export const ENTRY_X = 60;
export const BASE_Y = 340;
export const SLOT = 170;
export const INTERCHANGE_PAD = 40;
export const EASE = 60;
export const BRANCH_RISE = 150;
export const NEST_RISE = 110;
/** Beyond this recursion depth branches stop elevating and reuse the parent lane (POC caps at 3). */
export const MAX_ELEV_DEPTH = 3;
export const DETACH_Y = BASE_Y + 105;
export const LANE_GAP = 85;
export const CATCH_RISE = 105;
/** Vertical half-height of the stadium ring enclosing a loop body. */
export const LOOP_RY = 72;
export const MIN_HEIGHT = 620;
export const MARGIN_X = 100;
/** Hard recursion guard — pathological trees never blow the stack or the canvas. */
export const MAX_DEPTH = 16;
export const TOP_MARGIN = 44;

/** A straight horizontal segment on one lane. */
export function hline(x1: number, x2: number, y: number): string {
  return `M ${x1} ${y} H ${x2}`;
}

/** A split: eased cubic leaving `(x,y)` and landing flat at `(tx,ty)` — the POC's bezier at a fork. */
export function splitTo(x: number, y: number, tx: number, ty: number): string {
  return `M ${x} ${y} C ${x + EASE} ${y} ${tx - EASE} ${ty} ${tx} ${ty}`;
}

/** A rejoin is geometrically the same eased cubic — the alias keeps call sites saying what they mean. */
export const rejoinTo = splitTo;

/** The stadium ring that encloses a loop's WHOLE body sequence, threaded by the exec line. */
export function encloseLoop(x0: number, x1: number, y: number, ry: number): string {
  return `M ${x0} ${y - ry} L ${x1} ${y - ry} A ${ry} ${ry} 0 0 1 ${x1} ${y + ry} L ${x0} ${y + ry} A ${ry} ${ry} 0 0 1 ${x0} ${y - ry} Z`;
}

/** A hand-off: curves down to a lower lane then runs flat to the right edge (detached / callback). */
export function departTo(x: number, y: number, ly: number, endX: number): string {
  const flat = x + EASE * 2;
  return `M ${x} ${y} C ${x + EASE} ${y} ${flat - EASE} ${ly} ${flat} ${ly} H ${endX}`;
}
