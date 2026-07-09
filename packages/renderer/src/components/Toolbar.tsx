/**
 * The top-left control panel: project identity, a collapse-all reset, and the mandatory
 * environment gate (only when the artifact ships with an overlay).
 */

import { Panel } from "@xyflow/react";
import { useBlueprint, useBlueprintActions } from "../state/StoreContext";
import { EnvSelector } from "./EnvSelector";
import { Breadcrumb } from "./Breadcrumb";
import { ViewModeToggle } from "./ViewModeToggle";
import { TestsToggle } from "./TestsToggle";
import { CoverageToggle } from "./CoverageToggle";
import { FlowSelector } from "./FlowSelector";
import { CompositionPanel } from "./composition/CompositionPanel";
import { DepthSlider } from "./DepthSlider";
import { ModuleCategoryToggles } from "./ModuleCategoryToggles";

export function Toolbar(props: { preselectedEnv: string | null }) {
  const targetName = useBlueprint((state) => state.artifact.target.name);
  const hasOverlay = useBlueprint((state) => state.hasOverlay);
  // The sidebar swaps its per-lens controls: "call" (Service composition) gets the composition map +
  // refactor worklist; "modules" (Module map) gets the selection highlight-radius dial + category
  // toggles; ui/logic keep the call-flow FlowSelector.
  const viewMode = useBlueprint((state) => state.viewMode);
  const isComposition = viewMode === "call";
  const isModules = viewMode === "modules";
  // The Logic view is a scrollable intra-procedural surface whose sub-tabs aren't all React Flow, so
  // "recenter the graph" has no coherent meaning there — hide the action rather than dead-click it.
  const isLogic = viewMode === "logic";
  const { collapseAll, recenter } = useBlueprintActions();
  return (
    <Panel position="top-left">
      <div style={PANEL_STYLE}>
        <div style={TITLE_ROW_STYLE}>
          <strong style={TITLE_STYLE} title={targetName}>{targetName}</strong>
          <div style={ACTIONS_STYLE}>
            {!isLogic ? (
              <button
                type="button"
                style={ACTION_STYLE}
                onClick={recenter}
                title="Recenter on the current selection, or the whole graph if nothing is selected"
              >
                Recenter
              </button>
            ) : null}
            <button type="button" style={ACTION_STYLE} onClick={collapseAll}>
              Collapse all
            </button>
          </div>
        </div>
        <ViewModeToggle />
        <div style={FILTER_ROW_STYLE}>
          <TestsToggle />
          <CoverageToggle />
        </div>
        <Breadcrumb />
        {isComposition ? (
          <CompositionPanel />
        ) : isModules ? (
          <>
            <DepthSlider />
            <ModuleCategoryToggles />
          </>
        ) : (
          <FlowSelector />
        )}
        {hasOverlay ? <EnvSelector preselectedEnv={props.preselectedEnv} /> : null}
      </div>
    </Panel>
  );
}

const PANEL_STYLE: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 10,
  padding: 12,
  borderRadius: 10,
  border: "1px solid #2A2F37",
  background: "rgba(14,17,22,0.92)",
  backdropFilter: "blur(6px)",
  maxWidth: 300,
};
const TITLE_ROW_STYLE: React.CSSProperties = { display: "flex", alignItems: "center", gap: 12 };
// The title grows (flex:1) and pushes this group right, so the buttons sit together at the row's end.
const ACTIONS_STYLE: React.CSSProperties = { display: "flex", gap: 6, flexShrink: 0 };
const FILTER_ROW_STYLE: React.CSSProperties = { display: "flex", gap: 6 };
const TITLE_STYLE: React.CSSProperties = {
  fontSize: 14,
  color: "#E6EDF3",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  flex: 1,
  minWidth: 0,
};
const ACTION_STYLE: React.CSSProperties = {
  background: "#1A1F27",
  color: "#9AA4B2",
  border: "1px solid #2A2F37",
  borderRadius: 6,
  padding: "4px 10px",
  fontSize: 12,
  cursor: "pointer",
  whiteSpace: "nowrap",
};
