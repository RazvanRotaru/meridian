/**
 * The PR-review lens palette for the dark Unreal-Blueprints look, kept beside `kindColors` so the
 * review surfaces share one token source. Three axes carry meaning: review STATUS (reviewed green vs
 * unreviewed muted), the qualifying REASON (a "changed" file is the amber primary signal, a
 * "calls-into" reach is the calmer teal), and BOUNDARY context (the faded 1-hop neighbours drawn
 * dimmed + dashed because they sit just outside the changed set). Selection re-uses the Module-map's
 * green emphasis so a lit row and its highlighted modules read as one highlight.
 */

import type { ReviewReason } from "../derive/reviewFlows";

export const REVIEW_COLORS = {
  /** A ticked-off flow: the same success green as the coverage/active accents. */
  reviewed: "#56C271",
  /** A flow still awaiting review — muted, so the unreviewed set doesn't shout. */
  unreviewed: "#7B8695",
  /** "changed": the root callable lives in a changed file — the primary amber signal. */
  changed: "#E3B341",
  changedBg: "rgba(227,179,65,0.14)",
  /** "calls-into": the flow only reaches changed code — the calmer secondary teal. */
  callsInto: "#3FB7C4",
  callsIntoBg: "rgba(63,183,196,0.14)",
  /** The row/module selection accent + its glow (shared with the Module-map emphasis green). */
  selection: "#6BE38A",
  selectionGlow: "rgba(107,227,138,0.45)",
  /** Import wires: a quiet default, lit to the selection green when a row emphasises them. */
  edge: "#3A424E",
  edgeEmphasis: "#6BE38A",
  /** Boundary (context / blast-radius) nodes: dimmed fill, dashed border, muted label. */
  boundaryFill: "#10151C",
  boundaryBorder: "#2A2F37",
  boundaryText: "#6C7683",
} as const;

/** The badge accent for a qualifying reason (mirrors `accentForKind`'s open-vocabulary fallback). */
export function reasonColor(reason: ReviewReason): string {
  return reason === "changed" ? REVIEW_COLORS.changed : REVIEW_COLORS.callsInto;
}

/** The badge background for a qualifying reason. */
export function reasonBackground(reason: ReviewReason): string {
  return reason === "changed" ? REVIEW_COLORS.changedBg : REVIEW_COLORS.callsIntoBg;
}

/** The status accent for a flow row: green when reviewed, muted when still pending. */
export function reviewedColor(reviewed: boolean): string {
  return reviewed ? REVIEW_COLORS.reviewed : REVIEW_COLORS.unreviewed;
}
