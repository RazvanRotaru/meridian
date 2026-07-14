/**
 * The Blocks (structogram) projection of a logic flow: a Nassi–Shneiderman-style nested column where
 * scope depth == indentation, so the shape reads like the source. The main column runs the flow top
 * to bottom; fire-and-forget work (detached calls, handed-over callbacks) is pulled out into a
 * dashed tray on the right — because it keeps running after the flow returns and its errors never
 * reach the caller, showing it inline would lie about the control flow.
 */

import { useMemo } from "react";
import type { HandoffEntry } from "../../derive/flowViewModel";
import { FLOW_COLORS, collectHandoffs } from "../../derive/flowViewModel";
import type { FlowViewProps } from "../../derive/flowViewModel";
import { Rows } from "./blocksRows";
import type { RowCtx } from "./blocksRows";

const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";

export function BlocksView(props: FlowViewProps & { density?: "full" | "compact"; drillEnabled?: boolean }) {
  // A root focus has no call row in this source-shaped projection. Avoid dimming every row when the
  // review navigator is still doing useful work in the linked upper graph.
  const selectionVisible = props.selected !== null && containsTarget(props.steps, props.selected);
  const ctx: RowCtx = {
    flows: props.flows,
    index: props.index,
    selected: selectionVisible ? props.selected : null,
    onSelect: props.onSelect,
    onDrill: props.onDrill,
    drillEnabled: props.drillEnabled !== false,
  };
  const rootName = props.index.nodesById.get(props.rootId)?.displayName ?? props.rootId;
  // Selection clicks repaint this component; the whole-tree walk must not re-run for them.
  const handoffs = useMemo(() => collectHandoffs(props.steps, props.index), [props.index, props.steps]);

  return (
    <div style={props.density === "compact" ? COMPACT_WRAP : WRAP}>
      <div style={COLUMN}>
        <div style={ENTRY}>▶ {rootName}</div>
        <Rows steps={props.steps} ctx={ctx} />
      </div>
      {handoffs.length > 0 ? <Tray handoffs={handoffs} /> : null}
    </div>
  );
}

function containsTarget(steps: FlowViewProps["steps"], targetId: string): boolean {
  return steps.some((step) => {
    if (step.kind === "call") return step.target === targetId;
    if (step.kind === "loop" || step.kind === "callback") return containsTarget(step.body, targetId);
    if (step.kind === "branch") return step.paths.some((path) => containsTarget(path.body, targetId));
    return false;
  });
}

function Tray({ handoffs }: { handoffs: HandoffEntry[] }) {
  return (
    <div style={TRAY}>
      <span style={TRAY_TITLE}>⤳ HANDED OFF · RUNS LATER</span>
      <div style={TRAY_LIST}>
        {handoffs.map((entry, i) => (
          <div key={i} style={TRAY_ROW}>
            <span style={TRAY_GLYPH}>⤳</span>
            <span style={TRAY_LABEL}>{entry.step.label}</span>
            <span style={TRAY_CTX}>via {entry.context}</span>
          </div>
        ))}
      </div>
      <div style={TRAY_HINT}>Keeps running after the flow returns. Errors here never reach the caller.</div>
    </div>
  );
}

// ~70px top clearance for the floating breadcrumb + sub-tab strip AltLogicSurface overlays.
const WRAP: React.CSSProperties = {
  display: "flex",
  gap: 26,
  justifyContent: "center",
  alignItems: "flex-start",
  padding: "70px 26px 60px",
  fontFamily: MONO,
  color: FLOW_COLORS.ink,
};
const COMPACT_WRAP: React.CSSProperties = {
  ...WRAP,
  width: "max-content",
  minWidth: "100%",
  boxSizing: "border-box",
  justifyContent: "flex-start",
  padding: "16px 20px 36px",
};
const COLUMN: React.CSSProperties = { width: 680, flex: "none", display: "flex", flexDirection: "column", gap: 7 };
const ENTRY: React.CSSProperties = {
  alignSelf: "center",
  padding: "6px 14px",
  borderRadius: 999,
  border: `1px solid ${FLOW_COLORS.entry}`,
  background: `${FLOW_COLORS.entry}1A`,
  color: FLOW_COLORS.entry,
  fontSize: 12,
  fontWeight: 600,
  marginBottom: 4,
};
const TRAY: React.CSSProperties = {
  width: 300,
  flex: "none",
  border: `1px dashed ${FLOW_COLORS.detached}8C`,
  borderRadius: 8,
  padding: "16px 12px 12px",
  position: "relative",
  fontSize: 12,
};
const TRAY_TITLE: React.CSSProperties = {
  position: "absolute",
  top: -9,
  left: 12,
  fontSize: 9,
  letterSpacing: "0.13em",
  color: FLOW_COLORS.detached,
  background: FLOW_COLORS.canvas,
  padding: "0 6px",
  fontWeight: 600,
};
const TRAY_LIST: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 7 };
const TRAY_ROW: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  background: FLOW_COLORS.card,
  border: `1px solid ${FLOW_COLORS.faint}`,
  borderLeft: `3px solid ${FLOW_COLORS.detached}`,
  borderRadius: 5,
  padding: "6px 10px",
};
const TRAY_GLYPH: React.CSSProperties = { color: FLOW_COLORS.detached, fontSize: 11, flex: "none" };
const TRAY_LABEL: React.CSSProperties = { fontWeight: 600, color: FLOW_COLORS.ink, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
const TRAY_CTX: React.CSSProperties = { color: FLOW_COLORS.dim, fontSize: 10, marginLeft: "auto", flex: "none" };
const TRAY_HINT: React.CSSProperties = { fontSize: 10, color: FLOW_COLORS.dim, margin: "10px 2px 0", lineHeight: 1.5 };
