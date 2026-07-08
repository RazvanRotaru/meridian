/**
 * The minimal-graph overlay's shared styles + MiniMap tint, split out of `MinimalGraphView` to keep
 * the component small. Package frames tint blue, files take their category hue — the same reading
 * order (and the same `CATEGORY_COLOR` palette) as the Module map the overlay is built from.
 */

import type { Node } from "@xyflow/react";
import type { ModuleCardData } from "../derive/moduleLevel";
import { CATEGORY_COLOR } from "./nodes/modulemap/ModuleCardNode";

const PACKAGE_TINT = "#5B9BE3";
// The active-toggle amber, matching the Map's "changed" accent family.
const TOGGLE_ACTIVE_ACCENT = "#E3B341";
const TOGGLE_ACTIVE_BG = "rgba(227,179,65,0.14)";

/** MiniMap tint: package frames blue, else the file's category hue. */
export function minimalMiniMapColor(node: Node): string {
  if (node.type === "package") {
    return PACKAGE_TINT;
  }
  return CATEGORY_COLOR[(node.data as ModuleCardData).category];
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
  borderColor: TOGGLE_ACTIVE_ACCENT,
  background: TOGGLE_ACTIVE_BG,
  color: "#E6EDF3",
};

/** Merge the mode-toggle base with its active (aria-pressed) accent. */
export function toggleStyle(active: boolean): React.CSSProperties {
  return active ? { ...TOGGLE_STYLE, ...TOGGLE_ACTIVE_STYLE } : TOGGLE_STYLE;
}
