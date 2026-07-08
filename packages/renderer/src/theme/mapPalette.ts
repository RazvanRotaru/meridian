/**
 * The Map lens's WIRE and FLOW-STEP palette — the single source of truth shared by the paint layer
 * (`moduleMapHighlight`), the flow-step cards (`StepNode`), and the legend (`MapLegend`), so a colour
 * can never mean one thing on the canvas and show another in the key. Relationship/selection hues
 * (violet = reaches/callee, green = reached-by/caller) live in `edgeColors` and are reserved for that.
 */

// Resting wire colour: every wire is a quiet grey at rest, EXCEPT an import that crosses a directory
// boundary, which goes gold — the one coupling signal worth a hue before you select anything. The
// selection reads (violet/green) are the only other coloured wires; nothing else spends colour.
export const IMPORT_SIBLING = "#5B6675"; // the resting grey shared by every wire (import / dep / flow)
export const IMPORT_CROSS = "#C9A24B"; // import crossing a directory boundary — the coupling signal

// A distinct hue per code-dependency KIND, shown at rest so the reader can tell a call from an
// inheritance from a type reference at a glance (toggles isolate one kind). Deliberately avoids the
// reserved relationship greens/violets (caller/callee selection), the coupling gold, and the IPC
// magenta. Imports keep their own grey/gold; only these `dep`-category kinds are coloured here.
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

// Flow-step glyph tints (inside an expanded callable's charted logic).
export const CALL_RESOLVED = "#5E74C6"; // a resolved call step
export const CALL_UNRESOLVED = "#565E68"; // an unresolved call step
export const CONSTRUCT = "#C9A24B"; // construction + loop / branch / callback / return
