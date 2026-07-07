/**
 * A logic-flow STEP charted in place on the Map — one entry of an expanded block's flow: a call, or
 * a folded control construct (loop/branch/callback). The quietest shape on the canvas: it reads as
 * the inside of a block, not a peer of one. Resolved call steps are where the flow leaves the frame
 * — their violet wires point at the definition being called. View-only pseudo-node (never an
 * artifact id).
 */

import { memo } from "react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { useBlueprint } from "../../../state/StoreContext";
import type { StepData } from "../../../derive/flowSteps";
import { MONO, PIN, SELECT_ACCENT } from "./frameChrome";

const STEP_GLYPH: Record<StepData["stepKind"], string> = { call: "→", loop: "↻", branch: "⑂", callback: "λ" };
// Calls tint by resolution (resolved = the wire-out blue, unresolved = muted); constructs are amber.
const CALL_COLOR = "#5E74C6";
const CONSTRUCT_COLOR = "#C9A24B";

type StepRfNode = Node<StepData, "step">;

function StepNodeImpl({ id, data }: NodeProps<StepRfNode>) {
  const selected = useBlueprint((state) => state.moduleSelectedId) === id;
  const glyphColor = data.stepKind === "call" ? (data.resolved ? CALL_COLOR : "#565E68") : CONSTRUCT_COLOR;
  return (
    <div style={selected ? STEP_SELECTED : STEP} title={data.label}>
      <Handle type="target" position={Position.Left} style={PIN} isConnectable={false} />
      <Handle type="source" position={Position.Right} style={PIN} isConnectable={false} />
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
  padding: "0 8px",
  border: "1px solid #242B37",
  borderRadius: 5,
  background: "#161C25",
  fontFamily: MONO,
};
const STEP_SELECTED: React.CSSProperties = { ...STEP, borderColor: SELECT_ACCENT, boxShadow: `0 0 0 2px ${SELECT_ACCENT}` };
const GLYPH: React.CSSProperties = { fontSize: 9.5, flexShrink: 0 };
const LABEL: React.CSSProperties = {
  minWidth: 0,
  fontSize: 10.5,
  color: "#9AA4B2",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};
