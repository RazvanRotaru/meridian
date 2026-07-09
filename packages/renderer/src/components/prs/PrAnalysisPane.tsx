/**
 * The right-hand pane of the PR page, driven entirely by `prAnalyzeStatus`: a hint when idle, a
 * clone→checkout→extract progress panel while running, the error + retry affordance on failure, and
 * on "ready" the minimal graph of modified modules over the directly-affected logic-flow list.
 * Presentational; it reads the analyze slice and re-runs analysis via `analyzePr`.
 */

import { useBlueprint, useBlueprintActions } from "../../state/StoreContext";
import type { PrSummary } from "../../state/prTypes";

type Stage = "clone" | "checkout" | "extract";

const STAGES: ReadonlyArray<{ id: Stage; label: string }> = [
  { id: "clone", label: "Cloning the repository" },
  { id: "checkout", label: "Fetching the PR head + base" },
  { id: "extract", label: "Extracting modified nodes" },
];

export function PrAnalysisPane() {
  const status = useBlueprint((state) => state.prAnalyzeStatus);
  const stage = useBlueprint((state) => state.prAnalyzeStage);
  const prNumber = useBlueprint((state) => state.prAnalyzePrNumber);

  if (status === "idle") {
    return <Hint>Select a pull request to analyze its impact.</Hint>;
  }
  if (status === "running") {
    return <Progress stage={stage} prNumber={prNumber} />;
  }
  if (status === "error") {
    return <Failure prNumber={prNumber} />;
  }
  return <Result prNumber={prNumber} />;
}

function Progress({ stage, prNumber }: { stage: Stage | null; prNumber: number | null }) {
  const activeIndex = stage ? STAGES.findIndex((entry) => entry.id === stage) : 0;
  return (
    <section style={CARD}>
      <div style={CARD_TITLE}>Analyzing PR #{prNumber}</div>
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

function Failure({ prNumber }: { prNumber: number | null }) {
  const message = useBlueprint((state) => state.prAnalyzeError);
  const summary = useBlueprint((state) => summaryFor(prNumber, state.prsList.open, state.prsList.closed));
  const { analyzePr } = useBlueprintActions();
  return (
    <section style={CARD}>
      <div style={ERROR_TITLE}>Analysis failed</div>
      <div style={ERROR_BODY}>{message ?? "PR analysis failed."}</div>
      {summary ? (
        <button type="button" style={RETRY} onClick={() => void analyzePr(summary)}>
          Retry
        </button>
      ) : null}
    </section>
  );
}

// On "ready" the diff opens full-screen (PrDiffOverlay covers the whole PR view); this note is what
// sits behind it, so closing the overlay lands on a clear affordance to reopen the same diff.
function Result({ prNumber }: { prNumber: number | null }) {
  return <Hint>{`PR #${prNumber} diff is open full-screen — press Esc to return.`}</Hint>;
}

function Hint({ children }: { children: string }) {
  return (
    <div style={HINT_WRAP}>
      <div style={HINT_CARD}>{children}</div>
    </div>
  );
}

function stepState(index: number, activeIndex: number): "done" | "active" | "pending" {
  if (index < activeIndex) {
    return "done";
  }
  return index === activeIndex ? "active" : "pending";
}

function summaryFor(
  selected: number | null,
  open: readonly PrSummary[] | null,
  closed: readonly PrSummary[] | null,
): PrSummary | null {
  if (selected === null) {
    return null;
  }
  return [...(open ?? []), ...(closed ?? [])].find((pr) => pr.number === selected) ?? null;
}

const CARD: React.CSSProperties = {
  height: "100%",
  boxSizing: "border-box",
  border: "1px solid #2A2F37",
  borderRadius: 10,
  background: "#0E1116",
  padding: 22,
  display: "flex",
  flexDirection: "column",
  gap: 16,
};
const CARD_TITLE: React.CSSProperties = { color: "#F0F6FC", fontSize: 15, fontWeight: 650 };
const STEP_LIST: React.CSSProperties = { listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 12 };
const STEP_ROW: React.CSSProperties = { display: "flex", alignItems: "center", gap: 12 };
const ERROR_TITLE: React.CSSProperties = { color: "#FCA5A5", fontSize: 15, fontWeight: 650 };
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
const HINT_WRAP: React.CSSProperties = { height: "100%", display: "grid", placeItems: "center" };
const HINT_CARD: React.CSSProperties = { maxWidth: 380, border: "1px dashed #2A2F37", borderRadius: 8, padding: 18, color: "#8B949E", background: "#0E1116", fontSize: 14, textAlign: "center" };

function stepDot(state: "done" | "active" | "pending"): React.CSSProperties {
  const colors = { done: "#56C271", active: "#388BFD", pending: "#2A2F37" } as const;
  return {
    width: 10,
    height: 10,
    borderRadius: 999,
    flexShrink: 0,
    background: colors[state],
    boxShadow: state === "active" ? "0 0 0 4px rgba(56,139,253,0.2)" : "none",
  };
}

function stepLabel(state: "done" | "active" | "pending"): React.CSSProperties {
  return {
    fontSize: 13.5,
    color: state === "pending" ? "#6C7683" : "#E6EDF3",
    fontWeight: state === "active" ? 650 : 500,
  };
}
