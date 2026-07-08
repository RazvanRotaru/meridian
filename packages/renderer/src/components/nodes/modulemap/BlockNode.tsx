/**
 * A code block for the Map lens: one method inside an expanded unit frame, or a file-level function/type
 * definition. The block is the DEPENDENCY ANCHOR — its wires say what this specific code uses —
 * and the unit of navigation: double-clicking a callable block opens its logic flow (the map→logic
 * link). A block WITH a charted flow also carries the chevron: expanding it charts the flow's steps
 * in place, the block becoming a small frame on this canvas (the POC for logic-flows-on-the-Map).
 * Kind glyph + name only; a green ring marks selection, mirroring every other Map card.
 */

import { memo } from "react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { useBlueprint } from "../../../state/StoreContext";
import { accentForKind } from "../../../theme/kindColors";
import type { BlockData } from "../../../derive/moduleLevel";
import { ExpandChevron, frameSelectedStyle, frameStyle, MONO, PIN, SELECT_ACCENT } from "./frameChrome";
import { borderFor, DeltaChip, useNodeDiff } from "./changed";

type BlockRfNode = Node<BlockData, "block">;

function BlockNodeImpl({ id, data }: NodeProps<BlockRfNode>) {
  const selected = useBlueprint((state) => state.moduleSelected.has(id));
  const diff = useNodeDiff(id);
  const accent = accentForKind(data.blockKind);
  const chevron = data.hasFlow ? <ExpandChevron id={id} isExpanded={data.isExpanded} collapsedTitle="Expand — chart this flow in place" /> : null;
  const title = data.callable ? `${data.label} — double-click to open its logic flow` : data.label;

  if (data.isExpanded) {
    return (
      <div style={borderFor(frameStyle(accent), frameSelectedStyle(accent), selected, diff)}>
        <Handle type="target" position={Position.Left} style={PIN} isConnectable={false} />
        <Handle type="source" position={Position.Right} style={PIN} isConnectable={false} />
        <div style={TITLE_BAR} title={title}>
          {chevron}
          <span style={{ ...GLYPH, color: accent }}>ƒ</span>
          <span style={FRAME_LABEL}>{data.label}</span>
          <DeltaChip diff={diff} />
        </div>
      </div>
    );
  }

  return (
    <div style={borderFor(BLOCK, BLOCK_SELECTED, selected, diff)} title={title}>
      <Handle type="target" position={Position.Left} style={PIN} isConnectable={false} />
      <Handle type="source" position={Position.Right} style={PIN} isConnectable={false} />
      {chevron}
      <span style={{ ...GLYPH, color: accent }}>{data.callable ? "ƒ" : "τ"}</span>
      <span style={LABEL}>{data.label}</span>
      <DeltaChip diff={diff} />
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
  padding: "0 9px 0 5px",
  border: "1px solid #2A3140",
  borderRadius: 6,
  background: "#1B222D",
  fontFamily: MONO,
  cursor: "pointer",
};
const BLOCK_SELECTED: React.CSSProperties = { ...BLOCK, borderColor: SELECT_ACCENT, boxShadow: `0 0 0 2px ${SELECT_ACCENT}` };
// A flow frame's title strip is slimmer than a unit frame's — it's the innermost nesting level.
const TITLE_BAR: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 5,
  height: 24,
  padding: "0 8px 0 5px",
  borderBottom: "1px solid #232935",
  background: "rgba(27,34,45,0.9)",
  fontFamily: MONO,
};
const GLYPH: React.CSSProperties = { fontSize: 10, flexShrink: 0 };
const LABEL: React.CSSProperties = {
  minWidth: 0,
  fontSize: 11.5,
  color: "#C8D3E0",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};
const FRAME_LABEL: React.CSSProperties = { ...LABEL, fontWeight: 700, color: "#E6EDF3" };
