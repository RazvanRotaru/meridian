/**
 * The PR-review list pane (right side of the split). The setup card while no changed files are
 * staged; otherwise the unmatched-paths banner, the header (progress + bulk-review + filter
 * chip), the ranked flow rows, and the not-covered section. Row order and ranking come straight
 * from the store's `reviewModel`; this component only decides which rows are currently VISIBLE
 * (the file-filter chip + "Hide reviewed"), via the pure `visibleFlows` helper so that rule is
 * unit-tested without mounting React.
 */

import { useMemo } from "react";
import { useBlueprint } from "../state/StoreContext";
import type { RankedReviewFlow } from "../derive/reviewFlows";
import { ReviewSetupCard } from "./ReviewSetupCard";
import { ReviewTruncatedNotice } from "./ReviewTruncatedNotice";
import { ReviewUnmatchedBanner } from "./ReviewUnmatchedBanner";
import { ReviewListHeader } from "./ReviewListHeader";
import { ReviewFlowRow } from "./ReviewFlowRow";
import { ReviewNotCoveredSection } from "./ReviewNotCoveredSection";
import { ReviewRemovedSection } from "./ReviewRemovedSection";
import { visibleFlows } from "./reviewListFilters";

const EMPTY_FLOWS: readonly RankedReviewFlow[] = [];

export function ReviewFlowList() {
  const affectedFiles = useBlueprint((state) => state.affectedFiles);
  const reviewModel = useBlueprint((state) => state.reviewModel);
  const reviewedFlowIds = useBlueprint((state) => state.reviewedFlowIds);
  const reviewListFilterFileId = useBlueprint((state) => state.reviewListFilterFileId);
  const reviewHideReviewed = useBlueprint((state) => state.reviewHideReviewed);
  const reviewSelectedFlowId = useBlueprint((state) => state.reviewSelectedFlowId);
  const index = useBlueprint((state) => state.index);

  const flows = reviewModel?.flows ?? EMPTY_FLOWS;
  const shown = useMemo(
    () =>
      visibleFlows(flows, index, {
        filterFile: reviewListFilterFileId,
        hideReviewed: reviewHideReviewed,
        reviewedFlowIds,
      }),
    [flows, index, reviewListFilterFileId, reviewHideReviewed, reviewedFlowIds],
  );

  if (affectedFiles.length === 0) {
    return <ReviewSetupCard />;
  }
  if (reviewModel === null) {
    return <div style={LOADING_STYLE}>Building the review model…</div>;
  }

  const reviewedCount = flows.filter((flow) => reviewedFlowIds.has(flow.rootId)).length;

  return (
    <div style={PANE_STYLE}>
      <ReviewTruncatedNotice />
      <ReviewUnmatchedBanner model={reviewModel} />
      <ReviewListHeader
        reviewedCount={reviewedCount}
        total={flows.length}
        visibleFlowIds={shown.map((flow) => flow.rootId)}
        reviewedFlowIds={reviewedFlowIds}
        filterFileId={reviewListFilterFileId}
      />
      <div style={ROWS_STYLE}>
        {shown.map((flow) => (
          <ReviewFlowRow
            key={flow.rootId}
            flow={flow}
            reviewed={reviewedFlowIds.has(flow.rootId)}
            selected={reviewSelectedFlowId === flow.rootId}
          />
        ))}
        {shown.length === 0 ? <div style={EMPTY_ROWS_STYLE}>No flows match the current filter.</div> : null}
      </div>
      <ReviewRemovedSection removed={reviewModel.removed} />
      <ReviewNotCoveredSection notCovered={reviewModel.notCovered} />
    </div>
  );
}

const PANE_STYLE: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  height: "100%",
  background: "#0E1116",
  color: "#E6EDF3",
  overflow: "hidden",
};
const ROWS_STYLE: React.CSSProperties = { flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: 2, padding: 6 };
const EMPTY_ROWS_STYLE: React.CSSProperties = { padding: "16px 12px", fontSize: 12, color: "#7B8695", textAlign: "center" };
const LOADING_STYLE: React.CSSProperties = { padding: 16, fontSize: 12, color: "#7B8695" };
