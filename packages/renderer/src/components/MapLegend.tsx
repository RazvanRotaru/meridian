/**
 * The Map's LEGEND: a collapsed pill that expands into the lens's vocabulary — what each card
 * shape, step glyph, wire colour, and highlight read means. Pure presentation over constants that
 * mirror the real palette (moduleMapPaint / the node components); nothing here computes.
 */

import { useState } from "react";
import { CALLEE_WIRE, CALLER_WIRE } from "../theme/edgeColors";

export function MapLegend() {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <button type="button" style={PILL} title="What the shapes and colours mean" onClick={() => setOpen(true)}>
        ◫ Legend
      </button>
    );
  }
  return (
    <div style={CARD}>
      <div style={HEAD_ROW}>
        <strong style={TITLE}>Legend</strong>
        <button type="button" style={CLOSE} onClick={() => setOpen(false)} title="Close">✕</button>
      </div>
      <Section title="Cards">
        <Row swatch={<Box color="#5B9BE3" />} text="package / directory — double-click to zoom in, chevron to expand in place" />
        <Row swatch={<Box color="#3FB7C4" />} text="file — expands into its classes, functions, and types" />
        <Row swatch={<Glyph text="◆" color="#C9A24B" />} text="class / interface / object — an open frame of its members" />
        <Row swatch={<Glyph text="ƒ" color={CALLER_WIRE} />} text="method / function — expands into its logic flow; double-click opens the Logic tab" />
        <Row swatch={<Glyph text="τ" color={CALLEE_WIRE} />} text="type definition — a dependency anchor, nothing to unroll" />
        <Row swatch={<Dashed />} text="ghost — a definition/caller NOT on this level; double-click reveals it" />
      </Section>
      <Section title="Flow steps">
        <Row swatch={<Glyph text="→" color="#5E74C6" />} text="call (blue = resolved, grey = unresolved); expandable when its flow is charted" />
        <Row swatch={<Glyph text="↻ ⑂ λ" color="#C9A24B" />} text="loop / branch / callback — expand to unroll the body" />
        <Row swatch={<Glyph text="⏎" color="#C9A24B" />} text="return / throw — this path ends here" />
      </Section>
      <Section title="Wires">
        <Row swatch={<Line color="#5B6675" />} text="import between siblings" />
        <Row swatch={<Line color="#C9A24B" />} text="import crossing a directory boundary (coupling)" />
        <Row swatch={<Line color="#7C6FBF" />} text="code dependency — from the exact block to its definition" />
        <Row swatch={<Line color="#7B8695" />} text="execution order between flow steps" />
        <Row swatch={<Line color="#7C6FBF" dashed />} text="to/from a ghost (the other end is off this level)" />
      </Section>
      <Section title="Selection reads">
        <Row swatch={<Line color={CALLEE_WIRE} />} text="marching violet — what the selection reaches (callees)" />
        <Row swatch={<Line color={CALLER_WIRE} />} text="marching green — who reaches the selection (callers); ctrl/cmd+click adds to the selection" />
        <Row swatch={<Ring />} text="green ring — a selected call step's DEFINITION; an edge-of-screen ➤ guides to it when out of view" />
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

function Line(props: { color: string; dashed?: boolean }) {
  return <span style={{ display: "inline-block", width: 16, borderTop: `2px ${props.dashed ? "dashed" : "solid"} ${props.color}`, verticalAlign: "middle" }} />;
}

const MONO = "'JetBrains Mono', ui-monospace, monospace";
const ANCHOR: React.CSSProperties = { position: "absolute", bottom: 16, left: 56, zIndex: 5 };
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
