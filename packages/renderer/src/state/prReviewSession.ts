/**
 * The PR-review artifact session: swap the loaded graph for the freshly-prepared PR-head artifact
 * (so the review computes in HEAD coordinates — the diff hunks' own line numbers), and restore the
 * boot pair when the review session ends. The store's `reviewPrInGraph` drives the swap behind its
 * stale-seq guard; every session exit (back to the PRs lens, switching PRs) drives the restore, so
 * the coverage lives in the store actions, not in any one component. Only TYPES are imported from
 * the store (erased at build), so there is no runtime cycle.
 */

import { collectChangedIds, computeCoverage } from "@meridian/core";
import type { ChangedLineSpan, GraphArtifact, LineRange, ReviewContext } from "@meridian/core";
import { loadArtifact } from "../boot/loadArtifact";
import { applyChangedIds, buildGraphIndex, type GraphIndex } from "../graph/graphIndex";
import type { FileMatch } from "../derive/matchAffectedFiles";
import type { ReviewData } from "../derive/reviewData";
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
  const baseline = state.prReviewBaseline ?? { artifact: state.artifact, index: state.index, review: state.review };
  invalidateArtifactCaches();
  set({
    artifact: prepared,
    index: buildGraphIndex(prepared),
    prReviewBaseline: baseline,
    // The cached coverage report belongs to the outgoing artifact: recompute for the head graph
    // when coverage mode is showing, else drop it so the next toggle recomputes lazily.
    coverage: state.coverageMode ? computeCoverage(prepared.nodes, prepared.edges) : null,
    // An open code panel shows the outgoing artifact's node/lines — stale against the new graph.
    codeView: null,
  });
}

/**
 * The review-owned fields cleared identically whether a session ends by swapping the boot artifact
 * back or (the no-analyze-endpoint path) in place — the review pre-expanded/seeded the Map around
 * the PR, and none of that is the reader's own navigation, so the Map returns to its top level and
 * the minimal overlay closes. One source of truth so the two exits can never drift; the baseline
 * restore overrides artifact/index and the boot review's checklist on top of these defaults.
 */
function clearedReviewState(): Partial<BlueprintState> {
  return {
    review: null,
    reviewTicks: {},
    reviewUnitTicks: {},
    reviewFileTicks: {},
    reviewComments: [],
    reviewFiles: [],
    reviewPanelHidden: false,
    reviewSubmitStatus: "idle",
    reviewSubmitError: null,
    reviewSubmittedUrl: null,
    reviewAffectedIds: new Set<string>(),
    reviewLitNodeIds: null,
    reviewSelectedId: null,
    reviewGroups: null,
    reviewActiveGroupId: null,
    reviewAllSeedIds: [],
    prReviewed: null,
    prReviewBaseline: null,
    prPreparedGraphId: null,
    codeView: null,
    moduleFocus: null,
    moduleSelected: new Set<string>(),
    moduleExpanded: new Set<string>(),
    minimalSeedIds: [],
    minimalMemberIds: [],
    minimalBasePositions: {},
    minimalArrange: false,
    minimalRfNodes: [],
    minimalRfEdges: [],
    minimalLayoutStatus: "idle",
  };
}

/**
 * End the review session and clear every review-owned field. When the review swapped in a PR-head
 * artifact, put the boot artifact/index back; when it reviewed the loaded graph in place (the
 * synchronous, no-analyze-endpoint path — no baseline to swap), reset that graph's amber marking to
 * its OWN changed set instead, so no stale rings survive the exit. Returns false (a true no-op) only
 * when there is no review at all, so callers can hook this unconditionally.
 */
export function restorePrReviewBaseline(
  get: () => BlueprintState,
  set: (partial: Partial<BlueprintState>) => void,
  invalidateArtifactCaches: () => void,
): boolean {
  const state = get();
  const baseline = state.prReviewBaseline;
  if (baseline === null) {
    // No swap happened: the current graph IS the boot graph, only carrying this PR's amber marking.
    // Reset it to the artifact's OWN tag-derived set (usually none) and clear the review fields. A
    // boot-carried `meridian review` artifact (a review with no PR) is left untouched.
    if (state.prReviewed === null) {
      return false;
    }
    applyChangedIds(state.index, collectChangedIds(state.artifact.nodes));
    invalidateArtifactCaches();
    set({
      ...clearedReviewState(),
      coverage: state.coverageMode ? computeCoverage(state.artifact.nodes, state.artifact.edges) : null,
    });
    return true;
  }
  // `applyChangedIds` mutates whichever index is current when a review runs, so the baseline index
  // can carry a PR's amber set (e.g. a synchronous fallback review earlier in the session).
  // Reapply the artifact's OWN tag-derived set so the restored graph shows exactly the boot
  // marking (usually none), never a finished review's leftovers.
  applyChangedIds(baseline.index, collectChangedIds(baseline.artifact.nodes));
  invalidateArtifactCaches();
  // An artifact-sourced review (the boot artifact carried one) gets its checklist + progress back;
  // a plain session clears every review-owned field.
  const progress = baseline.review ? readReviewProgress(baseline.review.context.reviewKey) : null;
  set({
    ...clearedReviewState(),
    artifact: baseline.artifact,
    index: baseline.index,
    review: baseline.review,
    reviewTicks: progress?.ticks ?? {},
    reviewUnitTicks: progress?.unitTicks ?? {},
    reviewFileTicks: progress?.fileTicks ?? {},
    reviewComments: progress?.comments ?? [],
    reviewFiles: baseline.review ? deriveReviewFiles(baseline.review.context, baseline.artifact, baseline.index) : [],
    coverage: state.coverageMode ? computeCoverage(baseline.artifact.nodes, baseline.artifact.edges) : null,
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
