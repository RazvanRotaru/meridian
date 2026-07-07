/**
 * The Logic-flow SUB-VIEW switch: four projections of the same flow (exec graph / metro / blocks /
 * timeline), floated top-center over whichever surface is mounted. A pure presentation switch —
 * flipping it never touches the charted root, drill trail, or selection.
 */

import { useBlueprint, useBlueprintActions } from "../../state/StoreContext";
import { LOGIC_VIEW_MODES } from "../../derive/flowViewModel";

export function LogicViewTabs() {
  const logicView = useBlueprint((state) => state.logicView);
  const setLogicView = useBlueprintActions().setLogicView;
  return (
    <div style={BAR} role="group" aria-label="Logic flow view">
      {LOGIC_VIEW_MODES.map((entry) => (
        <button
          key={entry.mode}
          type="button"
          style={segmentStyle(entry.mode === logicView)}
          aria-pressed={entry.mode === logicView}
          onClick={() => setLogicView(entry.mode)}
        >
          {entry.label}
        </button>
      ))}
    </div>
  );
}

// Mirrors the top-level ViewModeToggle's segmented look so the two switches read as one family.
const BAR: React.CSSProperties = {
  position: "absolute",
  top: 12,
  left: "50%",
  transform: "translateX(-50%)",
  display: "flex",
  padding: 2,
  gap: 2,
  borderRadius: 8,
  border: "1px solid #2A2F37",
  background: "rgba(14,17,22,0.92)",
  zIndex: 20,
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
