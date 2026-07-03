/**
 * Kind-accent palette for the dark Unreal-Blueprints look.
 *
 * The same accent drives a node's header rail and its MiniMap dot, so a reader builds one
 * stable colour->kind association while drilling down. Unknown (registry-absent) kinds get a
 * neutral accent rather than crashing — the schema's vocabularies are intentionally open.
 */

const KIND_COLORS: Record<string, string> = {
  package: "#A77BF3",
  module: "#3FB7C4",
  namespace: "#3FB7C4",
  class: "#E0A33E",
  object: "#D98E5A",
  interface: "#C57BD6",
  enum: "#E0A33E",
  typeAlias: "#C57BD6",
  function: "#56C271",
  method: "#56C271",
  // Boundary nodes read as muted grey — they are outside the analyzed code.
  external: "#6E7681",
  unresolved: "#565E68",
};

const NEUTRAL_ACCENT = "#7A8290";

export function accentForKind(kind: string): string {
  return KIND_COLORS[kind] ?? NEUTRAL_ACCENT;
}
