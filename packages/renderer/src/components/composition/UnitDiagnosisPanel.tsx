/**
 * The selected unit's diagnosis: a tone-coloured verdict, the plain-language reading of its scores,
 * and concrete refactor suggestions — the "what should I do about it" companion to the worklist.
 * Presentation only; the parent resolves the active unit's metrics.
 */

import { diagnoseUnit, type Tone, type UnitMetrics } from "@meridian/design-metrics";

export function UnitDiagnosisPanel(props: { unit: UnitMetrics | null }) {
  return (
    <section style={SECTION_STYLE} aria-label="Diagnosis">
      <div style={HEADER_STYLE}>Diagnosis</div>
      {props.unit ? (
        <Diagnosis unit={props.unit} />
      ) : (
        <div style={META_STYLE}>Select a card or worklist row to see its scores explained and what to do.</div>
      )}
    </section>
  );
}

function Diagnosis({ unit }: { unit: UnitMetrics }) {
  const diagnosis = diagnoseUnit(unit);
  const tone = TONE_COLOR[diagnosis.tone];
  return (
    <div style={BODY_STYLE}>
      <div style={VERDICT_STYLE}>
        <span style={{ ...DOT_STYLE, background: tone }} />
        <span style={NAME_STYLE} title={unit.id}>{unit.displayName}</span>
      </div>
      <div style={{ ...HEADLINE_STYLE, color: tone }}>{diagnosis.headline}</div>
      <ul style={LIST_STYLE}>
        {diagnosis.findings.map((finding) => (
          <li key={finding} style={FINDING_STYLE}>{finding}</li>
        ))}
      </ul>
      {diagnosis.suggestions.length > 0 ? (
        <>
          <div style={SUB_HEADER_STYLE}>Suggested</div>
          <ul style={LIST_STYLE}>
            {diagnosis.suggestions.map((suggestion) => (
              <li key={suggestion} style={SUGGESTION_STYLE}>{suggestion}</li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}

const TONE_COLOR: Record<Tone, string> = { good: "#56C271", warn: "#E6B84D", bad: "#F0787C" };

const SECTION_STYLE: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 5,
  paddingTop: 8,
  borderTop: "1px solid #2A2F37",
};
const HEADER_STYLE: React.CSSProperties = {
  fontSize: 11,
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  color: "#7B8695",
};
const META_STYLE: React.CSSProperties = { fontSize: 11, color: "#7B8695", lineHeight: 1.45 };
const BODY_STYLE: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 4 };
const VERDICT_STYLE: React.CSSProperties = { display: "flex", alignItems: "center", gap: 6 };
const DOT_STYLE: React.CSSProperties = { width: 8, height: 8, borderRadius: "50%", flexShrink: 0 };
const NAME_STYLE: React.CSSProperties = {
  fontSize: 12.5,
  fontWeight: 700,
  color: "#E6EDF3",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};
const HEADLINE_STYLE: React.CSSProperties = { fontSize: 12, fontWeight: 600 };
const SUB_HEADER_STYLE: React.CSSProperties = {
  fontSize: 10,
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  color: "#6C7683",
  marginTop: 2,
};
const LIST_STYLE: React.CSSProperties = {
  margin: 0,
  paddingLeft: 16,
  display: "flex",
  flexDirection: "column",
  gap: 3,
};
const FINDING_STYLE: React.CSSProperties = { fontSize: 11, color: "#9AA4B2", lineHeight: 1.4 };
const SUGGESTION_STYLE: React.CSSProperties = { fontSize: 11, color: "#C8D3E0", lineHeight: 1.4 };
