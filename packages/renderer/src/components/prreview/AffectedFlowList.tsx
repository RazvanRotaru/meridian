/**
 * PR-review side panel: the logic flows a change set touches DIRECTLY (see derive/affectedFlows). Pure
 * presentational — it renders the derived `AffectedFlow[]` alone (no store). Each row names the flow's
 * owner, its file, and a reason chip: "changed" when the owner itself changed, else "calls N changed".
 */

import type { AffectedFlow } from "../../derive/affectedFlows";

export function AffectedFlowList({ flows }: { flows: AffectedFlow[] }): React.JSX.Element {
  return (
    <div style={PANEL}>
      <div style={TITLE}>Affected logic flows ({flows.length})</div>
      {flows.length === 0 ? (
        <div style={EMPTY}>No logic flows are directly affected by this change.</div>
      ) : (
        <ul style={LIST}>
          {flows.map((flow) => (
            <FlowRow key={flow.flowId} flow={flow} />
          ))}
        </ul>
      )}
    </div>
  );
}

function FlowRow({ flow }: { flow: AffectedFlow }): React.JSX.Element {
  return (
    <li style={ROW}>
      <div style={ROW_HEAD}>
        <span style={NAME} title={flow.flowId}>{flow.displayName}</span>
        <ReasonChip flow={flow} />
      </div>
      {flow.file ? <span style={FILE} title={flow.file}>{flow.file}</span> : null}
    </li>
  );
}

function ReasonChip({ flow }: { flow: AffectedFlow }): React.JSX.Element {
  const changed = flow.ownerChanged;
  const label = changed ? "changed" : `calls ${flow.changedTargets.length} changed`;
  return <span style={changed ? CHIP_CHANGED : CHIP_CALLS}>{label}</span>;
}

const PANEL: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 8,
  padding: 12,
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  color: "#E6EDF3",
};
const TITLE: React.CSSProperties = { fontSize: 12, fontWeight: 700, letterSpacing: "0.04em", color: "#C8D3E0" };
const EMPTY: React.CSSProperties = { fontSize: 11.5, color: "#6C7683" };
const LIST: React.CSSProperties = { listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 6 };
const ROW: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 3,
  padding: "6px 8px",
  border: "1px solid #232935",
  borderRadius: 6,
  background: "#12171E",
};
const ROW_HEAD: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8 };
const NAME: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  fontSize: 12,
  fontWeight: 600,
  color: "#E6EDF3",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};
const FILE: React.CSSProperties = {
  fontSize: 10,
  color: "#6C7683",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};
const CHIP_BASE: React.CSSProperties = {
  flexShrink: 0,
  fontSize: 8,
  fontWeight: 700,
  letterSpacing: "0.06em",
  textTransform: "uppercase",
  border: "1px solid",
  borderRadius: 3,
  padding: "1px 4px",
};
const CHIP_CHANGED: React.CSSProperties = { ...CHIP_BASE, color: "#F5A623", borderColor: "#6E5320", background: "rgba(245,166,35,0.16)" };
const CHIP_CALLS: React.CSSProperties = { ...CHIP_BASE, color: "#3FB7C4", borderColor: "#245B62", background: "rgba(63,183,196,0.14)" };
