/**
 * Kind-accent palette for the dark Unreal-Blueprints look.
 *
 * The same accent drives a node's header rail and its MiniMap dot, so a reader builds one
 * stable colour->kind association while drilling down. Unknown (registry-absent) kinds get a
 * neutral accent rather than crashing — the schema's vocabularies are intentionally open.
 */

// Green and violet are RESERVED for relationships (caller/callee wires + selection reads); node
// kinds never wear them, so a hue means one thing. Structural containers are cool (blue/teal),
// type-shaped kinds share a warm amber ramp, callables are a distinct yellow.
const KIND_COLORS: Record<string, string> = {
  package: "#5B9BE3",
  module: "#3FB7C4",
  namespace: "#3FB7C4",
  // Every type-shaped declaration shares ONE amber; the glyph (◆ ◇ ❑ τ) tells class from interface
  // from object from type — colour doesn't need to repeat what the glyph already says.
  class: "#E0A33E",
  object: "#E0A33E",
  interface: "#E0A33E",
  enum: "#E0A33E",
  typeAlias: "#E0A33E",
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

// The ◆/◇/❑/▤ kind-glyph vocabulary is retired: the textual kind labels (INTERFACE / OBJECT / …)
// are the one kind marker across cards and panels.
