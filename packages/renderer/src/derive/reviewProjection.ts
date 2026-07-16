/**
 * The PR-review projection controlled by the shared Tests toggle. The raw ReviewContext stays
 * intact so hiding tests is lossless: persisted ticks/drafts keep the same review key and turning
 * tests back on can reconstruct the exact original review. Every visible review surface derives
 * from one filtered context, preventing graph/files/flows/progress from disagreeing.
 */

import { computeAffectedNodes, LOGIC_FLOW_EXTENSION, parseNodeId } from "@meridian/core";
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
  const coveredContext = withFlowCoverageWarnings(context, artifact);
  const allFiles = deriveReviewFiles(coveredContext, artifact, index, { baseIndex: options.baseIndex });
  const excludedTestFileCount = options.showTests ? 0 : allFiles.filter((file) => file.isTest).length;
  const includedPaths = options.showTests
    ? null
    : new Set(allFiles.filter((file) => !file.isTest).map((file) => file.path));
  const visibleContext = includedPaths === null
    ? coveredContext
    : { ...coveredContext, changedFiles: coveredContext.changedFiles.filter((file) => includedPaths.has(file.path)) };
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
    context: coveredContext,
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
