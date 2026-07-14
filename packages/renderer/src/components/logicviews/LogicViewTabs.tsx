/**
 * The Logic-flow SUB-VIEW switch: four static projections of the same flow plus, while Telemetry
 * mode is active, one observed request trace. It floats top-center over whichever surface is
 * mounted. Flipping it never touches the charted root, drill trail, or selection.
 */

import { useBlueprint, useBlueprintActions } from "../../state/StoreContext";
import { LOGIC_VIEW_MODES, STATIC_LOGIC_VIEW_MODES } from "../../derive/flowViewModel";
import type { NodeId } from "@meridian/core";
import { LogicSyntheticExecutionControls } from "../synthetic/SyntheticExecutionControls";

export function LogicViewTabs(props: { rootId?: NodeId } = {}) {
  const logicView = useBlueprint((state) => state.logicView);
  const telemetryMode = useBlueprint((state) => state.telemetryMode);
  const setLogicView = useBlueprintActions().setLogicView;
  const modes = telemetryMode ? LOGIC_VIEW_MODES : STATIC_LOGIC_VIEW_MODES;
  return (
    <div style={TOP_CONTROLS}>
      <div style={BAR} role="group" aria-label="Logic flow view">
        {modes.map((entry) => (
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
      {props.rootId === undefined ? null : <LogicSyntheticExecutionControls rootId={props.rootId} />}
    </div>
  );
}

// Mirrors the top-level ViewModeToggle's segmented look so the two switches read as one family.
const TOP_CONTROLS: React.CSSProperties = {
  position: "absolute",
  top: 12,
  left: "50%",
  transform: "translateX(-50%)",
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: 7,
  pointerEvents: "none",
  zIndex: 20,
};

const BAR: React.CSSProperties = {
  display: "flex",
  padding: 2,
  gap: 2,
  borderRadius: 8,
  border: "1px solid #2A2F37",
  background: "rgba(14,17,22,0.92)",
  pointerEvents: "auto",
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
