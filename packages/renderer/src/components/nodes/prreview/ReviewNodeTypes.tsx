/**
 * The PR-review graph's node components — the review-aware twins of the Module-map cards. A
 * `reviewFile` card reuses the file-card look (category accent bar, label, category chip, in/out
 * import counts) but drops the Module-map's store-driven selection ring: emphasis (outline/glow/dim)
 * is painted onto `node.style` by `PrReviewGraph`, so these stay pure props → visuals. A boundary
 * neighbour (the faded 1-hop context / blast-radius node) renders dimmed with a dashed border and a
 * "ctx" tag. A `reviewGroup` is a containment FRAME (an ELK container): a titled box the file cards
 * sit inside; a collapsed package chain shows its joined `collapsedLabel`.
 */

import { memo } from "react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import {
  REVIEW_FILE_NODE,
  REVIEW_GROUP_NODE,
  type ReviewFileNodeData,
  type ReviewGroupNodeData,
} from "../../../layout/minimalSubgraphLayout";
import { changeStatusColor, REVIEW_COLORS } from "../../../theme/reviewColors";
import { CATEGORY_COLOR } from "../modulemap/ModuleCardNode";

const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";

type ReviewFileRfNode = Node<ReviewFileNodeData, typeof REVIEW_FILE_NODE>;
type ReviewGroupRfNode = Node<ReviewGroupNodeData, typeof REVIEW_GROUP_NODE>;

function ReviewFileNodeImpl({ data }: NodeProps<ReviewFileRfNode>) {
  // An AFFECTED card is tinted by HOW it changed (accent bar + border + status badge); a boundary
  // neighbour keeps the neutral faded/dashed context look. The category hue stays on the chip so both
  // signals — what kind of module, and how it changed — read at once. `status === null` ≡ boundary.
  const status = data.isBoundary ? null : changeStatusColor(data.changeStatus ?? "modified");
  const category = CATEGORY_COLOR[data.category];
  const accent = status ? status.stroke : REVIEW_COLORS.boundaryBorder;
  return (
    <div style={status ? { ...FILE_CARD, borderColor: status.stroke } : FILE_CARD_BOUNDARY}>
      <Handle type="target" position={Position.Left} style={PIN} isConnectable={false} />
      <Handle type="source" position={Position.Right} style={PIN} isConnectable={false} />
      <div style={{ ...ACCENT_BAR, background: accent }} />
      <div style={INNER}>
        <div style={HEADER}>
          <span style={status ? LABEL : LABEL_BOUNDARY} title={data.fullPath}>{data.label}</span>
          {status ? (
            <span style={{ ...STATUS_BADGE, color: status.stroke, borderColor: status.stroke, background: status.fill }}>
              {status.label}
            </span>
          ) : (
            <span style={CTX_BADGE} title="1-hop context / blast-radius neighbour">ctx</span>
          )}
        </div>
        <div style={META}>
          <span style={{ ...CHIP, color: category, borderColor: category }}>{data.category.toUpperCase()}</span>
          <span style={COUNTS} title={`${data.inCount} importer(s) · ${data.outCount} import(s)`}>
            <span style={COUNT_MUTED}>in</span>
            <span style={COUNT_VALUE}>{data.inCount}</span>
            <span style={COUNT_MUTED}>out</span>
            <span style={COUNT_VALUE}>{data.outCount}</span>
          </span>
        </div>
      </div>
    </div>
  );
}

function ReviewGroupNodeImpl({ data }: NodeProps<ReviewGroupRfNode>) {
  const title = data.collapsedLabel ?? data.label;
  return (
    <div style={FRAME}>
      <div style={FRAME_TITLE}>
        <span style={FRAME_LABEL} title={title}>{title}</span>
        {data.fileCount > 0 ? <span style={FRAME_COUNT}>{data.fileCount}</span> : null}
      </div>
    </div>
  );
}

const ReviewFileNode = memo(ReviewFileNodeImpl);
const ReviewGroupNode = memo(ReviewGroupNodeImpl);

/** The node-type registry the PR-review surface hands React Flow (a stable module-level reference). */
export const reviewNodeTypes = {
  [REVIEW_FILE_NODE]: ReviewFileNode,
  [REVIEW_GROUP_NODE]: ReviewGroupNode,
};

const PIN: React.CSSProperties = { width: 6, height: 6, background: "#C8D3E0", border: "none", minWidth: 0, minHeight: 0 };

const FILE_CARD: React.CSSProperties = {
  position: "relative",
  width: "100%",
  height: "100%",
  boxSizing: "border-box",
  border: "1px solid #232935",
  borderRadius: 8,
  background: "#12171E",
  overflow: "hidden",
  fontFamily: MONO,
};
const FILE_CARD_BOUNDARY: React.CSSProperties = {
  ...FILE_CARD,
  border: `1px dashed ${REVIEW_COLORS.boundaryBorder}`,
  background: REVIEW_COLORS.boundaryFill,
  opacity: 0.5,
};
const ACCENT_BAR: React.CSSProperties = { position: "absolute", left: 0, top: 0, bottom: 0, width: 4 };
const INNER: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  justifyContent: "center",
  gap: 6,
  height: "100%",
  padding: "0 10px 0 12px",
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
const LABEL_BOUNDARY: React.CSSProperties = { ...LABEL, fontWeight: 600, color: REVIEW_COLORS.boundaryText };
const CTX_BADGE: React.CSSProperties = {
  flexShrink: 0,
  fontSize: 8,
  fontWeight: 700,
  letterSpacing: "0.06em",
  color: REVIEW_COLORS.boundaryText,
  border: `1px dashed ${REVIEW_COLORS.boundaryBorder}`,
  borderRadius: 3,
  padding: "1px 4px",
};
const STATUS_BADGE: React.CSSProperties = {
  flexShrink: 0,
  fontSize: 8,
  fontWeight: 700,
  letterSpacing: "0.06em",
  border: "1px solid",
  borderRadius: 3,
  padding: "1px 4px",
};
const META: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8 };
const CHIP: React.CSSProperties = {
  flexShrink: 0,
  fontSize: 8,
  fontWeight: 700,
  letterSpacing: "0.06em",
  border: "1px solid",
  borderRadius: 3,
  padding: "1px 4px",
};
const COUNTS: React.CSSProperties = { display: "inline-flex", alignItems: "baseline", gap: 4, fontSize: 10.5 };
const COUNT_MUTED: React.CSSProperties = { color: "#6C7683" };
const COUNT_VALUE: React.CSSProperties = { color: "#C8D3E0", fontWeight: 600 };

const FRAME: React.CSSProperties = {
  position: "relative",
  width: "100%",
  height: "100%",
  boxSizing: "border-box",
  border: "1px solid #232935",
  borderRadius: 10,
  background: "rgba(91,155,227,0.04)",
  fontFamily: MONO,
};
const FRAME_TITLE: React.CSSProperties = {
  position: "absolute",
  top: 0,
  left: 0,
  right: 0,
  height: 30,
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "0 12px",
  borderBottom: "1px solid #1C222B",
};
const FRAME_LABEL: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  fontSize: 11.5,
  fontWeight: 700,
  letterSpacing: "0.02em",
  color: "#9AA4B2",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};
const FRAME_COUNT: React.CSSProperties = {
  flexShrink: 0,
  fontSize: 10,
  fontWeight: 600,
  color: "#6C7683",
  background: "rgba(122,134,146,0.14)",
  borderRadius: 3,
  padding: "1px 6px",
};
