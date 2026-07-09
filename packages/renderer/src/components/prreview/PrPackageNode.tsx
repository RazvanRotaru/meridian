/**
 * PR-review package/group container card. A store-free frame node for the standalone PR <ReactFlow>:
 * it renders ONLY from its `data` prop (the group label the minimal-subgraph derive emits). Purely a
 * labelled container — children nest inside it via React Flow `parentId`.
 */

import { memo } from "react";
import { type Node, type NodeProps } from "@xyflow/react";

const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";

/** `type` (not interface) so it carries @xyflow/react's implicit index signature on Node<T>. */
export type PrPackageData = {
  label?: string;
};

type PrPackageRfNode = Node<PrPackageData, "package">;

function PrPackageNodeImpl({ data }: NodeProps<PrPackageRfNode>) {
  return (
    <div style={FRAME}>
      <span style={TITLE} title={data.label}>{data.label ?? "package"}</span>
    </div>
  );
}

export const PrPackageNode = memo(PrPackageNodeImpl);

const FRAME: React.CSSProperties = {
  width: "100%",
  height: "100%",
  boxSizing: "border-box",
  border: "1px solid #2A313C",
  borderRadius: 10,
  background: "rgba(24,29,37,0.45)",
  fontFamily: MONO,
};
const TITLE: React.CSSProperties = {
  display: "block",
  padding: "6px 10px",
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: "0.04em",
  color: "#9AA4B2",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};
