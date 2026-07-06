/**
 * The Service-composition scorecard: one composition unit (class/interface/object/module) as a
 * SOLID health card, styled after the dark Unreal-Blueprints palette. A left accent bar coloured by
 * distance-from-the-main-sequence gives an at-a-glance health read; the body carries the kind, the
 * coupling/cohesion metrics, and a wrapping row of design-smell chips. A green ring marks the
 * selected unit — read from the store, mirroring how logic nodes show their selection.
 */

import { memo } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { useBlueprint } from "../../../state/StoreContext";
import { colorForDistance, type CompNodeData } from "../../../derive/compositionGraph";
import type { CompRfNode } from "../../../layout/compositionElk";
import { accentForKind } from "../../../theme/kindColors";
import { coverageAccent } from "../../../theme/coverageColors";
import { SmellChip } from "../../composition/SmellChip";
import { CompositionMembers } from "../../composition/CompositionMembers";
import { CoverageBadge } from "../../CoverageBadge";
import { ClusterFrameNode } from "./ClusterFrameNode";

const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";
// The green shared with the emphasized coupling wires so the node ring and the edge glow read as
// one highlight (mirrors logic's SELECT_ACCENT).
export const COMP_SELECT_ACCENT = "#6BE38A";

function CompositionNodeImpl({ data }: NodeProps<CompRfNode>) {
  const compSelectedId = useBlueprint((state) => state.compSelectedId);
  const showMetrics = useBlueprint((state) => state.showSolidMetrics);
  const coverage = useBlueprint((state) => (state.coverageMode ? state.coverage : null));
  const d = data as CompNodeData;
  const metrics = d.metrics;
  // A boundary (1-hop neighbour of the root) is a faded, click-to-re-root ghost — never the selected
  // unit, so it never wears the green selection ring.
  const boundary = d.boundary === true;
  const selected = compSelectedId === d.unitId && !boundary;
  // Coverage mode repaints the health rail by test-coverage verdict (green/amber/red/violet), so the
  // same scorecards tell the coverage story; otherwise the rail keeps its distance-from-main-sequence hue.
  const health = coverage ? coverageAccent(d.unitId, coverage) : colorForDistance(metrics.distance);
  const tint = accentForKind(d.kind);
  return (
    <div style={boundary ? CARD_BOUNDARY : selected ? CARD_SELECTED : CARD}>
      <Handle type="target" position={Position.Left} style={PIN} isConnectable={false} />
      <Handle type="source" position={Position.Right} style={PIN} isConnectable={false} />
      {/* The health rail stays crisp on a boundary card so the neighbour's health still reads. */}
      <div style={{ ...ACCENT_BAR, background: health }} />
      <div style={boundary ? INNER_BOUNDARY : INNER}>
        <div style={HEADER}>
          <span style={{ ...GLYPH, color: tint }}>{glyphForKind(d.kind)}</span>
          <span style={LABEL} title={d.label}>{d.label}</span>
          {boundary ? (
            <span style={BOUNDARY_TAG} title="Click to root the composition here">▸ ROOT</span>
          ) : null}
          {coverage ? <CoverageBadge nodeId={d.unitId} /> : null}
          <span style={{ ...KIND_TAG, color: tint, borderColor: tint }}>{d.kind.toUpperCase()}</span>
        </div>
        {showMetrics ? (
          <>
            <div style={METRIC_ROW}>
              <span style={METRIC_MUTED}>members</span>
              <span style={METRIC_VALUE}>{metrics.members}</span>
              <span style={SEP}>·</span>
              <span style={METRIC_MUTED}>cohesion</span>
              <span style={METRIC_VALUE}>{metrics.cohesion}</span>
            </div>
            <div style={METRIC_ROW}>
              <MetricPair label="Ce" value={metrics.ce} title="efferent coupling" />
              <span style={SEP}>·</span>
              <MetricPair label="Ca" value={metrics.ca} title="afferent coupling" />
              <span style={SEP}>·</span>
              <MetricPair label="I" value={metrics.instability} title="instability" />
              <span style={SEP}>·</span>
              <MetricPair label="A" value={metrics.abstractness} title="abstractness" />
            </div>
          </>
        ) : null}
        <div style={{ ...DISTANCE_ROW, color: health }} title="distance from the main sequence">
          <span style={DISTANCE_LABEL}>D</span>
          <span style={DISTANCE_VALUE}>{metrics.distance}</span>
        </div>
        {/* The unit's methods — the composition→logic link. A boundary ghost is context only, so it
            skips the list (matching its faded, non-selectable treatment). */}
        {!boundary && d.members.length > 0 ? <CompositionMembers members={d.members} /> : null}
        {showMetrics && metrics.smells.length > 0 ? (
          <div style={CHIP_ROW}>
            {metrics.smells.map((smell) => (
              <SmellChip key={smell} smell={smell} />
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** One `label value` metric cell — a small muted label over its mono value. */
function MetricPair(props: { label: string; value: number; title: string }) {
  return (
    <span style={PAIR} title={props.title}>
      <span style={METRIC_MUTED}>{props.label}</span>
      <span style={METRIC_VALUE}>{props.value}</span>
    </span>
  );
}

// A compact kind glyph so a card reads as class/module/interface/object before the tag is scanned.
const KIND_GLYPH: Record<string, string> = {
  module: "▤",
  class: "◆",
  interface: "◇",
  object: "❑",
};
function glyphForKind(kind: string): string {
  return KIND_GLYPH[kind] ?? "▪";
}

export const CompositionNode = memo(CompositionNodeImpl);
export const compNodeTypes = { unit: CompositionNode, cluster: ClusterFrameNode };

const PIN: React.CSSProperties = { width: 7, height: 7, background: "#C8D3E0", border: "none", minWidth: 0, minHeight: 0 };

const CARD: React.CSSProperties = {
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
// The selection ring is an outset box-shadow, so overflow:hidden on the card never clips it.
const CARD_SELECTED: React.CSSProperties = {
  ...CARD,
  borderColor: COMP_SELECT_ACCENT,
  boxShadow: `0 0 0 2px ${COMP_SELECT_ACCENT}`,
};
// A boundary neighbour reads as a ghost: dashed border + darker fill say "context, not part of the
// root"; its body dims (below) while the accent rail stays lit. Clicking it re-roots there.
const CARD_BOUNDARY: React.CSSProperties = {
  ...CARD,
  borderStyle: "dashed",
  borderColor: "#39414D",
  background: "#0F141B",
};
// The 4px left rail, coloured by health — the card's fastest visual signal.
const ACCENT_BAR: React.CSSProperties = { position: "absolute", left: 0, top: 0, bottom: 0, width: 4 };
const INNER: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 5,
  padding: "9px 11px 9px 13px",
};
// A boundary card's body recedes; the "▸ ROOT" affordance below is bright enough to stay legible.
const INNER_BOUNDARY: React.CSSProperties = { ...INNER, opacity: 0.6 };
const HEADER: React.CSSProperties = { display: "flex", alignItems: "center", gap: 6 };
// The re-root affordance on a boundary card — a blue pill mirroring the palette's structural accent.
const BOUNDARY_TAG: React.CSSProperties = {
  flexShrink: 0,
  fontSize: 8,
  fontWeight: 700,
  letterSpacing: "0.06em",
  color: "#8FB6E3",
  border: "1px solid #2F4A66",
  background: "rgba(59,122,192,0.16)",
  borderRadius: 3,
  padding: "1px 4px",
};
const GLYPH: React.CSSProperties = { fontSize: 12, flexShrink: 0 };
const LABEL: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  fontSize: 13,
  fontWeight: 700,
  color: "#E6EDF3",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};
const KIND_TAG: React.CSSProperties = {
  flexShrink: 0,
  fontSize: 8,
  fontWeight: 700,
  letterSpacing: "0.06em",
  border: "1px solid",
  borderRadius: 3,
  padding: "1px 4px",
};
const METRIC_ROW: React.CSSProperties = { display: "flex", alignItems: "center", gap: 5, fontSize: 10.5, color: "#9AA4B2" };
const PAIR: React.CSSProperties = { display: "inline-flex", alignItems: "baseline", gap: 3 };
const METRIC_MUTED: React.CSSProperties = { color: "#6C7683" };
const METRIC_VALUE: React.CSSProperties = { color: "#C8D3E0", fontWeight: 600 };
const SEP: React.CSSProperties = { color: "#3A414C" };
const DISTANCE_ROW: React.CSSProperties = { display: "flex", alignItems: "baseline", gap: 5, fontWeight: 700 };
const DISTANCE_LABEL: React.CSSProperties = { fontSize: 11, letterSpacing: "0.04em" };
const DISTANCE_VALUE: React.CSSProperties = { fontSize: 15 };
const CHIP_ROW: React.CSSProperties = { display: "flex", flexWrap: "wrap", gap: 4, marginTop: 1 };
