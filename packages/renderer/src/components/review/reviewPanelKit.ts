/**
 * The review panel's shared visual vocabulary — one home for what its sections must agree on
 * (mirrors controlpanel/panelKit): the todo/done/stale tick glyphs+colors, the section-header
 * styles, and small shared bits. Keyed by the ONE CheckState union from derive, so a new state
 * fails the type-check here rather than rendering a blank glyph.
 */

import type { CheckState } from "../../derive/reviewFiles";

export const TICK_GLYPH: Record<CheckState, string> = { todo: "○", done: "✓", stale: "◐" };
export const TICK_COLOR: Record<CheckState, string> = { todo: "#7D8695", done: "#3FB950", stale: "#D29922" };

/** The comment composer's target row: a file (nodeId null) or one touched unit inside it. */
export interface CommentTarget {
  path: string;
  nodeId: string | null;
}

export function basename(path: string): string {
  return path.split("/").pop() ?? path;
}

export const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";

/** Panel buttons carry no focus outline: every click's feedback lives on the GRAPH (ring +
 * centering), and clicked-button rings lingering down the checklist read as phantom selection. */
export const NO_FOCUS_RING: React.CSSProperties = { outline: "none" };

export const SECTION_HEAD: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  width: "100%",
  padding: "6px 6px 4px",
  border: "none",
  background: "transparent",
  cursor: "pointer",
  font: "inherit",
  textAlign: "left",
  ...NO_FOCUS_RING,
};
export const SECTION_TITLE: React.CSSProperties = { fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5, color: "#9AA4B2" };
export const SECTION_COUNT: React.CSSProperties = { fontSize: 10, fontWeight: 600, color: "#9AA4B2", background: "#1B212A", borderRadius: 9, padding: "0 6px" };
export const CARET: React.CSSProperties = { fontSize: 9, color: "#5A6472", width: 10, flexShrink: 0 };
export const TEST_CHIP: React.CSSProperties = { fontSize: 9, fontWeight: 700, color: "#8B7DF0", border: "1px solid #3A3357", borderRadius: 4, padding: "0 4px", flexShrink: 0 };
export const TICK_BTN: React.CSSProperties = { border: "none", background: "transparent", cursor: "pointer", fontSize: 15, lineHeight: 1, padding: "2px 5px", flexShrink: 0, ...NO_FOCUS_RING };

/** The uppercase kind chip (INTERFACE / OBJECT / …) — the one kind marker the UI uses; the old
 * ◆/◇/❑ glyph vocabulary is retired everywhere in favour of these labels. */
export const KIND_CHIP: React.CSSProperties = {
  flexShrink: 0,
  fontSize: 8,
  fontWeight: 700,
  letterSpacing: "0.06em",
  border: "1px solid",
  borderRadius: 3,
  padding: "1px 4px",
};

/** Callables read fine as plain names; only type-shaped declarations get the kind chip. */
export function kindChipText(kind: string): string | null {
  return kind === "function" || kind === "method" ? null : kind.toUpperCase();
}
export const EMPTY_NOTE: React.CSSProperties = { fontSize: 12, color: "#7D8695", padding: "10px 8px 6px", textAlign: "center" };
