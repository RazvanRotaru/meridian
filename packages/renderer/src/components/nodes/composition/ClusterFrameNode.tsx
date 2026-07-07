/**
 * A cluster FRAME for the Service-composition tab: the titled panel that groups a package's unit
 * scorecards, so the canvas reads as "what's in each package". Styled after logic's DefGroupNode —
 * a translucent panel with a subtle border and a header bar carrying the package (folder) label, a
 * "N units" count, and, when the package holds design smells, a small red "N⚠" marker so a troubled
 * package is spottable at a glance. The frame body is passive (the scorecards React Flow parents to
 * it render OVER it); an AGGREGATED view's inline-expanded frame (`data.expanded`) additionally
 * carries a ▾ header button that collapses it back to its package summary card.
 */

import { memo } from "react";
import type { NodeProps } from "@xyflow/react";
import { useBlueprintActions } from "../../../state/StoreContext";
import type { ClusterNodeData } from "../../../derive/compositionGraph";
import type { CompRfNode } from "../../../layout/compositionElk";

const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";

function ClusterFrameNodeImpl({ data }: NodeProps<CompRfNode>) {
  const { toggleCompExpand } = useBlueprintActions();
  const d = data as ClusterNodeData;
  return (
    <div style={FRAME}>
      <div style={TITLE}>
        <span style={PKG_GLYPH}>◗</span>
        <span style={LABEL} title={d.label}>{d.label}</span>
        <span style={COUNT}>{`${d.unitCount} ${d.unitCount === 1 ? "unit" : "units"}`}</span>
        {d.smellyCount > 0 ? (
          <span style={SMELL_BADGE} title={`${d.smellyCount} unit(s) with design smells`}>{`${d.smellyCount}⚠`}</span>
        ) : null}
        {d.expanded ? (
          <button
            type="button"
            style={COLLAPSE_BTN}
            title="Collapse this package back to its summary card"
            onClick={(event) => {
              event.stopPropagation();
              toggleCompExpand(d.clusterId);
            }}
            onDoubleClick={(event) => event.stopPropagation()}
          >
            ▾
          </button>
        ) : null}
      </div>
    </div>
  );
}

export const ClusterFrameNode = memo(ClusterFrameNodeImpl);

// A neutral slate frame — deliberately quieter than the unit accents so the scorecards inside stay
// the focus. Fills its exact ELK-laid-out box (border-box); the body is transparent for children.
const FRAME: React.CSSProperties = {
  width: "100%",
  height: "100%",
  boxSizing: "border-box",
  border: "1px solid #2A313D",
  borderRadius: 12,
  background: "rgba(20,25,33,0.45)",
  fontFamily: MONO,
};
// A 42px title matches CONTAINER_LAYOUT_OPTIONS' top padding so the child scorecards clear it.
const TITLE: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  height: 42,
  boxSizing: "border-box",
  padding: "0 14px",
  borderBottom: "1px solid #232935",
  color: "#B7C0CC",
  fontSize: 12,
  fontWeight: 700,
};
const PKG_GLYPH: React.CSSProperties = { fontSize: 12, flexShrink: 0, color: "#A77BF3" };
const LABEL: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};
const COUNT: React.CSSProperties = { flexShrink: 0, fontSize: 10, fontWeight: 600, color: "#6C7683" };
const SMELL_BADGE: React.CSSProperties = {
  flexShrink: 0,
  fontSize: 9.5,
  fontWeight: 700,
  letterSpacing: "0.04em",
  color: "#F0787C",
  border: "1px solid #5B2B2F",
  borderRadius: 3,
  padding: "1px 5px",
  background: "rgba(229,72,77,0.14)",
};
// Mirrors the package card's ▸ expand pill so open/close read as the same control family.
const COLLAPSE_BTN: React.CSSProperties = {
  flexShrink: 0,
  fontSize: 10,
  fontWeight: 700,
  lineHeight: "14px",
  color: "#8FB6E3",
  border: "1px solid #2F4A66",
  background: "rgba(59,122,192,0.16)",
  borderRadius: 3,
  padding: "0 5px",
  cursor: "pointer",
  fontFamily: "inherit",
};
