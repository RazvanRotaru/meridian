/**
 * The minimal-graph overlay's shared styles + MiniMap tint, split out of `MinimalGraphView` to keep
 * the component small. The overlay is FLAT: file cards take the file-family accent, group member/ghost
 * cards a package hue, and an expanded file's nested declarations a muted code tint — the same reading
 * order as the Module map the overlay mirrors.
 */

import type { Node } from "@xyflow/react";
import { CHROME_EDGE } from "./canvas/flowCanvasProps";
import { MINIMAL_MEMBERS_MAX_HEIGHT_OFFSET, MINIMAL_MEMBERS_MIN_HEIGHT } from "./controlpanel/canvasActionBarLayout";
import { CONTROL_PANEL_WIDTH } from "./controlpanel/panelKit";

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

const PANEL_STYLE: React.CSSProperties = {
  position: "absolute",
  top: 16,
  left: 16,
  zIndex: 6,
  display: "flex",
  flexDirection: "column",
  gap: 10,
  overflow: "hidden",
  border: "1px solid #2A2F37",
  borderRadius: 8,
  background: "rgba(18,23,30,0.92)",
  padding: "10px 12px",
};

// The members list owns the top-right lane now that view actions live in the bottom action bar.
export const MEMBERS_PANEL_STYLE: React.CSSProperties = {
  ...PANEL_STYLE,
  left: "auto",
  right: 16,
  top: 16,
  gap: 8,
  width: "max-content",
  maxWidth: `min(280px, max(144px, calc(100% - ${CHROME_EDGE + CONTROL_PANEL_WIDTH + 32}px)))`,
  maxHeight: `max(${MINIMAL_MEMBERS_MIN_HEIGHT}px, calc(100% - ${MINIMAL_MEMBERS_MAX_HEIGHT_OFFSET}px))`,
  boxSizing: "border-box",
};
