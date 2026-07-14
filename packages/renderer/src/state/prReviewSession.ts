/**
 * The PR-review artifact session: swap the loaded graph for the freshly-prepared PR-head artifact
 * (so the review computes in HEAD coordinates — the diff hunks' own line numbers), and restore the
 * boot pair while the review is parked. The store's `prepareHeadGraph` drives the swap behind its
 * stale-seq guard; starting another review or explicitly leaving review history ends the session.
 * The coverage lives in store actions, not in any one component. Only TYPES are imported from the
 * store (erased at build), so there is no runtime cycle.
 */

import {
  changedLineKindsFromExtensions,
  collectChangedIds,
  computeCoverage,
  syntheticScenarioDescriptorSchema,
} from "@meridian/core";
import type {
  ChangedLineSpan,
  GraphArtifact,
  LineRange,
  ReviewContext,
  SyntheticScenarioDescriptor,
} from "@meridian/core";
import { loadArtifact } from "../boot/loadArtifact";
import { applyChangedIds, applyChangedStatus, buildGraphIndex, type GraphIndex } from "../graph/graphIndex";
import type { FileMatch } from "../derive/matchAffectedFiles";
import { deriveReviewData, type ReviewData } from "../derive/reviewData";
import { deriveReviewProjection } from "../derive/reviewProjection";
import { readReviewProgress } from "./reviewTicksPref";
import { reviewNodeStatusEntries, reviewNodeStatusSourcesFromKinds } from "./reviewNodeStatus";
import type { BlueprintState } from "./store";
import type { SyntheticExecutionTrust } from "./syntheticExecutionTrust";

export interface PreparedSyntheticCapability {
  syntheticExecutionUrl: string | null;
  syntheticScenarios: SyntheticScenarioDescriptor[];
  syntheticExecutionTrust: SyntheticExecutionTrust | null;
}

export interface PreparedGraphSession extends PreparedSyntheticCapability {
  artifact: GraphArtifact;
}

/** Immutable identity the renderer already learned from the analyze stream (or saved review
 * session). An executable prepared capability is accepted only when its server-attested sandbox
 * provenance names this exact repository and commit. */
export interface PreparedGraphIdentity {
  repository: string | null;
  headSha: string | null;
}

/** The boot artifact/index (+ its artifact-carried review, if any), saved once when the first swap
 * happens so ending the session restores the exact graph the session booted with. */
export interface PrReviewBaseline {
  artifact: GraphArtifact;
  index: GraphIndex;
  review: ReviewData | null;
  syntheticExecutionUrl: string | null;
  syntheticScenarios: SyntheticScenarioDescriptor[];
  syntheticExecutionTrust: SyntheticExecutionTrust | null;
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

/** Load both halves of a prepared review session before committing either. A valid graph paired
 * with missing or malformed execution metadata is a failed prepare, not a partially capable UI. */
export async function fetchPreparedGraphSession(
  graphUrl: string,
  metaUrl: string,
  preparedGraphId: string,
  expectedIdentity: PreparedGraphIdentity,
): Promise<PreparedGraphSession> {
  if (metaUrl === "") {
    throw new Error("this session has no meta endpoint to load prepared synthetic capabilities from");
  }
  const preparedMetaUrl = new URL(metaUrl, requestOrigin());
  preparedMetaUrl.searchParams.set("id", preparedGraphId);
  const [artifact, capability] = await Promise.all([
    fetchPreparedArtifact(graphUrl, preparedGraphId),
    fetchPreparedSyntheticCapability(preparedMetaUrl.toString()),
  ]);
  assertPreparedCapabilityIdentity(capability, expectedIdentity);
  return { artifact, ...capability };
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
  capability: PreparedSyntheticCapability = currentSyntheticCapability(get()),
): void {
  const state = get();
  // Snapshot the review the BOOT artifact itself carries (if any) — never the live PR review:
  // the sync-first flow means a PR review is already running when the first head-extract swaps,
  // and session-end restore must not resurrect it.
  const baseline = state.prReviewBaseline ?? {
    artifact: state.artifact,
    index: state.index,
    review: deriveReviewData(state.artifact, state.index),
    syntheticExecutionUrl: state.syntheticExecutionUrl,
    syntheticScenarios: [...state.syntheticScenarios],
    syntheticExecutionTrust: state.syntheticExecutionTrust,
  };
  invalidateArtifactCaches();
  set({
    artifact: prepared,
    index: buildGraphIndex(prepared),
    prReviewBaseline: baseline,
    prPreparedArtifactCurrent: true,
    syntheticExecutionUrl: capability.syntheticExecutionUrl,
    syntheticScenarios: [...capability.syntheticScenarios],
    syntheticExecutionTrust: capability.syntheticExecutionTrust,
    ...resetSyntheticRunState(state),
    // The cached coverage report belongs to the outgoing artifact: recompute for the head graph
    // when coverage mode is showing, else drop it so the next toggle recomputes lazily.
    coverage: state.coverageMode ? computeCoverage(prepared.nodes, prepared.edges) : null,
    // An open code panel shows the outgoing artifact's node/lines — stale against the new graph.
    codeView: null,
    // Preview roots belong to the outgoing artifact/projection and must never cross the swap.
    moduleGhostInspection: null,
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
 *    the pre-expanded/seeded Map (starting another review or leaving it through browser history).
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
    moduleGhostInspection: null,
    syntheticExecutionUrl: baseline.syntheticExecutionUrl,
    syntheticScenarios: [...baseline.syntheticScenarios],
    syntheticExecutionTrust: baseline.syntheticExecutionTrust,
    ...resetSyntheticRunState(get()),
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
  const projection = baseline.review
    ? deriveReviewProjection(baseline.review.context, baseline.artifact, baseline.index, {
        baseIndex: null,
        showTests: get().showTests,
      })
    : null;
  if (projection !== null) {
    applyChangedIds(baseline.index, projection.affected.map((node) => node.nodeId));
    applyChangedStatus(
      baseline.index,
      reviewNodeStatusEntries(
        baseline.index,
        projection.affected,
        reviewNodeStatusSourcesFromKinds(changedLineKindsFromExtensions(baseline.artifact.extensions)),
      ),
    );
  }
  set({
    ...restoredGraph,
    review: projection?.review ?? null,
    reviewTicks: progress?.ticks ?? {},
    reviewUnitTicks: progress?.unitTicks ?? {},
    reviewFileTicks: progress?.fileTicks ?? {},
    reviewComments: progress?.comments ?? [],
    reviewFiles: projection?.files ?? [],
    reviewPanelHidden: false,
    reviewSubmitStatus: "idle",
    reviewSubmitError: null,
    reviewSubmittedUrl: null,
    reviewAffectedIds: new Set(projection?.affected.map((node) => node.nodeId) ?? []),
    reviewDiffOnly: false,
    reviewLitNodeIds: null,
    reviewSelectedId: null,
    flowSelection: null,
    flowPaneExpansionOverrides: new Set<string>(),
    logicSelected: null,
    flowPaneRfNodes: [],
    flowPaneRfEdges: [],
    flowPaneLayoutStatus: "idle",
    reviewFlowBaseline: null,
    reviewGroups: null,
    reviewActiveGroupId: null,
    reviewPathScope: null,
    reviewFocusedSubgraph: null,
    reviewAllSeedIds: [],
    prReviewed: null,
    prReviewSource: null,
    prReviewRevision: null,
    prReviewStale: false,
    prReviewRefreshing: false,
    reviewHeadRef: null,
    reviewDiffByFile: {},
    reviewCommentRangesByFile: {},
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

function currentSyntheticCapability(state: BlueprintState): PreparedSyntheticCapability {
  return {
    syntheticExecutionUrl: state.syntheticExecutionUrl,
    syntheticScenarios: [...state.syntheticScenarios],
    syntheticExecutionTrust: state.syntheticExecutionTrust,
  };
}

/** Disabled execution metadata carries no authority and can accompany an otherwise valid prepared
 * review graph. A runnable prepared capability, however, must be the sandboxed capability minted
 * for the exact PR repository + analyzed commit; local or stale sandbox authority fails closed. */
function assertPreparedCapabilityIdentity(
  capability: PreparedSyntheticCapability,
  expected: PreparedGraphIdentity,
): void {
  if (capability.syntheticExecutionUrl === null) {
    return;
  }
  const trust = capability.syntheticExecutionTrust;
  if (trust?.mode !== "sandboxed-pr") {
    throw new Error("prepared synthetic execution capability is not bound to a PR sandbox");
  }
  if (expected.repository === null || trust.provenance.repository !== expected.repository) {
    throw new Error("prepared synthetic execution repository provenance does not match this PR session");
  }
  if (expected.headSha === null || trust.provenance.headSha !== expected.headSha) {
    throw new Error("prepared synthetic execution head SHA provenance does not match the analyzed PR head");
  }
}

function resetSyntheticRunState(state: BlueprintState): Partial<BlueprintState> {
  const reset: Partial<BlueprintState> = {
    syntheticExecution: null,
    syntheticPreviousExecution: null,
    syntheticExecutionRootId: null,
    syntheticExecutionHost: null,
    syntheticExecutionStatus: "idle",
    syntheticExecutionError: null,
    syntheticExperimentRootId: null,
    syntheticInputOverrides: [],
    syntheticFieldWatchers: [],
    syntheticEditorRequest: null,
    syntheticSelectedMomentId: null,
    syntheticFlowOrientation: "vertical",
    syntheticFlowPresentation: "focused",
  };
  if (state.flowPaneOrigin === "synthetic") {
    Object.assign(reset, {
      flowSelection: null,
      flowPaneOrigin: null,
      requestFlowTraceId: null,
      requestFlowExpansionOverrides: new Set<string>(),
      flowPaneRfNodes: [],
      flowPaneRfEdges: [],
      flowPaneLayoutStatus: "idle",
    } satisfies Partial<BlueprintState>);
  }
  return reset;
}

async function fetchPreparedSyntheticCapability(metaUrl: string): Promise<PreparedSyntheticCapability> {
  const response = await fetch(metaUrl);
  if (!response.ok) {
    throw new Error(`prepared meta fetch failed (${response.status}) from ${metaUrl}`);
  }
  const body = await response.json() as unknown;
  if (typeof body !== "object" || body === null) {
    throw new Error("prepared meta returned an invalid synthetic execution capability");
  }
  const candidate = body as Record<string, unknown>;
  const rawUrl = candidate.syntheticExecutionUrl;
  const syntheticExecutionUrl = rawUrl === null
    ? null
    : typeof rawUrl === "string" && rawUrl.trim().length > 0
      ? rawUrl
      : invalidPreparedCapability("syntheticExecutionUrl");
  const rawScenarios = candidate.syntheticScenarios;
  if (!Array.isArray(rawScenarios)) invalidPreparedCapability("syntheticScenarios");
  const scenarios: SyntheticScenarioDescriptor[] = [];
  const scenarioIds = new Set<string>();
  for (const rawScenario of rawScenarios as unknown[]) {
    const parsed = syntheticScenarioDescriptorSchema.safeParse(rawScenario);
    if (!parsed.success || scenarioIds.has(parsed.data.id)) {
      invalidPreparedCapability("syntheticScenarios");
    }
    scenarioIds.add(parsed.data.id);
    scenarios.push(parsed.data);
  }
  const trust = parsePreparedTrust(candidate.syntheticExecutionTrust);
  if (syntheticExecutionUrl === null) {
    if (trust !== null || scenarios.length > 0) invalidPreparedCapability("disabled execution metadata");
  } else if (trust === null) {
    invalidPreparedCapability("syntheticExecutionTrust");
  }
  return { syntheticExecutionUrl, syntheticScenarios: scenarios, syntheticExecutionTrust: trust };
}

function parsePreparedTrust(value: unknown): SyntheticExecutionTrust | null {
  if (value === null) return null;
  if (typeof value !== "object" || value === null) invalidPreparedCapability("syntheticExecutionTrust");
  const candidate = value as Record<string, unknown>;
  if (candidate.mode !== "local" && candidate.mode !== "sandboxed-pr") {
    invalidPreparedCapability("syntheticExecutionTrust.mode");
  }
  const provenance = parsePreparedProvenance(candidate.provenance);
  if (candidate.mode === "sandboxed-pr") {
    if (provenance?.repository === undefined || provenance.headSha === undefined) {
      invalidPreparedCapability("syntheticExecutionTrust.provenance");
    }
    return { mode: "sandboxed-pr", provenance: { repository: provenance.repository, headSha: provenance.headSha } };
  }
  return provenance === undefined ? { mode: "local" } : { mode: "local", provenance };
}

function parsePreparedProvenance(value: unknown): SyntheticExecutionTrust["provenance"] {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null) invalidPreparedCapability("syntheticExecutionTrust.provenance");
  const candidate = value as Record<string, unknown>;
  const repository = optionalPreparedString(candidate.repository, "repository", 512);
  const headSha = optionalPreparedString(candidate.headSha, "headSha", 128);
  return repository === undefined && headSha === undefined ? undefined : { repository, headSha };
}

function optionalPreparedString(value: unknown, field: string, maxLength: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0 || value.trim().length > maxLength) {
    invalidPreparedCapability(`syntheticExecutionTrust.provenance.${field}`);
  }
  return value.trim();
}

function invalidPreparedCapability(field: string): never {
  throw new Error(`prepared meta returned invalid ${field}`);
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
      changedSince: { baseRef: `pr#${prNumber}`, source: "pr-review", files: changedFiles, kinds: changedKinds },
    },
  } as unknown as GraphArtifact;
}

/** Whether changedSince was synthesized client-side by withPrLineDiff. Unlike an extractor-owned
 * stamp, this projection must be regenerated whenever the Tests toggle changes its file set. */
export function hasPrReviewLineDiff(artifact: GraphArtifact): boolean {
  return (artifact.extensions as { changedSince?: { source?: unknown } } | undefined)
    ?.changedSince?.source === "pr-review";
}

function requestOrigin(): string {
  return typeof window === "undefined" ? "http://meridian.local" : window.location.origin;
}
