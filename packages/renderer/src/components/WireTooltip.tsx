/**
 * The wire HOVER card: names what a single strand IS — relationship kind, aggregated call-site
 * count, and both endpoints — so a wire inside a shared bus/trunk is identifiable by pointing at
 * it. Bundle highways keep their own richer breakdown tooltip; this covers every other wire.
 */

export interface WireHover {
  id: string;
  x: number;
  y: number;
  kind: string;
  weight: number;
  source: string;
  target: string;
}

export function WireTooltip({ hover }: { hover: WireHover }) {
  return (
    <div style={{ ...CARD, left: hover.x + 14, top: hover.y + 12 }}>
      <div style={KIND}>
        {hover.kind}
        {hover.weight > 1 ? <span style={WEIGHT}> ×{hover.weight}</span> : null}
      </div>
      <div style={ENDS}>
        {hover.source} <span style={ARROW}>→</span> {hover.target}
      </div>
    </div>
  );
}

const CARD: React.CSSProperties = {
  position: "fixed",
  zIndex: 30,
  pointerEvents: "none",
  background: "rgba(22, 27, 34, 0.96)",
  border: "1px solid #30363d",
  borderRadius: 6,
  padding: "5px 9px",
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  maxWidth: 420,
};
const KIND: React.CSSProperties = { fontSize: 10.5, fontWeight: 700, color: "#E6EDF3" };
const WEIGHT: React.CSSProperties = { fontWeight: 400, color: "#9AA4B2" };
const ENDS: React.CSSProperties = { fontSize: 10, color: "#9AA4B2", marginTop: 2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" };
const ARROW: React.CSSProperties = { color: "#565E68" };
