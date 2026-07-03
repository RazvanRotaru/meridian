/**
 * The top-left control panel: project identity, a collapse-all reset, and the mandatory
 * environment gate (only when the artifact ships with an overlay).
 */

import { Panel } from "@xyflow/react";
import { useBlueprint, useBlueprintActions } from "../state/StoreContext";
import { EnvSelector } from "./EnvSelector";
import { Breadcrumb } from "./Breadcrumb";
import { ViewModeToggle } from "./ViewModeToggle";

export function Toolbar(props: { preselectedEnv: string | null }) {
  const targetName = useBlueprint((state) => state.artifact.target.name);
  const hasOverlay = useBlueprint((state) => state.hasOverlay);
  const collapseAll = useBlueprintActions().collapseAll;
  return (
    <Panel position="top-left">
      <div style={PANEL_STYLE}>
        <div style={TITLE_ROW_STYLE}>
          <strong style={TITLE_STYLE}>{targetName}</strong>
          <button type="button" style={RESET_STYLE} onClick={collapseAll}>
            Collapse all
          </button>
        </div>
        <ViewModeToggle />
        <Breadcrumb />
        <RangeRow />
        {hasOverlay ? <EnvSelector preselectedEnv={props.preselectedEnv} /> : null}
      </div>
    </Panel>
  );
}

/** The change-lens status row, mirroring the ENVIRONMENT row: which range is painted on. */
function RangeRow() {
  const change = useBlueprint((state) => state.change);
  if (!change) {
    return null;
  }
  const files = Object.values(change.files);
  const additions = files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0);
  return (
    <div style={RANGE_ROW_STYLE}>
      <span style={RANGE_LABEL_STYLE}>RANGE</span>
      <code style={RANGE_VALUE_STYLE}>{change.range}</code>
      <span style={RANGE_STATS_STYLE}>
        {files.length}Δ · <span style={{ color: "#56C271" }}>+{additions}</span>{" "}
        <span style={{ color: "#E5534B" }}>−{deletions}</span>
      </span>
    </div>
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
};
const RANGE_ROW_STYLE: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8 };
const RANGE_LABEL_STYLE: React.CSSProperties = {
  fontSize: 9,
  fontWeight: 700,
  letterSpacing: 0.8,
  color: "#7C8696",
};
const RANGE_VALUE_STYLE: React.CSSProperties = {
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  fontSize: 11,
  color: "#E8B341",
};
const RANGE_STATS_STYLE: React.CSSProperties = {
  fontSize: 11,
  color: "#9AA4B2",
  fontVariantNumeric: "tabular-nums",
};
const TITLE_ROW_STYLE: React.CSSProperties = { display: "flex", alignItems: "center", gap: 12 };
const TITLE_STYLE: React.CSSProperties = { fontSize: 14, color: "#E6EDF3" };
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
