/**
 * The PR-review artifact session: swap the loaded graph for the freshly-prepared PR-head artifact
 * (so the review computes in HEAD coordinates — the diff hunks' own line numbers), and restore the
 * boot pair when the review session ends. The store's `prepareHeadGraph` drives the swap behind its
 * stale-seq guard; every session exit (back to the PRs lens, switching PRs) drives the restore, so
 * the coverage lives in the store actions, not in any one component. Only TYPES are imported from
 * the store (erased at build), so there is no runtime cycle.
 */

import { collectChangedIds, computeCoverage } from "@meridian/core";
import type { ChangedLineSpan, GraphArtifact, LineRange, ReviewContext } from "@meridian/core";
import { loadArtifact } from "../boot/loadArtifact";
import { applyChangedIds, buildGraphIndex, type GraphIndex } from "../graph/graphIndex";
import type { FileMatch } from "../derive/matchAffectedFiles";
import { deriveReviewData, type ReviewData } from "../derive/reviewData";
import { deriveReviewFiles } from "../derive/reviewFiles";
import { readReviewProgress } from "./reviewTicksPref";
import type { BlueprintState } from "./store";

/** The boot artifact/index (+ its artifact-carried review, if any), saved once when the first swap
 * happens so ending the session restores the exact graph the session booted with. */
export interface PrReviewBaseline {
  artifact: GraphArtifact;
  index: GraphIndex;
  review: ReviewData | null;
}

/** GET the prepared PR-head artifact from the same graph endpoint the boot artifact came from,
 * exchanging the `id` query param. Validation matches boot exactly (`loadArtifact`): the schema
 * MAJOR gate only — lenient like `view`/`web`, never Tier-1/2 strict. */
export async function fetchPreparedArtifact(graphUrl: string, preparedGraphId: string): Promise<GraphArtifact> {
  if (graphUrl === "") {
    throw new Error("this session has no graph endpoint to load the prepared PR artifact from");
  }
  const url = new URL(graphUrl, requestOrigin());
  url.searchParams.set("id", preparedGraphId);
  return loadArtifact(url.toString());
}

/**
 * Make the prepared PR-head artifact the CURRENT graph. The boot pair is saved ONCE — a re-review
 * (the same PR again, or another PR without leaving the session) must keep restoring to the
 * ORIGINAL artifact, never to a previous PR's head graph. The caller invalidates its once-per-
 * artifact derive caches via `invalidateArtifactCaches` (they must rebuild from the new index).
 */
export function swapToPreparedArtifact(
  get: () => BlueprintState,
  set: (partial: Partial<BlueprintState>) => void,
  prepared: GraphArtifact,
  invalidateArtifactCaches: () => void,
): void {
  const state = get();
  // Snapshot the review the BOOT artifact itself carries (if any) — never the live PR review:
  // the sync-first flow means a PR review is already running when the first head-extract swaps,
  // and session-end restore must not resurrect it.
  const baseline = state.prReviewBaseline ?? {
    artifact: state.artifact,
    index: state.index,
    review: deriveReviewData(state.artifact, state.index),
  };
  invalidateArtifactCaches();
  set({
    artifact: prepared,
    index: buildGraphIndex(prepared),
    prReviewBaseline: baseline,
    prPreparedArtifactCurrent: true,
    // The cached coverage report belongs to the outgoing artifact: recompute for the head graph
    // when coverage mode is showing, else drop it so the next toggle recomputes lazily.
    coverage: state.coverageMode ? computeCoverage(prepared.nodes, prepared.edges) : null,
    // An open code panel shows the outgoing artifact's node/lines — stale against the new graph.
    codeView: null,
  });
}

/**
 * Reset an index's amber changed-id marking to the artifact's OWN tag-derived set (usually none).
 * `applyChangedIds` mutates whichever index is current when a review runs, so an index can carry a
 * finished PR's amber set; this wipes those leftovers so the restored/plain graph shows exactly the
 * boot marking. Shared by the baseline restore and the sync-mode overlay close (no baseline to swap).
 */
export function resetChangedIdsToArtifact(artifact: GraphArtifact, index: GraphIndex): void {
  applyChangedIds(index, collectChangedIds(artifact.nodes));
}

/**
 * Put the boot artifact/index back. Two modes:
 *  - `endSession` (default true): the review session is over — clear every review-owned field and
 *    the pre-expanded/seeded Map (leaving to the PRs lens, switching PRs).
 *  - `endSession:false`: a SOFT close (the overlay closed mid-review) — restore the boot graph but
 *    keep review/ticks/seeds/baseline/prepared-id so `resumePrReview` can re-open from them.
 * Returns false (a no-op) outside a swapped session, so callers can hook this unconditionally.
 */
export function restorePrReviewBaseline(
  get: () => BlueprintState,
  set: (partial: Partial<BlueprintState>) => void,
  invalidateArtifactCaches: () => void,
  options: { endSession?: boolean } = {},
): boolean {
  const endSession = options.endSession ?? true;
  const baseline = get().prReviewBaseline;
  if (baseline === null) {
    return false;
  }
  resetChangedIdsToArtifact(baseline.artifact, baseline.index);
  invalidateArtifactCaches();
  // Both modes swap the boot graph back in, drop the (now-stale) code panel, and recompute coverage
  // for the boot artifact when the coverage lens is showing (else drop it for a lazy recompute).
  const restoredGraph: Partial<BlueprintState> = {
    artifact: baseline.artifact,
    index: baseline.index,
    prPreparedArtifactCurrent: false,
    coverage: get().coverageMode ? computeCoverage(baseline.artifact.nodes, baseline.artifact.edges) : null,
    codeView: null,
  };
  if (!endSession) {
    // Soft close: the review stays fully populated (chip + resume). The overlay's own arrays are
    // reset by closeMinimalGraph, and moduleFocus/Selected/Expanded stay so a resume replays them.
    set(restoredGraph);
    return true;
  }
  // An artifact-sourced review (the boot artifact carried one) gets its checklist + progress back;
  // a plain session clears every review-owned field.
  const progress = baseline.review ? readReviewProgress(baseline.review.context.reviewKey) : null;
  set({
    ...restoredGraph,
    review: baseline.review,
    reviewTicks: progress?.ticks ?? {},
    reviewUnitTicks: progress?.unitTicks ?? {},
    reviewFileTicks: progress?.fileTicks ?? {},
    reviewComments: progress?.comments ?? [],
    reviewFiles: baseline.review
      ? deriveReviewFiles(baseline.review.context, baseline.artifact, baseline.index, { baseIndex: null })
      : [],
    reviewPanelHidden: false,
    reviewSubmitStatus: "idle",
    reviewSubmitError: null,
    reviewSubmittedUrl: null,
    reviewAffectedIds: new Set<string>(),
    reviewLitNodeIds: null,
    reviewSelectedId: null,
    flowSelection: null,
    logicSelected: null,
    flowPaneRfNodes: [],
    flowPaneRfEdges: [],
    flowPaneLayoutStatus: "idle",
    reviewFlowBaseline: null,
    reviewGroups: null,
    reviewActiveGroupId: null,
    reviewAllSeedIds: [],
    prReviewed: null,
    reviewHeadRef: null,
    reviewDiffByFile: {},
    reviewRemovedByFile: {},
    reviewRemovedTruncatedByFile: {},
    prReviewBaseline: null,
    prPreparedGraphId: null,
    prPreparedHeadSha: null,
    // The review pre-expanded/seeded the Map around the PR; none of that is the reader's own
    // navigation, so the Map returns to its top level and the minimal overlay closes.
    moduleFocus: null,
    moduleSelected: new Set<string>(),
    moduleExpanded: new Set<string>(),
    minimalSeedIds: [],
    minimalMemberIds: [],
    minimalRollups: {},
    minimalBasePositions: {},
    minimalArrange: false,
    minimalRfNodes: [],
    minimalRfEdges: [],
    minimalLayoutStatus: "idle",
  });
  return true;
}

/**
 * Synthesize the line-level `changedSince` diff channel from the GitHub patch hunks, keyed by each
 * matched module's own `location.file`, so the code panel's `</>` highlights the added lines. This
 * is the FALLBACK source of truth, used only when the artifact carries no stamp of its own — see
 * applyPrReviewToMap for the choice between the two.
 */
export function withPrLineDiff(
  artifact: GraphArtifact,
  index: GraphIndex,
  context: ReviewContext,
  matchedFiles: readonly FileMatch[],
  prNumber: number,
): GraphArtifact {
  const hunksByPath = new Map(context.changedFiles.map((file) => [file.path, file.hunks]));
  const changedFiles: Record<string, LineRange[]> = {};
  const changedKinds: Record<string, ChangedLineSpan[]> = {};
  for (const match of matchedFiles) {
    const hunks = hunksByPath.get(match.path);
    const locFile = index.nodesById.get(match.moduleId)?.location?.file;
    if (hunks && hunks.length > 0 && locFile) {
      changedFiles[locFile] = hunks.map((hunk) => ({ start: hunk.start, end: hunk.end }));
      changedKinds[locFile] = hunks.map((hunk) => ({ start: hunk.start, end: hunk.end, kind: "added" as const }));
    }
  }
  // extensions is a strict JsonValue; the ranges/spans are plain JSON, so cast the assembled
  // artifact back to its type rather than widen JsonValue.
  return {
    ...artifact,
    extensions: {
      ...(artifact.extensions as Record<string, unknown> | undefined),
      changedSince: { baseRef: `pr#${prNumber}`, files: changedFiles, kinds: changedKinds },
    },
  } as unknown as GraphArtifact;
}

function requestOrigin(): string {
  return typeof window === "undefined" ? "http://meridian.local" : window.location.origin;
}
