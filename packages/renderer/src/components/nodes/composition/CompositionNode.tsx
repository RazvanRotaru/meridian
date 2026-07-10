/**
 * The Service-composition scorecard: one composition unit (class/interface/object/module) as a
 * SOLID health card, styled after the dark Unreal-Blueprints palette. A left accent bar coloured by
 * distance-from-the-main-sequence gives an at-a-glance health read; the body carries the kind, the
 * coupling/cohesion metrics, and a wrapping row of design-smell chips. A green ring marks the
 * selected unit — read from the store, mirroring how logic nodes show their selection.
 */

import { memo } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { useBlueprint, useBlueprintActions } from "../../../state/StoreContext";
import { colorForDistance, type ChannelCompData, type CompNodeData } from "../../../derive/compositionGraph";
import type { PackageSummaryData } from "../../../derive/compositionAggregate";
import type { CompRfNode } from "../../../layout/compositionElk";
import { accentForKind } from "../../../theme/kindColors";
import { coverageAccent } from "../../../theme/coverageColors";
import { SmellChip } from "../../composition/SmellChip";
import { CompositionMembers } from "../../composition/CompositionMembers";
import { CoverageBadge } from "../../CoverageBadge";
import { changedColor } from "../../ChangedBadge";
import { ClusterFrameNode } from "./ClusterFrameNode";
import { useChangeSummary } from "../../useChangedLines";

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
  const changedStatus = useBlueprint((state) => state.index.changedStatus.get(d.unitId));
  const changed = changedStatus !== undefined;
  const changedDescendants = useBlueprint((state) => state.index.changedDescendants.get(d.unitId) ?? 0);
  // A composition unit should expose diff navigation when either it OR anything inside it changed.
  const hasDiff = changed || changedDescendants > 0;
  // Green added / gold modified / red deleted; a contains-changes-only card falls back to gold.
  const changedRing = changedColor(changedStatus);
  const unitNode = useBlueprint((state) => (hasDiff ? state.index.nodesById.get(d.unitId) : undefined));
  const changeSummary = useChangeSummary(unitNode);
  const { showCode, expandCode } = useBlueprintActions();
  // The Δ chip is the diff's entry point: straight to the source modal, whose gutter marks the
  // changed lines. stopPropagation keeps the click from also selecting/re-rooting the card.
  const openDiff = (event: React.MouseEvent) => {
    event.stopPropagation();
    if (unitNode) {
      void showCode(unitNode);
      expandCode();
    }
  };
  // Coverage mode repaints the health rail by test-coverage verdict (green/amber/red/violet), so the
  // same scorecards tell the coverage story; otherwise the rail keeps its distance-from-main-sequence hue.
  const health = coverage ? coverageAccent(d.unitId, coverage) : colorForDistance(metrics.distance);
  const tint = accentForKind(d.kind);
  return (
    <div style={boundary ? CARD_BOUNDARY : selected ? CARD_SELECTED : hasDiff ? changedCard(changedRing) : CARD}>
      <Handle type="target" position={Position.Left} style={PIN} isConnectable={false} />
      <Handle type="source" position={Position.Right} style={PIN} isConnectable={false} />
      {/* The health rail stays crisp on a boundary card so the neighbour's health still reads. */}
      <div style={{ ...ACCENT_BAR, background: health }} />
      <div style={boundary ? INNER_BOUNDARY : INNER}>
        <div style={HEADER}>
          <span style={LABEL} title={d.label}>{d.label}</span>
          {boundary ? (
            <span style={BOUNDARY_TAG} title="Click to root the composition here">▸ ROOT</span>
          ) : null}
          {coverage ? <CoverageBadge nodeId={d.unitId} /> : null}
          {hasDiff ? (
            <button
              type="button"
              style={{ ...CHANGED_TAG, color: changedRing, border: `1px solid ${changedRing}66`, background: `${changedRing}1A` }}
              title={changed ? "Changed in this diff — click to see the changed lines" : "Contains changed code — click to see the changed lines"}
              onClick={openDiff}
            >
              {changeSummary ? `+${changeSummary.added} -${changeSummary.deleted}` : "diff"}
            </button>
          ) : null}
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

/**
 * An IPC channel card: the wire two processes meet on — magenta and pill-shaped so it never reads as
 * a code unit. Carries the channel key, its protocol tag, and (when a whole side is missing) an
 * honest dangling warning. The selection ring works like a unit's, so clicking one lights its wires.
 */
function ChannelCompNodeImpl({ data }: NodeProps<CompRfNode>) {
  const compSelectedId = useBlueprint((state) => state.compSelectedId);
  const d = data as ChannelCompData;
  const selected = compSelectedId === d.channelId;
  return (
    <div style={selected ? CHANNEL_CARD_SELECTED : CHANNEL_CARD} title={danglingTitle(d)}>
      <Handle type="target" position={Position.Left} style={PIN} isConnectable={false} />
      <Handle type="source" position={Position.Right} style={PIN} isConnectable={false} />
      <span style={CHANNEL_GLYPH}>⇄</span>
      <span style={CHANNEL_LABEL} title={d.label}>{d.label}</span>
      {d.dangling ? <span style={CHANNEL_WARN}>{d.dangling === "out-only" ? "⚠ no handler" : "⚠ no sender"}</span> : null}
      <span style={CHANNEL_TAG}>{d.protocol.toUpperCase()}</span>
    </div>
  );
}

function danglingTitle(d: ChannelCompData): string {
  if (d.dangling === "out-only") {
    return `${d.label} — someone sends on this channel and nobody in the graph handles it`;
  }
  if (d.dangling === "in-only") {
    return `${d.label} — a handler listens on this channel and nobody in the graph sends to it`;
  }
  return `${d.protocol} channel — an IPC boundary joined by its channel key`;
}

/**
 * A PACKAGE summary card — the aggregated whole-system unit. Rolls a package's units into one card:
 * a health rail by worst distance, the unit/member counts, and a smell tally. Double-click roots the
 * view into it (handled by the view); the ▸ button instead expands it INLINE — the card becomes a
 * frame holding the next level while the rest of the overview stays put.
 */
function PackageSummaryNodeImpl({ data }: NodeProps<CompRfNode>) {
  const compSelectedId = useBlueprint((state) => state.compSelectedId);
  const { toggleCompExpand } = useBlueprintActions();
  const d = data as PackageSummaryData;
  const selected = compSelectedId === d.packageId;
  const health = colorForDistance(d.worstDistance);
  return (
    <div style={selected ? CARD_SELECTED : CARD} title={`${d.label} — ▸ opens the next level inline; double-click roots the view here`}>
      <Handle type="target" position={Position.Left} style={PIN} isConnectable={false} />
      <Handle type="source" position={Position.Right} style={PIN} isConnectable={false} />
      <div style={{ ...ACCENT_BAR, background: health }} />
      <div style={INNER}>
        <div style={HEADER}>
          <span style={LABEL} title={d.label}>{d.label}</span>
          <button
            type="button"
            style={EXPAND_BTN}
            title="Open this package inline — its sub-packages and units appear in a frame here"
            onClick={(event) => {
              event.stopPropagation();
              toggleCompExpand(d.packageId);
            }}
            onDoubleClick={(event) => event.stopPropagation()}
          >
            ▸
          </button>
          <span style={{ ...KIND_TAG, color: "#A77BF3", borderColor: "#A77BF3" }}>PACKAGE</span>
        </div>
        <div style={METRIC_ROW}>
          <span style={METRIC_VALUE}>{d.unitCount}</span><span style={METRIC_MUTED}>units</span>
          <span style={SEP}>·</span>
          <span style={METRIC_VALUE}>{d.memberCount}</span><span style={METRIC_MUTED}>members</span>
          {d.smellyCount > 0 ? (<><span style={SEP}>·</span><span style={{ ...METRIC_VALUE, color: "#E5484D" }}>{d.smellyCount}</span><span style={METRIC_MUTED}>smelly</span></>) : null}
        </div>
        <div style={{ ...DISTANCE_ROW, color: health }} title="worst distance from the main sequence in this package">
          <span style={DISTANCE_LABEL}>worst D</span><span style={DISTANCE_VALUE}>{d.worstDistance}</span>
        </div>
      </div>
    </div>
  );
}

export const CompositionNode = memo(CompositionNodeImpl);
export const ChannelCompNode = memo(ChannelCompNodeImpl);
export const PackageSummaryNode = memo(PackageSummaryNodeImpl);
export const compNodeTypes = { unit: CompositionNode, cluster: ClusterFrameNode, channel: ChannelCompNode, package: PackageSummaryNode };

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
// A changed card keeps the status ring (green/gold/red) subtler than selection so the two never compete.
function changedCard(color: string): React.CSSProperties {
  return { ...CARD, borderColor: color, boxShadow: `0 0 0 1px ${color}44` };
}
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
// The inline-expand affordance on a package card — a blue pill sharing BOUNDARY_TAG's palette so
// every "this navigates" control reads alike.
const EXPAND_BTN: React.CSSProperties = {
  flexShrink: 0,
  fontSize: 10,
  fontWeight: 700,
  lineHeight: "14px",
  color: "#8FB6E3",
  border: "1px solid #2F4A66",
  background: "rgba(59,122,192,0.16)",
  borderRadius: 3,
  padding: "0 5px",
  cursor: "pointer",
  fontFamily: "inherit",
};
// The diff marker, sized like KIND_TAG so the header chips read as one row; its colour (green/gold/
// red) is applied inline by the caller. A button: clicking it opens the source modal with the diff.
const CHANGED_TAG: React.CSSProperties = {
  flexShrink: 0,
  fontSize: 8,
  fontWeight: 700,
  letterSpacing: "0.06em",
  fontFamily: "inherit",
  lineHeight: 1.4,
  borderRadius: 3,
  padding: "1px 4px",
  cursor: "pointer",
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

// The channel pill: gold like its wires, rounded so it never reads as a code-unit scorecard.
const IPC_ACCENT = "#E06CB0";
const CHANNEL_CARD: React.CSSProperties = {
  position: "relative",
  width: "100%",
  height: "100%",
  boxSizing: "border-box",
  display: "flex",
  alignItems: "center",
  gap: 7,
  padding: "0 12px",
  borderRadius: 999,
  border: `1px dashed ${IPC_ACCENT}`,
  background: "rgba(201,162,75,0.10)",
  fontFamily: MONO,
  overflow: "hidden",
};
const CHANNEL_CARD_SELECTED: React.CSSProperties = {
  ...CHANNEL_CARD,
  borderStyle: "solid",
  borderColor: COMP_SELECT_ACCENT,
  boxShadow: `0 0 0 2px ${COMP_SELECT_ACCENT}`,
};
const CHANNEL_GLYPH: React.CSSProperties = { fontSize: 12, color: IPC_ACCENT, flexShrink: 0 };
const CHANNEL_LABEL: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  fontSize: 12,
  fontWeight: 700,
  color: "#EAD9AE",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};
const CHANNEL_WARN: React.CSSProperties = {
  flexShrink: 0,
  fontSize: 9,
  fontWeight: 700,
  color: "#E5484D",
  border: "1px solid rgba(229,72,77,0.5)",
  borderRadius: 3,
  padding: "1px 4px",
  background: "rgba(229,72,77,0.12)",
};
const CHANNEL_TAG: React.CSSProperties = {
  flexShrink: 0,
  fontSize: 8,
  fontWeight: 700,
  letterSpacing: "0.06em",
  color: IPC_ACCENT,
  border: `1px solid ${IPC_ACCENT}66`,
  borderRadius: 3,
  padding: "1px 4px",
};
