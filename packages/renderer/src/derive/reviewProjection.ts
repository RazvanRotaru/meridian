/**
 * The PR-review projection controlled by the shared Tests toggle. The raw ReviewContext stays
 * intact so hiding tests is lossless: persisted ticks/drafts keep the same review key and turning
 * tests back on can reconstruct the exact original review. Every visible review surface derives
 * from one filtered context, preventing graph/files/flows/progress from disagreeing.
 */

import { computeAffectedNodes } from "@meridian/core";
import type { AffectedNode, GraphArtifact, ReviewContext } from "@meridian/core";
import type { GraphIndex } from "../graph/graphIndex";
import { deriveReviewDataFromContext, type ReviewData } from "./reviewData";
import { deriveReviewFiles, type ReviewFileRow } from "./reviewFiles";

export interface ReviewProjection {
  /** The context used for affected nodes, files, flows, groups, and graph seeds. */
  visibleContext: ReviewContext;
  /** Carries the unfiltered context while exposing only visible flow rows. */
  review: ReviewData;
  files: ReviewFileRow[];
  affected: AffectedNode[];
  excludedTestFileCount: number;
}

export function deriveReviewProjection(
  context: ReviewContext,
  artifact: GraphArtifact,
  index: GraphIndex,
  options: { baseIndex: GraphIndex | null; baseArtifact?: GraphArtifact | null; showTests: boolean },
): ReviewProjection {
  const allFiles = deriveReviewFiles(context, artifact, index, { baseIndex: options.baseIndex });
  const excludedTestFileCount = options.showTests ? 0 : allFiles.filter((file) => file.isTest).length;
  const includedPaths = options.showTests
    ? null
    : new Set(allFiles.filter((file) => !file.isTest).map((file) => file.path));
  const visibleContext = includedPaths === null
    ? context
    : { ...context, changedFiles: context.changedFiles.filter((file) => includedPaths.has(file.path)) };
  const files = includedPaths === null
    ? allFiles
    : deriveReviewFiles(visibleContext, artifact, index, { baseIndex: options.baseIndex });
  const visibleReview = deriveReviewDataFromContext(
    visibleContext,
    artifact,
    index,
    options.baseArtifact ?? null,
  );
  const review: ReviewData = {
    ...visibleReview,
    // Preserve the complete source context for reversible toggling and stable progress/drafts.
    context,
    // A test-owned flow can be impacted by a production edit, so changed-file filtering alone is
    // insufficient: when Tests is off, remove those supporting flows as well.
    rows: options.showTests ? visibleReview.rows : visibleReview.rows.filter((row) => !row.isTest),
  };
  return {
    visibleContext,
    review,
    files,
    affected: computeAffectedNodes(artifact.nodes, visibleContext.changedFiles),
    excludedTestFileCount,
  };
}
