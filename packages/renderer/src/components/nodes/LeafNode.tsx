/**
 * A leaf node (no children): a function/method, or any childless declaration. Function and
 * method nodes reveal their monospace signature and typed input/output pins (the left/right
 * handles), so a reader sees what flows in and what flows out of the unit.
 */

import { Handle, Position, type NodeProps } from "@xyflow/react";
import { accentForKind } from "../../theme/kindColors";
import { ellipsize } from "../../theme/displayName";
import { isCallable } from "../../layout/nodeSize";
import { useBlueprint } from "../../state/StoreContext";
import type { BlueprintNode } from "../../layout/rfTypes";
import { NodeHeader } from "./NodeHeader";
import { TelemetryBadges } from "../TelemetryBadges";

export function LeafNode(props: NodeProps<BlueprintNode>) {
  const node = props.data.node;
  const accent = accentForKind(node.kind);
  const metrics = useBlueprint((state) => state.telemetry[props.id]);
  const selected = useBlueprint((state) => state.selectedId === props.id);
  // Dim when a path trace is active and this node is not on it.
  const dimmed = useBlueprint((state) => state.pathNodeIds.size > 0 && !state.pathNodeIds.has(props.id));
  const callable = isCallable(node.kind);
  return (
    <div style={{ ...cardStyle(accent, selected), ...dimStyle(dimmed) }}>
      <Handle type="target" position={Position.Left} id="in" style={pinStyle(callable)} />
      <NodeHeader node={node} accent={accent}>
        <TelemetryBadges metrics={metrics} />
      </NodeHeader>
      {node.summary || (callable && node.signature) ? (
        <div style={BODY_STYLE}>
          {node.summary ? <div style={SUMMARY_STYLE}>{ellipsize(node.summary, 96)}</div> : null}
          {callable && node.signature ? <code style={SIGNATURE_STYLE}>{node.signature}</code> : null}
        </div>
      ) : null}
      <Handle type="source" position={Position.Right} id="out" style={pinStyle(callable)} />
    </div>
  );
}

function cardStyle(accent: string, selected: boolean): React.CSSProperties {
  return {
    width: "100%",
    height: "100%",
    boxSizing: "border-box",
    borderRadius: 10,
    border: `1px solid ${selected ? accent : "#2A2F37"}`,
    background: "#161A21",
    boxShadow: selected ? `0 0 0 1px ${accent}66` : "0 1px 2px rgba(0,0,0,0.4)",
    overflow: "hidden",
  };
}

function dimStyle(dimmed: boolean): React.CSSProperties {
  return {
    opacity: dimmed ? 0.25 : 1,
    filter: dimmed ? "saturate(0.5)" : undefined,
    transition: "opacity 140ms, filter 140ms",
  };
}

// Callable pins are visible typed connectors; non-callable leaves keep them subtle.
function pinStyle(callable: boolean): React.CSSProperties {
  return {
    background: callable ? "#56C271" : "#3A414C",
    width: callable ? 9 : 7,
    height: callable ? 9 : 7,
    border: "none",
  };
}

const BODY_STYLE: React.CSSProperties = { padding: "5px 12px 7px" };
const SUMMARY_STYLE: React.CSSProperties = {
  fontSize: 11,
  color: "#9AA4B2",
  lineHeight: "15px",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};
const SIGNATURE_STYLE: React.CSSProperties = {
  display: "block",
  marginTop: 4,
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  fontSize: 11,
  color: "#C9D3E0",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};
