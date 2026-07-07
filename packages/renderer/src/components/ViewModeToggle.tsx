/**
 * The Call-flow / UI-composition segmented control — the "separate viewer" switch. Selecting a
 * segment flips the store's viewMode, which re-derives the graph (different edge kinds) and,
 * for UI, dives to the React render subtree.
 */

import { useBlueprint, useBlueprintActions } from "../state/StoreContext";
import type { ViewMode } from "../derive/edgeSelection";

const SEGMENTS: ReadonlyArray<{ mode: ViewMode; label: string }> = [
  { mode: "call", label: "Service composition" },
  { mode: "ui", label: "UI composition" },
  { mode: "logic", label: "Logic flow" },
  { mode: "modules", label: "Module map" },
  { mode: "review", label: "PR Review" },
];

export function ViewModeToggle() {
  const viewMode = useBlueprint((state) => state.viewMode);
  const setViewMode = useBlueprintActions().setViewMode;
  return (
    <div style={GROUP_STYLE} role="group" aria-label="View mode">
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
  flexWrap: "wrap",
  padding: 2,
  gap: 2,
  borderRadius: 8,
  border: "1px solid #2A2F37",
  background: "#0E1116",
};

function segmentStyle(active: boolean): React.CSSProperties {
  return {
    border: "none",
    borderRadius: 6,
    padding: "4px 10px",
    fontSize: 12,
    cursor: "pointer",
    font: "inherit",
    fontWeight: active ? 600 : 400,
    background: active ? "#1F2530" : "transparent",
    color: active ? "#E6EDF3" : "#9AA4B2",
  };
}
