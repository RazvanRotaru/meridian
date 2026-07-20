/**
 * The PR-review artifact session: swap the loaded graph for the freshly-prepared PR-head artifact
 * (so the review computes in HEAD coordinates — the diff hunks' own line numbers), and retain only
 * the prior projection identity while the review is active. The store's `prepareHeadGraph` drives
 * the swap behind its stale-seq guard; starting another review or explicitly leaving review
 * history ends the session.
 * The coverage lives in store actions, not in any one component. Only TYPES are imported from the
 * store (erased at build), so there is no runtime cycle.
 */

import {
  collectChangedIds,
  syntheticScenarioDescriptorSchema,
} from "@meridian/core";
import type {
  GraphArtifact,
  LineRange,
  SyntheticScenarioDescriptor,
} from "@meridian/core";
import { applyChangedIds, type GraphIndex } from "../graph/graphIndex";
import type {
  GraphProjectionEndpoints,
  GraphProjectionRequest,
  StagedReviewProjection,
} from "../graph/graphProjectionClient";
import type { BlueprintState } from "./store";
import type { PrChangedFile } from "./prTypes";
import type { SyntheticExecutionTrust } from "./syntheticExecutionTrust";
import { withReachabilityTestIds } from "../derive/reachabilityFacts";

export interface PreparedSyntheticCapability {
  syntheticExecutionUrl: string | null;
  syntheticScenarios: SyntheticScenarioDescriptor[];
  syntheticExecutionTrust: SyntheticExecutionTrust | null;
}

/** Immutable identity the renderer already learned from the prepare stream (or saved review
 * session). An executable prepared capability is accepted only when its server-attested sandbox
 * provenance names this exact repository and commit. */
export interface PreparedGraphIdentity {
  repository: string | null;
  headSha: string | null;
}

/** A lightweight return coordinate for the prior graph view. The decoded pair remains solely in the
 * projection transport's bounded LRU and may be evicted/reloaded independently. */
export interface PrReviewBaseline {
  graphId: string;
  projectionKey: string;
  projectionId: string;
  request: GraphProjectionRequest;
  endpoints: GraphProjectionEndpoints;
  syntheticExecutionUrl: string | null;
  syntheticScenarios: SyntheticScenarioDescriptor[];
  syntheticExecutionTrust: SyntheticExecutionTrust | null;
}

/** Load bounded execution metadata independently from the graph projection. A malformed runnable
 * capability is a failed prepare, never a partially trusted UI. */
export async function fetchPreparedSyntheticCapability(
  metaUrl: string,
  expectedIdentity: PreparedGraphIdentity,
  signal?: AbortSignal,
): Promise<PreparedSyntheticCapability> {
  if (metaUrl === "") {
    throw new Error("this session has no meta endpoint to load prepared synthetic capabilities from");
  }
  const capability = await readPreparedSyntheticCapability(metaUrl, signal);
  assertPreparedCapabilityIdentity(capability, expectedIdentity);
  return capability;
}

/**
 * Make the prepared PR-head projection current. The original projection identity is saved once;
 * re-reviewing never creates a second decoded baseline outside the bounded transport cache.
 */
export function swapToPreparedReviewProjection(
  get: () => BlueprintState,
  set: (partial: Partial<BlueprintState>) => void,
  staged: StagedReviewProjection,
  invalidateArtifactCaches: () => void,
  headEndpoints: GraphProjectionEndpoints,
  capability: PreparedSyntheticCapability = currentSyntheticCapability(get()),
  commitState: Partial<BlueprintState> = {},
): void {
  try {
    const state = get();
    const baseline = state.prReviewBaseline ?? activeBaseline(state);
    const prepared = staged.projection;
    const head = prepared.head;
    // First entry retains the exact pre-review coordinate as its return target. On Resume/Refresh,
    // however, the currently mounted base/review projection may be a transient derivative of that
    // saved coordinate. It has no durable navigation owner once the prepared pair becomes active,
    // so supersede it atomically instead of leaking it into the recent-view LRU.
    const supersededCurrent = state.prReviewBaseline !== null
      && state.activeProjectionKey !== null
      && state.activeProjectionKey !== baseline.projectionKey
      ? [state.activeProjectionKey]
      : [];
    staged.commit({ supersededKeys: supersededCurrent });
    invalidateArtifactCaches();
    set({
      artifact: head.artifact,
      index: head.index,
      activeProjectionGraphId: head.graphId,
      activeProjectionRequest: head.request,
      activeProjectionKey: prepared.key,
      activeProjectionId: prepared.projectionId,
      activeProjectionEndpoints: headEndpoints,
      prReviewComparison: prepared.mergeBase,
      prReviewBaseline: baseline,
      prPreparedArtifactCurrent: true,
      reviewHeadRef: null,
      reviewDiffByFile: {},
      syntheticExecutionUrl: capability.syntheticExecutionUrl,
      syntheticScenarios: [...capability.syntheticScenarios],
      syntheticExecutionTrust: capability.syntheticExecutionTrust,
      ...resetSyntheticRunState(state),
      reviewBaseNodeIds: new Set<string>(),
      reviewDeletedNodeIds: new Set<string>(),
      reviewBaseSpanByHeadId: new Map<string, LineRange>(),
      // The outgoing report belongs to another revision. Prepared projections carry repository-wide
      // claims plus paint facts for this exact HEAD slice; never recompute claims from partial nodes.
      coverage: state.coverageMode && head.reachability !== null
        ? withReachabilityTestIds(head.reachability, head.index.testIds)
        : null,
      // An open code panel shows the outgoing artifact's node/lines — stale against the new graph.
      codeView: null,
      // Preview roots belong to the outgoing artifact/projection and must never cross the swap.
      moduleGhostInspection: null,
      // Descriptor/cursor state which identifies this exact pair publishes with the graph. Callers
      // must never expose a new projection beneath the prior review coordinate.
      ...commitState,
    });
  } finally {
    staged.release();
  }
}

/**
 * Reset an index's amber changed-id marking to the artifact's OWN tag-derived set (usually none).
 * `applyChangedIds` mutates whichever index is current when a review runs, so an index can carry a
 * finished PR's amber set; this wipes those leftovers so the restored/plain graph shows exactly its
 * own marking. Shared by the baseline restore and the base-graph overlay close (no baseline to swap).
 */
export function resetChangedIdsToArtifact(artifact: GraphArtifact, index: GraphIndex): void {
  applyChangedIds(index, collectChangedIds(artifact.nodes));
}

/**
 * Leave the prepared projection. Two modes:
 *  - `endSession` (default true): the review session is over — clear every review-owned field and
 *    the pre-expanded/seeded Map (starting another review or leaving it through browser history).
 *  - `endSession:false`: a SOFT close (the overlay closed mid-review) — leave the prepared graph and
 *    keep review/ticks/seeds/baseline/prepared-id so `resumePrReview` can re-open from them.
 * The decoded prior projection is deliberately not retained here; the store promotes it from the
 * bounded recent-view LRU when present, otherwise the next layout reloads it by request identity.
 */
export function restorePrReviewBaseline(
  get: () => BlueprintState,
  set: (partial: Partial<BlueprintState>) => void,
  invalidateArtifactCaches: () => void,
  options: { endSession?: boolean } = {},
): boolean {
  const endSession = options.endSession ?? true;
  const state = get();
  const baseline = state.prReviewBaseline;
  if (baseline === null) {
    return false;
  }
  invalidateArtifactCaches();
  const restoredSession: Partial<BlueprintState> = {
    prPreparedArtifactCurrent: false,
    prReviewComparison: null,
    prPreparedFileProjectionPending: null,
    prPreparedFileProjectionError: null,
    reviewBaseNodeIds: new Set<string>(),
    reviewDeletedNodeIds: new Set<string>(),
    reviewBaseSpanByHeadId: new Map<string, LineRange>(),
    codeView: null,
    moduleGhostInspection: null,
    syntheticExecutionUrl: baseline.syntheticExecutionUrl,
    syntheticScenarios: [...baseline.syntheticScenarios],
    syntheticExecutionTrust: baseline.syntheticExecutionTrust,
    ...resetSyntheticRunState(get()),
  };
  if (!endSession) {
    // Park only restart coordinates and user progress. ReviewData owns the artifact's LogicFlows,
    // while file/checklist/diff derivations retain graph-shaped presentation data; none may outlive
    // the projection cache's active/recent allocation. Resume reloads the immutable pair and derives
    // all of them again from a status-rich, detail-free file manifest.
    const parkedSource = state.prReviewSource === null
      ? null
      : { ...state.prReviewSource, files: lightweightReviewFiles(state.prReviewSource.files) };
    set({
      ...restoredSession,
      review: null,
      reviewAffectedIds: new Set<string>(),
      reviewFiles: [],
      reviewFileDelta: {},
      reviewGroups: null,
      reviewFocusedSubgraph: null,
      reviewAllSeedIds: [],
      reviewDiffByFile: {},
      reviewDiffLinesByFile: {},
      reviewCommentRangesByFile: {},
      reviewRemovedByFile: {},
      reviewRemovedTruncatedByFile: {},
      prReviewSource: parkedSource,
      ...(parkedSource !== null && state.prSelected === parkedSource.number
        ? { prFiles: parkedSource.files }
        : {}),
    });
    return true;
  }
  set({
    ...restoredSession,
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
    reviewAffectedIds: new Set(),
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
    minimalGraphHistory: [],
    reviewAllSeedIds: [],
    prReviewed: null,
    prReviewSource: null,
    prReviewRevision: null,
    prReviewStale: false,
    prReviewRefreshing: false,
    reviewHeadRef: null,
    reviewDiffByFile: {},
    reviewDiffLinesByFile: {},
    reviewBaseNodeIds: new Set<string>(),
    reviewDeletedNodeIds: new Set<string>(),
    reviewBaseSpanByHeadId: new Map<string, LineRange>(),
    reviewCommentRangesByFile: {},
    reviewRemovedByFile: {},
    reviewRemovedTruncatedByFile: {},
    prReviewBaseline: null,
    prPreparedHead: null,
    prPreparedMergeBase: null,
    prPreparedReviewCursor: null,
    prPreparedFileProjectionPending: null,
    prPreparedFileProjectionError: null,
    prPreparedChangedFiles: [],
    prPreparedHeadSha: null,
    prPreparedMergeBaseSha: null,
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

/** Keep only canonical PR membership/provenance while parked. Patch bodies, ranges, removed text,
 * and line maps are reconstituted from the immutable prepared projection on Resume. */
function lightweightReviewFiles(files: readonly PrChangedFile[]): PrChangedFile[] {
  return files.map((file) => ({
    path: file.path,
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
    ...(file.status === "renamed" && file.previousPath !== undefined
      ? { previousPath: file.previousPath }
      : {}),
  }));
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
 * for the exact PR repository + prepared commit; local or stale sandbox authority fails closed. */
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

async function readPreparedSyntheticCapability(
  metaUrl: string,
  signal?: AbortSignal,
): Promise<PreparedSyntheticCapability> {
  const response = await fetch(metaUrl, { signal });
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
  } else if (trust === null || scenarios.length === 0) {
    invalidPreparedCapability(trust === null ? "syntheticExecutionTrust" : "syntheticScenarios");
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

function activeBaseline(state: BlueprintState): PrReviewBaseline {
  if (
    state.activeProjectionGraphId === null
    || state.activeProjectionRequest === null
    || state.activeProjectionKey === null
    || state.activeProjectionId === null
    || state.activeProjectionEndpoints === null
  ) {
    throw new Error("cannot prepare a PR without an active graph projection identity");
  }
  return {
    graphId: state.activeProjectionGraphId,
    request: state.activeProjectionRequest,
    projectionKey: state.activeProjectionKey,
    projectionId: state.activeProjectionId,
    endpoints: state.activeProjectionEndpoints,
    syntheticExecutionUrl: state.syntheticExecutionUrl,
    syntheticScenarios: [...state.syntheticScenarios],
    syntheticExecutionTrust: state.syntheticExecutionTrust,
  };
}
