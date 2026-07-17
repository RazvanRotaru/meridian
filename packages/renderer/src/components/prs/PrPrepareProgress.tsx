/** PR-specific adapters around the shared progress indicator, cancellation, and retry. */

import { useBlueprint, useBlueprintActions } from "../../state/StoreContext";
import type { PrPrepareStage } from "../../state/prPreparation";
import { PrepareProgress } from "../PrepareProgress";
import type { PrepareProgressStep } from "../PrepareProgress";

/** User-facing step labels for the strict v1 preparation stream's real stage names. */
const STAGES = [
  { id: "resolve", label: "Resolving immutable revisions…" },
  { id: "git", label: "Preparing repository snapshots…" },
  { id: "extract-head", label: "Extracting the HEAD view…" },
  { id: "extract-merge-base", label: "Extracting the merge-base view…" },
  { id: "publish", label: "Publishing projection slices…" },
] as const satisfies readonly [PrepareProgressStep<PrPrepareStage>, ...PrepareProgressStep<PrPrepareStage>[]];

export function PrPrepareProgress() {
  const stage = useBlueprint((state) => state.prPrepareStage);
  const elapsedMs = useBlueprint((state) => state.prPrepareElapsedMs);
  const { cancelPrReviewPreparation } = useBlueprintActions();
  return (
    <PrepareProgress
      title={progressTitle(elapsedMs)}
      steps={STAGES}
      activeStep={stage}
      style={PROGRESS_CARD}
      actions={(
        <button type="button" style={CANCEL} onClick={cancelPrReviewPreparation}>
          Cancel
        </button>
      )}
    />
  );
}

/** Compact store-connected adapter for the control-panel review card. */
export function PrPrepareInline() {
  const stage = useBlueprint((state) => state.prPrepareStage);
  const elapsedMs = useBlueprint((state) => state.prPrepareElapsedMs);
  return (
    <PrepareProgress
      title={progressTitle(elapsedMs)}
      steps={STAGES}
      activeStep={stage}
      variant="inline"
    />
  );
}

function progressTitle(elapsedMs: number | null): string {
  return elapsedMs === null ? "Preparing PR review" : `Preparing PR review · ${(elapsedMs / 1_000).toFixed(1)}s`;
}

export function PrPrepareError() {
  const message = useBlueprint((state) => state.prPrepareError);
  const { reviewPrInGraph } = useBlueprintActions();
  return (
    <section style={ERROR_CARD}>
      <div style={ERROR_BODY}>{message ?? "PR preparation failed."}</div>
      <div style={ERROR_ACTIONS}>
        <button type="button" style={RETRY} onClick={() => void reviewPrInGraph()}>
          Retry
        </button>
      </div>
    </section>
  );
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
const PROGRESS_CARD: React.CSSProperties = { marginBottom: 14 };
const ERROR_CARD: React.CSSProperties = { ...CARD, borderColor: "#92400E", background: "#1C1409" };
const ERROR_BODY: React.CSSProperties = { color: "#FBBF24", fontSize: 13, lineHeight: "19px" };
const ERROR_ACTIONS: React.CSSProperties = { display: "flex", alignItems: "center", flexWrap: "wrap", gap: 8 };
const RETRY: React.CSSProperties = {
  border: "1px solid #2A2F37",
  borderRadius: 8,
  background: "#161B22",
  color: "#E6EDF3",
  padding: "8px 16px",
  cursor: "pointer",
  fontWeight: 600,
};
const CANCEL: React.CSSProperties = { ...RETRY, alignSelf: "flex-start" };
