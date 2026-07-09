/**
 * The Map lens's WIRE palette. Each relationship kind gets its own distinct colour; IPC uses
 * the magenta from edgeColors. Imports are suppressed when a dep edge exists between the pair;
 * bare imports use a neutral gold.
 */

export const REL_COLORS: Record<string, string> = {
  calls: "#5E74C6", // blue — a behavioural call
  instantiates: "#E08A5A", // orange — `new X()`
  extends: "#C77DBB", // orchid — class/interface inheritance
  implements: "#8FB6E3", // steel blue — implementing a contract
  references: "#7C8CA3", // slate — a type used in a signature/type position
};

export function relColor(kind: string | undefined): string | null {
  return kind && kind in REL_COLORS ? REL_COLORS[kind] : null;
}

// Bare imports (no dep edge between the pair) — neutral, unobtrusive.
export const IMPORT_CROSS = "#C9A24B";
export const IMPORT_SIBLING = "#8B7A3F";

// Flow-step glyph tints (inside an expanded callable's charted logic).
export const CALL_RESOLVED = "#5E74C6"; // a resolved call step
export const CALL_UNRESOLVED = "#565E68"; // an unresolved call step
export const CONSTRUCT = "#C9A24B"; // construction + loop / branch / callback / return
