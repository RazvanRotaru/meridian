/**
 * The Map lens's WIRE palette. Each relationship kind gets its own distinct colour; IPC uses
 * the magenta from edgeColors. Imports are suppressed when a dep edge exists between the pair;
 * bare imports use a neutral gold.
 *
 * VALIDATED, not eyeballed: the 7-wire set (5 kinds + IMPORT_CROSS + IPC_WIRE) passes the
 * categorical checks against the #0E1116 surface — OKLCH lightness band 0.48–0.67 (no kind
 * visually shouts over another), chroma ≥ 0.10 (nothing reads as gray, so no wire is confusable
 * with the DIMMED/neutral grays), CVD separation, ≥3:1 contrast. The previous `references` slate
 * (#7C8CA3) failed the chroma floor AND sat within a hair of the neutral WIRE_COLOR — the most
 * common relationship read as "generic wire"; it wears a muted teal now. Re-run the check after
 * any change here (knowledge/map-readability-plan.md § P2 has the command).
 */

export const REL_COLORS: Record<string, string> = {
  calls: "#5E74C6", // indigo blue — a behavioural call
  instantiates: "#CE7040", // orange — `new X()`
  extends: "#B865AB", // orchid — class/interface inheritance
  implements: "#4E90DE", // steel blue — implementing a contract
  implementedBy: "#4E90DE", // same contract link, read from interface method to implementation
  references: "#2FA8A3", // teal — a symbol used in a type position / as a value
};

export function relColor(kind: string | undefined): string | null {
  return kind && kind in REL_COLORS ? REL_COLORS[kind] : null;
}

// Bare imports (no dep edge between the pair) — neutral, unobtrusive. Sibling stays the darker
// twin of cross so the pair keeps its relative read.
export const IMPORT_CROSS = "#AE8A38";
export const IMPORT_SIBLING = "#7A6630";

// Flow-step glyph tints (inside an expanded callable's charted logic).
export const CALL_RESOLVED = "#5E74C6"; // a resolved call step
export const CALL_UNRESOLVED = "#565E68"; // an unresolved call step
export const CONSTRUCT = "#C9A24B"; // construction + loop / branch / callback / return
