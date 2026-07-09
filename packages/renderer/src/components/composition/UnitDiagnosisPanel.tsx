/**
 * The selected unit's diagnosis: a tone-coloured verdict, the plain-language reading of its scores,
 * and concrete refactor suggestions — the "what should I do about it" companion to the worklist.
 * Presentation only; the parent resolves the active unit's metrics.
 */

import { diagnoseUnit, type Tone, type UnitMetrics } from "@meridian/design-metrics";
import type { GraphNode } from "@meridian/core";
import { useBlueprintActions } from "../../state/StoreContext";
import { useChangeSummary } from "../useChangedLines";

export function UnitDiagnosisPanel(props: { unit: UnitMetrics | null; node: GraphNode | null }) {
  return (
    <section style={SECTION_STYLE} aria-label="Diagnosis">
      <div style={HEADER_STYLE}>Diagnosis</div>
      {props.unit ? (
        <Diagnosis unit={props.unit} node={props.node} />
      ) : (
        <div style={META_STYLE}>Select a card or worklist row to see its scores explained and what to do.</div>
      )}
    </section>
  );
}

function Diagnosis({ unit, node }: { unit: UnitMetrics; node: GraphNode | null }) {
  const diagnosis = diagnoseUnit(unit);
  const tone = TONE_COLOR[diagnosis.tone];
  const { showCode, expandCode } = useBlueprintActions();
  const summary = useChangeSummary(node ?? undefined);
  const canOpen = Boolean(node?.location);
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
      {summary ? (
        <div style={CHANGE_BOX_STYLE}>
          <div style={CHANGE_HEADER_STYLE}>Diff</div>
          <div style={CHANGE_ROW_STYLE}>
            <span style={ADDED_STYLE}>{`+${summary.added} lines`}</span>
            <span style={DELETED_STYLE}>{`-${summary.deleted} lines`}</span>
            {summary.touched > 0 ? <span style={TOUCHED_STYLE}>{`${summary.touched} highlighted`}</span> : null}
            {canOpen && node ? (
              <button
                type="button"
                style={OPEN_STYLE}
                onClick={() => {
                  void showCode(node);
                  expandCode();
                }}
              >
                Open Diff
              </button>
            ) : null}
          </div>
        </div>
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
const CHANGE_BOX_STYLE: React.CSSProperties = {
  marginTop: 2,
  padding: "7px 8px",
  borderRadius: 8,
  border: "1px solid #5A4A24",
  background: "rgba(230,184,77,0.08)",
  display: "flex",
  flexDirection: "column",
  gap: 5,
};
const CHANGE_HEADER_STYLE: React.CSSProperties = {
  fontSize: 10,
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  color: "#B99A53",
};
const CHANGE_ROW_STYLE: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  flexWrap: "wrap",
};
const ADDED_STYLE: React.CSSProperties = {
  fontSize: 10.5,
  fontWeight: 700,
  color: "#56C271",
  border: "1px solid rgba(86,194,113,0.45)",
  borderRadius: 4,
  padding: "1px 5px",
  background: "rgba(86,194,113,0.1)",
};
const DELETED_STYLE: React.CSSProperties = {
  fontSize: 10.5,
  fontWeight: 700,
  color: "#F0787C",
  border: "1px solid rgba(240,120,124,0.45)",
  borderRadius: 4,
  padding: "1px 5px",
  background: "rgba(240,120,124,0.1)",
};
const TOUCHED_STYLE: React.CSSProperties = { fontSize: 10.5, color: "#C8D3E0" };
const OPEN_STYLE: React.CSSProperties = {
  marginLeft: "auto",
  fontSize: 10.5,
  fontWeight: 600,
  color: "#E2A33C",
  border: "1px solid rgba(226,163,60,0.55)",
  borderRadius: 5,
  padding: "2px 7px",
  background: "rgba(226,163,60,0.14)",
  cursor: "pointer",
};
