/** PR-specific adapters around the shared progress indicator, cancellation, and fallback actions. */

import { useBlueprint, useBlueprintActions } from "../../state/StoreContext";
import { PrReviewProgressView } from "../PrReviewProgressView";

export function PrPrepareProgress() {
  const progress = useBlueprint((state) => state.prReviewProgress);
  const { cancelPrReviewPreparation } = useBlueprintActions();
  return (
    <PrReviewProgressView
      progress={progress}
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
  const progress = useBlueprint((state) => state.prReviewProgress);
  return <PrReviewProgressView progress={progress} variant="inline" />;
}

export function PrPrepareError() {
  const progress = useBlueprint((state) => state.prReviewProgress);
  const { reviewPrInGraph, reviewPrOnBaseGraph } = useBlueprintActions();
  return (
    <PrReviewProgressView
      progress={progress}
      style={ERROR_PROGRESS}
      actions={(
        <div style={ERROR_ACTIONS}>
          <button type="button" style={RETRY} onClick={() => void reviewPrInGraph()}>
            Retry
          </button>
          <button type="button" style={FALLBACK} onClick={() => void reviewPrOnBaseGraph()}>
            Review on base graph instead
          </button>
        </div>
      )}
    />
  );
}

export function PrPrepareCanceled() {
  const progress = useBlueprint((state) => state.prReviewProgress);
  const { reviewPrInGraph } = useBlueprintActions();
  return (
    <PrReviewProgressView
      progress={progress}
      style={PROGRESS_CARD}
      actions={(
        <button type="button" style={RETRY} onClick={() => void reviewPrInGraph()}>
          Try again
        </button>
      )}
    />
  );
}

const PROGRESS_CARD: React.CSSProperties = { marginBottom: 14 };
const ERROR_PROGRESS: React.CSSProperties = {
  marginBottom: 14,
  borderColor: "#92400E",
  background: "#1C1409",
};
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
const FALLBACK: React.CSSProperties = { ...RETRY, borderColor: "#92400E", color: "#FDE68A", background: "transparent" };
