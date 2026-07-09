/**
 * The three node types of the minimal PR-review graph: a `reviewFile` frame (one changed file), an
 * optional `reviewGroup` frame (a class/namespace holding changed members), and the `reviewBlock`
 * leaf — the actual affected CODE BLOCK (function/method). Frames are recessive (thin, muted) so the
 * blocks read as the content; a block carries the kind accent, a change dot, and a test chip.
 *
 * Blocks paint against the store's `reviewLitNodeIds` (hover coupling from the flow panel) and wear a
 * green ring when selected — mirroring how the module/composition/logic nodes show their highlight.
 */

import { memo } from "react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { accentForKind } from "../../../theme/kindColors";
import { useBlueprint } from "../../../state/StoreContext";
import type { ChangeStatus } from "@meridian/core";
import type { ReviewNodeData } from "../../../derive/reviewNodeGraph";

const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";
const SELECT_ACCENT = "#6BE38A";
const DIM_OPACITY = 0.28;

const STATUS_COLOR: Record<ChangeStatus, string> = {
  added: "#3FB950",
  modified: "#D29922",
  deleted: "#F85149",
  renamed: "#A371F7",
};
const STATUS_GLYPH: Record<ChangeStatus, string> = { added: "A", modified: "M", deleted: "D", renamed: "R" };

type ReviewNodeRf = Node<ReviewNodeData & { isContainer: boolean }, "reviewFile" | "reviewGroup" | "reviewBlock">;

/** A leaf code block — the affected function/method. Prominent; paints with the kind accent. */
function ReviewBlockNodeImpl({ id, data }: NodeProps<ReviewNodeRf>) {
  const lit = useBlueprint((state) => litness(state.reviewLitNodeIds, id));
  const selected = useBlueprint((state) => state.reviewSelectedId === id);
  const accent = accentForKind(data.nodeKind);
  return (
    <div style={{ ...(selected ? BLOCK_SELECTED : BLOCK), opacity: lit ? 1 : DIM_OPACITY }}>
      <Handle type="target" position={Position.Left} style={PIN} isConnectable={false} />
      <Handle type="source" position={Position.Right} style={PIN} isConnectable={false} />
      <div style={{ ...ACCENT_BAR, background: accent }} />
      <div style={BLOCK_INNER}>
        <div style={HEADER}>
          {data.status && <span style={statusDot(data.status)} title={data.status}>{STATUS_GLYPH[data.status]}</span>}
          <span style={LABEL} title={data.label}>{data.label}</span>
          {data.isTest && <span style={TEST_CHIP}>test</span>}
        </div>
        <span style={SUBLABEL} title={data.sublabel}>{data.sublabel}</span>
      </div>
    </div>
  );
}

/** A class/namespace frame: recessive, holds changed members, shows a "N changed" count. */
function ReviewGroupNodeImpl({ data }: NodeProps<ReviewNodeRf>) {
  return (
    <div style={GROUP_FRAME}>
      <Handle type="target" position={Position.Left} style={HIDDEN_PIN} isConnectable={false} />
      <Handle type="source" position={Position.Right} style={HIDDEN_PIN} isConnectable={false} />
      <div style={FRAME_TITLE}>
        <span style={{ ...FRAME_NAME, color: accentForKind(data.nodeKind) }} title={data.label}>{data.label}</span>
        <span style={COUNT_CHIP}>{data.changedCount} changed</span>
      </div>
    </div>
  );
}

/** A file frame: the outermost group; filename + change badge + count. */
function ReviewFileNodeImpl({ data }: NodeProps<ReviewNodeRf>) {
  return (
    <div style={FILE_FRAME}>
      <Handle type="target" position={Position.Left} style={HIDDEN_PIN} isConnectable={false} />
      <Handle type="source" position={Position.Right} style={HIDDEN_PIN} isConnectable={false} />
      <div style={FRAME_TITLE}>
        {data.status && <span style={statusDot(data.status)} title={data.status}>{STATUS_GLYPH[data.status]}</span>}
        <span style={FILE_NAME} title={`${data.sublabel}/${data.label}`}>{data.label}</span>
        <span style={COUNT_CHIP}>{data.changedCount}</span>
      </div>
    </div>
  );
}

/** null lit set == nothing hovered == everything at full strength. */
function litness(litIds: ReadonlySet<string> | null, id: string): boolean {
  return litIds === null || litIds.has(id);
}

export const ReviewBlockNode = memo(ReviewBlockNodeImpl);
export const ReviewGroupNode = memo(ReviewGroupNodeImpl);
export const ReviewFileNode = memo(ReviewFileNodeImpl);

export const reviewNodeTypes = {
  reviewFile: ReviewFileNode,
  reviewGroup: ReviewGroupNode,
  reviewBlock: ReviewBlockNode,
} as const;

const BLOCK: React.CSSProperties = {
  position: "relative",
  width: "100%",
  height: "100%",
  boxSizing: "border-box",
  borderRadius: 8,
  border: "1px solid #2A2F37",
  background: "#12161C",
  overflow: "hidden",
  transition: "opacity 120ms ease",
};
const BLOCK_SELECTED: React.CSSProperties = { ...BLOCK, borderColor: SELECT_ACCENT, boxShadow: `0 0 0 2px ${SELECT_ACCENT}` };
const ACCENT_BAR: React.CSSProperties = { position: "absolute", left: 0, top: 0, bottom: 0, width: 4 };
const BLOCK_INNER: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  justifyContent: "center",
  gap: 4,
  height: "100%",
  padding: "0 10px 0 12px",
};
const HEADER: React.CSSProperties = { display: "flex", alignItems: "center", gap: 6, minWidth: 0 };
const LABEL: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  fontSize: 12.5,
  fontWeight: 600,
  color: "#E6EDF3",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};
const SUBLABEL: React.CSSProperties = {
  fontFamily: MONO,
  fontSize: 10.5,
  color: "#7D8695",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};
const TEST_CHIP: React.CSSProperties = {
  fontSize: 9,
  fontWeight: 700,
  letterSpacing: 0.4,
  textTransform: "uppercase",
  color: "#8B7DF0",
  border: "1px solid #3A3357",
  borderRadius: 4,
  padding: "0 4px",
};
const COUNT_CHIP: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 600,
  color: "#9AA4B2",
  background: "#1B212A",
  borderRadius: 10,
  padding: "1px 7px",
};

function statusDot(status: ChangeStatus): React.CSSProperties {
  return {
    fontSize: 9.5,
    fontWeight: 800,
    color: "#0B0E13",
    background: STATUS_COLOR[status],
    borderRadius: 3,
    width: 14,
    height: 14,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  };
}

const FRAME_TITLE: React.CSSProperties = {
  position: "absolute",
  top: 0,
  left: 0,
  right: 0,
  height: 34,
  display: "flex",
  alignItems: "center",
  gap: 6,
  padding: "0 12px",
  boxSizing: "border-box",
};
const FILE_FRAME: React.CSSProperties = {
  position: "relative",
  width: "100%",
  height: "100%",
  boxSizing: "border-box",
  borderRadius: 10,
  border: "1px solid #232935",
  background: "rgba(22,27,34,0.35)",
};
const GROUP_FRAME: React.CSSProperties = {
  ...FILE_FRAME,
  border: "1px dashed #2C3340",
  background: "rgba(28,34,44,0.4)",
};
const FILE_NAME: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  fontFamily: MONO,
  fontSize: 12,
  fontWeight: 600,
  color: "#C9D3DF",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};
const FRAME_NAME: React.CSSProperties = { ...FILE_NAME, fontFamily: "inherit" };
const PIN: React.CSSProperties = { width: 6, height: 6, background: "#3A424E", border: "none" };
const HIDDEN_PIN: React.CSSProperties = { ...PIN, opacity: 0 };
