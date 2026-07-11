/**
 * The A/I main-sequence scatter — the "map behind the colour". Every unit is one dot plotted by
 * Instability (x, left→right) against Abstractness (y, bottom→top), over the shaded traps: the zone
 * of pain (lower-left, concrete + depended-upon) and the zone of uselessness (upper-right, abstract +
 * unused), split by the dashed main-sequence diagonal (A+I=1) where distance-from-line = 0. Dots are
 * coloured by that distance (health). Clicking a dot roots the canvas at the unit; the active
 * root/selection wears a larger dot + ring. Presentational — geometry comes from `scatterPoints`.
 *
 * Mirrors the static SVG in docs/service-composition.html (same zones, diagonal, axis labels), scaled
 * to fit the ~276px Toolbar and made data-driven + interactive.
 */

import { useMemo } from "react";
import type { UnitMetrics } from "@meridian/design-metrics";
import { scatterPoints } from "../../derive/compositionScatter";
import { colorForDistance, HEALTH_AMBER, HEALTH_GREEN, HEALTH_RED } from "../../derive/compositionGraph";

const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";

// The selection green shared across the app's highlights (logic SELECT_ACCENT, module-map ring), so
// the scatter's active-dot ring reads as the same "selected" signal.
const COMP_SELECT_ACCENT = "#6BE38A";

// Viewbox + margins: the plot box (PLOT_W × PLOT_H) is inset by the label margins, then PAD keeps
// dots and the diagonal/zone corners off the frame edge. Kept in one place so the SVG geometry and
// `scatterPoints` agree on the same box.
const VBW = 260;
const VBH = 236;
const ML = 24; // left margin — room for the rotated Abstractness label.
const MR = 10;
const MT = 10;
const MB = 24; // bottom margin — room for the Instability label.
const PLOT_W = VBW - ML - MR; // 226
const PLOT_H = VBH - MT - MB; // 202
const PAD = 8;

// The padded plot corners the frame, diagonal and zones reference — the same inset `scatterPoints`
// applies, so an on-sequence unit lands exactly on the drawn diagonal.
const LEFT = PAD;
const RIGHT_X = PLOT_W - PAD;
const TOP_Y = PAD;
const BOTTOM_Y = PLOT_H - PAD;
const MID_X = (LEFT + RIGHT_X) / 2;
const MID_Y = (TOP_Y + BOTTOM_Y) / 2;

interface MainSequenceScatterProps {
  metrics: UnitMetrics[];
  /** The rooted / selected unit — emphasized with a larger dot + ring; null when none. */
  activeId: string | null;
  onPick: (id: string) => void;
}

export function MainSequenceScatter(props: MainSequenceScatterProps) {
  const points = useMemo(() => scatterPoints(props.metrics, PLOT_W, PLOT_H, PAD), [props.metrics]);
  // Draw the active dot LAST so its ring sits above its neighbours.
  const ordered = useMemo(() => [...points].sort((a, b) => Number(a.id === props.activeId) - Number(b.id === props.activeId)), [points, props.activeId]);

  return (
    <div style={WRAP_STYLE}>
      <svg viewBox={`0 0 ${VBW} ${VBH}`} width="100%" role="img" aria-label="Abstractness versus instability scatter with the main-sequence diagonal, the zone of pain lower-left and the zone of uselessness upper-right.">
        <defs>
          <linearGradient id="ms-pain" x1="0" y1="1" x2="1" y2="0">
            <stop offset="0" stopColor="rgba(229,72,77,0.22)" />
            <stop offset="1" stopColor="rgba(229,72,77,0)" />
          </linearGradient>
          <linearGradient id="ms-useless" x1="1" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="rgba(230,184,77,0.20)" />
            <stop offset="1" stopColor="rgba(230,184,77,0)" />
          </linearGradient>
        </defs>
        <g transform={`translate(${ML}, ${MT})`}>
          <rect x={LEFT} y={TOP_Y} width={RIGHT_X - LEFT} height={BOTTOM_Y - TOP_Y} fill="#0d1218" stroke="#232935" />
          <path d={`M${LEFT} ${BOTTOM_Y} L${MID_X} ${BOTTOM_Y} L${LEFT} ${MID_Y} Z`} fill="url(#ms-pain)" />
          <path d={`M${RIGHT_X} ${TOP_Y} L${MID_X} ${TOP_Y} L${RIGHT_X} ${MID_Y} Z`} fill="url(#ms-useless)" />
          <line x1={LEFT} y1={TOP_Y} x2={RIGHT_X} y2={BOTTOM_Y} stroke="#3fb8af" strokeWidth={1.5} strokeDasharray="5 4" />
          <text x={LEFT + 4} y={BOTTOM_Y - 4} fill={HEALTH_RED} fontFamily={MONO} fontSize={7.5}>pain</text>
          <text x={RIGHT_X - 4} y={TOP_Y + 9} fill={HEALTH_AMBER} fontFamily={MONO} fontSize={7.5} textAnchor="end">unused</text>
          {ordered.map((point) => {
            const active = point.id === props.activeId;
            const fill = colorForDistance(point.distance);
            return (
              <g key={point.id} onClick={() => props.onPick(point.id)} style={DOT_GROUP_STYLE}>
                {active ? <circle cx={point.x} cy={point.y} r={8} fill="none" stroke={COMP_SELECT_ACCENT} strokeWidth={1.5} /> : null}
                <circle cx={point.x} cy={point.y} r={active ? 5.5 : 4} fill={fill} stroke="#0d1218" strokeWidth={0.75}>
                  <title>{`${point.label} · D${point.distance}`}</title>
                </circle>
              </g>
            );
          })}
        </g>
        <text x={ML + PLOT_W / 2} y={VBH - 6} fill="#8592a3" fontFamily={MONO} fontSize={9} textAnchor="middle">Instability  I  →</text>
        <text x={11} y={MT + PLOT_H / 2} fill="#8592a3" fontFamily={MONO} fontSize={9} textAnchor="middle" transform={`rotate(-90 11 ${MT + PLOT_H / 2})`}>Abstractness  A  →</text>
      </svg>
      <div style={LEGEND_STYLE}>
        <LegendDot color={HEALTH_RED} label="pain" />
        <LegendDot color={HEALTH_GREEN} label="on-sequence" />
        <LegendDot color={HEALTH_AMBER} label="uselessness" />
      </div>
    </div>
  );
}

function LegendDot(props: { color: string; label: string }) {
  return (
    <span style={LEGEND_ITEM_STYLE}>
      <span style={{ ...LEGEND_SWATCH_STYLE, background: props.color }} />
      {props.label}
    </span>
  );
}

const WRAP_STYLE: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 4 };
const DOT_GROUP_STYLE: React.CSSProperties = { cursor: "pointer" };
const LEGEND_STYLE: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 10,
  fontSize: 10,
  color: "#7B8695",
  fontFamily: MONO,
};
const LEGEND_ITEM_STYLE: React.CSSProperties = { display: "inline-flex", alignItems: "center", gap: 4 };
const LEGEND_SWATCH_STYLE: React.CSSProperties = { width: 8, height: 8, borderRadius: "50%", display: "inline-block" };
