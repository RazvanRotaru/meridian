/**
 * Kind-accent palette for the dark Unreal-Blueprints look.
 *
 * The same accent drives a node's header rail and its MiniMap dot, so a reader builds one
 * stable colour->kind association while drilling down. Unknown (registry-absent) kinds get a
 * neutral accent rather than crashing — the schema's vocabularies are intentionally open.
 */

// Green is RESERVED for selection/caller-callee reads and amber for the diff highlight; node kinds
// wear neither, so those two hues always mean one thing. Structural containers are cool (blue/teal);
// type-shaped kinds share one violet — the "type world", echoing the extends/implements wires;
// callables are a distinct yellow.
const KIND_COLORS: Record<string, string> = {
  package: "#5B9BE3",
  module: "#3FB7C4",
  namespace: "#3FB7C4",
  // Every type-shaped declaration shares ONE violet; the glyph (◆ ◇ ❑ τ) tells class from interface
  // from object from type — colour doesn't need to repeat what the glyph already says.
  class: "#B87ED0",
  object: "#B87ED0",
  interface: "#B87ED0",
  enum: "#B87ED0",
  typeAlias: "#B87ED0",
  function: "#E3C36B",
  method: "#E3C36B",
  // Boundary nodes read as muted grey — they are outside the analyzed code.
  external: "#6E7681",
  unresolved: "#565E68",
  // IPC: a channel is the shared wire two processes meet on (magenta, like its sends/handles edges —
  // distinct from the gold of cross-package code coupling); a system frame is one linked artifact —
  // steel blue, structural rather than behavioural.
  channel: "#E06CB0",
  system: "#8FB6E3",
};

const NEUTRAL_ACCENT = "#7A8290";

export function accentForKind(kind: string): string {
  return KIND_COLORS[kind] ?? NEUTRAL_ACCENT;
}

// A compact kind glyph so a card reads as class/module/interface/object before its tag is scanned.
// Shared by the composition scorecards and the Map's unit cards, so the two lenses tell one story.
const KIND_GLYPHS: Record<string, string> = {
  module: "▤",
  class: "◆",
  interface: "◇",
  object: "❑",
};

export function glyphForKind(kind: string): string {
  return KIND_GLYPHS[kind] ?? "▪";
}

// A single-letter kind glyph — f function, m method, c class, i interface, o object, e enum, t type,
// n namespace — replacing the wordy INTERFACE / FUNCTION / … tags; the accent colour still says which.
const KIND_LETTERS: Record<string, string> = {
  function: "f",
  method: "m",
  class: "c",
  interface: "i",
  object: "o",
  enum: "e",
  typeAlias: "t",
  namespace: "n",
};

export function kindLetter(kind: string): string {
  return KIND_LETTERS[kind] ?? (kind.charAt(0).toLowerCase() || "•");
}
