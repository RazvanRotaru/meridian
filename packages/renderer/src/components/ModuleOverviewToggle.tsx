/**
 * Flip the Module map between the whole-repository PACKAGE overview (every npm package collapsed to
 * one node) and the entry-rooted FILE view (the import blast radius). A two-segment control mirroring
 * the ViewModeToggle's styling so the two read as one control language.
 */

import { useBlueprint, useBlueprintActions } from "../state/StoreContext";

export function ModuleOverviewToggle() {
  const overview = useBlueprint((state) => state.moduleOverview);
  const setModuleOverview = useBlueprintActions().setModuleOverview;
  return (
    <div style={GROUP_STYLE} role="group" aria-label="Module map scope">
      <button
        type="button"
        style={overview ? SEGMENT_ACTIVE : SEGMENT}
        aria-pressed={overview}
        onClick={() => setModuleOverview(true)}
      >
        Packages
      </button>
      <button
        type="button"
        style={overview ? SEGMENT : SEGMENT_ACTIVE}
        aria-pressed={!overview}
        onClick={() => setModuleOverview(false)}
      >
        Files
      </button>
    </div>
  );
}

const GROUP_STYLE: React.CSSProperties = {
  display: "flex",
  gap: 2,
  padding: 2,
  borderRadius: 8,
  border: "1px solid #2A2F37",
  background: "#12171E",
};
const SEGMENT: React.CSSProperties = {
  flex: 1,
  padding: "5px 8px",
  borderRadius: 6,
  border: "none",
  background: "transparent",
  color: "#9AA4B2",
  fontSize: 12,
  fontWeight: 600,
  cursor: "pointer",
};
const SEGMENT_ACTIVE: React.CSSProperties = { ...SEGMENT, background: "#1E2530", color: "#E6EDF3" };
