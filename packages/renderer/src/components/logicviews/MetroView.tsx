/**
 * The Metro projection: the flow's exec thread drawn as a transit map. Thin — all geometry is the
 * pure `layoutMetro` spec; this only paints it. One <svg> holds the polylines + station marks; HTML
 * label divs float above so text stays crisp. Selection is by target (every call site of the picked
 * callee haloes), a click selects, a double-click drills into an expandable callee.
 */

import type { CSSProperties } from "react";
import { useMemo } from "react";
import type { FlowViewProps } from "../../derive/flowViewModel";
import { FLOW_COLORS } from "../../derive/flowViewModel";
import { layoutMetro } from "../../derive/metroLayout";
import type { MetroStation } from "../../derive/metroSpec";

const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";

export function MetroView(props: FlowViewProps) {
  const rootName = props.index.nodesById.get(props.rootId)?.displayName ?? "flow";
  const spec = useMemo(
    () => layoutMetro(props.steps, props.flows, props.index, rootName),
    [props.steps, props.flows, props.index, rootName],
  );
  return (
    <div style={{ padding: "80px 40px 40px" }}>
      <div style={{ position: "relative", width: spec.width, height: spec.height }}>
        <svg width={spec.width} height={spec.height} style={{ position: "absolute", inset: 0, overflow: "visible" }}>
          <defs>
            <marker id="metro-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0 1 L9 5 L0 9 Z" fill={FLOW_COLORS.detached} />
            </marker>
          </defs>
          {spec.lines.map((l, i) => (
            <path
              key={i}
              d={l.d}
              fill="none"
              stroke={l.color}
              strokeWidth={l.width ?? 5}
              strokeLinecap="round"
              strokeDasharray={l.dash ? "11 8" : undefined}
              markerEnd={l.arrow ? "url(#metro-arrow)" : undefined}
              opacity={0.95}
            />
          ))}
          {spec.stations.map((s, i) => (
            <Mark key={i} s={s} selected={props.selected} />
          ))}
        </svg>
        {spec.stations.map((s, i) =>
          s.name ? <Label key={i} s={s} selected={props.selected} onSelect={props.onSelect} onDrill={props.onDrill} /> : null,
        )}
        {spec.labels.map((l, i) => (
          <div key={i} style={caption(l.x, l.y, l.color)}>
            {l.text}
          </div>
        ))}
      </div>
      <Legend />
    </div>
  );
}

/** The SVG mark for one station — dot, double-ring interchange, terminus bar, junction, or loop ring. */
function Mark({ s, selected }: { s: MetroStation; selected: FlowViewProps["selected"] }) {
  const lit = selected !== null && s.target === selected;
  const halo = lit ? <circle cx={s.x} cy={s.y} r={13} fill="none" stroke={FLOW_COLORS.select} strokeWidth={2} opacity={0.9} /> : null;
  if (s.kind === "loop") {
    return <circle cx={s.x} cy={s.y} r={34} fill="none" stroke={s.color} strokeWidth={4} />;
  }
  if (s.kind === "junction") {
    return <circle cx={s.x} cy={s.y} r={5} fill={s.color} />;
  }
  if (s.kind === "terminus") {
    return <path d={`M ${s.x} ${s.y - 12} L ${s.x} ${s.y + 12}`} stroke={s.color} strokeWidth={7} strokeLinecap="round" />;
  }
  if (s.kind === "interchange") {
    return (
      <g>
        {halo}
        <circle cx={s.x} cy={s.y} r={10} fill={FLOW_COLORS.canvas} stroke={s.color} strokeWidth={3} />
        <circle cx={s.x} cy={s.y} r={3.5} fill={s.color} />
      </g>
    );
  }
  return (
    <g>
      {halo}
      <circle cx={s.x} cy={s.y} r={6} fill={FLOW_COLORS.canvas} stroke={s.color} strokeWidth={2.6} />
    </g>
  );
}

/** The floating HTML label for a station (name bold, sub dim), alternating above/below the line. */
function Label({ s, selected, onSelect, onDrill }: {
  s: MetroStation;
  selected: FlowViewProps["selected"];
  onSelect: FlowViewProps["onSelect"];
  onDrill: FlowViewProps["onDrill"];
}) {
  const clickable = s.target != null;
  const dimmed = selected !== null && s.target !== selected;
  const gap = s.kind === "interchange" ? 62 : s.sub ? 46 : 32;
  const top = s.labelSide < 0 ? s.y - gap : s.y + 13;
  const style: CSSProperties = {
    position: "absolute",
    left: s.x,
    top,
    transform: "translateX(-50%)",
    textAlign: "center",
    lineHeight: 1.35,
    fontFamily: MONO,
    cursor: clickable ? "pointer" : "default",
    opacity: dimmed ? 0.55 : 1,
    userSelect: "none",
  };
  return (
    <div
      style={style}
      onClick={(e) => {
        if (!clickable) return;
        e.stopPropagation();
        onSelect(s.target ?? null);
      }}
      onDoubleClick={(e) => {
        if (!clickable || !s.expandable) return;
        e.stopPropagation();
        onDrill(s.target!);
      }}
    >
      {/* Termini are the only marks whose NAME carries the line colour (▶ entry / ⏎ return). */}
      <span style={{ display: "block", fontSize: 10.5, fontWeight: 600, color: s.kind === "terminus" ? s.color : FLOW_COLORS.ink, whiteSpace: "nowrap" }}>
        {s.name}
      </span>
      {s.sub ? <span style={{ display: "block", fontSize: 9, color: FLOW_COLORS.dim, whiteSpace: "nowrap" }}>{s.sub}</span> : null}
    </div>
  );
}

function Legend() {
  const items: Array<[string, string]> = [
    ["exec line", FLOW_COLORS.ink],
    ["branch split", FLOW_COLORS.branch],
    ["⏱ interchange = awaited", FLOW_COLORS.awaited],
    ["⏎ terminus = return", FLOW_COLORS.exitCap],
    ["dashed violet = fire-and-forget", FLOW_COLORS.detached],
  ];
  return (
    <div style={{ display: "flex", gap: 16, flexWrap: "wrap", margin: "16px 2px 0", fontFamily: MONO, fontSize: 10.5, color: FLOW_COLORS.dim }}>
      {items.map(([text, color]) => (
        <span key={text} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <span style={{ width: 18, height: 4, borderRadius: 2, background: color, display: "inline-block" }} />
          {text}
        </span>
      ))}
    </div>
  );
}

function caption(x: number, y: number, color: string): CSSProperties {
  return {
    position: "absolute",
    left: x,
    top: y,
    transform: "translateX(-50%)",
    padding: "1px 6px",
    borderRadius: 3,
    background: FLOW_COLORS.canvas,
    border: `1px solid ${FLOW_COLORS.faint}`,
    color,
    fontFamily: MONO,
    fontSize: 9,
    whiteSpace: "nowrap",
    pointerEvents: "none",
  };
}
