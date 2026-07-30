/**
 * The PR-review projection controlled by the shared Tests toggle. The raw ReviewContext stays
 * intact so hiding tests is lossless: persisted ticks/drafts keep the same review key and turning
 * tests back on can reconstruct the exact original review. Every visible review surface derives
 * from one filtered context, preventing graph/files/flows/progress from disagreeing.
 */

import { computeAffectedNodes, LOGIC_FLOW_EXTENSION, parseNodeId } from "@meridian/core";
import type {
  AffectedNode,
  ChangedDiffLines,
  GraphArtifact,
  ReviewContext,
} from "@meridian/core";
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
  options: {
    baseIndex: GraphIndex | null;
    baseArtifact?: GraphArtifact | null;
    showTests: boolean;
    hideSourceCommentDiffs?: boolean;
    diffLines?: ChangedDiffLines | null;
  },
): ReviewProjection {
  const sourceVisibleContext = options.hideSourceCommentDiffs
    ? withoutCommentOnlyFiles(context, options.diffLines ?? null)
    : context;
  const allFiles = deriveReviewFiles(sourceVisibleContext, artifact, index, { baseIndex: options.baseIndex });
  const excludedTestFileCount = options.showTests ? 0 : allFiles.filter((file) => file.isTest).length;
  const includedPaths = options.showTests
    ? null
    : new Set(allFiles.filter((file) => !file.isTest).map((file) => file.path));
  const visibleContextWithoutCoverage = includedPaths === null
    ? sourceVisibleContext
    : {
        ...sourceVisibleContext,
        changedFiles: sourceVisibleContext.changedFiles.filter((file) => includedPaths.has(file.path)),
      };
  const visibleContext = withFlowCoverageWarnings(visibleContextWithoutCoverage, artifact);
  const files = includedPaths === null
    ? allFiles
    : deriveReviewFiles(visibleContext, artifact, index, { baseIndex: options.baseIndex });
  const visibleReview = deriveReviewDataFromContext(
    visibleContext,
    artifact,
    index,
    options.baseArtifact ?? null,
    options.baseIndex,
  );
  const coveredContext = withFlowCoverageWarnings(context, artifact);
  const reviewContext = (
    coveredContext.warnings.length === visibleContext.warnings.length
    && coveredContext.warnings.every((warning, index) => warning === visibleContext.warnings[index])
  )
    ? coveredContext
    : {
        ...coveredContext,
        // Coverage belongs to the visible review transaction. Preserve the raw changed-file
        // inventory for reversible toggling without surfacing warnings for hidden languages.
        warnings: visibleContext.warnings,
      };
  const review: ReviewData = {
    ...visibleReview,
    // Preserve the complete source context for reversible toggling and stable progress/drafts.
    context: reviewContext,
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

/**
 * Losslessly remove files whose complete canonical diff proves that every edit run changes comments
 * only. The raw context remains on `review.context`, so toggling the preference restores the exact
 * PR inventory, progress scope, and comment anchors.
 */
function withoutCommentOnlyFiles(
  context: ReviewContext,
  diffLines: ChangedDiffLines | null,
): ReviewContext {
  if (diffLines === null) return context;
  const changedFiles = context.changedFiles.filter((file) => {
    // File creation/deletion/rename is itself a visible source-tree change even when every textual
    // row is a comment (for example Python package markers and module-resolution targets).
    if (file.status !== "modified") return true;
    const rows = Object.hasOwn(diffLines, file.path) ? diffLines[file.path] : undefined;
    return rows === undefined
      || rows.length === 0
      || !rows.every((row) => row.sourceCommentOnly === true);
  });
  return changedFiles.length === context.changedFiles.length
    ? context
    : { ...context, changedFiles };
}

/**
 * A mixed-language artifact written by an older/partial extractor can still contain nodes for a
 * changed language while contributing no flow roots for that language. Never let the affected-flow
 * checklist silently present that partial inventory as complete.
 */
export function withFlowCoverageWarnings(context: ReviewContext, artifact: GraphArtifact): ReviewContext {
  const changedLanguages = new Set(
    computeAffectedNodes(artifact.nodes, context.changedFiles)
      .map((affected) => sourceLanguageOf(affected.nodeId))
      .filter((language): language is string => language !== null),
  );
  if (changedLanguages.size === 0) return context;

  const rawFlows = artifact.extensions?.[LOGIC_FLOW_EXTENSION];
  const coveredLanguages = new Set<string>();
  if (typeof rawFlows === "object" && rawFlows !== null && !Array.isArray(rawFlows)) {
    for (const flowId of Object.keys(rawFlows)) {
      const language = sourceLanguageOf(flowId);
      if (language !== null) coveredLanguages.add(language);
    }
  }
  const missing = [...changedLanguages].filter((language) => !coveredLanguages.has(language)).sort();
  if (missing.length === 0) return context;

  const warnings = [...context.warnings];
  for (const language of missing) {
    const warning = `No ${languageName(language)} logic flows were extracted; affected logic flows may be incomplete.`;
    if (!warnings.includes(warning)) warnings.push(warning);
  }
  return { ...context, warnings };
}

function sourceLanguageOf(nodeId: string): string | null {
  const language = parseNodeId(nodeId).lang;
  return language === "ext" || language === "unresolved" ? null : language;
}

function languageName(language: string): string {
  if (language === "py") return "Python";
  if (language === "ts") return "TypeScript";
  return language;
}
