/**
 * The PR-review view: the setup card (centered) while nothing is staged for review, otherwise the
 * resizable split of the containment GRAPH (left) and the ranked flow LIST (right). The graph runs
 * in its OWN <ReactFlowProvider> so its camera/fit state is isolated from every other surface.
 */

import { ReactFlowProvider } from "@xyflow/react";
import { useBlueprint } from "../state/StoreContext";
import { SplitPane } from "./SplitPane";
import { PrReviewGraph } from "./PrReviewGraph";
import { ReviewFlowList } from "./ReviewFlowList";
import { ReviewSetupCard } from "./ReviewSetupCard";

export function PrReviewView() {
  const affectedFiles = useBlueprint((state) => state.affectedFiles);
  const reviewModel = useBlueprint((state) => state.reviewModel);

  // Nothing to review yet: no staged paths and no matched files in any prior model.
  const nothingStaged =
    affectedFiles.length === 0 && (reviewModel === null || reviewModel.matchedFiles.length === 0);
  if (nothingStaged) {
    return <ReviewSetupCard />;
  }

  return (
    <SplitPane
      left={
        <ReactFlowProvider>
          <PrReviewGraph />
        </ReactFlowProvider>
      }
      right={<ReviewFlowList />}
    />
  );
}
