/**
 * The minimal-graph / review palette for the dark Unreal-Blueprints look, kept beside `kindColors`
 * so the review-flavoured surfaces share one token source. Two axes carry meaning here: BOUNDARY
 * context (the faded 1-hop neighbours drawn dimmed + dashed because they sit just outside the seed
 * set) and the diff-conventional CHANGE STATUS painted onto affected file cards. Selection re-uses
 * the Module-map's green emphasis so a lit row and its highlighted modules read as one highlight.
 */

import type { ChangeStatus } from "../derive/changeStatus";

export const REVIEW_COLORS = {
  /** "changed": the amber primary signal (also the active-toggle accent). */
  changed: "#E3B341",
  changedBg: "rgba(227,179,65,0.14)",
  /** The row/module selection accent + its glow (shared with the Module-map emphasis green). */
  selection: "#6BE38A",
  selectionGlow: "rgba(107,227,138,0.45)",
  /** Import wires: a quiet default, lit to the selection green when emphasised. */
  edge: "#3A424E",
  edgeEmphasis: "#6BE38A",
  /** Boundary (context / blast-radius) nodes: dimmed fill, dashed border, muted label. */
  boundaryFill: "#10151C",
  boundaryBorder: "#2A2F37",
  boundaryText: "#6C7683",
  // The diff-conventional change-status palette painted onto affected file cards + the graph legend:
  // green added / amber modified / red removed / purple renamed.
  added: "#3FB950",
  addedBg: "rgba(63,185,80,0.14)",
  modified: "#D29922",
  modifiedBg: "rgba(210,153,34,0.14)",
  removed: "#F85149",
  removedBg: "rgba(248,81,73,0.14)",
  renamed: "#A371F7",
  renamedBg: "rgba(163,113,247,0.14)",
} as const;

/** A change status resolved to its stroke (accent/border), fill (tint) and lowercase legend label. */
export interface ChangeStatusStyle {
  stroke: string;
  fill: string;
  label: string;
}

const CHANGE_STATUS_STYLES: Record<ChangeStatus, ChangeStatusStyle> = {
  added: { stroke: REVIEW_COLORS.added, fill: REVIEW_COLORS.addedBg, label: "added" },
  modified: { stroke: REVIEW_COLORS.modified, fill: REVIEW_COLORS.modifiedBg, label: "modified" },
  removed: { stroke: REVIEW_COLORS.removed, fill: REVIEW_COLORS.removedBg, label: "removed" },
  renamed: { stroke: REVIEW_COLORS.renamed, fill: REVIEW_COLORS.renamedBg, label: "renamed" },
};

/** The diff-conventional color + label for a change status (drives the card tint + legend swatch). */
export function changeStatusColor(status: ChangeStatus): ChangeStatusStyle {
  return CHANGE_STATUS_STYLES[status];
}
