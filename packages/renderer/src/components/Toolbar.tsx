/**
 * The top-left control panel: project identity, a collapse-all reset, and the mandatory
 * environment gate (only when the artifact ships with an overlay).
 */

import { Panel } from "@xyflow/react";
import { useBlueprint, useBlueprintActions } from "../state/StoreContext";
import { EnvSelector } from "./EnvSelector";
import { Breadcrumb } from "./Breadcrumb";
import { ViewModeToggle } from "./ViewModeToggle";
import { FlowSelector } from "./FlowSelector";
import { CompositionPanel } from "./composition/CompositionPanel";

export function Toolbar(props: { preselectedEnv: string | null }) {
  const targetName = useBlueprint((state) => state.artifact.target.name);
  const hasOverlay = useBlueprint((state) => state.hasOverlay);
  // The "call" lens IS the Service-composition surface, so the sidebar swaps the call-flow picker
  // (meaningless there) for the composition map + refactor worklist; ui/logic keep the FlowSelector.
  const isComposition = useBlueprint((state) => state.viewMode) === "call";
  const collapseAll = useBlueprintActions().collapseAll;
  return (
    <Panel position="top-left">
      <div style={PANEL_STYLE}>
        <div style={TITLE_ROW_STYLE}>
          <strong style={TITLE_STYLE} title={targetName}>{targetName}</strong>
          <button type="button" style={RESET_STYLE} onClick={collapseAll}>
            Collapse all
          </button>
        </div>
        <ViewModeToggle />
        <Breadcrumb />
        {isComposition ? <CompositionPanel /> : <FlowSelector />}
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
  marginLeft: "auto",
  background: "#1A1F27",
  color: "#9AA4B2",
  border: "1px solid #2A2F37",
  borderRadius: 6,
  padding: "4px 10px",
  fontSize: 12,
  cursor: "pointer",
};
