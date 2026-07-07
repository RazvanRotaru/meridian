/**
 * A code block for the Map lens: one method inside a unit frame, or a file-level function/type
 * definition. The block is the DEPENDENCY ANCHOR — its wires say what this specific code uses —
 * and the unit of navigation: double-clicking a callable block opens its logic flow (the map→logic
 * link), which these nodes will later chart in place on this canvas. Kind glyph + name only; a
 * green ring marks selection, mirroring every other Map card.
 */

import { memo } from "react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { useBlueprint } from "../../../state/StoreContext";
import { accentForKind } from "../../../theme/kindColors";
import type { BlockData } from "../../../derive/moduleLevel";
import { MONO, PIN, SELECT_ACCENT } from "./frameChrome";

type BlockRfNode = Node<BlockData, "block">;

function BlockNodeImpl({ id, data }: NodeProps<BlockRfNode>) {
  const selected = useBlueprint((state) => state.moduleSelectedId) === id;
  const accent = accentForKind(data.blockKind);
  const title = data.callable ? `${data.label} — double-click to open its logic flow` : data.label;
  return (
    <div style={selected ? BLOCK_SELECTED : BLOCK} title={title}>
      <Handle type="target" position={Position.Left} style={PIN} isConnectable={false} />
      <Handle type="source" position={Position.Right} style={PIN} isConnectable={false} />
      <span style={{ ...GLYPH, color: accent }}>{data.callable ? "ƒ" : "τ"}</span>
      <span style={LABEL}>{data.label}</span>
    </div>
  );
}

export const BlockNode = memo(BlockNodeImpl);

const BLOCK: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  width: "100%",
  height: "100%",
  boxSizing: "border-box",
  padding: "0 9px",
  border: "1px solid #2A3140",
  borderRadius: 6,
  background: "#1B222D",
  fontFamily: MONO,
  cursor: "pointer",
};
const BLOCK_SELECTED: React.CSSProperties = { ...BLOCK, borderColor: SELECT_ACCENT, boxShadow: `0 0 0 2px ${SELECT_ACCENT}` };
const GLYPH: React.CSSProperties = { fontSize: 10, flexShrink: 0 };
const LABEL: React.CSSProperties = {
  minWidth: 0,
  fontSize: 11.5,
  color: "#C8D3E0",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};
