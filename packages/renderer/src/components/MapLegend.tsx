/**
 * The Map's LEGEND: a collapsed pill that expands into the lens's vocabulary. It reads its colours
 * and glyphs from the SAME sources the canvas paints from — `kindColors` (card accents + glyphs),
 * `mapPalette` (wires + flow-step tints), and `edgeColors` (the caller/callee relationship hues) —
 * so a swatch can never drift from what's on screen. Selection guidance is always present: the
 * legend is reference material, so selecting a card must not change its contents or size.
 */

import { useState } from "react";
import { CALLER_WIRE, IPC_WIRE } from "../theme/edgeColors";
import { accentForKind } from "../theme/kindColors";
import { CALL_RESOLVED, CONSTRUCT, IMPORT_CROSS, IMPORT_SIBLING, REL_COLORS } from "../theme/mapPalette";
import { CHROME_EDGE, CHROME_GAP, MINIMAP_W, LEGEND_BOTTOM } from "./canvas/flowCanvasProps";

const FILE_ACCENT = accentForKind("module");

interface MapLegendProps {
  /** A callable is unrolled, so flow-step cards are on the canvas. */
  hasSteps: boolean;
  /** The surface draws package/directory cards. The minimal overlay never does, so it opts out. */
  showPackages?: boolean;
  /** The surface can carry IPC wires. The minimal overlay mints only import/dep wires, so it opts out. */
  showIpc?: boolean;
}

export function MapLegend({ hasSteps, showPackages = true, showIpc = true }: MapLegendProps) {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <button type="button" style={PILL} title="What the shapes and colours mean" onClick={() => setOpen(true)}>
        ◫ Legend
      </button>
    );
  }
  return (
    <div style={CARD} role="region" aria-label="Map legend">
      <div style={HEAD_ROW}>
        <strong style={TITLE}>Legend</strong>
        <button type="button" style={CLOSE} onClick={() => setOpen(false)} title="Close">✕</button>
      </div>
      <Section title="Cards">
        {showPackages ? (
          <Row swatch={<Box color={accentForKind("package")} />} text="package / directory — double-click to zoom in, chevron to expand in place" />
        ) : null}
        <Row swatch={<Box color={FILE_ACCENT} />} text="file — expands into its declarations; its category is on the chip (UI / Utilities / Config)" />
        <Row swatch={<ChipSwatch label="KIND" color={accentForKind("class")} />} text="class / interface / object / type — a neutral grey; the kind chip names which" />
        <Row swatch={<Glyph text="ƒ" color={accentForKind("function")} />} text="method / function — double-click opens its logic flow" />
        <Row swatch={<Dashed />} text="ghost — a definition/caller NOT on this level; double-click reveals it" />
      </Section>
      <Section title="Wires — by relationship (toggle each in the toolbar)">
        <Row swatch={<Line color={REL_COLORS.calls} />} text="calls — a behavioural call" />
        <Row swatch={<Line color={REL_COLORS.instantiates} />} text="constructs — new X()" />
        <Row swatch={<Line color={REL_COLORS.extends} />} text="extends — class / interface inheritance" />
        <Row swatch={<Line color={REL_COLORS.implements} />} text="implements — a contract" />
        <Row swatch={<Line color={REL_COLORS.references} />} text="references — a type used in a signature / type position" />
        <Row swatch={<Line color={IMPORT_CROSS} />} text="import — gold crosses a directory boundary; grey within one" />
        {showIpc ? <Row swatch={<Line color={IPC_WIRE} />} text="IPC — joined over a channel (leaves the process)" /> : null}
        <Row swatch={<Line color={IMPORT_SIBLING} dashed />} text="dashed — the far end is off this level" />
      </Section>
      {hasSteps ? (
        <Section title="Flow steps">
          <Row swatch={<Glyph text="→" color={CALL_RESOLVED} />} text="call (blue = resolved, grey = unresolved); expandable when its flow is charted" />
          <Row swatch={<Glyph text="↻ ⑂ λ" color={CONSTRUCT} />} text="loop / branch / callback — expand to unroll the body" />
          <Row swatch={<Glyph text="⏎" color={CONSTRUCT} />} text="return / throw — this path ends here" />
        </Section>
      ) : null}
      <Section title="When you select">
        <Row swatch={<Line color="#C8D3E0" />} text="a node's wires BRIGHTEN (keeping their colour), everything else dims; the arrow shows direction. ctrl/cmd+click adds to the selection" />
        <Row swatch={<Ring />} text="green ring — a selected call step's definition; an edge-of-screen ➤ guides to it when off view" />
      </Section>
    </div>
  );
}

function Section(props: { title: string; children: React.ReactNode }) {
  return (
    <div style={SECTION}>
      <div style={SECTION_TITLE}>{props.title}</div>
      {props.children}
    </div>
  );
}

function Row(props: { swatch: React.ReactNode; text: string }) {
  return (
    <div style={ROW}>
      <span style={SWATCH}>{props.swatch}</span>
      <span style={ROW_TEXT}>{props.text}</span>
    </div>
  );
}

function Box(props: { color: string }) {
  return <span style={{ display: "inline-block", width: 14, height: 10, borderRadius: 2, border: `1px solid ${props.color}`, background: "#12171E" }} />;
}

function Dashed() {
  return <span style={{ display: "inline-block", width: 14, height: 10, borderRadius: 2, border: "1px dashed #4B535F", background: "rgba(16,21,28,0.6)" }} />;
}

function Ring() {
  return <span style={{ display: "inline-block", width: 12, height: 10, borderRadius: 2, border: "1px solid #2A3140", boxShadow: `0 0 0 2px ${CALLER_WIRE}`, background: "#1B222D" }} />;
}

function Glyph(props: { text: string; color: string }) {
  return <span style={{ color: props.color, fontSize: 11, fontFamily: MONO }}>{props.text}</span>;
}

/** Mirrors the cards' uppercase kind chip — the one kind marker since the glyphs were retired. */
function ChipSwatch(props: { label: string; color: string }) {
  return (
    <span style={{ color: props.color, border: `1px solid ${props.color}`, borderRadius: 3, padding: "1px 3px", fontSize: 7, fontWeight: 700, letterSpacing: "0.06em" }}>
      {props.label}
    </span>
  );
}

function Line(props: { color: string; dashed?: boolean }) {
  return <span style={{ display: "inline-block", width: 16, borderTop: `2px ${props.dashed ? "dashed" : "solid"} ${props.color}`, verticalAlign: "middle" }} />;
}

const MONO = "'JetBrains Mono', ui-monospace, monospace";
// Bottom-right, just LEFT of the minimap; the zoom controls stack directly above this pill. The
// whole left gutter stays free for the control panel, which can grow to full height.
const ANCHOR: React.CSSProperties = { position: "absolute", bottom: LEGEND_BOTTOM, right: CHROME_EDGE + MINIMAP_W + CHROME_GAP, zIndex: 6 };
const PILL: React.CSSProperties = {
  ...ANCHOR,
  border: "1px solid #2A2F37",
  borderRadius: 8,
  background: "rgba(18,23,30,0.92)",
  color: "#9AA4B2",
  padding: "5px 10px",
  fontSize: 12,
  cursor: "pointer",
};
const CARD: React.CSSProperties = {
  ...ANCHOR,
  width: 380,
  maxHeight: "70vh",
  overflowY: "auto",
  border: "1px solid #2A2F37",
  borderRadius: 10,
  background: "rgba(14,17,22,0.95)",
  backdropFilter: "blur(6px)",
  padding: "10px 12px",
  display: "flex",
  flexDirection: "column",
  gap: 8,
};
const HEAD_ROW: React.CSSProperties = { display: "flex", alignItems: "center", justifyContent: "space-between" };
const TITLE: React.CSSProperties = { fontSize: 12.5, color: "#E6EDF3" };
const CLOSE: React.CSSProperties = { background: "transparent", border: "none", color: "#7B8695", cursor: "pointer", fontSize: 12 };
const SECTION: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 3 };
const SECTION_TITLE: React.CSSProperties = { fontSize: 10, letterSpacing: 0.8, textTransform: "uppercase", color: "#565E68", marginBottom: 1 };
const ROW: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8 };
const SWATCH: React.CSSProperties = { width: 24, display: "inline-flex", justifyContent: "center", flexShrink: 0 };
const ROW_TEXT: React.CSSProperties = { fontSize: 11, color: "#9AA4B2", lineHeight: 1.45 };
