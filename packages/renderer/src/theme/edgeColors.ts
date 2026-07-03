/**
 * Wire colours, in one place so the edge component and the marker built at layout time agree.
 *
 * Behavioural call wires read as neutral steel; React "renders" wires get a distinct cyan
 * accent so UI-composition mode is legible at a glance even when both live on screen.
 */

export const WIRE_COLOR = "#7C8696";
export const RENDERS_WIRE = "#61DAFB";

export function wireColorForKind(kind: string): string {
  return kind === "renders" ? RENDERS_WIRE : WIRE_COLOR;
}
