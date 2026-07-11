/**
 * The always-visible key for the Service-composition canvas — so the view explains itself without a
 * tour. Two parts: what the three wire colours mean (matching `compositionElk`'s edge styling), and
 * the interaction gestures (single-click / double-click / ⌘P). Presentation only; no store reads.
 */

// Kept in step with `layout/compositionElk.ts` so the swatches match the wires on the canvas.
const INTERNAL_COLOR = "#5B6675";
const CROSS_BOUNDARY_COLOR = "#C9A24B";
const INHERITANCE_COLOR = "#A78BFA";
const IPC_COLOR = "#E06CB0";

export function CompositionLegend() {
  return (
    <section style={SECTION_STYLE} aria-label="Legend">
      <div style={HEADER_STYLE}>Reading this view</div>
      <div style={KEY_STYLE}>
        <LegendEdge color={INTERNAL_COLOR} label="within a package" />
        <LegendEdge color={CROSS_BOUNDARY_COLOR} label="crosses a package boundary" />
        <LegendEdge color={INHERITANCE_COLOR} label="inheritance" dashed />
        <LegendEdge color={IPC_COLOR} label="IPC — over the wire, via a channel" dashed />
      </div>
      <div style={HINT_STYLE}>
        <div><b style={KBD_STYLE}>click</b> → highlight a unit's dependencies</div>
        <div><b style={KBD_STYLE}>double-click</b> → navigate into this node</div>
        <div><b style={KBD_STYLE}>⌘P</b> → jump to any file / package</div>
      </div>
    </section>
  );
}

function LegendEdge(props: { color: string; label: string; dashed?: boolean }) {
  return (
    <div style={ROW_STYLE}>
      <svg width={28} height={8} viewBox="0 0 28 8" aria-hidden style={{ flexShrink: 0 }}>
        <line
          x1={1}
          y1={4}
          x2={27}
          y2={4}
          stroke={props.color}
          strokeWidth={2}
          strokeDasharray={props.dashed ? "4 3" : undefined}
        />
      </svg>
      <span>{props.label}</span>
    </div>
  );
}

const SECTION_STYLE: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 6,
  paddingTop: 8,
  borderTop: "1px solid #2A2F37",
};
const HEADER_STYLE: React.CSSProperties = {
  fontSize: 11,
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  color: "#7B8695",
};
const KEY_STYLE: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 4 };
const ROW_STYLE: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  fontSize: 11,
  color: "#9AA4B2",
};
const HINT_STYLE: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 2,
  fontSize: 11,
  color: "#9AA4B2",
};
const KBD_STYLE: React.CSSProperties = { color: "#C8D3E0", fontWeight: 600 };
