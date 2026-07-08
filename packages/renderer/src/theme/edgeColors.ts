/**
 * Wire colours, in one place so the edge component and the marker built at layout time agree.
 *
 * Behavioural call wires read as neutral steel; React "renders" wires get a distinct cyan
 * accent so UI-composition mode is legible at a glance even when both live on screen.
 */

import { MarkerType } from "@xyflow/react";

export const WIRE_COLOR = "#7C8696";
export const RENDERS_WIRE = "#61DAFB";
/** App-wide caller-green/callee-violet convention shared by Map emphasis and the Logic surface's
 * selection accent, so upstream/downstream reads do not drift between lenses. */
export const CALLER_WIRE = "#6BE38A";
export const CALLEE_WIRE = "#A78BFA";
/** IPC hops (`sends`/`handles` through a channel node): magenta — its OWN colour, distinct from the
 * gold used for cross-package code coupling, so "leaves the process" never reads as "imports another
 * package". The only animated wire on the composition canvas, so IPC traffic is unmistakable. */
export const IPC_WIRE = "#E06CB0";

export function wireColorForKind(kind: string): string {
  if (kind === "renders") {
    return RENDERS_WIRE;
  }
  return kind === "sends" || kind === "handles" ? IPC_WIRE : WIRE_COLOR;
}

/** The closed arrowhead a laid-out edge terminates in, coloured to match its wire. */
export function arrowMarker(color: string, size = 18) {
  return { type: MarkerType.ArrowClosed, color, width: size, height: size };
}
