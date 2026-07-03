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
  const isEntry = useBlueprint((state) => state.flowRootId === props.id);
  const callable = isCallable(node.kind);
  return (
    <div style={cardStyle(accent, selected, isEntry)}>
      <Handle type="target" position={Position.Left} id="in" style={pinStyle(callable)} />
      <NodeHeader node={node} accent={accent} entry={isEntry}>
        <TelemetryBadges metrics={metrics} />
      </NodeHeader>
      <div style={BODY_STYLE}>
        {node.summary ? <div style={SUMMARY_STYLE}>{ellipsize(node.summary, 96)}</div> : null}
        {callable && node.signature ? <code style={SIGNATURE_STYLE}>{node.signature}</code> : null}
      </div>
      <Handle type="source" position={Position.Right} id="out" style={pinStyle(callable)} />
    </div>
  );
}

function cardStyle(accent: string, selected: boolean, isEntry: boolean): React.CSSProperties {
  return {
    width: "100%",
    height: "100%",
    boxSizing: "border-box",
    borderRadius: 10,
    border: isEntry ? "2px solid #56C271" : `1px solid ${selected ? accent : "#2A2F37"}`,
    background: "#161A21",
    boxShadow: isEntry
      ? "0 0 0 3px rgba(86,194,113,0.30)"
      : selected
        ? `0 0 0 1px ${accent}66`
        : "0 1px 2px rgba(0,0,0,0.4)",
    overflow: "hidden",
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

const BODY_STYLE: React.CSSProperties = { padding: "6px 12px 10px" };
const SUMMARY_STYLE: React.CSSProperties = { fontSize: 11, color: "#9AA4B2", lineHeight: "15px" };
const SIGNATURE_STYLE: React.CSSProperties = {
  display: "block",
  marginTop: 6,
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  fontSize: 11,
  color: "#C9D3E0",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};
