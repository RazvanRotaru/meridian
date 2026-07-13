/** Comment previews attached inside the visible representatives of commented review nodes. */

import { useMemo } from "react";
import { NodeToolbar, Position, useViewport, type Node } from "@xyflow/react";
import { SEMANTIC_LAYER_CLASS, semanticLayerClass } from "../../derive/moduleSemanticComposite";
import {
  deriveReviewCommentNodeEvidence,
  projectReviewCommentNodeEvidence,
  type ReviewCommentNodeEvidence,
} from "../../derive/reviewCommentNodes";
import { useBlueprint } from "../../state/StoreContext";
import { ReviewCommentIndicator } from "./ReviewCommentHoverCard";

const NO_EXISTING_COMMENTS = [] as const;

export function ReviewCommentNodeIndicators({ visibleNodes }: { visibleNodes: readonly Node[] }) {
  const reviewActive = useBlueprint((state) => state.review !== null);
  const livePrReview = useBlueprint((state) => state.prReviewed !== null);
  const drafts = useBlueprint((state) => state.reviewComments);
  const discussion = useBlueprint((state) => state.prDiscussion);
  const existingCommentsVisible = useBlueprint((state) => state.reviewCommentsVisible);
  const files = useBlueprint((state) => state.reviewFiles);
  const index = useBlueprint((state) => state.index);
  const preparedHeadGraph = useBlueprint((state) => state.prPreparedArtifactCurrent);
  const exactEvidence = useMemo(
    () => reviewActive
      ? deriveReviewCommentNodeEvidence({
          drafts,
          existingComments: livePrReview ? discussion?.comments ?? NO_EXISTING_COMMENTS : NO_EXISTING_COMMENTS,
          existingCommentsVisible,
          files,
          index,
          lineCoordinatesMatchGraph: !livePrReview || preparedHeadGraph,
        })
      : new Map<string, ReviewCommentNodeEvidence>(),
    [discussion, drafts, existingCommentsVisible, files, index, livePrReview, preparedHeadGraph, reviewActive],
  );
  const visibleEvidence = useMemo(
    () => projectReviewCommentNodeEvidence(exactEvidence, visibleNodes, index),
    [exactEvidence, index, visibleNodes],
  );
  return <ReviewCommentNodeIndicatorLayer visibleNodes={visibleNodes} evidence={visibleEvidence} />;
}

export function ReviewCommentNodeIndicatorLayer({
  visibleNodes,
  evidence,
}: {
  visibleNodes: readonly Node[];
  evidence: ReadonlyMap<string, ReviewCommentNodeEvidence>;
}) {
  if (evidence.size === 0) return null;
  return <VisibleReviewCommentNodeIndicators visibleNodes={visibleNodes} evidence={evidence} />;
}

function VisibleReviewCommentNodeIndicators({
  visibleNodes,
  evidence,
}: {
  visibleNodes: readonly Node[];
  evidence: ReadonlyMap<string, ReviewCommentNodeEvidence>;
}) {
  const { zoom } = useViewport();
  return (
    <>
      {visibleNodes.map((node) => {
        const counts = evidence.get(node.id);
        if (!counts) return null;
        const count = counts.draftCount + counts.existingCount;
        if (count === 0) return null;
        const label = `${count} review ${count === 1 ? "comment" : "comments"}`;
        const depth = semanticDepthOf(node);
        return (
          <NodeToolbar
            key={node.id}
            nodeId={node.id}
            isVisible
            position={Position.Bottom}
            align="end"
            offset={-30 * zoom}
            className={toolbarClass(depth)}
            style={toolbarStyle(zoom)}
            data-review-comment-node-id={node.id}
            data-review-draft-count={counts.draftCount}
            data-review-existing-count={counts.existingCount}
          >
            <ReviewCommentIndicator label={label} count={count} comments={counts.comments} zoom={zoom} />
          </NodeToolbar>
        );
      })}
    </>
  );
}

function semanticDepthOf(node: Node): number | undefined {
  const depth = (node.data as { semanticDepth?: unknown }).semanticDepth;
  return typeof depth === "number" && Number.isInteger(depth) && depth >= 0 ? depth : undefined;
}

function toolbarClass(depth: number | undefined): string {
  return depth === undefined
    ? "review-comment-node-toolbar"
    : `review-comment-node-toolbar ${SEMANTIC_LAYER_CLASS} ${semanticLayerClass(depth)}`;
}

function toolbarStyle(zoom: number): React.CSSProperties {
  return { pointerEvents: "all", width: 26 * zoom, height: 26 * zoom };
}
