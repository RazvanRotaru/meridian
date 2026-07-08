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
import { PrivateToggle } from "./PrivateToggle";
import { CoverageToggle } from "./CoverageToggle";
import { FlowSelector } from "./FlowSelector";
import { CompositionPanel } from "./composition/CompositionPanel";
import { DepthSlider } from "./DepthSlider";
import { ModuleCategoryToggles } from "./ModuleCategoryToggles";
import { HighlightModeToggle } from "./HighlightModeToggle";

export function Toolbar(props: { preselectedEnv: string | null }) {
  const targetName = useBlueprint((state) => state.artifact.target.name);
  const hasOverlay = useBlueprint((state) => state.hasOverlay);
  // The sidebar swaps its per-lens controls: "call" (Service composition) gets the composition map +
  // refactor worklist; "modules" (Module map) gets the selection highlight-radius dial + category
  // toggles; ui/logic keep the call-flow FlowSelector.
  const viewMode = useBlueprint((state) => state.viewMode);
  const flowExplorerOpen = useBlueprint((state) => state.flowExplorerOpen);
  const isComposition = viewMode === "call";
  const isModules = viewMode === "modules";
  const isPrs = viewMode === "prs";
  const showFlowToggle = viewMode === "ui" || viewMode === "modules";
  const { expandAll, collapseAll, toggleFlowExplorer } = useBlueprintActions();
  return (
    <Panel position="top-left">
      <div style={PANEL_STYLE}>
        <div style={TITLE_ROW_STYLE}>
          <strong style={TITLE_STYLE} title={targetName}>{targetName}</strong>
          {isPrs ? null : (
            <span style={EXPAND_GROUP_STYLE}>
              <button
                type="button"
                style={RESET_STYLE}
                title="Expand the selection one level — or the whole view when nothing is selected"
                onClick={expandAll}
              >
                Expand all
              </button>
              <button
                type="button"
                style={RESET_STYLE}
                title="Collapse the selection one level — or the whole view when nothing is selected"
                onClick={collapseAll}
              >
                Collapse all
              </button>
            </span>
          )}
        </div>
        <ViewModeToggle />
        {isPrs ? null : (
          <>
            <div style={FILTER_ROW_STYLE}>
              <TestsToggle />
              {isModules || isComposition ? <HighlightModeToggle /> : null}
              {isModules ? <PrivateToggle /> : null}
              <CoverageToggle />
              {showFlowToggle ? (
                <button
                  type="button"
                  style={flowToggleStyle(flowExplorerOpen)}
                  aria-pressed={flowExplorerOpen}
                  onClick={toggleFlowExplorer}
                >
                  Flows
                </button>
              ) : null}
            </div>
            <Breadcrumb />
          </>
        )}
        {isComposition ? (
          <>
            <DepthSlider />
            <CompositionPanel />
          </>
        ) : isModules ? (
          <>
            <DepthSlider />
            <ModuleCategoryToggles />
          </>
        ) : isPrs ? null : (
          <FlowSelector />
        )}
        {hasOverlay && !isPrs ? <EnvSelector preselectedEnv={props.preselectedEnv} /> : null}
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
const EXPAND_GROUP_STYLE: React.CSSProperties = { marginLeft: "auto", display: "flex", gap: 6 };
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
const RESET_STYLE: React.CSSProperties = {
  background: "#1A1F27",
  color: "#9AA4B2",
  border: "1px solid #2A2F37",
  borderRadius: 6,
  padding: "4px 10px",
  fontSize: 12,
  cursor: "pointer",
};

function flowToggleStyle(active: boolean): React.CSSProperties {
  return {
    background: active ? "#1F2530" : "#1A1F27",
    color: active ? "#E6EDF3" : "#9AA4B2",
    border: `1px solid ${active ? "#56C271" : "#2A2F37"}`,
    borderRadius: 6,
    padding: "4px 10px",
    fontSize: 12,
    cursor: "pointer",
  };
}
