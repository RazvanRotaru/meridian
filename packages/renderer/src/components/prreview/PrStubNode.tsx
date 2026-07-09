/**
 * PR-review directional [+n] ghost stub. A store-free, non-interactive node for the standalone PR
 * <ReactFlow>: it renders ONLY from its `data` prop (the hidden-neighbour count the minimal-subgraph
 * derive emits). It stands in for import neighbours the minimal PR graph doesn't show.
 */

import { memo } from "react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import type { MinimalStubData } from "../../derive/minimalSubgraph";

const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";

type PrStubRfNode = Node<MinimalStubData, "minimalStub">;

function PrStubNodeImpl({ data }: NodeProps<PrStubRfNode>) {
  const label = `+${data.count}`;
  return (
    <div style={STUB} aria-label={`${data.count} hidden neighbour(s)`}>
      <Handle type="target" position={Position.Left} style={PIN} isConnectable={false} />
      <Handle type="source" position={Position.Right} style={PIN} isConnectable={false} />
      <span style={PLUS}>{label}</span>
    </div>
  );
}

export const PrStubNode = memo(PrStubNodeImpl);

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
};
const PLUS: React.CSSProperties = { pointerEvents: "none" };
const PIN: React.CSSProperties = { width: 5, height: 5, background: "#5A6472", border: "none", minWidth: 0, minHeight: 0 };
