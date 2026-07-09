/**
 * The minimal-graph overlay's directional [+n] expander. A tiny pill tethered to a file card: the
 * "in" stub sits left (hidden importers), the "out" stub right (hidden imports), n = the exact hidden
 * count. Clicking it (handled by the overlay's onNodeClick) reveals those neighbours as ghosts.
 * Pure props → visuals; it carries the source id + direction the overlay's handler reads.
 */

import { memo } from "react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import type { MinimalStubData } from "../../../derive/minimalSubgraph";

const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";

type MinimalStubRfNode = Node<MinimalStubData, "minimalStub">;

function MinimalStubNodeImpl({ data }: NodeProps<MinimalStubRfNode>) {
  const title = data.direction === "in" ? `${data.count} more importer(s) — click to reveal` : `${data.count} more import(s) — click to reveal`;
  return (
    <div style={STUB} title={title} aria-label={title}>
      <Handle type="target" position={Position.Left} style={PIN} isConnectable={false} />
      <Handle type="source" position={Position.Right} style={PIN} isConnectable={false} />
      <span style={PLUS}>+{data.count}</span>
    </div>
  );
}

export const MinimalStubNode = memo(MinimalStubNodeImpl);

const STUB: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  width: "100%",
  height: "100%",
  boxSizing: "border-box",
  border: "1px dashed #3A4452",
  borderRadius: 6,
  background: "rgba(59,66,76,0.35)",
  color: "#9AA4B2",
  fontFamily: MONO,
  fontSize: 12,
  fontWeight: 700,
  cursor: "pointer",
};
const PLUS: React.CSSProperties = { pointerEvents: "none" };
const PIN: React.CSSProperties = { width: 5, height: 5, background: "#5A6472", border: "none", minWidth: 0, minHeight: 0 };
