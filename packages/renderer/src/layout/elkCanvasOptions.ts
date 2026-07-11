/**
 * THE canvas ELK root options — the single allowed definition. Every graph surface (Map, Service,
 * UI, minimal overlay when it runs ELK) must lay out with exactly these root options; per-surface
 * variation is container padding ONLY (title bars, gutter rails), never the root algorithm knobs.
 *
 * Why this is locked down: the UI lens once carried its own near-copy of these options that was
 * missing `elk.aspectRatio` — ELK then stacks disconnected components into a single vertical
 * column (a renders-forest almost always has several roots, so that lens degenerated to a column
 * every time; the same pathology hit the minimal overlay). aspectRatio is what makes ELK pack
 * components side-by-side. Do not fork these options; do not define `elk.*` root literals
 * anywhere else. See docs/plans/2026-07-10-unified-canvas-design.md.
 */
export const CANVAS_ROOT_ELK_OPTIONS: Record<string, string> = {
  "elk.algorithm": "layered",
  "elk.direction": "RIGHT",
  "elk.hierarchyHandling": "INCLUDE_CHILDREN",
  "elk.layered.spacing.nodeNodeBetweenLayers": "64",
  "elk.spacing.nodeNode": "44",
  "elk.spacing.edgeNode": "28",
  "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
  "elk.layered.compaction.postCompaction.strategy": "EDGE_LENGTH",
  "elk.aspectRatio": "1.6",
};

/** The synthetic flat child graph used by minimal Re-arrange. It inherits every canonical canvas
 * knob and changes only hierarchy handling: its leaves are not a real nested surface, so keeping
 * INCLUDE_CHILDREN there suppresses ELK's disconnected-component packing. */
export const FLAT_CANVAS_ELK_OPTIONS: Record<string, string> = {
  ...CANVAS_ROOT_ELK_OPTIONS,
  "elk.hierarchyHandling": "SEPARATE_CHILDREN",
};
