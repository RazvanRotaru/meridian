/**
 * The minimal-graph overlay's shared styles + MiniMap tint, split out of `MinimalGraphView` to keep
 * the component small. The overlay is FLAT: file cards take the file-family accent, group member/ghost
 * cards a package hue, and an expanded file's nested declarations a muted code tint — the same reading
 * order as the Module map the overlay mirrors.
 */

import type { Node } from "@xyflow/react";

// The package-card hue, mirroring PackageOverviewNode's accent.
const PACKAGE_TINT = "#5B9BE3";
// An expanded file's nested declarations (unit/block/step) share a muted code tint on the MiniMap —
// they carry no file `category`, and the reader navigates by the file frames, not their innards.
const CHILD_TINT = "#4A5568";
// Files wear the single file-family accent — the Map no longer tints per category (category is
// carried by a text chip alone; see ModuleCardNode), so the MiniMap mirrors that one hue.
const FILE_TINT = "#3FB7C4";

/** MiniMap tint: group cards a package hue, nested declarations a muted code tint, else the file accent. */
export function minimalMiniMapColor(node: Node): string {
  if (node.type === "package") {
    return PACKAGE_TINT;
  }
  if (node.type !== "file") {
    return CHILD_TINT;
  }
  return FILE_TINT;
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

// The members list panel, docked top-right BENEATH the main title/Reset/Close panel (three stacked
// rows at top:16), so the Close button underneath stays clickable.
export const MEMBERS_PANEL_STYLE: React.CSSProperties = {
  ...PANEL_STYLE,
  left: "auto",
  right: 16,
  top: 152,
  gap: 8,
  maxWidth: 280,
};

const BUTTON_STYLE: React.CSSProperties = {
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
const BUTTON_ACTIVE_STYLE: React.CSSProperties = {
  borderColor: "#E3B341",
  background: "rgba(227,179,65,0.14)",
  color: "#E6EDF3",
};
const BUTTON_DISABLED_STYLE: React.CSSProperties = { opacity: 0.4, cursor: "default" };

/** A panel button: base, plus an active (aria-pressed) accent and/or a disabled dim. */
export function buttonStyle(active: boolean, disabled: boolean): React.CSSProperties {
  return {
    ...BUTTON_STYLE,
    ...(active ? BUTTON_ACTIVE_STYLE : {}),
    ...(disabled ? BUTTON_DISABLED_STYLE : {}),
  };
}
