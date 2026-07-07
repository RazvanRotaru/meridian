/**
 * A logic-flow STEP charted in place on the Map — one entry of an expanded block's flow: a call, or
 * a control construct (loop/branch/callback). The quietest shape on the canvas: it reads as the
 * inside of a block, not a peer of one. Resolved call steps are where the flow leaves the frame —
 * their violet wires point at the definition being called. A step with something INSIDE (a charted
 * callee flow, a construct body) carries the same chevron as a block: expanding it unrolls that
 * flow in place, recursively — the expand gesture works at every depth. View-only pseudo-node
 * (never an artifact id).
 */

import { memo } from "react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { useBlueprint } from "../../../state/StoreContext";
import type { StepData } from "../../../derive/flowSteps";
import { ExpandChevron, MONO, PIN, SELECT_ACCENT } from "./frameChrome";

const STEP_GLYPH: Record<StepData["stepKind"], string> = { call: "→", loop: "↻", branch: "⑂", callback: "λ", exit: "⏎" };
// Calls tint by resolution (resolved = the wire-out blue, unresolved = muted); constructs are amber.
const CALL_COLOR = "#5E74C6";
const CONSTRUCT_COLOR = "#C9A24B";

type StepRfNode = Node<StepData, "step">;

function StepNodeImpl({ id, data }: NodeProps<StepRfNode>) {
  const selected = useBlueprint((state) => state.moduleSelected.has(id));
  const glyphColor = data.stepKind === "call" ? (data.resolved ? CALL_COLOR : "#565E68") : CONSTRUCT_COLOR;
  const chevron = data.isContainer ? (
    <ExpandChevron
      id={id}
      isExpanded={data.isExpanded}
      collapsedTitle={data.stepKind === "call" ? "Expand — chart the callee's flow in place" : "Expand — unroll this body in place"}
    />
  ) : null;

  if (data.isExpanded) {
    return (
      <div style={selected ? FRAME_SELECTED : FRAME}>
        <Handle type="target" position={Position.Left} style={PIN} isConnectable={false} />
        <Handle type="source" position={Position.Right} style={PIN} isConnectable={false} />
        <div style={TITLE_BAR} title={data.label}>
          {chevron}
          <span style={{ ...GLYPH, color: glyphColor }}>{STEP_GLYPH[data.stepKind]}</span>
          <span style={FRAME_LABEL}>{data.label}</span>
        </div>
      </div>
    );
  }

  return (
    <div style={selected ? STEP_SELECTED : STEP} title={data.label}>
      <Handle type="target" position={Position.Left} style={PIN} isConnectable={false} />
      <Handle type="source" position={Position.Right} style={PIN} isConnectable={false} />
      {chevron}
      <span style={{ ...GLYPH, color: glyphColor }}>{STEP_GLYPH[data.stepKind]}</span>
      <span style={LABEL}>{data.label}</span>
    </div>
  );
}

export const StepNode = memo(StepNodeImpl);

const STEP: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 5,
  width: "100%",
  height: "100%",
  boxSizing: "border-box",
  padding: "0 8px 0 5px",
  border: "1px solid #242B37",
  borderRadius: 5,
  background: "#161C25",
  fontFamily: MONO,
};
const STEP_SELECTED: React.CSSProperties = { ...STEP, borderColor: SELECT_ACCENT, boxShadow: `0 0 0 2px ${SELECT_ACCENT}` };
// An expanded step is the innermost frame species: a hair quieter than a block's flow frame.
const FRAME: React.CSSProperties = {
  width: "100%",
  height: "100%",
  boxSizing: "border-box",
  border: "1px solid #242B37",
  borderRadius: 6,
  background: "rgba(22,28,37,0.5)",
  fontFamily: MONO,
};
const FRAME_SELECTED: React.CSSProperties = { ...FRAME, borderColor: SELECT_ACCENT, boxShadow: `0 0 0 2px ${SELECT_ACCENT}` };
const TITLE_BAR: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 5,
  height: 22,
  padding: "0 8px 0 5px",
  borderBottom: "1px solid #202632",
  background: "rgba(22,28,37,0.9)",
};
const GLYPH: React.CSSProperties = { fontSize: 9.5, flexShrink: 0 };
const LABEL: React.CSSProperties = {
  minWidth: 0,
  fontSize: 10.5,
  color: "#9AA4B2",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};
const FRAME_LABEL: React.CSSProperties = { ...LABEL, fontWeight: 700, color: "#C8D3E0" };
