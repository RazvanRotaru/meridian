/**
 * The minimal-graph overlay's shared styles + MiniMap tint, split out of `MinimalGraphView` to keep
 * the component small. Package frames tint blue, boundary files muted, and everything else takes
 * the file's category hue — the same reading order as the Module map it was built from.
 */

import type { Node } from "@xyflow/react";
import { REVIEW_COLORS } from "../theme/reviewColors";
import { REVIEW_GROUP_NODE, type ReviewFileNodeData } from "../layout/minimalSubgraphLayout";
import { CATEGORY_COLOR } from "./nodes/modulemap/ModuleCardNode";

/** MiniMap tint: package frames blue, boundary files muted, else the file's category hue. */
export function reviewMiniMapColor(node: Node): string {
  if (node.type === REVIEW_GROUP_NODE) {
    return "#5B9BE3";
  }
  const data = node.data as ReviewFileNodeData;
  return data.isBoundary ? REVIEW_COLORS.boundaryBorder : CATEGORY_COLOR[data.category];
}

export const SURFACE_STYLE: React.CSSProperties = { position: "relative", width: "100%", height: "100%", background: "#0E1116" };

export const PANEL_STYLE: React.CSSProperties = {
  position: "absolute",
  top: 16,
  left: 16,
  zIndex: 5,
  display: "flex",
  flexDirection: "column",
  gap: 10,
  border: "1px solid #2A2F37",
  borderRadius: 8,
  background: "rgba(18,23,30,0.92)",
  padding: "10px 12px",
};

const TOGGLE_STYLE: React.CSSProperties = {
  background: "transparent",
  border: "1px solid #2A2F37",
  borderRadius: 6,
  padding: "4px 10px",
  cursor: "pointer",
  font: "inherit",
  fontSize: 12,
  fontWeight: 600,
  color: "#9AA4B2",
};
const TOGGLE_ACTIVE_STYLE: React.CSSProperties = {
  borderColor: REVIEW_COLORS.changed,
  background: REVIEW_COLORS.changedBg,
  color: "#E6EDF3",
};

/** Merge the mode-toggle base with its active (aria-pressed) accent. */
export function toggleStyle(active: boolean): React.CSSProperties {
  return active ? { ...TOGGLE_STYLE, ...TOGGLE_ACTIVE_STYLE } : TOGGLE_STYLE;
}
