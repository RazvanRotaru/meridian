/**
 * A collapsible "what the scores mean" key — the glossary behind the Ce/Ca/I/A/D and cohesion numbers
 * on every scorecard. Default collapsed so it never crowds the sidebar; open it to learn the view.
 */

import { useState } from "react";
import { SCORE_GLOSSARY } from "../../derive/compositionAdvice";

export function ScoreGlossary() {
  const [open, setOpen] = useState(false);
  return (
    <section style={SECTION_STYLE} aria-label="What the scores mean">
      <button type="button" style={HEADER_BUTTON_STYLE} aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <span style={CARET_STYLE} aria-hidden>{open ? "▾" : "▸"}</span>
        What the scores mean
      </button>
      {open ? (
        <div style={LIST_STYLE}>
          {SCORE_GLOSSARY.map((gloss) => (
            <div key={gloss.key} style={ROW_STYLE}>
              <div style={NAME_STYLE}>{gloss.name}</div>
              <div style={BLURB_STYLE}>{gloss.blurb}</div>
              <div style={HEALTHY_STYLE}>{gloss.healthy}</div>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}

const SECTION_STYLE: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 6,
  paddingTop: 8,
  borderTop: "1px solid #2A2F37",
};
const HEADER_BUTTON_STYLE: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  background: "transparent",
  border: "none",
  padding: 0,
  cursor: "pointer",
  font: "inherit",
  fontSize: 11,
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  color: "#7B8695",
};
const CARET_STYLE: React.CSSProperties = { fontSize: 9, color: "#6C7683" };
const LIST_STYLE: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 8 };
const ROW_STYLE: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 1 };
const NAME_STYLE: React.CSSProperties = { fontSize: 11.5, fontWeight: 700, color: "#C8D3E0" };
const BLURB_STYLE: React.CSSProperties = { fontSize: 11, color: "#9AA4B2", lineHeight: 1.4 };
const HEALTHY_STYLE: React.CSSProperties = { fontSize: 10.5, color: "#6C7683", fontStyle: "italic" };
