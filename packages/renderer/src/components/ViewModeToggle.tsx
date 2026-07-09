/**
 * The LENS segmented control — the "separate viewer" switch. Selecting a segment flips the store's
 * viewMode, which re-derives the graph (different edge kinds) and, for UI, dives to the React render
 * subtree. The "PRs" segment opens the pull-request review surface (list a repo's PRs, analyze one
 * into a minimal graph of its modified nodes + affected logic flows); it only has data under a
 * GitHub-sourced `meridian web` session and shows an honest empty state otherwise.
 */

import { useBlueprint, useBlueprintActions } from "../state/StoreContext";
import type { ViewMode } from "../derive/edgeSelection";

const SEGMENTS: ReadonlyArray<{ mode: ViewMode; label: string }> = [
  { mode: "modules", label: "Map" },
  { mode: "call", label: "Service" },
  { mode: "ui", label: "UI" },
  { mode: "logic", label: "Logic" },
  { mode: "prs", label: "PRs" },
];

export function ViewModeToggle() {
  const viewMode = useBlueprint((state) => state.viewMode);
  const setViewMode = useBlueprintActions().setViewMode;
  return (
    <div style={GROUP_STYLE} role="group" aria-label="Lens">
      {SEGMENTS.map((segment) => (
        <button
          key={segment.mode}
          type="button"
          style={segmentStyle(segment.mode === viewMode)}
          aria-pressed={segment.mode === viewMode}
          onClick={() => setViewMode(segment.mode)}
        >
          {segment.label}
        </button>
      ))}
    </div>
  );
}

const GROUP_STYLE: React.CSSProperties = {
  display: "flex",
  padding: 3,
  gap: 2,
  borderRadius: 9,
  border: "1px solid #2A2F37",
  background: "#0E1116",
};

function segmentStyle(active: boolean): React.CSSProperties {
  return {
    flex: 1,
    border: "none",
    borderRadius: 6,
    padding: "6px 8px",
    fontSize: 12.5,
    cursor: "pointer",
    font: "inherit",
    fontWeight: active ? 600 : 500,
    background: active ? "#242A31" : "transparent",
    color: active ? "#E6EDF3" : "#8B949E",
  };
}
