/**
 * A logic-flow STEP charted in place on the Map — one entry of an expanded block's flow: a call, or
 * a control construct (loop/branch/callback). The quietest shape on the canvas: it reads as the
 * inside of a block, not a peer of one. Resolved call steps are where the flow leaves the frame —
 * their violet wires point at the definition being called. Every resolved local call and every
 * structural step carries the same disclosure as a block: expanding it unrolls that flow in place,
 * recursively (or shows the shared empty state) — the expand gesture works at every
 * depth. View-only pseudo-node
 * (never an artifact id).
 */

import { memo } from "react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { useSurfaceNodeSelected } from "../../canvas/SurfaceInteractionContext";
import type { StepData } from "../../../derive/flowSteps";
import { BaseNode, type BaseNodeModel } from "../BaseNode";
import { EmptyNodeExpansion } from "../EmptyNodeExpansion";
import { cardSelectedStyle, MONO, PIN } from "./frameChrome";
import { CALL_RESOLVED, CALL_UNRESOLVED, CONSTRUCT } from "../../../theme/mapPalette";

type StepRfNode = Node<StepData, "step">;

function StepNodeImpl({ id, data }: NodeProps<StepRfNode>) {
  const selected = useSurfaceNodeSelected(id);
  // Calls tint by resolution (resolved = wire-out blue, unresolved = muted); constructs are amber.
  const glyphColor = data.stepKind === "call" ? (data.resolved ? CALL_RESOLVED : CALL_UNRESOLVED) : CONSTRUCT;
  const model: BaseNodeModel = {
    instanceId: id,
    // Structural steps fall back to their occurrence owner; resolved call steps retain the callee
    // identity so the same node can expand in place and navigate into that callable.
    targetId: data.targetId ?? null,
    nodeType: "step",
    kind: data.nodeKind,
    semantics: data.semantics,
    label: data.label,
    childCount: data.childCount,
    canExpand: data.isContainer,
    expanded: data.isExpanded,
    canNavigate: true,
    data,
  };
  const handles = (
    <>
      <Handle type="target" position={Position.Left} style={PIN} isConnectable={false} />
      <Handle type="source" position={Position.Right} style={PIN} isConnectable={false} />
    </>
  );
  if (data.isExpanded) {
    return (
      <BaseNode
        model={model}
        style={selected ? cardSelectedStyle(FRAME, glyphColor) : FRAME}
        headerStyle={TITLE_BAR}
        labelStyle={FRAME_LABEL}
        ports={handles}
        title={data.label}
      >
        {data.emptyFlow ? <EmptyNodeExpansion /> : null}
      </BaseNode>
    );
  }

  return (
    <BaseNode
      model={model}
      style={selected ? cardSelectedStyle(STEP, glyphColor) : STEP}
      headerStyle={STEP_HEADER}
      labelStyle={LABEL}
      ports={handles}
      title={data.label}
    />
  );
}

export const StepNode = memo(StepNodeImpl);

const STEP: React.CSSProperties = {
  width: "100%",
  height: "100%",
  boxSizing: "border-box",
  border: "1px solid #242B37",
  borderRadius: 5,
  background: "#161C25",
  fontFamily: MONO,
};
const STEP_HEADER: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 5,
  width: "100%",
  height: "100%",
  boxSizing: "border-box",
  padding: "0 8px 0 5px",
};
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
const TITLE_BAR: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 5,
  height: 22,
  padding: "0 8px 0 5px",
  borderBottom: "1px solid #202632",
  background: "rgba(22,28,37,0.9)",
};
const LABEL: React.CSSProperties = {
  minWidth: 0,
  fontSize: 10.5,
  color: "#9AA4B2",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};
const FRAME_LABEL: React.CSSProperties = { ...LABEL, fontWeight: 700, color: "#C8D3E0" };
