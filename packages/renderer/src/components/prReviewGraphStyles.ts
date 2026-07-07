/**
 * The PR-review graph pane's paint passes + styles, split out of `PrReviewGraph` to keep the
 * component small. `paintReviewNodes`/`paintReviewEdges` are PURE repaints over the laid-out graph
 * (positions never move): a selected or hovered flow's touched modules get a green outline+glow, and
 * a SELECTION additionally dims everything else so the flow's neighbourhood pops. Mirrors the
 * Module-map's `emphasize` step, but keyed on a flow's `touchedModuleIds` rather than import reach.
 */

import type { Edge, Node } from "@xyflow/react";
import { REVIEW_COLORS } from "../theme/reviewColors";
import { arrowMarker } from "../theme/edgeColors";
import { REVIEW_GROUP_NODE, type ReviewFileNodeData } from "../layout/minimalSubgraphLayout";
import { CATEGORY_COLOR } from "./nodes/modulemap/ModuleCardNode";
import type { RankedReviewFlow } from "../derive/reviewFlows";

const DIM_OPACITY = 0.35;
const OUTLINE_SHADOW = `0 0 0 2px ${REVIEW_COLORS.selection}, 0 0 16px ${REVIEW_COLORS.selectionGlow}`;

/** A flow's highlighted module (file) node ids as a lookup set; empty when the flow is absent. */
export function touchedIdSet(flow: RankedReviewFlow | undefined): Set<string> {
  return new Set(flow?.touchedModuleIds ?? []);
}

/**
 * Outline the selected + hovered flows' touched nodes; when a flow is SELECTED, dim every other node
 * so the neighbourhood reads first. A hover alone outlines without dimming (no dimming, no camera).
 */
export function paintReviewNodes(nodes: Node[], selectedIds: ReadonlySet<string>, hoverIds: ReadonlySet<string>): Node[] {
  const dim = selectedIds.size > 0;
  return nodes.map((node) => {
    if (selectedIds.has(node.id) || hoverIds.has(node.id)) {
      return { ...node, style: { ...node.style, opacity: 1, boxShadow: OUTLINE_SHADOW, borderRadius: 8 } };
    }
    if (dim) {
      return { ...node, style: { ...node.style, opacity: DIM_OPACITY } };
    }
    return node;
  });
}

/** Emphasise wires whose BOTH endpoints sit in a highlighted flow; dim the rest under a selection. */
export function paintReviewEdges(edges: Edge[], selectedIds: ReadonlySet<string>, hoverIds: ReadonlySet<string>): Edge[] {
  const dim = selectedIds.size > 0;
  return edges.map((edge) => {
    if (bothIn(selectedIds, edge) || bothIn(hoverIds, edge)) {
      return {
        ...edge,
        animated: true,
        markerEnd: arrowMarker(REVIEW_COLORS.edgeEmphasis, 14),
        style: { ...edge.style, stroke: REVIEW_COLORS.edgeEmphasis, strokeWidth: 2, opacity: 0.95, strokeDasharray: undefined },
      };
    }
    if (dim) {
      return { ...edge, style: { ...edge.style, opacity: DIM_OPACITY } };
    }
    return edge;
  });
}

function bothIn(ids: ReadonlySet<string>, edge: Edge): boolean {
  return ids.has(edge.source) && ids.has(edge.target);
}

/** MiniMap tint: package frames blue, boundary files muted, else the file's category hue. */
export function reviewMiniMapColor(node: Node): string {
  if (node.type === REVIEW_GROUP_NODE) {
    return "#5B9BE3";
  }
  const data = node.data as ReviewFileNodeData;
  return data.isBoundary ? REVIEW_COLORS.boundaryBorder : CATEGORY_COLOR[data.category];
}

export const SURFACE_STYLE: React.CSSProperties = { position: "relative", width: "100%", height: "100%", background: "#0E1116" };

export const PANEL_STYLE: React.CSSProperties = {
  position: "absolute",
  top: 16,
  left: 16,
  zIndex: 5,
  display: "flex",
  flexDirection: "column",
  gap: 10,
  border: "1px solid #2A2F37",
  borderRadius: 8,
  background: "rgba(18,23,30,0.92)",
  padding: "10px 12px",
};

const TOGGLE_STYLE: React.CSSProperties = {
  background: "transparent",
  border: "1px solid #2A2F37",
  borderRadius: 6,
  padding: "4px 10px",
  cursor: "pointer",
  font: "inherit",
  fontSize: 12,
  fontWeight: 600,
  color: "#9AA4B2",
};
const TOGGLE_ACTIVE_STYLE: React.CSSProperties = {
  borderColor: REVIEW_COLORS.changed,
  background: REVIEW_COLORS.changedBg,
  color: "#E6EDF3",
};

/** Merge the mode-toggle base with its active (aria-pressed) accent. */
export function toggleStyle(active: boolean): React.CSSProperties {
  return active ? { ...TOGGLE_STYLE, ...TOGGLE_ACTIVE_STYLE } : TOGGLE_STYLE;
}

export const LEGEND_STYLE: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 5 };
export const LEGEND_ROW_STYLE: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 7,
  fontSize: 11,
  color: "#7B8695",
};
/** A solid legend swatch in the given change-status color. */
export function swatchStyle(color: string): React.CSSProperties {
  return { width: 11, height: 11, borderRadius: 2, background: color, flexShrink: 0 };
}
export const SWATCH_BOUNDARY_STYLE: React.CSSProperties = {
  width: 11,
  height: 11,
  borderRadius: 2,
  background: REVIEW_COLORS.boundaryFill,
  border: `1px dashed ${REVIEW_COLORS.boundaryBorder}`,
  boxSizing: "border-box",
  flexShrink: 0,
};
/** The footnote under the legend: removed files have no node — they live in the side list. */
export const LEGEND_NOTE_STYLE: React.CSSProperties = {
  maxWidth: 150,
  fontSize: 10,
  lineHeight: 1.4,
  color: "#6C7683",
};
