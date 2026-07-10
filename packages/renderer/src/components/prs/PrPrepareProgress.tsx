/**
 * The "Review in graph" preparation indicator, driven by the store's prepare lane: while the
 * server streams the PR-head analysis, a clone→checkout→extract step list with done/active/pending
 * dots (ported from the PR-analysis POC's PrAnalysisPane); on failure, the message plus a Retry
 * that simply re-invokes reviewPrInGraph.
 */

import { useBlueprint, useBlueprintActions } from "../../state/StoreContext";
import type { PrAnalyzeStage } from "../../state/prAnalysis";

type StepState = "done" | "active" | "pending";

/** User-facing step labels for the analyze stream's real stage names. */
const STAGES: ReadonlyArray<{ id: PrAnalyzeStage; label: string }> = [
  { id: "clone", label: "Fetch repository" },
  { id: "checkout", label: "Checkout PR head vs base" },
  { id: "extract", label: "Generate graph & extract diff" },
];

export function PrPrepareProgress() {
  const stage = useBlueprint((state) => state.prPrepareStage);
  const activeIndex = stage ? STAGES.findIndex((entry) => entry.id === stage) : 0;
  return (
    <section style={CARD}>
      <div style={CARD_TITLE}>Preparing PR review</div>
      <ol style={STEP_LIST}>
        {STAGES.map((entry, index) => (
          <li key={entry.id} style={STEP_ROW}>
            <span style={stepDot(stepState(index, activeIndex))} />
            <span style={stepLabel(stepState(index, activeIndex))}>{entry.label}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

/** Compact one-line sibling of PrPrepareProgress for tight surfaces (the control-panel review
 * card): the same store fields and stage labels, rendered as a single active dot + label instead
 * of the full step list — so the two indicators can never drift apart. */
export function PrPrepareInline() {
  const stage = useBlueprint((state) => state.prPrepareStage);
  const label = STAGES.find((entry) => entry.id === stage)?.label ?? STAGES[0].label;
  return (
    <div style={INLINE_ROW}>
      <span style={stepDot("active")} />
      <span style={INLINE_LABEL}>{label}…</span>
    </div>
  );
}

export function PrPrepareError() {
  const message = useBlueprint((state) => state.prPrepareError);
  const { reviewPrInGraph } = useBlueprintActions();
  return (
    <section style={CARD}>
      <div style={ERROR_TITLE}>Preparation failed</div>
      <div style={ERROR_BODY}>{message ?? "PR analysis failed."}</div>
      <button type="button" style={RETRY} onClick={() => void reviewPrInGraph()}>
        Retry
      </button>
    </section>
  );
}

function stepState(index: number, activeIndex: number): StepState {
  if (index < activeIndex) {
    return "done";
  }
  return index === activeIndex ? "active" : "pending";
}

function stepDot(state: StepState): React.CSSProperties {
  const colors: Record<StepState, string> = { done: "#56C271", active: "#388BFD", pending: "#2A2F37" };
  return {
    width: 10,
    height: 10,
    borderRadius: 999,
    flexShrink: 0,
    background: colors[state],
    boxShadow: state === "active" ? "0 0 0 4px rgba(56,139,253,0.2)" : "none",
  };
}

function stepLabel(state: StepState): React.CSSProperties {
  return {
    fontSize: 13.5,
    color: state === "pending" ? "#6C7683" : "#E6EDF3",
    fontWeight: state === "active" ? 650 : 500,
  };
}

const CARD: React.CSSProperties = {
  border: "1px solid #2A2F37",
  borderRadius: 10,
  background: "#0B0F14",
  padding: 16,
  display: "flex",
  flexDirection: "column",
  gap: 12,
  marginBottom: 14,
};
const CARD_TITLE: React.CSSProperties = { color: "#F0F6FC", fontSize: 13.5, fontWeight: 650 };
const INLINE_ROW: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8 };
const INLINE_LABEL: React.CSSProperties = { fontSize: 12, color: "#E6EDF3", fontWeight: 550 };
const STEP_LIST: React.CSSProperties = { listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 12 };
const STEP_ROW: React.CSSProperties = { display: "flex", alignItems: "center", gap: 12 };
const ERROR_TITLE: React.CSSProperties = { color: "#FCA5A5", fontSize: 13.5, fontWeight: 650 };
const ERROR_BODY: React.CSSProperties = { color: "#C9D1D9", fontSize: 13, lineHeight: "19px" };
const RETRY: React.CSSProperties = {
  alignSelf: "flex-start",
  border: "1px solid #2A2F37",
  borderRadius: 8,
  background: "#161B22",
  color: "#E6EDF3",
  padding: "8px 16px",
  cursor: "pointer",
  fontWeight: 600,
};
