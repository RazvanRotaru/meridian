/**
 * PR-review file card. A store-free node for the standalone PR <ReactFlow> — it renders ONLY from its
 * `data` prop (no StoreContext, no useNodeDiff), so it works without the primary index. It reads the
 * same `ModuleCardData` fields the Module-map card emits (`label`, `fullPath`) plus the review-only
 * `prChanged` flag the PR minimal-graph derive stamps on changed/seed nodes.
 */

import { memo } from "react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";

const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";

/** `type` (not interface) so it carries @xyflow/react's implicit index signature on Node<T>. */
export type PrModuleData = {
  label?: string;
  fullPath?: string;
  prChanged?: boolean;
};

type PrModuleRfNode = Node<PrModuleData, "file">;

function PrModuleNodeImpl({ data }: NodeProps<PrModuleRfNode>) {
  const label = data.label ?? data.fullPath ?? "file";
  return (
    <div style={CARD}>
      <Handle type="target" position={Position.Left} style={PIN} isConnectable={false} />
      <Handle type="source" position={Position.Right} style={PIN} isConnectable={false} />
      <div style={HEADER}>
        <span style={LABEL} title={data.fullPath}>{label}</span>
        {data.prChanged ? <span style={BADGE}>changed</span> : null}
      </div>
      {data.fullPath ? <span style={PATH} title={data.fullPath}>{data.fullPath}</span> : null}
    </div>
  );
}

export const PrModuleNode = memo(PrModuleNodeImpl);

const CARD: React.CSSProperties = {
  position: "relative",
  width: "100%",
  height: "100%",
  boxSizing: "border-box",
  display: "flex",
  flexDirection: "column",
  justifyContent: "center",
  gap: 4,
  padding: "0 12px",
  border: "1px solid #232935",
  borderRadius: 8,
  background: "#12171E",
  overflow: "hidden",
  fontFamily: MONO,
};
const HEADER: React.CSSProperties = { display: "flex", alignItems: "center", gap: 6 };
const LABEL: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  fontSize: 12.5,
  fontWeight: 700,
  color: "#E6EDF3",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};
const BADGE: React.CSSProperties = {
  flexShrink: 0,
  fontSize: 8,
  fontWeight: 700,
  letterSpacing: "0.06em",
  textTransform: "uppercase",
  color: "#F5A623",
  border: "1px solid #6E5320",
  background: "rgba(245,166,35,0.16)",
  borderRadius: 3,
  padding: "1px 4px",
};
const PATH: React.CSSProperties = {
  fontSize: 10,
  color: "#6C7683",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};
const PIN: React.CSSProperties = { width: 5, height: 5, background: "#5A6472", border: "none", minWidth: 0, minHeight: 0 };
