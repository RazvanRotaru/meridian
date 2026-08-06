/**
 * The single zustand store. `moduleExpanded` starts EMPTY so only roots show (progressive
 * disclosure begins at the package/system level), and `environment` starts null and is NEVER
 * auto-set or defaulted to prod. Every structural mutation bumps its surface's layout sequence and
 * re-runs the derive pipeline behind a stale guard so a slow ELK pass can never overwrite a newer one.
 */

import { createStore, type StoreApi } from "zustand/vanilla";
import type { Edge, Node } from "@xyflow/react";
import {
  buildNodeId,
  changedDiffLinesFromExtensions,
  changedFileManifestFromExtensions,
  changedLineKindsFromExtensions,
  changedLineStatsFromExtensions,
  changedRangesFromExtensions,
  computeAffectedNodes,
  computeChangeGroups,
  computeCoverage,
  createPrReviewProgressSnapshot,
  reducePrReviewProgress,
} from "@meridian/core";
import type {
  AffectedNode,
  ChangedDiffLine,
  ChangedDiffLines,
  ChangedLineKind,
  ChangedLineSpan,
  ChangeGroupsResult,
  CoverageReport,
  FlowSourceAnchor,
  FlowPath,
  FlowStep,
  GraphArtifact,
  GraphProjectionV1,
  CompactGraphSymbolEntry,
  GraphNode,
  JsonValue,
  LineRange,
  LogicFlows,
  NodeId,
  NodeMetrics,
  RequestTrace,
  ReviewContext,
  PrReviewProgressSnapshot,
  SyntheticExecution,
  SyntheticFieldWatcher,
  SyntheticInputOverride,
  SyntheticScenarioDescriptor,
  TraceBundle,
  TraceGraphRef,
} from "@meridian/core";
import { applyChangedIds, applyChangedStatus, buildGraphIndex, type GraphIndex } from "../graph/graphIndex";
import {
  changedFileProjectionRequest,
  fetchGraphProjection,
  fetchGraphSymbols,
  fileProjectionRequests,
  hydrateHeadProjectionForComparisonContext,
  isProjectionReadyForCanvas,
  mergeGraphProjections,
  projectionToArtifact,
  warmGraphProjection,
  MAX_GRAPH_SYMBOL_RESPONSE_BYTES,
} from "./progressiveGraph";
import {
  createGraphSymbolSearchClient,
  GraphSymbolSearchSupersededError,
  graphSymbolIndexSummary,
  graphSymbolSearchWorkerAvailable,
  type GraphSymbolIndexSummary,
  type GraphSymbolSearchClient,
} from "./graphSymbolSearchClient";
import type {
  GraphSymbolSearchEntry,
  GraphSymbolSearchQuery,
  GraphSymbolSearchQueryResult,
  GraphSymbolSearchScopeCounts,
} from "./graphSymbolSearch";
import { matchAffectedFiles } from "../derive/matchAffectedFiles";
import { isReviewPathInScope, normalizeReviewPathScope } from "../derive/reviewPathScope";
import { isSourceBackedNode } from "../derive/sourceBackedNode";
import { rollupSeeds } from "../derive/seedRollup";
import { minimalGraphConnectorIds } from "../derive/minimalGraphConnectors";
import { filesInScope } from "../derive/filesInScope";
import { deriveRequestGraphOverlay } from "../derive/requestGraphOverlay";
import { traceGraphRefMismatches } from "../derive/requestTimelineModel";
import {
  deriveMinimalCodebaseContext,
  type MinimalCodebaseContext,
} from "../derive/minimalCodebaseContext";
import type { LogicNodeData } from "../derive/logicGraph";
import type {
  TelemetryProvider,
  TelemetrySourceDescriptor,
  TelemetrySourceRegistration,
} from "../telemetry/provider";
import type { ViewMode } from "../derive/edgeSelection";
import { relatedNodeIds, type FlowSelectionRef } from "../derive/flowBlocks";
import { idsToExpand, idsToCollapse, type ExpandableNode } from "../derive/scopedExpansion";
import {
  reviewViewedTargetFor,
  reviewViewedTargetState,
} from "../derive/reviewNodeViewed";
import type { LogicViewMode } from "../derive/flowViewModel";
import { deriveLogicLayout } from "./deriveLogicLayout";
import { deriveFlowPaneLayout } from "./deriveFlowPaneLayout";
import { deriveFocusedRequestFlowPaneLayout, deriveRequestFlowPaneLayout } from "./deriveRequestFlowPaneLayout";
import { defaultSyntheticMomentId, syntheticOccurrenceSteps } from "../synthetic/syntheticFlowModel";
import { requestSyntheticExecution } from "../synthetic/client";
import type { SyntheticExecutionTrust } from "./syntheticExecutionTrust";
import type {
  GraphViewLeaseController,
  GraphViewLeaseHandoff,
} from "../boot/graphViewLease";
import { layoutModuleTree } from "../layout/moduleLevelLayout";
import {
  deriveMinimalGraphLayout,
  explicitRootVisibleIds,
  reviewDiffVisibleIds,
} from "./deriveMinimalGraphLayout";
import { minimalRollupExpansions } from "../derive/minimalRollupExpansion";
import { captureMapPositions, promotedMemberRect } from "./mapPositions";
import type { PlacedRect } from "../layout/minimalPlacement";
import { buildModuleGraph, type ModuleGraph } from "../derive/moduleGraph";
import { levelChildren, type NavChild } from "../derive/breadcrumbNav";
import { buildBlockDeps, UNIT_CARD_KINDS, type BlockDeps } from "../derive/blockDeps";
import type { GhostData } from "../derive/ghostDeps";
import { buildUnitIndex, type UnitIndex } from "@meridian/design-metrics";
import { extraRoots, type VisibleModuleNode } from "../derive/moduleTree";
import { decorateGhostInspectionTree } from "../derive/ghostInspection";
import { moduleChildContainerIds } from "../derive/moduleChildContainers";
import { serviceScopeFor, widenServiceScope, type ServiceScope } from "./serviceScope";
import { expandServiceSyntheticAnchors, leadIdOf } from "../derive/serviceClusterEdges";
import { clusteringFor } from "../derive/serviceClusteringCache";
import { deriveServiceDomains, isServiceDomainId, serviceDomainById } from "../derive/serviceDomains";
import {
  DEFAULT_SERVICE_GROUPING_LABEL_MODE,
  SERVICE_GROUPING_OPTIONS,
  type ServiceGroupingLabelMode,
  type ServiceGroupingMode,
} from "../derive/serviceClusteringModes";
import type { ModuleCategory } from "../derive/moduleCategory";
import type { HighlightMode } from "../components/moduleMapPaint";
import { expandedSelectionByOneHop, type SelectionEdge, type SelectionNode } from "../derive/selectionExpansion";
import {
  activeModuleSurfaceSpec,
  moduleSurfaceSpec,
  type SurfaceSemanticParent,
} from "../components/canvas/surfaceSpec";
import {
  composeSemanticStackLayouts,
  prepareSemanticModuleStack,
  retainSemanticStackFromDepth,
  type SemanticAncestorLevel,
  type SemanticOuterTree,
} from "../derive/moduleSemanticComposite";
import { readSolidMetricsPref, writeSolidMetricsPref } from "./solidMetricsPref";
import {
  readReviewPreferences,
  writeReviewPreferences,
  type ReviewCodePreviewTrigger,
  type ReviewFlowSplitView,
} from "./reviewPreferences";
import { isCanonicalFileNode, moduleRevealStateFor, nearestModuleIds } from "./flowExplorer";
import {
  anchorNodeIds,
  mapRevealStateForMany,
  resolveServiceAnchors,
  serviceRevealStateForMany,
  uiRevealStateForMany,
} from "./lensPath";
import type { LogicFlowOrientation, LogicRfNode, LogicRfEdge } from "../layout/logicElk";
import {
  edgeEvidenceKey,
  type EdgeEvidenceContext,
} from "../graph/edgeEvidence";
import {
  PRS_UNAVAILABLE_ERROR,
  type LineEdit,
  type PrChangedFile,
  type PrChecks,
  type PrDiscussionResult,
  type PrFilesResponse,
  type PrFileStatus,
  type PrFileViewedState,
  type PrListResponse,
  type PrOneResponse,
  type PrReviewCommentSide,
  type PrReviewSubmissionEvent,
  type PrSessionSource,
  type PrSummary,
  type PrViewedFileMutationResponse,
  type PrViewedFilesMutationResponse,
  type PrViewedFilesResponse,
  type ReviewCommentFilter,
  type PrsTab,
  type RelatedPrsResponse,
  type RelatedPrsState,
} from "./prTypes";
import {
  normalizePrSearchQuery,
  prSearchCacheKey,
  type PrSearchCacheEntry,
} from "./prSearch";
import { headKindsWithin, headSpanFor } from "./headSpan";
import {
  reviewNodeStatusEntries,
  reviewNodeStatusSourcesFromDiff,
  reviewNodeStatusSourcesFromKinds,
  reviewSourceChangeStatus,
} from "./reviewNodeStatus";
import {
  streamPrAnalysis,
  type PrAnalysisReadyResult,
  type PrAnalysisResult,
  type PrPrepareStage,
} from "./prAnalysis";
import { isPrReviewStale, prReviewRevisionKey, reviewRevision, type PrReviewRevision } from "./prReviewFreshness";
import {
  discardReviewLineComposer as discardReviewLineComposerState,
  keepEditingReviewLineComposer as keepEditingReviewLineComposerState,
  matchesReviewLineComposerTarget,
  openReviewLineComposer as openReviewLineComposerState,
  requestReviewLineComposerDismiss as requestReviewLineComposerDismissState,
  setReviewLineComposerBody as setReviewLineComposerBodyState,
  type ReviewLineComposerState,
} from "./reviewLineComposer";
import {
  fetchPreparedArtifact,
  fetchPreparedGraphSession,
  fetchPreparedSyntheticCapabilityForGraph,
  hasPrReviewLineDiff,
  resetChangedIdsToArtifact,
  restorePrReviewBaseline,
  swapToPreparedArtifact,
  withPrLineDiff,
  type PrReviewBaseline,
  type PrReviewComparison,
  type PreparedGraphSession,
} from "./prReviewSession";
import { deriveReviewData, applyTick, type ReviewData } from "../derive/reviewData";
import {
  readReviewProgress,
  setReviewTick,
  writeReviewProgress,
  type ReviewComment,
  type ReviewProgress,
  type ReviewTick,
} from "./reviewTicksPref";
import { reviewContextFromPrFiles } from "../derive/prReviewContext";
import { canonicalPrReviewScope } from "../derive/prReviewScope";
import {
  applyFilesToggle,
  fileViewState,
  promoteFullyViewedUnitTicks,
  removeReviewFileTick,
  removeReviewUnitTicks,
  setReviewUnitsViewed,
  tickForFile,
  unitViewState,
  unitsViewState,
  type ReviewFileRow,
  type ReviewUnitCoordinates,
  type ReviewUnitProvenance,
  type ReviewUnitRow,
} from "../derive/reviewFiles";
import { deriveReviewProjection } from "../derive/reviewProjection";
import { deriveDeletedNodeProjection, type DeletedNodeProjection } from "../derive/deletedNodeProjection";
import { canonicalPrFiles } from "../derive/canonicalPrFiles";
import { filterFormattingOnlyPrFiles } from "../derive/formattingOnlyPrFiles";
import {
  filterFormattingOnlyReviewContext,
  formattingAwareArtifactDiff,
} from "../derive/formattingOnlyReviewContext";
import { expandReviewScopeBaseUnits, type ReviewScopeBaseNodes } from "../derive/reviewScopeExpansion";
import { buildReviewSubmission, reviewDraftIsVisible } from "../derive/reviewSubmit";
import {
  DEFAULT_SERVICE_GROUPING_TARGET_SIZE,
  isServiceGroupingTargetSize,
  type ServiceGroupingTargetSize,
} from "./serviceGroupingTargetSize";
import { yieldForPaint } from "./yieldForPaint";
import {
  EMPTY_RELATION_VISIBILITY_OVERRIDES,
  resetRelationsToPolicyDefaults,
  showAllRelations,
  toggleRelationOverride,
  type RelationVisibilityOverrides,
} from "../graph/relationVisibility";
import {
  captureMinimalGraphHistory,
  restoreMinimalGraphHistory,
  type MinimalGraphHistoryEntry,
} from "./minimalGraphHistory";
import { resolveFlowStep } from "../derive/minimalExpansion";

/**
 * The "All" setting for the related-flows depth dial: a depth larger than any real call-graph chain.
 * `transitiveCallers`' BFS terminates when the frontier empties (no more callers to visit), so 99 ≡
 * "the entire transitive-caller closure" — it just never bottoms out on a real graph — with no perf
 * risk, since the walk is bounded by the callers that exist, not by this number.
 */
export const GHOST_DEPTH_ALL = 99;

export type LayoutStatus = "idle" | "laying-out" | "ready" | "error";
export type FlowPaneOrigin = "explorer" | "request" | "synthetic";
export type SyntheticExecutionHost = "flow-pane" | "logic";

export interface RunSyntheticExecutionArgs {
  rootId: NodeId;
  scenarioId: string;
  input: JsonValue;
  host: SyntheticExecutionHost;
  /** Ephemeral confirmation from the currently open editor. Never copied into store state. */
  sandboxConsent?: boolean;
}

/** One in-flight layout request's copy. It is snapshotted at the initiating action, never inferred
 * later from sticky lens settings, and cleared only by that request's winning completion/failure. */
export interface LayoutActivity {
  label: string;
  detail?: string;
}

/** Session-only, read-before-pinning exploration of off-level call neighbours. Exact artifact ids
 * temporarily join the current tree as roots, while the anchors retain the ring from which the
 * reader entered the path. Nothing here is URL encoded or written to the permanent `mapExtra` set. */
export interface ModuleGhostInspection {
  anchorIds: Set<string>;
  visitedIds: Set<string>;
}

/** Lens-owned state carried by an already-mounted semantic parent. The compositor treats this as
 * opaque metadata; the surface spec supplies it and the generic commit applies it atomically. */
type SurfaceSemanticContext = NonNullable<SurfaceSemanticParent["context"]>;

/** The source view's state: which node, its fetched code, and the in-flight/error status.
 * `mode` decides where it renders — compact inline, or in the large source host (the centered node
 * modal or, when `edgeEvidence` is present, the graph-local inspection dock). */
export interface CodeView {
  node: GraphNode;
  code: string | null;
  /** Exact source rows represented by `code`. Distinguishes an empty file from one blank line. */
  lineCount?: number;
  loading: boolean;
  error: string | null;
  /** Where the code shows: a compact panel hanging off the node, or a large source surface. */
  mode: "inline" | "modal";
  /** The server capped the snippet; the panel shows a note when set. */
  truncated?: boolean;
  /** First line number of `code`: the node's start for a node slice, 1 when the whole file is shown.
   * Anchors the gutter numbers and the diff paint; defaults to the node's start when absent. */
  baseLine?: number;
  /** The whole file is shown (scrolled to the first change) rather than just the node's own span. */
  wholeFile?: boolean;
  /** PR-review only: head-relative change kinds for THIS panel (from the PR's own diff, not the
   * global changedSince). When set, the panel paints these — so the code shown is the PR head and
   * the highlight is exactly its added/modified lines, even on the synchronous (base-graph) review. */
  changedLineKinds?: ReadonlyMap<number, ChangedLineKind>;
  changedLines?: ReadonlySet<number>;
  /** Exact ordered +/- rows from the canonical unified diff. Unlike `changedLineKinds`, these
   * retain deleted text and old/new coordinates and are therefore the source of truth for source
   * rendering, row counts, and parity tests. */
  diffLines?: readonly ChangedDiffLine[];
  /** Exact comparison-side span for this surviving declaration. `null` means the comparison graph
   * proved that no counterpart exists; `undefined` keeps the legacy cursor-only fallback when no
   * comparison graph is available. Whole-file/module views intentionally leave this undefined. */
  diffOldSpan?: LineRange | null;
  /** Which side `code` belongs to. Normally HEAD; a removed file has no HEAD source, so its base
   * snippet is rendered directly as deleted rows instead of duplicating it as ghost text. */
  sourceSide?: "head" | "base";
  /** Presentation-only structural range inside `node`. It is expressed in the coordinates of the
   * displayed source and must never participate in diff ownership or commentability. */
  previewFocus?: LineRange;
  /** Edge-click mode: the concrete syntax occurrences behind the aggregate wire and the currently
   * loaded one. Its focus range is in the coordinates of the code being shown (HEAD during a
   * synchronous PR review, otherwise artifact/source coordinates). Presence moves the large source
   * surface into the graph-local edge inspection dock. */
  edgeEvidence?: {
    contexts: readonly EdgeEvidenceContext[];
    activeIndex: number;
    focusStartLine: number;
    focusEndLine: number;
  };
}

export interface CodePreviewOptions {
  /** Exact control statement inside the canonical enclosing callable. */
  focus?: FlowSourceAnchor;
}

/** A review container opened as its own exact-file graph. Navigation history is owned by the
 * generic minimal-graph stack, so this value only scopes the review panel to the current frame. */
export interface ReviewFocusedSubgraph {
  rootId: string;
  label: string;
  filePaths: string[];
  moduleIds: string[];
}

export const DEFAULT_PROGRESSIVE_GRAPH_DEPTH = 1;
export const MAX_PROGRESSIVE_GRAPH_DEPTH = 6;
const INITIAL_PROGRESSIVE_GRAPH_PREFETCH_DEPTH = 3;
const MAX_PROGRESSIVE_AUTOWARM_DEPTH = 2;

export interface ProgressiveGraphSessionState {
  /** Authoritative bounded HEAD slice; the displayed review may also contain base tombstones. */
  head: GraphProjectionV1;
  /** Authoritative bounded exact merge-base slice used for deleted-node derivation. */
  comparison: GraphProjectionV1 | null;
  /** Disconnected HEAD files explicitly admitted through search/ghost interaction. They participate
   * in every later depth change just like the affected-file roots. */
  explicitFileIds: string[];
  /** Deepest affected-file-rooted slice merged into HEAD; explicit search roots track their own
   * per-file frontier and must not inflate this cursor. */
  affectedDepth: number;
  requestedDepth: number;
  status: "ready" | "expanding" | "error";
  error: string | null;
}

export interface ProgressiveSymbolIndexState {
  status: "idle" | "indexing" | "ready" | "error";
  graphId: string | null;
  generation: string | null;
  /** Production repository rows live in the persistent search Worker. Omitted/false is the bounded
   * fetch-only fallback used by tests, legacy WebViews, and manually constructed store fixtures. */
  workerBacked?: boolean;
  symbols: CompactGraphSymbolEntry[];
  indexed: number;
  total: number;
  error: string | null;
}

/** A one-sided empty projection is valid for added-only/deleted-only PRs; admission requires at
 * least one ready root across the exact HEAD/merge-base pair. */
export function isProgressiveProjectionPairReady(
  head: GraphProjectionV1,
  comparison: GraphProjectionV1 | null,
): boolean {
  const sideReady = (projection: GraphProjectionV1): boolean => projection.rootFileIds.length === 0
    ? projection.loadedDepth >= projection.requestedDepth
    : isProjectionReadyForCanvas(projection);
  return sideReady(head)
    && (comparison === null || sideReady(comparison))
    && (
      head.rootFileIds.length + (comparison?.rootFileIds.length ?? 0) > 0
      || isProgressiveManifestOnlyPairReady(head, comparison)
    );
}

/** True only for independently extractable slices stamped by the server with their immutable
 * logical graph lineage. Such a slice must never fall back to loading its backing artifact as if
 * that artifact claimed repository completeness. */
function isPartialOnlyProjection(projection: GraphProjectionV1 | null): boolean {
  const value = projection?.extensions?.prPartialGraph;
  if (typeof value !== "object" || value === null || Array.isArray(value) || projection === null) {
    return false;
  }
  const lineage = value as Record<string, unknown>;
  return lineage.version === 1
    && lineage.graphId === projection.graphId
    && lineage.generation === projection.generation;
}

function isPartialPrGraphId(graphId: string | null): boolean {
  return graphId !== null
    && /^pr-partial-(?:base-)?[a-f0-9]{20}-[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(graphId);
}

/** Narrow a progressive terminal to the same exact-revision bounded-pair contract as `ready`.
 * Legacy complete terminals deliberately return null: production must not treat their ids as a
 * second graph source or route them through `/api/graph`. */
function authoritativePartialAnalysisResult(
  result: PrAnalysisResult,
): PrAnalysisReadyResult | null {
  const comparisonGraphId = result.comparisonGraphId;
  const headSha = result.headSha;
  const mergeBaseSha = result.mergeBaseSha;
  const pairId = result.pairId;
  if (
    result.completeness !== "provisional"
    || typeof pairId !== "string"
    || !/^[a-f0-9]{20}$/.test(pairId)
    || comparisonGraphId === null
    || comparisonGraphId === result.graphId
    || headSha === null
    || mergeBaseSha === null
    || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(headSha)
    || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(mergeBaseSha)
  ) {
    return null;
  }
  return {
    ...result,
    comparisonGraphId,
    headSha,
    mergeBaseSha,
    pairId,
    completeness: "provisional",
  };
}

function samePartialAnalysisPair(
  ready: PrAnalysisReadyResult,
  terminal: PrAnalysisReadyResult,
): boolean {
  return ready.pairId === terminal.pairId
    && ready.graphId === terminal.graphId
    && ready.comparisonGraphId === terminal.comparisonGraphId
    && ready.headSha === terminal.headSha
    && ready.mergeBaseSha === terminal.mergeBaseSha;
}

/** Admit an intentionally empty graph only when the HEAD projection carries a complete non-empty
 * changed-file manifest and the exact merge-base projection independently resolved that same seed
 * to no files. This is the docs/binary-only fast path; it must not turn a malformed, one-sided, or
 * legacy zero-match response into a review. */
export function isProgressiveManifestOnlyPairReady(
  head: GraphProjectionV1,
  comparison: GraphProjectionV1 | null,
): boolean {
  if (
    comparison === null
    || head.seedGraphId !== head.graphId
    || comparison.seedGraphId !== head.graphId
    || head.rootFileIds.length > 0
    || comparison.rootFileIds.length > 0
    || head.loadedFileIds.length > 0
    || comparison.loadedFileIds.length > 0
    || head.counts.slice.files > 0
    || comparison.counts.slice.files > 0
    || head.loadedDepth < head.requestedDepth
    || comparison.loadedDepth < comparison.requestedDepth
  ) {
    return false;
  }
  const manifest = changedFileManifestFromExtensions(head.extensions);
  return manifest !== null && manifest.length > 0;
}

function projectionRootsCompleteThrough(
  projection: GraphProjectionV1,
  depth: number,
): boolean {
  if (projection.rootFileIds.length === 0) return projection.loadedDepth >= depth;
  const ready = new Set(projection.readyFileIds);
  const frontier = new Map(projection.frontier.map((entry) => [entry.fileId, entry.completeThroughDepth]));
  return projection.rootFileIds.every((fileId) =>
    ready.has(fileId) && (frontier.get(fileId) ?? -1) >= depth,
  );
}

/** Aggregate loadedDepth is insufficient after disconnected roots are merged. Every root carries
 * its own completeness proof and the depth control is ready only when both immutable sides do. */
export function isProgressiveSessionDepthReady(
  session: Pick<ProgressiveGraphSessionState, "head" | "comparison">,
  depth: number,
): boolean {
  return projectionRootsCompleteThrough(session.head, depth)
    && (session.comparison === null || projectionRootsCompleteThrough(session.comparison, depth));
}

function settledProgressiveSession(
  session: ProgressiveGraphSessionState | null,
): ProgressiveGraphSessionState | null {
  if (session === null) return null;
  const completeDepth = (projection: GraphProjectionV1): number => {
    if (projection.rootFileIds.length === 0) return projection.loadedDepth;
    const frontier = new Map(projection.frontier.map((entry) => [entry.fileId, entry.completeThroughDepth]));
    return Math.min(...projection.rootFileIds.map((fileId) => frontier.get(fileId) ?? 0));
  };
  const proven = Math.min(
    completeDepth(session.head),
    session.comparison === null ? MAX_PROGRESSIVE_GRAPH_DEPTH : completeDepth(session.comparison),
  );
  return {
    ...session,
    requestedDepth: Math.max(1, Math.min(session.requestedDepth, proven)),
    status: "ready",
    error: null,
  };
}

function settledProgressiveSymbols(
  symbols: ProgressiveSymbolIndexState,
): ProgressiveSymbolIndexState {
  // A worker-backed snapshot cannot carry its closure-owned live Worker through transactional graph
  // rollback. Restore it as idle so the next actionable/palette trigger creates a fresh generation-
  // bound client. Inline test/legacy inventories are value-owned and remain safe to restore ready.
  if (symbols.status === "ready" && symbols.workerBacked !== true) return symbols;
  return {
    status: "idle",
    graphId: null,
    generation: null,
    symbols: [],
    indexed: 0,
    total: 0,
    error: null,
  };
}

export interface BlueprintState {
  artifact: GraphArtifact;
  index: GraphIndex;
  /** Which relationship story is on screen: the call graph, or the React composition tree. */
  viewMode: ViewMode;
  /** Whether test code (nodes tagged/heuristically detected as tests) is drawn at all. */
  showTests: boolean;
  /** Coverage lens: imported runtime counters when present, otherwise estimated static reachability. */
  coverageMode: boolean;
  /** Computed once, on first entering coverage mode (the artifact never changes after boot). */
  coverage: CoverageReport | null;
  /** Whether request telemetry controls, runtime paint, and request-only surfaces are visible.
   * Loaded data stays resident when this presentation mode is off so re-entry is instant. */
  telemetryMode: boolean;
  /** The callable whose intra-procedural logic flow the Logic-flow view charts; null == none picked yet. */
  logicRoot: NodeId | null;
  /** Which PROJECTION of the charted flow is on screen (exec graph / metro / blocks / timeline).
   * All four render the same flow tree and share root/trail/selection — a pure view switch, sticky
   * across navigation like ghostDepth. */
  logicView: LogicViewMode;
  /** The drill trail into logic flows, oldest first — root..current — powering the logic breadcrumb. */
  logicStack: NodeId[];
  /** The DIVE trail INTO control containers, oldest first; each entry re-charts the canvas to show
   * only that container's bodies. Empty == show the whole callable flow. It sits ON TOP of the
   * callable's `logicStack` in the breadcrumb (a container lives inside the current callable). */
  logicFocus: Array<{ id: string; label: string; bodies: FlowPath[] }>;
  /** How many levels of resolved calls the Logic-flow view inlines in place; 0 == calls are leaf
   * chips (today's behavior). Sticky across open/drill so the reader keeps their chosen depth. */
  logicInlineDepth: number;
  /** Static-reachability fallback only: whether tests with direct resolved calls are drawn as ghost
   * nodes above the flow. Runtime aggregate reports deliberately provide no test identity. */
  showLogicTests: boolean;
  /** The selected call TARGET in the Logic-flow view; null == nothing picked. Selection is by
   * target id (not call site), so every same-target call site — the "direct links" — highlights
   * for free. Cleared whenever the charted flow changes so a stale selection can't linger. */
  logicSelected: NodeId | null;
  /** How many hops of INDIRECT callers the "related flows" ghosts reach back over the reverse call
   * graph: 1 == direct callers only (today's behavior), up to 3. Sticky across navigation; it's a
   * repaint-only setting — the view recomputes the ghosts in a useMemo, no relayout. */
  ghostDepth: number;
  /** Flow-root ids the reader pinned for quick access. Session-scoped, survives navigation. */
  pinnedFlows: NodeId[];
  /** Logic-graph nodes the reader toggled AWAY from their default expansion (calls default
   * collapsed; loops/try default expanded) — an expand/collapse flips membership. */
  expandedLogic: Set<string>;
  /** Stable semantic edge keys folded in the full Logic lens. Kept independent from whole-node
   * disclosure so reopening an if/try restores the reader's per-path choices. */
  collapsedLogicEdges: Set<string>;
  /** Hide the non-expandable (greyed) building-block leaves in the Logic graph. */
  hideGreyed: boolean;
  /** Nest consecutive same-owner calls under service frames in the Logic graph. Default OFF (flat):
   * the framing is opt-in, so the flow reads as plain blocks unless the reader turns it on. */
  nestByService: boolean;
  /** Phase-1 Code flows explorer state: the selection is shared by the tree and panes. */
  flowExplorerOpen: boolean;
  flowSelection: FlowSelectionRef | null;
  /** Why the shared split pane is open. Request inspection deliberately reuses its Logic layout
   * without inheriting the explorer/PR reveal semantics. */
  flowPaneOrigin: FlowPaneOrigin | null;
  /** The captured request owning a runtime-derived split. Kept separate from `flowSelection`, which
   * always denotes one static artifact flow and must never collapse repeated request occurrences. */
  requestFlowTraceId: string | null;
  /** Request-occurrence/static-child ids toggled away from Exec's defaults. Empty means every
   * top-level request occurrence is collapsed; nested call/control ids retain Exec's XOR semantics. */
  requestFlowExpansionOverrides: Set<string>;
  /** Static explorer/review-flow occurrence ids toggled away from Logic's defaults. This pane owns
   * an isolated override set so expanding here never mutates the separately mounted Logic lens. */
  flowPaneExpansionOverrides: Set<string>;
  /** Stable semantic edge keys folded in the shared static/request/synthetic split pane. Runtime
   * occurrence ids and static flow ids are namespaced, so one set remains collision-free. */
  flowPaneCollapsedEdges: Set<string>;
  /** Explicit server capability plus its bounded, advertised harnesses. These are independent of
   * telemetry sources: running trusted local code never changes environment/source selection. */
  syntheticExecutionUrl: string | null;
  syntheticExecutionTrust: SyntheticExecutionTrust | null;
  syntheticScenarios: SyntheticScenarioDescriptor[];
  /** One opt-in run attached to the currently selected static flow. `flowSelection` and the PR
   * review baseline remain authoritative while this execution temporarily owns the lower pane. */
  syntheticExecution: SyntheticExecution | null;
  /** The immediately preceding successful run for the same root and scenario. Retained only for
   * session-local before/after comparison; unrelated scenarios never become a false baseline. */
  syntheticPreviousExecution: SyntheticExecution | null;
  /** The root and UI surface that initiated the current/in-flight run. Unlike the completed
   * execution payload these also exist while the runner is still working, so controls scope cleanly. */
  syntheticExecutionRootId: NodeId | null;
  syntheticExecutionHost: SyntheticExecutionHost | null;
  syntheticExecutionStatus: "idle" | "running" | "ready" | "error";
  syntheticExecutionError: string | null;
  /** Session-only experiments staged against one flow root. They deliberately stay out of URL and
   * browser persistence because inputs can contain sensitive data. */
  syntheticExperimentRootId: NodeId | null;
  syntheticInputOverrides: SyntheticInputOverride[];
  syntheticFieldWatchers: SyntheticFieldWatcher[];
  /** One-shot request from an entry point (notably a PR impacted-flow row) to open the matching
   * synthetic editor as soon as that flow surface mounts. */
  syntheticEditorRequest: { rootId: NodeId; host: SyntheticExecutionHost } | null;
  /** Runtime moment id, not target node id: repeated calls keep independent inspection identity. */
  syntheticSelectedMomentId: string | null;
  /** Focused synthetic callable layout. This is intentionally independent from the main Logic view. */
  syntheticFlowOrientation: LogicFlowOrientation;
  syntheticFlowPresentation: "focused" | "overview";
  flowPaneRfNodes: LogicRfNode[];
  flowPaneRfEdges: LogicRfEdge[];
  flowPaneLayoutStatus: LayoutStatus;
  /** Review-only snapshot captured before the first flow opens, so closing/switching back to file
   * review restores the exact graph curation and declaration expansion the reader had. */
  reviewFlowBaseline: {
    moduleSelected: Set<string>;
    moduleExpanded: Set<string>;
    minimalSeedIds: string[];
    minimalMemberIds: string[];
    minimalBasePositions: Record<string, PlacedRect>;
    minimalArrange: boolean;
    reviewSelectedId: NodeId | null;
    reviewLitNodeIds: Set<NodeId> | null;
  } | null;
  /** The laid-out Logic graph (React Flow), recomputed on open/drill/expand/toggle via ELK. */
  logicRfNodes: LogicRfNode[];
  logicRfEdges: LogicRfEdge[];
  logicLayoutStatus: LayoutStatus;
  logicLayoutActivity: LayoutActivity | null;
  /** The selected composition unit id; null == none. A repaint-only highlight — no relayout. */
  compSelectedId: string | null;
  /** The module/package the Service-composition tab is rooted at; null == the whole system. Defaults
   * to the app's first entry module. Only its subtree + 1-hop coupling neighbours are drawn. */
  compRoot: string | null;
  /** Whether the composition scorecards show their SOLID metric rows + smell chips. Off == a
   * structure-only view (kind + name), decluttered. Persisted to localStorage across reloads. */
  showSolidMetrics: boolean;
  /** The laid-out shared module-family scene. A focused surface may contain the current level plus
   * every canonical semantic parent supplied by that surface's spec. */
  moduleRfNodes: Node[];
  moduleRfEdges: Edge[];
  moduleLayoutStatus: LayoutStatus;
  moduleLayoutActivity: LayoutActivity | null;
  /** The current surface's innermost semantic level; null == that surface's root. Double-click,
   * breadcrumb, URL navigation, and outward semantic commits can change it; zoom-in never does. */
  moduleFocus: string | null;
  /** The node actually rendered from after chain-collapse (a single-child chain auto-descends); null
   * == the overview. Read by the surface for the containment breadcrumb. */
  moduleEffectiveFocus: string | null;
  /** Every outward semantic transition already mounted in the canvas, nearest parent first.
   * `depth` is also stamped into each layer's node/edge data as `semanticDepth`. */
  moduleSemanticLayers: SemanticAncestorLevel<SurfaceSemanticContext>[];
  /** How many import hops the selection lights up — a PAINT-ONLY highlight radius (never a relayout;
   * containment, not this, bounds what's drawn). GHOST_DEPTH_ALL == the whole connected neighbourhood. */
  moduleRadius: number;
  /** Whether Module-map selection lights incident node wires only, or the full radius-based reach. */
  highlightMode: HighlightMode;
  /** Whether ordinary module surfaces merge cross-container edges into thick "highway" bundles.
   * Paint-only over the settled exact-edge substrate; selected-node wires draw individually. */
  showHighways: boolean;
  /** Review-local highway visibility. Kept separate so the PR's decluttered default cannot leak back
   * into the ordinary Map when the review closes; nested review frames preserve it through history. */
  reviewShowHighways: boolean;
  /** Whether utility hubs demote into the COMMONS DOCK below the graph (commonsDemotion). A
   * RELAYOUT toggle like Tests — the docked cards leave/rejoin ELK, so positions change. */
  showCommons: boolean;
  /** Whether package/library boundary ghosts (`ext:` ids) are painted. Paint-only: the external
   * nodes and their incident wires remain in the laid-out graph, so toggling never moves cards. */
  showExternalGhosts: boolean;
  /** Whether the currently visible ghost neighbourhood collapses crowds of 4+ exact siblings under
   * their immediate semantic parent. Paint-only: exact ghosts remain canonical in the derived tree,
   * and disabling this reveals every related ghost without another ELK pass. */
  groupGhostsByParent: boolean;
  /** Module categories painted OUT of the map (a render-time filter — never a re-derive). */
  hiddenCategories: Set<ModuleCategory>;
  /** Sparse exact-kind visibility deviations, isolated by semantic lens id. A missing value follows
   * that lens's policy default (for example Service calls are initially hidden); paint-only. */
  relationVisibilityOverrides: RelationVisibilityOverrides;
  /** The selected node ids in the Module map (ctrl/cmd+click accumulates several); empty == none.
   * A repaint-only highlight — no relayout. */
  moduleSelected: Set<string>;
  /** Cards the reader expanded IN PLACE on the Map (files into code, blocks into flow frames,
   * steps into deeper flows) — one id space, URL-round-tripped. A relayout concern. */
  moduleExpanded: Set<string>;
  /** Nodes the reader pinned into the current map lens via ⌘P's "+" — drawn as EXTRA top-level cards
   * (their owning unit/file) so an out-of-view symbol joins the Map or Service canvas. Shared by both
   * lenses (they share the module slice). Session-only; cleared on a focus/lens change. */
  mapExtra: Set<string>;
  /** Exact pin roots newly contributed by each promoted ghost. Folder ghosts need this provenance
   * because their selected package id contains (rather than sits beneath) the pinned files; it lets
   * Remove reverse only that promotion without sweeping unrelated pins under the same folder. */
  mapGhostPins: Map<string, ReadonlySet<string>>;
  /** Temporary exact roots traversed by clicking ghosts. They expose one more call-neighbour ring
   * without committing those nodes to `mapExtra`; clicking outside the retained path clears them. */
  moduleGhostInspection: ModuleGhostInspection | null;
  /** Whether `private`-tagged members are painted on the Map. PAINT-ONLY like Tests/categories —
   * privates always get their space in the layout, so toggling never reshuffles positions. */
  showPrivate: boolean;
  /** The Service lens's scoped sub-view (see state/serviceScope.ts); null == the full lens.
   * Session-only — deliberately NOT URL-round-tripped (YAGNI until asked). */
  serviceScope: ServiceScope | null;
  /** How the dense Service overview partitions service frames into artificial parent nodes. */
  serviceGroupingMode: ServiceGroupingMode;
  /** Preferred member count for balanced Service partitions. */
  serviceGroupingTargetSize: ServiceGroupingTargetSize;
  /** How many ranked semantic concepts name each inferred Service parent. */
  serviceGroupingLabelMode: ServiceGroupingLabelMode;
  /** The ORIGIN of the OPEN minimal-graph overlay: the raw selection ids (any kind), verbatim; empty
   * == the overlay is closed and the Module-map level canvas shows. Immutable per build — it is the
   * seed-tier baseline and the Reset target. URL-synced as `mgraph`. */
  minimalSeedIds: string[];
  /** The mutable working set of MEMBERS shown in the overlay (starts = origin). Promoting a ghost adds
   * to it; removing a member drops from it. Ghosts are the members' on-map 1-hop ring, derived (not
   * stored). Reset restores it to the origin. */
  minimalMemberIds: string[];
  /** Original rolled package → changed file modules. The package stays a stable member while its
   * ordinary Map chevron discloses the canonical contained subtree through `moduleExpanded`. */
  minimalRollups: Record<string, string[]>;
  /** The Module map's on-screen card positions, captured (absolute) when the overlay is BUILT, so the
   * overlay mirrors them: a captured card sits at its exact map spot, growth is placed around it.
   * Captured once at build (never on curation) so placed cards never jump; cleared on close. */
  minimalBasePositions: Record<string, PlacedRect>;
  /** When true, the overlay abandons the captured map-mirror and lays the current cards out with the
   * canonical canvas ELK pass. Stays on until the overlay is reset, rebuilt, or closed. */
  minimalArrange: boolean;
  /** The laid-out minimal subgraph for the overlay (flat, mirroring the map), under its own stale-seq guard. */
  minimalRfNodes: Node[];
  minimalRfEdges: Edge[];
  minimalLayoutStatus: LayoutStatus;
  minimalLayoutActivity: LayoutActivity | null;
  /** Which presentation of this extracted frame is active. Captured per history frame. */
  minimalView: "graph" | "codebase";
  /** Frame-local ghost declutter choice; Back restores the parent's exact visibility. */
  minimalShowGhostNodes: boolean;
  /** Frame-local PR filter. False hides only non-diff ghost satellites; affected ghosts and exact
   * minimal members remain visible. Back restores the parent's exact choice. */
  minimalShowNonDiffGhostNodes: boolean;
  /** Codebase presentation's local disclosure overrides, preserved across nested extraction. */
  minimalCodebaseExpansionOverrides: Map<string, boolean>;
  /** The parsed PR-review data (affected-flow rows + flow trees); null hides the review surface.
   * Sourced EITHER from a `meridian review` artifact extension, OR built at runtime from a GitHub PR
   * (selectPr → reviewPrInGraph). */
  review: ReviewData | null;
  /** Artifact node ids that are affected — the coupling set between the graph and the flow panel. */
  reviewAffectedIds: Set<string>;
  /** Show only exact diff nodes plus the containment frames needed to place them. Current-review,
   * session-only display state; never persisted or URL-synced. */
  reviewDiffOnly: boolean;
  /** Every changed file as a checklist row, with any touched code units nested inside it. */
  reviewFiles: ReviewFileRow[];
  /** Checklist ordering preference. Ephemeral UI state: deliberately neither persisted nor URL-synced. */
  reviewFilesSort: "path" | "risk";
  /** Per changed file (keyed by node.location.file): GitHub's +N/-M churn, shown as a marker before
   * the file card's name (files themselves are not coloured — only the touched blocks inside are). */
  reviewFileDelta: Record<string, { added: number; deleted: number; status?: PrFileStatus }>;
  /** Per-flow review progress, keyed by flowId, persisted to localStorage under the reviewKey. */
  reviewTicks: Record<string, ReviewTick>;
  /** Per-unit viewed progress, keyed by node id and persisted with the review. */
  reviewUnitTicks: Record<string, ReviewTick>;
  /** Whole-file progress and durable GitHub synchronization intent, keyed by exact path. */
  reviewFileTicks: Record<string, ReviewTick>;
  /** GitHub viewer state for a signed-in live PR. Null keeps local/artifact progress authoritative. */
  reviewFileViewedStates: Record<string, PrFileViewedState> | null;
  /** This renderer was booted with the authenticated GitHub viewed-file synchronization bridge. */
  reviewViewedFilesSyncEnabled: boolean;
  /** Immutable viewer whose GitHub file-state snapshot is active; paired atomically with the map. */
  reviewViewedFilesViewerId: string | null;
  /** Display login for the active immutable viewer id. */
  reviewViewedFilesViewerLogin: string | null;
  reviewViewedFilesLoading: boolean;
  reviewViewedFilesError: string | null;
  /** Optimistic GitHub writes in flight, scoped to the active review's extraction-relative paths. */
  reviewViewedFileSyncPending: Set<string>;
  /** Retryable per-path GitHub mutation failures. */
  reviewViewedFileSyncErrors: Record<string, string>;
  /** Draft review comments (file- or unit-anchored), persisted until submitted. */
  reviewComments: ReviewComment[];
  /** One unfinished HEAD-line comment shared by every source host. Session-only: unlike a Pending
   * review comment it is not submittable yet, but host swaps and incidental dismissal must not erase it. */
  reviewLineComposer: ReviewLineComposerState | null;
  /** Projection shown in the PR review's bottom logic-flow split. This browser-local reader
   * preference is deliberately separate from the full Logic lens's URL-synced `logicView`. */
  reviewFlowSplitView: ReviewFlowSplitView;
  /** Whether selecting an affected PR flow also opens its bottom split. The flow remains selected
   * and highlighted in the main graph when this browser-local preference is off. */
  reviewOpenFlowSplitOnSelect: boolean;
  /** One explicit "View flow" request. Non-null forces the current review split open in this
   * projection without mutating the reader's persisted auto-open or projection preferences. */
  reviewFlowExplicitView: ReviewFlowSplitView | null;
  /** Pointer gesture which opens the graph node's transient code preview. Browser-local so a
   * reader's preference follows them between repositories and reviews. */
  reviewCodePreviewTrigger: ReviewCodePreviewTrigger;
  /** Whether graph and logic-flow node gestures may open transient code previews. Session-only;
   * source stays available through each node header's explicit View source action. */
  reviewCodePreviewEnabled: boolean;
  /** Hide proven source-comment-only edits from diff rows and the visible review transaction.
   * Browser-local so the reader's review preference follows them between repositories. */
  reviewHideAddedSourceCommentDiffs: boolean;
  /** Remove only edits the prepared analysis proved syntax-equivalent after layout normalization.
   * Browser-local and default-on; missing or uncertain proof keeps the change reviewable. */
  reviewExcludeFormatOnlyChanges: boolean;
  /** Hides the review side panel so the graph takes the full width; session-only. */
  reviewPanelHidden: boolean;
  /** Shows existing GitHub review comments in canvas source widgets. Session-only; draft comment
   * composers and the submit queue stay available independently of this reader-facing layer. */
  reviewCommentsVisible: boolean;
  /** Focus existing review discussion without hiding the viewer's local pending comments. */
  reviewCommentFilter: ReviewCommentFilter;
  reviewSubmitStatus: "idle" | "submitting";
  reviewSubmitError: string | null;
  /** Non-error placement detail for the last successful review submission. */
  reviewSubmitNotice: string | null;
  /** One existing GitHub comment edit/reply at a time; separate from draft-review submission. */
  prCommentMutationStatus: "idle" | "submitting";
  prCommentMutationId: number | null;
  prCommentMutationError: string | null;
  /** html_url of the last submitted review; shows a "view on GitHub" confirmation. */
  reviewSubmittedUrl: string | null;
  /** The graph node ids lit by a panel hover; null == nothing hovered (all blocks full strength). */
  reviewLitNodeIds: Set<string> | null;
  /** The selected review block/flow id; drives the graph selection ring and the panel row highlight. */
  reviewSelectedId: string | null;
  /** The PR's disjoint change groups (one per weakly-connected component of the changed modules),
   * computed once at review time; null outside a review. Drives the CHANGE GROUPS strip. */
  reviewGroups: ChangeGroupsResult | null;
  /** The isolated group's id, or null for "All groups" (the full seed set). Session-only, never URL-synced. */
  reviewActiveGroupId: string | null;
  /** Optional repo-relative path prefix intersected with the active change group. Session-only. */
  reviewPathScope: string | null;
  /** A container's changed files temporarily replacing the outer PR graph. Session-only; its
   * review-panel scope deliberately stays separate from moduleFocus. */
  reviewFocusedSubgraph: ReviewFocusedSubgraph | null;
  /** Exact parent scenes for nested extraction. The last entry is one Back step away; unbounded
   * array depth keeps extraction independent of whether the source is Map, PR, or another extract. */
  minimalGraphHistory: MinimalGraphHistoryEntry[];
  /** Snapshot of the full seed list at review time — the "All groups" restore target. */
  reviewAllSeedIds: string[];
  /** Bumped by viewport-focus actions. The active graph surface subscribes to it and, on a change,
   * either fits one explicit `recenterTargetId` or applies the normal selection/whole-graph recenter.
   * Ephemeral: never serialized to the URL (it is a signal, not navigation state). */
  recenterSeq: number;
  /** One exact node requested by `focusNodeInView`; null keeps the ordinary Toolbar/review recenter
   * contract. The active React Flow instance re-checks that the target is still rendered. */
  recenterTargetId: NodeId | null;
  telemetry: Record<string, NodeMetrics>;
  /** Request executions captured for the explicitly loaded environment. */
  requestTraces: RequestTrace[];
  selectedTraceId: string | null;
  /** Artifact identity carried by the bundle; navigation is disabled unless this exactly matches
   * the loaded graph. Kept beside traces so the UI never has to infer provenance from node ids. */
  traceGraphRef: TraceGraphRef | null;
  /** Producer-declared provenance. Mock captures are synthetic demos and must never be presented as
   * observed production evidence. */
  traceSource: TraceBundle["source"] | null;
  telemetryLoading: boolean;
  telemetryError: string | null;
  traceLoading: boolean;
  traceError: string | null;
  environment: string | null;
  /** Selectable source metadata is serializable; transports stay in the store's private catalog. */
  telemetrySources: TelemetrySourceDescriptor[];
  telemetrySourceId: string | null;
  provider: TelemetryProvider | null;
  hasOverlay: boolean;
  /** Base URL for on-demand source fetches; null when the server ships no source access. Node
   * components read it to decide whether to offer a "show source" control. */
  sourceUrl: string | null;
  /** POST endpoint for PR-head preparation; null when this session can't prepare one (plain
   * `view`, older server). Gates prepare-first review entry and the fallback extract button. */
  analyzeUrl: string | null;
  /** Whether this graph was loaded from a GitHub repository and can use the PR endpoints. */
  githubSource: boolean;
  /** PR API endpoints derived from the graph artifact URL; 404/network means this session lacks PRs. */
  prsUrl: string;
  prOneUrl: string;
  prFilesUrl: string;
  prCommentsUrl: string;
  prChecksUrl: string;
  /** Exact web-session source used only by the subfolder recovery action. */
  prSessionSource: PrSessionSource | null;
  prsTab: PrsTab;
  prsList: Record<PrsTab, PrSummary[] | null>;
  /** One-off summaries fetched for URL restores; unlike `prsList`, these are not loaded pages. */
  prExtraSummaries: Record<number, PrSummary>;
  prsHasMore: Record<PrsTab, boolean>;
  prsLoading: boolean;
  prsError: string | null;
  /** Active priority search is independent from paged queues: results name summaries in the
   * one-off cache, while the query cache avoids repeating a completed lookup in this session. */
  prSearchQuery: string;
  prSearchResults: number[];
  prSearchHasMore: boolean;
  prSearchCache: Record<string, PrSearchCacheEntry>;
  prSearchLoading: boolean;
  prSearchError: string | null;
  /** Session-only related-path filter; persists across page/lens switches until explicitly cleared. */
  relatedPrs: RelatedPrsState | null;
  prSelected: number | null;
  prFiles: PrChangedFile[] | null;
  /** Existing GitHub comments plus the latest review-state rollup for the selected PR. */
  prDiscussion: Pick<PrDiscussionResult, "comments" | "reviews"> | null;
  /** Check-run rollup for the selected PR's head commit. */
  prChecks: PrChecks | null;
  prFilesTruncated: boolean;
  prFilesTotal: number;
  prFilesOutside: number;
  prFilesSuggestedSubdir: string;
  /** The selected PR could not seed this session's graph; shown on the PR detail page. */
  prReviewBlocked: { number: number; reason: string } | null;
  /** The PR whose changed files are currently highlighted in the graph (via "review in graph"). */
  prReviewed: number | null;
  /** Immutable input snapshot for the parked review. The PR queue may browse another selection,
   * but Resume must re-project the reviewed PR rather than whichever detail card is now open. */
  prReviewSource: {
    number: number;
    files: PrChangedFile[];
    truncated: boolean;
    total: number;
    outside: number;
    suggestedSubdir: string;
  } | null;
  /** Exact GitHub content revision currently rendered by the review. It remains immutable while a
   * freshness check updates the summary cache, so a newly pushed head can be compared honestly. */
  prReviewRevision: PrReviewRevision | null;
  /** A newer head/base revision exists on GitHub than the one currently rendered. */
  prReviewStale: boolean;
  /** The stale review is fetching fresh PR data and rebuilding its graph in place. */
  prReviewRefreshing: boolean;
  /** Immutable head SHA (falling back to the ref only when GitHub omitted it) used by synchronous
   * source requests. Null off-review. */
  reviewHeadRef: string | null;
  /** Per changed file (keyed by node.location.file): the PR diff needed to slice + paint the head code. */
  reviewDiffByFile: Record<string, { edits: LineEdit[]; kinds: ChangedLineSpan[] }>;
  /** Exact ordered +/- rows from the selected PR, keyed like reviewDiffByFile. This is the
   * synchronous-review fallback; prepared reviews prefer the local merge-base Git rows stamped
   * into the artifact. */
  reviewDiffLinesByFile: Record<string, ChangedDiffLine[]>;
  /** Review-only nodes whose source coordinates belong to the exact merge-base comparison graph.
   * The active prepared graph remains HEAD-authoritative for edges/flows; these ids are appended
   * only as containment-preserving deletion tombstones and must always read BASE source. */
  reviewBaseNodeIds: Set<string>;
  /** Directly vanished declarations/files within reviewBaseNodeIds. Structural base ancestors are
   * kept separate so they can expose the deleted child without being mistaken for a changed unit. */
  reviewDeletedNodeIds: Set<string>;
  /** Exact merge-base declaration spans keyed by their surviving HEAD node id. This is derived by
   * the same fail-closed semantic pairing that projects deleted nodes, then carried into every
   * source host so a boundary deletion cannot appear in two adjacent declaration previews. */
  reviewBaseSpanByHeadId: Map<string, LineRange>;
  /** Context-padded new-side hunk ranges accepted by GitHub's public inline-review API. */
  reviewCommentRangesByFile: Record<string, LineRange[]>;
  /** Removed patch text keyed like reviewDiffByFile. Positions are HEAD-side in both review modes. */
  reviewRemovedByFile: Record<string, { afterNewLine: number; lines: string[] }[]>;
  /** Files whose removed patch text exceeded the server-side cap, keyed like reviewRemovedByFile. */
  reviewRemovedTruncatedByFile: Record<string, boolean>;
  /** The review-preparation lane: "preparing" while the exact bounded pair is produced/installed,
   * "error" when that fail-closed transaction failed, otherwise "idle". */
  prReviewStatus: "idle" | "preparing" | "error";
  /** The current server analysis or renderer artifact/projection stage. Projection briefly remains
   * set while successful entry disarms cancellation before its synchronous PRs → Map transition. */
  prPrepareStage: PrPrepareStage | null;
  /** Presentation-neutral, revision-aware progress shared by boot and every in-app PR surface. */
  prReviewProgress: PrReviewProgressSnapshot;
  /** Why preparation failed; null outside "error". */
  prPrepareError: string | null;
  /** The server-side graph id of the prepared PR-head source (the bounded ready/terminal payload).
   * Kept across a soft close so the review can resume without another extraction. */
  prPreparedGraphId: string | null;
  /** Exact merge-base graph paired with prPreparedGraphId. Its source root serves deleted nodes. */
  prPreparedComparisonGraphId: string | null;
  /** Immutable merge-base commit represented by prPreparedComparisonGraphId. */
  prPreparedMergeBaseSha: string | null;
  /** The head commit the server analyzed for the prepared artifact (the "done" payload's
   * provenance); shown in the review header. Set on swap, cleared with prPreparedGraphId. */
  prPreparedHeadSha: string | null;
  /** True only while the loaded artifact/index pair is the prepared PR-head graph. Unlike its id,
   * this disarms on a soft baseline restore and re-arms when resumePrReview swaps the graph back. */
  prPreparedArtifactCurrent: boolean;
  /** The boot artifact/index pair, saved ONCE when a streamed review swaps in the prepared PR-head
   * artifact and restored while the review is parked. It is cleared only when another review starts
   * or history explicitly leaves review state. Null outside a swapped review. */
  prReviewBaseline: PrReviewBaseline | null;
  /** Exact merge-base artifact/index for the current prepared review. Kept distinct from
   * prReviewBaseline: the latter restores the user's boot graph, which may be a newer base tip. */
  prReviewComparison: PrReviewComparison | null;
  /** Complete-artifact endpoint for ordinary graph documents and the explicit benchmark control.
   * Production partial review swaps never fetch their bounded source through this URL. */
  graphUrl: string;
  /** Active bounded graph delivery for the prepared review. Null means no partial session is active
   * (ordinary non-review documents and the explicit complete benchmark control). */
  progressiveGraph: ProgressiveGraphSessionState | null;
  /** Background, graph-generation-bound command-palette index. */
  progressiveSymbols: ProgressiveSymbolIndexState;
  /** IDs whose disconnected depth-1 neighbourhood is currently being admitted from search. */
  progressivePendingNodeIds: Set<string>;
  /** The open source view (inline panel or modal); null when nothing is being shown. */
  codeView: CodeView | null;
  /** Reveal one more containment level within the current selection (or the whole view / root
   * container when nothing is selected). Surface-aware: module surfaces and the Logic graph each. */
  expandAll(): void;
  /** Grow the module-family surface's literal selection across every visible incident edge by one
   * undirected hop. The mounted surface supplies its post-filter paint graph so hidden relations,
   * grouped ghosts, and mount-local codebase layouts obey what the reader can actually see. */
  expandModuleSelectionByOneHop(nodes: readonly SelectionNode[], edges: readonly SelectionEdge[]): void;
  /** Logic's transient one-hop selection is occurrence-based; keep its containment actions scoped
   * to those exact visible occurrence ids without widening the persisted target selection. */
  expandLogicOccurrences(nodeIds: readonly string[]): void;
  /** Fully collapse the current selection (or the whole view / root container when nothing is
   * selected) — closes every open container in scope in one click. Surface-aware. */
  collapseAll(): void;
  /** Collapse every open container inside a currently viewed scope on the active review graph.
   * Selection is intentionally ignored; viewed progress and GitHub state are presentation-neutral. */
  collapseAllViewedNodes(): void;
  collapseLogicOccurrences(nodeIds: readonly string[]): void;
  recenter(): void;
  /** Select one canonical node through the ordinary module-surface semantics, then ask the active
   * React Flow instance to fit only that exact node. Inert outside Map/Service/UI surfaces. */
  focusNodeInView(id: NodeId): boolean;
  toggleFlowExplorer(): void;
  selectFlowEntry(ref: FlowSelectionRef | null): void;
  /** Open one review flow in a requested projection without changing saved review preferences. */
  openReviewFlow(ref: FlowSelectionRef, view: ReviewFlowSplitView): void;
  /** Select one artifact node from the bottom flow pane. Request execution reveals/highlights the
   * exact observed node on the graph; PR review narrows the Map to that node's incident relationships
   * (including on-demand ghosts). Null clears request emphasis or restores the whole review flow. */
  selectFlowPaneTarget(nodeId: NodeId | null): void;
  /** Expand/collapse one occurrence (or one namespaced static child) in the request split only. */
  toggleRequestFlowExpand(nodeId: string): void;
  /** Expand/collapse one occurrence in the static explorer/review split only. */
  toggleFlowPaneExpand(nodeId: string): void;
  /** Fold/restore one semantic edge in the shared static/request/synthetic split pane. */
  toggleFlowPaneEdgeCollapse(collapseKey: string): void;
  flowPaneRelayout(): Promise<void>;
  /** The logic flow charted for a callable, or undefined when it has none (empty body). */
  logicFlowFor(nodeId: string): FlowStep[] | undefined;
  openLogicFlow(nodeId: string): void;
  openComposition(unitId: string): void;
  drillLogicFlow(nodeId: string): void;
  logicFlowTo(nodeId: string): void;
  diveLogicContainer(id: string, label: string, bodies: FlowPath[]): void;
  logicFocusTo(index: number): void;
  setLogicInlineDepth(depth: number): void;
  toggleLogicTests(): void;
  setLogicView(mode: LogicViewMode): void;
  setGhostDepth(depth: number): void;
  selectLogicTarget(id: NodeId | null): void;
  togglePinnedFlow(id: NodeId): void;
  toggleLogicExpand(nodeId: string): void;
  /** Fold/restore one semantic edge in the full Logic lens. */
  toggleLogicEdgeCollapse(collapseKey: string): void;
  toggleHideGreyed(): void;
  toggleNestByService(): void;
  logicRelayout(activity?: LayoutActivity): Promise<void>;
  selectCompUnit(id: string | null): void;
  setCompRoot(id: string | null): void;
  toggleSolidMetrics(): void;
  moduleRelayout(activity?: LayoutActivity): Promise<void>;
  /** Reveal the exact clicked ghost(s) as temporary roots. `extend` unions into the current path;
   * false starts a new path from the supplied real anchors. */
  inspectModuleGhost(nodeIds: readonly string[], anchorIds: readonly string[], extend: boolean): boolean;
  clearModuleGhostInspection(): void;
  setModuleFocus(id: string | null): void;
  /** The navigable cards shown at a given Map focus — powers the breadcrumb dropdowns (the nodes you
   * can go into from that level). Read-only; reuses the cached module import graph + hidden-tests set. */
  folderChildrenFor(focus: string | null): NavChild[];
  /** Commit an already-mounted semantic parent as real surface navigation. This consumes inner
   * layers in place; unlike an explicit double-click/breadcrumb dive, it never runs ELK again. */
  commitModuleSemanticParent(depth: number): boolean;
  toggleModuleExpand(nodeId: string): void;
  revealModule(nodeId: string): void;
  /** The Service lens's ghost reveal: open the ghost's owning `svc:` cluster frame(s) IN PLACE
   * (expansion union) and select it — never a folder focus. Unclustered ghosts select only. */
  revealServiceGhost(nodeId: string): void;
  /** ⌘P palette navigate: reveal a picked symbol in the CURRENT map lens — the Map goes to its
   * definition (revealModule), the Service lens pins + selects it. Inert outside the map lenses. */
  revealInView(rawId: string): void;
  /** ⌘P palette "+": add a picked symbol to the graph which is actually on screen. A minimal
   * graph owns its member list; otherwise the current map lens pins the owning unit/file as an
   * extra card. Inert outside those module surfaces. */
  addToView(rawId: string): void;
  /** Ensure a palette result's owning file and depth-1 neighbours are loaded before an existing
   * reveal/add action runs. Full-artifact sessions resolve immediately. */
  ensureNodeReady(rawId: string, fileIdHint?: string): Promise<boolean>;
  /** Adjust the affected-file BFS horizon. The worker precomputes the next requested depth without
   * transferring it until a later gesture needs it. */
  setProgressiveGraphDepth(depth: number): Promise<boolean>;
  /** Start compact symbol indexing after the first actionable canvas. Safe and idempotent. */
  startProgressiveSymbolIndex(): Promise<void>;
  /** Merge only the currently loaded bounded graph into the repository index retained by its Worker. */
  synchronizeProgressiveSymbolSearch(
    loaded: readonly GraphSymbolSearchEntry[],
    isMap: boolean,
  ): Promise<GraphSymbolSearchScopeCounts | null>;
  /** Query the Worker-retained repository index. Its response is always capped to palette rows. */
  queryProgressiveSymbols(request: GraphSymbolSearchQuery): Promise<GraphSymbolSearchQueryResult | null>;
  /** The shared ghost "+" action. On the Map/Service/UI canvas it pins the ghost's home FILE(s)
   * into `mapExtra`; while the minimal overlay is open it adds the home member to that overlay and
   * preserves the clicked card's position. Both destinations open the target's containment path. */
  promoteGhost(ghostId: string, at?: { x: number; y: number }): void;
  /** Remove the selected additions from the active graph. Persistent `mapExtra` pins and selected
   * temporary inspection roots are reversed together on Map/Service/UI; promoted members are
   * demoted in the minimal graph. Canonical/source members are never hidden. Multi-selection
   * membership commits as one state change and one relayout. */
  removeSelectionFromView(): void;
  expandModuleChildren(containerId: string | null): void;
  collapseModuleChildren(containerId: string | null): void;
  togglePrivateMembers(): void;
  setModuleRadius(radius: number): void;
  toggleHighlightMode(): void;
  toggleHighways(): void;
  toggleCommons(): void;
  toggleExternalGhosts(): void;
  toggleGhostGrouping(): void;
  toggleCategory(category: ModuleCategory): void;
  toggleRelKind(kind: string): void;
  resetCategoryFilter(): void;
  resetRelationshipFilter(): void;
  /** Restore the active lens's declared relation defaults (distinct from “All”). */
  resetRelationshipDefaults(): void;
  selectModule(id: string | null): void;
  toggleModuleSelect(id: string): void;
  /** Scope the Service lens to the current anchors' owning cluster(s) + 1-hop; no-op when nothing
   * anchored resolves to a cluster. Enters the "call" lens itself (bypassing setViewMode's clear). */
  openServiceScope(): void;
  /** Exit the scoped Service sub-view back to the full lens; no-op when already unscoped. */
  clearServiceScope(): void;
  /** Switch the dense Service overview's artificial-parent assignment and relayout in place. */
  setServiceGroupingMode(mode: ServiceGroupingMode): void;
  /** Change the preferred size of balanced Service parents and relayout in place. */
  setServiceGroupingTargetSize(size: ServiceGroupingTargetSize): void;
  /** Switch inferred Service parents between one- and two-concept labels. */
  setServiceGroupingLabelMode(mode: ServiceGroupingLabelMode): void;
  buildMinimalGraph(): void;
  setMinimalView(view: "graph" | "codebase"): void;
  setMinimalShowGhostNodes(visible: boolean): void;
  setMinimalShowNonDiffGhostNodes(visible: boolean): void;
  setMinimalCodebaseExpansionOverride(nodeId: string, expanded: boolean): void;
  /** Restore one exact parent extracted graph without closing the overall overlay/review. */
  backMinimalGraph(): void;
  /** Returns false only for a legacy projection over an ordinary complete boot graph while that
   * non-review baseline is restored. A partial document closes directly to its bounded baseline. */
  closeMinimalGraph(afterDeferredRestore?: () => void): boolean;
  resetMinimalGraph(): void;
  rearrangeMinimalGraph(): void;
  minimalRelayout(activity?: LayoutActivity): Promise<void>;
  setReviewLit(ids: Set<string> | null): void;
  setReviewFilesSort(sort: "path" | "risk"): void;
  /** Reveal a review unit, focusing its owning rollup first when the unit is not in the current scene. */
  selectReviewNode(id: string | null): void;
  /** Isolate one change group on the Map (null = "All groups"): re-seed the minimal overlay with only
   * that group's module ids and relayout. A no-op outside a review or when already active. */
  selectReviewGroup(groupId: string | null): void;
  /** Further narrow the active review/group to a repo-relative path prefix. Null restores the group. */
  selectReviewPathScope(path: string | null): void;
  /** Open one review container as an exact-file subgraph, bypassing the large-review rollup. */
  openReviewSubgraph(rootId: string): void;
  /** Restore the exact immediate parent captured before openReviewSubgraph. */
  closeReviewSubgraph(): void;
  toggleReviewTick(flowId: string): void;
  resetReviewTicks(): void;
  /** Reveal a changed file, focusing its owning rollup first, then select/light/center its frame. */
  focusReviewFile(path: string): void;
  toggleReviewUnitTick(nodeId: string): void;
  toggleReviewUnitsViewed(nodeIds: readonly string[]): void;
  toggleReviewFileViewed(path: string): void;
  toggleReviewFilesViewed(paths: readonly string[]): void;
  retryReviewViewedFiles(): Promise<void>;
  addReviewComment(
    path: string,
    nodeId: string | null,
    body: string,
    line?: number | null,
    side?: PrReviewCommentSide | null,
  ): void;
  openReviewLineComposer(path: string, line: number, side?: PrReviewCommentSide): void;
  setReviewLineComposerBody(body: string): void;
  /** True means the caller may dismiss immediately. False leaves a dirty composer open on its
   * inline Keep/Discard confirmation; the requesting host closes only after a later discard. */
  requestReviewLineComposerDismiss(): boolean;
  keepEditingReviewLineComposer(): void;
  discardReviewLineComposer(): void;
  updateReviewComment(id: string, body: string): void;
  deleteReviewComment(id: string): void;
  setReviewFlowSplitView(view: ReviewFlowSplitView): void;
  setReviewOpenFlowSplitOnSelect(open: boolean): void;
  setReviewCodePreviewTrigger(trigger: ReviewCodePreviewTrigger): void;
  toggleReviewCodePreview(): void;
  setReviewHideAddedSourceCommentDiffs(hide: boolean): void;
  setReviewExcludeFormatOnlyChanges(exclude: boolean): void;
  toggleReviewDiffOnly(): void;
  toggleReviewPanel(): void;
  toggleReviewCommentsVisible(): void;
  setReviewCommentFilter(filter: ReviewCommentFilter): void;
  submitReviewComments(): Promise<void>;
  submitReview(event: PrReviewSubmissionEvent, body?: string): Promise<boolean>;
  editPrReviewComment(id: number, body: string): Promise<boolean>;
  replyToPrReviewComment(topLevelId: number, body: string): Promise<boolean>;
  setViewMode(mode: ViewMode): void;
  /** Toggle the full PR-review page: open it, or (when already open) resume the lens you came from. */
  togglePrsView(): void;
  toggleShowTests(): void;
  toggleCoverageMode(): void;
  toggleTelemetryMode(): void;
  /** Show every exact graph node observed by the selected request in the cheapest canonical Map
   * scope. Reuses Minimal Graph's LCA/ancestor-expansion path and preserves request split context. */
  revealSelectedTraceInCodebase(): void;
  /** Open the selected request's reconstructed execution in the shared split pane. */
  openSelectedRequestFlowPane(): void;
  /** Execute one server-advertised, trusted local harness for an explicit flow root. */
  runSyntheticExecution(args: RunSyntheticExecutionArgs): Promise<void>;
  requestSyntheticEditor(rootId: NodeId, host: SyntheticExecutionHost): void;
  consumeSyntheticEditorRequest(rootId: NodeId, host: SyntheticExecutionHost): void;
  stageSyntheticInputOverride(rootId: NodeId, override: SyntheticInputOverride): void;
  removeSyntheticInputOverride(id: string): void;
  addSyntheticFieldWatcher(rootId: NodeId, watcher: SyntheticFieldWatcher): void;
  removeSyntheticFieldWatcher(id: string): void;
  /** Return the selected PR/explorer flow to its static projection without closing the split. */
  clearSyntheticExecution(): void;
  /** Select one exact runtime occurrence while reusing the normal linked-graph highlight path. */
  selectSyntheticMoment(momentId: string | null, targetId: NodeId | null): void;
  setSyntheticFlowOrientation(orientation: LogicFlowOrientation): void;
  setSyntheticFlowPresentation(presentation: "focused" | "overview"): void;
  setTelemetrySource(id: string | null): void;
  setEnvironment(environment: string): void;
  setSelectedTrace(traceId: string | null): void;
  refreshTelemetry(): Promise<void>;
  /** Load one node's review diff for the hover preview without taking over the global code modal. */
  loadCodePreview(node: GraphNode, opts?: CodePreviewOptions): Promise<CodeView | null>;
  showCode(node: GraphNode, opts?: { wholeFile?: boolean; mode?: CodeView["mode"] }): Promise<void>;
  /** Open a changed file's full source even when the extractor produced no graph node for it. */
  showReviewFile(path: string): Promise<void>;
  /** Open contextual source beside the clicked wire's inspector. */
  showEdgeEvidence(contexts: readonly EdgeEvidenceContext[], activeIndex?: number): Promise<void>;
  /** Move the open edge-source pane to another occurrence, loading its file/context on demand. */
  selectEdgeEvidence(index: number): Promise<void>;
  /** Close edge source only; a stale graph surface must never dismiss ordinary node/PR source. */
  /** True when the dock may unmount. A dirty line composer returns false until it is discarded. */
  closeEdgeEvidence(): boolean;
  expandCode(): void;
  closeCode(): void;
  setPrsTab(tab: PrsTab): void;
  loadPrs(page?: number): Promise<void>;
  searchPrs(query: string): Promise<void>;
  clearPrSearch(): void;
  exploreRelatedPrs(): Promise<void>;
  clearRelatedPrs(): void;
  ensurePrSummary(number: number): Promise<void>;
  selectPr(number: number | null, options?: { endReviewSession?: boolean }): Promise<void>;
  /** Quietly compare the live GitHub head with the revision currently rendered. */
  checkPrReviewFreshness(): Promise<void>;
  /** Replace a stale review's files, discussion, checks, and graph without a page reload. */
  refreshPrReview(): Promise<void>;
  /** Enter the selected PR's bounded graph. `progressiveGraphDelivery: false` is reserved for the
   * explicit complete-artifact benchmark control. */
  reviewPrInGraph(options?: { progressiveGraphDelivery?: boolean }): Promise<void>;
  /** Explicit fallback after prepare-first entry fails: review against the loaded base graph. */
  reviewPrOnBaseGraph(): Promise<void>;
  /** Head preparation: stream the server's exact-revision bounded pair, install its verified
   * projection, and run the review in HEAD coordinates. Production never follows a later complete
   * terminal or `/api/graph`; on failure the PRs page (or prior ready review) remains intact. */
  prepareHeadGraph(options?: { progressiveGraphDelivery?: boolean }): Promise<void>;
  /** Re-open a review whose overlay was soft-closed without re-running preparation: re-project the
   * retained exact pair, repaint the kept amber, and reseed from `reviewAllSeedIds`. The explicit
   * complete benchmark lane may still reload its artifact. */
  resumePrReview(options?: { progressiveGraphDelivery?: boolean }): Promise<void>;
  /** Abandon an in-flight prepare-first entry; server work may continue behind the stale-seq guard. */
  cancelPrReviewPreparation(): void;
  /** Dismiss the head-extraction failure warning: clears the prepare-error lane. */
  dismissPrepareError(): void;
  relayout(): Promise<void>;
}

export function reviewViewedGestureBlockReason(state: Pick<
  BlueprintState,
  | "prReviewed"
  | "prReviewStale"
  | "prReviewRefreshing"
  | "reviewViewedFilesSyncEnabled"
  | "reviewViewedFilesLoading"
  | "reviewFileViewedStates"
  | "reviewViewedFilesError"
>): string | null {
  if (!state.reviewViewedFilesSyncEnabled || state.prReviewed === null) return null;
  if (state.reviewViewedFilesLoading) return "Wait for GitHub viewed-file status to finish loading";
  if (state.prReviewRefreshing) return "Wait for the pull request refresh to finish";
  if (state.prReviewStale) return "Refresh the pull request before changing viewed files";
  if (state.reviewViewedFilesError !== null) {
    return "Retry GitHub viewed-file status before changing review progress";
  }
  return null;
}

export interface StoreDependencies {
  artifact: GraphArtifact;
  index: GraphIndex;
  provider: TelemetryProvider | null;
  telemetrySources?: TelemetrySourceRegistration[];
  telemetrySourceId?: string | null;
  hasOverlay: boolean;
  sourceUrl: string | null;
  syntheticExecutionUrl?: string | null;
  syntheticExecutionTrust?: SyntheticExecutionTrust | null;
  syntheticScenarios?: SyntheticScenarioDescriptor[];
  prSessionSource?: PrSessionSource | null;
  prsUrl: string;
  prOneUrl: string;
  prFilesUrl: string;
  /** GET/POST viewer-specific file state. Optional for cached/legacy renderer fixtures. */
  prViewedFilesUrl?: string;
  prRelatedUrl: string;
  prCommentsUrl: string;
  prChecksUrl: string;
  /** GET base for one changed file's text at the PR head ref (the review code panel's head-fetch). */
  prFileUrl?: string;
  /** POST endpoint for PR-head preparation. Null/absent (a plain `view` session, or an older
   * server) makes reviewPrInGraph use the synchronously-applied loaded-artifact review. */
  analyzeUrl?: string | null;
  /** The current GitHub artifact id — the analyze POST body's `id`. */
  graphId?: string | null;
  /** Complete-artifact URL retained for ordinary graph loads and the explicit benchmark control. */
  graphUrl?: string;
  /** Bounded projection and compact-symbol capabilities. Both are required for production PR prep;
   * optionality supports ordinary non-review documents and the explicit benchmark control. */
  graphProjectUrl?: string | null;
  graphSymbolsUrl?: string | null;
  /** Explicit non-production seam for environments which cannot construct a browser Worker. The
   * real UI degrades to loaded-graph search instead of parsing a repository index on its UI thread. */
  loadGraphSymbolsInlineForTest?: typeof fetchGraphSymbols;
  /** Validated depth-1 projection used for a direct PR-review boot. */
  initialGraphProjection?: GraphProjectionV1 | null;
  /** True only for the `partial=1` boot contract. Its bounded artifact and projection are the
   * durable, incrementally expandable baseline for this document. */
  initialGraphProvisional?: boolean;
  /** Lazy complete boot graph loader for a projection over a legacy complete artifact. A true
   * `partial=1` document never needs or invokes it. */
  loadCanonicalBootArtifact?: ((signal: AbortSignal) => Promise<GraphArtifact>) | null;
  /** Meta endpoint paired with graphUrl; prepared PR swaps exchange its id in the same transaction. */
  metaUrl?: string;
  /** Compact server-registration protection for the boot graph and transactional PR graph swaps. */
  graphViewLease?: GraphViewLeaseController | null;
  /** POST target for submitting review comments (web sessions only; 404s elsewhere). */
  prReviewUrl: string;
}

export type BlueprintStore = StoreApi<BlueprintState>;

/** The `/api/source` base for the CURRENT graph: after a head-graph swap the server serves the
 * PR-head checkout under the prepared graph id (web-pr-analyze registers its sourceRoots there),
 * so the boot URL's `id` is exchanged — else every source fetch would read base-clone bytes
 * against head-relative node locations. Every store source fetch must route through this. */
function activeSourceUrl(state: BlueprintState): string | null {
  if (state.sourceUrl === null || !state.prPreparedArtifactCurrent || state.prPreparedGraphId === null) {
    return state.sourceUrl;
  }
  return sourceUrlForGraph(state.sourceUrl, state.prPreparedGraphId);
}

/** Exchange only the immutable graph id while retaining the boot endpoint's origin/path. */
function sourceUrlForGraph(sourceUrl: string, graphId: string): string {
  const url = new URL(sourceUrl, requestOrigin());
  url.searchParams.set("id", graphId);
  return url.toString();
}

/** Keep local execution pinned to the source tree backing the active artifact. A prepared PR review
 * swaps to a distinct retained checkout exactly like source viewing, so exchange the graph id too. */
function activeSyntheticExecutionUrl(state: BlueprintState): string | null {
  if (
    state.syntheticExecutionUrl === null
    || !state.prPreparedArtifactCurrent
    || state.prPreparedGraphId === null
  ) {
    return state.syntheticExecutionUrl;
  }
  const url = new URL(state.syntheticExecutionUrl, requestOrigin());
  url.searchParams.set("id", state.prPreparedGraphId);
  return url.toString();
}

/** `/api/source` URL for a node slice (or the whole file). */
function baseSourceUrl(sourceUrl: string, location: NonNullable<GraphNode["location"]>, wholeFile: boolean): URL {
  const url = new URL(sourceUrl, window.location.origin);
  url.searchParams.set("file", location.file);
  // Omitting start/end makes the server return the whole file (missing bounds default to 1..EOF).
  if (!wholeFile) {
    url.searchParams.set("start", String(location.startLine));
    url.searchParams.set("end", String(location.endLine ?? location.startLine));
  }
  return url;
}

/** `/api/prs/file` URL for one changed file's text at the PR head ref. */
function prFileHeadUrl(prFileUrl: string, file: string, ref: string): URL {
  const url = new URL(prFileUrl, window.location.origin);
  url.searchParams.set("path", file);
  url.searchParams.set("ref", ref);
  return url;
}

interface CodeLoadRequest {
  node: GraphNode;
  url: URL;
  baseLine: number;
  wholeFile: boolean;
  /** Present when the request reads the PR head rather than the loaded source root. */
  headSpan: { start: number; end: number } | null;
  headKinds: readonly ChangedLineSpan[];
  diffLines: readonly ChangedDiffLine[];
  /** See CodeView.diffOldSpan. */
  diffOldSpan: LineRange | null | undefined;
  sourceSide: "head" | "base";
}

interface CodePayload {
  code: string;
  truncated: boolean;
  startLine?: number;
  lineCount?: number;
}

type CodePayloadCache = Map<string, Promise<CodePayload>>;

function liveReviewStatusSources(
  files: Readonly<Record<string, { edits: readonly LineEdit[]; kinds: readonly ChangedLineSpan[] }>>,
  diffLines: Readonly<Record<string, ChangedDiffLine[]>>,
) {
  const kinds = Object.fromEntries(Object.entries(files).map(([file, detail]) => [file, [...detail.kinds]]));
  const edits = Object.fromEntries(Object.entries(files).map(([file, detail]) => [file, detail.edits]));
  return reviewNodeStatusSourcesFromDiff(kinds, diffLines, edits);
}

/** Generous surrounding source for edge evidence: enough to understand the declaration/control
 * flow without asking the source server for only the proving line or risking its 2,000-line cap. */
export const EDGE_EVIDENCE_CONTEXT_LINES = 80;

function edgeEvidenceNode(
  context: EdgeEvidenceContext,
  activeIndex: number,
  state: BlueprintState,
): GraphNode {
  const source = state.index.nodesById.get(context.source);
  const target = state.index.nodesById.get(context.target);
  const endLine = Math.max(context.site.line, context.site.endLine ?? context.site.line);
  const displayName = `${source?.displayName ?? context.source} → ${target?.displayName ?? context.target}`;
  const location = {
    file: context.site.file,
    startLine: Math.max(1, context.site.line - EDGE_EVIDENCE_CONTEXT_LINES),
    endLine: endLine + EDGE_EVIDENCE_CONTEXT_LINES,
    startCol: context.site.col,
  };
  return source
    ? {
        ...source,
        id: `edge-evidence:${encodeURIComponent(context.edgeId)}:${activeIndex}`,
        qualifiedName: displayName,
        displayName,
        location,
      }
    : {
        id: `edge-evidence:${encodeURIComponent(context.edgeId)}:${activeIndex}`,
        kind: "module",
        qualifiedName: displayName,
        displayName,
        parentId: null,
        location,
      };
}

/** Map artifact/base evidence onto the source coordinates codeLoadRequest will display. */
function displayedEvidenceSpan(
  context: EdgeEvidenceContext,
  state: BlueprintState,
  prFileUrl: string | null,
): { start: number; end: number } {
  const start = context.site.line;
  const end = Math.max(start, context.site.endLine ?? start);
  const diff = valueForExactRecord(state.reviewDiffByFile, context.site.file) ?? null;
  const removedAtHead = valueForExactRecord(state.reviewFileDelta, context.site.file)?.status === "removed";
  const readsPrHead =
    !state.prPreparedArtifactCurrent
    && !removedAtHead
    && state.prReviewed !== null
    && prFileUrl !== null
    && state.reviewHeadRef !== null;
  return readsPrHead && diff !== null ? headSpanFor(start, end, diff.edits) : { start, end };
}

/** Resolve the source request once so click-to-open and hover-preview read identical code. */
function codeLoadRequest(
  node: GraphNode,
  opts: { wholeFile?: boolean; sourceSide?: "base" } | undefined,
  state: BlueprintState,
  sourceUrl: string | null,
  prFileUrl: string | null,
): CodeLoadRequest | null {
  if (!isSourceBackedNode(node)) {
    return null;
  }
  // A prepared PR artifact has its own retained source root. Route every code surface through that
  // graph id and keep it out of the GitHub head-file branch: its nodes and source already share HEAD
  // coordinates, while the head-file fallback below exists for reviews on the loaded base artifact.
  const preparedArtifactCurrent = state.prPreparedArtifactCurrent;
  const removedAtHead = valueForExactRecord(state.reviewFileDelta, node.location.file)?.status === "removed";
  const readsComparisonBase = opts?.sourceSide === "base" || state.reviewBaseNodeIds.has(node.id) || removedAtHead;
  const resolvedSourceUrl = preparedArtifactCurrent
    ? readsComparisonBase && state.sourceUrl !== null && state.prPreparedComparisonGraphId !== null
      ? sourceUrlForGraph(state.sourceUrl, state.prPreparedComparisonGraphId)
      : readsComparisonBase
        ? sourceUrl
        : activeSourceUrl(state)
    : sourceUrl;
  // A live PR review reads changed files from the PR head. The synchronous path holds BASE node
  // coordinates and therefore needs the edit map; a prepared artifact is already in HEAD
  // coordinates, so mapping it again would double-shift the preview after an earlier hunk.
  const reviewDiff = !preparedArtifactCurrent && state.prReviewed !== null && prFileUrl && state.reviewHeadRef
    ? valueForExactRecord(state.reviewDiffByFile, node.location.file) ?? null
    : null;
  // A patch can be absent for a binary/oversized change, but the file is still a PR-head file. Its
  // file-delta entry is the fallback capability signal so the preview never silently shows BASE
  // source just because GitHub omitted hunk detail. Removed files are the exception: no HEAD path
  // exists, so their old (entirely deleted) node span must come from the base source endpoint.
  const readsPrHead = !preparedArtifactCurrent && !readsComparisonBase
    && state.prReviewed !== null && prFileUrl !== null && state.reviewHeadRef !== null
    && (reviewDiff !== null || valueForExactRecord(state.reviewFileDelta, node.location.file) !== undefined);
  if (!readsPrHead && !resolvedSourceUrl) {
    return null;
  }
  const wholeFile = opts?.wholeFile ?? false;
  const headSpan = readsPrHead && !wholeFile
    ? reviewDiff === null
      ? { start: node.location.startLine, end: node.location.endLine ?? node.location.startLine }
      : headSpanFor(node.location.startLine, node.location.endLine ?? node.location.startLine, reviewDiff.edits)
    : null;
  const baseLine = wholeFile ? 1 : headSpan ? headSpan.start : node.location.startLine;
  // A deletion cursor at `endLine + 1` is inherently shared by the declarations on either side of
  // that boundary. Declaration previews therefore need the exact old-side counterpart span before
  // accepting the row. In synchronous reviews the active node itself is in BASE coordinates; in a
  // prepared review the deletion projection supplies the fail-closed semantic counterpart. File
  // modules and explicit whole-file views intentionally remain cursor-scoped so EOF deletions stay
  // visible even when the extractor's module span stops before the physical final line.
  const scopesDeletedRows = !wholeFile && node.kind !== "module" && !readsComparisonBase;
  const diffOldSpan: LineRange | null | undefined = !scopesDeletedRows
    ? undefined
    : preparedArtifactCurrent && state.prReviewComparison !== null
      ? state.reviewBaseSpanByHeadId.get(node.id) ?? null
      : readsPrHead
        ? {
            start: node.location.startLine,
            end: node.location.endLine ?? node.location.startLine,
          }
        : undefined;
  // Prepared/local artifacts carry the canonical merge-base diff beside the graph. A synchronous
  // GitHub review has not swapped artifacts, so it uses the selected PR response parsed through the
  // same unified-diff model. Never hybridize local additions with GitHub deletions.
  const artifactKinds = !readsComparisonBase && (preparedArtifactCurrent || state.prReviewed === null)
    ? valueForReviewAliases(
        changedLineKindsFromExtensions(state.artifact.extensions),
        new Set([node.location.file]),
      )
    : undefined;
  const artifactDiffLines = preparedArtifactCurrent || state.prReviewed === null
    ? valueForReviewAliases(
        changedDiffLinesFromExtensions(state.artifact.extensions),
        new Set([node.location.file]),
      )
    : undefined;
  const reviewDiffLines = valueForExactRecord(state.reviewDiffLinesByFile, node.location.file);
  return {
    node,
    url: readsPrHead
      ? prFileHeadUrl(prFileUrl!, node.location.file, state.reviewHeadRef!)
      : baseSourceUrl(resolvedSourceUrl!, node.location, wholeFile),
    baseLine,
    wholeFile,
    headSpan,
    // A removed file has no head-side text or line kinds. Its base snippet is entirely deleted,
    // so paint the node span explicitly instead of reducing the hover card to plain source.
    headKinds: removedAtHead || state.reviewDeletedNodeIds.has(node.id)
      ? [{ start: node.location.startLine, end: node.location.endLine ?? node.location.startLine, kind: "deleted" }]
      : artifactKinds ?? reviewDiff?.kinds ?? [],
    diffLines: artifactDiffLines ?? reviewDiffLines ?? [],
    diffOldSpan,
    sourceSide: readsComparisonBase ? "base" : "head",
  };
}

/** Attach a structural focus without changing the canonical declaration request or its PR diff
 * ownership. Synchronous reviews store FlowSourceAnchor coordinates on BASE while displaying HEAD,
 * so only that branch needs the same edit-map projection used for the enclosing callable. */
function withCodePreviewFocus(
  view: CodeView,
  node: GraphNode,
  focus: FlowSourceAnchor,
  request: CodeLoadRequest,
  state: BlueprintState,
): CodeView {
  if (
    focus.file !== node.location.file
    || view.code === null
  ) {
    return view;
  }
  let range: LineRange = {
    start: Math.max(1, focus.line),
    end: Math.max(Math.max(1, focus.line), focus.endLine ?? focus.line),
  };
  if (request.headSpan !== null && !state.prPreparedArtifactCurrent) {
    const reviewDiff = valueForExactRecord(state.reviewDiffByFile, focus.file) ?? null;
    if (reviewDiff !== null) {
      range = headSpanFor(range.start, range.end, reviewDiff.edits);
    }
  }
  const firstShown = view.baseLine ?? node.location.startLine;
  const lineCount = view.lineCount ?? view.code.split("\n").length;
  const lastShown = firstShown + lineCount - 1;
  if (lineCount <= 0 || range.end < firstShown || range.start > lastShown) {
    return view;
  }
  return {
    ...view,
    previewFocus: {
      start: Math.max(firstShown, range.start),
      end: Math.min(lastShown, range.end),
    },
  };
}

/** Fetch a resolved request into the same view model the existing code surfaces render. */
async function fetchCodeView(
  request: CodeLoadRequest,
  mode: CodeView["mode"],
  payloadCache?: CodePayloadCache,
): Promise<CodeView> {
  const key = request.url.toString();
  let pending = payloadCache?.get(key);
  if (!pending) {
    pending = fetch(request.url, { credentials: "same-origin" }).then(async (response): Promise<CodePayload> => {
      if (!response.ok) {
        throw new Error(`source request failed with ${response.status}`);
      }
      const data = await response.json() as { code?: unknown; truncated?: unknown; startLine?: unknown; lineCount?: unknown };
      return {
        code: typeof data.code === "string" ? data.code : String(data.code ?? ""),
        truncated: data.truncated === true,
        ...(typeof data.startLine === "number" ? { startLine: data.startLine } : {}),
        ...(isSourceLineCount(data.lineCount) ? { lineCount: data.lineCount } : {}),
      };
    });
    payloadCache?.set(key, pending);
  }
  try {
    const data = await pending;
    if (request.headSpan) {
      return sliceHeadCodeView(
        request.node,
        data.code,
        data.lineCount,
        data.truncated,
        request.headSpan,
        request.headKinds,
        request.diffLines,
        request.diffOldSpan,
        request.sourceSide,
        mode,
      );
    }
    const baseLine = data.startLine ?? request.baseLine;
    const lineCount = data.lineCount ?? data.code.split("\n").length;
    const changedLineKinds = request.headKinds.length > 0
      ? headKindsWithin(request.headKinds, baseLine, baseLine + lineCount - 1)
      : undefined;
    return {
      node: request.node,
      code: data.code,
      lineCount,
      loading: false,
      error: null,
      truncated: data.truncated,
      mode,
      baseLine,
      wholeFile: request.wholeFile,
      sourceSide: request.sourceSide,
      ...(request.diffLines.length > 0 ? { diffLines: request.diffLines } : {}),
      ...(request.diffOldSpan !== undefined ? { diffOldSpan: request.diffOldSpan } : {}),
      ...(changedLineKinds && changedLineKinds.size > 0
        ? { changedLineKinds, changedLines: new Set(changedLineKinds.keys()) }
        : {}),
    };
  } catch {
    // Do not pin a transient source error into the shared cache; a later hover/click may retry it.
    if (payloadCache?.get(key) === pending) {
      payloadCache.delete(key);
    }
    return {
      node: request.node,
      code: null,
      loading: false,
      error: "Could not load source.",
      mode,
      baseLine: request.baseLine,
      wholeFile: request.wholeFile,
      sourceSide: request.sourceSide,
      ...(request.diffLines.length > 0 ? { diffLines: request.diffLines } : {}),
      ...(request.diffOldSpan !== undefined ? { diffOldSpan: request.diffOldSpan } : {}),
    };
  }
}

/** Slice the fetched HEAD file to the node's head span and pin the PR's own change kinds onto it. */
function sliceHeadCodeView(
  node: GraphNode,
  fullCode: string,
  fullLineCount: number | undefined,
  truncated: boolean,
  headSpan: { start: number; end: number },
  kinds: readonly ChangedLineSpan[],
  diffLines: readonly ChangedDiffLine[],
  diffOldSpan: LineRange | null | undefined,
  sourceSide: "head" | "base",
  mode: "inline" | "modal",
): CodeView {
  const lines = fullLineCount === 0 ? [] : fullCode.length > 0 || fullLineCount === 1 ? fullCode.split("\n") : [];
  const start = lines.length === 0
    ? Math.max(headSpan.start, 1)
    : Math.min(Math.max(headSpan.start, 1), lines.length);
  const end = lines.length === 0
    ? start - 1
    : Math.min(Math.max(headSpan.end, start), lines.length);
  const slicedLines = lines.slice(start - 1, end);
  const changedLineKinds = headKindsWithin(kinds, start, end);
  return {
    node,
    code: slicedLines.join("\n"),
    lineCount: slicedLines.length,
    loading: false,
    error: null,
    truncated,
    mode,
    baseLine: start,
    wholeFile: false,
    sourceSide,
    ...(diffLines.length > 0 ? { diffLines } : {}),
    ...(diffOldSpan !== undefined ? { diffOldSpan } : {}),
    changedLineKinds,
    changedLines: new Set(changedLineKinds.keys()),
  };
}

function isSourceLineCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Whether changing only this view's chrome keeps the active composer mounted on the exact same
 * diff row. This lets inline → modal expansion feel continuous while still guarding an
 * unrelated hover-card draft that happens to coexist with an older inline source view. */
function codeViewCanHostReviewLineComposer(state: BlueprintState, view: CodeView): boolean {
  const composer = state.reviewLineComposer;
  if (
    composer === null
    || state.review === null
    || composer.reviewKey !== state.review.context.reviewKey
    || composer.lineRevision !== prReviewRevisionKey(state.prReviewRevision)
    || composer.path !== view.node.location.file
    || view.code === null
  ) {
    return false;
  }
  if (composer.side === "LEFT") {
    return view.diffLines?.some((line) => line.kind === "deleted" && line.oldLine === composer.line) === true;
  }
  if ((view.sourceSide ?? "head") !== "head") {
    return false;
  }
  const baseLine = view.baseLine ?? view.node.location.startLine;
  const lineCount = view.lineCount ?? view.code.split("\n").length;
  return composer.line >= baseLine && composer.line < baseLine + lineCount;
}

/** The module surface (Map + Service) opened at its top level: whole-repo overview, nothing expanded
 * or selected. The lens-switch fallback when no path node can be carried into it. */
const MODULE_TOP_LEVEL = { moduleFocus: null, moduleExpanded: new Set<string>(), moduleSelected: new Set<string>() } as const;

function defaultModuleLayoutActivity(state: BlueprintState): LayoutActivity {
  if (state.viewMode === "call") {
    return { label: "Arranging service graph…" };
  }
  return { label: state.viewMode === "ui" ? "Arranging UI graph…" : "Arranging map…" };
}

function serviceGroupingLabel(mode: ServiceGroupingMode): string {
  return SERVICE_GROUPING_OPTIONS.find((option) => option.id === mode)?.label ?? mode;
}

function serviceGroupingUsesTarget(mode: ServiceGroupingMode): boolean {
  return mode === "edge-cut" || mode === "coupling-cut" || mode === "leiden" || mode === "bunch";
}

function layoutNodeLabel(state: BlueprintState, id: string | null): string | null {
  if (id === null) {
    return null;
  }
  const laid = state.moduleRfNodes.find((node) => node.id === id)?.data;
  if (laid && typeof laid === "object" && "label" in laid && typeof laid.label === "string") {
    return laid.label;
  }
  return state.index.nodesById.get(id)?.displayName ?? null;
}

function nodeLayoutActivity(state: BlueprintState, verb: string, id: string | null): LayoutActivity {
  const label = layoutNodeLabel(state, id);
  return { label: label ? `${verb} ${label}…` : `${verb}…` };
}

interface ModuleSelectionRemovalPlan {
  /** Selected ids covered by at least one removable addition. */
  selectionIds: string[];
  /** Selected promoted-ghost ids which can remain valid as paint-created parent ghosts even when
   * they are absent from the settled raw layout. */
  provenanceSelectionIds: string[];
  /** Persistent extra roots covered by the selection. */
  mapExtraIds: string[];
  /** Temporary inspection roots covered by the selection. */
  visitedIds: string[];
}

/** Number of selected scopes on which the action-bar Remove control can operate. Kept as a
 * primitive selector so the action bar does not rerender on unrelated store updates. */
export function removableModuleSelectionCount(state: BlueprintState): number {
  if (state.minimalSeedIds.length > 0) {
    return minimalSelectionRemovalIds(state).length;
  }
  return moduleSelectionRemovalPlan(state).selectionIds.length;
}

/** Number of open containers the review-only canvas action would close. A primitive selector keeps
 * action-bar subscriptions stable while sharing the viewed-state oracle with node chrome. */
export function collapsibleViewedNodeCount(state: BlueprintState): number {
  return collapsibleViewedNodeIds(state).length;
}

/** Resolve the highway toggle for the active experience without leaking PR defaults into the Map. */
export function selectShowHighways(
  state: Pick<
    BlueprintState,
    "review" | "viewMode" | "prReviewed" | "minimalSeedIds" | "showHighways" | "reviewShowHighways"
  >,
): boolean {
  return reviewOwnsHighways(state) ? state.reviewShowHighways : state.showHighways;
}

function reviewOwnsHighways(
  state: Pick<BlueprintState, "review" | "viewMode" | "prReviewed" | "minimalSeedIds">,
): boolean {
  return state.review !== null
    && state.viewMode === "modules"
    && (state.prReviewed === null || state.minimalSeedIds.length > 0);
}

/** Resolve selected minimal-graph nodes to promoted member ancestors. Canonical GraphIndex
 * ancestry covers ordinary unit/block selections; the laid parent chain also covers view-only
 * nodes such as logic-flow steps. Walking upward from the selection is intentionally conservative:
 * selecting a non-member ancestor must not sweep promoted members beneath it. */
function minimalSelectionRemovalIds(state: BlueprintState): string[] {
  if (state.moduleSelected.size === 0 || state.minimalMemberIds.length <= 1) {
    return [];
  }

  const seeds = new Set(state.minimalSeedIds);
  const promotedMembers = new Set(state.minimalMemberIds.filter((id) => !seeds.has(id)));
  if (promotedMembers.size === 0) {
    return [];
  }

  const drawnById = new Map(state.minimalRfNodes.map((node) => [node.id, node]));
  const nearestPromotedMember = (selectedId: string): string | null => {
    const canonicalPath = state.index.ancestorsOf(selectedId);
    for (let index = canonicalPath.length - 1; index >= 0; index -= 1) {
      if (promotedMembers.has(canonicalPath[index].id)) {
        return canonicalPath[index].id;
      }
    }

    const seen = new Set<string>();
    let current: string | null | undefined = selectedId;
    while (current !== null && current !== undefined && !seen.has(current)) {
      if (promotedMembers.has(current)) {
        return current;
      }
      seen.add(current);
      current = drawnById.get(current)?.parentId;
    }
    return null;
  };

  const removable = new Set<string>();
  for (const selectedId of state.moduleSelected) {
    const memberId = nearestPromotedMember(selectedId);
    if (memberId !== null) {
      removable.add(memberId);
    }
  }
  // Keep one anchor even under defensive/restored state where every current member is promoted.
  return removable.size < state.minimalMemberIds.length ? [...removable].sort() : [];
}

/** Resolve selection against both canonical GraphIndex ancestry and the active canvas's drawn
 * ancestry. The latter matters for Service/UI frames whose semantic parents are presentation-only.
 * Only an added root equal to or containing a selection is removable: selecting a canonical
 * ancestor must never sweep unrelated additions from beneath it. */
function moduleSelectionRemovalPlan(state: BlueprintState): ModuleSelectionRemovalPlan {
  const inspectionVisited = state.moduleGhostInspection?.visitedIds;
  if (
    state.moduleSelected.size === 0
    || state.minimalSeedIds.length > 0
    || moduleSurfaceSpec(state.viewMode) === null
    || (state.mapExtra.size === 0 && (inspectionVisited?.size ?? 0) === 0)
  ) {
    return { selectionIds: [], provenanceSelectionIds: [], mapExtraIds: [], visitedIds: [] };
  }

  const selected = [...state.moduleSelected];
  let drawnById: Map<string, Node> | null = null;
  const contains = (ancestorId: string, descendantId: string): boolean => {
    if (state.index.isWithinFocus(ancestorId, descendantId)) {
      return true;
    }
    drawnById ??= new Map(state.moduleRfNodes.map((node) => [node.id, node]));
    const seen = new Set<string>();
    let current: string | null | undefined = descendantId;
    while (current !== null && current !== undefined && !seen.has(current)) {
      if (current === ancestorId) {
        return true;
      }
      seen.add(current);
      current = drawnById.get(current)?.parentId;
    }
    return false;
  };
  const coversSelection = (rootId: string, selectedId: string): boolean =>
    contains(rootId, selectedId);

  const mapExtraIds = new Set([...state.mapExtra]
    .filter((rootId) => selected.some((selectedId) => coversSelection(rootId, selectedId)))
  );
  const provenanceSelections = new Set<string>();
  for (const selectedId of selected) {
    for (const pinId of state.mapGhostPins.get(selectedId) ?? []) {
      if (!state.mapExtra.has(pinId)) continue;
      mapExtraIds.add(pinId);
      provenanceSelections.add(selectedId);
    }
  }
  const visitedIds = [...(inspectionVisited ?? [])]
    .filter((rootId) => selected.some((selectedId) => coversSelection(rootId, selectedId)))
    .sort();
  const sortedMapExtraIds = [...mapExtraIds].sort();
  const removableRoots = [...sortedMapExtraIds, ...visitedIds];
  const selectionIds = selected
    .filter((selectedId) =>
      provenanceSelections.has(selectedId)
      || removableRoots.some((rootId) => coversSelection(rootId, selectedId)))
    .sort();
  return {
    selectionIds,
    provenanceSelectionIds: [...provenanceSelections].sort(),
    mapExtraIds: sortedMapExtraIds,
    visitedIds,
  };
}

function telemetryRegistrations(dependencies: StoreDependencies): TelemetrySourceRegistration[] {
  if (dependencies.telemetrySources !== undefined) {
    const seen = new Set<string>();
    return dependencies.telemetrySources.flatMap((source) => {
      if (seen.has(source.id)) return [];
      seen.add(source.id);
      return [{ ...source, environments: [...source.environments] }];
    });
  }
  const provider = dependencies.provider;
  if (provider === null) return [];
  const kind = provider.id === "tempo" ? "tempo" : provider.id === "file" ? "file" : "mock";
  return [{
    id: provider.id,
    kind,
    label: kind === "tempo" ? "Tempo" : kind === "file" ? "Saved telemetry snapshot" : "Telemetry",
    provenance: kind === "tempo" ? "observed" : kind === "file" ? "saved" : "synthetic",
    environments: [...provider.listEnvironments()],
    supportsMetrics: true,
    supportsTraces: kind !== "file",
    provider,
  }];
}

function initialSourceId(
  dependencies: StoreDependencies,
  catalog: ReadonlyMap<string, TelemetrySourceRegistration>,
): string | null {
  // Supplying a catalog opts into explicit source selection. Legacy single-provider dependencies
  // remain selected so existing embedders/tests keep their pre-catalog behavior.
  const requested = dependencies.telemetrySources === undefined
    ? dependencies.telemetrySourceId ?? dependencies.provider?.id ?? null
    : dependencies.telemetrySourceId ?? null;
  return requested !== null && catalog.has(requested) ? requested : null;
}

function sourceDescriptor(source: TelemetrySourceRegistration): TelemetrySourceDescriptor {
  return {
    id: source.id,
    kind: source.kind,
    label: source.label,
    provenance: source.provenance,
    environments: [...source.environments],
    ...(source.environmentMode === undefined ? {} : { environmentMode: source.environmentMode }),
    supportsMetrics: source.supportsMetrics,
    supportsTraces: source.supportsTraces,
  };
}

export function createBlueprintStore(dependencies: StoreDependencies): BlueprintStore {
  const sourceRegistrations = telemetryRegistrations(dependencies);
  const telemetrySourceCatalog = new Map(sourceRegistrations.map((source) => [source.id, source]));
  const initialTelemetrySourceId = initialSourceId(dependencies, telemetrySourceCatalog);
  const initialTelemetryProvider = initialTelemetrySourceId === null
    ? null
    : telemetrySourceCatalog.get(initialTelemetrySourceId)?.provider ?? null;
  // The lens to resume when the PR-review page is toggled back off; null == none captured yet.
  let lensBeforePrs: ViewMode | null = null;
  // Monotonic seq to drop a stale Logic-graph layout when a newer open/drill/toggle supersedes it.
  let logicLayoutSeq = 0;
  // And for the Module-map layout, so a newer focus change supersedes an older derivation.
  let moduleLayoutSeq = 0;
  // Selected ids whose just-removed membership may leave no settled card. Any winning module
  // layout consumes this set, so a superseded Remove layout cannot strand a palette-only pick.
  const pendingModuleSelectionPrune = new Set<string>();
  // And for the Module-map selection's minimal-graph overlay (its own surface, its own guard).
  let minimalLayoutSeq = 0;
  // The file import graph, built once per ARTIFACT on first module-map relayout and reused for
  // every level — never rebuilt per relayout. A PR-review swap/restore replaces the artifact, so
  // invalidateArtifactCaches (below) nulls it for a lazy rebuild from the incoming index.
  let moduleGraph: ModuleGraph | null = null;
  // Stable empty set for "nothing hidden" so relayout inputs don't churn per call.
  const EMPTY_HIDDEN_IDS: ReadonlySet<string> = new Set<string>();
  // The code-dependency substrate (coupling edges at their real endpoints), same lifecycle.
  let blockDeps: BlockDeps | null = null;
  // Request bulk-reveal and one-node clicks both install the same canonical Map projection. Keep
  // artifact/cached-graph plumbing in one seam so those entry points cannot drift in disclosure.
  const requestCodebaseContextFor = (
    state: BlueprintState,
    targetIds: readonly string[],
  ): MinimalCodebaseContext | null => {
    const flows = (state.artifact.extensions?.logicFlow ?? {}) as unknown as LogicFlows;
    return deriveMinimalCodebaseContext({
      index: state.index,
      moduleGraph: (moduleGraph ??= buildModuleGraph(state.index)),
      blockDeps: (blockDeps ??= buildBlockDeps(state.index)),
      flows,
      minimalMemberIds: targetIds,
      hiddenIds: state.showTests ? EMPTY_HIDDEN_IDS : state.index.testIds,
      demoteCommons: false,
    });
  };
  // The composition unit index (member → owning unit), built lazily on the first ⌘P reveal/add so a
  // picked symbol resolves to the unit/module card that draws it. Cached like moduleGraph/blockDeps.
  let unitIndex: UnitIndex | null = null;
  let unitIndexSource: GraphIndex | null = null;
  // Resolve any symbol to the card the map lenses actually draw: its nearest owning unit
  // (class/interface/object), or its module for a top-level callable (module is itself a UNIT_KIND).
  const resolveCard = (id: string, index: GraphIndex): string => {
    if (unitIndex === null || unitIndexSource !== index) {
      unitIndex = buildUnitIndex([...index.nodesById.values()]);
      unitIndexSource = index;
    }
    return unitIndex.unitIdOf(id) ?? id;
  };
  // Same guard for the Code flows explorer's embedded flow preview pane.
  let flowPaneLayoutSeq = 0;
  // Request-runtime clicks can trigger Map relayouts. Keep their camera handoff last-write-wins too:
  // A → B → A must not let the first A's slower layout recenter over the final A selection.
  let requestTargetRevealSeq = 0;
  // PR list/file fetches and PR-head preparation are independent async lanes; newer requests win
  // when the reader switches PRs (or re-clicks Review) mid-stream.
  let prsListSeq = 0;
  let prSearchSeq = 0;
  let relatedPrsSeq = 0;
  let prFilesSeq = 0;
  let prViewedFilesSeq = 0;
  // Every discussion read (selection, refresh, or post-submit) shares one last-started-wins lane.
  let prDiscussionSeq = 0;
  let prFilesRequest: { number: number; sequence: number; promise: Promise<void> } | null = null;
  type ViewedFileWrite = {
    number: number;
    path: string;
    desired: boolean;
    expectedHeadSha: string;
    viewerId: string;
    viewerLogin: string;
    fileFingerprint: string;
    fileAddress: string | null;
    generation: number;
    running: boolean;
    completion: Promise<void> | null;
  };
  type GitHubViewerIdentity = { id: string; login: string };
  type ViewedFileWriteCapture = {
    key: string;
    entry: ViewedFileWrite;
    generation: number;
    desired: boolean;
  };
  const viewedFileWrites = new Map<string, ViewedFileWrite>();
  // Intent entries can be canceled when authentication or the immutable PR head changes, but an
  // already-issued browser request cannot. Track those request lifetimes independently so every
  // later canonical read waits for abandoned writes that may still reach GitHub.
  const viewedFileSettlements = new Map<number, Set<Promise<void>>>();
  const trackViewedFileSettlement = (number: number, completion: Promise<void>): void => {
    const settlements = viewedFileSettlements.get(number) ?? new Set<Promise<void>>();
    settlements.add(completion);
    viewedFileSettlements.set(number, settlements);
    const remove = (): void => {
      settlements.delete(completion);
      if (settlements.size === 0 && viewedFileSettlements.get(number) === settlements) {
        viewedFileSettlements.delete(number);
      }
    };
    void completion.then(remove, remove);
  };
  const waitForViewedFileSettlements = async (number: number): Promise<void> => {
    // A settling request can synchronously enqueue a newer generation behind itself. Re-snapshot
    // until no tracked request for this PR remains.
    while (true) {
      const settlements = viewedFileSettlements.get(number);
      if (settlements === undefined || settlements.size === 0) return;
      await Promise.allSettled([...settlements]);
    }
  };
  const cancelViewedWrites = (number: number): void => {
    for (const [key, entry] of viewedFileWrites) {
      if (entry.number === number) viewedFileWrites.delete(key);
    }
  };
  const localViewedFallbackViewers = new Map<number, GitHubViewerIdentity>();
  const MAX_VIEWED_FILE_BATCH_SIZE = 25;
  // The server's generic JSON reader caps UTF-8 bodies at 64 KiB. Keep enough room for request
  // coordinates and JSON escaping while still accepting every individually valid 4,096-char path.
  const MAX_VIEWED_FILE_BATCH_BODY_BYTES = 60_000;
  const viewedFileUtf8 = new TextEncoder();
  const MAX_CONCURRENT_VIEWED_FILE_WRITES = 2;
  const viewedWriteSlotWaiters: Array<() => void> = [];
  let activeViewedFileWrites = 0;
  const acquireViewedWriteSlot = async (): Promise<void> => {
    if (activeViewedFileWrites < MAX_CONCURRENT_VIEWED_FILE_WRITES) {
      activeViewedFileWrites += 1;
      return;
    }
    await new Promise<void>((resolve) => viewedWriteSlotWaiters.push(resolve));
  };
  const releaseViewedWriteSlot = (): void => {
    const next = viewedWriteSlotWaiters.shift();
    if (next) {
      // Ownership transfers directly to the waiter; the active count does not briefly dip and let
      // a newly enqueued write leapfrog the bounded queue.
      next();
    } else {
      activeViewedFileWrites -= 1;
    }
  };
  let prFreshnessRequest: { number: number; revision: PrReviewRevision; promise: Promise<void> } | null = null;
  let prReviewRefreshSeq = 0;
  let prAnalyzeSeq = 0;
  // PR preparation itself may be shared and intentionally drains after UI cancellation. Projection
  // delivery is per-view work: abort it eagerly so stale disposable parses cannot block the next PR.
  let prPrepareProjectionAbort: AbortController | null = null;
  let progressiveDepthSeq = 0;
  let progressiveSymbolSeq = 0;
  let progressiveSymbolScheduleSeq = 0;
  let progressiveNodeSeq = 0;
  let progressiveDepthAbort: AbortController | null = null;
  let progressiveSymbolAbort: AbortController | null = null;
  let progressiveSymbolSearchClient: GraphSymbolSearchClient | null = null;
  let progressiveNodeAbort: AbortController | null = null;
  let canonicalBaselineRestoreSeq = 0;
  let canonicalBaselineLoadSeq = 0;
  let canonicalBaselineLoadAbort: AbortController | null = null;
  let canonicalBaselineLoadPromise: Promise<PrReviewBaseline> | null = null;
  const progressiveNodeRequests = new Map<string, Promise<boolean>>();
  const progressiveWarmKeys = new Set<string>();
  const invalidateProgressiveRequests = () => {
    progressiveDepthAbort?.abort();
    progressiveSymbolAbort?.abort();
    progressiveSymbolSearchClient?.dispose(new DOMException("aborted", "AbortError"));
    progressiveNodeAbort?.abort();
    progressiveDepthAbort = null;
    progressiveSymbolAbort = null;
    progressiveSymbolSearchClient = null;
    progressiveNodeAbort = null;
    canonicalBaselineRestoreSeq += 1;
    canonicalBaselineLoadSeq += 1;
    canonicalBaselineLoadAbort?.abort();
    canonicalBaselineLoadAbort = null;
    canonicalBaselineLoadPromise = null;
    progressiveDepthSeq += 1;
    progressiveSymbolSeq += 1;
    progressiveSymbolScheduleSeq += 1;
    progressiveNodeSeq += 1;
    progressiveNodeRequests.clear();
    progressiveWarmKeys.clear();
  };
  const progressiveNodeSignal = (): AbortSignal => {
    progressiveNodeAbort ??= new AbortController();
    return progressiveNodeAbort.signal;
  };
  // Aggregate metrics and request traces share one invalidation sequence. Each settles independently,
  // while a newer load/environment prevents either stale channel from repainting the store.
  let telemetryFetchSeq = 0;
  // Local code execution is explicit and independently stale-guarded. Selecting another flow or
  // starting a newer run invalidates the prior child-process response without touching telemetry.
  let syntheticExecutionSeq = 0;
  let prAnalyzeCancellation: { sequence: number; resolve: () => void } | null = null;
  let prGraphHandoff: GraphViewLeaseHandoff | null = null;
  let prReviewEntryRequest: { number: number; promise: Promise<void> } | null = null;
  let prReviewResumeRequest: { number: number; promise: Promise<void> } | null = null;
  let prReviewResumeSeq = 0;
  let prResumeProjectionAbort: AbortController | null = null;
  // Edge-evidence context switches are asynchronous source reads; only the latest click may win.
  let edgeEvidenceSeq = 0;
  // Every global source host shares this lane. Node id alone is insufficient because a node slice,
  // its whole file, and edge evidence can all request the same id with different coordinates.
  let codeViewSeq = 0;
  // Dirty-composer navigation stays out of Zustand because callbacks are ephemeral behavior, not
  // renderable state. The composer itself carries the visible confirmation; Discard replays the
  // exact attempted source/lens/revision transition, while Keep editing clears this callback.
  let pendingReviewLineComposerTransition: (() => void) | null = null;
  // A nested review projection destructively removes hidden members from the live scene. Retain one
  // session-only unfiltered/projected pair so the inverse toggle can three-way-merge the user's
  // intervening curation and restore only the members removed by the projection.
  let reviewProjectionFrameBaseline: {
    reviewKey: string;
    index: GraphIndex;
    history: MinimalGraphHistoryEntry[];
    unfiltered: MinimalGraphHistoryEntry;
    projected: MinimalGraphHistoryEntry;
  } | null = null;
  const hasReusableReviewProjectionFrame = (
    state: BlueprintState,
    history: MinimalGraphHistoryEntry[] = state.minimalGraphHistory,
  ): boolean =>
    reviewProjectionFrameBaseline !== null
    && reviewProjectionFrameBaseline.reviewKey === state.review?.context.reviewKey
    && reviewProjectionFrameBaseline.index === state.index
    && reviewProjectionFrameBaseline.history === history;
  const captureHistoryWithReviewProjection = (state: BlueprintState): MinimalGraphHistoryEntry => {
    const entry = captureMinimalGraphHistory(state);
    if (hasReusableReviewProjectionFrame(state)) {
      entry.reviewProjectionBaseline = {
        unfiltered: reviewProjectionFrameBaseline!.unfiltered,
        projected: reviewProjectionFrameBaseline!.projected,
      };
    }
    return entry;
  };
  const prsNextPage: Record<PrsTab, number> = { open: 1, closed: 1 };
  // PR-head reads return an entire file. Share that response across every changed node in the file;
  // fetchCodeView still slices and annotates a separate node-specific view for each caller.
  const codePayloadCache: CodePayloadCache = new Map();
  // Rebuilding/closing the minimal overlay must discard any of its ELK passes still in flight; the
  // extracted review body shares this invalidation with the in-store actions that own the counter.
  const invalidateMinimalLayout = () => {
    minimalLayoutSeq += 1;
  };
  const invalidateModuleLayout = () => {
    moduleLayoutSeq += 1;
  };
  // A PR-review swap/restore replaces the WHOLE artifact/index, so every "built once per artifact"
  // cache must rebuild from the incoming index — and any overlay ELK pass in flight must drop.
  const invalidateArtifactCaches = () => {
    reviewProjectionFrameBaseline = null;
    moduleGraph = null;
    blockDeps = null;
    unitIndex = null;
    unitIndexSource = null;
    codePayloadCache.clear();
    invalidateModuleLayout();
    invalidateMinimalLayout();
  };
  const invalidateSyntheticArtifactBoundary = () => {
    syntheticExecutionSeq += 1;
    flowPaneLayoutSeq += 1;
  };
  const restorePreparedReviewBaseline = (
    getState: () => BlueprintState,
    setState: (partial: Partial<BlueprintState>) => void,
    options: { endSession?: boolean } = {},
  ) => {
    const restoringCanonicalFullBaseline = !initialGraphProvisional
      && initialGraphProjection !== null
      && canonicalBootBaseline !== null
      && getState().prReviewBaseline === canonicalBootBaseline;
    invalidateSyntheticArtifactBoundary();
    const restored = restorePrReviewBaseline(getState, setState, invalidateArtifactCaches, options);
    if (restored) {
      invalidateProgressiveRequests();
      setState({
        progressiveGraph: initialGraphProjection === null || restoringCanonicalFullBaseline ? null : {
          head: initialGraphProjection,
          comparison: null,
          explicitFileIds: [],
          affectedDepth: initialGraphProjection.loadedDepth,
          requestedDepth: initialGraphProjection.requestedDepth,
          status: "ready",
          error: null,
        },
        progressiveSymbols: {
          status: "idle",
          graphId: null,
          generation: null,
          symbols: [],
          indexed: 0,
          total: 0,
          error: null,
        },
        progressivePendingNodeIds: new Set<string>(),
      });
    }
    return restored;
  };
  // Preferences must be available before the boot artifact's review projection is derived: the
  // default-on formatting proof changes graph ownership, not merely a later paint preference.
  const reviewPreferences = readReviewPreferences();
  // The parsed review payload from a `meridian review` artifact (null when the artifact carries no
  // valid `review` extension — e.g. a plain `web`/`view` session). Computed once (the artifact never
  // changes after boot); a GitHub PR opened via reviewPrInGraph can later populate `review` at runtime.
  const artifactReview = deriveReviewData(dependencies.artifact, dependencies.index);
  const initialReviewContext = artifactReview === null
    ? null
    : filterFormattingOnlyReviewContext(
        artifactReview.context,
        dependencies.artifact,
        reviewPreferences.excludeFormatOnlyChanges,
      );
  const initialReviewDiff = formattingAwareArtifactDiff(
    dependencies.artifact,
    reviewPreferences.excludeFormatOnlyChanges,
  );
  const initialReviewProjection = artifactReview
    ? deriveReviewProjection(initialReviewContext!, dependencies.artifact, dependencies.index, {
        baseIndex: null,
        showTests: false,
        hideSourceCommentDiffs: reviewPreferences.hideAddedSourceCommentDiffs,
        diffLines: initialReviewDiff.diffLines,
      })
    : null;
  const review = initialReviewProjection?.review ?? null;
  if (initialReviewProjection !== null) {
    applyChangedIds(dependencies.index, initialReviewProjection.affected.map((node) => node.nodeId));
    applyChangedStatus(
      dependencies.index,
      reviewNodeStatusEntries(
        dependencies.index,
        initialReviewProjection.affected,
        reviewNodeStatusSourcesFromDiff(
          initialReviewDiff.kinds,
          initialReviewDiff.diffLines,
        ),
      ),
    );
  }
  const initialSyntheticExecutionUrl = dependencies.syntheticExecutionUrl ?? null;
  const initialSyntheticExecutionTrust = dependencies.syntheticExecutionTrust === undefined
    ? initialSyntheticExecutionUrl ? { mode: "local" as const } : null
    : dependencies.syntheticExecutionTrust;
  const initialSyntheticScenarios = [...(dependencies.syntheticScenarios ?? [])];
  const initialGraphProjection = dependencies.initialGraphProjection ?? null;
  const initialGraphProvisional = dependencies.initialGraphProvisional === true
    && initialGraphProjection !== null;
  const bootReviewBaseline: PrReviewBaseline = {
    artifact: dependencies.artifact,
    index: dependencies.index,
    review: artifactReview,
    syntheticExecutionUrl: initialSyntheticExecutionUrl,
    syntheticScenarios: initialSyntheticScenarios,
    syntheticExecutionTrust: initialSyntheticExecutionTrust,
  };
  let canonicalBootBaseline = initialGraphProjection === null || initialGraphProvisional
    ? bootReviewBaseline
    : null;
  const loadCanonicalBootBaseline = (): Promise<PrReviewBaseline> => {
    if (canonicalBootBaseline !== null) return Promise.resolve(canonicalBootBaseline);
    const loader = dependencies.loadCanonicalBootArtifact ?? null;
    if (loader === null) {
      return Promise.reject(new Error("the complete boot graph is unavailable"));
    }
    if (canonicalBaselineLoadPromise !== null) return canonicalBaselineLoadPromise;
    const controller = new AbortController();
    const loadSequence = canonicalBaselineLoadSeq;
    canonicalBaselineLoadAbort = controller;
    const promise = loader(controller.signal).then((artifact) => {
      if (controller.signal.aborted || loadSequence !== canonicalBaselineLoadSeq) {
        throw new DOMException("stale canonical baseline load", "AbortError");
      }
      const index = buildGraphIndex(artifact);
      const baseline: PrReviewBaseline = {
        artifact,
        index,
        review: deriveReviewData(artifact, index),
        syntheticExecutionUrl: initialSyntheticExecutionUrl,
        syntheticScenarios: [...initialSyntheticScenarios],
        syntheticExecutionTrust: initialSyntheticExecutionTrust,
      };
      canonicalBootBaseline = baseline;
      return baseline;
    }).finally(() => {
      if (canonicalBaselineLoadAbort === controller) canonicalBaselineLoadAbort = null;
      if (canonicalBaselineLoadPromise === promise) canonicalBaselineLoadPromise = null;
    });
    canonicalBaselineLoadPromise = promise;
    return promise;
  };
  // The files checklist + persisted progress for an artifact-sourced review; a GitHub PR opened via
  // reviewPrInGraph re-derives both at runtime under its own reviewKey.
  const reviewFiles = initialReviewProjection?.files ?? [];
  const initialProgress = review ? readReviewProgress(review.context.reviewKey) : null;
  const initialMigrationFiles = artifactReview
    ? deriveReviewProjection(artifactReview.context, dependencies.artifact, dependencies.index, {
        baseIndex: null,
        showTests: true,
      }).files
    : [];
  const initialMigratedProgress = initialProgress === null
    ? null
    : promoteFullyViewedUnitTicks(initialMigrationFiles, initialProgress.unitTicks, initialProgress.fileTicks);
  if (
    initialProgress !== null
    && (
      Object.keys(initialProgress.unitTicks).length > 0
      || Object.keys(initialProgress.fileTicks).length > 0
    )
  ) {
    writeReviewProgress(review!.context.reviewKey, {
      ...initialProgress,
      unitTicks: initialMigratedProgress!.unitTicks,
      fileTicks: initialMigratedProgress!.fileTicks,
    });
  }
  // Null when the server didn't ship source access — the code drawer is then inert.
  const sourceUrl = dependencies.sourceUrl;
  const githubSource = (dependencies.prSessionSource ?? null) !== null;
  const prsUrl = dependencies.prsUrl;
  const prOneUrl = dependencies.prOneUrl;
  const prFilesUrl = dependencies.prFilesUrl;
  const prViewedFilesUrl = dependencies.prViewedFilesUrl ?? null;
  const prRelatedUrl = dependencies.prRelatedUrl;
  const prCommentsUrl = dependencies.prCommentsUrl;
  const prChecksUrl = dependencies.prChecksUrl;
  const prFileUrl = dependencies.prFileUrl ?? null;
  const analyzeGraphId = dependencies.graphId ?? null;
  const graphProjectUrl = dependencies.graphProjectUrl ?? null;
  const graphSymbolsUrl = dependencies.graphSymbolsUrl ?? null;
  const loadGraphSymbolsInlineForTest = dependencies.loadGraphSymbolsInlineForTest ?? null;
  const metaUrl = dependencies.metaUrl ?? "";
  const graphViewLease = dependencies.graphViewLease ?? null;
  // The route alone is not a usable prepare capability: plain `view` still knows the route name,
  // but has no stored graph id for the request. Expose null in that context so every consumer has
  // one truthful capability flag and reviewPrInGraph takes its synchronous path.
  const analyzeUrl = analyzeGraphId === null ? null : dependencies.analyzeUrl ?? null;
  const prReviewUrl = dependencies.prReviewUrl;
  // The composition tab opens on the WHOLE-SYSTEM overview (null root); file-rooting is the explicit
  // focus tool (⌘P / click a boundary or frame). Auto-rooting at the declared entry module proved a
  // poor default — a React entry (e.g. main.tsx) is a thin bootstrap with no cross-unit coupling, so
  // it roots to a lone card. Predictable overview-first beats a sometimes-empty auto-root; whether to
  // auto-root a meaningful entry is an open design question (see docs/service-composition-design.md §8).
  const defaultCompRoot = null;

  return createStore<BlueprintState>((set, get) => {
    const requestMinimalRelayout = (activity?: LayoutActivity): Promise<void> =>
      get().minimalRelayout(activity);
    const scheduleProgressiveSymbolIndex = (): void => {
      const state = get();
      if (
        state.progressiveGraph === null
        || state.progressiveSymbols.status !== "idle"
      ) {
        return;
      }
      const sequence = ++progressiveSymbolScheduleSeq;
      const run = (): void => {
        if (sequence !== progressiveSymbolScheduleSeq) return;
        void get().startProgressiveSymbolIndex();
      };
      // Exact-revision search scans source syntax in a disposable, bounded worker. Give the browser
      // its first actionable review paint first, then use idle time (with a bounded fallback so
      // search becomes useful even while the main thread remains intermittently busy).
      if (typeof window !== "undefined" && typeof window.requestIdleCallback === "function") {
        window.requestIdleCallback(run, { timeout: 1_500 });
      } else {
        setTimeout(run, 0);
      }
    };
    const scheduleProgressiveLookahead = (): void => {
      const session = get().progressiveGraph;
      if (session === null || graphProjectUrl === null) return;
      const requests = [] as ReturnType<typeof changedFileProjectionRequest>[];
      if (session.affectedDepth < MAX_PROGRESSIVE_AUTOWARM_DEPTH) {
        const depth = session.affectedDepth + 1;
        requests.push(changedFileProjectionRequest(
          session.head.graphId,
          session.head.seedGraphId,
          depth,
          depth,
        ));
        if (session.comparison !== null) {
          requests.push(changedFileProjectionRequest(
            session.comparison.graphId,
            session.head.graphId,
            depth,
            depth,
          ));
        }
      }
      const frontier = new Map(
        session.head.frontier.map((entry) => [entry.fileId, entry.completeThroughDepth]),
      );
      const explicitByNextDepth = new Map<number, string[]>();
      for (const fileId of session.explicitFileIds) {
        const completeThroughDepth = frontier.get(fileId) ?? 0;
        if (completeThroughDepth >= MAX_PROGRESSIVE_AUTOWARM_DEPTH) continue;
        const depth = completeThroughDepth + 1;
        const bucket = explicitByNextDepth.get(depth) ?? [];
        bucket.push(fileId);
        explicitByNextDepth.set(depth, bucket);
      }
      for (const [depth, fileIds] of explicitByNextDepth) {
        requests.push(...fileProjectionRequests(
          session.head.graphId,
          fileIds.sort(),
          depth,
          depth,
        ));
      }
      for (const request of requests) {
        const key = `${session.head.generation}\u0000${JSON.stringify(request)}`;
        if (progressiveWarmKeys.has(key)) continue;
        progressiveWarmKeys.add(key);
        void warmGraphProjection(graphProjectUrl, request).catch(() => {
          // Speculation is advisory and never paints an error state.
        }).finally(() => {
          // This set is an in-flight bound, not a durable success cache: the server's immutable
          // entry can fail or be evicted, so a later user/state transition must be allowed to retry.
          progressiveWarmKeys.delete(key);
        });
      }
    };
    // Compatibility only for a projection layered over an ordinary complete graph document. A
    // partial PR document has `initialGraphProvisional` and never enters this loader.
    const deferCompleteBootDocumentRestore = (replay: () => void): void => {
      const expected = get();
      const expectedReview = expected.prReviewed;
      const expectedPreparedGraph = expected.prPreparedGraphId;
      const sequence = ++canonicalBaselineRestoreSeq;
      set({
        minimalLayoutStatus: "laying-out",
        minimalLayoutActivity: { label: "Restoring original graph…" },
      });
      void loadCanonicalBootBaseline().then((baseline) => {
        const current = get();
        if (
          sequence !== canonicalBaselineRestoreSeq
          || current.prReviewed !== expectedReview
          || current.prPreparedGraphId !== expectedPreparedGraph
          || !current.prPreparedArtifactCurrent
          || current.prReviewBaseline !== null
          || current.minimalSeedIds.length === 0
        ) {
          return;
        }
        // Install only the original non-review document. The replay immediately runs the existing
        // close/lens path, which restores this baseline before changing what the reader can see.
        set({ prReviewBaseline: baseline });
        replay();
      }).catch((error) => {
        if (sequence !== canonicalBaselineRestoreSeq) return;
        const message = error instanceof Error
          ? `Could not restore the original graph: ${error.message}`
          : "Could not restore the original graph.";
        set((current) => current.prReviewed !== expectedReview
          || current.prPreparedGraphId !== expectedPreparedGraph
          || !current.prPreparedArtifactCurrent
          ? {}
          : {
              minimalLayoutStatus: "ready",
              minimalLayoutActivity: null,
              progressiveGraph: current.progressiveGraph === null
                ? null
                : { ...current.progressiveGraph, status: "error", error: message },
            });
      });
    };
    const ensureCompleteBootDocumentRestoreForTransition = async (
      expectedReview: number,
      expectedPreparedGraph: string | null,
      isCurrent: () => boolean,
    ): Promise<boolean> => {
      const current = get();
      if (current.prReviewBaseline !== null || initialGraphProjection === null) return true;
      const sequence = ++canonicalBaselineRestoreSeq;
      try {
        const baseline = await loadCanonicalBootBaseline();
        const latest = get();
        if (
          sequence !== canonicalBaselineRestoreSeq
          || !isCurrent()
          || latest.prReviewed !== expectedReview
          || latest.prPreparedGraphId !== expectedPreparedGraph
          || !latest.prPreparedArtifactCurrent
        ) {
          return false;
        }
        set({ prReviewBaseline: baseline });
        return true;
      } catch (error) {
        if (sequence !== canonicalBaselineRestoreSeq || !isCurrent()) return false;
        const message = error instanceof Error
          ? `Could not restore the original graph: ${error.message}`
          : "Could not restore the original graph.";
        set((latest) => latest.progressiveGraph === null
          ? {}
          : { progressiveGraph: { ...latest.progressiveGraph, status: "error", error: message } });
        return false;
      }
    };
    const guardReviewLineComposerTransition = (transition: () => void): boolean => {
      const current = get().reviewLineComposer;
      const result = requestReviewLineComposerDismissState(current);
      if (result.composer !== current) {
        set({ reviewLineComposer: result.composer });
      }
      if (result.allowed) {
        pendingReviewLineComposerTransition = null;
        return true;
      }
      pendingReviewLineComposerTransition = transition;
      return false;
    };

    type ReviewSubgraphReveal = {
      selectedId: string;
      litNodeIds: ReadonlySet<string>;
    };

    const isRealMinimalNode = (state: BlueprintState, id: string): boolean =>
      state.minimalRfNodes.some((node) => node.id === id && node.type !== "ghost");

    const reviewTargetModuleId = (state: BlueprintState, targetId: string): string | null => {
      const reviewFile = state.reviewFiles.find((file) =>
        file.moduleId === targetId || file.units.some((unit) => unit.nodeId === targetId),
      );
      return reviewFile?.moduleId ?? nearestModuleIds([targetId], state.index)[0] ?? null;
    };

    // A review sidebar target can be absent from the laid scene because a large review substituted
    // its file seed with an owning package rollup. Resolve only that case: ordinary collapsed code
    // still follows the existing paint-only selection path, while a target already on the canvas is
    // centered without changing review scope.
    const hiddenReviewRollupFor = (state: BlueprintState, targetId: string): string | null => {
      if (
        state.review === null
        || state.minimalSeedIds.length === 0
        || state.minimalLayoutStatus !== "ready"
        || state.flowSelection !== null
        || state.reviewFlowBaseline !== null
        || state.syntheticExecutionStatus === "running"
        || isRealMinimalNode(state, targetId)
      ) {
        return null;
      }
      const moduleId = reviewTargetModuleId(state, targetId);
      if (moduleId === null) {
        return null;
      }
      const members = new Set(state.minimalMemberIds);
      for (const ancestor of [...state.index.ancestorsOf(moduleId)].reverse()) {
        const fileIds = state.minimalRollups[ancestor.id];
        if (
          members.has(ancestor.id)
          && fileIds?.includes(moduleId)
          && (ancestor.kind === "package" || ancestor.kind === "directory")
          && state.index.isContainer(ancestor.id)
          && state.reviewFocusedSubgraph?.rootId !== ancestor.id
        ) {
          return ancestor.id;
        }
      }
      return null;
    };

    // Shared implementation for an explicit package double-click and an automatic sidebar reveal.
    // The latter carries its original selection into the exact-file child scene and waits for that
    // scene's layout before signaling the camera, so useRecenter can never fall back to fitting the
    // whole graph because the requested id is still hidden behind the rollup.
    const focusReviewSubgraph = (
      rootId: string,
      reveal: ReviewSubgraphReveal | null,
      retry: () => void,
    ): boolean => {
      const state = get();
      const root = state.index.nodesById.get(rootId);
      if (
        state.review === null
        || state.minimalSeedIds.length === 0
        || state.minimalLayoutStatus !== "ready"
        || state.flowSelection !== null
        || state.reviewFlowBaseline !== null
        || state.syntheticExecutionStatus === "running"
        || root === undefined
        || (root.kind !== "package" && root.kind !== "directory")
        || !state.index.isContainer(rootId)
        || state.reviewFocusedSubgraph?.rootId === rootId
      ) {
        return false;
      }
      const activeGroup = state.reviewActiveGroupId === null
        ? null
        : state.reviewGroups?.groups.find((group) => group.id === state.reviewActiveGroupId) ?? null;
      const groupFiles = activeGroup === null ? null : new Set(activeGroup.files);
      const candidates = state.reviewFiles.filter((file) =>
        file.moduleId !== null
        && (groupFiles === null || groupFiles.has(file.path))
        && isReviewPathInScope(file.path, state.reviewPathScope)
        && state.index.isWithinFocus(rootId, file.moduleId),
      );
      const matched = matchAffectedFiles(state.index, candidates.map((file) => file.path)).matched
        .filter((match) => state.index.isWithinFocus(rootId, match.moduleId));
      const seeds = [...new Set(matched.map((match) => match.moduleId))].sort();
      if (seeds.length === 0) {
        return false;
      }
      if (!guardReviewLineComposerTransition(retry)) {
        return false;
      }
      // Treat the focused root as a rollup boundary only for expansion calculation: every file and
      // declaration below it starts collapsed, while the exact file modules remain the graph seeds.
      const expansionBoundary = new Map<string, string[]>([[rootId, seeds]]);
      const baseExpansion = reviewExpansionForMatches(state.index, matched, expansionBoundary);
      const moduleExpanded = reveal === null
        ? baseExpansion
        : expandedCodePaths(baseExpansion, new Set([reveal.selectedId]), state.index);
      const activity = { label: `Opening ${root.displayName || "container"} subgraph…` };
      syntheticExecutionSeq += 1;
      flowPaneLayoutSeq += 1;
      invalidateMinimalLayout();
      set({
        reviewFocusedSubgraph: {
          rootId,
          label: root.displayName || rootId,
          filePaths: [...new Set(matched.map((match) => match.path))].sort(),
          moduleIds: seeds,
        },
        minimalGraphHistory: [...state.minimalGraphHistory, captureHistoryWithReviewProjection(state)],
        minimalView: "graph",
        minimalShowGhostNodes: false,
        minimalShowNonDiffGhostNodes: true,
        minimalCodebaseExpansionOverrides: new Map<string, boolean>(),
        reviewSelectedId: reveal?.selectedId ?? null,
        reviewLitNodeIds: reveal === null ? null : new Set(reveal.litNodeIds),
        flowSelection: null,
        reviewFlowExplicitView: null,
        flowPaneOrigin: null,
        requestFlowTraceId: null,
        requestFlowExpansionOverrides: new Set<string>(),
        flowPaneExpansionOverrides: new Set<string>(),
        flowPaneCollapsedEdges: new Set<string>(),
        logicSelected: null,
        flowPaneRfNodes: [] as LogicRfNode[],
        flowPaneRfEdges: [] as LogicRfEdge[],
        flowPaneLayoutStatus: "idle" as const,
        reviewFlowBaseline: null,
        ...syntheticExecutionReset(),
        syntheticExperimentRootId: null,
        syntheticInputOverrides: [],
        syntheticFieldWatchers: [],
        syntheticEditorRequest: null,
        moduleSelected: reveal === null ? new Set<string>() : new Set([reveal.selectedId]),
        moduleExpanded,
        minimalSeedIds: seeds,
        minimalMemberIds: [...seeds],
        minimalRollups: {},
        minimalBasePositions: {},
        minimalArrange: false,
        minimalRfNodes: [],
        minimalRfEdges: [],
        minimalLayoutStatus: "laying-out",
        minimalLayoutActivity: activity,
      });
      reviewProjectionFrameBaseline = null;
      void requestMinimalRelayout(activity).then(() => {
        const current = get();
        if (
          reveal !== null
          && current.minimalLayoutStatus === "ready"
          && current.reviewFocusedSubgraph?.rootId === rootId
          && current.reviewSelectedId === reveal.selectedId
          && isRealMinimalNode(current, reveal.selectedId)
        ) {
          set({ recenterSeq: current.recenterSeq + 1, recenterTargetId: null });
        }
      });
      return true;
    };

    // Once a container is already focused there is no rollup left to open. A unit in another exact
    // file can still be behind that file/class's disclosure gates, so reveal it in the current child
    // scene without pushing a duplicate history frame.
    const revealWithinFocusedReviewSubgraph = (
      state: BlueprintState,
      reveal: ReviewSubgraphReveal,
      retry: () => void,
    ): boolean => {
      const focused = state.reviewFocusedSubgraph;
      const moduleId = reviewTargetModuleId(state, reveal.selectedId);
      if (
        focused === null
        || moduleId === null
        || !focused.moduleIds.includes(moduleId)
        || state.minimalLayoutStatus !== "ready"
        || state.flowSelection !== null
        || state.reviewFlowBaseline !== null
        || state.syntheticExecutionStatus === "running"
        || isRealMinimalNode(state, reveal.selectedId)
      ) {
        return false;
      }
      const moduleExpanded = expandedCodePaths(
        state.moduleExpanded,
        new Set([reveal.selectedId]),
        state.index,
      );
      if (sameStringSet(moduleExpanded, state.moduleExpanded)) {
        return false;
      }
      if (!guardReviewLineComposerTransition(retry)) {
        return true;
      }
      set({
        moduleSelected: new Set([reveal.selectedId]),
        moduleExpanded,
        reviewSelectedId: reveal.selectedId,
        reviewLitNodeIds: new Set(reveal.litNodeIds),
        flowSelection: null,
        reviewFlowExplicitView: null,
        flowPaneExpansionOverrides: new Set<string>(),
        flowPaneCollapsedEdges: new Set<string>(),
        logicSelected: null,
        flowPaneRfNodes: [],
        flowPaneRfEdges: [],
        flowPaneLayoutStatus: "idle",
        reviewFlowBaseline: null,
      });
      void requestMinimalRelayout({ label: "Revealing changed node…" }).then(() => {
        const current = get();
        if (
          current.minimalLayoutStatus === "ready"
          && current.reviewFocusedSubgraph?.rootId === focused.rootId
          && current.reviewSelectedId === reveal.selectedId
          && isRealMinimalNode(current, reveal.selectedId)
        ) {
          set({ recenterSeq: current.recenterSeq + 1, recenterTargetId: null });
        }
      });
      return true;
    };

    const reprojectArtifactReview = (showTests: boolean): void => {
      const state = get();
      if (state.prReviewed !== null || artifactReview === null || state.review === null) {
        return;
      }
      const context = filterFormattingOnlyReviewContext(
        artifactReview.context,
        state.artifact,
        state.reviewExcludeFormatOnlyChanges,
      );
      const capturedFrame = state.minimalSeedIds.length > 0
        ? captureMinimalGraphHistory(state)
        : null;
      const history = state.minimalGraphHistory;
      const reusableBaseline = capturedFrame !== null
        && hasReusableReviewProjectionFrame(state, history);
      const frame = capturedFrame === null
        ? null
        : reusableBaseline
          ? mergeReviewProjectionFrame(
              reviewProjectionFrameBaseline!.unfiltered,
              reviewProjectionFrameBaseline!.projected,
              capturedFrame,
            )
          : capturedFrame;
      const statusDiff = formattingAwareArtifactDiff(
        state.artifact,
        state.reviewExcludeFormatOnlyChanges,
      );
      const projection = deriveReviewProjection(context, state.artifact, state.index, {
        baseIndex: null,
        showTests,
        hideSourceCommentDiffs: state.reviewHideAddedSourceCommentDiffs,
        diffLines: statusDiff.diffLines,
      });
      applyChangedIds(state.index, projection.affected.map((node) => node.nodeId));
      applyChangedStatus(
        state.index,
        reviewNodeStatusEntries(
          state.index,
          projection.affected,
          reviewNodeStatusSourcesFromDiff(
            statusDiff.kinds,
            statusDiff.diffLines,
          ),
        ),
      );
      const visiblePaths = new Set(projection.files.map((file) => file.path));
      const excludedPaths = artifactReview.context.changedFiles
        .map((file) => file.path)
        .filter((path) => !visiblePaths.has(path));
      const excludedMatches = matchAffectedFiles(state.index, excludedPaths).matched;
      const excludedModuleIds = new Set(excludedMatches.map((match) => match.moduleId));
      const excludedFiles = new Set(excludedMatches.map((match) => match.file));
      const keepDirect = (id: string): boolean => {
        if (!showTests && state.index.testIds.has(id)) return false;
        const owner = flowStepArtifactOwner(state, id, frame?.moduleExpanded ?? state.moduleExpanded) ?? id;
        if (excludedModuleIds.has(owner)) return false;
        const file = state.index.nodesById.get(owner)?.location.file;
        return file === undefined || !excludedFiles.has(file);
      };
      const keep = (id: string): boolean => {
        const rollupFiles = frame !== null && Object.hasOwn(frame.minimalRollups, id)
          ? frame.minimalRollups[id]
          : undefined;
        return rollupFiles === undefined ? keepDirect(id) : rollupFiles.some(keepDirect);
      };
      const activeGroup = state.reviewActiveGroupId === null
        ? null
        : state.reviewGroups?.groups.find((group) => group.id === state.reviewActiveGroupId) ?? null;
      const previousVisiblePaths = new Set(state.reviewFiles.map((file) => file.path));
      const revealsFiles = projection.files.some((file) => !previousVisiblePaths.has(file.path));
      const scopedReveal = frame !== null
        && !reusableBaseline
        && frame.flowSelection === null
        && revealsFiles
        && (
          frame.reviewActiveGroupId !== null
          || frame.reviewPathScope !== null
          || frame.reviewFocusedSubgraph !== null
        )
        ? {
            previous: deriveReviewScopedFrame(
              state.index,
              state.reviewFiles,
              activeGroup,
              frame.reviewPathScope,
              frame.reviewFocusedSubgraph,
              {
                baseNodeIds: state.reviewBaseNodeIds,
                deletedNodeIds: state.reviewDeletedNodeIds,
              },
            ),
            next: deriveReviewScopedFrame(
              state.index,
              projection.files,
              activeGroup,
              frame.reviewPathScope,
              frame.reviewFocusedSubgraph,
              {
                baseNodeIds: state.reviewBaseNodeIds,
                deletedNodeIds: state.reviewDeletedNodeIds,
              },
            ),
          }
        : null;
      const currentVisibleMembers = frame?.minimalMemberIds.filter(keep) ?? [];
      const minimalSeedIds = frame === null
        ? []
        : scopedReveal === null
          ? frame.minimalSeedIds
          : mergeProjectionList(
              scopedReveal.next.seeds,
              scopedReveal.previous.seeds,
              frame.minimalSeedIds,
            );
      const minimalMemberIds = scopedReveal === null
        ? currentVisibleMembers
        : mergeProjectionList(
            scopedReveal.next.seeds,
            scopedReveal.previous.seeds,
            currentVisibleMembers,
          );
      const currentVisibleExpanded = frame === null
        ? new Set<string>()
        : new Set([...frame.moduleExpanded].filter(keep));
      const moduleExpanded = scopedReveal === null
        ? currentVisibleExpanded
        : mergeProjectionSet(
            scopedReveal.next.expanded,
            scopedReveal.previous.expanded,
            currentVisibleExpanded,
          );
      const reviewFocusedSubgraph = scopedReveal?.next.focused ?? (
        frame?.reviewFocusedSubgraph === null || frame === null
        ? null
        : {
            ...frame.reviewFocusedSubgraph,
            moduleIds: frame.reviewFocusedSubgraph.moduleIds.filter(keep),
            filePaths: frame.reviewFocusedSubgraph.filePaths.filter((path) => visiblePaths.has(path)),
          }
      );
      set({
        review: projection.review,
        reviewFiles: projection.files,
        reviewAffectedIds: new Set(projection.affected.map((node) => node.nodeId)),
        ...(frame === null
          ? {}
          : {
              ...restoreMinimalGraphHistory(frame),
              minimalGraphHistory: history,
              minimalSeedIds,
              minimalMemberIds,
              minimalRollups: scopedReveal === null
                ? Object.fromEntries(
                    Object.entries(frame.minimalRollups)
                      .map(([id, fileIds]) => [id, fileIds.filter(keep)] as const)
                      .filter(([id, fileIds]) => keep(id) && fileIds.length > 0),
                  )
                : rollupsRecord(scopedReveal.next.rolledUp),
              moduleSelected: new Set([...frame.moduleSelected].filter(keep)),
              moduleExpanded,
              reviewSelectedId: frame.reviewSelectedId !== null && keep(frame.reviewSelectedId)
                ? frame.reviewSelectedId
                : null,
              reviewLitNodeIds: frame.reviewLitNodeIds === null
                ? null
                : new Set([...frame.reviewLitNodeIds].filter(keep)),
              reviewFocusedSubgraph,
              logicSelected: frame.logicSelected !== null && keep(frame.logicSelected)
                ? frame.logicSelected
                : null,
              minimalRfNodes: [],
              minimalRfEdges: [],
              minimalLayoutStatus: minimalMemberIds.length > 0 ? "laying-out" as const : "idle" as const,
              minimalLayoutActivity: minimalMemberIds.length > 0
                ? { label: "Refreshing review graph…" }
                : null,
            }),
      });
      if (frame !== null) {
        const committed = get();
        reviewProjectionFrameBaseline = excludedPaths.length === 0
          ? null
          : {
              reviewKey: committed.review!.context.reviewKey,
              index: committed.index,
              history,
              unfiltered: frame,
              projected: captureMinimalGraphHistory(committed),
            };
        if (minimalMemberIds.length > 0) {
          void requestMinimalRelayout({ label: "Refreshing review graph…" });
        }
      }
    };

    const flowStepArtifactOwner = (
      state: BlueprintState,
      id: string,
      expanded: ReadonlySet<string> = state.moduleExpanded,
    ): string | null => {
      if (!id.startsWith("step:")) {
        return null;
      }
      const flows = (state.artifact.extensions?.logicFlow ?? {}) as unknown as LogicFlows;
      return resolveFlowStep(id, state.index, expanded, flows)?.artifactOwnerId ?? null;
    };

    const idPassesTestsProjection = (
      state: BlueprintState,
      id: string,
      expanded: ReadonlySet<string> = state.moduleExpanded,
    ): boolean => {
      if (state.showTests) {
        return true;
      }
      const owner = flowStepArtifactOwner(state, id, expanded);
      return !state.index.testIds.has(id) && (owner === null || !state.index.testIds.has(owner));
    };

    /** Nodes excluded from the canonical review transaction must also be hidden from the coupling
     * ring, otherwise a visible neighbour can re-materialize them as ghosts after their seed/file
     * row was removed. Ancestor-aware ghost filtering closes over each matched file module. */
    const reviewProjectionHiddenIds = (state: BlueprintState): ReadonlySet<string> => {
      const hidden = new Set(state.showTests ? EMPTY_HIDDEN_IDS : state.index.testIds);
      if (state.review === null) return hidden;
      const visiblePaths = new Set(state.reviewFiles.map((file) => file.path));
      const excludedPaths = state.review.context.changedFiles
        .map((file) => file.path)
        .filter((path) => !visiblePaths.has(path));
      for (const match of matchAffectedFiles(state.index, excludedPaths).matched) {
        hidden.add(match.moduleId);
      }
      return hidden;
    };

    const idPassesReviewDiffProjection = (
      state: BlueprintState,
      id: string,
      visibleIds: ReadonlySet<string>,
    ): boolean => {
      if (visibleIds.has(id)) {
        return true;
      }
      const owner = flowStepArtifactOwner(state, id);
      return owner !== null && visibleIds.has(owner);
    };

    /** Recompute live-PR metadata/artifact paint without letting its root seeding destroy the
     * current recursively extracted frame. Layout is deferred until that frame is restored. */
    const reprojectLivePrReview = (
      label: string,
      rebuildFlowPane = false,
      scheduleLayout = true,
    ): boolean => {
      const before = get();
      if (before.prReviewed === null) {
        return false;
      }
      const capturedFrame = captureMinimalGraphHistory(before);
      const history = before.minimalGraphHistory;
      const reusableBaseline = hasReusableReviewProjectionFrame(before, history);
      const frame = reusableBaseline
        ? mergeReviewProjectionFrame(
            reviewProjectionFrameBaseline!.unfiltered,
            reviewProjectionFrameBaseline!.projected,
            capturedFrame,
          )
        : capturedFrame;
      const rootProjectionBefore = (
        history.length === 0
        && frame.reviewActiveGroupId === null
        && frame.reviewPathScope === null
        && frame.reviewFocusedSubgraph === null
        && frame.flowSelection === null
      )
        ? deriveReviewScopedFrame(
            before.index,
            before.reviewFiles,
            null,
            null,
            null,
            {
              baseNodeIds: before.reviewBaseNodeIds,
              deletedNodeIds: before.reviewDeletedNodeIds,
            },
          )
        : null;
      const previousGroup = before.reviewActiveGroupId === null
        ? null
        : before.reviewGroups?.groups.find((group) => group.id === before.reviewActiveGroupId) ?? null;
      const applied = applyPrReviewToMap(
        get,
        set,
        prFilesUrl,
        invalidateMinimalLayout,
        invalidateModuleLayout,
        invalidateArtifactCaches,
        { reprojecting: true, preserveReviewSelection: true, scheduleLayout: false },
      );
      if (!applied) {
        return false;
      }

      const projected = get();
      // Frame restoration owns the next scene, even when filtering leaves it intentionally empty.
      // Invalidate the outgoing pass before restoring; applyPrReviewToMap was asked not to queue a
      // transient root-review layout of its own.
      invalidateMinimalLayout();
      const projectedFilePaths = new Set(projected.reviewFiles.map((file) => file.path));
      const excludedChangedPaths = new Set(
        (projected.review?.context.changedFiles ?? [])
          .map((file) => file.path)
          .filter((path) => !projectedFilePaths.has(path)),
      );
      const excludedMatches = matchAffectedFiles(projected.index, [...excludedChangedPaths]).matched;
      const excludedModuleIds = new Set(excludedMatches.map((match) => match.moduleId));
      const excludedCanonicalFiles = new Set(excludedMatches.map((match) => match.file));
      const keepDirect = (id: string) => {
        if (!idPassesTestsProjection(projected, id, frame.moduleExpanded)) return false;
        const owner = flowStepArtifactOwner(projected, id, frame.moduleExpanded) ?? id;
        if (excludedModuleIds.has(owner)) return false;
        const file = projected.index.nodesById.get(owner)?.location.file;
        return file === undefined || !excludedCanonicalFiles.has(file);
      };
      const keep = (id: string) => {
        const rollupFiles = Object.hasOwn(frame.minimalRollups, id)
          ? frame.minimalRollups[id]
          : undefined;
        return rollupFiles === undefined
          ? keepDirect(id)
          : rollupFiles.some(keepDirect);
      };
      const survivingGroupFiles = new Set(
        (previousGroup?.files ?? []).filter((path) => projectedFilePaths.has(path)),
      );
      const exactProjectedGroup = frame.reviewActiveGroupId === null
        ? null
        : projected.reviewGroups?.groups.find((group) => group.id === frame.reviewActiveGroupId) ?? null;
      const projectedGroup = exactProjectedGroup !== null
        ? { group: exactProjectedGroup, overlap: exactProjectedGroup.files.length }
        : previousGroup === null || survivingGroupFiles.size === 0
          ? null
          : (projected.reviewGroups?.groups ?? [])
            .map((group) => ({
              group,
              overlap: group.files.filter((path) => survivingGroupFiles.has(path)).length,
            }))
            .sort((left, right) => right.overlap - left.overlap || left.group.id.localeCompare(right.group.id))[0];
      const reviewActiveGroupId = projectedGroup !== null && projectedGroup.overlap > 0
        ? projectedGroup.group.id
        : null;
      const activeGroupFiles = reviewActiveGroupId === null
        ? null
        : new Set(projectedGroup?.group.files ?? []);
      const reviewPathScope = frame.reviewPathScope !== null
        && projected.reviewFiles.some((file) =>
          (activeGroupFiles === null || activeGroupFiles.has(file.path))
          && isReviewPathInScope(file.path, frame.reviewPathScope),
        )
          ? frame.reviewPathScope
          : null;
      const beforeVisiblePaths = new Set(before.reviewFiles.map((file) => file.path));
      const revealsFiles = projected.reviewFiles.some((file) => !beforeVisiblePaths.has(file.path));
      const scopedReveal = !reusableBaseline
        && revealsFiles
        && (
          frame.reviewActiveGroupId !== null
          || frame.reviewPathScope !== null
          || frame.reviewFocusedSubgraph !== null
        )
        ? {
            previous: deriveReviewScopedFrame(
              before.index,
              before.reviewFiles,
              previousGroup,
              frame.reviewPathScope,
              frame.reviewFocusedSubgraph,
              {
                baseNodeIds: before.reviewBaseNodeIds,
                deletedNodeIds: before.reviewDeletedNodeIds,
              },
            ),
            next: deriveReviewScopedFrame(
              projected.index,
              projected.reviewFiles,
              projectedGroup?.group ?? null,
              reviewPathScope,
              frame.reviewFocusedSubgraph,
              {
                baseNodeIds: projected.reviewBaseNodeIds,
                deletedNodeIds: projected.reviewDeletedNodeIds,
              },
            ),
          }
        : null;
      // A selected logic flow temporarily replaces the graph scene, but its baseline is still the
      // scoped file-review scene. Reconcile newly visible files into that baseline so closing the
      // flow restores the updated projection. Re-derive the corresponding old/new flow scenes too:
      // a rollup can cross its threshold while the flow is open, and the immediate reveal must be
      // identical to closing and reopening that same flow from the updated baseline.
      const sceneScopedReveal = frame.flowSelection === null ? scopedReveal : null;
      const flowSelection = frame.flowSelection !== null && keep(frame.flowSelection.rootId)
        ? frame.flowSelection
        : null;
      const scopedFlowReveal = scopedReveal !== null
        && frame.flowSelection !== null
        && flowSelection !== null
        ? {
            previous: deriveReviewScopedFlowScene(
              before.index,
              (before.artifact.extensions?.logicFlow ?? {}) as unknown as LogicFlows,
              frame.flowSelection,
              scopedReveal.previous,
            ),
            next: deriveReviewScopedFlowScene(
              projected.index,
              (projected.artifact.extensions?.logicFlow ?? {}) as unknown as LogicFlows,
              flowSelection,
              scopedReveal.next,
            ),
          }
        : null;
      // Origins remain as the overlay sentinel when every current member is filtered (the live PR
      // root uses the same raw-seed/empty-member contract for an all-test review), keeping Back
      // reachable from a test-only nested child.
      const currentVisibleMembers = frame.minimalMemberIds.filter(keep);
      const minimalSeedIds = rootProjectionBefore !== null
        ? projected.minimalSeedIds
        : scopedFlowReveal !== null
        ? mergeProjectionList(
            scopedFlowReveal.next.minimalSeedIds,
            scopedFlowReveal.previous.minimalSeedIds,
            frame.minimalSeedIds,
          )
        : sceneScopedReveal !== null
          ? mergeProjectionList(
            sceneScopedReveal.next.seeds,
            sceneScopedReveal.previous.seeds,
            frame.minimalSeedIds,
          )
          : frame.minimalSeedIds;
      const minimalMemberIds = rootProjectionBefore !== null
        ? mergeProjectionList(
            projected.minimalMemberIds,
            rootProjectionBefore.seeds,
            currentVisibleMembers,
          )
        : scopedFlowReveal !== null
        ? mergeProjectionList(
            scopedFlowReveal.next.minimalMemberIds,
            scopedFlowReveal.previous.minimalMemberIds,
            currentVisibleMembers,
          )
        : sceneScopedReveal !== null
          ? mergeProjectionList(
            sceneScopedReveal.next.seeds,
            sceneScopedReveal.previous.seeds,
            currentVisibleMembers,
          )
          : currentVisibleMembers;
      const moduleSelected = new Set([...frame.moduleSelected].filter(keep));
      const currentVisibleExpanded = new Set([...frame.moduleExpanded].filter(keep));
      const moduleExpanded = rootProjectionBefore !== null
        ? mergeProjectionSet(
            projected.moduleExpanded,
            rootProjectionBefore.expanded,
            currentVisibleExpanded,
          )
        : scopedFlowReveal !== null
        ? mergeProjectionSet(
            scopedFlowReveal.next.moduleExpanded,
            scopedFlowReveal.previous.moduleExpanded,
            currentVisibleExpanded,
          )
        : sceneScopedReveal !== null
          ? mergeProjectionSet(
            sceneScopedReveal.next.expanded,
            sceneScopedReveal.previous.expanded,
            currentVisibleExpanded,
          )
          : currentVisibleExpanded;
      const reviewLitNodeIds = frame.reviewLitNodeIds === null
        ? null
        : new Set([...frame.reviewLitNodeIds].filter(keep));
      const reviewSelectedId = frame.reviewSelectedId !== null && keep(frame.reviewSelectedId)
        ? frame.reviewSelectedId
        : null;
      const logicSelected = frame.logicSelected !== null && keep(frame.logicSelected)
        ? frame.logicSelected
        : null;
      const filteredFlowBaseline = frame.reviewFlowBaseline === null
        ? null
        : {
            ...frame.reviewFlowBaseline,
            moduleSelected: new Set([...frame.reviewFlowBaseline.moduleSelected].filter(keep)),
            moduleExpanded: new Set([...frame.reviewFlowBaseline.moduleExpanded].filter(keep)),
            minimalSeedIds: frame.reviewFlowBaseline.minimalSeedIds,
            minimalMemberIds: frame.reviewFlowBaseline.minimalMemberIds.filter(keep),
            reviewSelectedId: frame.reviewFlowBaseline.reviewSelectedId !== null
              && keep(frame.reviewFlowBaseline.reviewSelectedId)
                ? frame.reviewFlowBaseline.reviewSelectedId
                : null,
            reviewLitNodeIds: frame.reviewFlowBaseline.reviewLitNodeIds === null
              ? null
              : new Set([...frame.reviewFlowBaseline.reviewLitNodeIds].filter(keep)),
          };
      const projectedFlowBaseline = (
        filteredFlowBaseline === null
        || scopedReveal === null
        || frame.flowSelection === null
      )
        ? filteredFlowBaseline
        : {
            ...filteredFlowBaseline,
            moduleExpanded: mergeProjectionSet(
              scopedReveal.next.expanded,
              scopedReveal.previous.expanded,
              filteredFlowBaseline.moduleExpanded,
            ),
            minimalSeedIds: mergeProjectionList(
              scopedReveal.next.seeds,
              scopedReveal.previous.seeds,
              filteredFlowBaseline.minimalSeedIds,
            ),
            minimalMemberIds: mergeProjectionList(
              scopedReveal.next.seeds,
              scopedReveal.previous.seeds,
              filteredFlowBaseline.minimalMemberIds,
            ),
          };
      const filteredFlow = frame.flowSelection !== null && flowSelection === null;
      const reviewFlowBaseline = flowSelection === null ? null : projectedFlowBaseline;
      const effectiveMinimalSeedIds = filteredFlow && projectedFlowBaseline !== null
        ? projectedFlowBaseline.minimalSeedIds
        : minimalSeedIds;
      const effectiveMinimalMemberIds = filteredFlow && projectedFlowBaseline !== null
        ? projectedFlowBaseline.minimalMemberIds
        : minimalMemberIds;
      const effectiveModuleSelected = filteredFlow && projectedFlowBaseline !== null
        ? projectedFlowBaseline.moduleSelected
        : moduleSelected;
      const effectiveModuleExpanded = filteredFlow && projectedFlowBaseline !== null
        ? projectedFlowBaseline.moduleExpanded
        : moduleExpanded;
      const effectiveReviewSelectedId = filteredFlow && projectedFlowBaseline !== null
        ? projectedFlowBaseline.reviewSelectedId
        : reviewSelectedId;
      const effectiveReviewLitNodeIds = filteredFlow && projectedFlowBaseline !== null
        ? projectedFlowBaseline.reviewLitNodeIds
        : reviewLitNodeIds;
      if (filteredFlow) {
        syntheticExecutionSeq += 1;
        flowPaneLayoutSeq += 1;
      }
      const visibleReviewPaths = new Set(projected.reviewFiles.map((file) => file.path));
      const reviewFocusedSubgraph = scopedReveal?.next.focused ?? (frame.reviewFocusedSubgraph === null
        ? null
        : {
            ...frame.reviewFocusedSubgraph,
            moduleIds: frame.reviewFocusedSubgraph.moduleIds.filter(keep),
            filePaths: frame.reviewFocusedSubgraph.filePaths.filter((path) => visibleReviewPaths.has(path)),
          });
      const restore = restoreMinimalGraphHistory(frame);
      set({
        ...restore,
        minimalGraphHistory: history,
        reviewActiveGroupId,
        reviewPathScope,
        reviewFocusedSubgraph,
        minimalSeedIds: effectiveMinimalSeedIds,
        minimalMemberIds: effectiveMinimalMemberIds,
        ...(filteredFlow && projectedFlowBaseline !== null
          ? {
              minimalBasePositions: projectedFlowBaseline.minimalBasePositions,
              minimalArrange: projectedFlowBaseline.minimalArrange,
            }
          : {}),
        minimalRollups: scopedReveal === null
          ? Object.fromEntries(
              Object.entries(frame.minimalRollups)
                .map(([id, fileIds]) => [id, fileIds.filter(keep)] as const)
                .filter(([id, fileIds]) => keep(id) && fileIds.length > 0),
            )
          : rollupsRecord(scopedReveal.next.rolledUp),
        moduleSelected: effectiveModuleSelected,
        moduleExpanded: effectiveModuleExpanded,
        reviewSelectedId: effectiveReviewSelectedId,
        reviewLitNodeIds: effectiveReviewLitNodeIds !== null && effectiveReviewLitNodeIds.size > 0
          ? effectiveReviewLitNodeIds
          : null,
        logicSelected: filteredFlow ? null : logicSelected,
        flowSelection,
        reviewFlowBaseline,
        ...(filteredFlow
          ? {
              flowPaneOrigin: null,
              requestFlowTraceId: null,
              requestFlowExpansionOverrides: new Set<string>(),
              flowPaneExpansionOverrides: new Set<string>(),
              flowPaneCollapsedEdges: new Set<string>(),
              ...syntheticExecutionReset(),
              syntheticExperimentRootId: null,
              syntheticInputOverrides: [],
              syntheticFieldWatchers: [],
              syntheticEditorRequest: null,
            }
          : {}),
        flowPaneRfNodes: [],
        flowPaneRfEdges: [],
        flowPaneLayoutStatus: "idle",
        ...(rootProjectionBefore === null
          ? {}
          : { minimalRollups: projected.minimalRollups }),
        minimalRfNodes: [],
        minimalRfEdges: [],
        minimalLayoutStatus: effectiveMinimalMemberIds.length > 0 ? "laying-out" : "idle",
        minimalLayoutActivity: effectiveMinimalMemberIds.length > 0 ? { label } : null,
      });
      const committed = get();
      reviewProjectionFrameBaseline = excludedChangedPaths.size === 0
        ? null
        : {
            reviewKey: committed.review!.context.reviewKey,
            index: committed.index,
            history,
            unfiltered: frame,
            projected: captureMinimalGraphHistory(committed),
          };
      if (scheduleLayout && effectiveMinimalMemberIds.length > 0) {
        void requestMinimalRelayout({ label });
      }
      if (
        scheduleLayout
        && rebuildFlowPane
        && flowSelection !== null
        && (
          frame.flowPaneOrigin === "synthetic"
          || (projected.reviewOpenFlowSplitOnSelect && projected.reviewFlowSplitView === "graph")
        )
      ) {
        void get().flowPaneRelayout();
      }
      return true;
    };

    const mutatePrReviewComment = async (mutation: {
      number: number;
      action: "edit" | "reply";
      commentId: number;
      body: string;
      reviewKey: string;
    }): Promise<boolean> => {
      // A mutation response is a fresh discussion snapshot. Invalidate an older selection/refresh
      // read now, then invalidate any read started during the POST when the response is committed.
      prDiscussionSeq += 1;
      set({
        prCommentMutationStatus: "submitting",
        prCommentMutationId: mutation.commentId,
        prCommentMutationError: null,
      });
      const ownsLane = () => {
        const current = get();
        return current.prCommentMutationStatus === "submitting"
          && current.prCommentMutationId === mutation.commentId;
      };
      const sameReview = () => {
        const current = get();
        return current.prReviewed === mutation.number
          && current.prSelected === mutation.number
          && current.review?.context.reviewKey === mutation.reviewKey;
      };
      try {
        const response = await fetch(prCommentsUrl, {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            number: mutation.number,
            action: mutation.action,
            commentId: mutation.commentId,
            body: mutation.body,
          }),
        });
        if (!ownsLane()) {
          return false;
        }
        if (!sameReview()) {
          set({ prCommentMutationStatus: "idle", prCommentMutationId: null, prCommentMutationError: null });
          return false;
        }
        if (!response.ok) {
          const error = await prCommentErrorMessage(response);
          if (ownsLane()) {
            set({
              prCommentMutationStatus: "idle",
              prCommentMutationId: null,
              prCommentMutationError: sameReview() ? error : null,
            });
          }
          return false;
        }
        const discussion = (await response.json()) as PrDiscussionResult;
        if (!ownsLane() || !sameReview()) {
          if (ownsLane()) {
            set({ prCommentMutationStatus: "idle", prCommentMutationId: null, prCommentMutationError: null });
          }
          return false;
        }
        prDiscussionSeq += 1;
        set({
          prDiscussion: { comments: discussion.comments, reviews: discussion.reviews },
          prCommentMutationStatus: "idle",
          prCommentMutationId: null,
          prCommentMutationError: null,
        });
        return true;
      } catch {
        if (ownsLane()) {
          set({
            prCommentMutationStatus: "idle",
            prCommentMutationId: null,
            prCommentMutationError: sameReview() ? "could not reach the server" : null,
          });
        }
        return false;
      }
    };

    const sameViewedReview = (number: number): boolean => {
      const current = get();
      return current.prReviewed === number
        && current.review !== null;
    };

    const sameActiveReview = (number: number): boolean =>
      sameViewedReview(number) && get().prSelected === number;

    const viewedWriteKey = (number: number, path: string): string => `${number}\0${path}`;

    const sameViewedSnapshot = (entry: ViewedFileWrite): boolean => {
      const current = get();
      return sameViewedReview(entry.number)
        && !current.prReviewStale
        && normalizedGitHubSha(current.prReviewRevision?.headSha) === normalizedGitHubSha(entry.expectedHeadSha)
        && current.reviewViewedFilesViewerId === entry.viewerId
        && current.reviewFileViewedStates !== null;
    };

    const discardViewedWrite = (key: string, entry: ViewedFileWrite): void => {
      entry.running = false;
      if (viewedFileWrites.get(key) === entry) viewedFileWrites.delete(key);
    };

    const clearViewedWriteUi = (path: string): void => {
      const current = get();
      const pending = new Set(current.reviewViewedFileSyncPending);
      pending.delete(path);
      const errors = { ...current.reviewViewedFileSyncErrors };
      delete errors[path];
      set({ reviewViewedFileSyncPending: pending, reviewViewedFileSyncErrors: errors });
    };

    const clearSyncedLocalFileTick = (path: string, viewerId: string, viewed: boolean): void => {
      const current = get();
      const file = current.reviewFiles.find((candidate) => candidate.path === path);
      const tick = file === undefined
        ? Object.hasOwn(current.reviewFileTicks, path) ? current.reviewFileTicks[path] : undefined
        : tickForFile(file, current.reviewFileTicks);
      if (
        tick === undefined
        || (
          tick.viewerId !== undefined
          && tick.viewerId !== viewerId
        )
      ) {
        return;
      }
      const nextTicks = file === undefined
        ? { ...current.reviewFileTicks }
        : removeReviewFileTick(current.reviewFileTicks, file);
      if (file === undefined) delete nextTicks[path];
      set({
        reviewFileTicks: nextTicks,
        reviewUnitTicks: viewed && file !== undefined
          ? removeReviewUnitTicks(current.reviewUnitTicks, file.units)
          : current.reviewUnitTicks,
      });
      persistReviewProgress(get());
    };

    const failViewedWritesForStaleHead = (number: number, message: string): void => {
      cancelViewedWrites(number);
      if (!sameViewedReview(number)) return;
      let fileTicks = get().reviewFileTicks;
      for (const [path, tick] of Object.entries(fileTicks)) {
        if (tick.headSha === undefined) continue;
        fileTicks = { ...fileTicks };
        delete fileTicks[path];
      }
      set({
        prReviewStale: true,
        reviewViewedFilesError: message,
        reviewFileTicks: fileTicks,
        reviewViewedFileSyncPending: new Set<string>(),
        reviewViewedFileSyncErrors: {},
      });
      persistReviewProgress(get());
    };

    const failViewedWrite = (key: string, entry: ViewedFileWrite, message: string, stale = false): void => {
      entry.running = false;
      if (!sameViewedSnapshot(entry)) {
        discardViewedWrite(key, entry);
        return;
      }
      if (stale) {
        // One immutable-head conflict invalidates the whole optimistic group. Stop every queued or
        // in-flight sibling so none can race a now-obsolete revision.
        failViewedWritesForStaleHead(entry.number, message);
        return;
      }
      const pending = new Set(get().reviewViewedFileSyncPending);
      pending.delete(entry.path);
      set({
        reviewViewedFileSyncPending: pending,
        reviewViewedFileSyncErrors: { ...get().reviewViewedFileSyncErrors, [entry.path]: message },
      });
    };

    const enterLocalViewedMode = (
      number: number,
      fallbackViewerHint: GitHubViewerIdentity | null = null,
    ): void => {
      const current = get();
      let localViewedFiles = current.reviewFiles;
      if (!current.showTests && current.review !== null) {
        const headArtifact = current.prPreparedArtifactCurrent && current.reviewBaseNodeIds.size > 0
          ? {
              ...current.artifact,
              nodes: current.artifact.nodes.filter((node) => !current.reviewBaseNodeIds.has(node.id)),
              edges: current.artifact.edges.filter((edge) =>
                !current.reviewBaseNodeIds.has(edge.source)
                && !current.reviewBaseNodeIds.has(edge.target)),
            }
          : current.artifact;
        const headIndex = headArtifact === current.artifact
          ? current.index
          : buildGraphIndex(headArtifact);
        const projectedFiles = deriveReviewProjection(
          current.review.context,
          headArtifact,
          headIndex,
          {
            baseIndex: current.prPreparedArtifactCurrent
              ? (current.prReviewComparison?.index ?? null)
              : null,
            baseArtifact: current.prPreparedArtifactCurrent
              ? (current.prReviewComparison?.artifact ?? null)
              : null,
            showTests: true,
          },
        ).files;
        // The mounted rows may carry richer live-PR mapping than a fresh projection. Use the full
        // projection only to add currently hidden files, never to replace a visible row.
        localViewedFiles = [...new Map(
          [...projectedFiles, ...current.reviewFiles].map((file) => [file.path, file] as const),
        ).values()];
      }
      const localViewedFileByPath = new Map(
        localViewedFiles.map((file) => [file.path, file] as const),
      );
      let fileTicks = { ...current.reviewFileTicks };
      let unitTicks = current.reviewUnitTicks;
      const at = new Date().toISOString();
      const activeHeadSha = normalizedGitHubSha(current.prReviewRevision?.headSha);
      const writes = [...viewedFileWrites.values()].filter((entry) =>
        entry.number === number
        && normalizedGitHubSha(entry.expectedHeadSha) === activeHeadSha);
      for (const [path, tick] of Object.entries(fileTicks)) {
        const incompleteOwner = (tick.viewerId === undefined) !== (tick.viewerLogin === undefined);
        const staleHead = tick.headSha !== undefined
          && normalizedGitHubSha(tick.headSha) !== activeHeadSha;
        if (incompleteOwner || staleHead) delete fileTicks[path];
      }
      const persistedViewers = new Map<string, GitHubViewerIdentity>();
      for (const tick of Object.values(fileTicks)) {
        if (tick.viewerId !== undefined && tick.viewerLogin !== undefined) {
          persistedViewers.set(tick.viewerId, { id: tick.viewerId, login: tick.viewerLogin });
        }
      }
      // On reload, the in-memory fallback map is empty but durable ticks still carry their owner.
      // Recover one unambiguous owner so subsequent offline gestures cannot become anonymous and
      // later migrate into a different GitHub account.
      const firstWrite = writes[0];
      const fallbackViewer = fallbackViewerHint
        ?? (firstWrite === undefined ? null : { id: firstWrite.viewerId, login: firstWrite.viewerLogin })
        ?? (persistedViewers.size === 1 ? [...persistedViewers.values()][0]! : null);
      const writesByPath = new Map(writes.map((entry) => [entry.path, entry.desired]));
      // A refresh can discover that authentication expired without any pending mutation. Preserve
      // the canonical VIEWED baseline before clearing the GitHub map, otherwise an ordinary 401
      // would make already-reviewed files and all of their children appear new again.
      for (const file of localViewedFiles) {
        if (
          current.reviewFileViewedStates?.[file.path] !== "VIEWED"
          || writesByPath.get(file.path) === false
        ) {
          continue;
        }
        fileTicks = removeReviewFileTick(fileTicks, file);
        const rawHeadSha = current.prReviewRevision?.headSha;
        const provenance: ReviewUnitProvenance = rawHeadSha === undefined || rawHeadSha === null
          ? {}
          : fallbackViewer === null
            ? { headSha: rawHeadSha }
            : {
                viewerId: fallbackViewer.id,
                viewerLogin: fallbackViewer.login,
                headSha: rawHeadSha,
              };
        setReviewTick(fileTicks, file.path, {
          at,
          fingerprint: file.fingerprint,
          ...(file.address ? { address: file.address } : {}),
          ...(fallbackViewer !== null
            ? {
                viewerId: fallbackViewer.id,
                viewerLogin: fallbackViewer.login,
                viewed: true,
              }
            : {}),
          ...(provenance.headSha !== undefined ? { headSha: provenance.headSha } : {}),
        });
        if (file.units.length > 0) {
          unitTicks = setReviewUnitsViewed(file.units, unitTicks, true, at, provenance);
        }
      }
      for (const entry of writes) {
        const file = localViewedFileByPath.get(entry.path);
        if (file === undefined) {
          fileTicks = { ...fileTicks };
          delete fileTicks[entry.path];
        } else {
          fileTicks = removeReviewFileTick(fileTicks, file);
        }
        setReviewTick(fileTicks, entry.path, {
          at,
          fingerprint: entry.fileFingerprint,
          ...(entry.fileAddress ? { address: entry.fileAddress } : {}),
          viewerId: entry.viewerId,
          viewerLogin: entry.viewerLogin,
          viewed: entry.desired,
          headSha: entry.expectedHeadSha,
        });
      }
      cancelViewedWrites(number);
      if (fallbackViewer === null) {
        localViewedFallbackViewers.delete(number);
      } else {
        localViewedFallbackViewers.set(number, fallbackViewer);
      }
      const localProgress = promoteFullyViewedUnitTicks(
        localViewedFiles,
        unitTicks,
        fileTicks,
      );
      set({
        reviewUnitTicks: localProgress.unitTicks,
        reviewFileTicks: localProgress.fileTicks,
        reviewFileViewedStates: null,
        reviewViewedFilesViewerId: null,
        reviewViewedFilesViewerLogin: null,
        reviewViewedFilesLoading: false,
        reviewViewedFilesError: null,
        reviewViewedFileSyncPending: new Set<string>(),
        reviewViewedFileSyncErrors: {},
      });
      persistReviewProgress(get());
    };

    const reloadForChangedViewer = (number: number): void => {
      cancelViewedWrites(number);
      set({
        reviewFileViewedStates: null,
        reviewViewedFilesViewerId: null,
        reviewViewedFilesViewerLogin: null,
        reviewViewedFilesLoading: true,
        reviewViewedFilesError: null,
        reviewViewedFileSyncPending: new Set<string>(),
        reviewViewedFileSyncErrors: {},
      });
      queueMicrotask(() => void loadViewedFiles(number));
    };

    const drainViewedWrite = async (key: string, entry: ViewedFileWrite): Promise<void> => {
      if (entry.running || prViewedFilesUrl === null) return;
      if (!sameViewedSnapshot(entry)) {
        discardViewedWrite(key, entry);
        return;
      }
      entry.running = true;
      while (viewedFileWrites.get(key) === entry) {
        if (!sameViewedSnapshot(entry)) {
          discardViewedWrite(key, entry);
          return;
        }
        const generation = entry.generation;
        const desired = entry.desired;
        const expectedHeadSha = entry.expectedHeadSha;
        try {
          const response = await fetch(prViewedFilesUrl, {
            method: "POST",
            credentials: "same-origin",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              number: entry.number,
              path: entry.path,
              viewed: desired,
              expectedHeadSha,
              expectedViewerId: entry.viewerId,
            }),
          });
          if (viewedFileWrites.get(key) !== entry) return;
          if (entry.generation !== generation) continue;
          if (!sameViewedSnapshot(entry)) {
            discardViewedWrite(key, entry);
            return;
          }
          if (!response.ok) {
            const failure = await viewedFileMutationFailure(response);
            if (response.status === 401) {
              enterLocalViewedMode(entry.number);
              return;
            }
            if (response.status === 409 && failure.conflict === "viewer") {
              reloadForChangedViewer(entry.number);
              return;
            }
            failViewedWrite(key, entry, failure.message, response.status === 409);
            return;
          }
          const result = (await response.json()) as PrViewedFileMutationResponse;
          if (viewedFileWrites.get(key) !== entry) return;
          if (entry.generation !== generation) continue;
          if (!sameViewedSnapshot(entry)) {
            discardViewedWrite(key, entry);
            return;
          }
          const expectedState: PrFileViewedState = desired ? "VIEWED" : "UNVIEWED";
          const resultViewerId = normalizedGitHubViewerId(result.viewerId);
          const resultViewerLogin = normalizedGitHubLogin(result.viewerLogin);
          if (
            result.path !== entry.path
            || result.state !== expectedState
            || resultViewerId === null
            || resultViewerLogin === null
          ) {
            failViewedWrite(key, entry, "GitHub returned an invalid viewed-file mutation response.");
            return;
          }
          if (normalizedGitHubSha(result.headSha) !== normalizedGitHubSha(expectedHeadSha)) {
            failViewedWrite(key, entry, "GitHub viewed-file state changed at a different pull request head. Refresh and retry.", true);
            return;
          }
          if (
            resultViewerId !== entry.viewerId
          ) {
            reloadForChangedViewer(entry.number);
            return;
          }
          viewedFileWrites.delete(key);
          if (sameViewedSnapshot(entry)) {
            set({ reviewViewedFilesViewerLogin: result.viewerLogin });
            clearSyncedLocalFileTick(entry.path, entry.viewerId, desired);
            clearViewedWriteUi(entry.path);
          }
          return;
        } catch {
          if (viewedFileWrites.get(key) !== entry) return;
          if (entry.generation !== generation) continue;
          failViewedWrite(key, entry, "could not synchronize viewed state with GitHub");
          return;
        }
      }
    };

    const runViewedWrite = async (key: string, entry: ViewedFileWrite): Promise<void> => {
      await acquireViewedWriteSlot();
      try {
        await drainViewedWrite(key, entry);
      } finally {
        releaseViewedWriteSlot();
      }
    };

    const startViewedWrite = (key: string, entry: ViewedFileWrite): void => {
      if (entry.completion !== null) return;
      const completion = runViewedWrite(key, entry).finally(() => {
        if (entry.completion === completion) entry.completion = null;
      });
      entry.completion = completion;
      trackViewedFileSettlement(entry.number, completion);
      void completion;
    };

    const prepareViewedWrite = (
      number: number,
      path: string,
      desired: boolean,
      expectedHeadSha: string,
      viewerId: string,
      viewerLogin: string,
    ): { key: string; entry: ViewedFileWrite } | null => {
      if (prViewedFilesUrl === null) return null;
      const file = get().reviewFiles.find((candidate) => candidate.path === path);
      const stagedTick = Object.hasOwn(get().reviewFileTicks, path)
        ? get().reviewFileTicks[path]
        : undefined;
      // Bulk reset also covers canonical files currently filtered out of the review projection.
      // A negative intent is safely path/head/viewer scoped and therefore does not need a visible
      // fingerprint; positive gestures always originate from a projected file row.
      if (file === undefined && stagedTick === undefined) return null;
      const key = viewedWriteKey(number, path);
      const existing = viewedFileWrites.get(key);
      const entry = existing ?? {
        number,
        path,
        desired,
        expectedHeadSha,
        viewerId,
        viewerLogin,
        fileFingerprint: file?.fingerprint ?? stagedTick!.fingerprint,
        fileAddress: file?.address ?? stagedTick?.address ?? null,
        generation: 0,
        running: false,
        completion: null,
      };
      entry.desired = desired;
      entry.expectedHeadSha = expectedHeadSha;
      entry.viewerId = viewerId;
      entry.viewerLogin = viewerLogin;
      entry.fileFingerprint = file?.fingerprint ?? stagedTick!.fingerprint;
      entry.fileAddress = file?.address ?? stagedTick?.address ?? null;
      entry.generation += 1;
      viewedFileWrites.set(key, entry);
      if (sameActiveReview(number)) {
        const pending = new Set(get().reviewViewedFileSyncPending);
        pending.add(path);
        const errors = { ...get().reviewViewedFileSyncErrors };
        delete errors[path];
        set({ reviewViewedFileSyncPending: pending, reviewViewedFileSyncErrors: errors });
      }
      return { key, entry };
    };

    const failViewedBatchEntries = (
      captures: readonly ViewedFileWriteCapture[],
      message: string,
    ): void => {
      for (const { key, entry, generation } of captures) {
        if (viewedFileWrites.get(key) !== entry || entry.generation !== generation) continue;
        failViewedWrite(key, entry, message);
      }
    };

    const drainViewedWriteBatch = async (
      captures: readonly ViewedFileWriteCapture[],
    ): Promise<void> => {
      const first = captures[0];
      if (first === undefined || prViewedFilesUrl === null) return;
      if (captures.some(({ key, entry }) =>
        viewedFileWrites.get(key) !== entry || !sameViewedSnapshot(entry))) {
        for (const { key, entry } of captures) {
          if (viewedFileWrites.get(key) === entry) discardViewedWrite(key, entry);
        }
        return;
      }
      try {
        const response = await fetch(prViewedFilesUrl, {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            number: first.entry.number,
            changes: captures.map(({ entry, desired }) => ({ path: entry.path, viewed: desired })),
            expectedHeadSha: first.entry.expectedHeadSha,
            expectedViewerId: first.entry.viewerId,
          }),
        });
        if (captures.every(({ key, entry }) => viewedFileWrites.get(key) !== entry)) return;
        if (captures.some(({ key, entry }) =>
          viewedFileWrites.get(key) === entry && !sameViewedSnapshot(entry))) {
          for (const { key, entry } of captures) {
            if (viewedFileWrites.get(key) === entry) discardViewedWrite(key, entry);
          }
          return;
        }
        if (!response.ok) {
          const failure = await viewedFileMutationFailure(response);
          if (response.status === 401) {
            enterLocalViewedMode(first.entry.number);
            return;
          }
          if (response.status === 409 && failure.conflict === "viewer") {
            reloadForChangedViewer(first.entry.number);
            return;
          }
          if (response.status === 409) {
            failViewedWritesForStaleHead(first.entry.number, failure.message);
            return;
          }
          failViewedBatchEntries(captures, failure.message);
          return;
        }
        const result = (await response.json()) as PrViewedFilesMutationResponse;
        if (
          normalizedGitHubSha(result.headSha)
          !== normalizedGitHubSha(first.entry.expectedHeadSha)
        ) {
          failViewedWritesForStaleHead(
            first.entry.number,
            "GitHub viewed-file state changed at a different pull request head. Refresh the review.",
          );
          return;
        }
        const resultViewerId = normalizedGitHubViewerId(result.viewerId);
        if (resultViewerId === null || normalizedGitHubLogin(result.viewerLogin) === null) {
          failViewedBatchEntries(captures, "GitHub returned an invalid viewed-file mutation response.");
          return;
        }
        if (resultViewerId !== first.entry.viewerId) {
          reloadForChangedViewer(first.entry.number);
          return;
        }
        let resultStates: Record<string, PrFileViewedState>;
        try {
          resultStates = parseViewedFileStates(result.files);
        } catch {
          failViewedBatchEntries(captures, "GitHub returned an invalid viewed-file mutation response.");
          return;
        }
        if (Object.keys(resultStates).length !== captures.length) {
          failViewedBatchEntries(captures, "GitHub returned an invalid viewed-file mutation response.");
          return;
        }
        for (const { key, entry, generation, desired } of captures) {
          if (viewedFileWrites.get(key) !== entry || entry.generation !== generation) continue;
          const expectedState: PrFileViewedState = desired ? "VIEWED" : "UNVIEWED";
          if (resultStates[entry.path] !== expectedState) {
            failViewedWrite(key, entry, "GitHub returned an invalid viewed-file mutation response.");
            continue;
          }
          viewedFileWrites.delete(key);
          if (sameViewedSnapshot(entry)) {
            set({ reviewViewedFilesViewerLogin: result.viewerLogin });
            clearSyncedLocalFileTick(entry.path, entry.viewerId, desired);
            clearViewedWriteUi(entry.path);
          }
        }
      } catch {
        failViewedBatchEntries(captures, "could not synchronize viewed state with GitHub");
      }
    };

    const runViewedWriteBatch = async (
      captures: readonly ViewedFileWriteCapture[],
    ): Promise<void> => {
      await acquireViewedWriteSlot();
      try {
        await drainViewedWriteBatch(captures);
      } finally {
        releaseViewedWriteSlot();
      }
    };

    const startViewedWriteBatch = (
      prepared: readonly { key: string; entry: ViewedFileWrite }[],
    ): void => {
      const partitions = partitionViewedWrites(prepared);
      if (partitions.length > 1) {
        for (const partition of partitions) startViewedWriteBatch(partition);
        return;
      }
      const bounded = partitions[0] ?? [];
      const captures = bounded
        .filter(({ entry }) => entry.completion === null)
        .map(({ key, entry }) => ({
          key,
          entry,
          generation: entry.generation,
          desired: entry.desired,
        }));
      if (captures.length === 0) return;
      if (captures.length === 1) {
        startViewedWrite(captures[0].key, captures[0].entry);
        return;
      }
      for (const { entry } of captures) entry.running = true;
      let completion!: Promise<void>;
      completion = runViewedWriteBatch(captures).finally(() => {
        const changed: Array<{ key: string; entry: ViewedFileWrite }> = [];
        for (const { key, entry, generation } of captures) {
          if (entry.completion !== completion) continue;
          entry.running = false;
          entry.completion = null;
          // A same-path gesture while the batch was in flight owns a newer generation. Let it
          // serialize behind this request while retaining the original batch grouping.
          if (
            viewedFileWrites.get(key) === entry
            && entry.generation !== generation
            && sameViewedSnapshot(entry)
          ) {
            changed.push({ key, entry });
          }
        }
        startViewedWriteBatch(changed);
      });
      for (const { entry } of captures) entry.completion = completion;
      trackViewedFileSettlement(captures[0]!.entry.number, completion);
      void completion;
    };

    const partitionViewedWrites = (
      prepared: readonly { key: string; entry: ViewedFileWrite }[],
    ): Array<Array<{ key: string; entry: ViewedFileWrite }>> => {
      const partitions: Array<Array<{ key: string; entry: ViewedFileWrite }>> = [];
      let current: Array<{ key: string; entry: ViewedFileWrite }> = [];
      for (const candidate of prepared) {
        const next = [...current, candidate];
        if (
          current.length > 0
          && (
            next.length > MAX_VIEWED_FILE_BATCH_SIZE
            || viewedWriteBodyBytes(next) > MAX_VIEWED_FILE_BATCH_BODY_BYTES
          )
        ) {
          partitions.push(current);
          current = [candidate];
        } else {
          current = next;
        }
      }
      if (current.length > 0) partitions.push(current);
      return partitions;
    };

    const viewedWriteBodyBytes = (
      prepared: readonly { entry: ViewedFileWrite }[],
    ): number => {
      const first = prepared[0]?.entry;
      if (first === undefined) return 0;
      return viewedFileUtf8.encode(JSON.stringify({
        number: first.number,
        changes: prepared.map(({ entry }) => ({ path: entry.path, viewed: entry.desired })),
        expectedHeadSha: first.expectedHeadSha,
        expectedViewerId: first.viewerId,
      })).byteLength;
    };

    const enqueueViewedWrites = (
      number: number,
      changes: readonly { path: string; viewed: boolean }[],
      expectedHeadSha: string,
      viewerId: string,
      viewerLogin: string,
    ): void => {
      if (changes.length === 0) return;
      const current = get();
      let fileTicks = current.reviewFileTicks;
      const at = new Date().toISOString();
      // Persist the latest optimistic intent before crossing the network boundary. Successful
      // mutations remove it; failures, navigation, reloads, and authentication loss retain enough
      // information to reconcile both mark-viewed and unview operations later.
      for (const change of changes) {
        const file = current.reviewFiles.find((candidate) => candidate.path === change.path);
        const existing = file === undefined
          ? Object.hasOwn(fileTicks, change.path) ? fileTicks[change.path] : undefined
          : tickForFile(file, fileTicks);
        fileTicks = file === undefined
          ? { ...fileTicks }
          : removeReviewFileTick(fileTicks, file);
        if (file === undefined) delete fileTicks[change.path];
        setReviewTick(fileTicks, change.path, {
          at,
          fingerprint: file?.fingerprint ?? existing?.fingerprint ?? "unverified",
          ...(file?.address
            ? { address: file.address }
            : existing?.address ? { address: existing.address } : {}),
          viewerId,
          viewerLogin,
          viewed: change.viewed,
          headSha: expectedHeadSha,
        });
      }
      set({ reviewFileTicks: fileTicks });
      persistReviewProgress(get());
      const prepared = changes
        .map(({ path, viewed }) =>
          prepareViewedWrite(number, path, viewed, expectedHeadSha, viewerId, viewerLogin))
        .filter((value): value is { key: string; entry: ViewedFileWrite } => value !== null);
      startViewedWriteBatch(prepared);
    };

    const viewedGesturesBlocked = (current: BlueprintState): boolean =>
      reviewViewedGestureBlockReason(current) !== null;

    const toggleWholeReviewFiles = (files: readonly ReviewFileRow[]): void => {
      const current = get();
      if (files.length === 0) return;
      // A canonical GET may have captured state before a concurrent mutation. Pause gestures for
      // every refetch so its landing cannot overwrite an optimistic write that GitHub accepted.
      // A live review becomes local-only only after an explicit 401.
      if (viewedGesturesBlocked(current)) return;
      const unique = [...new Map(files.map((file) => [file.path, file])).values()];
      const coordinates: ReviewUnitCoordinates = {
        viewerId: current.reviewViewedFilesViewerId,
        headSha: current.prReviewRevision?.headSha,
      };
      const before = new Map(unique.map((file) => [
        file.path,
        fileViewState(
          file,
          current.reviewUnitTicks,
          current.reviewFileTicks,
          current.reviewFileViewedStates,
          coordinates,
        ),
      ]));
      const priorLocalTicks = new Map(unique.map((file) => [
        file.path,
        tickForFile(file, current.reviewFileTicks),
      ]));
      const markViewed = [...before.values()].some((state) => state !== "done");
      const toggledAt = new Date().toISOString();
      const next = applyFilesToggle(
        unique,
        current.reviewUnitTicks,
        current.reviewFileTicks,
        toggledAt,
        current.reviewFileViewedStates,
        coordinates,
      );
      const nextGithubStates = current.reviewFileViewedStates === null
        ? null
        : { ...current.reviewFileViewedStates };
      const changed = unique.filter((file) => (before.get(file.path) === "done") !== markViewed);
      if (nextGithubStates !== null) {
        for (const file of changed) {
          setOwnRecordValue(nextGithubStates, file.path, markViewed ? "VIEWED" : "UNVIEWED");
        }
      }
      let nextUnitTicks = next.unitTicks;
      if (
        nextGithubStates !== null
        && markViewed
        && current.reviewViewedFilesViewerId !== null
        && current.reviewViewedFilesViewerLogin !== null
        && current.prReviewRevision?.headSha !== undefined
        && current.prReviewRevision.headSha !== null
      ) {
        // Keep exact unit history until GitHub accepts the file-level write. A stale-head failure
        // can then retain valid semantic progress instead of erasing it with the optimistic fold.
        for (const file of changed) {
          nextUnitTicks = setReviewUnitsViewed(
            file.units,
            nextUnitTicks,
            true,
            toggledAt,
            {
              viewerId: current.reviewViewedFilesViewerId,
              viewerLogin: current.reviewViewedFilesViewerLogin,
              headSha: current.prReviewRevision.headSha,
            },
          );
        }
      }
      let nextLocalFileTicks = next.fileTicks;
      const number = current.prReviewed;
      const fallbackViewer = number === null ? undefined : localViewedFallbackViewers.get(number);
      if (nextGithubStates === null) {
        nextLocalFileTicks = { ...nextLocalFileTicks };
        for (const file of changed) {
          const priorTick = priorLocalTicks.get(file.path);
          const priorViewer = priorTick?.viewerId !== undefined && priorTick.viewerLogin !== undefined
            ? { id: priorTick.viewerId, login: priorTick.viewerLogin }
            : undefined;
          const intentViewer = fallbackViewer ?? priorViewer;
          const intentHeadSha = current.prReviewRevision?.headSha ?? priorTick?.headSha;
          if (intentHeadSha !== undefined && file.units.length > 0) {
            nextUnitTicks = setReviewUnitsViewed(
              file.units,
              nextUnitTicks,
              markViewed,
              toggledAt,
              intentViewer === undefined
                ? { headSha: intentHeadSha }
                : {
                    viewerId: intentViewer.id,
                    viewerLogin: intentViewer.login,
                    headSha: intentHeadSha,
                  },
            );
          }
          if (markViewed) {
            const tick = tickForFile(file, nextLocalFileTicks) ?? {
              at: toggledAt,
              fingerprint: file.fingerprint,
              ...(file.address ? { address: file.address } : {}),
            };
            setReviewTick(nextLocalFileTicks, file.path, {
              ...tick,
              ...(intentViewer
                ? { viewerId: intentViewer.id, viewerLogin: intentViewer.login }
                : {}),
              ...(intentHeadSha !== undefined ? { headSha: intentHeadSha } : {}),
            });
          } else if (intentViewer !== undefined) {
            setReviewTick(nextLocalFileTicks, file.path, {
              at: toggledAt,
              fingerprint: file.fingerprint,
              ...(file.address ? { address: file.address } : {}),
              viewerId: intentViewer.id,
              viewerLogin: intentViewer.login,
              viewed: false,
              ...(intentHeadSha ? { headSha: intentHeadSha } : {}),
            });
          }
        }
      }
      set({
        reviewUnitTicks: nextUnitTicks,
        // Canonical state stays in memory. Preserve only durable migration/fallback intents, whose
        // ticks carry viewer ownership when they originated from an authenticated write.
        reviewFileTicks: nextGithubStates === null ? nextLocalFileTicks : current.reviewFileTicks,
        reviewFileViewedStates: nextGithubStates,
      });
      persistReviewProgress(get());
      const expectedHeadSha = current.prReviewRevision?.headSha;
      const viewerId = current.reviewViewedFilesViewerId;
      const viewerLogin = current.reviewViewedFilesViewerLogin;
      if (
        nextGithubStates !== null
        && number !== null
        && typeof expectedHeadSha === "string"
        && viewerId !== null
        && viewerLogin !== null
      ) {
        enqueueViewedWrites(
          number,
          changed.map((file) => ({ path: file.path, viewed: markViewed })),
          expectedHeadSha,
          viewerId,
          viewerLogin,
        );
      }
    };

    const toggleReviewUnits = (nodeIds: readonly string[]): void => {
      const current = get();
      if (nodeIds.length === 0 || viewedGesturesBlocked(current)) return;
      const requested = new Set(nodeIds);
      const ownerByUnit = new Map<string, ReviewFileRow>();
      for (const file of current.reviewFiles) {
        for (const unit of file.units) ownerByUnit.set(unit.nodeId, file);
      }
      const units = [...requested]
        .map((nodeId) => ownerByUnit.get(nodeId)?.units.find((unit) => unit.nodeId === nodeId))
        .filter((unit): unit is ReviewUnitRow => unit !== undefined);
      if (units.length === 0) return;
      const unitsByFile = new Map<string, { file: ReviewFileRow; units: ReviewUnitRow[] }>();
      for (const unit of units) {
        const file = ownerByUnit.get(unit.nodeId)!;
        const group = unitsByFile.get(file.path);
        group ? group.units.push(unit) : unitsByFile.set(file.path, { file, units: [unit] });
      }
      const files = [...unitsByFile.values()].map((group) => group.file);
      const toggledAt = new Date().toISOString();
      const coordinates: ReviewUnitCoordinates = {
        viewerId: current.reviewViewedFilesViewerId,
        headSha: current.prReviewRevision?.headSha,
      };
      const number = current.prReviewed;
      const fallbackViewer = number === null ? undefined : localViewedFallbackViewers.get(number);
      const provenanceByPath = new Map(files.map((file) => {
        let provenance: ReviewUnitProvenance = {};
        if (
          current.reviewFileViewedStates !== null
          && current.reviewViewedFilesViewerId !== null
          && current.reviewViewedFilesViewerLogin !== null
          && current.prReviewRevision?.headSha !== undefined
          && current.prReviewRevision.headSha !== null
        ) {
          provenance = {
            viewerId: current.reviewViewedFilesViewerId,
            viewerLogin: current.reviewViewedFilesViewerLogin,
            headSha: current.prReviewRevision.headSha,
          };
        } else if (current.reviewFileViewedStates === null) {
          const priorTick = tickForFile(file, current.reviewFileTicks);
          const priorViewer = priorTick?.viewerId !== undefined && priorTick.viewerLogin !== undefined
            ? { id: priorTick.viewerId, login: priorTick.viewerLogin }
            : undefined;
          const intentViewer = fallbackViewer ?? priorViewer;
          const intentHeadSha = current.prReviewRevision?.headSha ?? priorTick?.headSha;
          if (intentHeadSha !== undefined) {
            provenance = intentViewer === undefined
              ? { headSha: intentHeadSha }
              : {
                  viewerId: intentViewer.id,
                  viewerLogin: intentViewer.login,
                  headSha: intentHeadSha,
                };
          }
        }
        return [file.path, provenance] as const;
      }));
      let seededTicks = current.reviewUnitTicks;
      for (const file of files) {
        const githubState = current.reviewFileViewedStates !== null
          && Object.hasOwn(current.reviewFileViewedStates, file.path)
          ? current.reviewFileViewedStates[file.path]
          : undefined;
        const fileTick = tickForFile(file, current.reviewFileTicks);
        const wholeFileBaseline = githubState === "VIEWED"
          || (
            current.reviewFileViewedStates === null
            && fileTick !== undefined
            && fileTick.viewed !== false
            && fileTick.fingerprint === file.fingerprint
          );
        if (wholeFileBaseline) {
          seededTicks = setReviewUnitsViewed(
            file.units,
            seededTicks,
            true,
            toggledAt,
            provenanceByPath.get(file.path) ?? {},
          );
        }
      }
      const beforeDone = new Map(files.map((file) => [
        file.path,
        unitsViewState(file.units, seededTicks, undefined, coordinates) === "done",
      ]));
      const selectedDone = units.every((unit) => {
        const file = ownerByUnit.get(unit.nodeId)!;
        const githubState = current.reviewFileViewedStates !== null
          && Object.hasOwn(current.reviewFileViewedStates, file.path)
          ? current.reviewFileViewedStates[file.path]
          : undefined;
        return unitViewState(unit, seededTicks, githubState, coordinates) === "done";
      });
      const markViewed = !selectedDone;
      let nextUnitTicks = seededTicks;
      for (const [path, group] of unitsByFile) {
        nextUnitTicks = setReviewUnitsViewed(
          group.units,
          nextUnitTicks,
          markViewed,
          toggledAt,
          provenanceByPath.get(path) ?? {},
        );
      }
      const nextGithubStates = current.reviewFileViewedStates === null
        ? null
        : { ...current.reviewFileViewedStates };
      let nextFileTicks = current.reviewFileTicks;
      const githubChanges: Array<{ path: string; viewed: boolean }> = [];
      for (const file of files) {
        const viewed = unitsViewState(file.units, nextUnitTicks, undefined, coordinates) === "done";
        if (nextGithubStates !== null) {
          const githubViewed = Object.hasOwn(nextGithubStates, file.path)
            && nextGithubStates[file.path] === "VIEWED";
          if (viewed !== githubViewed) {
            setOwnRecordValue(nextGithubStates, file.path, viewed ? "VIEWED" : "UNVIEWED");
            githubChanges.push({ path: file.path, viewed });
          }
          continue;
        }

        const priorTick = tickForFile(file, nextFileTicks);
        const priorViewer = priorTick?.viewerId !== undefined && priorTick.viewerLogin !== undefined
          ? { id: priorTick.viewerId, login: priorTick.viewerLogin }
          : undefined;
        const intentViewer = fallbackViewer ?? priorViewer;
        const intentHeadSha = current.prReviewRevision?.headSha ?? priorTick?.headSha;
        nextFileTicks = removeReviewFileTick(nextFileTicks, file);
        if (viewed) {
          setReviewTick(nextFileTicks, file.path, {
            at: toggledAt,
            fingerprint: file.fingerprint,
            ...(file.address ? { address: file.address } : {}),
            ...(intentViewer
              ? {
                  viewerId: intentViewer.id,
                  viewerLogin: intentViewer.login,
                  viewed: true,
                }
              : {}),
            ...(intentHeadSha !== undefined ? { headSha: intentHeadSha } : {}),
          });
        } else if (
          intentViewer !== undefined
          && (beforeDone.get(file.path) === true || priorTick?.viewed === false)
        ) {
          setReviewTick(nextFileTicks, file.path, {
            at: toggledAt,
            fingerprint: file.fingerprint,
            ...(file.address ? { address: file.address } : {}),
            viewerId: intentViewer.id,
            viewerLogin: intentViewer.login,
            viewed: false,
            ...(intentHeadSha !== undefined ? { headSha: intentHeadSha } : {}),
          });
        }
      }
      set({
        reviewUnitTicks: nextUnitTicks,
        reviewFileTicks: nextGithubStates === null ? nextFileTicks : current.reviewFileTicks,
        reviewFileViewedStates: nextGithubStates,
      });
      persistReviewProgress(get());

      const expectedHeadSha = current.prReviewRevision?.headSha;
      const viewerId = current.reviewViewedFilesViewerId;
      const viewerLogin = current.reviewViewedFilesViewerLogin;
      if (
        nextGithubStates !== null
        && number !== null
        && githubChanges.length > 0
        && typeof expectedHeadSha === "string"
        && viewerId !== null
        && viewerLogin !== null
      ) {
        enqueueViewedWrites(
          number,
          githubChanges,
          expectedHeadSha,
          viewerId,
          viewerLogin,
        );
      }
    };

    const loadViewedFiles = async (number: number): Promise<void> => {
      if (prViewedFilesUrl === null || !sameActiveReview(number)) return;
      const sequence = ++prViewedFilesSeq;
      set({ reviewViewedFilesLoading: true, reviewViewedFilesError: null });
      try {
        // A mutation may already be past the browser boundary when a resume/refresh begins.
        // Let every such write settle before reading canonical state so an older GET cannot land
        // over a mutation that GitHub accepts a moment later.
        await waitForViewedFileSettlements(number);
        if (sequence !== prViewedFilesSeq || !sameActiveReview(number)) return;
        const url = new URL(prViewedFilesUrl, requestOrigin());
        url.searchParams.set("n", String(number));
        const response = await fetch(url, { credentials: "same-origin", cache: "no-store" });
        if (sequence !== prViewedFilesSeq || !sameActiveReview(number)) return;
        // An explicitly signed-out session retains browser-local whole-file progress. Other
        // failures can mean a broken permission/session/repository and must remain visible.
        if (response.status === 401) {
          const knownViewerId = get().reviewViewedFilesViewerId;
          const knownViewerLogin = get().reviewViewedFilesViewerLogin;
          const knownViewer = knownViewerId === null || knownViewerLogin === null
            ? null
            : { id: knownViewerId, login: knownViewerLogin };
          // Failed/queued mutations still carry the user's latest desired value. Convert them to
          // viewer-owned local ticks before leaving canonical mode instead of dropping that intent.
          enterLocalViewedMode(number, knownViewer);
          return;
        }
        if (!response.ok) throw new Error(await errorMessage(response));
        const result = (await response.json()) as PrViewedFilesResponse;
        const current = get();
        const activeHeadSha = current.prReviewRevision?.headSha;
        if (
          activeHeadSha === null
          || activeHeadSha === undefined
          || normalizedGitHubSha(result.headSha) !== normalizedGitHubSha(activeHeadSha)
        ) {
          cancelViewedWrites(number);
          set({
            reviewViewedFilesLoading: false,
            reviewViewedFilesError: "GitHub viewed-file state belongs to a newer pull request head. Refresh the review.",
            prReviewStale: true,
            reviewViewedFileSyncPending: new Set<string>(),
            reviewViewedFileSyncErrors: {},
          });
          return;
        }
        const states = parseViewedFileStates(result.files);
        const viewerId = parseGitHubViewerId(result.viewerId);
        const viewerLogin = parseGitHubViewerLogin(result.viewerLogin);
        localViewedFallbackViewers.delete(number);
        let localFileTicks = current.reviewFileTicks;
        let localUnitTicks = reconcileReviewUnitTickCoordinates(
          current.reviewUnitTicks,
          viewerId,
          result.headSha,
        );
        const localChangesToSync = new Map<string, boolean>();
        const visiblePaths = new Set(current.reviewFiles.map((file) => file.path));
        for (const file of current.reviewFiles) {
          const tick = tickForFile(file, localFileTicks);
          if (tick === undefined) continue;
          const incompleteOwner = (tick.viewerId === undefined) !== (tick.viewerLogin === undefined);
          const ownedByAnotherViewer = tick.viewerId !== undefined && tick.viewerId !== viewerId;
          if (incompleteOwner || ownedByAnotherViewer) {
            // One persisted path has one intent slot. Once GitHub establishes a different active
            // viewer, discard the foreign slot rather than ever rendering or relabeling it locally.
            localFileTicks = removeReviewFileTick(localFileTicks, file);
            continue;
          }
          const coordinateBoundIntent = tick.headSha !== undefined;
          if (
            tick.headSha !== undefined
            && normalizedGitHubSha(tick.headSha) !== normalizedGitHubSha(result.headSha)
          ) {
            localFileTicks = removeReviewFileTick(localFileTicks, file);
            continue;
          }
          const remoteState = states[file.path];
          if (remoteState === undefined) continue;
          if (tick.viewed === false) {
            if (tick.viewerId === undefined) {
              localFileTicks = removeReviewFileTick(localFileTicks, file);
              continue;
            }
            if (remoteState !== "UNVIEWED") {
              // Preserve an optimistic unview while the same-head write is retried.
              setOwnRecordValue(states, file.path, "UNVIEWED");
              localChangesToSync.set(file.path, false);
            } else {
              // Only GitHub's explicit UNVIEWED state satisfies a negative intent. DISMISSED is
              // separately rendered as stale and still needs the unmark mutation used by Reset.
              localFileTicks = removeReviewFileTick(localFileTicks, file);
            }
            continue;
          }
          if (!coordinateBoundIntent) {
            if (tick.fingerprint === "unverified" || file.fingerprint === "unverified") {
              localFileTicks = removeReviewFileTick(localFileTicks, file);
              continue;
            }
            if (fileViewState(file, localUnitTicks, localFileTicks, null, {
              viewerId,
              headSha: result.headSha,
            }) !== "done") {
              continue;
            }
          }
          if (remoteState === "VIEWED") {
            localFileTicks = removeReviewFileTick(localFileTicks, file);
          } else if (remoteState === "UNVIEWED" || remoteState === "DISMISSED") {
            // Keep a durable local intent until GitHub accepts the migration. Canonical state makes
            // the optimistic marker visible; this tick only protects a retry/reload after failure.
            localFileTicks = removeReviewFileTick(localFileTicks, file);
            setReviewTick(localFileTicks, file.path, {
              at: tick!.at,
              fingerprint: file.fingerprint,
              ...(file.address ? { address: file.address } : {}),
              viewerId,
              viewerLogin,
              viewed: true,
              headSha: result.headSha,
            });
            setOwnRecordValue(states, file.path, "VIEWED");
            localChangesToSync.set(file.path, true);
          }
        }
        // Authenticated intents carry exact path + immutable head + viewer coordinates, so both
        // directions can retry while a test file is filtered out. Unowned legacy positive ticks
        // still wait for a visible row and its current fingerprint check above.
        for (const [path, tick] of Object.entries(localFileTicks)) {
          if (visiblePaths.has(path)) continue;
          const incompleteOwner = (tick.viewerId === undefined) !== (tick.viewerLogin === undefined);
          if (
            incompleteOwner
            || (tick.viewerId !== undefined && tick.viewerId !== viewerId)
          ) {
            localFileTicks = { ...localFileTicks };
            delete localFileTicks[path];
            continue;
          }
          if (
            tick.headSha === undefined
            || normalizedGitHubSha(tick.headSha) !== normalizedGitHubSha(result.headSha)
            || !Object.hasOwn(states, path)
          ) {
            localFileTicks = { ...localFileTicks };
            delete localFileTicks[path];
            continue;
          }
          const desired = tick.viewed !== false;
          const satisfied = desired ? states[path] === "VIEWED" : states[path] === "UNVIEWED";
          if (satisfied) {
            localFileTicks = { ...localFileTicks };
            delete localFileTicks[path];
          } else {
            setOwnRecordValue(states, path, desired ? "VIEWED" : "UNVIEWED");
            localChangesToSync.set(path, desired);
          }
        }
        for (const file of current.reviewFiles) {
          if (Object.hasOwn(states, file.path) && states[file.path] === "VIEWED") {
            localUnitTicks = removeReviewUnitTicks(localUnitTicks, file.units);
          }
        }
        cancelViewedWrites(number);
        set({
          reviewUnitTicks: localUnitTicks,
          reviewFileTicks: localFileTicks,
          reviewFileViewedStates: states,
          reviewViewedFilesViewerId: viewerId,
          reviewViewedFilesViewerLogin: viewerLogin,
          reviewViewedFilesLoading: false,
          reviewViewedFilesError: null,
          reviewViewedFileSyncPending: new Set<string>(),
          reviewViewedFileSyncErrors: {},
        });
        // Canonical state clears satisfied intents and immediately retries same-viewer intents in
        // either direction. Positive legacy progress still requires a current file fingerprint.
        persistReviewProgress(get());
        enqueueViewedWrites(
          number,
          [...localChangesToSync].map(([path, viewed]) => ({ path, viewed })),
          result.headSha,
          viewerId,
          viewerLogin,
        );
      } catch (error) {
        if (sequence === prViewedFilesSeq && sameActiveReview(number)) {
          set({
            reviewViewedFilesLoading: false,
            reviewViewedFilesError: error instanceof Error ? error.message : "could not load GitHub viewed-file state",
          });
        }
      }
    };

    const installProgressiveProjection = (
      head: GraphProjectionV1,
      comparison: GraphProjectionV1 | null,
      requestedDepth: number,
      explicitFileIds: readonly string[] = get().progressiveGraph?.explicitFileIds ?? [],
      affectedDepth: number = get().progressiveGraph?.affectedDepth ?? head.loadedDepth,
    ): boolean => {
      const current = get();
      const session = current.progressiveGraph;
      if (
        session === null
        || session.head.graphId !== head.graphId
        || session.head.generation !== head.generation
      ) {
        return false;
      }
      const artifact = mergeProjectionIntoDisplayedArtifact(current.artifact, session.head, head);
      const index = buildGraphIndex(artifact);
      const retainedChangedIds = [...current.index.changedIds].filter((id) => index.nodesById.has(id));
      const retainedStatuses = [...current.index.changedStatus.entries()]
        .filter(([id]) => index.nodesById.has(id));
      applyChangedIds(index, retainedChangedIds);
      applyChangedStatus(index, retainedStatuses);
      invalidateArtifactCaches();
      const comparisonArtifact = comparison === null ? null : projectionToArtifact(comparison);
      const nextSession: ProgressiveGraphSessionState = {
        head,
        comparison,
        explicitFileIds: [...new Set(explicitFileIds)].sort(),
        affectedDepth,
        requestedDepth,
        status: "ready",
        error: null,
      };
      if (!isProgressiveSessionDepthReady(nextSession, requestedDepth)) {
        nextSession.status = "expanding";
      }
      set({
        artifact,
        index,
        progressiveGraph: nextSession,
        ...(comparisonArtifact === null
          ? {}
          : { prReviewComparison: { artifact: comparisonArtifact, index: buildGraphIndex(comparisonArtifact) } }),
        coverage: current.coverageMode ? computeCoverage(artifact.nodes, artifact.edges) : null,
      });
      return true;
    };

    const expandProgressiveFileRoots = async (
      requestedFileIds: readonly string[],
      depth: number,
      nodeSequence: number,
    ): Promise<boolean> => {
      const initial = get().progressiveGraph;
      if (initial === null || graphProjectUrl === null || nodeSequence !== progressiveNodeSeq) return false;
      const signal = progressiveNodeSignal();
      const completeThrough = new Map(
        initial.head.frontier.map((entry) => [entry.fileId, entry.completeThroughDepth]),
      );
      const fileIds = [...new Set(requestedFileIds)]
        .filter((id) => (completeThrough.get(id) ?? -1) < depth)
        .sort();
      if (fileIds.length === 0) return true;
      const requestKey = [
        "expand",
        nodeSequence,
        initial.head.graphId,
        initial.head.generation,
        depth,
        ...fileIds,
      ].join("\u0000");
      let request = progressiveNodeRequests.get(requestKey);
      if (request === undefined) {
        request = (async () => {
          // Search can remain open for many adds. Split on both the worker's root count and the
          // HTTP transport's encoded byte ceiling so valid long canonical IDs never become a 413.
          const projectionRequests = fileProjectionRequests(
            initial.head.graphId,
            fileIds,
            depth,
            depth,
          );
          const fragments = await Promise.all(projectionRequests.map((projectionRequest) =>
            fetchGraphProjection(graphProjectUrl, projectionRequest, { signal })));
          if (
            nodeSequence !== progressiveNodeSeq
            || fragments.some((fragment) =>
              !isProjectionReadyForCanvas(fragment)
              || !projectionRootsCompleteThrough(fragment, depth),
            )
          ) {
            return false;
          }
          const active = get().progressiveGraph;
          if (
            active === null
            || active.head.graphId !== initial.head.graphId
            || active.head.generation !== initial.head.generation
          ) {
            return false;
          }
          const mergedHead = fragments.reduce(mergeGraphProjections, active.head);
          return installProgressiveProjection(
            mergedHead,
            active.comparison,
            active.requestedDepth,
            [...active.explicitFileIds, ...fileIds],
          );
        })().finally(() => {
          if (progressiveNodeRequests.get(requestKey) === request) {
            progressiveNodeRequests.delete(requestKey);
          }
        });
        progressiveNodeRequests.set(requestKey, request);
      }
      return request;
    };

    const hydrateProgressiveFiles = async (
      requestedFileIds: readonly string[],
      options: { consumeAffectedWarm?: boolean } = {},
    ): Promise<boolean> => {
      const initial = get();
      const session = initial.progressiveGraph;
      if (session === null || graphProjectUrl === null) return false;
      const nodeSequence = progressiveNodeSeq;
      const signal = progressiveNodeSignal();
      const ready = new Set(session.head.readyFileIds);
      const fileIds = [...new Set(requestedFileIds)]
        .filter((id) => !ready.has(id))
        .sort();
      if (fileIds.length === 0) return true;
      const requestKey = [
        "hydrate",
        options.consumeAffectedWarm === false ? "exact-file" : "affected-frontier",
        nodeSequence,
        session.head.graphId,
        session.head.generation,
        ...fileIds,
      ].join("\u0000");
      let request = progressiveNodeRequests.get(requestKey);
      if (request === undefined) {
        request = (async () => {
          let active = get().progressiveGraph;
          if (
            nodeSequence !== progressiveNodeSeq
            || active === null
            || active.head.graphId !== session.head.graphId
            || active.head.generation !== session.head.generation
          ) {
            return false;
          }

          // A represented-but-not-ready boundary is the next affected-file BFS ring. Consume the
          // post-paint changed-root warm entry first; this is the cache key we precomputed for ghost
          // promotion and avoids reclassifying connected context as a disconnected search root.
          if (
            options.consumeAffectedWarm !== false
            &&
            active.affectedDepth < MAX_PROGRESSIVE_GRAPH_DEPTH
            // `loadedFileIds` also includes presentation-only coupling/Promise endpoint ghosts.
            // Only frontier membership proves that a file belongs to the changed-root import/IPC
            // traversal and can be satisfied by consuming its next warmed ring.
            && fileIds.some((fileId) => active!.head.frontier.some((entry) => entry.fileId === fileId))
          ) {
            const depth = active.affectedDepth + 1;
            const affectedFragment = await fetchGraphProjection(
              graphProjectUrl,
              changedFileProjectionRequest(
                active.head.graphId,
                active.head.seedGraphId,
                depth,
                depth,
              ),
              { signal },
            );
            if (
              !isProjectionReadyForCanvas(affectedFragment)
              || !projectionRootsCompleteThrough(affectedFragment, depth)
            ) {
              throw new Error(`the affected-file graph is not ready through depth ${depth}`);
            }
            active = get().progressiveGraph;
            if (
              nodeSequence !== progressiveNodeSeq
              || active === null
              || active.head.graphId !== affectedFragment.graphId
              || active.head.generation !== affectedFragment.generation
            ) {
              return false;
            }
            if (!installProgressiveProjection(
              mergeGraphProjections(active.head, affectedFragment),
              active.comparison,
              active.requestedDepth,
              active.explicitFileIds,
              Math.max(active.affectedDepth, depth),
            )) {
              return false;
            }
            active = get().progressiveGraph;
            if (active === null) return false;
          }

          const nowReady = new Set(active.head.readyFileIds);
          const explicitRoots = fileIds.filter((fileId) => !nowReady.has(fileId));
          if (explicitRoots.length === 0) return true;
          const explicitRequests = fileProjectionRequests(active.head.graphId, explicitRoots, 1, 1);
          const fragments = await Promise.all(explicitRequests.map((projectionRequest) =>
            fetchGraphProjection(graphProjectUrl, projectionRequest, { signal })));
          if (fragments.some((fragment) => !isProjectionReadyForCanvas(fragment))) {
            throw new Error("the selected depth-1 neighbourhood is not ready");
          }
          active = get().progressiveGraph;
          if (
            nodeSequence !== progressiveNodeSeq
            || active === null
            || fragments.some((fragment) =>
              active!.head.graphId !== fragment.graphId
              || active!.head.generation !== fragment.generation)
          ) {
            return false;
          }
          const explicitFileIds = [...new Set([...active.explicitFileIds, ...explicitRoots])].sort();
          const mergedHead = fragments.reduce(mergeGraphProjections, active.head);
          if (!installProgressiveProjection(
            mergedHead,
            active.comparison,
            active.requestedDepth,
            explicitFileIds,
          )) {
            return false;
          }
          // Admission is intentionally depth 1 for time-to-action. If the reader already chose a
          // wider horizon, finish that same explicit-root BFS in the background and then refresh the
          // visible ghost ring once; the selected node itself need not wait.
          if (active.requestedDepth > 1 && active.status !== "expanding") {
            void expandProgressiveFileRoots(explicitRoots, active.requestedDepth, nodeSequence)
              .then(async (expanded) => {
                if (!expanded || nodeSequence !== progressiveNodeSeq) return;
                const hydrated = get();
                if (hydrated.minimalSeedIds.length > 0) {
                  await hydrated.minimalRelayout({ label: `Loading context depth ${active.requestedDepth}…` });
                } else if (moduleSurfaceSpec(hydrated.viewMode) !== null) {
                  await hydrated.moduleRelayout({ label: `Loading context depth ${active.requestedDepth}…` });
                }
              })
              .catch((error) => {
                if (nodeSequence !== progressiveNodeSeq) return;
                const message = error instanceof Error ? error.message : "could not expand selected graph context";
                set((currentState) => currentState.progressiveGraph === null
                  ? {}
                  : { progressiveGraph: { ...currentState.progressiveGraph, status: "error", error: message } });
              });
          }
          return true;
        })().finally(() => {
          if (progressiveNodeRequests.get(requestKey) === request) {
            progressiveNodeRequests.delete(requestKey);
          }
        });
        progressiveNodeRequests.set(requestKey, request);
      }
      return request;
    };

    return {
    artifact: dependencies.artifact,
    index: dependencies.index,
    // A `meridian review` artifact opens straight on the review surface; everything else (plain
    // `view`, or a `web` GitHub session) opens on the Map — the default lens.
    viewMode: "modules",
    // Tests are hidden by default — rarely what the reader is here for, and always in the graph (the
    // Tests toggle reveals them), so nothing is lost. Tagged ids come from `index.testIds`.
    showTests: false,
    coverageMode: false,
    coverage: null,
    telemetryMode: false,
    logicRoot: null,
    logicView: "graph",
    logicStack: [],
    logicFocus: [],
    logicInlineDepth: 0,
    showLogicTests: false,
    logicSelected: null,
    ghostDepth: 1,
    pinnedFlows: [],
    expandedLogic: new Set<string>(),
    collapsedLogicEdges: new Set<string>(),
    hideGreyed: false,
    nestByService: false,
    flowExplorerOpen: false,
    flowSelection: null,
    flowPaneOrigin: null,
    requestFlowTraceId: null,
    requestFlowExpansionOverrides: new Set<string>(),
    flowPaneExpansionOverrides: new Set<string>(),
    flowPaneCollapsedEdges: new Set<string>(),
    syntheticExecutionUrl: initialSyntheticExecutionUrl,
    syntheticExecutionTrust: initialSyntheticExecutionTrust,
    syntheticScenarios: initialSyntheticScenarios,
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
    flowPaneRfNodes: [],
    flowPaneRfEdges: [],
    flowPaneLayoutStatus: "idle",
    reviewFlowBaseline: null,
    logicRfNodes: [],
    logicRfEdges: [],
    logicLayoutStatus: "idle",
    logicLayoutActivity: null,
    compSelectedId: null,
    compRoot: defaultCompRoot,
    showSolidMetrics: readSolidMetricsPref(),
    moduleRfNodes: [],
    moduleRfEdges: [],
    moduleLayoutStatus: "idle",
    moduleLayoutActivity: null,
    moduleFocus: null,
    moduleEffectiveFocus: null,
    moduleSemanticLayers: [],
    moduleRadius: 1,
    highlightMode: "node",
    showHighways: true,
    reviewShowHighways: false,
    showCommons: true,
    showExternalGhosts: true,
    groupGhostsByParent: true,
    hiddenCategories: new Set<ModuleCategory>(),
    relationVisibilityOverrides: EMPTY_RELATION_VISIBILITY_OVERRIDES,
    moduleSelected: new Set<string>(),
    moduleExpanded: new Set<string>(),
    mapExtra: new Set<string>(),
    mapGhostPins: new Map<string, ReadonlySet<string>>(),
    moduleGhostInspection: null,
    showPrivate: true,
    serviceScope: null,
    serviceGroupingMode: "folder",
    serviceGroupingTargetSize: DEFAULT_SERVICE_GROUPING_TARGET_SIZE,
    serviceGroupingLabelMode: DEFAULT_SERVICE_GROUPING_LABEL_MODE,
    minimalSeedIds: [],
    minimalMemberIds: [],
    minimalRollups: {},
    minimalBasePositions: {},
    minimalArrange: false,
    minimalRfNodes: [],
    minimalRfEdges: [],
    minimalLayoutStatus: "idle",
    minimalLayoutActivity: null,
    minimalView: "graph",
    minimalShowGhostNodes: review === null,
    minimalShowNonDiffGhostNodes: true,
    minimalCodebaseExpansionOverrides: new Map<string, boolean>(),
    review,
    reviewAffectedIds: new Set(initialReviewProjection?.affected.map((node) => node.nodeId) ?? []),
    reviewDiffOnly: false,
    reviewFiles,
    reviewFilesSort: "path",
    reviewFileDelta: {},
    reviewTicks: initialProgress?.ticks ?? {},
    reviewUnitTicks: initialMigratedProgress?.unitTicks ?? {},
    reviewFileTicks: initialMigratedProgress?.fileTicks ?? {},
    reviewFileViewedStates: null,
    reviewViewedFilesSyncEnabled: prViewedFilesUrl !== null,
    reviewViewedFilesViewerId: null,
    reviewViewedFilesViewerLogin: null,
    reviewViewedFilesLoading: false,
    reviewViewedFilesError: null,
    reviewViewedFileSyncPending: new Set<string>(),
    reviewViewedFileSyncErrors: {},
    reviewComments: initialProgress?.comments ?? [],
    reviewLineComposer: null,
    reviewFlowSplitView: reviewPreferences.flowSplitView,
    reviewOpenFlowSplitOnSelect: reviewPreferences.openFlowSplitOnSelect,
    reviewFlowExplicitView: null,
    reviewCodePreviewTrigger: reviewPreferences.codePreviewTrigger,
    reviewCodePreviewEnabled: true,
    reviewHideAddedSourceCommentDiffs: reviewPreferences.hideAddedSourceCommentDiffs,
    reviewExcludeFormatOnlyChanges: reviewPreferences.excludeFormatOnlyChanges,
    reviewPanelHidden: false,
    reviewCommentsVisible: true,
    reviewCommentFilter: "all",
    reviewSubmitStatus: "idle",
    reviewSubmitError: null,
    reviewSubmitNotice: null,
    prCommentMutationStatus: "idle",
    prCommentMutationId: null,
    prCommentMutationError: null,
    reviewSubmittedUrl: null,
    reviewLitNodeIds: null,
    reviewSelectedId: null,
    reviewGroups: null,
    reviewActiveGroupId: null,
    reviewPathScope: null,
    reviewFocusedSubgraph: null,
    minimalGraphHistory: [],
    reviewAllSeedIds: [],
    recenterSeq: 0,
    recenterTargetId: null,
    telemetry: {},
    requestTraces: [],
    selectedTraceId: null,
    traceGraphRef: null,
    traceSource: null,
    telemetryLoading: false,
    telemetryError: null,
    traceLoading: false,
    traceError: null,
    environment: null,
    telemetrySources: sourceRegistrations.map(sourceDescriptor),
    telemetrySourceId: initialTelemetrySourceId,
    provider: initialTelemetryProvider,
    hasOverlay: dependencies.hasOverlay,
    sourceUrl,
    analyzeUrl,
    githubSource,
    prsUrl,
    prOneUrl,
    prFilesUrl,
    prCommentsUrl,
    prChecksUrl,
    prSessionSource: dependencies.prSessionSource ?? null,
    prsTab: "open",
    prsList: { open: null, closed: null },
    prExtraSummaries: {},
    prsHasMore: { open: false, closed: false },
    prsLoading: false,
    prsError: null,
    prSearchQuery: "",
    prSearchResults: [],
    prSearchHasMore: false,
    prSearchCache: {},
    prSearchLoading: false,
    prSearchError: null,
    relatedPrs: null,
    prSelected: null,
    prFiles: null,
    prDiscussion: null,
    prChecks: null,
    prFilesTruncated: false,
    prFilesTotal: 0,
    prFilesOutside: 0,
    prFilesSuggestedSubdir: "",
    prReviewBlocked: null,
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
    prReviewStatus: "idle",
    prPrepareStage: null,
    prReviewProgress: createPrReviewProgressSnapshot(),
    prPrepareError: null,
    prPreparedGraphId: null,
    prPreparedComparisonGraphId: null,
    prPreparedMergeBaseSha: null,
    prPreparedHeadSha: null,
    prPreparedArtifactCurrent: false,
    prReviewBaseline: null,
    prReviewComparison: null,
    graphUrl: dependencies.graphUrl ?? "",
    progressiveGraph: initialGraphProjection === null ? null : {
      head: initialGraphProjection,
      comparison: null,
      explicitFileIds: [],
      affectedDepth: initialGraphProjection.loadedDepth,
      requestedDepth: initialGraphProjection.requestedDepth,
      status: "ready",
      error: null,
    },
    progressiveSymbols: {
      status: "idle",
      graphId: null,
      generation: null,
      symbols: [],
      indexed: 0,
      total: 0,
      error: null,
    },
    progressivePendingNodeIds: new Set<string>(),
    codeView: null,

    // Reveal one more containment level, scoped to the current selection (or the whole view when
    // nothing is selected). Each surface reads its own visible frontier + selection and folds the
    // ids scopedExpansion picks into its own expansion set — see applyScoped below.
    expandAll() {
      applyScoped(get, set, () => (moduleGraph ??= buildModuleGraph(get().index)), () => (blockDeps ??= buildBlockDeps(get().index)), idsToExpand, "open", { label: "Expanding one level…" });
    },

    // Grow the literal selection over the exact painted graph supplied by the mounted surface.
    // Dependency direction is irrelevant for adjacency; graph membership/layout remain untouched.
    expandModuleSelectionByOneHop(nodes, edges) {
      const state = get();
      if (
        state.moduleSelected.size === 0
        || state.syntheticExecutionStatus === "running"
        || (state.review !== null && state.flowSelection !== null)
      ) {
        return;
      }
      const expanded = expandedSelectionByOneHop(state.moduleSelected, nodes, edges);
      if (expanded.size <= state.moduleSelected.size) {
        return;
      }
      set({
        moduleSelected: expanded,
        reviewSelectedId: null,
        reviewLitNodeIds: null,
      });
    },

    expandLogicOccurrences(nodeIds) {
      applyLogicOccurrenceScope(get, set, nodeIds, idsToExpand, { label: "Expanding one level…" });
    },

    // Fully collapse the same scope: close every open container within it in one click.
    collapseAll() {
      applyScoped(get, set, () => (moduleGraph ??= buildModuleGraph(get().index)), () => (blockDeps ??= buildBlockDeps(get().index)), idsToCollapse, "close", { label: "Collapsing graph…" });
    },

    collapseAllViewedNodes() {
      const state = get();
      const ids = collapsibleViewedNodeIds(state);
      if (ids.length === 0) {
        return;
      }
      set({ moduleExpanded: foldIds(state.moduleExpanded, ids, "close") });
      void relayoutActiveModuleSurface(get, { label: "Collapsing viewed nodes…" });
    },

    collapseLogicOccurrences(nodeIds) {
      applyLogicOccurrenceScope(get, set, nodeIds, idsToCollapse, { label: "Collapsing graph…" });
    },

    // Bump the recenter signal so the active graph surface re-fits its viewport (to the current
    // selection, or the whole graph if none). A pure signal — no relayout, no navigation change; the
    // surface reads the value change via useRecenter and calls React Flow's fitView.
    recenter() {
      set({ recenterSeq: get().recenterSeq + 1, recenterTargetId: null });
    },

    // The command palette's magnifier is a camera gesture, not reveal/add navigation. Preserve the
    // shared selection semantics (including review-flow ownership), then carry the exact target to
    // the active React Flow surface. Its getNode check is the final authority after any paint race.
    focusNodeInView(id) {
      if (moduleSurfaceSpec(get().viewMode) === null) {
        return false;
      }
      get().selectModule(id);
      const current = get();
      set({ recenterSeq: current.recenterSeq + 1, recenterTargetId: id });
      return true;
    },

    toggleFlowExplorer() {
      if (!get().flowExplorerOpen) {
        set({ flowExplorerOpen: true });
        return;
      }
      set({ flowExplorerOpen: false });
      // Closing the explorer is the same navigation as closing its selected pane. In review mode
      // that path also restores the graph snapshot captured before flow inspection began.
      get().selectFlowEntry(null);
    },

    selectFlowEntry(ref) {
      syntheticExecutionSeq += 1;
      if (ref === null) {
        const state = get();
        const baseline = state.reviewFlowBaseline;
        const reviewFlowOpen = state.review !== null
          && state.minimalSeedIds.length > 0
          && state.flowSelection !== null
          && baseline !== null;
        flowPaneLayoutSeq += 1;
        requestTargetRevealSeq += 1;
        set({
          flowSelection: null,
          reviewFlowExplicitView: null,
          flowPaneOrigin: null,
          requestFlowTraceId: null,
          requestFlowExpansionOverrides: new Set<string>(),
          flowPaneExpansionOverrides: new Set<string>(),
          flowPaneCollapsedEdges: new Set<string>(),
          ...syntheticExecutionReset(),
          flowPaneRfNodes: [],
          flowPaneRfEdges: [],
          flowPaneLayoutStatus: "idle",
          ...(reviewFlowOpen
            ? {
                logicSelected: null,
                ...baseline,
                reviewFlowBaseline: null,
              }
            : {}),
        });
        if (reviewFlowOpen && baseline !== null) {
          void requestMinimalRelayout({ label: "Closing logic flow review…" });
        }
        return;
      }
      const state = get();
      const { artifact, index, viewMode } = state;
      const flows = (artifact.extensions?.logicFlow ?? {}) as unknown as LogicFlows;
      const related = relatedNodeIds(index, flows, ref);
      const reviewFlow = state.review !== null && state.minimalSeedIds.length > 0;
      if (reviewFlow) {
        const needsExecutionGraph = state.reviewOpenFlowSplitOnSelect && state.reviewFlowSplitView === "graph";
        if (!needsExecutionGraph) {
          // Hidden splits and alternate projections do not mount this execution graph. Invalidate
          // and discard any older ELK result instead of paying for invisible work.
          flowPaneLayoutSeq += 1;
        }
        const reviewFlowBaseline = state.reviewFlowBaseline ?? {
          moduleSelected: new Set(state.moduleSelected),
          moduleExpanded: new Set(state.moduleExpanded),
          minimalSeedIds: [...state.minimalSeedIds],
          minimalMemberIds: [...state.minimalMemberIds],
          minimalBasePositions: { ...state.minimalBasePositions },
          minimalArrange: state.minimalArrange,
          reviewSelectedId: state.reviewSelectedId,
          reviewLitNodeIds: state.reviewLitNodeIds === null ? null : new Set(state.reviewLitNodeIds),
        };
        // A review flow is an exact code-level read, not the explorer's coarser file reveal. Open
        // every owning file/unit gate so nested methods exist on the minimal Map, then select every
        // resolved node in the flow. Off-member targets remain exact ghost cards.
        const moduleExpanded = expandedCodePaths(reviewFlowBaseline.moduleExpanded, related, index);
        const { minimalSeedIds, minimalMemberIds } = expandFlowRollups(
          state,
          related,
          reviewFlowBaseline.minimalSeedIds,
          reviewFlowBaseline.minimalMemberIds,
        );
        const needsRelayout = !sameFlowSelection(state.flowSelection, ref)
          || state.logicSelected !== null
          || !sameStringSet(related, state.moduleSelected)
          || !sameStringSet(moduleExpanded, state.moduleExpanded)
          || !sameMembers(minimalSeedIds, state.minimalSeedIds)
          || !sameMembers(minimalMemberIds, state.minimalMemberIds);
        set({
          flowSelection: ref,
          reviewFlowExplicitView: null,
          flowPaneOrigin: "explorer",
          requestFlowTraceId: null,
          requestFlowExpansionOverrides: new Set<string>(),
          flowPaneExpansionOverrides: new Set<string>(),
          flowPaneCollapsedEdges: new Set<string>(),
          ...syntheticExecutionReset(),
          logicSelected: null,
          moduleSelected: related,
          moduleExpanded,
          minimalSeedIds,
          minimalMemberIds,
          reviewFlowBaseline,
          reviewLitNodeIds: null,
          reviewSelectedId: null,
          ...(!needsExecutionGraph
            ? {
                flowPaneRfNodes: [] as LogicRfNode[],
                flowPaneRfEdges: [] as LogicRfEdge[],
                flowPaneLayoutStatus: "idle" as const,
              }
            : {}),
        });
        if (needsExecutionGraph) {
          void get().flowPaneRelayout();
        }
        const recenterIfCurrent = () => {
          if (get().flowSelection === ref && get().logicSelected === null) {
            set({ recenterSeq: get().recenterSeq + 1, recenterTargetId: null });
          }
        };
        if (needsRelayout) {
          void requestMinimalRelayout({ label: "Revealing logic flow in review…" }).then(recenterIfCurrent);
        } else {
          recenterIfCurrent();
        }
        return;
      }
      set({
        flowSelection: ref,
        reviewFlowExplicitView: null,
        flowPaneOrigin: "explorer",
        requestFlowTraceId: null,
        requestFlowExpansionOverrides: new Set<string>(),
        flowPaneExpansionOverrides: new Set<string>(),
        flowPaneCollapsedEdges: new Set<string>(),
        ...syntheticExecutionReset(),
      });
      // Both module lenses the explorer serves (Map + UI) bulk-reveal the flow's modules in the
      // SHARED module spaces — the phase-C unification retired the ui lens's private expansion.
      // The UI lens routes through its OWN reveal: a null focus means the RENDER ROOT there (not
      // the repo), so the repo-rooted helper could select files the lens never draws.
      if (viewMode === "modules" || viewMode === "ui") {
        const reveal =
          viewMode === "ui"
            ? uiRevealStateForMany(nearestModuleIds([...related], index), index)
            : moduleRevealStateFor([...related], index);
        if (reveal) {
          set({
            moduleFocus: reveal.moduleFocus,
            moduleExpanded: reveal.moduleExpanded,
            moduleSelected: reveal.moduleSelected,
            moduleGhostInspection: null,
          });
          void get().moduleRelayout({ label: "Revealing selected flow…" });
        } else {
          set({ moduleSelected: new Set<string>(), moduleGhostInspection: null });
          if (state.moduleGhostInspection !== null) {
            void get().moduleRelayout({ label: "Closing ghost exploration…" });
          }
        }
      }
      void get().flowPaneRelayout();
    },

    revealSelectedTraceInCodebase() {
      const state = get();
      if (
        state.minimalSeedIds.length > 0
        || state.moduleLayoutStatus === "laying-out"
        || (state.viewMode !== "modules" && state.viewMode !== "call" && state.viewMode !== "ui")
      ) {
        return;
      }
      const trace = state.selectedTraceId === null
        ? null
        : state.requestTraces.find((candidate) => candidate.traceId === state.selectedTraceId) ?? null;
      if (trace === null || traceGraphRefMismatches(state.traceGraphRef, state.artifact).length > 0) {
        return;
      }

      // The request renderer accepts only the trace contract's exact node-id join. Feed the same
      // proven set into Minimal Graph's canonical codebase projection so runtime labels or source
      // coordinates can never become inferred graph evidence during reveal.
      const exactNodeIds = [...deriveRequestGraphOverlay(trace, state.index).nodesById.keys()];
      if (exactNodeIds.length === 0) {
        return;
      }
      const context = requestCodebaseContextFor(state, exactNodeIds);
      if (context === null) {
        return;
      }
      if (!guardReviewLineComposerTransition(() => get().revealSelectedTraceInCodebase())) {
        return;
      }

      const traceId = trace.traceId;
      const revealedIds = [...context.highlightTargetIds];
      set(canonicalRequestMapPatch(state, context));
      // Do not route through selectModule/setViewMode: both are ordinary navigation and would close
      // the request-origin Logic split. Once the canonical tree is ready, the existing recenter
      // signal fits all revealed exact ids because context.reveal selected them as one set.
      void get().moduleRelayout({ label: `Revealing ${revealedIds.length} observed node${revealedIds.length === 1 ? "" : "s"}…` }).then(() => {
        const current = get();
        if (current.selectedTraceId === traceId && current.viewMode === "modules") {
          set({ recenterSeq: current.recenterSeq + 1, recenterTargetId: null });
        }
      });
    },

    openSelectedRequestFlowPane() {
      const state = get();
      if (
        (state.viewMode !== "modules" && state.viewMode !== "call" && state.viewMode !== "ui")
        || state.minimalSeedIds.length > 0
        || (state.flowSelection !== null && state.flowPaneOrigin !== "request")
      ) {
        return;
      }
      const trace = state.selectedTraceId === null
        ? null
        : state.requestTraces.find((candidate) => candidate.traceId === state.selectedTraceId) ?? null;
      if (
        trace === null
        || traceGraphRefMismatches(state.traceGraphRef, state.artifact).length > 0
      ) {
        return;
      }
      if (state.flowPaneOrigin === "request" && state.requestFlowTraceId === trace.traceId) {
        return;
      }
      requestTargetRevealSeq += 1;
      set({
        telemetryMode: true,
        flowSelection: null,
        reviewFlowExplicitView: null,
        flowPaneOrigin: "request",
        requestFlowTraceId: trace.traceId,
        requestFlowExpansionOverrides: new Set<string>(),
        flowPaneExpansionOverrides: new Set<string>(),
        flowPaneCollapsedEdges: new Set<string>(),
        flowPaneRfNodes: [],
        flowPaneRfEdges: [],
        flowPaneLayoutStatus: "laying-out",
      });
      void get().flowPaneRelayout();
    },

    async runSyntheticExecution(args) {
      const { rootId, scenarioId, input, host } = args;
      const state = get();
      const scenario = state.syntheticScenarios.find((candidate) => (
        candidate.id === scenarioId && candidate.rootId === rootId
      ));
      const endpoint = activeSyntheticExecutionUrl(state);
      if (state.syntheticExecutionTrust?.mode === "sandboxed-pr" && args.sandboxConsent !== true) {
        set({
          syntheticExecutionRootId: rootId,
          syntheticExecutionHost: host,
          syntheticExecutionStatus: "error",
          syntheticExecutionError: "Confirm the untrusted PR sandbox before running code.",
        });
        return;
      }
      if (!syntheticExecutionContextMatches(state, host, rootId) || scenario === undefined || endpoint === null) {
        set({
          syntheticExecutionRootId: rootId,
          syntheticExecutionHost: host,
          syntheticExecutionStatus: "error",
          syntheticExecutionError: endpoint === null
            ? "Synthetic execution is not available in this session."
            : scenario === undefined
              ? "This synthetic scenario does not match the selected flow."
              : "The selected flow is no longer open.",
        });
        return;
      }

      const sequence = ++syntheticExecutionSeq;
      set({
        syntheticExecutionRootId: rootId,
        syntheticExecutionHost: host,
        syntheticExecutionStatus: "running",
        syntheticExecutionError: null,
      });
      try {
        const experimentMatches = state.syntheticExperimentRootId === rootId;
        const execution = await requestSyntheticExecution(endpoint, {
          scenarioId: scenario.id,
          rootNodeId: rootId,
          input,
          inputOverrides: experimentMatches ? state.syntheticInputOverrides : [],
          watchers: experimentMatches ? state.syntheticFieldWatchers : [],
        }, { sandboxConsent: state.syntheticExecutionTrust?.mode === "sandboxed-pr" });
        if (syntheticExecutionSeq !== sequence) {
          return;
        }
        if (!syntheticExecutionContextMatches(get(), host, rootId)) {
          set(syntheticExecutionReset());
          return;
        }
        if (execution.scenarioId !== scenario.id || execution.rootId !== rootId) {
          throw new Error("Synthetic execution response does not match the requested flow.");
        }
        const currentSelection = get().flowSelection;
        const executionSelection = host === "logic"
          ? currentSelection?.rootId === rootId ? currentSelection : { rootId, blockPath: [] }
          : currentSelection;
        if (executionSelection === null || executionSelection.rootId !== rootId) {
          throw new Error("The selected flow changed before synthetic execution completed.");
        }
        const previousExecution = get().syntheticExecution;
        const comparablePrevious = previousExecution?.rootId === execution.rootId
          && previousExecution.scenarioId === execution.scenarioId
          ? previousExecution
          : null;
        flowPaneLayoutSeq += 1;
        const stoppedHit = execution.stop?.reason === "watcher"
          ? execution.watchHits.find((hit) => hit.id === execution.stop?.watchHitId) ?? null
          : null;
        const initialMomentId = stoppedHit === null
          ? defaultSyntheticMomentId(execution.trace)
          : syntheticOccurrenceSteps(execution, get().index).find((step) => step.spanId === stoppedHit.spanId)?.id
            ?? defaultSyntheticMomentId(execution.trace);
        set({
          flowSelection: executionSelection,
          flowPaneOrigin: "synthetic",
          requestFlowTraceId: null,
          requestFlowExpansionOverrides: new Set<string>(),
          syntheticExecution: execution,
          syntheticPreviousExecution: comparablePrevious,
          syntheticExecutionRootId: rootId,
          syntheticExecutionHost: host,
          syntheticExecutionStatus: "ready",
          syntheticExecutionError: null,
          syntheticSelectedMomentId: initialMomentId,
          syntheticFlowPresentation: "focused",
          flowPaneRfNodes: [],
          flowPaneRfEdges: [],
          flowPaneLayoutStatus: "laying-out",
        });
        await get().flowPaneRelayout();
      } catch (error) {
        if (syntheticExecutionSeq !== sequence) {
          return;
        }
        if (!syntheticExecutionContextMatches(get(), host, rootId)) {
          set(syntheticExecutionReset());
          return;
        }
        set({
          syntheticExecutionRootId: rootId,
          syntheticExecutionHost: host,
          syntheticExecutionStatus: "error",
          syntheticExecutionError: syntheticExecutionFailure(error),
        });
      }
    },

    openReviewFlow(ref, view) {
      // Reuse the canonical review-selection path so graph reveal, baseline capture, and flow
      // highlighting stay identical to an ordinary row selection. The transient override is
      // applied afterwards and never written to localStorage.
      get().selectFlowEntry(ref);
      const state = get();
      if (state.flowSelection === null || !sameFlowSelection(state.flowSelection, ref)) {
        return;
      }
      if (view !== "graph") {
        // A preference for Graph may have started an ELK pass during selection. Supersede it before
        // mounting the requested DOM projection so a stale result cannot win later.
        flowPaneLayoutSeq += 1;
        set({
          reviewFlowExplicitView: view,
          recenterSeq: state.recenterSeq + 1,
          recenterTargetId: null,
          flowPaneRfNodes: [],
          flowPaneRfEdges: [],
          flowPaneLayoutStatus: "idle",
        });
        return;
      }
      set({ reviewFlowExplicitView: view, recenterSeq: state.recenterSeq + 1, recenterTargetId: null });
      void get().flowPaneRelayout();
    },

    requestSyntheticEditor(rootId, host) {
      set({ syntheticEditorRequest: { rootId, host } });
    },

    consumeSyntheticEditorRequest(rootId, host) {
      const request = get().syntheticEditorRequest;
      if (request?.rootId === rootId && request.host === host) {
        set({ syntheticEditorRequest: null });
      }
    },

    stageSyntheticInputOverride(rootId, override) {
      const state = get();
      const current = state.syntheticExperimentRootId === rootId ? state.syntheticInputOverrides : [];
      set({
        syntheticExperimentRootId: rootId,
        syntheticInputOverrides: [...current.filter((candidate) => candidate.id !== override.id), override],
        ...(state.syntheticExperimentRootId === rootId ? {} : { syntheticFieldWatchers: [] }),
      });
    },

    removeSyntheticInputOverride(id) {
      set({ syntheticInputOverrides: get().syntheticInputOverrides.filter((override) => override.id !== id) });
    },

    addSyntheticFieldWatcher(rootId, watcher) {
      const state = get();
      const current = state.syntheticExperimentRootId === rootId ? state.syntheticFieldWatchers : [];
      set({
        syntheticExperimentRootId: rootId,
        syntheticFieldWatchers: [...current.filter((candidate) => candidate.id !== watcher.id), watcher],
        ...(state.syntheticExperimentRootId === rootId ? {} : { syntheticInputOverrides: [] }),
      });
    },

    removeSyntheticFieldWatcher(id) {
      set({ syntheticFieldWatchers: get().syntheticFieldWatchers.filter((watcher) => watcher.id !== id) });
    },

    clearSyntheticExecution() {
      const state = get();
      syntheticExecutionSeq += 1;
      if (state.syntheticExecutionHost === "logic") {
        flowPaneLayoutSeq += 1;
        set({
          flowSelection: null,
          reviewFlowExplicitView: null,
          flowPaneOrigin: null,
          requestFlowTraceId: null,
          requestFlowExpansionOverrides: new Set<string>(),
          ...syntheticExecutionReset(),
          logicSelected: null,
          flowPaneRfNodes: [],
          flowPaneRfEdges: [],
          flowPaneLayoutStatus: "idle",
        });
        return;
      }
      const selection = state.flowSelection;
      if (selection !== null) {
        // Replay the existing flow-selection entry path. In review this restores the whole related
        // set from the preserved baseline; outside review it re-runs the normal bulk reveal after a
        // synthetic occurrence narrowed the canonical Map to one exact node.
        get().selectFlowEntry(selection);
        return;
      }
      flowPaneLayoutSeq += 1;
      set({
        flowPaneOrigin: null,
        requestFlowExpansionOverrides: new Set<string>(),
        ...syntheticExecutionReset(),
        logicSelected: null,
        flowPaneRfNodes: [],
        flowPaneRfEdges: [],
        flowPaneLayoutStatus: "idle",
      });
    },

    selectSyntheticMoment(momentId, targetId) {
      const state = get();
      if (state.flowPaneOrigin !== "synthetic" || state.syntheticExecution === null) return;
      const steps = syntheticOccurrenceSteps(state.syntheticExecution, state.index);
      const nextMomentId = momentId ?? defaultSyntheticMomentId(state.syntheticExecution.trace);
      if (nextMomentId !== null && !steps.some((step) => step.id === nextMomentId)) return;
      const changed = nextMomentId !== state.syntheticSelectedMomentId;
      set({
        syntheticSelectedMomentId: nextMomentId,
        ...(changed ? { flowPaneLayoutStatus: "laying-out" as const } : {}),
      });
      get().selectFlowPaneTarget(targetId);
      if (changed && nextMomentId !== null) void get().flowPaneRelayout();
    },

    setSyntheticFlowOrientation(orientation) {
      const state = get();
      if (state.syntheticFlowOrientation === orientation) return;
      set({
        syntheticFlowOrientation: orientation,
        ...(state.flowPaneOrigin === "synthetic" ? { flowPaneLayoutStatus: "laying-out" as const } : {}),
      });
      if (state.flowPaneOrigin === "synthetic") void get().flowPaneRelayout();
    },

    setSyntheticFlowPresentation(presentation) {
      const state = get();
      if (state.syntheticFlowPresentation === presentation) return;
      set({
        syntheticFlowPresentation: presentation,
        ...(state.flowPaneOrigin === "synthetic" ? { flowPaneLayoutStatus: "laying-out" as const } : {}),
      });
      if (state.flowPaneOrigin === "synthetic") void get().flowPaneRelayout();
    },

    toggleRequestFlowExpand(nodeId) {
      const state = get();
      if (
        (state.flowPaneOrigin !== "request" && state.flowPaneOrigin !== "synthetic")
        || state.flowPaneLayoutStatus !== "ready"
      ) {
        return;
      }
      const node = state.flowPaneRfNodes.find((candidate) => candidate.id === nodeId);
      const data = node?.data as Partial<LogicNodeData> | undefined;
      if (data?.expandable !== true) {
        return;
      }
      set({
        requestFlowExpansionOverrides: withToggled(state.requestFlowExpansionOverrides, nodeId),
        flowPaneLayoutStatus: "laying-out",
      });
      void get().flowPaneRelayout();
    },

    toggleFlowPaneExpand(nodeId) {
      const state = get();
      if (state.flowPaneOrigin !== "explorer" || state.flowPaneLayoutStatus !== "ready") {
        return;
      }
      const node = state.flowPaneRfNodes.find((candidate) => candidate.id === nodeId);
      const data = node?.data as Partial<LogicNodeData> | undefined;
      if (data?.expandable !== true) {
        return;
      }
      set({
        flowPaneExpansionOverrides: withToggled(state.flowPaneExpansionOverrides, nodeId),
        flowPaneLayoutStatus: "laying-out",
      });
      void get().flowPaneRelayout();
    },

    toggleFlowPaneEdgeCollapse(collapseKey) {
      const state = get();
      if (state.flowPaneOrigin === null || state.flowPaneLayoutStatus !== "ready") {
        return;
      }
      const edgeVisible = state.flowPaneRfEdges.some((edge) => edge.data?.collapseKey === collapseKey);
      const foldVisible = state.flowPaneRfNodes.some((node) => (
        node.type === "fold"
        && (node.data as { collapseKey?: unknown }).collapseKey === collapseKey
      ));
      if (!edgeVisible && !foldVisible) {
        return;
      }
      set({
        flowPaneCollapsedEdges: withToggled(state.flowPaneCollapsedEdges, collapseKey),
        flowPaneLayoutStatus: "laying-out",
      });
      void get().flowPaneRelayout();
    },

    selectFlowPaneTarget(nodeId) {
      const state = get();
      const syntheticReview = state.flowPaneOrigin === "synthetic"
        && state.review !== null
        && state.minimalSeedIds.length > 0
        && state.reviewFlowBaseline !== null;
      const mapLinkedExecution = state.flowPaneOrigin === "request"
        || (state.flowPaneOrigin === "synthetic" && !syntheticReview);
      if (mapLinkedExecution) {
        const revealSequence = ++requestTargetRevealSeq;
        const executionOrigin = state.flowPaneOrigin;
        const trace = executionOrigin === "synthetic"
          ? state.syntheticExecution?.trace ?? null
          : state.requestFlowTraceId === null
            ? null
            : state.requestTraces.find((candidate) => candidate.traceId === state.requestFlowTraceId) ?? null;
        const graphTarget = nodeId !== null
          && trace !== null
          && requestFlowContainsTarget(state, trace, nodeId)
          && (executionOrigin === "synthetic" || traceGraphRefMismatches(state.traceGraphRef, state.artifact).length === 0)
          && state.index.nodesById.has(nodeId)
          ? nodeId
          : null;
        if (graphTarget === null) {
          // Empty-pane clicks clear only the map emphasis. An unmapped runtime occurrence has no
          // graph node to invent, so clicking it is deliberately inert.
          if (nodeId === null) set({ moduleSelected: new Set<string>() });
          return;
        }

        // Minimal Graph is a separately curated surface. Match the bulk request reveal contract:
        // do not silently replace or relayout it from a split-pane click.
        if (state.minimalSeedIds.length > 0) {
          return;
        }

        const traceId = trace!.traceId;
        const targetSet = new Set([graphTarget]);
        const semanticDepths = state.moduleRfNodes
          .map((node) => (node.data as { semanticDepth?: unknown }).semanticDepth)
          .filter((depth): depth is number => typeof depth === "number" && Number.isFinite(depth));
        const currentSemanticDepth = semanticDepths.length === 0 ? null : Math.min(...semanticDepths);
        const targetAlreadyDrawn = state.moduleRfNodes.some((node) => {
          if (node.id !== graphTarget || node.type === "ghost") return false;
          const depth = (node.data as { semanticDepth?: unknown }).semanticDepth;
          return currentSemanticDepth === null
            ? depth === undefined
            : depth === currentSemanticDepth;
        });
        const showTests = state.showTests || state.index.testIds.has(graphTarget);
        const recenterIfCurrent = () => {
          const current = get();
          if (
            revealSequence === requestTargetRevealSeq
            && current.flowPaneOrigin === executionOrigin
            && (executionOrigin === "synthetic"
              ? current.syntheticExecution?.trace.traceId === traceId
              : current.requestFlowTraceId === traceId)
            && current.moduleLayoutStatus === "ready"
            && current.moduleSelected.has(graphTarget)
          ) {
            set({ recenterSeq: current.recenterSeq + 1, recenterTargetId: null });
          }
        };

        // If the exact node already belongs to the mounted graph, this is a paint + camera action:
        // retain the reader's curation, remove filters that could conceal the target, and highlight it.
        if (targetAlreadyDrawn) {
          set({
            moduleSelected: targetSet,
            hiddenCategories: new Set<ModuleCategory>(),
            showPrivate: true,
            showTests,
          });
          // No layout is pending on the fast path; its current graph is already ready by definition.
          const current = get();
          if (current.moduleLayoutStatus === "ready" || current.moduleLayoutStatus === "idle") {
            set({ recenterSeq: current.recenterSeq + 1, recenterTargetId: null });
          }
          return;
        }

        // An absent exact target may be behind any package/file/unit gate, represented only by a
        // ghost, or rolled into another lens. Reuse Minimal Graph's canonical “show in codebase”
        // projection: it returns only after proving this exact id is a REAL node in the derived tree.
        const context = requestCodebaseContextFor(state, [graphTarget]);
        if (context === null || !context.highlightTargetIds.has(graphTarget)) return;
        if (!guardReviewLineComposerTransition(() => get().selectFlowPaneTarget(nodeId))) return;
        set(canonicalRequestMapPatch(state, context));
        const subject = executionOrigin === "synthetic" ? "synthetic run" : "request";
        void get().moduleRelayout({ label: `Revealing ${state.index.nodesById.get(graphTarget)?.displayName ?? graphTarget} from ${subject}…` }).then(recenterIfCurrent);
        return;
      }
      const selection = state.flowSelection;
      if (selection === null) {
        return;
      }
      // The shared `logicSelected` field belongs to the main Logic lens. A non-review explorer pane
      // must not overwrite (or clear) that unrelated selection; linked graph inspection is a PR
      // review interaction only until the pane owns a dedicated local selection field.
      if (state.review === null || state.minimalSeedIds.length === 0 || state.reviewFlowBaseline === null) {
        return;
      }
      const flows = (state.artifact.extensions?.logicFlow ?? {}) as unknown as LogicFlows;
      const related = relatedNodeIds(state.index, flows, selection);
      // External/unresolved call blocks still select inside the flow pane, but they have no artifact
      // definition to reveal on the Map. Keep the whole-flow graph context in that honest fallback.
      const rawGraphTarget = nodeId !== null && related.has(nodeId) && state.index.nodesById.has(nodeId) ? nodeId : null;
      const diffVisible = state.reviewDiffOnly
        ? reviewDiffVisibleIds(state.index, state.reviewAffectedIds)
        : null;
      const graphTarget = rawGraphTarget !== null && (diffVisible === null || diffVisible.has(rawGraphTarget))
        ? rawGraphTarget
        : null;
      const emphasized = graphTarget === null
        ? new Set([...related].filter((id) => diffVisible === null || diffVisible.has(id)))
        : new Set([graphTarget]);
      const moduleExpanded = expandedCodePaths(state.moduleExpanded, emphasized, state.index);
      // Re-derive on every target change. When the selected node is currently an off-member ghost,
      // the layout pass temporarily treats its home file as a member so its full incident edge set
      // can fan out to ghost neighbours; clearing the target removes that temporary context again.
      const needsRelayout = moduleExpanded.size !== state.moduleExpanded.size
        || state.logicSelected !== nodeId
        || !sameStringSet(emphasized, state.moduleSelected);
      set({
        logicSelected: nodeId,
        moduleSelected: emphasized,
        moduleExpanded,
        reviewLitNodeIds: null,
        reviewSelectedId: graphTarget,
      });
      const recenterIfCurrent = () => {
        if (get().flowSelection === selection && get().logicSelected === nodeId) {
          set({ recenterSeq: get().recenterSeq + 1, recenterTargetId: null });
        }
      };
      if (needsRelayout) {
        void requestMinimalRelayout({ label: nodeId === null ? "Restoring logic flow context…" : "Revealing logic flow node…" }).then(recenterIfCurrent);
      } else {
        recenterIfCurrent();
      }
    },

    async flowPaneRelayout() {
      const {
        flowSelection,
        flowPaneOrigin,
        requestFlowTraceId,
        requestFlowExpansionOverrides,
        flowPaneExpansionOverrides,
        flowPaneCollapsedEdges,
        syntheticSelectedMomentId,
        syntheticFlowOrientation,
        syntheticFlowPresentation,
        index,
        artifact,
        review,
        prPreparedArtifactCurrent,
        prReviewed,
        reviewDiffByFile,
        reviewExcludeFormatOnlyChanges,
      } = get();
      if (flowPaneOrigin === "request" || flowPaneOrigin === "synthetic") {
        const execution = flowPaneOrigin === "synthetic" ? get().syntheticExecution : null;
        const trace = flowPaneOrigin === "synthetic"
          ? execution?.trace ?? null
          : requestFlowTraceId === null
            ? null
            : get().requestTraces.find((candidate) => candidate.traceId === requestFlowTraceId) ?? null;
        if (trace === null) {
          set({ flowPaneRfNodes: [], flowPaneRfEdges: [], flowPaneLayoutStatus: "idle" });
          return;
        }
        const sequence = ++flowPaneLayoutSeq;
        const traceId = trace.traceId;
        set({ flowPaneLayoutStatus: "laying-out" });
        const flows = (artifact.extensions?.logicFlow ?? {}) as unknown as LogicFlows;
        const graph = flowPaneOrigin === "synthetic"
          && syntheticFlowPresentation === "focused"
          && syntheticSelectedMomentId !== null
          ? await deriveFocusedRequestFlowPaneLayout(
              trace,
              index,
              flows,
              syntheticSelectedMomentId,
              syntheticFlowOrientation,
              requestFlowExpansionOverrides,
              execution?.snapshots ?? [],
              flowPaneCollapsedEdges,
            )
          : await deriveRequestFlowPaneLayout(
              trace,
              index,
              flows,
              requestFlowExpansionOverrides,
              execution?.snapshots ?? [],
              flowPaneCollapsedEdges,
            );
        if (
          flowPaneLayoutSeq !== sequence
          || get().flowPaneOrigin !== flowPaneOrigin
          || (flowPaneOrigin === "request" && get().requestFlowTraceId !== traceId)
          || (flowPaneOrigin === "synthetic" && get().syntheticExecution?.trace.traceId !== traceId)
          || (flowPaneOrigin === "synthetic" && get().syntheticSelectedMomentId !== syntheticSelectedMomentId)
          || (flowPaneOrigin === "synthetic" && get().syntheticFlowOrientation !== syntheticFlowOrientation)
          || (flowPaneOrigin === "synthetic" && get().syntheticFlowPresentation !== syntheticFlowPresentation)
        ) {
          return;
        }
        set({ flowPaneRfNodes: graph.nodes, flowPaneRfEdges: graph.edges, flowPaneLayoutStatus: "ready" });
        return;
      }
      if (flowSelection === null) {
        set({ flowPaneRfNodes: [], flowPaneRfEdges: [], flowPaneLayoutStatus: "idle" });
        return;
      }
      const flows = (artifact.extensions?.logicFlow ?? {}) as unknown as LogicFlows;
      const sequence = ++flowPaneLayoutSeq;
      set({ flowPaneLayoutStatus: "laying-out" });
      // Match the full Logic lens: a flow node's PR status belongs to its own source site, not its
      // callee. Synchronous reviews resolve base-coordinate anchors through GitHub's aligned diff;
      // prepared/current artifacts already carry head-coordinate changed-line kinds themselves.
      const stepStatusSources = prReviewed !== null && !prPreparedArtifactCurrent
        ? reviewDiffByFile
        : review === null
          ? reviewNodeStatusSourcesFromKinds(changedLineKindsFromExtensions(artifact.extensions))
          : (() => {
              const effectiveArtifactDiff = formattingAwareArtifactDiff(
                artifact,
                reviewExcludeFormatOnlyChanges,
              );
              return reviewNodeStatusSourcesFromDiff(
                effectiveArtifactDiff.kinds,
                effectiveArtifactDiff.diffLines,
              );
            })();
      const graph = await deriveFlowPaneLayout(flowSelection, flows, index, flowPaneExpansionOverrides, {
        changedStatusForSource: (source) => reviewSourceChangeStatus(source, stepStatusSources),
      }, flowPaneCollapsedEdges);
      if (flowPaneLayoutSeq !== sequence || get().flowSelection !== flowSelection) {
        return;
      }
      set({ flowPaneRfNodes: graph.nodes, flowPaneRfEdges: graph.edges, flowPaneLayoutStatus: "ready" });
    },

    // The logic flow charted for a callable id: read straight from the artifact extension, keyed
    // by the same node.id grammar as the graph. `extensions` is a loose record, so cast once here.
    logicFlowFor(nodeId) {
      const flows = get().artifact.extensions?.logicFlow;
      if (!flows) {
        return undefined;
      }
      return (flows as unknown as LogicFlows)[nodeId];
    },

    // Open a callable's logic flow (the double-click "dive into logic" gesture). A fresh chart
    // starts at default expansion; clear any prior selection (it means nothing in a new chart).
    openLogicFlow(nodeId) {
      if (!guardReviewLineComposerTransition(() => get().openLogicFlow(nodeId))) {
        return;
      }
      const state = get();
      if (!beginLensTransition(get, set, () => get().openLogicFlow(nodeId))) return;
      moduleLayoutSeq += 1;
      const resetSynthetic = shouldResetLogicHostedSynthetic(state, nodeId);
      if (resetSynthetic) {
        syntheticExecutionSeq += 1;
        flowPaneLayoutSeq += 1;
      }
      set({
        viewMode: "logic",
        logicRoot: nodeId,
        logicStack: [nodeId],
        logicFocus: [],
        logicSelected: null,
        expandedLogic: new Set<string>(),
        collapsedLogicEdges: new Set<string>(),
        ...(resetSynthetic ? logicHostedSyntheticReset() : {}),
      });
      void get().logicRelayout(nodeLayoutActivity(state, "Opening logic for", nodeId));
    },

    // The logic→composition link: a call block's owning-unit chip opens the Service lens HERE with
    // the unit revealed on canvas AND rooted/selected in the composition side panel, so a reader can
    // pivot from "who calls this" to "how healthy is the unit it lives in".
    openComposition(unitId) {
      if (!guardReviewLineComposerTransition(() => get().openComposition(unitId))) {
        return;
      }
      const state = get();
      if (!beginLensTransition(get, set, () => get().openComposition(unitId))) return;
      const reveal = serviceRevealStateForMany(
        [unitId],
        get().index,
        get().serviceGroupingMode,
        get().serviceGroupingTargetSize,
      );
      set({
        viewMode: "call",
        compRoot: unitId,
        compSelectedId: unitId,
        mapExtra: new Set<string>(),
        mapGhostPins: new Map<string, ReadonlySet<string>>(),
        moduleRfNodes: [],
        moduleRfEdges: [],
        moduleSemanticLayers: [],
        moduleEffectiveFocus: null,
        // Composition pivots deliberately re-enter the full Service lens; unlike tab-to-tab path
        // carry, they must not recreate the session-only scoped sub-view that the reader exited.
        serviceScope: null,
        ...(reveal ?? MODULE_TOP_LEVEL),
      });
      void get().moduleRelayout(nodeLayoutActivity(state, "Opening service graph for", unitId));
    },

    // Drill from a call node into its target's own flow — push it onto the trail, re-chart from it.
    // A changed callable starts unfocused, so any container dive is dropped.
    drillLogicFlow(nodeId) {
      const state = get();
      const resetSynthetic = shouldResetLogicHostedSynthetic(state, nodeId);
      if (resetSynthetic) {
        syntheticExecutionSeq += 1;
        flowPaneLayoutSeq += 1;
      }
      set({
        logicStack: [...state.logicStack, nodeId],
        logicRoot: nodeId,
        logicFocus: [],
        logicSelected: null,
        expandedLogic: new Set<string>(),
        collapsedLogicEdges: new Set<string>(),
        ...(resetSynthetic ? logicHostedSyntheticReset() : {}),
      });
      void get().logicRelayout(nodeLayoutActivity(state, "Opening logic for", nodeId));
    },

    // Jump back to an earlier callable in the trail (a logic-breadcrumb click), truncating there.
    // Clears any container dive — returning to a callable crumb shows its full flow.
    logicFlowTo(nodeId) {
      const state = get();
      const index = state.logicStack.indexOf(nodeId);
      if (index === -1) {
        return;
      }
      const resetSynthetic = shouldResetLogicHostedSynthetic(state, nodeId);
      if (resetSynthetic) {
        syntheticExecutionSeq += 1;
        flowPaneLayoutSeq += 1;
      }
      set({
        logicStack: state.logicStack.slice(0, index + 1),
        logicRoot: nodeId,
        logicFocus: [],
        logicSelected: null,
        expandedLogic: new Set<string>(),
        collapsedLogicEdges: new Set<string>(),
        ...(resetSynthetic ? logicHostedSyntheticReset() : {}),
      });
      void get().logicRelayout(nodeLayoutActivity(state, "Returning to", nodeId));
    },

    // Dive INTO a control container (loop/try): re-chart the canvas to show ONLY its bodies as a
    // focused sub-view, the breadcrumb gaining a segment. Push it, reset expansion, relayout.
    diveLogicContainer(id, label, bodies) {
      set({
        logicFocus: [...get().logicFocus, { id, label, bodies }],
        logicSelected: null,
        expandedLogic: new Set<string>(),
        collapsedLogicEdges: new Set<string>(),
      });
      void get().logicRelayout({ label: `Opening ${label}…` });
    },

    // Jump back along the container-dive trail (a focus-breadcrumb click): truncate to `index + 1`;
    // a negative index clears focus entirely, back to the full callable flow. Reset, relayout.
    logicFocusTo(index) {
      set({
        logicFocus: index < 0 ? [] : get().logicFocus.slice(0, index + 1),
        logicSelected: null,
        expandedLogic: new Set<string>(),
        collapsedLogicEdges: new Set<string>(),
      });
      void get().logicRelayout({ label: index < 0 ? "Returning to full logic flow…" : "Returning to parent flow…" });
    },

    // Set how many levels of resolved calls the Logic-flow view expands in place. Clamped to 0..2
    // (the cap that keeps a deep pre-expansion from hanging the browser). Sticky — never reset on
    // open/drill — so the reader's chosen inline depth carries across navigation.
    setLogicInlineDepth(depth) {
      set({ logicInlineDepth: Math.max(0, Math.min(2, Math.trunc(depth))) });
    },

    // Reachability fallback: reveal/hide tests with direct resolved calls as ghosts above the flow.
    // Runtime aggregate reports deliberately do not use this static test identity. Repaint only —
    // the view derives the ghosts from this flag + report, so it never relayouts.
    toggleLogicTests() {
      set({ showLogicTests: !get().showLogicTests });
    },

    // Switch which projection of the charted flow is on screen. A pure view switch: root, drill
    // trail, and selection all stay put, and the exec graph's ELK layout is untouched (it re-mounts
    // from the already-derived logicRfNodes when switched back).
    setLogicView(mode) {
      set({
        logicView: mode,
        ...(mode === "request" ? { telemetryMode: true } : {}),
      });
    },

    // Set how many hops of indirect callers the "related flows" ghosts reach back. Clamped to
    // 1..GHOST_DEPTH_ALL — 1 == direct callers (today's behavior), 2/3 walk that many hops, and
    // GHOST_DEPTH_ALL means the whole transitive-caller closure. A repaint only — the view recomputes
    // the ghosts in a useMemo from this — so it deliberately does NOT relayout the graph.
    setGhostDepth(depth) {
      set({ ghostDepth: Math.max(1, Math.min(GHOST_DEPTH_ALL, Math.trunc(depth))) });
    },

    // Select a call target in the Logic-flow view (pass null to clear). The view renders straight
    // from logicRoot, so this needs no relayout — it only repaints the highlight.
    selectLogicTarget(id) {
      set({ logicSelected: id });
    },

    // Pin/unpin a flow-root for quick access; a plain membership toggle over the session list.
    togglePinnedFlow(id) {
      const pinned = get().pinnedFlows;
      set({ pinnedFlows: pinned.includes(id) ? pinned.filter((pin) => pin !== id) : [...pinned, id] });
    },

    // Expand/collapse a Logic-graph node: a call reveals its callee flow nested inline; a loop/try
    // shows or hides its body. Flip membership in expandedLogic, then re-lay out the graph.
    toggleLogicExpand(nodeId) {
      const state = get();
      set({ expandedLogic: withToggled(state.expandedLogic, nodeId) });
      void get().logicRelayout(nodeLayoutActivity(state, "Updating", nodeId));
    },

    toggleLogicEdgeCollapse(collapseKey) {
      const state = get();
      if (state.logicLayoutStatus !== "ready") {
        return;
      }
      const edgeVisible = state.logicRfEdges.some((edge) => edge.data?.collapseKey === collapseKey);
      const foldVisible = state.logicRfNodes.some((node) => (
        node.type === "fold"
        && (node.data as { collapseKey?: unknown }).collapseKey === collapseKey
      ));
      if (!edgeVisible && !foldVisible) {
        return;
      }
      set({
        collapsedLogicEdges: withToggled(state.collapsedLogicEdges, collapseKey),
        logicLayoutStatus: "laying-out",
        logicLayoutActivity: { label: state.collapsedLogicEdges.has(collapseKey) ? "Expanding flow path…" : "Collapsing flow path…" },
      });
      void get().logicRelayout();
    },

    // Toggle hiding the greyed (non-expandable) building-block leaves — the library/leaf calls.
    toggleHideGreyed() {
      const hideGreyed = !get().hideGreyed;
      set({ hideGreyed });
      void get().logicRelayout({ label: hideGreyed ? "Hiding leaf blocks…" : "Showing leaf blocks…" });
    },

    // Toggle the service-frame nesting — flat blocks (default) vs consecutive same-owner calls grouped
    // under service frames. Mirrors toggleHideGreyed: flip the flag, then re-lay out the graph.
    toggleNestByService() {
      const nestByService = !get().nestByService;
      set({ nestByService });
      void get().logicRelayout({ label: nestByService ? "Grouping flow by service…" : "Flattening service groups…" });
    },

    // Re-derive the Logic graph for the current root through ELK, behind a stale-seq guard (a newer
    // open/drill/toggle discards an older in-flight layout). A null root clears the graph.
    async logicRelayout(activity) {
      const {
        logicRoot,
        index,
        artifact,
        expandedLogic,
        collapsedLogicEdges,
        hideGreyed,
        nestByService,
        logicFocus,
        review,
        prPreparedArtifactCurrent,
        prReviewed,
        reviewDiffByFile,
        reviewDiffLinesByFile,
        reviewExcludeFormatOnlyChanges,
      } = get();
      if (logicRoot === null) {
        set({ logicRfNodes: [], logicRfEdges: [], logicLayoutStatus: "idle", logicLayoutActivity: null });
        return;
      }
      const flows = (artifact.extensions?.logicFlow ?? {}) as unknown as LogicFlows;
      const sequence = ++logicLayoutSeq;
      set({
        logicLayoutStatus: "laying-out",
        logicLayoutActivity: activity ?? { label: "Arranging logic flow…" },
      });
      try {
        await yieldForPaint();
        if (logicLayoutSeq !== sequence) {
          return;
        }
        // A container dive charts only the TOP focus entry's bodies; else the whole callable flow.
        const top = logicFocus[logicFocus.length - 1];
        const focus = top ? { id: top.id, bodies: top.bodies } : undefined;
        // Flow nodes represent source sites, not their callees. Resolve their PR status from each
        // FlowStep source anchor using the same aligned line-kind source as node colouring.
        const stepStatusSources = prReviewed !== null && !prPreparedArtifactCurrent
          ? liveReviewStatusSources(reviewDiffByFile, reviewDiffLinesByFile)
          : review === null
            ? reviewNodeStatusSourcesFromDiff(
                changedLineKindsFromExtensions(artifact.extensions),
                changedDiffLinesFromExtensions(artifact.extensions),
              )
            : (() => {
                const effectiveArtifactDiff = formattingAwareArtifactDiff(
                  artifact,
                  reviewExcludeFormatOnlyChanges,
                );
                return reviewNodeStatusSourcesFromDiff(
                  effectiveArtifactDiff.kinds,
                  effectiveArtifactDiff.diffLines,
                );
              })();
        const graph = await deriveLogicLayout(logicRoot, flows, index, expandedLogic, {
          hideGreyed,
          nestByService,
          changedStatusForSource: (source) => reviewSourceChangeStatus(source, stepStatusSources),
        }, focus, collapsedLogicEdges);
        if (logicLayoutSeq !== sequence) {
          return; // a newer layout superseded this one.
        }
        set({
          logicRfNodes: graph.nodes,
          logicRfEdges: graph.edges,
          logicLayoutStatus: "ready",
          logicLayoutActivity: null,
        });
      } catch {
        if (logicLayoutSeq === sequence) {
          set({ logicLayoutStatus: "error", logicLayoutActivity: null });
        }
      }
    },

    // Select a composition unit (pass null to clear). The view renders straight from the laid-out
    // graph, so this needs no relayout — it only repaints the highlight.
    selectCompUnit(id) {
      set({ compSelectedId: id });
    },

    // Re-root the Service-composition side panel at a module/package (null == whole system). Clears
    // the selection and the code view — neither carries meaning in a new rooted view. When the root
    // is unchanged it still clears the stale selection + code so navigation always returns to the
    // graph first.
    setCompRoot(id) {
      if (!guardReviewLineComposerTransition(() => get().setCompRoot(id))) {
        return;
      }
      const sameRoot = get().compRoot === id;
      // Root navigation should always return to the graph surface; if the root is unchanged, still
      // clear stale composition selection/code so Cmd+P never appears to jump straight to source.
      if (sameRoot) {
        if (get().compSelectedId !== null || get().codeView !== null) {
          set({ compSelectedId: null, codeView: null });
        }
        return;
      }
      set({ compRoot: id, compSelectedId: null, codeView: null });
    },

    // Show/hide the per-card SOLID metrics (metric rows + smell chips) on the composition scorecards.
    // Persisted across reloads.
    toggleSolidMetrics() {
      const next = !get().showSolidMetrics;
      writeSolidMetricsPref(next);
      set({ showSolidMetrics: next });
    },

    // Clicking a ghost is exploratory, not curation: chart the exact artifact as a temporary root
    // so the ordinary derive pipeline emits its next dependency ring. The retained anchors keep the
    // ring the reader entered from; only the shared "+" action writes permanent `mapExtra` state.
    inspectModuleGhost(nodeIds, anchorIds, extend) {
      const state = get();
      if (state.minimalSeedIds.length > 0 || moduleSurfaceSpec(state.viewMode) === null) {
        return false;
      }
      const validVisited = extraRoots(state.index, new Set(nodeIds));
      if (validVisited.length === 0) {
        return false;
      }
      const prior = extend ? state.moduleGhostInspection : null;
      const visitedIds = new Set(prior?.visitedIds ?? []);
      validVisited.forEach((id) => visitedIds.add(id));
      const anchorSet = new Set(prior?.anchorIds ?? []);
      // Direct adjacency from a later frontier click explains which visited node exposed it, but it
      // is not a new provenance owner. Only the path's original entry anchors retain their complete
      // mixed-relation ghost ring; visited nodes contribute calls only.
      if (prior === null) {
        anchorIds
          .filter((id) => typeof id === "string" && id.length > 0)
          .forEach((id) => anchorSet.add(id));
      }
      const next: ModuleGhostInspection = { anchorIds: anchorSet, visitedIds };
      if (
        state.moduleGhostInspection !== null
        && sameStringSet(state.moduleGhostInspection.anchorIds, next.anchorIds)
        && sameStringSet(state.moduleGhostInspection.visitedIds, next.visitedIds)
      ) {
        return true;
      }
      set({ moduleGhostInspection: next });
      void get().moduleRelayout(nodeLayoutActivity(state, "Exploring calls from", validVisited[0]));
      return true;
    },

    clearModuleGhostInspection() {
      if (get().moduleGhostInspection === null) {
        return;
      }
      set({ moduleGhostInspection: null });
      void get().moduleRelayout({ label: "Closing ghost exploration…" });
    },

    // Re-derive the active module-family surface through ELK, behind the same stale-seq guard. The
    // SurfaceSpec owns both its visible tree and its semantic-parent relation, so Map, Service, and
    // UI all travel through this one hierarchy/composition path.
    async moduleRelayout(activity) {
      const sequence = ++moduleLayoutSeq;
      set({
        moduleLayoutStatus: "laying-out",
        moduleLayoutActivity: activity ?? defaultModuleLayoutActivity(get()),
      });
      try {
        await yieldForPaint();
        if (moduleLayoutSeq !== sequence) {
          return;
        }
        const state = get();
        const graph = (moduleGraph ??= buildModuleGraph(state.index));
        const deps = (blockDeps ??= buildBlockDeps(state.index));
        const flows = (state.artifact.extensions?.logicFlow ?? {}) as unknown as LogicFlows;
        // Hidden tests are EXCLUDED from the layout (not just painted out): test code can be half the
        // cards, and paint-hiding it kept a crater of empty space. toggleShowTests relayouts this lens.
        // (The Service tree applies the hidden set to its GHOST tier only — cluster members still
        // hide at paint time, exactly as its old branch did. The Commons toggle rides in as part of
        // `state`: the Map's spec threads `showCommons` into its hub demotion; Service/UI ignore it.
        // Focused semantic composites disable the off-frame dock below so all detail stays enclosed.)
        const hidden = new Set(state.showTests ? EMPTY_HIDDEN_IDS : state.index.testIds);
        // Cmd+P/ghost "+" pins are explicit exceptions to the Tests-off projection. Retain only the
        // selected card's containment closure; unrelated test files remain absent and showTests stays
        // untouched, so removing the pin restores the ordinary filter on the next relayout.
        for (const id of explicitRootVisibleIds(state.index, state.mapExtra)) hidden.delete(id);
        const spec = activeModuleSurfaceSpec(state.viewMode);
        // A focused surface mounts detail plus every real parent graph as independent ELK layers.
        // Commons demotion stays disabled for focused composites: independent Map layouts would
        // otherwise mint the same RF-only dock identity. Service/UI ignore this Map-only flag.
        const semanticState = state.moduleFocus !== null ? { ...state, showCommons: false } : state;
        const transientIds = state.moduleGhostInspection?.visitedIds;
        const extraIds = transientIds === undefined || transientIds.size === 0
          ? state.mapExtra
          : new Set([...state.mapExtra, ...transientIds]);
        let tree = spec.deriveTree(
          semanticState,
          { graph, deps, flows },
          { extraIds, hiddenIds: hidden },
        );
        if (state.moduleGhostInspection !== null) {
          tree = decorateGhostInspectionTree(tree, state.index, state.moduleGhostInspection, state.mapExtra);
        }
        const outerTrees: SemanticOuterTree<SurfaceSemanticContext>[] = [];
        let currentState = semanticState;
        let currentEffectiveFocus = tree.effectiveFocus;
        const seenParents = new Set<string>();
        while (currentState.moduleFocus !== null && currentEffectiveFocus !== null) {
          const stateKey = `${currentState.moduleFocus}\u0000${currentEffectiveFocus}`;
          if (seenParents.has(stateKey)) {
            break;
          }
          seenParents.add(stateKey);
          const parent = spec.navigation.semanticParent({ state: currentState, effectiveFocus: currentEffectiveFocus });
          if (parent === null) {
            break;
          }
          const parentState = {
            ...currentState,
            moduleFocus: parent.focus,
            moduleExpanded: new Set<string>(),
            ...(parent.context ?? {}),
          };
          let parentTree = spec.deriveTree(
            parentState,
            { graph, deps, flows },
            { hiddenIds: hidden },
          );
          if (state.moduleGhostInspection !== null) {
            // Outer semantic layers intentionally receive no temporary roots, but their canonical
            // ancestors (and a Service layer's synthetic anchor) are still inside the retained
            // path. Mark them so clicking the visible enclosing card does not end exploration.
            parentTree = decorateGhostInspectionTree(
              parentTree,
              state.index,
              state.moduleGhostInspection,
              state.mapExtra,
            );
            parentTree = {
              ...parentTree,
              nodes: parentTree.nodes.map((node) =>
                node.id === parent.anchorId
                  ? { ...node, data: { ...node.data, ghostInspectionPath: true } }
                  : node),
            };
          }
          outerTrees.push({
            level: {
              depth: outerTrees.length + 1,
              focus: parent.focus,
              effectiveFocus: parentTree.effectiveFocus,
              anchorId: parent.anchorId,
              label: parent.label,
              context: parent.context,
            },
            tree: parentTree,
          });
          if (parent.focus === null) {
            break;
          }
          currentState = parentState;
          currentEffectiveFocus = parentTree.effectiveFocus;
        }
        const stack = prepareSemanticModuleStack(tree, outerTrees);
        let laid: { nodes: Node[]; edges: Edge[] };
        let semanticLayers: SemanticAncestorLevel<SurfaceSemanticContext>[] = [];
        if (stack.layers.length < 2) {
          laid = await layoutModuleTree(tree.nodes, tree.edges, spec.relations);
        } else {
          const layouts = await Promise.all(
            stack.layers.map((layer) => layoutModuleTree(layer.tree.nodes, layer.tree.edges, spec.relations)),
          );
          const composite = composeSemanticStackLayouts(layouts, stack);
          laid = composite ?? layouts[0];
          if (composite !== null) {
            semanticLayers = stack.ancestors;
          }
        }
        if (moduleLayoutSeq !== sequence) {
          return; // a newer focus change superseded this one.
        }
        const latest = get();
        let moduleSelected = latest.moduleSelected;
        if (pendingModuleSelectionPrune.size > 0) {
          const visibleIds = new Set(laid.nodes.map((node) => node.id));
          const staleIds = [...pendingModuleSelectionPrune].filter((id) =>
            latest.moduleSelected.has(id) && !visibleIds.has(id));
          if (staleIds.length > 0) {
            moduleSelected = new Set(latest.moduleSelected);
            staleIds.forEach((id) => moduleSelected.delete(id));
          }
          pendingModuleSelectionPrune.clear();
        }
        set({
          moduleRfNodes: laid.nodes,
          moduleRfEdges: laid.edges,
          moduleEffectiveFocus: tree.effectiveFocus,
          moduleSemanticLayers: semanticLayers,
          moduleSelected,
          moduleLayoutStatus: "ready",
          moduleLayoutActivity: null,
        });
        if (get().progressiveGraph !== null) scheduleProgressiveLookahead();
      } catch {
        if (moduleLayoutSeq === sequence) {
          set({ moduleLayoutStatus: "error", moduleLayoutActivity: null });
        }
      }
    },

    // Explicitly dive the active module surface (null == its root). Clears the selection (it means
    // nothing at a new level) and re-lays out. A no-op when already there. Wheel zoom-in is inert;
    // this action remains the double-click/breadcrumb navigation path on every SurfaceSpec.
    setModuleFocus(id) {
      const state = get();
      if (state.moduleFocus === id) {
        return;
      }
      // A new level is a fresh id space, so the prior expansion set means nothing here — clear it so
      // the new level opens with only its frontier shown (mirrors logic's reset-on-drill).
      set({
        moduleFocus: id,
        moduleSelected: new Set<string>(),
        moduleExpanded: new Set<string>(),
        mapExtra: new Set<string>(),
        mapGhostPins: new Map<string, ReadonlySet<string>>(),
        moduleGhostInspection: null,
      });
      void get().moduleRelayout(id === null
        ? { label: "Returning to overview…" }
        : nodeLayoutActivity(state, "Opening", id));
    },

    // The cards a breadcrumb segment can descend into: the frontier the Map draws at that focus,
    // filtered to folders/files. Reuses the cached import graph and the SAME hidden-tests set the
    // layout hides, so the dropdown never lists a card that isn't on screen.
    folderChildrenFor(focus) {
      const state = get();
      const graph = (moduleGraph ??= buildModuleGraph(state.index));
      const hidden = state.showTests ? EMPTY_HIDDEN_IDS : state.index.testIds;
      return levelChildren(state.index, graph, focus, hidden);
    },

    // Crossing an outward semantic threshold is browser-back-shaped navigation on ANY registered
    // module surface, but its target graph is already mounted and aligned. A coarse wheel sample may
    // cross more than one band, so consume through the canonical graph actually visible at that
    // depth. Surviving absolute markers stay stable through the camera reset.
    commitModuleSemanticParent(depth) {
      const state = get();
      const target = state.moduleSemanticLayers.find((level) => level.depth === depth);
      if (
        moduleSurfaceSpec(state.viewMode) === null ||
        state.moduleLayoutStatus !== "ready" ||
        !Number.isInteger(depth) ||
        target === undefined
      ) {
        return false;
      }
      const retained = retainSemanticStackFromDepth(
        { nodes: state.moduleRfNodes, edges: state.moduleRfEdges },
        depth,
      );
      if (retained === null) {
        return false;
      }

      // A focus relayout requested immediately before the threshold must never overwrite this
      // committed slice when its awaited ELK work completes.
      moduleLayoutSeq += 1;
      set({
        ...(target.context ?? {}),
        moduleFocus: target.focus,
        moduleEffectiveFocus: target.effectiveFocus,
        moduleRfNodes: retained.nodes,
        moduleRfEdges: retained.edges,
        moduleSemanticLayers: state.moduleSemanticLayers.filter((level) => level.depth > depth),
        moduleSelected: new Set<string>(),
        moduleExpanded: new Set<string>(),
        mapExtra: new Set<string>(),
        mapGhostPins: new Map<string, ReadonlySet<string>>(),
        moduleGhostInspection: null,
      });
      return true;
    },

    // Expand/collapse a card of the module surface IN PLACE (the service tab's cluster frames, the
    // Map's inline file/block expansions). A relayout concern — the canvas gains/loses nested cards.
    toggleModuleExpand(nodeId) {
      const state = get();
      const collapsing = state.moduleExpanded.has(nodeId);
      set({ moduleExpanded: withToggled(state.moduleExpanded, nodeId) });
      void relayoutActiveModuleSurface(
        get,
        nodeLayoutActivity(state, collapsing ? "Collapsing" : "Expanding", nodeId),
      );
    },

    // REVEAL a code node the reader can't see (a ghost card's real definition): refocus the Map at
    // the directory it lives in, with its file/unit chain expanded so the symbol is actually drawn.
    // The Map-native "go to definition" — a deliberate focus jump, so prior expansions reset like
    // any setModuleFocus navigation.
    revealModule(nodeId) {
      const state = get();
      const ancestors = state.index.ancestorsOf(nodeId);
      const file = ancestors.find(isCanonicalFileNode);
      const unit = ancestors.find((node) => UNIT_CARD_KINDS.has(node.kind));
      const directory = [...ancestors].reverse().find((node) => node.kind === "package" && node.id !== file?.id);
      const expanded = new Set<string>();
      if (file) {
        expanded.add(file.id);
      }
      if (unit) {
        expanded.add(unit.id);
      }
      set({
        moduleFocus: directory?.id ?? null,
        moduleExpanded: expanded,
        moduleSelected: new Set([nodeId]),
        showPrivate: state.showPrivate || state.index.privateIds.has(nodeId),
        mapExtra: new Set<string>(), // a focus jump ends the scratch "+" pins from the level we left.
        mapGhostPins: new Map<string, ReadonlySet<string>>(),
        moduleGhostInspection: null,
      });
      void get().moduleRelayout(nodeLayoutActivity(state, "Opening", nodeId));
    },

    // GHOST reveal on the SERVICE lens — the expand-based sibling of revealModule: resolve the
    // ghost through the shared service placement (resolveServiceAnchors — the same pass the
    // lens-carry and the scope opener read) and OPEN its owning cluster frame(s) in place, frames
    // UNIONED into the current expansion, the node selected. A folded FOLDER group-ghost
    // decomposes to every clustered unit beneath the folder, opening ALL their frames (the folder
    // id stays the selection — the same id revealModule selects for a group ghost). NEVER a folder
    // focus (this lens's reveal is an expand, not a jump). A live cluster ZOOM survives only when
    // it already contains the ghost — else it clears WITH its cluster's frame joining the union
    // (the zoom drew that frame force-open; exiting must not collapse the reader's context), and a
    // scoped sub-view WIDENS by the owning leads, so the opened frame is actually on canvas. An
    // unclustered ghost (an unowned helper, a folder with no clustered units) has no frame to
    // open: best-effort select only, mirroring revealModule's tolerance.
    revealServiceGhost(nodeId) {
      const state = get();
      const { index, moduleExpanded, moduleFocus, serviceScope, serviceGroupingMode, serviceGroupingTargetSize } = state;
      const resolution = resolveServiceAnchors([nodeId], index, serviceGroupingMode, serviceGroupingTargetSize);
      if (resolution === null) {
        set({ moduleSelected: new Set([nodeId]), moduleGhostInspection: null });
        if (state.moduleGhostInspection !== null) {
          void get().moduleRelayout(nodeLayoutActivity(state, "Revealing", nodeId));
        }
        return;
      }
      const focusLead = moduleFocus === null ? null : leadIdOf(moduleFocus);
      const focusDomain = moduleFocus === null
        ? undefined
        : serviceDomainById(
            deriveServiceDomains(clusteringFor(index), serviceGroupingMode, serviceGroupingTargetSize),
            moduleFocus,
          );
      const staysInFocus = (focusLead !== null && resolution.owningLeads.every((lead) => lead === focusLead))
        || (focusDomain !== undefined && resolution.owningLeads.every((lead) => focusDomain.leadIds.includes(lead)));
      const expanded = new Set([...moduleExpanded, ...resolution.reveal.moduleExpanded]);
      if (!staysInFocus && focusLead !== null && moduleFocus !== null) {
        expanded.add(moduleFocus);
      }
      if (!staysInFocus && focusDomain !== undefined) {
        expanded.add(focusDomain.id);
      }
      set({
        moduleFocus: staysInFocus ? moduleFocus : null,
        serviceScope: widenServiceScope(serviceScope, resolution.owningLeads),
        moduleExpanded: expanded,
        moduleSelected: resolution.reveal.moduleSelected,
        moduleGhostInspection: null,
      });
      // `moduleExpanded` is shared with the minimal overlay; when one covers this lens the reveal
      // must re-lay the overlay the reader can see, not the Map beneath it.
      void relayoutActiveModuleSurface(get, nodeLayoutActivity(state, "Revealing", nodeId));
    },

    // ⌘P palette NAVIGATE: reveal a picked symbol in the current map lens. The Map and UI lenses go
    // to its real definition (revealModule: refocus + expand its file/unit chain + select it). The
    // Service lens has no folder focus, so it pins the symbol's owning card onto the canvas and
    // selects it. Inert elsewhere — the palette opens a logic flow in logic itself.
    revealInView(rawId) {
      const viewMode = get().viewMode;
      if (viewMode === "modules" || viewMode === "ui") {
        get().revealModule(rawId);
        return;
      }
      if (viewMode === "call") {
        const state = get();
        const card = resolveCard(rawId, state.index);
        set({
          mapExtra: new Set(state.mapExtra).add(card),
          moduleSelected: new Set([card]),
          showPrivate: state.showPrivate || state.index.privateIds.has(rawId),
          moduleGhostInspection: null,
        });
        void get().moduleRelayout(nodeLayoutActivity(state, "Revealing", card));
      }
    },

    // ⌘P palette "+": add a picked symbol to the graph the reader can actually see. Minimal Graph
    // covers its source Map and owns a separate ordered member list, so it must win as the destination
    // just like the shared ghost "+" action below. Otherwise pin the owning card into the current map
    // lens as a scratch-card union for its next relayout. All ordinary module lenses share `mapExtra`.
    addToView(rawId) {
      const state = get();
      const viewMode = state.viewMode;
      const minimalOpen = state.minimalSeedIds.length > 0;
      if (!minimalOpen && moduleSurfaceSpec(viewMode) === null) {
        return;
      }
      const revealPrivate = !state.showPrivate && state.index.privateIds.has(rawId);
      if (minimalOpen) {
        if (revealPrivate) {
          set({ showPrivate: true });
        }
        get().promoteGhost(rawId);
        return;
      }

      const card = resolveCard(rawId, state.index);
      if (!state.mapExtra.has(card)) {
        set({
          mapExtra: new Set(state.mapExtra).add(card),
          ...(revealPrivate ? { showPrivate: true } : {}),
        });
        void get().moduleRelayout(nodeLayoutActivity(state, "Adding", card));
      } else if (revealPrivate) {
        // The card is already laid out; exposing its explicitly requested private member is paint-only.
        set({ showPrivate: true });
      }
    },

    async ensureNodeReady(rawId, fileIdHint) {
      const initial = get();
      const session = initial.progressiveGraph;
      if (session === null || graphProjectUrl === null) {
        return initial.index.nodesById.has(rawId);
      }
      const symbol = initial.progressiveSymbols.symbols.find((entry) => entry.id === rawId);
      const resident = initial.index.nodesById.has(rawId);
      // A worker hint exists to admit a truly disconnected row. Once the node is resident, its
      // actual containment is authoritative. A Python package backed by `__init__.py` is its honest
      // HEAD file root; a structural namespace package has none and takes the local fast path below.
      const fileId = resident
        ? nearestModuleIds([rawId], initial.index)[0] ?? null
        : fileIdHint ?? symbol?.fileId ?? null;
      // Proven tombstones are already complete comparison-side declarations in the presentation
      // composite. Their module IDs do not exist in HEAD and must never be POSTed as HEAD roots.
      if (
        initial.index.nodesById.has(rawId)
        && (initial.reviewBaseNodeIds.has(rawId) || (fileId !== null && initial.reviewBaseNodeIds.has(fileId)))
      ) {
        return true;
      }
      if (fileId !== null && session.head.readyFileIds.includes(fileId)) {
        return initial.index.nodesById.has(rawId);
      }
      // A namespace package is a structural ancestor rather than one canonical file root. Background
      // search indexes only file-ownable symbols; an already-present container keeps the legacy
      // local-palette behavior instead of hydrating one arbitrary descendant.
      if (fileId === null && initial.index.nodesById.has(rawId)) {
        return true;
      }
      if (fileId === null) {
        return false;
      }
      const nodeSequence = progressiveNodeSeq;

      set((current) => ({
        progressivePendingNodeIds: new Set(current.progressivePendingNodeIds).add(rawId),
      }));
      try {
        // Cmd/Ctrl+P admission is always the selected file's exact depth-1 neighbourhood. A symbol
        // can already be represented as an unready affected-frontier ghost; treating that as a ghost
        // promotion here would turn one search click into the entire next changed-root BFS ring.
        const hydrated = await hydrateProgressiveFiles([fileId], { consumeAffectedWarm: false });
        const ready = hydrated && get().index.nodesById.has(rawId);
        // Readiness is an exact-node contract, not merely a root-file admission contract. Keep the
        // evidence mark and the palette action disabled if a malformed/stale projection omitted the
        // selected declaration even though it claimed the owning file was ready.
        if (ready) performanceMark("meridian:progressive-node-ready", { nodeId: rawId });
        return ready;
      } catch (error) {
        if (nodeSequence !== progressiveNodeSeq) return false;
        const message = error instanceof Error ? error.message : "could not load the selected symbol";
        set((current) => current.progressiveGraph === null
          || current.progressiveGraph.head.graphId !== session.head.graphId
          || current.progressiveGraph.head.generation !== session.head.generation
          ? {}
          : { progressiveGraph: { ...current.progressiveGraph, status: "error", error: message } });
        return false;
      } finally {
        set((current) => {
          if (
            nodeSequence !== progressiveNodeSeq
            ||
            current.progressiveGraph === null
            || current.progressiveGraph.head.graphId !== session.head.graphId
            || current.progressiveGraph.head.generation !== session.head.generation
          ) {
            return {};
          }
          const pending = new Set(current.progressivePendingNodeIds);
          pending.delete(rawId);
          return { progressivePendingNodeIds: pending };
        });
      }
    },

    async setProgressiveGraphDepth(depth) {
      const requestedDepth = Math.trunc(depth);
      if (requestedDepth < 1 || requestedDepth > MAX_PROGRESSIVE_GRAPH_DEPTH) {
        return false;
      }
      const initial = get();
      const session = initial.progressiveGraph;
      if (session === null || graphProjectUrl === null) {
        return false;
      }
      // Every explicit depth choice supersedes the previous one, including lowering to an already-
      // resident slice. Abort transport work as well as fencing its landing so a slow depth-3 response
      // cannot repaint the control after the reader has returned to depth 1.
      progressiveDepthAbort?.abort();
      const sequence = ++progressiveDepthSeq;
      const controller = new AbortController();
      let projectionTransportInFlight = false;
      const requestIsCurrent = (): boolean => {
        if (controller.signal.aborted || sequence !== progressiveDepthSeq) return false;
        const active = get().progressiveGraph;
        return active !== null
          && active.head.graphId === session.head.graphId
          && active.head.generation === session.head.generation
          && active.requestedDepth === requestedDepth
          && active.status === "ready"
          && isProgressiveSessionDepthReady(active, requestedDepth);
      };
      const settleDepthLayout = async (): Promise<boolean> => {
        if (!requestIsCurrent()) return false;
        let hydrated = get();
        if (hydrated.minimalSeedIds.length > 0) {
          await hydrated.minimalRelayout({ label: `Loading context depth ${requestedDepth}…` });
        } else if (moduleSurfaceSpec(hydrated.viewMode) !== null) {
          await hydrated.moduleRelayout({ label: `Loading context depth ${requestedDepth}…` });
        }
        if (!requestIsCurrent()) return false;
        // The primary canvas relayout may replace the active flow pane. Re-read the settled state
        // before deciding whether a second visible graph also owes a layout pass.
        hydrated = get();
        if (
          hydrated.flowSelection !== null
          && (
            hydrated.flowPaneOrigin === "synthetic"
            || (hydrated.reviewOpenFlowSplitOnSelect && hydrated.reviewFlowSplitView === "graph")
          )
        ) {
          await hydrated.flowPaneRelayout();
        }
        if (!requestIsCurrent()) return false;
        // This mark is the benchmark/UI contract for a usable depth, not merely transferred graph
        // data. It may only land after every visible graph has finished its current layout pass.
        performanceMark("meridian:progressive-depth-ready", { depth: requestedDepth });
        return true;
      };
      try {
        if (isProgressiveSessionDepthReady(session, requestedDepth)) {
          // Cumulative slices stay resident for instant back-and-forth experimentation. A fresh page
          // load is the memory-reclamation boundary used by the benchmark harness.
          set({ progressiveGraph: { ...session, requestedDepth, status: "ready", error: null } });
          return await settleDepthLayout();
        }

        set({ progressiveGraph: { ...session, requestedDepth, status: "expanding", error: null } });
        const prefetchDepth = requestedDepth;
        const explicitRequests = session.explicitFileIds.length === 0
          ? []
          : fileProjectionRequests(
              session.head.graphId,
              session.explicitFileIds,
              requestedDepth,
              prefetchDepth,
            );
        progressiveDepthAbort = controller;
        projectionTransportInFlight = true;
        const [headFragment, comparisonFragment, ...explicitFragments] = await Promise.all([
          fetchGraphProjection(
            graphProjectUrl,
            changedFileProjectionRequest(
              session.head.graphId,
              session.head.seedGraphId,
              requestedDepth,
              prefetchDepth,
            ),
            { signal: controller.signal },
          ),
          session.comparison === null
            ? Promise.resolve(null)
            : fetchGraphProjection(
                graphProjectUrl,
                changedFileProjectionRequest(
                  session.comparison.graphId,
                  session.head.graphId,
                  requestedDepth,
                  prefetchDepth,
                  ),
                { signal: controller.signal },
              ),
          ...explicitRequests.map((projectionRequest) =>
            fetchGraphProjection(graphProjectUrl, projectionRequest, { signal: controller.signal })),
        ]);
        projectionTransportInFlight = false;
        if (sequence !== progressiveDepthSeq) {
          return false;
        }
        if (!isProgressiveProjectionPairReady(headFragment, comparisonFragment)) {
          throw new Error(`the affected-file graph is not ready through depth ${requestedDepth}`);
        }
        if (explicitFragments.some((fragment) =>
          !isProjectionReadyForCanvas(fragment)
          || !projectionRootsCompleteThrough(fragment, requestedDepth),
        )) {
          throw new Error(`a selected graph root is not ready through depth ${requestedDepth}`);
        }
        const current = get().progressiveGraph;
        if (current === null || current.head.graphId !== headFragment.graphId) {
          return false;
        }
        const affectedHead = explicitFragments.reduce(
          mergeGraphProjections,
          mergeGraphProjections(current.head, headFragment),
        );
        const comparison = comparisonFragment === null
          ? current.comparison
          : current.comparison === null
            ? comparisonFragment
            : mergeGraphProjections(current.comparison, comparisonFragment);
        projectionTransportInFlight = true;
        const hydratedAffectedHead = await hydrateHeadProjectionForComparisonContext(
          graphProjectUrl,
          affectedHead,
          comparison,
          { signal: controller.signal },
        );
        projectionTransportInFlight = false;
        if (progressiveDepthAbort === controller) progressiveDepthAbort = null;
        if (sequence !== progressiveDepthSeq) return false;
        // Pair support hydration yields. A command-palette/ghost action may have admitted another
        // explicit HEAD root meanwhile without touching the depth lane. Rebase this result onto the
        // latest immutable session so the older depth request can never erase that concurrent root.
        let active = get().progressiveGraph;
        const nodeSequence = progressiveNodeSeq;
        for (let attempt = 0; attempt < 8; attempt += 1) {
          if (
            active === null
            || active.head.graphId !== hydratedAffectedHead.graphId
            || active.head.generation !== hydratedAffectedHead.generation
          ) {
            return false;
          }
          const completeThrough = new Map(
            active.head.frontier.map((entry) => [entry.fileId, entry.completeThroughDepth]),
          );
          const incompleteExplicit = active.explicitFileIds.filter(
            (fileId) => (completeThrough.get(fileId) ?? -1) < requestedDepth,
          );
          if (incompleteExplicit.length === 0) break;
          if (!await expandProgressiveFileRoots(incompleteExplicit, requestedDepth, nodeSequence)) {
            throw new Error(`a concurrently selected graph root is not ready through depth ${requestedDepth}`);
          }
          if (sequence !== progressiveDepthSeq || nodeSequence !== progressiveNodeSeq) return false;
          active = get().progressiveGraph;
        }
        if (active === null) return false;
        const completeThrough = new Map(
          active.head.frontier.map((entry) => [entry.fileId, entry.completeThroughDepth]),
        );
        if (active.explicitFileIds.some((fileId) => (completeThrough.get(fileId) ?? -1) < requestedDepth)) {
          throw new Error("selected graph roots changed too quickly to finish this depth; try again");
        }
        const head = mergeGraphProjections(active.head, hydratedAffectedHead);
        const activeComparison = comparison === null
          ? active.comparison
          : active.comparison === null
            ? comparison
            : mergeGraphProjections(active.comparison, comparison);
        if (!installProgressiveProjection(
          head,
          activeComparison,
          requestedDepth,
          active.explicitFileIds,
          Math.max(active.affectedDepth, requestedDepth),
        )) {
          return false;
        }
        const installed = get().progressiveGraph;
        if (installed === null || !isProgressiveSessionDepthReady(installed, requestedDepth)) {
          throw new Error(`the graph is not ready through depth ${requestedDepth}`);
        }
        if (
          installed.comparison !== null
          && get().prPreparedArtifactCurrent
          && get().prReviewed !== null
          && !reprojectLivePrReview(
            `Loading context depth ${requestedDepth}…`,
            true,
            false,
          )
        ) {
          throw new Error("the expanded comparison graph no longer matches this review");
        }
        return await settleDepthLayout();
      } catch (error) {
        if (sequence === progressiveDepthSeq) {
          const message = error instanceof Error ? error.message : "could not expand the review graph";
          set((current) => current.progressiveGraph === null
            || current.progressiveGraph.head.graphId !== session.head.graphId
            || current.progressiveGraph.head.generation !== session.head.generation
            ? {}
            : {
                progressiveGraph: {
                  ...current.progressiveGraph,
                  requestedDepth: session.requestedDepth,
                  status: "error",
                  error: message,
                },
              });
        }
        return false;
      } finally {
        // Promise.all rejects on the first failed lane. Cancel only while this operation may still
        // own a live sibling: aborting a response after its body was consumed can make Chromium
        // report that valid transfer as ERR_ABORTED instead of loadingFinished.
        if (projectionTransportInFlight) controller.abort();
        if (progressiveDepthAbort === controller) progressiveDepthAbort = null;
      }
    },

    async startProgressiveSymbolIndex() {
      const initial = get();
      const session = initial.progressiveGraph;
      if (session === null || graphSymbolsUrl === null) {
        return;
      }
      if (
        initial.progressiveSymbols.status === "indexing"
        || (
          initial.progressiveSymbols.status === "ready"
          && initial.progressiveSymbols.graphId === session.head.graphId
          && initial.progressiveSymbols.generation === session.head.generation
        )
      ) {
        return;
      }
      const sequence = ++progressiveSymbolSeq;
      progressiveSymbolAbort?.abort();
      const controller = new AbortController();
      progressiveSymbolAbort = controller;
      const url = new URL(graphSymbolsUrl, requestOrigin());
      url.searchParams.set("id", session.head.graphId);
      progressiveSymbolSearchClient?.dispose(new DOMException("superseded", "AbortError"));
      progressiveSymbolSearchClient = null;
      set({
        progressiveSymbols: {
          status: "indexing",
          graphId: session.head.graphId,
          generation: session.head.generation,
          workerBacked: false,
          symbols: [],
          indexed: 0,
          total: 0,
          error: null,
        },
      });
      let workerClient: GraphSymbolSearchClient | null = null;
      const requestStartedAtMs = performanceTimestamp();
      try {
        const workerBacked = graphSymbolSearchWorkerAvailable();
        let summary: GraphSymbolIndexSummary;
        let retainedSymbols: CompactGraphSymbolEntry[] = [];
        if (workerBacked) {
          workerClient = createGraphSymbolSearchClient();
          progressiveSymbolSearchClient = workerClient;
          summary = await workerClient.load(
            url.toString(),
            MAX_GRAPH_SYMBOL_RESPONSE_BYTES,
            controller.signal,
          );
        } else if (loadGraphSymbolsInlineForTest !== null) {
          const result = await loadGraphSymbolsInlineForTest(url.toString(), { signal: controller.signal });
          summary = graphSymbolIndexSummary(result);
          retainedSymbols = result.symbols;
        } else {
          throw new Error("Repository symbol search requires Web Worker support; showing the loaded graph only.");
        }
        const current = get().progressiveGraph;
        if (
          sequence !== progressiveSymbolSeq
          || current === null
          || summary.graphId !== current.head.graphId
          || summary.generation !== current.head.generation
        ) {
          if (workerClient !== null && progressiveSymbolSearchClient === workerClient) {
            workerClient.dispose(new DOMException("stale graph symbol generation", "AbortError"));
            progressiveSymbolSearchClient = null;
          }
          return;
        }
        set({
          progressiveSymbols: {
            status: summary.complete ? "ready" : "indexing",
            graphId: summary.graphId,
            generation: summary.generation,
            workerBacked,
            // Production never receives the repository inventory. The fetch-only fallback retains
            // its bounded result for tests and WebViews without module-Worker support.
            symbols: retainedSymbols,
            indexed: summary.indexedSymbolCount,
            total: summary.totalSymbolCount,
            error: null,
          },
        });
        performanceMark("meridian:progressive-symbol-index-ready", {
          symbols: summary.indexedSymbolCount,
          graphId: summary.graphId,
          generation: summary.generation,
          requestStartedAtMs,
          workerBacked: workerBacked ? 1 : 0,
          source: workerBacked ? "renderer-symbol-worker-accepted" : "renderer-inline-index-accepted",
        });
      } catch (error) {
        if (workerClient !== null && progressiveSymbolSearchClient === workerClient) {
          workerClient.dispose(error);
          progressiveSymbolSearchClient = null;
        }
        if (sequence === progressiveSymbolSeq) {
          set((current) => ({
            progressiveSymbols: {
              ...current.progressiveSymbols,
              status: "error",
              workerBacked: false,
              error: error instanceof Error ? error.message : "could not index graph symbols",
            },
          }));
        }
      } finally {
        if (progressiveSymbolAbort === controller) progressiveSymbolAbort = null;
      }
    },

    async synchronizeProgressiveSymbolSearch(loaded, isMap) {
      const client = progressiveSymbolSearchClient;
      const state = get().progressiveSymbols;
      if (client === null || state.status !== "ready" || state.workerBacked !== true) return null;
      try {
        return await client.synchronize(loaded, isMap);
      } catch (error) {
        if (progressiveSymbolSearchClient !== client) return null;
        client.dispose(error);
        progressiveSymbolSearchClient = null;
        set((current) => ({
          progressiveSymbols: {
            ...current.progressiveSymbols,
            status: "error",
            workerBacked: false,
            error: error instanceof Error ? error.message : "could not synchronize graph symbols",
          },
        }));
        return null;
      }
    },

    async queryProgressiveSymbols(request) {
      const client = progressiveSymbolSearchClient;
      const state = get().progressiveSymbols;
      if (client === null || state.status !== "ready" || state.workerBacked !== true) return null;
      try {
        return await client.query(request);
      } catch (error) {
        if (error instanceof GraphSymbolSearchSupersededError) return null;
        if (progressiveSymbolSearchClient !== client) return null;
        client.dispose(error);
        progressiveSymbolSearchClient = null;
        set((current) => ({
          progressiveSymbols: {
            ...current.progressiveSymbols,
            status: "error",
            workerBacked: false,
            error: error instanceof Error ? error.message : "could not search graph symbols",
          },
        }));
        return null;
      }
    },

    // The one ghost "+" action used by every module canvas. First resolve the same containment
    // reveal for the clicked artifact, then add its owning member to whichever canvas is currently
    // visible. The destinations necessarily store membership differently: the minimal overlay owns
    // an ordered member list and captures the clicked position, while the Map/Service/UI canvases
    // own a set of extra file cards and let ELK place them. Focus and selection are never replaced.
    promoteGhost(ghostId, at) {
      const state = get();
      const minimalOpen = state.minimalSeedIds.length > 0;
      if (!minimalOpen && moduleSurfaceSpec(state.viewMode) === null) {
        return;
      }

      const progressive = state.progressiveGraph;
      if (progressive !== null && graphProjectUrl !== null) {
        const readyFiles = new Set(progressive.head.readyFileIds);
        const candidatePins = ghostPinIds(
          state.index,
          ghostId,
          drawnGhostMembers(state.moduleRfNodes, ghostId),
        ).filter((id) => isCanonicalFileNode(state.index.nodesById.get(id)));
        const incompletePins = candidatePins.filter((id) => !readyFiles.has(id));
        if (incompletePins.length > 0) {
          if (state.progressivePendingNodeIds.has(ghostId)) return;
          const nodeSequence = progressiveNodeSeq;
          set({
            progressivePendingNodeIds: new Set(state.progressivePendingNodeIds).add(ghostId),
          });
          void hydrateProgressiveFiles(incompletePins)
            .then((ready) => {
              if (ready && nodeSequence === progressiveNodeSeq) get().promoteGhost(ghostId, at);
            })
            .catch((error) => {
              if (nodeSequence !== progressiveNodeSeq) return;
              const message = error instanceof Error ? error.message : "could not load ghost context";
              set((current) => current.progressiveGraph === null
                || current.progressiveGraph.head.graphId !== progressive.head.graphId
                || current.progressiveGraph.head.generation !== progressive.head.generation
                ? {}
                : { progressiveGraph: { ...current.progressiveGraph, status: "error", error: message } });
            })
            .finally(() => {
              set((current) => {
                if (
                  nodeSequence !== progressiveNodeSeq
                  ||
                  current.progressiveGraph === null
                  || current.progressiveGraph.head.graphId !== progressive.head.graphId
                  || current.progressiveGraph.head.generation !== progressive.head.generation
                ) {
                  return {};
                }
                const pending = new Set(current.progressivePendingNodeIds);
                pending.delete(ghostId);
                return { progressivePendingNodeIds: pending };
              });
            });
          return;
        }
      }

      const member = ghostMemberId(state.index, ghostId);
      if (member === null) {
        return;
      }
      const moduleExpanded = withMapRevealExpansion(state.moduleExpanded, [ghostId], state.index);

      if (minimalOpen) {
        if (state.minimalMemberIds.includes(member)) {
          // A nested ghost can belong to a file that is already in the overlay while its
          // containment path is still collapsed. Preserve that member's position, but commit the
          // newly required file/class expansion so relayout can replace the ghost with its real node.
          if (moduleExpanded.size === state.moduleExpanded.size) {
            return;
          }
          set({ moduleExpanded });
          void requestMinimalRelayout(nodeLayoutActivity(state, "Adding", member));
          return;
        }
        const minimalBasePositions =
          at === undefined
            ? state.minimalBasePositions
            : { ...state.minimalBasePositions, [member]: promotedMemberRect(at, !isCanonicalFileNode(state.index.nodesById.get(member))) };
        set({ minimalMemberIds: [...state.minimalMemberIds, member], minimalBasePositions, moduleExpanded });
        void requestMinimalRelayout(nodeLayoutActivity(state, "Adding", member));
        return;
      }

      // A folder group-ghost contributes its bounded set of drawn files; an individual symbol
      // contributes its home file. Map placement deliberately stays ELK's: the pinned files re-enter
      // the level wired to the cards that anchored the ghost, so a captured rect would fight relayout.
      const pins = ghostPinIds(state.index, ghostId, drawnGhostMembers(state.moduleRfNodes, ghostId));
      const mapExtra = new Set(state.mapExtra);
      const newlyPinned = pins.filter((pin) => !mapExtra.has(pin));
      newlyPinned.forEach((pin) => mapExtra.add(pin));
      let mapGhostPins = state.mapGhostPins;
      if (newlyPinned.length > 0) {
        mapGhostPins = new Map(state.mapGhostPins);
        const ownedPins = new Set(mapGhostPins.get(ghostId) ?? []);
        newlyPinned.forEach((pin) => ownedPins.add(pin));
        mapGhostPins.set(ghostId, ownedPins);
      }
      if (
        mapExtra.size === state.mapExtra.size
        && moduleExpanded.size === state.moduleExpanded.size
        && mapGhostPins === state.mapGhostPins
      ) {
        return; // unknown ghost, or its home file and reveal path are already present.
      }
      // Keep the current lens focus and selection. `mapRevealStateForMany` contributes expansion ids
      // only; adopting its other fields would unexpectedly navigate away from the canvas being edited.
      set({ mapExtra, mapGhostPins, moduleExpanded });
      void get().moduleRelayout(nodeLayoutActivity(state, "Adding", member));
    },

    // Remove is the exact inverse of graph admission, not an arbitrary graph hide. In a minimal
    // graph it demotes selected promoted members in one pass and source seeds remain protected. On
    // the source graph it can demote a selected temporary preview, unpin its committed home card, or
    // batch both. Inspection roots outside the selection stay retained, and expansion remains
    // untouched so re-adding a card does not forget how the reader had opened it.
    removeSelectionFromView() {
      const state = get();
      if (state.minimalSeedIds.length > 0) {
        const memberIds = minimalSelectionRemovalIds(state);
        if (memberIds.length === 0) {
          return;
        }
        const removed = new Set(memberIds);
        set({ minimalMemberIds: state.minimalMemberIds.filter((id) => !removed.has(id)) });
        void requestMinimalRelayout(nodeLayoutActivity(state, "Removing", memberIds[0] ?? null));
        return;
      }

      const plan = moduleSelectionRemovalPlan(state);
      if (plan.mapExtraIds.length === 0 && plan.visitedIds.length === 0) {
        return;
      }

      const mapExtra = new Set(state.mapExtra);
      plan.mapExtraIds.forEach((id) => mapExtra.delete(id));
      const mapGhostPins = new Map<string, ReadonlySet<string>>();
      for (const [ghostId, pinIds] of state.mapGhostPins) {
        const remaining = new Set([...pinIds].filter((id) => !plan.mapExtraIds.includes(id)));
        if (remaining.size > 0) {
          mapGhostPins.set(ghostId, remaining);
        }
      }

      let moduleGhostInspection = state.moduleGhostInspection;
      if (moduleGhostInspection !== null && plan.visitedIds.length > 0) {
        const visitedIds = new Set(moduleGhostInspection.visitedIds);
        plan.visitedIds.forEach((id) => visitedIds.delete(id));
        moduleGhostInspection = visitedIds.size === 0
          ? null
          : { anchorIds: new Set(moduleGhostInspection.anchorIds), visitedIds };
      }

      const firstRemoved = plan.selectionIds[0] ?? plan.mapExtraIds[0] ?? plan.visitedIds[0] ?? null;
      const activity = nodeLayoutActivity(state, "Removing", firstRemoved);
      const paintValidSelections = new Set(plan.provenanceSelectionIds);
      plan.selectionIds
        .filter((id) => !paintValidSelections.has(id))
        .forEach((id) => pendingModuleSelectionPrune.add(id));
      // Publish teardown and the admission barrier together. Otherwise a subscriber can observe a
      // null inspection key while layout still says "ready" and briefly admit the stale raw scene.
      set({
        mapExtra,
        mapGhostPins,
        moduleGhostInspection,
        moduleLayoutStatus: "laying-out",
        moduleLayoutActivity: activity,
      });
      // Keep the literal selection through admission so a demoted real card can return as the same
      // selected ghost, retaining its siblings and wires. Palette-only cards may truly disappear;
      // after the settled scene arrives, prune only those selected ids which have no drawn form.
      void get().moduleRelayout(activity);
    },

    // Expand one containment level under the target. `null` means the current view frontier; a
    // frame id means that expanded frame's visible package/file/unit/block child containers. The
    // active module surface decides whether that frontier is the folder Map or the Service lens.
    expandModuleChildren(containerId) {
      const state = get();
      const nodes = moduleTreeNodes(state, (moduleGraph ??= buildModuleGraph(state.index)), (blockDeps ??= buildBlockDeps(state.index)));
      const expanded = new Set(state.moduleExpanded);
      moduleChildContainerIds({ nodes }, containerId).forEach((id) => expanded.add(id));
      set({ moduleExpanded: expanded });
      void relayoutActiveModuleSurface(get, nodeLayoutActivity(state, "Expanding", containerId));
    },

    // Collapse only direct child package/file/unit/block frames; deeper expansion ids deliberately
    // remain, so re-opening a parent restores the reader's deeper manual state.
    collapseModuleChildren(containerId) {
      const state = get();
      const nodes = moduleTreeNodes(state, (moduleGraph ??= buildModuleGraph(state.index)), (blockDeps ??= buildBlockDeps(state.index)));
      const expanded = new Set(state.moduleExpanded);
      moduleChildContainerIds({ nodes }, containerId).forEach((id) => expanded.delete(id));
      set({ moduleExpanded: expanded });
      void relayoutActiveModuleSurface(get, nodeLayoutActivity(state, "Collapsing", containerId));
    },

    // Show/hide `private`-tagged members. PAINT-ONLY — privates keep their layout space, the surface
    // just stops painting them — so positions never reshuffle (the same contract as Tests/categories).
    // A selection about to be hidden retreats first, mirroring toggleShowTests's stranding rule.
    togglePrivateMembers() {
      const showPrivate = !get().showPrivate;
      const { moduleSelected, index } = get();
      set({
        showPrivate,
        moduleSelected: showPrivate ? moduleSelected : new Set([...moduleSelected].filter((id) => !index.privateIds.has(id))),
      });
    },

    // Set the selection's highlight radius (clamped 1..GHOST_DEPTH_ALL). PAINT-ONLY: the surface
    // recomputes the lit neighbourhood in a useMemo, so this deliberately does NOT relayout.
    setModuleRadius(radius) {
      set({ moduleRadius: Math.max(1, Math.min(GHOST_DEPTH_ALL, Math.trunc(radius))) });
    },

    // Paint-only: switches how the already-laid-out Module map interprets selection emphasis.
    toggleHighlightMode() {
      set({ highlightMode: get().highlightMode === "reach" ? "node" : "reach" });
    },

    // Merge/unmerge cross-container edges into highway bundles. Every surface retains exact raw
    // edges, so this is presentation-only: the canvas bundles or restores them without derivation,
    // layout, scene replacement, or a camera reset.
    toggleHighways() {
      const state = get();
      if (reviewOwnsHighways(state)) {
        set({ reviewShowHighways: !state.reviewShowHighways });
      } else {
        set({ showHighways: !state.showHighways });
      }
    },

    // Park/unpark utility hubs in the commons dock. A RELAYOUT toggle (like Tests): the docked
    // cards leave/rejoin ELK, so the level re-lays out and re-fits.
    toggleCommons() {
      const showCommons = !get().showCommons;
      set({ showCommons });
      void get().moduleRelayout({ label: showCommons ? "Showing shared utilities…" : "Hiding shared utilities…" });
    },

    // Show/hide external package/library ghosts and their wires in place. If a hidden external was
    // selected, discard only that selection so the remaining visible graph does not dim around a
    // stale id. Workspace and unresolved boundary selections survive.
    toggleExternalGhosts() {
      const showExternalGhosts = !get().showExternalGhosts;
      const moduleSelected = get().moduleSelected;
      set({
        showExternalGhosts,
        moduleSelected: showExternalGhosts
          ? moduleSelected
          : new Set([...moduleSelected].filter((id) => !id.startsWith("ext:"))),
      });
    },

    // Collapse/restore crowded ghost siblings at paint time. Exact ghost ids and their promotion
    // payloads never leave the derived graph, so this does not relayout or mutate containment.
    toggleGhostGrouping() {
      set({ groupGhostsByParent: !get().groupGhostsByParent });
    },

    // Show/hide a module category. PAINT-ONLY: the surface filters the category's file cards out in
    // place, so this deliberately does NOT relayout — positions stay stable.
    toggleCategory(category) {
      set({ hiddenCategories: withToggledCategory(get().hiddenCategories, category) });
    },

    // Show/hide a relationship kind's wires. PAINT-ONLY, like the category filter — no relayout.
    toggleRelKind(kind) {
      const state = get();
      const policy = activeModuleSurfaceSpec(state.viewMode).relations;
      set({
        relationVisibilityOverrides: toggleRelationOverride(
          policy,
          state.relationVisibilityOverrides,
          kind,
        ),
      });
    },

    // Clear the category / relationship filters back to "show everything". PAINT-ONLY — no relayout.
    resetCategoryFilter() {
      set({ hiddenCategories: new Set<ModuleCategory>() });
    },

    resetRelationshipFilter() {
      const state = get();
      const policy = activeModuleSurfaceSpec(state.viewMode).relations;
      set({
        relationVisibilityOverrides: showAllRelations(
          policy,
          state.relationVisibilityOverrides,
        ),
      });
    },

    resetRelationshipDefaults() {
      const state = get();
      const policy = activeModuleSurfaceSpec(state.viewMode).relations;
      set({
        relationVisibilityOverrides: resetRelationsToPolicyDefaults(
          policy,
          state.relationVisibilityOverrides,
        ),
      });
    },

    // Select a Module-map node, REPLACING the whole selection (pass null to clear) — the plain-click
    // gesture. Selection is paint-only on every surface; exact raw wires are already in the scene.
    selectModule(id) {
      const state = get();
      if (state.review !== null && state.minimalSeedIds.length > 0 && state.flowSelection !== null && state.reviewFlowBaseline !== null) {
        if (id === null) {
          // Clearing the Map while a flow is open means "back to the whole flow", not "show no
          // emphasis": no selected flow node must always highlight every node in that flow.
          get().selectFlowPaneTarget(null);
          return;
        }
        const flows = (state.artifact.extensions?.logicFlow ?? {}) as unknown as LogicFlows;
        if (relatedNodeIds(state.index, flows, state.flowSelection).has(id)) {
          // Clicking a real flow node on the Map mirrors selecting it in the bottom pane.
          get().selectFlowPaneTarget(id);
          return;
        }
        // A plain click outside the selected flow returns to ordinary graph review before applying
        // the new selection; keeping the split open would make its "whole flow" invariant false.
        get().selectFlowEntry(null);
        set({ moduleSelected: new Set([id]), reviewSelectedId: null, reviewLitNodeIds: null });
        return;
      }
      set({ moduleSelected: id === null ? new Set<string>() : new Set([id]) });
    },

    setMinimalView(view) {
      const state = get();
      if (state.minimalSeedIds.length === 0 || state.minimalView === view) return;
      if (!guardReviewLineComposerTransition(() => get().setMinimalView(view))) return;
      set({ minimalView: view });
    },

    setMinimalShowGhostNodes(visible) {
      if (get().minimalShowGhostNodes !== visible) {
        set({ minimalShowGhostNodes: visible });
      }
    },

    setMinimalShowNonDiffGhostNodes(visible) {
      if (get().minimalShowNonDiffGhostNodes !== visible) {
        set({ minimalShowNonDiffGhostNodes: visible });
      }
    },

    setMinimalCodebaseExpansionOverride(nodeId, expanded) {
      const next = new Map(get().minimalCodebaseExpansionOverrides);
      next.set(nodeId, expanded);
      set({ minimalCodebaseExpansionOverrides: next });
    },

    // Extract the current selection into a child graph. The first extraction covers the module
    // surface; every later extraction snapshots the active graph and pushes another frame. An open
    // PR is ambient session context, not an overlay owner, so nested extraction never destroys it.
    buildMinimalGraph() {
      const state = get();
      const nested = state.minimalSeedIds.length > 0;
      if (
        state.moduleSelected.size === 0
        || (!nested && state.prReviewed !== null)
        || (nested && state.minimalLayoutStatus !== "ready")
        || state.flowPaneLayoutStatus === "laying-out"
        || state.syntheticExecutionStatus === "running"
      ) {
        return;
      }
      if (!guardReviewLineComposerTransition(() => get().buildMinimalGraph())) {
        return;
      }
      // The active surface's spec decides how a selection seeds the overlay: identity on the Map,
      // while Service decomposes a selected synthetic frame. Once an extracted graph is active its
      // cards are already in the minimal graph's identity space, so deeper pushes stay verbatim.
      const selected = [...state.moduleSelected];
      const origin = nested
        ? selected
        : activeModuleSurfaceSpec(state.viewMode).minimalSeeds(
            selected,
            state.index,
            state.serviceGroupingMode,
            state.serviceGroupingTargetSize,
          );
      if (origin.length === 0) {
        return;
      }
      // Codebase deliberately includes structural context around a Diff-only PR scene. If the user
      // extracts one of those unchanged context nodes, the child must stop inheriting the parent's
      // diff projection or its exact seed would be filtered into a blank graph. The parent frame
      // retains Diff-only in history, so Back restores the original projection losslessly.
      const diffVisibleIds = nested && state.review !== null && state.reviewDiffOnly
        ? reviewDiffVisibleIds(state.index, state.reviewAffectedIds)
        : null;
      const childEscapesReviewDiff = diffVisibleIds !== null
        && origin.some((id) => !idPassesReviewDiffProjection(state, id, diffVisibleIds));
      // Snapshot the map's current on-screen card positions ONCE, at build — the overlay mirrors them,
      // and re-capturing on curation would let already-placed cards jump. Artifact-sourced review
      // (`prReviewed` null) is allowed because this overlay is that session's only review surface.
      const clearArtifactReviewFlow = !nested && state.review !== null && state.prReviewed === null
        ? {
            reviewLitNodeIds: null,
            reviewSelectedId: null,
            flowSelection: null,
            reviewFlowExplicitView: null,
            flowPaneExpansionOverrides: new Set<string>(),
            flowPaneCollapsedEdges: new Set<string>(),
            logicSelected: null,
            flowPaneRfNodes: [] as LogicRfNode[],
            flowPaneRfEdges: [] as LogicRfEdge[],
            flowPaneLayoutStatus: "idle" as const,
            reviewFlowBaseline: null,
          }
        : {};
      if (state.flowSelection !== null || state.flowPaneOrigin !== null) {
        flowPaneLayoutSeq += 1;
        requestTargetRevealSeq += 1;
      }
      syntheticExecutionSeq += 1;
      const inspectedSource = !nested && state.moduleGhostInspection !== null;
      const minimalBasePositions = captureMapPositions(nested ? state.minimalRfNodes : state.moduleRfNodes);
      const history = nested
        ? [...state.minimalGraphHistory, captureHistoryWithReviewProjection(state)]
        : [];
      reviewProjectionFrameBaseline = null;
      const clearSyntheticFlow = state.flowPaneOrigin === "synthetic"
        ? {
            flowSelection: null,
            reviewFlowExplicitView: null,
            flowPaneOrigin: null,
            requestFlowTraceId: null,
            requestFlowExpansionOverrides: new Set<string>(),
            flowPaneExpansionOverrides: new Set<string>(),
            flowPaneCollapsedEdges: new Set<string>(),
            flowPaneRfNodes: [] as LogicRfNode[],
            flowPaneRfEdges: [] as LogicRfEdge[],
            flowPaneLayoutStatus: "idle" as const,
            logicSelected: null,
            reviewFlowBaseline: null,
          }
        : {};
      set({
        minimalSeedIds: [...origin],
        minimalMemberIds: [...origin],
        minimalRollups: {},
        minimalBasePositions,
        minimalArrange: false,
        minimalRfNodes: [],
        minimalRfEdges: [],
        minimalLayoutStatus: "laying-out",
        minimalLayoutActivity: { label: "Extracting selection…" },
        minimalGraphHistory: history,
        minimalView: "graph",
        minimalShowGhostNodes: state.review === null,
        minimalShowNonDiffGhostNodes: true,
        minimalCodebaseExpansionOverrides: new Map<string, boolean>(),
        reviewDiffOnly: childEscapesReviewDiff ? false : state.reviewDiffOnly,
        moduleGhostInspection: null,
        ...syntheticExecutionReset(),
        syntheticExperimentRootId: null,
        syntheticInputOverrides: [],
        syntheticFieldWatchers: [],
        syntheticEditorRequest: null,
        ...(nested
          ? {
              flowSelection: null,
              reviewFlowExplicitView: null,
              flowPaneOrigin: null,
              requestFlowTraceId: null,
              requestFlowExpansionOverrides: new Set<string>(),
              flowPaneExpansionOverrides: new Set<string>(),
              flowPaneCollapsedEdges: new Set<string>(),
              flowPaneRfNodes: [] as LogicRfNode[],
              flowPaneRfEdges: [] as LogicRfEdge[],
              flowPaneLayoutStatus: "idle" as const,
              logicSelected: null,
              reviewFlowBaseline: null,
              reviewSelectedId: null,
              reviewLitNodeIds: null,
            }
          : {
              prReviewed: null,
              prReviewSource: null,
              ...requestFlowPaneReset(state),
            }),
        ...clearSyntheticFlow,
        ...clearArtifactReviewFlow,
      });
      if (inspectedSource) {
        // The overlay commits its own explicit member set. Rebuild the still-mounted source without
        // reversible preview roots so closing the overlay cannot resurrect the exploration path.
        void get().moduleRelayout({ label: "Restoring source graph…" });
      }
      void requestMinimalRelayout({ label: "Extracting selection…" });
    },

    // Navigate exactly one graph outward. Nested parents restore synchronously from their captured
    // scene; at the root, use the canonical close path so source/PR baselines and URL state receive
    // the same cleanup as the explicit Close action.
    backMinimalGraph() {
      const state = get();
      const parent = state.minimalGraphHistory.at(-1);
      if (parent === undefined) {
        get().closeMinimalGraph();
        return;
      }
      if (!guardReviewLineComposerTransition(() => get().backMinimalGraph())) {
        return;
      }
      minimalLayoutSeq += 1;
      flowPaneLayoutSeq += 1;
      requestTargetRevealSeq += 1;
      syntheticExecutionSeq += 1;
      const restoredModuleSelected = new Set(
        [...parent.moduleSelected].filter((id) =>
          (state.showExternalGhosts || !id.startsWith("ext:"))
          && (state.showPrivate || !state.index.privateIds.has(id)),
        ),
      );
      const remainingHistory = state.minimalGraphHistory.slice(0, -1);
      set({
        ...restoreMinimalGraphHistory(parent),
        moduleSelected: restoredModuleSelected,
        minimalGraphHistory: remainingHistory,
      });
      reviewProjectionFrameBaseline = parent.reviewProjectionBaseline === undefined || state.review === null
        ? null
        : {
            reviewKey: state.review.context.reviewKey,
            index: state.index,
            history: remainingHistory,
            unfiltered: parent.reviewProjectionBaseline.unfiltered,
            projected: parent.reviewProjectionBaseline.projected,
          };
      // The restored RF scene already reflects its captured selection and geometry. Selection is
      // paint-only, so returning to the parent cannot queue a competing layout over this snapshot.
      const showTestsChanged = state.showTests !== parent.showTests;
      const sourceCommentProjectionChanged = (
        state.reviewHideAddedSourceCommentDiffs
        !== parent.reviewHideAddedSourceCommentDiffs
      );
      if (showTestsChanged || sourceCommentProjectionChanged) {
        const liveReprojected = reprojectLivePrReview(
          showTestsChanged
            ? (parent.showTests ? "Restoring tests…" : "Restoring production review…")
            : "Refreshing source-comment filter…",
        );
        if (!liveReprojected) {
          reprojectArtifactReview(parent.showTests);
        }
        if (!liveReprojected && moduleSurfaceSpec(get().viewMode) !== null) {
          void get().moduleRelayout({ label: parent.showTests ? "Restoring tests…" : "Restoring production graph…" });
        }
      }
      const restored = get();
      const reviewFlowSelected = restored.review !== null
        && restored.minimalSeedIds.length > 0
        && restored.flowSelection !== null
        && restored.reviewFlowBaseline !== null;
      if (reviewFlowSelected) {
        const wantsExecutionGraph = restored.flowPaneOrigin === "synthetic"
          || (restored.reviewOpenFlowSplitOnSelect && restored.reviewFlowSplitView === "graph");
        const flowPresentationChanged = state.reviewOpenFlowSplitOnSelect !== parent.reviewOpenFlowSplitOnSelect
          || state.reviewFlowSplitView !== parent.reviewFlowSplitView;
        if (!wantsExecutionGraph) {
          if (
            restored.flowPaneLayoutStatus !== "idle"
            || restored.flowPaneRfNodes.length > 0
            || restored.flowPaneRfEdges.length > 0
          ) {
            flowPaneLayoutSeq += 1;
            set({ flowPaneRfNodes: [], flowPaneRfEdges: [], flowPaneLayoutStatus: "idle" });
          }
        } else if (flowPresentationChanged || restored.flowPaneLayoutStatus !== "ready") {
          void get().flowPaneRelayout();
        }
      }
    },

    // Close the overlay back to the Module-map level canvas. The selection is kept, so the reader
    // can adjust it and rebuild without re-picking every card. Bumping the seq discards any ELK
    // pass still in flight, so a slow layout can't repopulate the arrays after the close.
    closeMinimalGraph(afterDeferredRestore) {
      if (!guardReviewLineComposerTransition(() => { get().closeMinimalGraph(afterDeferredRestore); })) {
        return false;
      }
      const stateBeforeClose = get();
      const closingPrReview = stateBeforeClose.prReviewed;
      // A user close/lens transition wins over a refresh. Invalidate both its data-fetch lane and
      // any streamed head preparation so a late response cannot reopen the overlay they just left.
      if (stateBeforeClose.prReviewRefreshing) {
        prReviewRefreshSeq += 1;
        get().cancelPrReviewPreparation();
        set({ prReviewRefreshing: false });
      }
      if (
        initialGraphProjection !== null
        && dependencies.loadCanonicalBootArtifact != null
        && stateBeforeClose.prPreparedArtifactCurrent
        && stateBeforeClose.prReviewBaseline === null
      ) {
        deferCompleteBootDocumentRestore(() => {
          const closed = get().closeMinimalGraph();
          if (closed) afterDeferredRestore?.();
        });
        return false;
      }
      reviewProjectionFrameBaseline = null;
      const flowBaseline = stateBeforeClose.reviewFlowBaseline;
      const reviewFlowOpen = stateBeforeClose.review !== null
        && stateBeforeClose.flowSelection !== null
        && flowBaseline !== null;
      // Closing the overlay mid-review must not strand the reader on the swapped PR-head artifact
      // (still amber-marked) under the plain Map — yet the review must stay RESUMABLE. Soft-restore
      // the boot graph while keeping every review field (the chip + resumePrReview re-open from
      // them); in sync mode (never swapped, so no baseline to restore) just strip the review's amber
      // back to the boot artifact's own marking. No-op for a non-review overlay close.
      if (get().prReviewed !== null) {
        if (!restorePreparedReviewBaseline(get, set, { endSession: false })) {
          resetChangedIdsToArtifact(get().artifact, get().index);
        }
      }
      const sourceRestoreSequence = moduleLayoutSeq;
      minimalLayoutSeq += 1;
      flowPaneLayoutSeq += 1;
      set({
        ...(reviewFlowOpen && flowBaseline !== null
          ? {
              moduleSelected: flowBaseline.moduleSelected,
              moduleExpanded: flowBaseline.moduleExpanded,
              reviewSelectedId: flowBaseline.reviewSelectedId,
              reviewLitNodeIds: flowBaseline.reviewLitNodeIds,
            }
          : {}),
        minimalSeedIds: [],
        minimalMemberIds: [],
        minimalRollups: {},
        minimalBasePositions: {},
        minimalArrange: false,
        minimalRfNodes: [],
        minimalRfEdges: [],
        minimalLayoutStatus: "idle",
        minimalLayoutActivity: null,
        minimalGraphHistory: [],
        minimalView: "graph",
        minimalShowGhostNodes: stateBeforeClose.review === null
          ? true
          : stateBeforeClose.minimalShowGhostNodes,
        minimalShowNonDiffGhostNodes: true,
        minimalCodebaseExpansionOverrides: new Map<string, boolean>(),
        reviewFocusedSubgraph: null,
        ...(closingPrReview !== null
          ? {
              moduleRfNodes: [] as Node[],
              moduleRfEdges: [] as Edge[],
              moduleSemanticLayers: [] as SemanticAncestorLevel<SurfaceSemanticContext>[],
              moduleEffectiveFocus: null,
              moduleLayoutStatus: "laying-out" as const,
              moduleLayoutActivity: { label: "Restoring review map…" },
            }
          : {}),
        ...(reviewFlowOpen
          ? {
              flowSelection: null,
              reviewFlowExplicitView: null,
              flowPaneExpansionOverrides: new Set<string>(),
              flowPaneCollapsedEdges: new Set<string>(),
              logicSelected: null,
              flowPaneRfNodes: [] as LogicRfNode[],
              flowPaneRfEdges: [] as LogicRfEdge[],
              flowPaneLayoutStatus: "idle" as const,
              reviewFlowBaseline: null,
            }
          : {}),
      });
      if (closingPrReview !== null) {
        // Closing can be the first half of a lens transition. Give that transition one paint to
        // supersede this work, then rebuild only if the soft-closed review is still parked on a
        // module surface. Resume and every artifact swap bump moduleLayoutSeq, so an old base Map
        // can never race a newly reopened HEAD review.
        void (async () => {
          await yieldForPaint();
          const current = get();
          if (
            moduleLayoutSeq !== sourceRestoreSequence
            || current.prReviewed !== closingPrReview
            || current.minimalSeedIds.length > 0
            || moduleSurfaceSpec(current.viewMode) === null
          ) {
            return;
          }
          await current.moduleRelayout({ label: "Restoring review map…" });
        })();
      }
      return true;
    },

    // Reset the overlay to its base: restore the working set to the origin selection, collapse any
    // opened review rollups, and drop re-arrangement (back to the captured map-mirror).
    resetMinimalGraph() {
      const state = get();
      const { minimalSeedIds, minimalMemberIds, minimalRollups, minimalArrange, moduleExpanded } = state;
      // An all-test review with Tests hidden retains a seed-only sentinel so the empty review panel
      // stays mounted. It is not a real origin/member and Reset must never promote it into view.
      if (minimalMemberIds.length === 0) {
        return;
      }
      // Flow review may temporarily substitute exact changed files; restore those to their package
      // summaries. Ordinary chevron disclosure never changes either member list.
      const origin = restoreRolledSeeds(minimalSeedIds, minimalRollups);
      const hidden = reviewProjectionHiddenIds(state);
      const isHidden = (id: string): boolean =>
        hidden.has(id) || state.index.ancestorsOf(id).some((ancestor) => hidden.has(ancestor.id));
      // A review projection deliberately retains the raw origin as a reversible seed sentinel.
      // Reset may restore that origin, but must not promote currently excluded files back into the
      // explicit member set. A summarized package survives when at least one of its files does.
      const visibleOrigin = state.review === null
        ? origin
        : origin.filter((id) => {
            const files = minimalRollups[id];
            return files === undefined ? !isHidden(id) : files.some((fileId) => !isHidden(fileId));
          });
      const rolledIds = Object.keys(minimalRollups);
      const hasOpenRollup = rolledIds.some((id) => moduleExpanded.has(id));
      if (
        sameMembers(minimalMemberIds, visibleOrigin)
        && sameMembers(minimalSeedIds, origin)
        && !minimalArrange
        && !hasOpenRollup
      ) {
        return;
      }
      const collapsed = new Set(moduleExpanded);
      rolledIds.forEach((id) => collapsed.delete(id));
      set({
        minimalSeedIds: origin,
        minimalMemberIds: visibleOrigin,
        moduleExpanded: collapsed,
        minimalArrange: false,
      });
      if (visibleOrigin.length > 0) {
        void requestMinimalRelayout({ label: "Resetting extracted graph…" });
      }
    },

    // Re-arrange: drop the captured map-mirror and run the canonical canvas ELK layout. It stays
    // active so later curation keeps the arranged layout; repeated clicks deliberately run it again.
    rearrangeMinimalGraph() {
      if (get().minimalMemberIds.length === 0) {
        return;
      }
      if (!get().minimalArrange) {
        set({ minimalArrange: true });
      }
      void requestMinimalRelayout({ label: "Re-arranging extracted graph…" });
    },

    // Lay out the overlay's curated subgraph (members + their ghost-satellite ring) through the
    // shared minimal-graph pass, behind its own stale-seq guard. `minimalArrange` picks the fresh
    // ELK layout over the map-mirror; hidden tests drop out of the ring like on the Map beneath.
    // This path is structural only. Selection and Highways consume the settled exact-edge scene in
    // GraphSurface and never enter derivation or ELK.
    async minimalRelayout(activity) {
      if (get().minimalMemberIds.length === 0) {
        set({ minimalLayoutStatus: "idle", minimalLayoutActivity: null });
        if (get().review !== null) {
          performanceMark("meridian:first-actionable-canvas", { nodes: 0, edges: 0 });
          scheduleProgressiveSymbolIndex();
          scheduleProgressiveLookahead();
        }
        return;
      }
      const sequence = ++minimalLayoutSeq;
      set({
        minimalLayoutStatus: "laying-out",
        minimalLayoutActivity: activity ?? { label: "Arranging extracted graph…" },
      });
      try {
        await yieldForPaint();
        if (minimalLayoutSeq !== sequence) {
          return;
        }
        const state = get();
        const { index, minimalSeedIds, minimalBasePositions, minimalArrange, moduleExpanded, artifact } = state;
        const seedIds = new Set(minimalSeedIds);
        // Members beyond the immutable seed tier are the overlay's existing explicit-promotion
        // provenance (ghost "+" and Cmd+P add). Only those curated roots escape Diff-only filtering.
        const explicitRootIds = state.minimalMemberIds.filter((id) => !seedIds.has(id));
        moduleGraph ??= buildModuleGraph(index);
        const deps = (blockDeps ??= buildBlockDeps(index));
        const flows = (artifact.extensions?.logicFlow ?? {}) as unknown as LogicFlows;
        const hidden = new Set(reviewProjectionHiddenIds(state));
        // The review overlay stores explicit additions as members beyond its immutable seed tier.
        // Apply the same picked-root exception to test filtering without exposing sibling tests.
        for (const id of explicitRootVisibleIds(index, explicitRootIds)) hidden.delete(id);
        const members = minimalMembersForFlowInspection(state);
        const surface = activeModuleSurfaceSpec(state.viewMode);
        // An ordinary Extract retains the strongest shortest weak bridge between same-abstraction
        // source cards. Derive it from the already-laid structural scene on every pass: URL restore lays
        // that scene first, while PR/Service projections whose seeds do not exist there safely add
        // none. Relationship visibility and redundant-import suppression remain paint-only, so
        // toggling presentation cannot silently change the extracted graph's membership.
        const connectorIds = state.review === null
          ? minimalGraphConnectorIds(state.moduleRfNodes, state.moduleRfEdges, new Set(minimalSeedIds))
          : EMPTY_HIDDEN_IDS;
        const derivedMembers = connectorIds.size === 0
          ? members
          : new Set([...members, ...connectorIds]);
        // Source-backed group members keep the exact Map card contract, including real coupling
        // counts and disclosure. Review-only rollups have no source card and retain their synthetic
        // summary contract. Both kinds use the same canonical subtree expansion when disclosed.
        const sourceGroupNodes = state.review === null
          ? state.moduleRfNodes.filter((node) =>
              derivedMembers.has(node.id)
              && (node.type === "package" || node.type === "serviceDomain"),
            )
          : [];
        const expandableGroupIds = new Set([
          ...Object.keys(state.minimalRollups),
          ...sourceGroupNodes
            .filter((node) => (node.data as { isContainer?: unknown }).isContainer === true)
            .map((node) => node.id),
        ]);
        const requestedGroupExpansions = new Set(
          [...expandableGroupIds].filter((id) => derivedMembers.has(id) && moduleExpanded.has(id)),
        );
        const rollupExpansions = requestedGroupExpansions.size === 0
          ? []
          : minimalRollupExpansions(
              surface.deriveTree(state, { graph: moduleGraph, deps, flows }, { hiddenIds: hidden }),
              index,
              requestedGroupExpansions,
            );
        const layout = await deriveMinimalGraphLayout(index, moduleGraph, derivedMembers, new Set(minimalSeedIds), minimalBasePositions, {
          moduleExpanded,
          blockDeps: deps,
          flows,
          expandableGroupIds,
          rollupExpansions,
          sourceGroupNodes,
          // Highways is a visual transform over exact wires. Preparing that substrate once per
          // structural scene lets selection unspool its strands at paint time, just like the Map.
          directDependencies: true,
          visibleIds: state.review !== null && state.reviewDiffOnly
            ? reviewDiffVisibleIds(index, state.reviewAffectedIds, explicitRootIds)
            : undefined,
        }, minimalArrange, hidden, surface.relations);
        if (minimalLayoutSeq !== sequence) {
          return; // a newer build/promote/demote/reset/re-arrange superseded this one.
        }
        set({
          minimalRfNodes: layout.nodes,
          minimalRfEdges: layout.edges,
          minimalLayoutStatus: "ready",
          minimalLayoutActivity: null,
        });
        if (get().review !== null) {
          performanceMark("meridian:first-actionable-canvas", {
            nodes: layout.nodes.length,
            edges: layout.edges.length,
          });
          scheduleProgressiveSymbolIndex();
          scheduleProgressiveLookahead();
        }
      } catch (error) {
        if (minimalLayoutSeq === sequence) {
          console.error("[meridian] Minimal graph layout failed.", error);
          set({ minimalLayoutStatus: "error", minimalLayoutActivity: null });
        }
      }
    },

    // Flip one Module-map node in/out of the selection WITHOUT touching the rest — the ctrl/cmd+click
    // gesture that accumulates a multi-selection. Paint-only, like selectModule.
    toggleModuleSelect(id) {
      const state = get();
      if (state.review !== null && state.minimalSeedIds.length > 0 && state.flowSelection !== null && state.reviewFlowBaseline !== null) {
        const flows = (state.artifact.extensions?.logicFlow ?? {}) as unknown as LogicFlows;
        if (relatedNodeIds(state.index, flows, state.flowSelection).has(id)) {
          get().selectFlowPaneTarget(state.logicSelected === id ? null : id);
          return;
        }
        // Multi-select cannot coexist with the single-node flow inspection contract. Restore the
        // pre-flow selection first, then apply the reader's ordinary ctrl/cmd toggle to that set.
        get().selectFlowEntry(null);
        set({
          moduleSelected: withToggled(get().moduleSelected, id),
          reviewSelectedId: null,
          reviewLitNodeIds: null,
        });
        return;
      }
      set({ moduleSelected: withToggled(get().moduleSelected, id) });
    },

    // Scope the Service lens to the current anchors' owning cluster(s) plus every cluster coupled
    // to them in EITHER direction (1-hop). Enters the lens DIRECTLY — going through setViewMode
    // would clear the very scope this is setting — so it runs the shared lens transition itself
    // (clear-then-set). The reveal seeds the owning frames open + anchors selected.
    openServiceScope() {
      const { index, viewMode, moduleExpanded, serviceGroupingMode, serviceGroupingTargetSize } = get();
      // ONE anchors→clusters resolution feeds both the scope's leads and the reveal, so they can
      // never disagree about which anchors resolve (they read the same cached clustering too).
      const resolution = resolveServiceAnchors(
        anchorNodeIds(get()),
        index,
        serviceGroupingMode,
        serviceGroupingTargetSize,
      );
      if (resolution === null) {
        return; // nothing anchored resolves to a cluster — there is no scope to open.
      }
      if (!guardReviewLineComposerTransition(() => get().openServiceScope())) {
        return;
      }
      if (!beginLensTransition(get, set, () => get().openServiceScope())) return;
      // Scoping from WITHIN the call lens narrows the canvas the reader is already on, so their
      // open frames must survive: UNION the reveal's expansion into the current one. From any
      // other lens this is a lens switch, where the reveal REPLACES the expansion (the outgoing
      // lens's expansion ids mean nothing on the incoming surface).
      const revealExpanded =
        viewMode === "call"
          ? new Set([...moduleExpanded, ...resolution.reveal.moduleExpanded])
          : resolution.reveal.moduleExpanded;
      set({
        viewMode: "call",
        serviceScope: serviceScopeFor(resolution.owningLeads, index),
        moduleRfNodes: [],
        moduleRfEdges: [],
        moduleSemanticLayers: [],
        moduleEffectiveFocus: null,
        ...resolution.reveal,
        moduleExpanded: revealExpanded,
      });
      void get().moduleRelayout({ label: "Opening scoped service graph…" });
    },

    clearServiceScope() {
      if (get().serviceScope === null) {
        return;
      }
      set({ serviceScope: null, moduleGhostInspection: null });
      void get().moduleRelayout({ label: "Returning to all services…" });
    },

    setServiceGroupingMode(mode) {
      const state = get();
      if (state.serviceGroupingMode === mode) {
        return;
      }
      const keepReal = (id: string) => !isServiceDomainId(id);
      set({
        serviceGroupingMode: mode,
        // Synthetic parents are mode-specific. Preserve real service/code exploration while
        // removing only the stale parent ids from the prior partition.
        moduleFocus: state.moduleFocus !== null && isServiceDomainId(state.moduleFocus)
          ? null
          : state.moduleFocus,
        moduleEffectiveFocus: state.moduleEffectiveFocus !== null && isServiceDomainId(state.moduleEffectiveFocus)
          ? null
          : state.moduleEffectiveFocus,
        moduleExpanded: new Set([...state.moduleExpanded].filter(keepReal)),
        moduleSelected: new Set([...state.moduleSelected].filter(keepReal)),
      });
      void get().moduleRelayout({
        label: `Grouping services by ${serviceGroupingLabel(mode)}…`,
        detail: serviceGroupingUsesTarget(mode) ? `Target ${state.serviceGroupingTargetSize}` : undefined,
      });
    },

    setServiceGroupingTargetSize(size) {
      const state = get();
      if (!isServiceGroupingTargetSize(size) || state.serviceGroupingTargetSize === size) {
        return;
      }
      const keepReal = (id: string) => !isServiceDomainId(id);
      set({
        serviceGroupingTargetSize: size,
        // A new target can produce different synthetic parents. Retain the reader's exploration of
        // real service/code nodes while discarding parent ids from the previous partition.
        moduleFocus: state.moduleFocus !== null && isServiceDomainId(state.moduleFocus)
          ? null
          : state.moduleFocus,
        moduleEffectiveFocus: state.moduleEffectiveFocus !== null && isServiceDomainId(state.moduleEffectiveFocus)
          ? null
          : state.moduleEffectiveFocus,
        moduleExpanded: new Set([...state.moduleExpanded].filter(keepReal)),
        moduleSelected: new Set([...state.moduleSelected].filter(keepReal)),
      });
      void get().moduleRelayout({
        label: `Changing cluster target to ${size}…`,
        detail: serviceGroupingLabel(state.serviceGroupingMode),
      });
    },

    setServiceGroupingLabelMode(mode) {
      const state = get();
      if (state.serviceGroupingLabelMode === mode) {
        return;
      }
      set({ serviceGroupingLabelMode: mode });
      void get().moduleRelayout({
        label: mode === "single" ? "Showing single cluster labels…" : "Showing multi-part cluster labels…",
      });
    },

    // Paint-only: light a set of graph node ids (from a panel hover); null clears back to full strength.
    setReviewLit(ids) {
      set({ reviewLitNodeIds: ids });
    },

    setReviewFilesSort(sort) {
      set({ reviewFilesSort: sort });
    },

    // Select a review block (from the panel); if a rollup hides it, focus that owning container,
    // then light and CENTER the exact target once the child scene has laid out.
    selectReviewNode(id) {
      const before = get();
      const flowBaseline = before.reviewFlowBaseline;
      if (flowBaseline === null && id !== null) {
        const rootId = hiddenReviewRollupFor(before, id);
        if (rootId !== null) {
          focusReviewSubgraph(rootId, { selectedId: id, litNodeIds: new Set([id]) }, () => get().selectReviewNode(id));
          return;
        }
        if (revealWithinFocusedReviewSubgraph(
          before,
          { selectedId: id, litNodeIds: new Set([id]) },
          () => get().selectReviewNode(id),
        )) {
          return;
        }
      }
      const moduleSelected = id === null ? new Set<string>() : new Set([id]);
      set({
        ...(flowBaseline ?? {}),
        reviewSelectedId: id,
        reviewLitNodeIds: id === null ? null : new Set([id]),
        moduleSelected,
        // A file/unit click switches back to graph review; the bottom split belongs to a selected
        // logic flow and must not linger with a now-unrelated pane selection.
        flowSelection: null,
        reviewFlowExplicitView: null,
        flowPaneExpansionOverrides: new Set<string>(),
        flowPaneCollapsedEdges: new Set<string>(),
        logicSelected: null,
        flowPaneRfNodes: [],
        flowPaneRfEdges: [],
        flowPaneLayoutStatus: "idle",
        reviewFlowBaseline: null,
      });
      const recenter = () => {
        if (id !== null && get().reviewSelectedId === id) {
          set({ recenterSeq: get().recenterSeq + 1, recenterTargetId: null });
        }
      };
      if (flowBaseline !== null) {
        // Restore the exact pre-flow review first. If that scene rolls the requested unit into a
        // package, replaying the selection below will focus that now-settled owning container.
        void requestMinimalRelayout({ label: "Returning to changed node review…" }).then(() => {
          if (id !== null && get().reviewSelectedId === id) {
            get().selectReviewNode(id);
          }
        });
        return;
      }
      recenter();
    },

    // The file row's click: focus an owning rollup when necessary, select the exact file frame, light
    // its touched units amber-strong, and center the viewport. Inert for files with no graph module.
    focusReviewFile(path) {
      const state = get();
      const file = state.reviewFiles.find((candidate) => candidate.path === path);
      if (!file || file.moduleId === null) {
        return;
      }
      const flowBaseline = state.reviewFlowBaseline;
      // A file click owns both levels of its dependency story. Touched units light their exact
      // callable/type relationships, while the module seed retains relationships the extractor
      // honestly attributes to top-level syntax (for example `new Service()` in a default
      // parameter, top-level initializers, and interface-field type references). Replacing
      // the module with only its touched units makes those valid boundary ghosts disappear in the
      // shared paint pruner even though the file card remains the literal selection.
      const lit = new Set([file.moduleId, ...file.units.map((unit) => unit.nodeId)]);
      if (flowBaseline === null) {
        const rootId = hiddenReviewRollupFor(state, file.moduleId);
        if (rootId !== null) {
          focusReviewSubgraph(
            rootId,
            { selectedId: file.moduleId, litNodeIds: lit },
            () => get().focusReviewFile(path),
          );
          return;
        }
        if (revealWithinFocusedReviewSubgraph(
          state,
          { selectedId: file.moduleId, litNodeIds: lit },
          () => get().focusReviewFile(path),
        )) {
          return;
        }
      }
      const moduleSelected = new Set([file.moduleId]);
      set({
        ...(flowBaseline ?? {}),
        moduleSelected,
        reviewSelectedId: file.moduleId,
        reviewLitNodeIds: lit,
        flowSelection: null,
        reviewFlowExplicitView: null,
        flowPaneExpansionOverrides: new Set<string>(),
        flowPaneCollapsedEdges: new Set<string>(),
        logicSelected: null,
        flowPaneRfNodes: [],
        flowPaneRfEdges: [],
        flowPaneLayoutStatus: "idle",
        reviewFlowBaseline: null,
      });
      const recenter = () => {
        if (get().reviewSelectedId === file.moduleId) {
          set({ recenterSeq: get().recenterSeq + 1, recenterTargetId: null });
        }
      };
      if (flowBaseline !== null) {
        // As with a unit click, settle the pre-flow graph before deciding whether its owning rollup
        // must become an exact-file focused subgraph.
        void requestMinimalRelayout({ label: "Returning to changed file review…" }).then(() => {
          if (get().reviewSelectedId === file.moduleId) {
            get().focusReviewFile(path);
          }
        });
        return;
      }
      recenter();
    },

    // Isolate one change group on the Map: re-seed the minimal overlay with ONLY that group's module
    // ids (null restores the full review seed set), then relayout through the shared minimal machinery
    // — a pure seed/member swap, no dimming and no bespoke graph. Mirrors applyPrReviewToMap's reset
    // of the minimal fields exactly so the overlay rebuilds identically.
    selectReviewGroup(groupId) {
      const {
        review,
        reviewFiles,
        reviewGroups,
        reviewActiveGroupId,
        reviewPathScope,
        reviewFocusedSubgraph,
        reviewBaseNodeIds,
        reviewDeletedNodeIds,
        index,
      } = get();
      if (
        !review
        || !reviewGroups
        || (groupId === reviewActiveGroupId && reviewPathScope === null && reviewFocusedSubgraph === null)
      ) {
        return;
      }
      if (!guardReviewLineComposerTransition(() => get().selectReviewGroup(groupId))) {
        return;
      }
      // An unknown id falls back to "All" — a stale group id can never strand the reader on an empty Map.
      const group = groupId === null ? null : reviewGroups.groups.find((candidate) => candidate.id === groupId) ?? null;
      const allowed = group === null ? null : new Set(group.moduleIds);
      // The threshold belongs to THIS isolated set, not the PR as a whole: an eight-file group stays
      // eight file cards even when the full review was large enough to roll up.
      const projection = deriveReviewScopeGraph(index, reviewFiles, allowed, null, {
        baseNodeIds: reviewBaseNodeIds,
        deletedNodeIds: reviewDeletedNodeIds,
      });
      invalidateMinimalLayout();
      set({
        reviewActiveGroupId: group ? group.id : null,
        reviewPathScope: null,
        reviewFocusedSubgraph: null,
        minimalGraphHistory: [],
        minimalView: "graph",
        minimalShowGhostNodes: false,
        minimalShowNonDiffGhostNodes: true,
        minimalCodebaseExpansionOverrides: new Map<string, boolean>(),
        reviewSelectedId: null,
        reviewLitNodeIds: null,
        moduleSelected: new Set<string>(),
        flowSelection: null,
        reviewFlowExplicitView: null,
        flowPaneExpansionOverrides: new Set<string>(),
        flowPaneCollapsedEdges: new Set<string>(),
        logicSelected: null,
        flowPaneRfNodes: [],
        flowPaneRfEdges: [],
        flowPaneLayoutStatus: "idle",
        reviewFlowBaseline: null,
        minimalSeedIds: projection.seeds,
        minimalMemberIds: [...projection.seeds],
        minimalRollups: rollupsRecord(projection.rolledUp),
        moduleExpanded: projection.expanded,
        minimalBasePositions: {},
        minimalArrange: false,
        minimalRfNodes: [],
        minimalRfEdges: [],
        minimalLayoutStatus: projection.seeds.length > 0 ? "laying-out" : "idle",
        minimalLayoutActivity: projection.seeds.length > 0 ? { label: "Opening review group…" } : null,
      });
      void requestMinimalRelayout({ label: group ? `Opening ${group.label}…` : "Opening all review groups…" });
    },

    // A path scope is an additional, segment-safe filter over the active connectivity group. It
    // reuses the exact group-isolation machinery so graph, files, and flows remain one coherent
    // review lens. Empty/unmatched input cannot close the overlay and strand the review panel.
    selectReviewPathScope(path) {
      const state = get();
      if (state.review === null) {
        return;
      }
      const normalized = path === null ? null : normalizeReviewPathScope(path) || null;
      if (normalized === state.reviewPathScope && state.reviewFocusedSubgraph === null) {
        return;
      }
      const activeGroup = state.reviewActiveGroupId === null
        ? null
        : state.reviewGroups?.groups.find((group) => group.id === state.reviewActiveGroupId) ?? null;
      const allowed = activeGroup === null ? null : new Set(activeGroup.moduleIds);
      const projection = deriveReviewScopeGraph(state.index, state.reviewFiles, allowed, normalized, {
        baseNodeIds: state.reviewBaseNodeIds,
        deletedNodeIds: state.reviewDeletedNodeIds,
      });
      if (normalized !== null && projection.seeds.length === 0) {
        return;
      }
      if (!guardReviewLineComposerTransition(() => get().selectReviewPathScope(path))) {
        return;
      }
      invalidateMinimalLayout();
      set({
        reviewPathScope: normalized,
        reviewFocusedSubgraph: null,
        minimalGraphHistory: [],
        minimalView: "graph",
        minimalShowGhostNodes: false,
        minimalShowNonDiffGhostNodes: true,
        minimalCodebaseExpansionOverrides: new Map<string, boolean>(),
        reviewSelectedId: null,
        reviewLitNodeIds: null,
        moduleSelected: new Set<string>(),
        flowSelection: null,
        reviewFlowExplicitView: null,
        flowPaneExpansionOverrides: new Set<string>(),
        flowPaneCollapsedEdges: new Set<string>(),
        logicSelected: null,
        flowPaneRfNodes: [],
        flowPaneRfEdges: [],
        flowPaneLayoutStatus: "idle",
        reviewFlowBaseline: null,
        minimalSeedIds: projection.seeds,
        minimalMemberIds: [...projection.seeds],
        minimalRollups: rollupsRecord(projection.rolledUp),
        moduleExpanded: projection.expanded,
        minimalBasePositions: {},
        minimalArrange: false,
        minimalRfNodes: [],
        minimalRfEdges: [],
        minimalLayoutStatus: projection.seeds.length > 0 ? "laying-out" : "idle",
        minimalLayoutActivity: projection.seeds.length > 0 ? { label: "Filtering review path…" } : null,
      });
      void get().minimalRelayout({ label: normalized === null ? "Opening review group…" : `Opening ${normalized}…` });
    },

    // A review container focus is a child surface of the current PR graph, not a moduleFocus dive.
    // Exact file seeds deliberately bypass rollupSeeds so opening a large `fs` package reveals its
    // files rather than reproducing the same summary card. Every open pushes the immediate scene,
    // so package focus and ordinary selection extraction share unlimited stepwise Back navigation.
    openReviewSubgraph(rootId) {
      focusReviewSubgraph(rootId, null, () => get().openReviewSubgraph(rootId));
    },

    // Back from a focused container is intentionally synchronous: reuse the already-laid outer
    // nodes/edges and its exact curation instead of asking ELK to approximate the old PR graph.
    closeReviewSubgraph() {
      if (get().reviewFocusedSubgraph === null) {
        return;
      }
      get().backMinimalGraph();
    },

    // Toggle a flow's reviewed tick and persist the whole record under the reviewKey.
    toggleReviewTick(flowId) {
      const { review, reviewTicks } = get();
      const row = review?.rows.find((candidate) => candidate.memberFlowIds.includes(flowId));
      if (!review || !row) {
        return;
      }
      set({ reviewTicks: applyTick(reviewTicks, row, "toggle", new Date().toISOString()) });
      persistReviewProgress(get());
    },

    // Reset every reviewed tick (flows, units, files) but KEEP the draft comments — progress is
    // disposable, written words are not.
    resetReviewTicks() {
      const current = get();
      if (!current.review || viewedGesturesBlocked(current)) {
        return;
      }
      const changedPaths = current.reviewFileViewedStates === null
        ? []
        : Object.entries(current.reviewFileViewedStates)
            .filter(([, state]) => state !== "UNVIEWED")
            .map(([path]) => path);
      const nextGithubStates = current.reviewFileViewedStates === null
        ? null
        : Object.fromEntries(
            Object.keys(current.reviewFileViewedStates).map((path) => [path, "UNVIEWED" as const]),
          );
      const fallbackViewer = current.prReviewed === null
        ? undefined
        : localViewedFallbackViewers.get(current.prReviewed);
      let nextFileTicks: Record<string, ReviewTick> = {};
      if (nextGithubStates === null) {
        const at = new Date().toISOString();
        for (const file of current.reviewFiles) {
          if (fileViewState(
            file,
            current.reviewUnitTicks,
            current.reviewFileTicks,
            null,
            {
              viewerId: current.reviewViewedFilesViewerId,
              headSha: current.prReviewRevision?.headSha,
            },
          ) !== "done") continue;
          const priorTick = tickForFile(file, current.reviewFileTicks);
          const priorViewer = priorTick?.viewerId !== undefined && priorTick.viewerLogin !== undefined
            ? { id: priorTick.viewerId, login: priorTick.viewerLogin }
            : undefined;
          const intentViewer = fallbackViewer ?? priorViewer;
          if (intentViewer === undefined) continue;
          const intentHeadSha = current.prReviewRevision?.headSha ?? priorTick?.headSha;
          setReviewTick(nextFileTicks, file.path, {
            at,
            fingerprint: file.fingerprint,
            ...(file.address ? { address: file.address } : {}),
            viewerId: intentViewer.id,
            viewerLogin: intentViewer.login,
            viewed: false,
            ...(intentHeadSha ? { headSha: intentHeadSha } : {}),
          });
        }
        for (const [path, tick] of Object.entries(current.reviewFileTicks)) {
          if (
            tick.viewerId === undefined
            || tick.viewerLogin === undefined
            || Object.hasOwn(nextFileTicks, path)
          ) continue;
          setReviewTick(nextFileTicks, path, { ...tick, at, viewed: false });
        }
      }
      set({
        reviewTicks: {},
        reviewUnitTicks: {},
        reviewFileTicks: nextFileTicks,
        reviewFileViewedStates: nextGithubStates,
      });
      persistReviewProgress(get());
      const expectedHeadSha = current.prReviewRevision?.headSha;
      const viewerId = current.reviewViewedFilesViewerId;
      const viewerLogin = current.reviewViewedFilesViewerLogin;
      if (
        nextGithubStates !== null
        && current.prReviewed !== null
        && typeof expectedHeadSha === "string"
        && viewerId !== null
        && viewerLogin !== null
      ) {
        enqueueViewedWrites(
          current.prReviewed,
          changedPaths.map((path) => ({ path, viewed: false })),
          expectedHeadSha,
          viewerId,
          viewerLogin,
        );
      }
    },

    // A unit gesture stays local to that declaration. GitHub changes only when all units in the
    // owning file cross the viewed/not-viewed boundary.
    toggleReviewUnitTick(nodeId) {
      toggleReviewUnits([nodeId]);
    },

    // Structural cards aggregate and toggle exactly their represented changed leaves.
    toggleReviewUnitsViewed(nodeIds) {
      toggleReviewUnits(nodeIds);
    },

    // The per-file checkbox is the same atomic transition GitHub exposes.
    toggleReviewFileViewed(path) {
      const file = get().reviewFiles.find((candidate) => candidate.path === path);
      if (file) toggleWholeReviewFiles([file]);
    },

    // Folder markers bulk-toggle exactly the changed descendant files represented by that folder.
    toggleReviewFilesViewed(paths) {
      const selectedPaths = new Set(paths);
      toggleWholeReviewFiles(get().reviewFiles.filter((candidate) => selectedPaths.has(candidate.path)));
    },

    async retryReviewViewedFiles() {
      const current = get();
      if (current.prReviewed === null || current.prReviewStale) return;
      if (current.reviewViewedFilesError !== null) {
        await loadViewedFiles(current.prReviewed);
        return;
      }
      const retryPaths = Object.keys(current.reviewViewedFileSyncErrors);
      await waitForViewedFileSettlements(current.prReviewed);
      if (!sameActiveReview(current.prReviewed) || get().prReviewStale) return;
      const retryable = retryPaths
        .flatMap((path) => {
          const key = viewedWriteKey(current.prReviewed!, path);
          const entry = viewedFileWrites.get(key);
          return entry === undefined ? [] : [{ key, entry }];
        });
      if (retryable.length > 0) {
        const pending = new Set(get().reviewViewedFileSyncPending);
        const errors = { ...get().reviewViewedFileSyncErrors };
        for (const { entry } of retryable) {
          pending.add(entry.path);
          delete errors[entry.path];
        }
        set({ reviewViewedFileSyncPending: pending, reviewViewedFileSyncErrors: errors });
      }
      startViewedWriteBatch(retryable);
    },

    // The line composer is one session-only editing surface shared by hover, inline, modal, and
    // edge source hosts. Capturing the review revision prevents a remounted view from silently
    // retargeting unfinished prose after the PR head changes.
    openReviewLineComposer(path, line, side = "RIGHT") {
      const state = get();
      if (
        !state.review
        || state.prReviewRefreshing
        || state.prReviewStatus === "preparing"
        || !Number.isInteger(line)
        || line < 1
      ) {
        return;
      }
      const target = {
        reviewKey: state.review.context.reviewKey,
        lineRevision: prReviewRevisionKey(state.prReviewRevision),
        path,
        line,
        side,
      };
      const current = state.reviewLineComposer;
      if (matchesReviewLineComposerTarget(current, target)) {
        // Re-selecting the current line is an explicit return to the draft, so it also cancels a
        // previously queued source transition and leaves confirmation mode.
        pendingReviewLineComposerTransition = null;
        set({ reviewLineComposer: openReviewLineComposerState(current, target) });
        return;
      }
      if (!guardReviewLineComposerTransition(() => get().openReviewLineComposer(path, line, side))) {
        return;
      }
      set({ reviewLineComposer: openReviewLineComposerState(get().reviewLineComposer, target) });
    },

    setReviewLineComposerBody(body) {
      const current = get().reviewLineComposer;
      if (current === null) return;
      const next = setReviewLineComposerBodyState(current, body);
      if (next !== current) {
        set({ reviewLineComposer: next });
      }
    },

    requestReviewLineComposerDismiss() {
      // An explicit Cancel/host-close supersedes a queued source switch. The host-level guard owns
      // its own replay callback and will close only after Discard.
      pendingReviewLineComposerTransition = null;
      const current = get().reviewLineComposer;
      const result = requestReviewLineComposerDismissState(current);
      if (result.composer !== current) {
        set({ reviewLineComposer: result.composer });
      }
      return result.allowed;
    },

    keepEditingReviewLineComposer() {
      pendingReviewLineComposerTransition = null;
      const current = get().reviewLineComposer;
      if (current === null) return;
      set({ reviewLineComposer: keepEditingReviewLineComposerState(current) });
    },

    discardReviewLineComposer() {
      const transition = pendingReviewLineComposerTransition;
      pendingReviewLineComposerTransition = null;
      set({ reviewLineComposer: discardReviewLineComposerState(get().reviewLineComposer) });
      transition?.();
    },

    // Add a draft comment on a file (nodeId null), touched unit, or explicit diff line. Drafts
    // persist under the reviewKey until submitted or deleted.
    addReviewComment(path, nodeId, body, line = null, side = line === null ? null : "RIGHT") {
      const { review, reviewComments, index, prReviewRevision } = get();
      const trimmed = body.trim();
      if (!review || trimmed.length === 0) {
        return;
      }
      const lineRevision = line === null ? null : prReviewRevisionKey(prReviewRevision);
      const lineSide = line === null ? null : side === "LEFT" ? "LEFT" : "RIGHT";
      const comment: ReviewComment = {
        id: newCommentId(),
        path,
        nodeId,
        line,
        side: lineSide,
        ...(lineRevision === null ? {} : { lineRevision }),
        anchorLabel: line === null
          ? (nodeId === null ? null : (index.nodesById.get(nodeId)?.displayName ?? null))
          : `L${line}${lineSide === "LEFT" ? " · base" : ""}`,
        body: trimmed,
        at: new Date().toISOString(),
      };
      // A fresh draft supersedes the last submit's outcome banners (link and error alike).
      set({ reviewComments: [...reviewComments, comment], reviewSubmittedUrl: null, reviewSubmitError: null, reviewSubmitNotice: null });
      persistReviewProgress(get());
    },

    updateReviewComment(id, body) {
      const state = get();
      const trimmed = body.trim();
      if (!state.review || trimmed.length === 0 || !state.reviewComments.some((comment) => comment.id === id)) {
        return;
      }
      // Replace only the prose. The captured anchor, revision provenance, id, and timestamp remain
      // immutable so editing a draft cannot silently retarget it or make an old line look fresh.
      set({
        reviewComments: state.reviewComments.map((comment) => comment.id === id ? { ...comment, body: trimmed } : comment),
        reviewSubmittedUrl: null,
        reviewSubmitError: null,
        reviewSubmitNotice: null,
      });
      persistReviewProgress(get());
    },

    deleteReviewComment(id) {
      if (!get().review) {
        return;
      }
      set({ reviewComments: get().reviewComments.filter((comment) => comment.id !== id), reviewSubmittedUrl: null, reviewSubmitError: null, reviewSubmitNotice: null });
      persistReviewProgress(get());
    },

    setReviewFlowSplitView(view) {
      const state = get();
      writeReviewPreferences({
        version: 5,
        flowSplitView: view,
        openFlowSplitOnSelect: state.reviewOpenFlowSplitOnSelect,
        codePreviewTrigger: state.reviewCodePreviewTrigger,
        hideAddedSourceCommentDiffs: state.reviewHideAddedSourceCommentDiffs,
        excludeFormatOnlyChanges: state.reviewExcludeFormatOnlyChanges,
      });
      const reviewFlowOpen = state.review !== null
        && state.minimalSeedIds.length > 0
        && state.flowSelection !== null
        && state.reviewFlowBaseline !== null
        && (state.reviewOpenFlowSplitOnSelect || state.reviewFlowExplicitView !== null);
      set({
        reviewFlowSplitView: view,
        reviewFlowExplicitView: state.reviewFlowExplicitView === null ? null : view,
      });
      if (!reviewFlowOpen) {
        return;
      }
      // A concrete synthetic run always uses the occurrence graph; remember the reader's static
      // projection preference for when they return, but do not discard the active execution.
      if (state.flowPaneOrigin === "synthetic") {
        return;
      }
      if (view !== "graph") {
        flowPaneLayoutSeq += 1;
        set({ flowPaneRfNodes: [], flowPaneRfEdges: [], flowPaneLayoutStatus: "idle" });
        return;
      }
      void get().flowPaneRelayout();
    },

    setReviewOpenFlowSplitOnSelect(open) {
      const state = get();
      if (state.reviewOpenFlowSplitOnSelect === open) {
        return;
      }
      writeReviewPreferences({
        version: 5,
        flowSplitView: state.reviewFlowSplitView,
        openFlowSplitOnSelect: open,
        codePreviewTrigger: state.reviewCodePreviewTrigger,
        hideAddedSourceCommentDiffs: state.reviewHideAddedSourceCommentDiffs,
        excludeFormatOnlyChanges: state.reviewExcludeFormatOnlyChanges,
      });
      const reviewFlowSelected = state.review !== null
        && state.minimalSeedIds.length > 0
        && state.flowSelection !== null
        && state.reviewFlowBaseline !== null;
      set({
        reviewOpenFlowSplitOnSelect: open,
        ...(reviewFlowSelected ? { recenterSeq: state.recenterSeq + 1, recenterTargetId: null } : {}),
      });
      if (!reviewFlowSelected) {
        return;
      }
      const effectiveView = state.reviewFlowExplicitView ?? state.reviewFlowSplitView;
      const executionGraph = state.flowPaneOrigin === "synthetic" || effectiveView === "graph";
      const splitOpen = open || state.reviewFlowExplicitView !== null;
      if (!splitOpen || !executionGraph) {
        flowPaneLayoutSeq += 1;
        set({ flowPaneRfNodes: [], flowPaneRfEdges: [], flowPaneLayoutStatus: "idle" });
        return;
      }
      void get().flowPaneRelayout();
    },

    setReviewCodePreviewTrigger(trigger) {
      const state = get();
      if (state.reviewCodePreviewTrigger === trigger) {
        return;
      }
      writeReviewPreferences({
        version: 5,
        flowSplitView: state.reviewFlowSplitView,
        openFlowSplitOnSelect: state.reviewOpenFlowSplitOnSelect,
        codePreviewTrigger: trigger,
        hideAddedSourceCommentDiffs: state.reviewHideAddedSourceCommentDiffs,
        excludeFormatOnlyChanges: state.reviewExcludeFormatOnlyChanges,
      });
      set({ reviewCodePreviewTrigger: trigger });
    },

    toggleReviewCodePreview() {
      set((state) => ({ reviewCodePreviewEnabled: !state.reviewCodePreviewEnabled }));
    },

    setReviewHideAddedSourceCommentDiffs(hide) {
      if (!guardReviewLineComposerTransition(() => get().setReviewHideAddedSourceCommentDiffs(hide))) {
        return;
      }
      let state = get();
      if (state.reviewHideAddedSourceCommentDiffs === hide) {
        return;
      }
      // Artifact-carried reviews do not replace the whole workspace during reprojection. Leave an
      // active flow first so its baseline and flow pane cannot retain nodes the filter removes.
      if (
        state.prReviewed === null
        && state.review !== null
        && state.flowSelection !== null
        && state.reviewFlowBaseline !== null
      ) {
        state.selectFlowEntry(null);
        state = get();
      }
      writeReviewPreferences({
        version: 5,
        flowSplitView: state.reviewFlowSplitView,
        openFlowSplitOnSelect: state.reviewOpenFlowSplitOnSelect,
        codePreviewTrigger: state.reviewCodePreviewTrigger,
        hideAddedSourceCommentDiffs: hide,
        excludeFormatOnlyChanges: state.reviewExcludeFormatOnlyChanges,
      });
      set({ reviewHideAddedSourceCommentDiffs: hide });
      const current = get();
      // This preference defines the visible review transaction, not just source-row paint. Reuse
      // the same lossless reprojection path as Tests so files, affected nodes, flows, groups, and
      // graph seeds change atomically while the raw PR context remains available for toggle-back.
      if (current.prReviewed !== null && current.minimalSeedIds.length > 0) {
        let reprojected: boolean;
        if (
          current.flowSelection === null
          || current.minimalGraphHistory.length > 0
          || current.reviewActiveGroupId !== null
          || current.reviewPathScope !== null
          || current.reviewFocusedSubgraph !== null
          || hasReusableReviewProjectionFrame(current)
        ) {
          reprojected = reprojectLivePrReview(
            hide ? "Hiding source-comment-only changes…" : "Restoring source comments…",
            true,
          );
        } else {
          reprojected = applyPrReviewToMap(
            get,
            set,
            prFilesUrl,
            invalidateMinimalLayout,
            invalidateModuleLayout,
            invalidateArtifactCaches,
            { reprojecting: true, preserveReviewSelection: true },
          );
        }
        const projected = get();
        if (
          reprojected
          && !hide
          && projected.reviewFileViewedStates !== null
          && !projected.prReviewStale
        ) {
          // A hidden legacy file can acquire a whole-file viewed intent only when it re-enters.
          // Reconcile that intent against the canonical GitHub snapshot just like Tests restoration.
          queueMicrotask(() => void loadViewedFiles(current.prReviewed!));
        }
        return;
      }
      reprojectArtifactReview(current.showTests);
    },

    setReviewExcludeFormatOnlyChanges(exclude) {
      const state = get();
      if (state.reviewExcludeFormatOnlyChanges === exclude) {
        return;
      }
      if (!guardReviewLineComposerTransition(() => get().setReviewExcludeFormatOnlyChanges(exclude))) {
        return;
      }
      writeReviewPreferences({
        version: 5,
        flowSplitView: state.reviewFlowSplitView,
        openFlowSplitOnSelect: state.reviewOpenFlowSplitOnSelect,
        codePreviewTrigger: state.reviewCodePreviewTrigger,
        hideAddedSourceCommentDiffs: state.reviewHideAddedSourceCommentDiffs,
        excludeFormatOnlyChanges: exclude,
      });
      set({ reviewExcludeFormatOnlyChanges: exclude });
      if (state.review === null) {
        return;
      }
      if (state.prReviewed !== null && state.minimalSeedIds.length > 0) {
        // A content-ownership change invalidates every nested review frame. Rebuild the root from
        // the immutable raw PR facts instead of preserving a selection the new proof may remove.
        applyPrReviewToMap(
          get,
          set,
          prFilesUrl,
          invalidateMinimalLayout,
          invalidateModuleLayout,
          invalidateArtifactCaches,
          { reprojecting: true },
        );
        return;
      }
      const previousAffectedIds = new Set(state.reviewAffectedIds);
      reprojectArtifactReview(state.showTests);
      const projected = get();
      const removedAffectedIds = new Set(
        [...previousAffectedIds].filter((id) => !projected.reviewAffectedIds.has(id)),
      );
      if (
        projected.reviewFlowBaseline !== null
        && projected.flowSelection !== null
      ) {
        // Artifact reviews do not pass through applyPrReviewToMap's wholesale workspace reset. Close
        // the active review flow through its normal restoration path so its captured Map baseline
        // and every pane-owned selection/expansion/layout are invalidated together.
        projected.selectFlowEntry(null);
      }
      const restored = get();
      const reviewLitNodeIds = restored.reviewLitNodeIds === null
        ? null
        : new Set([...restored.reviewLitNodeIds].filter((id) => !removedAffectedIds.has(id)));
      set({
        moduleSelected: new Set(
          [...restored.moduleSelected].filter((id) => !removedAffectedIds.has(id)),
        ),
        reviewSelectedId: restored.reviewSelectedId !== null
          && removedAffectedIds.has(restored.reviewSelectedId)
          ? null
          : restored.reviewSelectedId,
        reviewLitNodeIds: reviewLitNodeIds !== null && reviewLitNodeIds.size > 0
          ? reviewLitNodeIds
          : null,
        logicSelected: restored.logicSelected !== null
          && removedAffectedIds.has(restored.logicSelected)
          ? null
          : restored.logicSelected,
      });
      if (moduleSurfaceSpec(restored.viewMode) !== null) {
        void get().moduleRelayout({
          label: exclude ? "Excluding formatting-only changes…" : "Including formatting-only changes…",
        });
      }
      if (get().minimalSeedIds.length > 0) {
        void requestMinimalRelayout({
          label: exclude ? "Excluding formatting-only changes…" : "Including formatting-only changes…",
        });
      }
      if (get().flowSelection !== null) {
        void get().flowPaneRelayout();
      }
      if (get().logicRoot !== null) {
        void get().logicRelayout({
          label: exclude ? "Excluding formatting-only changes…" : "Including formatting-only changes…",
        });
      }
    },

    toggleReviewDiffOnly() {
      const state = get();
      if (state.review === null) {
        return;
      }
      const reviewDiffOnly = !state.reviewDiffOnly;
      const visible = reviewDiffOnly
        ? reviewDiffVisibleIds(state.index, state.reviewAffectedIds)
        : null;
      const remainsVisible = (id: string | null) => id === null
        || visible === null
        || idPassesReviewDiffProjection(state, id, visible);
      const reviewLitNodeIds = state.reviewLitNodeIds === null || visible === null
        ? state.reviewLitNodeIds
        : new Set([...state.reviewLitNodeIds].filter((id) => idPassesReviewDiffProjection(state, id, visible)));
      set({
        reviewDiffOnly,
        moduleSelected: visible === null
          ? state.moduleSelected
          : new Set([...state.moduleSelected].filter((id) => idPassesReviewDiffProjection(state, id, visible))),
        reviewSelectedId: remainsVisible(state.reviewSelectedId) ? state.reviewSelectedId : null,
        reviewLitNodeIds: reviewLitNodeIds !== null && reviewLitNodeIds.size === 0 ? null : reviewLitNodeIds,
        logicSelected: remainsVisible(state.logicSelected) ? state.logicSelected : null,
      });
      if (state.minimalMemberIds.length > 0) {
        void get().minimalRelayout({
          label: reviewDiffOnly ? "Hiding unchanged graph context…" : "Restoring graph context…",
        });
      }
    },

    toggleReviewPanel() {
      set({ reviewPanelHidden: !get().reviewPanelHidden });
    },

    toggleReviewCommentsVisible() {
      set({ reviewCommentsVisible: !get().reviewCommentsVisible });
    },

    setReviewCommentFilter(filter) {
      set({ reviewCommentFilter: filter, reviewCommentsVisible: true });
    },

    async submitReviewComments() {
      await get().submitReview("COMMENT");
    },

    // Submit one GitHub review containing every visible draft. Diff-safe drafts stay inline;
    // drafts without a valid line anchor become real file-level review comments. A stale review
    // with a known SHA remains pinned to that reviewed commit. Without a SHA, force file comments
    // so GitHub can never attach old coordinates to its implicit latest commit.
    // Only the drafts snapshotted here are cleared; comments added while the POST is in flight stay.
    async submitReview(event, body = "") {
      const {
        review,
        reviewComments,
        reviewFiles,
        reviewCommentRangesByFile,
        reviewDiffLinesByFile,
        prReviewed: prNumber,
        reviewSubmitStatus,
        prReviewStale,
        prReviewRefreshing,
        prReviewStatus,
        prReviewRevision: submittedRevision,
      } = get();
      const visibleComments = review === null
        ? []
        : reviewComments.filter((comment) => reviewDraftIsVisible(comment, reviewFiles, review.context));
      const reviewBody = body.trim();
      if (
        !review
        || prNumber === null
        || (event === "COMMENT" && visibleComments.length === 0)
        || (event === "REQUEST_CHANGES" && reviewBody.length === 0)
        || reviewSubmitStatus === "submitting"
        || (prReviewStale && event !== "COMMENT")
        || prReviewRefreshing
        || prReviewStatus === "preparing"
      ) {
        return false;
      }
      // Drafts hidden by Tests or source-comment projection remain persisted and reappear when the
      // filter is restored; they must neither submit invisibly nor block the visible draft set.
      const forceFileComments = event === "COMMENT"
        && prReviewStale
        && submittedRevision?.headSha == null;
      const submission = buildReviewSubmission(
        visibleComments,
        reviewFiles,
        review.context,
        reviewCommentRangesByFile,
        { forceFileComments, diffLinesByFile: reviewDiffLinesByFile },
      );
      const submittedIds = new Set(visibleComments.map((comment) => comment.id));
      const submittedKey = review.context.reviewKey;
      set({ reviewSubmitStatus: "submitting", reviewSubmitError: null, reviewSubmitNotice: null });
      try {
        const response = await fetch(prReviewUrl, {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            number: prNumber,
            event,
            comments: submission.comments,
            fileComments: submission.fileComments,
            ...(submittedRevision?.headSha ? { commitId: submittedRevision.headSha } : {}),
            ...(event !== "COMMENT" && reviewBody ? { body: reviewBody } : {}),
          }),
        });
        if (!response.ok) {
          set({ reviewSubmitStatus: "idle", reviewSubmitError: await submitErrorMessage(response) });
          return false;
        }
        const data = (await response.json()) as { url?: string | null; forced?: boolean; pendingMerged?: boolean };
        const reviewSubmitDetails = [
          data.pendingMerged ? "An existing GitHub draft review was submitted first." : null,
          data.forced
            ? "GitHub could not anchor the inline batch, so those comments were submitted as file-level review comments."
            : submission.fileComments.length > 0
              ? `${submission.fileComments.length} ${submission.fileComments.length === 1 ? "comment was" : "comments were"} submitted as ${submission.fileComments.length === 1 ? "a file-level review comment" : "file-level review comments"}.`
              : null,
        ].filter((detail): detail is string => detail !== null);
        const reviewSubmitNotice = reviewSubmitDetails.length > 0 ? reviewSubmitDetails.join(" ") : null;
        // The review may have moved to another PR while awaiting; drop the SUBMITTED drafts from
        // the submitted key's storage either way, but only touch live state on the same review.
        // "" marks submitted-without-a-link, so the footer still confirms the submit happened.
        stripStoredComments(submittedKey, submittedIds);
        if (get().review?.context.reviewKey === submittedKey) {
          set({
            reviewSubmitStatus: "idle",
            reviewComments: get().reviewComments.filter((comment) => !submittedIds.has(comment.id)),
            reviewSubmittedUrl: data.url ?? "",
            reviewSubmitNotice,
          });
          // Any submitted inline drafts are now existing GitHub comments. Refresh that read model
          // so a successful canvas submission does not make them disappear until the next reload.
          // Submission success stands even if this secondary read fails.
          try {
            const discussionSequence = ++prDiscussionSeq;
            const discussion = await fetchPrDiscussion(prCommentsUrl, prNumber);
            const current = get();
            if (
              prDiscussionSeq === discussionSequence
              && current.prReviewed === prNumber
              && current.review?.context.reviewKey === submittedKey
              && current.prReviewRevision === submittedRevision
            ) {
              set({ prDiscussion: { comments: discussion.comments, reviews: discussion.reviews } });
            }
          } catch {
            console.warn("[meridian] Submitted review discussion could not be refreshed.");
          }
        } else {
          set({ reviewSubmitStatus: "idle" });
        }
        return true;
      } catch {
        set({ reviewSubmitStatus: "idle", reviewSubmitError: "could not reach the server" });
        return false;
      }
    },

    async editPrReviewComment(id, body) {
      const state = get();
      const trimmed = body.trim();
      const target = state.prDiscussion?.comments.find((comment) => comment.id === id);
      if (
        !state.review
        || state.prReviewed === null
        || state.prSelected !== state.prReviewed
        || trimmed.length === 0
        || state.prCommentMutationStatus === "submitting"
        || state.prReviewStale
        || state.prReviewRefreshing
        || state.prReviewStatus === "preparing"
        || !target?.viewerCanEdit
      ) {
        return false;
      }
      return mutatePrReviewComment({
        number: state.prReviewed,
        action: "edit",
        commentId: id,
        body: trimmed,
        reviewKey: state.review.context.reviewKey,
      });
    },

    async replyToPrReviewComment(topLevelId, body) {
      const state = get();
      const trimmed = body.trim();
      const target = state.prDiscussion?.comments.find((comment) => comment.id === topLevelId);
      if (
        !state.review
        || state.prReviewed === null
        || state.prSelected !== state.prReviewed
        || trimmed.length === 0
        || state.prCommentMutationStatus === "submitting"
        || state.prReviewStale
        || state.prReviewRefreshing
        || state.prReviewStatus === "preparing"
        || !target
        || target.inReplyToId !== null
      ) {
        return false;
      }
      return mutatePrReviewComment({
        number: state.prReviewed,
        action: "reply",
        commentId: topLevelId,
        body: trimmed,
        reviewKey: state.review.context.reviewKey,
      });
    },

    // Switching mode re-derives + relayouts like a dive, but CARRIES the current code path: the nodes
    // the reader is on in the outgoing lens (its whole selection, or focus) are revealed and selected
    // in the incoming one, so Map ↔ Service ↔ UI stay on the same files/symbols instead of resetting
    // to the lens's top level. Anchors the target lens can't place (a bare folder in the Service lens)
    // are dropped; only when NONE is placeable does it fall back to opening the lens at its top. The
    // logic view is a standalone render (its own ELK pass), so it neither dives nor relayouts.
    setViewMode(mode) {
      if (mode === "prs" && !get().githubSource) {
        return;
      }
      const previous = get().viewMode;
      if (previous === mode) {
        // Re-clicking the ACTIVE Service tab is the escape hatch back to the FULL lens: the scoped
        // sub-view exits AND any svc: cluster zoom clears (the breadcrumb stays the primary exit
        // for each); every other same-tab click remains a no-op.
        if (mode === "call") {
          get().clearServiceScope();
          const focus = get().moduleFocus;
          if (focus !== null && (leadIdOf(focus) !== null || isServiceDomainId(focus))) {
            get().setModuleFocus(null);
          }
        }
        return;
      }
      if (!guardReviewLineComposerTransition(() => get().setViewMode(mode))) {
        return;
      }
      if (previous === "prs") {
        // A prepare-first review only owns the PRs waiting surface. Leaving it explicitly abandons
        // the entry; the server stream may finish, but its sequence can no longer swap the graph.
        get().cancelPrReviewPreparation();
      }
      // The path nodes to carry — read BEFORE any state mutates the outgoing lens's selection/focus.
      const outgoing = get();
      const anchors = expandServiceSyntheticAnchors(
        anchorNodeIds(outgoing),
        outgoing.index,
        outgoing.serviceGroupingMode,
        outgoing.serviceGroupingTargetSize,
      );
      if (!beginLensTransition(get, set, () => get().setViewMode(mode))) return;
      if (mode === "logic") {
        moduleLayoutSeq += 1;
        set({ viewMode: mode });
        return;
      }
      if (mode === "prs") {
        moduleLayoutSeq += 1;
        // beginLensTransition softly parked any open review and restored the boot graph. Keep its
        // payload and prepared id alive while the queue is browsed; starting another review is the
        // commit point that replaces it. No relayout here because the PR page has no canvas.
        // Remember the lens we're leaving so `togglePrsView` can resume it (previous !== "prs" here).
        lensBeforePrs = previous;
        set({ viewMode: mode });
        if (get().prsList[get().prsTab] === null) {
          void get().loadPrs(1);
        }
        return;
      }
      // A shared/reloaded deep link is unaffected: it restores via setState on boot (not this click
      // path), so an explicit ?mfocus=… still opens exactly where the link points. The palette's
      // "+" pins (`mapExtra`) are session scratch of the level we leave — always cleared. Every
      // remaining mode is a module surface (Map / Service / UI) with its own anchor reveal.
      const { index, serviceGroupingMode, serviceGroupingTargetSize } = get();
      const serviceResolution = mode === "call"
        ? resolveServiceAnchors(anchors, index, serviceGroupingMode, serviceGroupingTargetSize)
        : null;
      const reveal =
        mode === "modules"
          ? mapRevealStateForMany(anchors, index)
          : mode === "call"
            ? serviceResolution?.reveal ?? null
            : uiRevealStateForMany(anchors, index);
      // The incoming spec must never render against the outgoing surface's scene while its ELK pass
      // is in flight. Service also receives the same owner + one-hop scope as its anchor resolution;
      // on large repositories this keeps lens carry local instead of synchronously mounting the
      // entire call graph before the first frame can paint.
      set({
        viewMode: mode,
        mapExtra: new Set<string>(),
        mapGhostPins: new Map<string, ReadonlySet<string>>(),
        moduleRfNodes: [],
        moduleRfEdges: [],
        moduleSemanticLayers: [],
        moduleEffectiveFocus: null,
        serviceScope:
          mode === "call" && serviceResolution !== null
            ? serviceScopeFor(serviceResolution.owningLeads, index)
            : null,
        ...(reveal ?? MODULE_TOP_LEVEL),
      });
      void get().moduleRelayout({
        label: mode === "call" ? "Opening Service lens…" : mode === "ui" ? "Opening UI lens…" : "Opening Map lens…",
      });
    },

    // The "PR review" control is a toggle: off → open the full PR page; on → resume the lens you came
    // from (Map/Service/UI/Logic). The graph state is left untouched while PRs are open, so flipping
    // the mode back restores it exactly where you left it — no reset, no re-layout — except when that
    // lens was never laid out (PRs opened before its surface first rendered), which we relayout for.
    togglePrsView() {
      if (get().viewMode !== "prs") {
        get().setViewMode("prs");
        return;
      }
      get().cancelPrReviewPreparation();
      const back = lensBeforePrs ?? "modules";
      lensBeforePrs = null;
      set({ viewMode: back });
      if (moduleSurfaceSpec(back) !== null && get().moduleRfNodes.length === 0) {
        void get().moduleRelayout({ label: "Restoring graph…" });
      }
    },

    // Hiding tests while having selected test code would strand the view on nodes that no longer
    // exist, so selection — including the composition panel's own selection/root — retreats first.
    toggleShowTests() {
      if (!guardReviewLineComposerTransition(() => get().toggleShowTests())) {
        return;
      }
      const showTests = !get().showTests;
      const beforeToggle = get();
      // Live PR reprojection below replaces the whole review workspace and clears its split. An
      // artifact-carried review only replaces rows/paint, so explicitly leave its transient flow
      // inspection first; otherwise the navigator and its old layout keep pointing at the prior
      // Tests projection. Restore before filtering selections so hiding tests cannot resurrect a
      // test-backed selection captured in the flow baseline.
      if (
        beforeToggle.prReviewed === null
        && beforeToggle.review !== null
        && beforeToggle.flowSelection !== null
        && beforeToggle.reviewFlowBaseline !== null
      ) {
        beforeToggle.selectFlowEntry(null);
      }
      const { compSelectedId, compRoot, moduleSelected, viewMode, index, prReviewed, minimalSeedIds } = get();
      const strandedById = (id: string | null) => !showTests && id !== null && index.testIds.has(id);
      set({
        showTests,
        compSelectedId: strandedById(compSelectedId) ? null : compSelectedId,
        compRoot: strandedById(compRoot) ? null : compRoot,
        moduleSelected: showTests ? moduleSelected : new Set([...moduleSelected].filter((id) => !index.testIds.has(id))),
      });
      // A live PR review is auto-derived, not an explicit hand-curated minimal graph. Re-project
      // every review surface through the same toggle (members, files, flows, groups, progress and
      // amber paint) while retaining the raw PR context/ticks/drafts for a lossless toggle-back.
      if (prReviewed !== null && minimalSeedIds.length > 0) {
        let reprojected: boolean;
        const current = get();
        if (
          current.flowSelection === null
          || current.minimalGraphHistory.length > 0
          || current.reviewActiveGroupId !== null
          || current.reviewPathScope !== null
          || current.reviewFocusedSubgraph !== null
          || hasReusableReviewProjectionFrame(current)
        ) {
          reprojected = reprojectLivePrReview(showTests ? "Showing tests…" : "Hiding tests…", true);
        } else {
          reprojected = applyPrReviewToMap(get, set, prFilesUrl, invalidateMinimalLayout, invalidateModuleLayout, invalidateArtifactCaches, {
            reprojecting: true,
            preserveReviewSelection: true,
          });
        }
        const projected = get();
        if (
          reprojected
          && showTests
          && projected.reviewFileViewedStates !== null
          && !projected.prReviewStale
        ) {
          // Hidden legacy unit ticks are promoted only when their test files enter the projection.
          // Reconcile those new file intents with the already-loaded canonical GitHub snapshot.
          queueMicrotask(() => void loadViewedFiles(prReviewed));
        }
        return;
      }
      reprojectArtifactReview(showTests);
      // The module surfaces (Map / Service / UI) re-derive: test code can be half a level's cards
      // (and a wall of off-level test ghosts), and paint-hiding kept a crater of empty space —
      // moduleRelayout re-derives the level with testIds excluded, so the survivors compact.
      // Positions do move on this toggle, by design.
      if (moduleSurfaceSpec(viewMode) !== null) {
        void get().moduleRelayout({ label: showTests ? "Showing tests…" : "Hiding tests…" });
        // An open minimal overlay derives its ghost-satellite ring with the same hidden set, so the
        // toggle refreshes it too (else stale test satellites linger over the recomputed Map).
        if (get().minimalSeedIds.length > 0) {
          void requestMinimalRelayout({ label: showTests ? "Showing tests…" : "Hiding tests…" });
        }
      }
    },

    // The layout is untouched — coverage only recolors — so no relayout is needed.
    toggleCoverageMode() {
      const coverageMode = !get().coverageMode;
      const { artifact, coverage } = get();
      set({
        coverageMode,
        coverage: coverageMode && !coverage ? computeCoverage(artifact.nodes, artifact.edges) : coverage,
      });
    },

    // Telemetry is a presentation mode, not a data lifecycle. Leaving it removes request-only
    // surfaces while preserving the selected source, loaded bundle, and selected request for fast
    // re-entry. A request split cannot remain on screen after its owning mode is hidden.
    toggleTelemetryMode() {
      const state = get();
      const telemetryMode = !state.telemetryMode;
      if (telemetryMode) {
        set({ telemetryMode: true });
        return;
      }
      if (state.flowPaneOrigin === "request") {
        flowPaneLayoutSeq += 1;
        requestTargetRevealSeq += 1;
      }
      set({
        telemetryMode: false,
        logicView: state.logicView === "request" ? "graph" : state.logicView,
        ...requestFlowPaneReset(state),
      });
    },

    setTelemetrySource(id) {
      const registration = id === null ? undefined : telemetrySourceCatalog.get(id);
      const telemetrySourceId = registration?.id ?? null;
      if (get().telemetrySourceId === telemetrySourceId && get().provider === (registration?.provider ?? null)) {
        return;
      }
      telemetryFetchSeq += 1;
      if (get().flowPaneOrigin === "request") flowPaneLayoutSeq += 1;
      set({
        telemetrySourceId,
        provider: registration?.provider ?? null,
        environment: null,
        telemetry: {},
        requestTraces: [],
        selectedTraceId: null,
        traceGraphRef: null,
        traceSource: null,
        telemetryLoading: false,
        telemetryError: null,
        traceLoading: false,
        traceError: null,
        ...requestFlowPaneReset(get()),
      });
    },

    setEnvironment(environment) {
      telemetryFetchSeq += 1;
      if (get().flowPaneOrigin === "request") flowPaneLayoutSeq += 1;
      set({
        environment,
        telemetry: {},
        requestTraces: [],
        selectedTraceId: null,
        traceGraphRef: null,
        traceSource: null,
        telemetryLoading: false,
        telemetryError: null,
        traceLoading: false,
        traceError: null,
        ...requestFlowPaneReset(get()),
      });
    },

    setSelectedTrace(traceId) {
      if (traceId !== null && !get().requestTraces.some((trace) => trace.traceId === traceId)) {
        return;
      }
      if (get().selectedTraceId === traceId) return;
      const requestPaneOpen = get().flowPaneOrigin === "request";
      if (!requestPaneOpen) {
        set({ selectedTraceId: traceId });
        return;
      }
      flowPaneLayoutSeq += 1;
      requestTargetRevealSeq += 1;
      if (traceId === null) {
        set({ selectedTraceId: null, ...requestFlowPaneReset(get()) });
        return;
      }
      set({
        selectedTraceId: traceId,
        requestFlowTraceId: traceId,
        requestFlowExpansionOverrides: new Set<string>(),
        flowPaneRfNodes: [],
        flowPaneRfEdges: [],
        flowPaneLayoutStatus: "laying-out",
      });
      void get().flowPaneRelayout();
    },

    async refreshTelemetry() {
      const { provider, environment, telemetrySourceId } = get();
      if (environment === null) {
        throw new Error("refreshTelemetry called before an environment was selected");
      }
      if (!provider) {
        return;
      }
      const sequence = ++telemetryFetchSeq;
      const descriptor = telemetrySourceId === null ? null : telemetrySourceCatalog.get(telemetrySourceId) ?? null;
      const supportsMetrics = descriptor?.supportsMetrics ?? true;
      const supportsTraces = descriptor?.supportsTraces ?? true;
      set({
        telemetryLoading: supportsMetrics,
        telemetryError: null,
        traceLoading: supportsTraces,
        traceError: null,
      });
      const stillCurrent = () => telemetryFetchSeq === sequence
        && get().environment === environment
        && get().telemetrySourceId === telemetrySourceId;

      // Each channel commits independently. A slow or hung trace backend must not hold an already
      // available metrics overlay hostage (and vice versa), while both retain the same stale-env guard.
      const metricsTask = supportsMetrics
        ? Promise.resolve()
          .then(() => provider.fetchMetrics(environment))
          .then(
            (telemetry) => {
              if (stillCurrent()) set({ telemetry, telemetryLoading: false, telemetryError: null });
            },
            (reason: unknown) => {
              if (stillCurrent()) set({ telemetryLoading: false, telemetryError: telemetryFailure(reason, "Metrics unavailable.") });
            },
          )
        : Promise.resolve();
      const tracesTask = supportsTraces
        ? Promise.resolve()
          .then(() => provider.fetchTraces(environment))
          .then(
            (bundle) => {
              if (!stillCurrent()) return;
              const current = get();
              const selectedTraceId = current.selectedTraceId !== null
                && bundle.traces.some((trace) => trace.traceId === current.selectedTraceId)
                ? current.selectedTraceId
                : newestTrace(bundle.traces)?.traceId ?? null;
              const keepRequestPane = current.flowPaneOrigin === "request"
                && selectedTraceId !== null
                && traceGraphRefMismatches(bundle.graphRef, current.artifact).length === 0;
              if (current.flowPaneOrigin === "request") flowPaneLayoutSeq += 1;
              set({
                requestTraces: bundle.traces,
                selectedTraceId,
                traceGraphRef: bundle.graphRef,
                traceSource: bundle.source,
                traceLoading: false,
                traceError: null,
                ...(keepRequestPane
                  ? {
                      requestFlowTraceId: selectedTraceId,
                      requestFlowExpansionOverrides: new Set<string>(),
                      flowPaneRfNodes: [] as LogicRfNode[],
                      flowPaneRfEdges: [] as LogicRfEdge[],
                      flowPaneLayoutStatus: "laying-out" as const,
                    }
                  : requestFlowPaneReset(current)),
              });
              if (keepRequestPane) void get().flowPaneRelayout();
            },
            (reason: unknown) => {
              if (stillCurrent()) set({ traceLoading: false, traceError: telemetryFailure(reason, "Request traces unavailable.") });
            },
          )
        : Promise.resolve();
      await Promise.all([metricsTask, tracesTask]);
    },

    // Hover previews have their own local lifecycle. Loading through this action reuses the exact
    // click-to-open source rules without mutating `codeView`, so hovering can never replace an open
    // modal. The preview component owns dwell, stale-result, and per-node caching behavior.
    async loadCodePreview(node, opts) {
      const state = get();
      const request = codeLoadRequest(node, undefined, state, sourceUrl, prFileUrl);
      if (!request) return null;
      const view = await fetchCodeView(request, "inline", codePayloadCache);
      return opts?.focus === undefined
        ? view
        : withCodePreviewFocus(view, node, opts.focus, request, state);
    },

    // Fetch and reveal a callable's source in the requested host (inline by default). Inert when
    // the server ships no source access or the node has no location. A race guard drops the result
    // if a newer click has since taken over; the host is preserved across the fetch so a mid-flight
    // inline → modal expansion is not clobbered when the code lands.
    async showCode(node, opts) {
      const state = get();
      const request = codeLoadRequest(node, opts, state, sourceUrl, prFileUrl);
      if (!request) {
        return;
      }
      if (!guardReviewLineComposerTransition(
        () => { void get().showCode(node, opts); },
      )) {
        return;
      }
      const requestedMode = opts?.mode ?? "inline";
      const sequence = ++codeViewSeq;
      set({
        codeView: {
          node,
          code: null,
          loading: true,
          error: null,
          mode: requestedMode,
          baseLine: request.baseLine,
          wholeFile: request.wholeFile,
        },
      });
      const view = await fetchCodeView(request, requestedMode, codePayloadCache);
      if (sequence !== codeViewSeq || get().codeView?.node.id !== node.id) {
        return;
      }
      // The reader may expand the loading inline panel before the response lands.
      set({ codeView: { ...view, mode: get().codeView?.mode ?? requestedMode } });
    },

    async showReviewFile(path) {
      const state = get();
      const file = state.reviewFiles.find((candidate) => candidate.path === path);
      if (!file) {
        return;
      }
      const matchedNode = file.moduleId === null ? null : state.index.nodesById.get(file.moduleId) ?? null;
      // This request descriptor never enters the graph/index. buildNodeId keeps even this ephemeral
      // source target inside the canonical id grammar instead of inventing a second id format.
      const sourceNode: GraphNode = matchedNode ?? {
        id: buildNodeId({ lang: "review", modulePath: path }),
        kind: "module",
        qualifiedName: path,
        displayName: path.split("/").pop() ?? path,
        parentId: null,
        location: { file: path, startLine: 1 },
      };
      const request = codeLoadRequest(sourceNode, { wholeFile: true }, state, sourceUrl, prFileUrl);
      if (!request || !guardReviewLineComposerTransition(
        () => { void get().showReviewFile(path); },
      )) {
        return;
      }
      // A file row has no card-mounted inline host, so modal intent is part of the guarded source
      // transition itself and survives a dirty-draft Discard replay.
      const loading = get().showCode(sourceNode, { wholeFile: true, mode: "modal" });
      await loading;
    },

    async showEdgeEvidence(contexts, activeIndex = 0) {
      if (contexts.length === 0) {
        get().closeEdgeEvidence();
        return;
      }
      const selectedIndex = Math.min(Math.max(Math.trunc(activeIndex), 0), contexts.length - 1);
      const context = contexts[selectedIndex]!;
      const state = get();
      const node = edgeEvidenceNode(context, selectedIndex, state);
      // A wire touching a projected tombstone exists only on the merge-base graph. Its call sites
      // are old-side evidence even when the source caller survived in HEAD, so route the synthetic
      // evidence node explicitly instead of trying to infer ownership from its presentation-only id.
      const readsComparisonBase = state.reviewDeletedNodeIds.has(context.source)
        || state.reviewDeletedNodeIds.has(context.target);
      const request = codeLoadRequest(
        node,
        readsComparisonBase ? { sourceSide: "base" } : undefined,
        state,
        sourceUrl,
        prFileUrl,
      );
      if (!request) {
        get().closeEdgeEvidence();
        return; // The pinned inspector remains visible and truthfully reports attribution only.
      }
      if (!guardReviewLineComposerTransition(
        () => { void get().showEdgeEvidence(contexts, activeIndex); },
      )) {
        return;
      }
      const span = displayedEvidenceSpan(context, state, prFileUrl);
      const edgeEvidence = {
        contexts: [...contexts],
        activeIndex: selectedIndex,
        focusStartLine: span.start,
        focusEndLine: span.end,
      };
      const sequence = ++edgeEvidenceSeq;
      const codeSequence = ++codeViewSeq;
      const selectionKey = edgeEvidenceKey(context);
      set({
        codeView: {
          node,
          code: null,
          loading: true,
          error: null,
          mode: "modal",
          baseLine: request.baseLine,
          wholeFile: false,
          edgeEvidence,
        },
      });
      const view = await fetchCodeView(request, "modal", codePayloadCache);
      const current = get().codeView;
      const currentContext = current?.edgeEvidence?.contexts[current.edgeEvidence.activeIndex];
      if (
        sequence !== edgeEvidenceSeq
        || codeSequence !== codeViewSeq
        || currentContext === undefined
        || edgeEvidenceKey(currentContext) !== selectionKey
      ) {
        return;
      }
      set({ codeView: { ...view, mode: "modal", edgeEvidence } });
    },

    async selectEdgeEvidence(index) {
      const contexts = get().codeView?.edgeEvidence?.contexts;
      if (!contexts || index < 0 || index >= contexts.length) {
        return;
      }
      await get().showEdgeEvidence(contexts, index);
    },

    closeEdgeEvidence() {
      if (get().codeView?.edgeEvidence === undefined) {
        return true;
      }
      if (!guardReviewLineComposerTransition(() => get().closeEdgeEvidence())) {
        return false;
      }
      edgeEvidenceSeq += 1;
      codeViewSeq += 1;
      set({ codeView: null });
      return true;
    },

    // Blow the current inline panel up into the centered modal. A no-op when nothing is shown.
    expandCode() {
      const state = get();
      const { codeView } = state;
      if (!codeView) {
        return;
      }
      if (
        state.reviewLineComposer !== null
        && !codeViewCanHostReviewLineComposer(state, codeView)
        && !guardReviewLineComposerTransition(() => get().expandCode())
      ) {
        return;
      }
      set({ codeView: { ...codeView, mode: "modal" } });
    },

    closeCode() {
      if (!guardReviewLineComposerTransition(() => get().closeCode())) {
        return;
      }
      if (get().codeView?.edgeEvidence !== undefined) {
        edgeEvidenceSeq += 1;
      }
      codeViewSeq += 1;
      set({ codeView: null });
    },

    setPrsTab(tab) {
      if (get().prsTab === tab) {
        return;
      }
      // A tab switch is also a selection reset, so invalidate every selected-PR response lane.
      prFilesSeq += 1;
      prSearchSeq += 1;
      get().cancelPrReviewPreparation();
      set({
        prsTab: tab,
        prsError: null,
        prSearchQuery: "",
        prSearchResults: [],
        prSearchHasMore: false,
        prSearchLoading: false,
        prSearchError: null,
        prSelected: null,
        prFiles: null,
        prDiscussion: null,
        prChecks: null,
        prsLoading: false,
        prFilesTruncated: false,
        prFilesTotal: 0,
        prFilesOutside: 0,
        prFilesSuggestedSubdir: "",
        prReviewBlocked: null,
      });
      if (get().prsList[tab] === null) {
        void get().loadPrs(1);
      }
    },

    async loadPrs(page) {
      if (!get().githubSource) {
        return;
      }
      const tab = get().prsTab;
      const pageToLoad = page ?? prsNextPage[tab];
      const sequence = ++prsListSeq;
      set({ prsLoading: true, prsError: null });
      try {
        const url = new URL(prsUrl, requestOrigin());
        url.searchParams.set("state", tab);
        url.searchParams.set("page", String(pageToLoad));
        const response = await fetch(url, { credentials: "same-origin" });
        if (prsListSeq !== sequence) {
          return;
        }
        if (!response.ok) {
          set({ prsLoading: false, prsError: await errorMessage(response) });
          return;
        }
        const data = (await response.json()) as PrListResponse;
        if (prsListSeq !== sequence) {
          return;
        }
        const current = get().prsList[tab];
        const existing = pageToLoad === 1 || current === null ? [] : current;
        prsNextPage[tab] = pageToLoad + 1;
        set({
          prsList: { ...get().prsList, [tab]: mergePrSummaries(existing, data.prs) },
          prsHasMore: { ...get().prsHasMore, [tab]: data.hasMore },
          prsLoading: false,
          prsError: null,
        });
      } catch {
        if (prsListSeq === sequence) {
          set({ prsLoading: false, prsError: PRS_UNAVAILABLE_ERROR });
        }
      }
    },

    async searchPrs(query) {
      if (!get().githubSource) {
        return;
      }
      const normalized = normalizePrSearchQuery(query);
      if (normalized === "") {
        get().clearPrSearch();
        return;
      }
      const tab = get().prsTab;
      const cacheKey = prSearchCacheKey(tab, normalized);
      const cached = get().prSearchCache[cacheKey];
      const sequence = ++prSearchSeq;
      if (cached) {
        set({
          prSearchQuery: normalized,
          prSearchResults: [...cached.numbers],
          prSearchHasMore: cached.hasMore,
          prSearchLoading: false,
          prSearchError: null,
        });
        return;
      }
      set({
        prSearchQuery: normalized,
        prSearchResults: [],
        prSearchHasMore: false,
        prSearchLoading: true,
        prSearchError: null,
      });
      const active = () =>
        prSearchSeq === sequence
        && get().prsTab === tab
        && get().prSearchQuery === normalized;
      try {
        const url = new URL(prsUrl, requestOrigin());
        url.searchParams.set("state", tab);
        // Keep the existing list contract valid while `q` selects the priority-search path.
        url.searchParams.set("page", "1");
        url.searchParams.set("q", query.trim());
        const response = await fetch(url, { credentials: "same-origin" });
        if (!active()) {
          return;
        }
        if (!response.ok) {
          const message = await errorMessage(response);
          if (!active()) {
            return;
          }
          set({
            prSearchResults: [],
            prSearchHasMore: false,
            prSearchLoading: false,
            prSearchError: message,
          });
          return;
        }
        const data = (await response.json()) as PrListResponse;
        if (!active()) {
          return;
        }
        const summaries = mergePrSummaries([], data.prs);
        const numbers = summaries.map((pr) => pr.number);
        const extras = { ...get().prExtraSummaries };
        for (const pr of summaries) {
          extras[pr.number] = pr;
        }
        const entry: PrSearchCacheEntry = { numbers, hasMore: data.hasMore };
        set({
          prExtraSummaries: extras,
          prSearchResults: numbers,
          prSearchHasMore: data.hasMore,
          prSearchCache: { ...get().prSearchCache, [cacheKey]: entry },
          prSearchLoading: false,
          prSearchError: null,
        });
      } catch {
        if (active()) {
          set({
            prSearchResults: [],
            prSearchHasMore: false,
            prSearchLoading: false,
            prSearchError: PRS_UNAVAILABLE_ERROR,
          });
        }
      }
    },

    clearPrSearch() {
      prSearchSeq += 1;
      set({
        prSearchQuery: "",
        prSearchResults: [],
        prSearchHasMore: false,
        prSearchLoading: false,
        prSearchError: null,
      });
    },

    async exploreRelatedPrs() {
      // Resolve before navigation: entering the PRs page may close/restore a review overlay, but the
      // request subject is the graph view the reader invoked this action from.
      const paths = filesInScope(get());
      if (paths.length === 0) {
        return;
      }
      const sequence = ++relatedPrsSeq;
      const subject: RelatedPrsState = {
        paths,
        results: [],
        scanned: 0,
        hasMore: false,
        loading: true,
        error: null,
      };
      set({ relatedPrs: subject });
      if (get().viewMode !== "prs") {
        get().setViewMode("prs");
      }
      // Identity is the subject guard: clearing or replacing the filter while either response body
      // is in flight must not let this request resurrect stale related results.
      const active = () => relatedPrsSeq === sequence && get().relatedPrs === subject;
      try {
        const response = await fetch(prRelatedUrl, {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ paths }),
        });
        if (!active()) {
          return;
        }
        if (!response.ok) {
          const error = await errorMessage(response);
          if (active()) {
            set({ relatedPrs: { ...subject, loading: false, error } });
          }
          return;
        }
        const data = (await response.json()) as RelatedPrsResponse;
        if (!active()) {
          return;
        }
        set({
          relatedPrs: {
            paths,
            results: data.results,
            scanned: data.scanned,
            hasMore: data.hasMore,
            loading: false,
            error: null,
          },
        });
      } catch {
        if (active()) {
          set({ relatedPrs: { ...subject, loading: false, error: PRS_UNAVAILABLE_ERROR } });
        }
      }
    },

    clearRelatedPrs() {
      relatedPrsSeq += 1;
      set({ relatedPrs: null });
    },

    async ensurePrSummary(number) {
      if (selectedPrSummary(get(), number) !== null) {
        return;
      }
      try {
        const url = new URL(prOneUrl, requestOrigin());
        url.searchParams.set("n", String(number));
        const response = await fetch(url, { credentials: "same-origin" });
        if (!response.ok) {
          set({ prsError: await errorMessage(response) });
          return;
        }
        const { pr } = (await response.json()) as PrOneResponse;
        set({
          prExtraSummaries: { ...get().prExtraSummaries, [pr.number]: pr },
          prsError: null,
        });
      } catch {
        set({ prsError: PRS_UNAVAILABLE_ERROR });
      }
    },

    async selectPr(number, options = {}) {
      if (number !== null && !get().githubSource) {
        return;
      }
      const sequence = ++prFilesSeq;
      prDiscussionSeq += 1;
      // Switching PRs abandons any review preparation in flight: bump its seq so a landing stream
      // is dropped, and clear the indicator so the panel never shows a stale progress/error card.
      get().cancelPrReviewPreparation();
      // Browsing another card must not discard a parked review. Only an explicit navigation restore
      // away from review state requests teardown; starting another review owns replacement below.
      const reviewToEnd = get().prReviewed;
      if (
        options.endReviewSession
        && reviewToEnd !== null
        && get().prPreparedArtifactCurrent
        && get().prReviewBaseline === null
        && !await ensureCompleteBootDocumentRestoreForTransition(
          reviewToEnd,
          get().prPreparedGraphId,
          () => sequence === prFilesSeq,
        )
      ) {
        return;
      }
      if (
        options.endReviewSession
        && restoreSelectedPrReview(
          get,
          set,
          canonicalBootBaseline ?? bootReviewBaseline,
          () => restorePreparedReviewBaseline(get, set),
        )
      ) {
        void get().relayout();
      }
      const progressAfterCancel = get().prReviewProgress;
      const retainBootReviewProgress = progressAfterCancel.status === "running"
        && progressAfterCancel.activeStage === "details"
        && progressAfterCancel.prNumber === number
        && (
          progressAfterCancel.steps.artifacts === "active"
          || progressAfterCancel.steps.artifacts === "done"
        )
        && progressAfterCancel.steps.projection === "pending";
      const prepareReset = {
        prReviewStatus: "idle" as const,
        prPrepareStage: null,
        prReviewProgress: retainBootReviewProgress
          ? progressAfterCancel
          : createPrReviewProgressSnapshot(number),
        prPrepareError: null,
      };
      if (number === null) {
        set({
          prSelected: null,
          prFiles: null,
          prDiscussion: null,
          prChecks: null,
          prFilesTruncated: false,
          prFilesTotal: 0,
          prFilesOutside: 0,
          prFilesSuggestedSubdir: "",
          prReviewBlocked: null,
          prsLoading: false,
          prsError: null,
          ...prepareReset,
        });
        return;
      }
      set({
        prSelected: number,
        prFiles: null,
        prDiscussion: null,
        prChecks: null,
        prFilesTruncated: false,
        prFilesTotal: 0,
        prFilesOutside: 0,
        prFilesSuggestedSubdir: "",
        prReviewBlocked: null,
        prsLoading: true,
        prsError: null,
        ...prepareReset,
      });
      const request = (async () => {
        // Related results intentionally carry only card fields. Resolve a full summary before the
        // ordinary file/discussion/check lanes so a related card behaves exactly like a paged card.
        if (selectedPrSummary(get(), number) === null) {
          await get().ensurePrSummary(number);
          if (prFilesSeq !== sequence || get().prSelected !== number) {
            return;
          }
        }
        try {
          const url = new URL(prFilesUrl, requestOrigin());
          url.searchParams.set("n", String(number));
          const response = await fetch(url, { credentials: "same-origin" });
          if (prFilesSeq !== sequence || get().prSelected !== number) {
            return;
          }
          if (!response.ok) {
            set({ prsLoading: false, prsError: await errorMessage(response) });
            return;
          }
          const data = (await response.json()) as PrFilesResponse;
          if (prFilesSeq !== sequence || get().prSelected !== number) {
            return;
          }
          set({
            prFiles: data.files,
            prFilesTruncated: data.truncated,
            prFilesTotal: data.totalFiles ?? data.files.length,
            prFilesOutside: data.outsideCount ?? 0,
            prFilesSuggestedSubdir: data.suggestedSubdir ?? "",
            prsLoading: false,
            prsError: null,
          });
          // Discussion and checks are deliberately secondary to the changed-file load: the detail
          // panel is usable as soon as files land, while these two independent lanes fill in quietly.
          const discussionSequence = ++prDiscussionSeq;
          void fetchPrDiscussion(prCommentsUrl, number).then(
            (discussion) => {
              if (prDiscussionSeq === discussionSequence && prFilesSeq === sequence && get().prSelected === number) {
                set({ prDiscussion: { comments: discussion.comments, reviews: discussion.reviews } });
              }
            },
            () => {
              if (prDiscussionSeq === discussionSequence && prFilesSeq === sequence && get().prSelected === number) {
                console.warn("[meridian] PR discussion unavailable.");
              }
            },
          );
          const headSha = selectedPrSummary(get(), number)?.headSha ?? null;
          if (headSha !== null) {
            void fetchPrChecks(prChecksUrl, number, headSha).then(
              (checks) => {
                if (prFilesSeq === sequence && get().prSelected === number) {
                  set({ prChecks: checks });
                }
              },
              () => {
                if (prFilesSeq === sequence && get().prSelected === number) {
                  console.warn("[meridian] PR checks unavailable.");
                }
              },
            );
          }
        } catch {
          if (prFilesSeq === sequence && get().prSelected === number) {
            set({ prsLoading: false, prsError: PRS_UNAVAILABLE_ERROR });
          }
        }
      })();
      const activeRequest = { number, sequence, promise: request };
      prFilesRequest = activeRequest;
      try {
        await request;
      } finally {
        if (prFilesRequest === activeRequest) {
          prFilesRequest = null;
        }
      }
    },

    // GitHub's Files changed view quietly notices when the pull-request head moves, but leaves the
    // reader on the revision they started reviewing until they explicitly refresh. The loaded
    // revision object is captured when applyPrReviewToMap runs; refreshing the summary cache here
    // therefore cannot erase the comparison baseline. Focus/visibility/interval scheduling lives
    // in ReviewPanel, while this action owns request sharing and stale-result guards.
    async checkPrReviewFreshness() {
      const { prReviewed: number, prReviewRevision: revision, prReviewRefreshing } = get();
      if (number === null || revision === null || prReviewRefreshing) {
        return;
      }
      const inFlight = prFreshnessRequest;
      if (inFlight?.number === number && inFlight.revision === revision) {
        await inFlight.promise;
        return;
      }
      const promise = (async () => {
        try {
          const latest = await fetchPrSummary(prOneUrl, number);
          const current = get();
          if (current.prReviewed !== number || current.prReviewRevision !== revision || current.prReviewRefreshing) {
            return;
          }
          const stale = isPrReviewStale(revision, latest);
          set(refreshedPrSummaryState(current, latest));
          if (stale) {
            failViewedWritesForStaleHead(
              number,
              "Pull request files changed at a newer head. Refresh the review to continue.",
            );
          } else {
            set({ prReviewStale: false });
          }
        } catch {
          // Freshness is advisory. A transient GitHub/network failure must not interrupt review or
          // replace the page's stronger load/submit errors with a noisy polling warning.
        }
      })();
      const request = { number, revision, promise };
      prFreshnessRequest = request;
      try {
        await promise;
      } finally {
        if (prFreshnessRequest === request) {
          prFreshnessRequest = null;
        }
      }
    },

    // Refresh a stale review in place. Drafts/ticks remain live under the stable reviewKey; the
    // fresh files, discussion, checks, and (when available) prepared head artifact replace the old
    // content only after their guarded requests land. Failures leave the previous review visible.
    async refreshPrReview() {
      const before = get();
      const number = before.prReviewed;
      const revision = before.prReviewRevision;
      if (
        number === null
        || revision === null
        || !before.prReviewStale
        || before.prReviewRefreshing
        || before.prReviewStatus === "preparing"
        || before.reviewSubmitStatus === "submitting"
        || before.viewMode !== "modules"
        || before.minimalSeedIds.length === 0
      ) {
        return;
      }
      if (!guardReviewLineComposerTransition(() => { void get().refreshPrReview(); })) {
        return;
      }
      // Refresh temporarily installs the new file inputs because both synchronous projection and
      // head preparation consume them from store state. Until that projection succeeds, retain
      // the prior inputs as one transaction so a failed/canceled refresh cannot poison a later
      // Resume with files from a graph we rolled back. Summary/discussion/checks stay fresh.
      let stagedPrFiles: BlueprintState["prFiles"] = null;
      const restoreRetainedReviewFiles = () => {
        const current = get();
        if (
          current.prReviewed !== number
          || current.prSelected !== number
          || current.prReviewRevision !== revision
          || current.prFiles !== stagedPrFiles
        ) {
          return;
        }
        set({
          prFiles: before.prFiles,
          prFilesTruncated: before.prFilesTruncated,
          prFilesTotal: before.prFilesTotal,
          prFilesOutside: before.prFilesOutside,
          prFilesSuggestedSubdir: before.prFilesSuggestedSubdir,
        });
      };
      const sequence = ++prReviewRefreshSeq;
      const active = () => prReviewRefreshSeq === sequence && sameReviewRefresh(get(), number, revision);
      set({
        prReviewRefreshing: true,
        prReviewStatus: "idle",
        prPrepareStage: null,
        prReviewProgress: createPrReviewProgressSnapshot(number),
        prPrepareError: null,
      });
      try {
        const latest = await fetchPrSummary(prOneUrl, number);
        if (!active()) {
          return;
        }
        const discussionSequence = ++prDiscussionSeq;
        const [files, discussion, checks] = await Promise.all([
          fetchPrFiles(prFilesUrl, number),
          fetchPrDiscussion(prCommentsUrl, number).catch(() => null),
          latest.headSha === null ? Promise.resolve(null) : fetchPrChecks(prChecksUrl, number, latest.headSha).catch(() => null),
        ]);
        if (!active()) {
          return;
        }
        const current = get();
        stagedPrFiles = files.files;
        set({
          ...refreshedPrSummaryState(current, latest),
          prFiles: files.files,
          prFilesTruncated: files.truncated,
          prFilesTotal: files.totalFiles ?? files.files.length,
          prFilesOutside: files.outsideCount ?? 0,
          prFilesSuggestedSubdir: files.suggestedSubdir ?? "",
          ...(prDiscussionSeq === discussionSequence
            ? { prDiscussion: discussion === null ? null : { comments: discussion.comments, reviews: discussion.reviews } }
            : {}),
          // Checks are commit-specific. A failed/unsupported refresh must clear the prior head's
          // rollup instead of presenting it as if it described the new revision.
          prChecks: checks,
        });

        if (analyzeUrl !== null && analyzeGraphId !== null) {
          const partialRefresh = before.progressiveGraph !== null
            || isPartialPrGraphId(before.prPreparedGraphId);
          await get().prepareHeadGraph({ progressiveGraphDelivery: partialRefresh });
          // Successful projection replaces the revision object. If it did not, preparation either
          // failed, found no matching HEAD nodes, or was canceled by a soft close; all three keep
          // the prior review and therefore must keep its matching GitHub payload as well.
          restoreRetainedReviewFiles();
        } else {
          // Older/plain view sessions cannot build a head artifact. Re-run the synchronous review
          // against the immutable boot graph so the new GitHub hunks replace the synthesized diff;
          // using the already-reviewed artifact here would accidentally retain its old stamp.
          const previous = get();
          invalidateArtifactCaches();
          set({
            artifact: bootReviewBaseline.artifact,
            index: bootReviewBaseline.index,
            coverage: previous.coverageMode ? computeCoverage(bootReviewBaseline.artifact.nodes, bootReviewBaseline.artifact.edges) : null,
            codeView: null,
          });
          if (!applyPrReviewToMap(get, set, prFilesUrl, invalidateMinimalLayout, invalidateModuleLayout, invalidateArtifactCaches, {
            preserveReviewDiffOnly: true,
            viewedFilesLoading: prViewedFilesUrl !== null,
          })) {
            // The refreshed PR no longer intersects this extraction. Keep the old review rather than
            // silently replacing it with an empty/base canvas; the stale control remains retryable.
            invalidateArtifactCaches();
            const message = "The refreshed pull request no longer matches this graph.";
            set({
              artifact: previous.artifact,
              index: previous.index,
              coverage: previous.coverage,
              codeView: null,
              prReviewBlocked: null,
              prReviewStatus: "error",
              prReviewProgress: reducePrReviewProgress(get().prReviewProgress, {
                type: "error",
                message,
              }),
              prPrepareError: message,
            });
            restoreRetainedReviewFiles();
          } else {
            await loadViewedFiles(number);
          }
        }
      } catch (error) {
        restoreRetainedReviewFiles();
        if (active()) {
          const message = refreshErrorMessage(error);
          set((current) => ({
            prReviewStatus: "error",
            prPrepareStage: null,
            prReviewProgress: reducePrReviewProgress(current.prReviewProgress, {
              type: "error",
              message,
            }),
            prPrepareError: message,
          }));
        }
      } finally {
        if (prReviewRefreshSeq === sequence && get().prReviewed === number) {
          set({ prReviewRefreshing: false });
        }
      }
    },

    // Once the selected PR's files are ready, a capable web session PREPARES first while the PRs
    // page remains visible. Only the swapped PR-head graph is allowed to enter the Map. A plain
    // view (no analyze capability) retains the synchronous loaded-artifact entry path.
    async reviewPrInGraph(options = {}) {
      const selected = get().prSelected;
      if (selected === null) {
        return;
      }
      if (get().prFiles === null) {
        const inFlight = prFilesRequest?.number === selected && prFilesRequest.sequence === prFilesSeq
          ? prFilesRequest.promise
          : get().selectPr(selected);
        await inFlight;
        if (get().prSelected !== selected || get().prFiles === null) {
          return;
        }
      }
      if (get().prReviewed === selected) {
        await get().resumePrReview(options);
        return;
      }
      // Selection is only browsing; pressing Review in graph is the commit point that replaces an
      // older parked session. Restore the immutable boot pair before preparing the new PR.
      const reviewed = get().prReviewed;
      if (reviewed !== null) {
        if (
          get().prPreparedArtifactCurrent
          && get().prReviewBaseline === null
          && !await ensureCompleteBootDocumentRestoreForTransition(
            reviewed,
            get().prPreparedGraphId,
            () => get().prSelected === selected && get().prReviewed === reviewed,
          )
        ) {
          return;
        }
        restoreSelectedPrReview(
          get,
          set,
          canonicalBootBaseline ?? bootReviewBaseline,
          () => restorePreparedReviewBaseline(get, set),
        );
      }
      if (analyzeUrl === null || analyzeGraphId === null) {
        await get().reviewPrOnBaseGraph();
        return;
      }
      // A double-click shares the one blocking entry promise; it must neither supersede the
      // sequence nor let a later caller observe completion before the one server run finishes.
      if (get().prReviewStatus === "preparing") {
        if (prReviewEntryRequest?.number === selected) {
          await prReviewEntryRequest.promise;
        }
        return;
      }
      const promise = get().prepareHeadGraph(options);
      const request = { number: selected, promise };
      prReviewEntryRequest = request;
      try {
        await promise;
      } finally {
        if (prReviewEntryRequest === request) {
          prReviewEntryRequest = null;
        }
      }
    },

    // The old synchronous entry is now deliberately narrow: no analyze capability, or the user's
    // explicit fallback after prepare-first failed. It never starts server preparation itself.
    async reviewPrOnBaseGraph() {
      const selected = get().prSelected;
      if (selected === null) {
        return;
      }
      if (get().prFiles === null) {
        const inFlight = prFilesRequest?.number === selected && prFilesRequest.sequence === prFilesSeq
          ? prFilesRequest.promise
          : get().selectPr(selected);
        await inFlight;
        if (get().prSelected !== selected || get().prFiles === null) {
          return;
        }
      }
      reviewProjectionFrameBaseline = null;
      if (applyPrReviewToMap(
        get,
        set,
        prFilesUrl,
        invalidateMinimalLayout,
        invalidateModuleLayout,
        invalidateArtifactCaches,
        { viewedFilesLoading: prViewedFilesUrl !== null },
      )) {
        await loadViewedFiles(selected);
      }
    },

    // Re-open a review whose overlay was soft-closed (explicit Close/lens switch) cheaply. Partial
    // reviews re-project their retained exact pair; only the explicit complete benchmark control
    // uses artifact GETs. Then re-project the PR through the current Tests setting so a toggle
    // changed while the workspace was parked is honored.
    async resumePrReview(options = {}) {
      const {
        prReviewed,
        prReviewSource,
        minimalSeedIds,
        prPreparedGraphId,
        prPreparedComparisonGraphId,
        prPreparedHeadSha,
        progressiveGraph: retainedProgressiveGraph,
        reviewActiveGroupId: resumeGroupId,
        reviewPathScope: resumePathScope,
      } = get();
      if (prReviewed === null || minimalSeedIds.length > 0) {
        return;
      }
      const retainedPartialOnly = isPartialOnlyProjection(retainedProgressiveGraph?.head ?? null)
        || isPartialPrGraphId(prPreparedGraphId);
      if (prReviewResumeRequest?.number === prReviewed) {
        await prReviewResumeRequest.promise;
        return;
      }
      prResumeProjectionAbort?.abort();
      prResumeProjectionAbort = null;
      const resumeSequence = ++prReviewResumeSeq;
      const resumeViewMode = get().viewMode;
      const resumeActive = () => (
        resumeSequence === prReviewResumeSeq
        && get().viewMode === resumeViewMode
        && get().prReviewed === prReviewed
        && get().minimalSeedIds.length === 0
        && get().prPreparedGraphId === prPreparedGraphId
        && get().prPreparedComparisonGraphId === prPreparedComparisonGraphId
        && get().prPreparedHeadSha === prPreparedHeadSha
      );
      // A normal Code Flow may have been opened on the base Map after the review overlay soft-
      // closed. It belongs to that Map, not the resumed review/head artifact; clear it before any
      // possible artifact swap so only a flow selected inside the review enters review mode.
      const clearResumeFlow = () => {
        const staleFlowOpen = get().flowSelection !== null;
        flowPaneLayoutSeq += 1;
        syntheticExecutionSeq += 1;
        set({
          moduleGhostInspection: null,
          ...requestFlowPaneReset(),
          ...syntheticExecutionReset(),
          syntheticExperimentRootId: null,
          syntheticInputOverrides: [],
          syntheticFieldWatchers: [],
          syntheticEditorRequest: null,
          logicSelected: null,
          reviewFlowBaseline: null,
          ...(staleFlowOpen
            ? {
                moduleSelected: new Set<string>(),
                reviewSelectedId: null,
                reviewLitNodeIds: null,
              }
            : {}),
        });
      };
      const promise = (async () => {
        if (prReviewSource !== null && prReviewSource.number === prReviewed) {
          set({
            prSelected: prReviewSource.number,
            prFiles: prReviewSource.files,
            prFilesTruncated: prReviewSource.truncated,
            prFilesTotal: prReviewSource.total,
            prFilesOutside: prReviewSource.outside,
            prFilesSuggestedSubdir: prReviewSource.suggestedSubdir,
          });
        }
        clearResumeFlow();
        const initialResumeStage: PrPrepareStage = prPreparedGraphId === null
          ? "projection"
          : "load-artifacts";
        set({
          prReviewStatus: "preparing",
          prPrepareStage: initialResumeStage,
          prReviewProgress: reducePrReviewProgress(createPrReviewProgressSnapshot(prReviewed), {
            type: "stage",
            stage: initialResumeStage,
          }),
          prPrepareError: null,
        });
        try {
          if (prPreparedGraphId !== null) {
            let headProjection: GraphProjectionV1 | null = null;
            let comparisonProjection: GraphProjectionV1 | null = null;
            let prepared: PreparedGraphSession | null = null;
            let comparison: GraphArtifact | null = null;
            const partialResumeRequested = retainedPartialOnly
              || options.progressiveGraphDelivery === true
              || (
                options.progressiveGraphDelivery === undefined
                && retainedProgressiveGraph !== null
              );
            if (partialResumeRequested && graphProjectUrl !== null && graphSymbolsUrl !== null) {
              const projectionController = new AbortController();
              prResumeProjectionAbort = projectionController;
              let projectionTransportInFlight = false;
              try {
                const depth = DEFAULT_PROGRESSIVE_GRAPH_DEPTH;
                const prefetchDepth = INITIAL_PROGRESSIVE_GRAPH_PREFETCH_DEPTH;
                projectionTransportInFlight = true;
                const [capability, projectedHead, projectedComparison] = await Promise.all([
                  fetchPreparedSyntheticCapabilityForGraph(metaUrl, prPreparedGraphId, {
                    repository: dependencies.prSessionSource?.repository ?? null,
                    headSha: prPreparedHeadSha,
                  }),
                  fetchGraphProjection(
                    graphProjectUrl,
                    changedFileProjectionRequest(prPreparedGraphId, prPreparedGraphId, depth, prefetchDepth),
                    { signal: projectionController.signal },
                  ),
                  prPreparedComparisonGraphId === null
                    ? Promise.resolve(null)
                    : fetchGraphProjection(
                        graphProjectUrl,
                        changedFileProjectionRequest(
                          prPreparedComparisonGraphId,
                          prPreparedGraphId,
                          depth,
                          prefetchDepth,
                        ),
                        { signal: projectionController.signal },
                      ),
                ]);
                projectionTransportInFlight = false;
                if (!isProgressiveProjectionPairReady(projectedHead, projectedComparison)) {
                  throw new Error("the retained graph projection is not ready through depth 1");
                }
                projectionTransportInFlight = true;
                const hydratedHead = await hydrateHeadProjectionForComparisonContext(
                  graphProjectUrl,
                  projectedHead,
                  projectedComparison,
                  { signal: projectionController.signal },
                );
                projectionTransportInFlight = false;
                headProjection = hydratedHead;
                comparisonProjection = projectedComparison;
                prepared = { artifact: projectionToArtifact(hydratedHead), ...capability };
                comparison = projectedComparison === null ? null : projectionToArtifact(projectedComparison);
              } catch (error) {
                if (projectionController.signal.aborted || !resumeActive()) throw error;
                // The registered artifacts are bounded sources. Loading either through `/api/graph`
                // would erase their readiness/frontier contract and manufacture completeness.
                throw new Error("the retained partial graph projection is unavailable", { cause: error });
              } finally {
                // A failed capability/head/comparison lane must not leave live siblings consuming
                // projector CPU. After every response body was consumed, leave the signal settled
                // so Chromium can publish loadingFinished authoritatively.
                if (projectionTransportInFlight) projectionController.abort();
                if (prResumeProjectionAbort === projectionController) prResumeProjectionAbort = null;
              }
            }
            if (prepared === null && partialResumeRequested) {
              // Missing capabilities are a protocol failure, never permission to load the bounded
              // source through the complete-artifact endpoint.
              throw new Error("the retained partial graph projection is unavailable");
            }
            if (prepared === null) {
              [prepared, comparison] = await Promise.all([
                fetchPreparedGraphSession(get().graphUrl, metaUrl, prPreparedGraphId, {
                  repository: dependencies.prSessionSource?.repository ?? null,
                  headSha: prPreparedHeadSha,
                }),
                prPreparedComparisonGraphId === null
                  ? Promise.resolve(null)
                  : fetchPreparedArtifact(get().graphUrl, prPreparedComparisonGraphId),
              ]);
            }
            if (!resumeActive()) {
              return; // the review moved on (or resumed elsewhere) while the artifact was in flight.
            }
            // The base Map stayed interactive during the fetch. Clear once more so a Code Flow opened
            // in that window cannot ride the stale base-artifact ref across the head-graph swap.
            clearResumeFlow();
            invalidateSyntheticArtifactBoundary();
            swapToPreparedArtifact(get, set, prepared.artifact, invalidateArtifactCaches, prepared, comparison);
            invalidateProgressiveRequests();
            set((current) => ({
              prPrepareStage: "projection",
              prReviewProgress: reducePrReviewProgress(current.prReviewProgress, {
                type: "stage",
                stage: "projection",
              }),
              progressiveGraph: headProjection === null ? null : {
                head: headProjection,
                comparison: comparisonProjection,
                explicitFileIds: [],
                affectedDepth: headProjection.loadedDepth,
                requestedDepth: headProjection.requestedDepth,
                status: "ready",
                error: null,
              },
              progressiveSymbols: {
                status: "idle",
                graphId: null,
                generation: null,
                symbols: [],
                indexed: 0,
                total: 0,
                error: null,
              },
            }));
          }
          const resumed = applyPrReviewToMap(
            get,
            set,
            prFilesUrl,
            invalidateMinimalLayout,
            invalidateModuleLayout,
            invalidateArtifactCaches,
            {
              reprojecting: true,
              preserveReviewSelection: true,
              viewedFilesLoading: prViewedFilesUrl !== null,
            },
          );
          if (!resumed) {
            // A corrupted/mutated retained payload must never leave the prepared HEAD artifact
            // active behind a closed overlay. Sync reviews do not swap, but surface the same honest
            // retry state instead of leaving Resume stuck on "preparing".
            if (prPreparedGraphId !== null) {
              restorePreparedReviewBaseline(get, set, { endSession: false });
            }
            const message = "The retained pull request no longer matches this graph.";
            set({
              prReviewStatus: "error",
              prPrepareStage: null,
              prReviewProgress: reducePrReviewProgress(get().prReviewProgress, {
                type: "error",
                message,
              }),
              prPrepareError: message,
            });
            return;
          }
          if (get().minimalMemberIds.length === 0) {
            performanceMark("meridian:first-actionable-canvas", { nodes: 0, edges: 0 });
            scheduleProgressiveSymbolIndex();
            scheduleProgressiveLookahead();
          }
          await loadViewedFiles(prReviewed);
          if (!resumeActive() && get().minimalSeedIds.length === 0) {
            return;
          }
          // Rebuild the reader's lightweight review context, not the entire PR. Each selector
          // invalidates the full pass that applyPrReviewToMap just queued before that pass derives,
          // so a scoped Resume remains cheap even for a repository-wide change.
          get().selectReviewGroup(resumeGroupId);
          get().selectReviewPathScope(resumePathScope);
          if (resumeSequence === prReviewResumeSeq && get().prReviewed === prReviewed) {
            set((current) => ({
              prReviewStatus: "idle",
              prPrepareStage: null,
              prReviewProgress: reducePrReviewProgress(current.prReviewProgress, { type: "success" }),
              prPrepareError: null,
            }));
          }
        } catch (error) {
          if (resumeActive()) {
            const message = resumeErrorMessage(error);
            set((current) => ({
              prReviewStatus: "error",
              prPrepareStage: null,
              prReviewProgress: reducePrReviewProgress(current.prReviewProgress, {
                type: "error",
                message,
              }),
              prPrepareError: message,
            }));
          }
        }
      })();
      const request = { number: prReviewed, promise };
      prReviewResumeRequest = request;
      try {
        await promise;
      } finally {
        if (prReviewResumeRequest === request) {
          prReviewResumeRequest = null;
        }
      }
    },

    // Prepare-first entry (and the fallback review's manual "Extract head graph"): stream the
    // clone→checkout→extract analysis, SWAP the loaded artifact for the prepared head-accurate one,
    // then run the review so marking, seeds, and line diff all compute in HEAD coordinates. The
    // stale-seq + identity guards drop a canceled entry, PR switch, or PRs-lens exit.
    async prepareHeadGraph(options = {}) {
      const state = get();
      const prNumber = state.prReviewed ?? state.prSelected;
      const enteringFromPrs = state.prReviewed === null;
      const refreshingExistingReview = !enteringFromPrs && state.prReviewRefreshing;
      const summary = selectedPrSummary(state, prNumber);
      // A refresh/manual re-extract can start while an older prepared review is still current.
      // Keep that exact graph as a transactional fallback: a clone/fetch/derive failure must not
      // throw the reader back to the boot graph or discard the review they were looking at.
      const previousPrepared = !enteringFromPrs && state.prPreparedArtifactCurrent
        ? {
            artifact: state.artifact,
            index: state.index,
            comparison: state.prReviewComparison,
            coverage: state.coverage,
            graphId: state.prPreparedGraphId,
            comparisonGraphId: state.prPreparedComparisonGraphId,
            mergeBaseSha: state.prPreparedMergeBaseSha,
            headSha: state.prPreparedHeadSha,
            syntheticExecutionUrl: state.syntheticExecutionUrl,
            syntheticScenarios: [...state.syntheticScenarios],
            syntheticExecutionTrust: state.syntheticExecutionTrust,
            baseNodeIds: state.reviewBaseNodeIds,
            deletedNodeIds: state.reviewDeletedNodeIds,
            baseSpanByHeadId: state.reviewBaseSpanByHeadId,
            progressiveGraph: settledProgressiveSession(state.progressiveGraph),
            progressiveSymbols: settledProgressiveSymbols(state.progressiveSymbols),
            progressivePendingNodeIds: new Set<string>(),
          }
        : null;
      if (
        prNumber === null
        || analyzeUrl === null
        || analyzeGraphId === null
        || summary === null
        || (enteringFromPrs && state.viewMode !== "prs")
      ) {
        return;
      }
      // Request partial-only preparation independently from this render document's advertised
      // consumption capabilities. Missing projection/symbol endpoints must fail closed; sending
      // `progressive: false` would make the server do the full extraction we are avoiding.
      const progressivePreparationRequested = options.progressiveGraphDelivery !== false;
      const progressivePreparationEnabled = progressivePreparationRequested
        && graphProjectUrl !== null
        && graphSymbolsUrl !== null;
      if (!guardReviewLineComposerTransition(() => { void get().prepareHeadGraph(options); })) {
        return;
      }
      // A direct manual re-run supersedes the prior action just like Retry does through
      // reviewPrInGraph; resolve its public waiter while its guarded stream drains.
      prAnalyzeCancellation?.resolve();
      prPrepareProjectionAbort?.abort();
      prPrepareProjectionAbort = null;
      const supersededHandoff = prGraphHandoff;
      prGraphHandoff = null;
      void supersededHandoff?.release().catch(() => undefined);
      const sequence = ++prAnalyzeSeq;
      let resolveCanceled!: () => void;
      const canceled = new Promise<void>((resolve) => {
        resolveCanceled = resolve;
      });
      const cancellation = { sequence, resolve: resolveCanceled };
      prAnalyzeCancellation = cancellation;
      let readyPairEntered = false;
      const active = () => {
        const current = get();
        return prAnalyzeSeq === sequence
          && current.prSelected === prNumber
          && (enteringFromPrs
            ? readyPairEntered
              ? current.viewMode === "modules"
                && current.prReviewed === prNumber
                && current.prPreparedArtifactCurrent
              : current.viewMode === "prs" && current.prReviewed === null
            : current.prReviewed === prNumber)
          && (!refreshingExistingReview
            || (current.prReviewRefreshing && current.viewMode === "modules" && current.minimalSeedIds.length > 0));
      };
      let resolveActionable!: () => void;
      let actionableSettled = false;
      const actionable = new Promise<void>((resolve) => {
        resolveActionable = resolve;
      });
      const settleActionable = () => {
        if (actionableSettled) return;
        actionableSettled = true;
        resolveActionable();
      };
      const progressBase = state.prReviewProgress.status === "running"
        && state.prReviewProgress.prNumber === prNumber
        && (
          state.prReviewProgress.steps.artifacts === "active"
          || state.prReviewProgress.steps.artifacts === "done"
        )
        && state.prReviewProgress.steps.projection === "pending"
        ? state.prReviewProgress
        : createPrReviewProgressSnapshot(prNumber);
      set({
        prReviewStatus: "preparing",
        // Ref resolution and verified cache reads happen before a miss can truthfully report clone.
        prPrepareStage: "resolve",
        prReviewProgress: reducePrReviewProgress(progressBase, {
          type: "stage",
          stage: "resolve",
        }),
        prPrepareError: null,
        ...(previousPrepared === null
          ? {
              prPreparedGraphId: null,
              prPreparedComparisonGraphId: null,
              prPreparedMergeBaseSha: null,
              prPreparedHeadSha: null,
              prReviewComparison: null,
              reviewBaseNodeIds: new Set<string>(),
              reviewDeletedNodeIds: new Set<string>(),
              reviewBaseSpanByHeadId: new Map<string, LineRange>(),
            }
          : {}),
        prReviewBlocked: null,
      });
      let graphHandoff: GraphViewLeaseHandoff | null = null;
      const settleGraphHandoff = async (action: "commit" | "release") => {
        const handoff = graphHandoff;
        if (handoff === null) return;
        await handoff[action]();
        if (graphHandoff === handoff) graphHandoff = null;
        if (prGraphHandoff === handoff) prGraphHandoff = null;
      };
      type PreparedSnapshot = NonNullable<typeof previousPrepared>;
      const captureCurrentPrepared = (): PreparedSnapshot | null => {
        const current = get();
        return current.prPreparedArtifactCurrent
          ? {
              artifact: current.artifact,
              index: current.index,
              comparison: current.prReviewComparison,
              coverage: current.coverage,
              graphId: current.prPreparedGraphId,
              comparisonGraphId: current.prPreparedComparisonGraphId,
              mergeBaseSha: current.prPreparedMergeBaseSha,
              headSha: current.prPreparedHeadSha,
              syntheticExecutionUrl: current.syntheticExecutionUrl,
              syntheticScenarios: [...current.syntheticScenarios],
              syntheticExecutionTrust: current.syntheticExecutionTrust,
              baseNodeIds: current.reviewBaseNodeIds,
              deletedNodeIds: current.reviewDeletedNodeIds,
              baseSpanByHeadId: current.reviewBaseSpanByHeadId,
              progressiveGraph: settledProgressiveSession(current.progressiveGraph),
              progressiveSymbols: settledProgressiveSymbols(current.progressiveSymbols),
              progressivePendingNodeIds: new Set(current.progressivePendingNodeIds),
            }
          : null;
      };
      const restorePrepared = (snapshot: PreparedSnapshot | null) => {
        if (snapshot === null) {
          return false;
        }
        invalidateSyntheticArtifactBoundary();
        invalidateArtifactCaches();
        invalidateProgressiveRequests();
        set({
          artifact: snapshot.artifact,
          index: snapshot.index,
          prReviewComparison: snapshot.comparison,
          coverage: snapshot.coverage,
          codeView: null,
          prPreparedArtifactCurrent: true,
          prPreparedGraphId: snapshot.graphId,
          prPreparedComparisonGraphId: snapshot.comparisonGraphId,
          prPreparedMergeBaseSha: snapshot.mergeBaseSha,
          prPreparedHeadSha: snapshot.headSha,
          syntheticExecutionUrl: snapshot.syntheticExecutionUrl,
          syntheticScenarios: [...snapshot.syntheticScenarios],
          syntheticExecutionTrust: snapshot.syntheticExecutionTrust,
          reviewBaseNodeIds: snapshot.baseNodeIds,
          reviewDeletedNodeIds: snapshot.deletedNodeIds,
          reviewBaseSpanByHeadId: snapshot.baseSpanByHeadId,
          progressiveGraph: snapshot.progressiveGraph,
          progressiveSymbols: snapshot.progressiveSymbols,
          progressivePendingNodeIds: snapshot.progressivePendingNodeIds,
          prReviewBlocked: null,
        });
        return true;
      };
      const installPreparedPair = async (
        analysis: PrAnalysisResult,
        delivery: "partial" | "benchmark",
      ): Promise<boolean> => {
        if (!active()) return false;
        const rollback = captureCurrentPrepared() ?? previousPrepared;
        set((current) => ({
          prPrepareStage: "handoff",
          prReviewProgress: reducePrReviewProgress(
            delivery === "benchmark"
              ? reducePrReviewProgress(current.prReviewProgress, {
                  type: "analysis-done",
                  cache: analysis.cache,
                })
              : current.prReviewProgress,
            { type: "stage", stage: "handoff" },
          ),
        }));
        try {
          // Protect the new pair before either artifact fetch begins. The controller unions it with
          // the currently mounted pair, so a refresh keeps its visible source alive until the new
          // bounded pair is installed transactionally.
          graphHandoff = await graphViewLease?.beginPreparedGraphHandoff([
            analysis.graphId,
            ...(analysis.comparisonGraphId === null ? [] : [analysis.comparisonGraphId]),
          ]) ?? null;
          if (graphHandoff !== null) prGraphHandoff = graphHandoff;
          if (!active()) {
            await settleGraphHandoff("release");
            return false;
          }
          set((current) => ({
            prPrepareStage: "load-artifacts",
            prReviewProgress: reducePrReviewProgress(current.prReviewProgress, {
              type: "stage",
              stage: "load-artifacts",
            }),
          }));
          // SWAP: load the pair and make HEAD current before deriving the review.
          const reusesBootHead = analysis.graphId === analyzeGraphId;
          const progressiveBefore = get().progressiveGraph;
          const progressiveDepth = Math.max(
            DEFAULT_PROGRESSIVE_GRAPH_DEPTH,
            progressiveBefore?.requestedDepth ?? DEFAULT_PROGRESSIVE_GRAPH_DEPTH,
          );
          // The boot projection retains its depth-1/depth-3 cache key. Once the reader explicitly
          // expands context, every later projection is exact-depth so no hidden N+1 work is retained.
          const progressivePrefetchDepth = progressiveDepth === DEFAULT_PROGRESSIVE_GRAPH_DEPTH
            ? INITIAL_PROGRESSIVE_GRAPH_PREFETCH_DEPTH
            : progressiveDepth;
          let headProjection: GraphProjectionV1 | null = null;
          let comparisonProjection: GraphProjectionV1 | null = null;
          let prepared: PreparedGraphSession | null = null;
          let comparison: GraphArtifact | null = null;
          if (delivery === "partial" && progressivePreparationEnabled && graphProjectUrl !== null) {
            const projectionController = new AbortController();
            prPrepareProjectionAbort = projectionController;
            let projectionTransportInFlight = false;
            try {
              projectionTransportInFlight = true;
              const capabilityPromise = reusesBootHead
                ? Promise.resolve({
                    syntheticExecutionUrl: initialSyntheticExecutionUrl,
                    syntheticExecutionTrust: initialSyntheticExecutionTrust,
                    syntheticScenarios: [...initialSyntheticScenarios],
                  })
                : fetchPreparedSyntheticCapabilityForGraph(metaUrl, analysis.graphId, {
                    repository: dependencies.prSessionSource?.repository ?? null,
                    headSha: analysis.headSha,
                  });
              const headProjectionPromise = reusesBootHead
                && initialGraphProjection?.graphId === analysis.graphId
                && initialGraphProjection.loadedDepth >= progressiveDepth
                ? Promise.resolve(initialGraphProjection)
                : fetchGraphProjection(
                    graphProjectUrl,
                    changedFileProjectionRequest(
                      analysis.graphId,
                      analysis.graphId,
                      progressiveDepth,
                      progressivePrefetchDepth,
                    ),
                    { signal: projectionController.signal },
                  );
              const comparisonProjectionPromise = analysis.comparisonGraphId === null
                ? Promise.resolve(null)
                : fetchGraphProjection(
                    graphProjectUrl,
                    changedFileProjectionRequest(
                      analysis.comparisonGraphId,
                      analysis.graphId,
                      progressiveDepth,
                      progressivePrefetchDepth,
                    ),
                    { signal: projectionController.signal },
                  );
              const explicitRequests = progressiveBefore !== null
                && progressiveBefore.explicitFileIds.length > 0
                ? fileProjectionRequests(
                    analysis.graphId,
                    progressiveBefore.explicitFileIds,
                    progressiveDepth,
                    progressivePrefetchDepth,
                  )
                : [];
              const explicitFragmentsPromise = Promise.all(explicitRequests.map((request) =>
                fetchGraphProjection(graphProjectUrl, request, { signal: projectionController.signal })));
              const [capability, projectedHead, projectedComparison, explicitFragments] = await Promise.all([
                capabilityPromise,
                headProjectionPromise,
                comparisonProjectionPromise,
                explicitFragmentsPromise,
              ]);
              projectionTransportInFlight = false;
              if (!isProgressiveProjectionPairReady(projectedHead, projectedComparison)) {
                throw new Error(`prepared graph projection is not ready through depth ${progressiveDepth}`);
              }
              if (explicitFragments.some((fragment) =>
                !isProjectionReadyForCanvas(fragment)
                || !projectionRootsCompleteThrough(fragment, progressiveDepth),
              )) {
                throw new Error(`a selected graph root is not ready through depth ${progressiveDepth}`);
              }
              const projectedWithExplicit = explicitFragments.reduce(
                mergeGraphProjections,
                projectedHead,
              );
              projectionTransportInFlight = true;
              const hydratedHead = await hydrateHeadProjectionForComparisonContext(
                graphProjectUrl,
                projectedWithExplicit,
                projectedComparison,
                { signal: projectionController.signal },
              );
              projectionTransportInFlight = false;
              headProjection = hydratedHead;
              comparisonProjection = projectedComparison;
              prepared = { artifact: projectionToArtifact(hydratedHead), ...capability };
              comparison = projectedComparison === null ? null : projectionToArtifact(projectedComparison);
            } catch (error) {
              if (projectionController.signal.aborted || !active()) throw error;
              // A partial pair is a bounded extraction source, not a complete artifact. It may retry
              // the projector, but it may never bypass readiness through the ordinary graph route.
              throw new Error("the partial PR graph projection is unavailable", { cause: error });
            } finally {
              // Promise.all is fail-fast, so abort live siblings when one lane fails. Do not abort
              // after every response body was consumed: Chromium may otherwise publish ERR_ABORTED
              // for a valid projection transfer, making exact network accounting non-authoritative.
              if (projectionTransportInFlight) projectionController.abort();
              if (prPrepareProjectionAbort === projectionController) prPrepareProjectionAbort = null;
            }
          }
          if (prepared === null) {
            if (delivery === "partial") {
              throw new Error("partial PR graph delivery requires projection and symbol capabilities");
            }
            // The only complete-artifact installation left in this action is the explicit
            // `progressiveGraphDelivery: false` benchmark control. Production never reaches it.
            const bootCapability = {
              syntheticExecutionUrl: initialSyntheticExecutionUrl,
              syntheticExecutionTrust: initialSyntheticExecutionTrust,
              syntheticScenarios: [...initialSyntheticScenarios],
            };
            [prepared, comparison] = await Promise.all([
              reusesBootHead
                ? initialGraphProjection === null
                  ? Promise.resolve({ artifact: dependencies.artifact, ...bootCapability })
                  : fetchPreparedArtifact(get().graphUrl, analysis.graphId)
                      .then((artifact) => ({ artifact, ...bootCapability }))
                : fetchPreparedGraphSession(get().graphUrl, metaUrl, analysis.graphId, {
                    repository: dependencies.prSessionSource?.repository ?? null,
                    headSha: analysis.headSha,
                  }),
              analysis.comparisonGraphId === null
                ? Promise.resolve(null)
                : fetchPreparedArtifact(get().graphUrl, analysis.comparisonGraphId),
            ]);
          }
          if (!active()) {
            await settleGraphHandoff("release");
            return false;
          }
          // Capture interaction state only after all pair network work has settled. A reader
          // can open or close the source surface while that pair is loading; an earlier snapshot
          // would resurrect UI they deliberately dismissed.
          const interactionBefore = get();
          const preservedCodeView = delivery === "partial"
            && !enteringFromPrs
            && analysis.headSha !== null
            && interactionBefore.prPreparedHeadSha === analysis.headSha
            && interactionBefore.prPreparedMergeBaseSha === analysis.mergeBaseSha
            ? interactionBefore.codeView
            : null;
          const directProgressiveBaseline = enteringFromPrs && initialGraphProjection !== null
            ? canonicalBootBaseline
            : undefined;
          invalidateSyntheticArtifactBoundary();
          swapToPreparedArtifact(
            get,
            set,
            prepared.artifact,
            invalidateArtifactCaches,
            prepared,
            comparison,
            reusesBootHead && headProjection === initialGraphProjection ? dependencies.index : undefined,
            directProgressiveBaseline,
          );
          invalidateProgressiveRequests();
          set({
            // applyPrReviewToMap transitions from PRs to Map. It must not observe a cancelable
            // server-preparation lane and release the already-installed graph handoff.
            prReviewStatus: "idle",
            prPrepareStage: "projection",
            prReviewProgress: reducePrReviewProgress(get().prReviewProgress, {
              type: "stage",
              stage: "projection",
            }),
            prPrepareError: null,
            prPreparedGraphId: analysis.graphId,
            prPreparedComparisonGraphId: analysis.comparisonGraphId,
            prPreparedMergeBaseSha: analysis.mergeBaseSha,
            prPreparedHeadSha: analysis.headSha,
            progressiveGraph: headProjection === null ? null : {
              head: headProjection,
              comparison: comparisonProjection,
              explicitFileIds: [...(progressiveBefore?.explicitFileIds ?? [])],
              affectedDepth: Math.max(progressiveBefore?.affectedDepth ?? 0, headProjection.loadedDepth),
              requestedDepth: progressiveDepth,
              status: "ready",
              error: null,
            },
            progressiveSymbols: {
              status: "idle",
              graphId: null,
              generation: null,
              symbols: [],
              indexed: 0,
              total: 0,
              error: null,
            },
            progressivePendingNodeIds: new Set<string>(),
          });
          const entered = applyPrReviewToMap(
            get,
            set,
            prFilesUrl,
            invalidateMinimalLayout,
            invalidateModuleLayout,
            invalidateArtifactCaches,
            {
              preserveReviewDiffOnly: !enteringFromPrs,
              viewedFilesLoading: prViewedFilesUrl !== null,
            },
          );
          if (!entered) {
            // The zero-match decision was made against this exact HEAD. Roll back to the prior
            // prepared review when refreshing; first entry restores its prior graph.
            if (!restorePrepared(rollback)) {
              restorePreparedReviewBaseline(get, set, { endSession: enteringFromPrs });
            }
            if (!enteringFromPrs && previousPrepared === null) {
              set({
                prPreparedGraphId: null,
                prPreparedComparisonGraphId: null,
                prPreparedMergeBaseSha: null,
                prPreparedHeadSha: null,
                prReviewComparison: null,
              });
            }
            if (get().prReviewRefreshing) {
              const message = "The refreshed pull request no longer matches this graph.";
              set({
                prReviewStatus: "error",
                prPrepareStage: null,
                prReviewProgress: reducePrReviewProgress(get().prReviewProgress, {
                  type: "error",
                  message,
                }),
                prPrepareError: message,
              });
            } else {
              set((current) => ({
                prReviewStatus: "idle",
                prPrepareStage: null,
                prReviewProgress: reducePrReviewProgress(current.prReviewProgress, {
                  type: "error",
                  message: "The pull request no longer matches this graph.",
                }),
                prPrepareError: null,
              }));
            }
            await settleGraphHandoff("release");
            return false;
          } else {
            if (delivery === "partial") readyPairEntered = true;
            if (preservedCodeView !== null) {
              const current = get();
              const currentNode = current.index.nodesById.get(preservedCodeView.node.id);
              // Keep a source surface open when its node survived the refreshed bounded pair (or it
              // is a file-row source target whose reviewed path still exists).
              if (
                currentNode !== undefined
                || current.reviewFiles.some((file) => file.path === preservedCodeView.node.location.file)
              ) {
                set({
                  codeView: currentNode === undefined
                    ? preservedCodeView
                    : { ...preservedCodeView, node: currentNode },
                });
              }
            }
            if (get().minimalMemberIds.length === 0) {
              performanceMark("meridian:first-actionable-canvas", { nodes: 0, edges: 0 });
              scheduleProgressiveSymbolIndex();
              scheduleProgressiveLookahead();
            }
            set((current) => ({
              prReviewStatus: "idle",
              prPrepareStage: null,
              prReviewProgress: delivery === "benchmark"
                ? reducePrReviewProgress(current.prReviewProgress, { type: "success" })
                : current.prReviewProgress,
              prPrepareError: null,
            }));
            await settleGraphHandoff("commit");
            if (delivery === "partial" || !readyPairEntered) await loadViewedFiles(prNumber);
            return true;
          }
        } catch (error) {
          await settleGraphHandoff("release").catch(() => undefined);
          if (prAnalyzeSeq === sequence && get().prPreparedGraphId === analysis.graphId) {
            if (!restorePrepared(rollback)) {
              restorePreparedReviewBaseline(get, set, { endSession: enteringFromPrs });
            }
          }
          throw error;
        }
      };

      let readyInstall: Promise<boolean> = Promise.resolve(false);
      let readyLine: PrAnalysisReadyResult | null = null;
      const completePartialPreparation = (analysis: PrAnalysisResult) => {
        set((current) => ({
          prReviewStatus: "idle",
          prPrepareStage: null,
          prReviewProgress: reducePrReviewProgress(
            reducePrReviewProgress(current.prReviewProgress, {
              type: "analysis-done",
              cache: analysis.cache,
            }),
            { type: "success" },
          ),
          prPrepareError: null,
        }));
      };
      const work = (async () => {
        try {
          const request = {
            id: analyzeGraphId,
            prNumber,
            baseRef: summary.baseRef,
            headRef: summary.headRef,
            progressive: progressivePreparationRequested,
          };
          const analysis = await streamPrAnalysis(
            analyzeUrl,
            request,
            (stage, progress) => {
              if (active()) {
                set((current) => ({
                  // Once the canvas is actionable, later terminal bookkeeping must not put the
                  // visible review back into a blocking preparation state.
                  prPrepareStage: readyPairEntered ? null : stage,
                  prReviewProgress: reducePrReviewProgress(current.prReviewProgress, {
                    type: "stage",
                    stage,
                    progress,
                  }),
                }));
              }
            },
            (lane) => {
              if (active()) {
                set((current) => ({
                  prReviewProgress: reducePrReviewProgress(current.prReviewProgress, {
                    type: "lane-complete",
                    lane,
                  }),
                }));
              }
            },
            (ready) => {
              // A stream carries at most one pair for a preparation generation. Ignore duplicate
              // replay lines instead of attempting two graph handoffs concurrently.
              if (!progressivePreparationEnabled || readyLine !== null || !active()) return;
              readyLine = ready;
              readyInstall = installPreparedPair(ready, "partial").then((entered) => {
                if (entered) settleActionable();
                return entered;
              }).catch((error) => {
                // The terminal may replay the same bounded pair and retry its transactional load.
                console.warn("Partial PR graph unavailable; waiting for the bounded terminal retry.", error);
                return false;
              });
            },
          );
          // TypeScript cannot observe the assignment performed by the streamed callback above;
          // snapshot it after the await so the terminal pair can be bound to that exact emission.
          const completedReady = readyLine as PrAnalysisReadyResult | null;
          const readyEntered = await readyInstall;
          if (!active()) return;
          if (!progressivePreparationRequested) {
            await installPreparedPair(analysis, "benchmark");
            settleActionable();
            return;
          }

          const boundedTerminal = authoritativePartialAnalysisResult(analysis);
          if (boundedTerminal === null) {
            if (!readyEntered || !readyPairEntered) {
              throw new Error("partial PR preparation ended with a legacy complete terminal");
            }
            // Rolling servers may still append their old complete terminal after the bounded pair is
            // already authoritative. Ignore it: production neither projects nor fetches those ids.
            performanceMark("meridian:legacy-pr-terminal-ignored", { graphId: analysis.graphId });
            completePartialPreparation(analysis);
            return;
          }
          if (completedReady !== null && !samePartialAnalysisPair(completedReady, boundedTerminal)) {
            throw new Error("bounded PR graph terminal does not match the ready pair");
          }
          if (
            readyEntered
            && get().prPreparedGraphId === boundedTerminal.graphId
            && get().prPreparedComparisonGraphId === boundedTerminal.comparisonGraphId
          ) {
            completePartialPreparation(boundedTerminal);
            return;
          }
          await installPreparedPair(boundedTerminal, "partial");
          completePartialPreparation(boundedTerminal);
          settleActionable();
        } catch (error) {
          // `ready` starts an asynchronous graph transaction while the same reader keeps draining.
          // A terminal stream failure can therefore race the provisional fetch/handoff. Let that
          // transaction finish before touching its shared lease or deciding whether there is a
          // usable review to keep; otherwise the error path can release the handoff underneath a
          // pair that is about to become visible (and can return the entry action before it lands).
          await readyInstall;
          await settleGraphHandoff("release").catch(() => undefined);
          if (active()) {
            const message = prepareErrorMessage(error);
            if (readyPairEntered && get().prPreparedArtifactCurrent) {
              console.warn("Partial PR graph terminal failed; keeping the ready review.", error);
              set((current) => ({
                prReviewStatus: "idle",
                prPrepareStage: null,
                prPrepareError: null,
                progressiveGraph: current.progressiveGraph === null
                  ? null
                  : { ...current.progressiveGraph, status: "error", error: message },
              }));
            } else {
              set((current) => ({
                prReviewStatus: "error",
                prPrepareStage: null,
                prReviewProgress: reducePrReviewProgress(current.prReviewProgress, {
                  type: "error",
                  message,
                }),
                prPrepareError: message,
              }));
            }
          }
        } finally {
          settleActionable();
          if (prAnalyzeCancellation === cancellation) {
            prAnalyzeCancellation = null;
          }
        }
      })();
      // The entry action returns as soon as the depth-1 pair is installed. `work` drains only the
      // bounded terminal bookkeeping; complete extraction is not part of a progressive session.
      await Promise.race([work, canceled, actionable]);
    },

    cancelPrReviewPreparation() {
      const wasPreparing = get().prReviewStatus === "preparing";
      prAnalyzeSeq += 1;
      prReviewResumeSeq += 1;
      prPrepareProjectionAbort?.abort();
      prPrepareProjectionAbort = null;
      prResumeProjectionAbort?.abort();
      prResumeProjectionAbort = null;
      prReviewResumeRequest = null;
      const cancellation = prAnalyzeCancellation;
      prAnalyzeCancellation = null;
      cancellation?.resolve();
      const handoff = prGraphHandoff;
      prGraphHandoff = null;
      void handoff?.release().catch(() => undefined);
      set((current) => ({
        prReviewStatus: "idle",
        prPrepareStage: null,
        prReviewProgress: wasPreparing
          ? reducePrReviewProgress(current.prReviewProgress, { type: "canceled" })
          : current.prReviewProgress,
        prPrepareError: null,
      }));
    },

    dismissPrepareError() {
      const state = get();
      set({
        prReviewStatus: "idle",
        prPrepareStage: null,
        prReviewProgress: createPrReviewProgressSnapshot(state.prReviewed ?? state.prSelected),
        prPrepareError: null,
      });
    },

    async relayout() {
      // Post-unification, every graph lens with an ELK canvas is a module surface ("modules" /
      // "call" / "ui" — the registry decides): they all route through the ONE moduleRelayout.
      // Logic owns its own pass (logicRelayout) and the PRs page has no canvas.
      if (moduleSurfaceSpec(get().viewMode) !== null) {
        await get().moduleRelayout();
      }
    },
    };
  });
}

/**
 * Reviewing a PR lands on main's Module-map minimal-graph surface, seeded from the PR's changed
 * FILES and pre-expanded into their code blocks. The modified blocks (diff hunks ∩ node ranges)
 * are pushed into the shared `changedIds` channel so the cards ring exactly them amber, and the
 * affected logic flows fill the hierarchical panel beside the overlay. Same review CONTEXT a
 * `meridian review` artifact carries — only the render surface is main's, not a bespoke graph.
 * Extracted from the store so reviewPrInGraph can run it either directly (no analyze endpoint)
 * or after the streamed PR-head preparation lands.
 */
function applyPrReviewToMap(
  get: () => BlueprintState,
  set: (partial: Partial<BlueprintState>) => void,
  prFilesUrl: string,
  invalidateMinimalLayout: () => void,
  invalidateModuleLayout: () => void,
  invalidateArtifactCaches: () => void,
  options: {
    reprojecting?: boolean;
    preserveReviewSelection?: boolean;
    preserveReviewDiffOnly?: boolean;
    /** Set for a true entry/resume/head refresh that immediately hydrates GitHub viewer state. */
    viewedFilesLoading?: boolean;
    /** A caller that awaits the replacement layout can suppress this fire-and-forget pass. */
    scheduleLayout?: boolean;
  } = {},
): boolean {
  const {
    prFiles,
    prSelected,
    prFilesTotal,
    prFilesOutside,
    artifact: activeArtifact,
    index: activeIndex,
    prPreparedArtifactCurrent,
    prPreparedHeadSha,
    prReviewComparison,
    reviewBaseNodeIds: activeBaseNodeIds,
    review: liveReview,
    reviewTicks: liveReviewTicks,
    reviewUnitTicks: liveReviewUnitTicks,
    reviewFileTicks: liveReviewFileTicks,
    reviewComments: liveReviewComments,
  } = get();
  if (prSelected === null) {
    return false;
  }
  // "Swapped" == the loaded artifact IS the prepared PR-head graph: node locations are already
  // head-relative, so every base→head remap below must stand down (running it would corrupt an
  // already-correct coordinate space — the #134 machinery is for the base-graph sync mode only).
  const swapped = prPreparedArtifactCurrent;
  // Tests reprojection and refresh can re-enter while the presentation composite is current. Strip
  // its prior base-only overlay first so every pass starts from one pure HEAD coordinate space and
  // cannot duplicate tombstones/edges or let their old spans influence HEAD affected-node derivation.
  const headArtifact = swapped && activeBaseNodeIds.size > 0
    ? {
        ...activeArtifact,
        nodes: activeArtifact.nodes.filter((node) => !activeBaseNodeIds.has(node.id)),
        // Every admitted comparison edge is incident to a projected base node by construction.
        edges: activeArtifact.edges.filter((edge) =>
          !activeBaseNodeIds.has(edge.source) && !activeBaseNodeIds.has(edge.target)),
      }
    : activeArtifact;
  const headIndex = headArtifact === activeArtifact ? activeIndex : buildGraphIndex(headArtifact);
  // GitHub caps the PR-files endpoint, while line-less changes (fully deleted files, pure renames,
  // binary edits, and mode-only edits) cannot be reconstructed from patch hunks. A prepared HEAD
  // artifact carries Git's exact merge-base name-status transaction, so make that inventory the
  // review's authority and retain GitHub detail only for files the bounded response did include.
  const exactManifest = swapped ? changedFileManifestFromExtensions(headArtifact.extensions) : null;
  const reviewPrFiles = exactManifest === null
    ? (prFiles ?? [])
    : canonicalPrFiles(prFiles ?? [], headArtifact);
  const reviewFilesTotal = exactManifest === null
    ? prFilesTotal
    : Math.max(prFilesTotal, reviewPrFiles.length + prFilesOutside);
  const summary = selectedPrSummary(get());
  const prSessionSource = get().prSessionSource;
  const reviewKey = prSessionSource === null ? null : canonicalPrReviewScope(prSessionSource, prSelected);
  if (reviewKey === null) {
    set({ prReviewBlocked: { number: prSelected, reason: "This PR session has no stable GitHub repository scope" } });
    return false;
  }
  const rawContext = reviewContextFromPrFiles(
    {
      prNumber: prSelected,
      headRef: summary?.headRef ?? null,
      baseRef: summary?.baseRef ?? null,
      reviewKey,
      files: reviewPrFiles,
    },
    // Base-side hunks mark base coordinates — right for the boot artifact, wrong for a head graph.
    { baseSide: !swapped },
  );
  const contentPrFiles = filterFormattingOnlyPrFiles(
    reviewPrFiles,
    get().reviewExcludeFormatOnlyChanges,
  );
  const rawPrFileByPath = new Map(reviewPrFiles.map((file) => [file.path, file]));
  const formattingFilteredPaths = new Set(
    contentPrFiles
      .filter((file) => rawPrFileByPath.get(file.path) !== file)
      .map((file) => file.path),
  );
  const context = reviewContextFromPrFiles(
    {
      prNumber: prSelected,
      headRef: summary?.headRef ?? null,
      baseRef: summary?.baseRef ?? null,
      reviewKey,
      files: contentPrFiles,
    },
    { baseSide: !swapped },
  );
  const projectionDiffLines = diffLinesByPrPath(contentPrFiles);
  // A refresh re-enters this same reviewKey. Carry the in-memory progress directly so drafts made
  // while persistence is unavailable (or while the refresh request is in flight) cannot disappear.
  const liveProgress = liveReview?.context.reviewKey === context.reviewKey
    ? {
        ticks: liveReviewTicks,
        unitTicks: liveReviewUnitTicks,
        fileTicks: liveReviewFileTicks,
        comments: liveReviewComments,
      }
    : null;
  const projection = deriveReviewProjection(context, headArtifact, headIndex, {
    // Deleted impact and test classification must use the same exact merge-base Git diff used to
    // build the prepared artifact. The boot graph may represent a newer base tip.
    baseIndex: swapped ? (prReviewComparison?.index ?? null) : null,
    baseArtifact: swapped ? (prReviewComparison?.artifact ?? null) : null,
    showTests: get().showTests,
    hideSourceCommentDiffs: get().reviewHideAddedSourceCommentDiffs,
    diffLines: projectionDiffLines,
  });
  const { review, visibleContext } = projection;
  const headMatchedFiles = matchAffectedFiles(
    headIndex,
    visibleContext.changedFiles.map((file) => file.path),
  ).matched;
  const reviewedHeadArtifact =
    changedRangesFromExtensions(headArtifact.extensions) !== null && !hasPrReviewLineDiff(headArtifact)
      ? headArtifact
      : withPrLineDiff(headArtifact, headIndex, visibleContext, headMatchedFiles, prSelected);
  const deletedProjection: DeletedNodeProjection = swapped && prReviewComparison !== null
    ? deriveDeletedNodeProjection({
        headArtifact: reviewedHeadArtifact,
        headIndex,
        baseArtifact: prReviewComparison.artifact,
        baseIndex: prReviewComparison.index,
        // Compose the complete reviewable projection before the Tests filter. Formatting-only
        // changes have already been proven and removed; raw PR seeds below remain the workspace
        // sentinel so an all-format review can still open and turn the preference back off.
        context,
        prFiles: contentPrFiles,
        effectiveDiffPaths: formattingFilteredPaths,
      })
    : emptyDeletedNodeProjection(reviewedHeadArtifact, headIndex);
  const artifact = deletedProjection.artifact;
  const index = deletedProjection.index;
  const visiblePaths = new Set(visibleContext.changedFiles.map((file) => file.path));
  const visibleDeletedFiles = deletedProjection.files.filter((file) => visiblePaths.has(file.path));
  const headAffected = swapped && prReviewComparison !== null
    ? preparedHeadAffected(
        visibleContext,
        contentPrFiles,
        reviewedHeadArtifact,
        headIndex,
        deletedProjection.survivingAffectedHeadIds,
      )
    : projection.affected;
  const deletedAffected = visibleDeletedFiles.flatMap((file) => file.affected);
  const affected = mergeAffectedNodes(headAffected, deletedAffected);
  const files = mergeDeletedReviewFiles(projection.files, headAffected, visibleDeletedFiles, index);

  // Gate entry on the COMPLETE two-sided graph before applying the Tests projection. A deletion-
  // only PR now resolves through its merge-base module instead of being rejected by a HEAD-only
  // seed check. An all-test PR still opens an intentionally empty workspace with Tests off.
  const allMatchedFiles = matchAffectedFiles(index, rawContext.changedFiles.map((file) => file.path)).matched;
  const allRollup = rollupSeeds(allMatchedFiles, index);
  const progressivePair = get().progressiveGraph;
  const manifestOnlyProgressivePair = exactManifest !== null
    && progressivePair !== null
    && isProgressiveManifestOnlyPairReady(progressivePair.head, progressivePair.comparison);
  if (allRollup.seeds.length === 0 && !manifestOnlyProgressivePair) {
    const allOutside = reviewPrFiles.length === 0 && prFilesOutside > 0;
    const changedFileCount = reviewFilesTotal > 0 ? reviewFilesTotal : reviewPrFiles.length + prFilesOutside;
    set({
      prReviewBlocked: {
        number: prSelected,
        reason: allOutside
          ? "This PR's changes are outside this session's subfolder"
          : `None of this PR's ${changedFileCount} changed files match this session's graph`,
      },
    });
    return false;
  }
  // A first entry/manual re-extract owes every shared lens-transition side effect. An in-place
  // refresh is already on this review surface; its final atomic state replaces the old overlay.
  if (!get().prReviewRefreshing && !options.reprojecting) {
    if (!beginLensTransition(get, set)) return false;
  }
  // Test files are excluded before every graph/checklist derivation. Keep the complete PR's seeds
  // only as an invisible workspace sentinel when ALL matched changes are tests: minimalMemberIds
  // remains empty, so no hidden test card can leak onto the canvas, while the review panel and the
  // toolbar toggle stay mounted.
  const matchedFiles = matchAffectedFiles(index, visibleContext.changedFiles.map((file) => file.path)).matched;
  const { seeds: visibleSeeds, rolledUp } = rollupSeeds(matchedFiles, index);
  const workspaceSeeds = visibleSeeds.length > 0 ? visibleSeeds : allRollup.seeds;
  const fileBindings = bindReviewFiles(
    reviewPrFiles,
    headIndex,
    swapped ? (prReviewComparison?.index ?? null) : null,
    deletedProjection,
  );
  // The synchronous review's graph is base-relative while patch kinds are head-relative. Preserve
  // each file's edit map beside its exact kinds so node spans can be translated before colouring.
  // A prepared graph instead reads its own authoritative, already-aligned changedSince stamp.
  const reviewDiffByFile = Object.create(null) as Record<
    string,
    { edits: LineEdit[]; kinds: ChangedLineSpan[] }
  >;
  const reviewDiffLinesByFile = Object.create(null) as Record<string, ChangedDiffLine[]>;
  if (!swapped) {
    for (const binding of fileBindings) {
      if (binding.file.diffComplete !== false && binding.file.edits && binding.file.edits.length > 0) {
        for (const locFile of binding.headFiles) {
          reviewDiffByFile[locFile] = { edits: binding.file.edits, kinds: binding.file.kinds ?? [] };
        }
      }
    }
  }
  const canonicalDiffLines = swapped ? changedDiffLinesFromExtensions(reviewedHeadArtifact.extensions) : null;
  for (const binding of fileBindings) {
    // `binding.file` carries GitHub's U3 source-comment proof merged onto the exact local rows.
    // Prefer it over the artifact's otherwise-identical U0 rows so deleted/interior comment edits
    // stay filterable after the prepared HEAD graph replaces the synchronous review.
    const rows = binding.file.diffComplete !== false
      ? (binding.file.diffLines ?? valueForReviewAliases(canonicalDiffLines, binding.aliases))
      : undefined;
    if (!rows || rows.length === 0) continue;
    for (const locFile of binding.aliases) reviewDiffLinesByFile[locFile] = rows;
  }
  // Source previews and comment anchors above deliberately keep the lossless raw rows. Node/flow
  // colouring must instead consume the same effective edit runs as the affected-node projection;
  // otherwise a hidden rewrap could leave a gold node behind or taint a mixed semantic edit.
  const statusKinds = Object.create(null) as Record<string, ChangedLineSpan[]>;
  const statusDiffLines = Object.create(null) as Record<string, ChangedDiffLine[]>;
  const statusEdits = Object.create(null) as Record<string, LineEdit[]>;
  const contentBindings = bindReviewFiles(
    contentPrFiles,
    headIndex,
    swapped ? (prReviewComparison?.index ?? null) : null,
    deletedProjection,
  );
  for (const binding of contentBindings) {
    const aliases = swapped ? binding.aliases : binding.headFiles;
    const rawEdits = rawPrFileByPath.get(binding.file.path)?.edits;
    for (const locFile of aliases) {
      statusKinds[locFile] = binding.file.kinds ?? [];
      if (binding.file.diffLines && binding.file.diffLines.length > 0) {
        statusDiffLines[locFile] = binding.file.diffLines;
      }
      // A synchronous review still paints BASE-coordinate graph nodes, so retain the complete raw
      // base→HEAD transform even though only semantic kinds/rows remain eligible for colouring.
      if (!swapped && rawEdits && rawEdits.length > 0) {
        statusEdits[locFile] = rawEdits;
      }
    }
  }
  const artifactStatusDiff = formattingAwareArtifactDiff(
    reviewedHeadArtifact,
    get().reviewExcludeFormatOnlyChanges,
  );
  const nodeStatusSources = swapped
    ? reviewNodeStatusSourcesFromDiff(
        artifactStatusDiff.kinds,
        artifactStatusDiff.diffLines,
      )
    : reviewNodeStatusSourcesFromDiff(
        statusKinds,
        statusDiffLines,
        statusEdits,
      );
  // The changed code blocks (hunks ∩ node ranges); repaint main's changed-node channel to THIS PR.
  applyChangedIds(index, affected.map((node) => node.nodeId));
  // Colour each touched CODE BLOCK by its own exact edits: additions-only green, deletions-only red,
  // replacements/mixed edits gold. Fall back to the file status when exact kinds are unavailable.
  applyChangedStatus(index, [
    ...reviewNodeStatusEntries(index, headAffected, nodeStatusSources),
    ...deletedAffected.map((entry) => [entry.nodeId, "deleted" as const] as const),
  ]);
  // Partition the change into disjoint groups (one per weakly-connected component of the changed
  // modules), sharing the SAME flow substrate the review rows already read. Stored so the rail can
  // offer per-group isolation; ignored (strip hidden) when the change is a single connected component.
  // Review grouping remains a HEAD/change topology decision. Comparison edges exist solely to make
  // a selected tombstone's historical execution neighbourhood visible; they must not merge groups.
  const changeGroups = computeChangeGroups(
    artifact.nodes,
    reviewedHeadArtifact.edges,
    visibleContext.changedFiles,
    review.flows,
  );
  // GitHub's whole-file +N/-M churn per changed file, keyed by node.location.file, for the marker a
  // changed FILE card shows before its name (files aren't coloured; only their touched blocks are).
  const artifactStats = swapped ? changedLineStatsFromExtensions(reviewedHeadArtifact.extensions) : null;
  const reviewFileDelta = Object.create(null) as Record<
    string,
    { added: number; deleted: number; status?: PrFileStatus }
  >;
  for (const binding of fileBindings) {
    const fallback = {
      added: binding.file.additions,
      deleted: binding.file.deletions,
      status: binding.file.status,
    };
    const canonical = valueForReviewAliases(artifactStats, binding.aliases);
    const delta = canonical ? { ...canonical, status: binding.file.status } : fallback;
    for (const locFile of binding.aliases) reviewFileDelta[locFile] = delta;
  }
  // ONE source of truth for the line-level changedSince channel (the code panel's </> diff): the
  // artifact's OWN stamp when it carries one — the prepared PR-head artifact does, computed by the
  // extract pipeline from the real merge-base git diff, keyed by the extractor's own location.file
  // paths, with true added/modified/deleted span kinds and no truncation. The client-side join from
  // the GitHub patch hunks is strictly weaker (suffix-matched paths, "added"-only kinds, and it
  // silently misses files whenever the server capped the PR file list), so it remains only as the
  // fallback for a boot artifact that carries no stamp (the synchronous, no-analyze-endpoint path).
  const reviewedArtifact = artifact;
  // Pre-expand the packages and file modules on the path to each changed file (packages too,
  // else deriveModuleTree never descends to the file — mirrors flowExplorer's
  // expandedModulePaths): review reads at declaration level (class/type cards), so classes stay
  // collapsed "N members" cards and blocks never chart flow steps — drilling deeper stays a
  // manual gesture.
  const expanded = expandedCodePaths(
    reviewExpansionForMatches(index, matchedFiles, rolledUp),
    new Set(deletedAffected.map((entry) => entry.nodeId)),
    index,
  );
  // The review owns the only mounted graph surface. Cancel and release the covered source Map
  // instead of deriving and retaining a second complete ELK/ReactFlow scene for large PRs. Closing
  // the review rebuilds the restored boot Map through the guarded path in closeMinimalGraph.
  if (activeBaseNodeIds.size > 0 || deletedProjection.baseSourceNodeIds.size > 0) {
    invalidateArtifactCaches();
  } else {
    invalidateModuleLayout();
    invalidateMinimalLayout();
  }
  // Capture the head ref + each changed file's real per-line diff (old/new spans + head-relative
  // added/modified lines), keyed by node.location.file, so opening a changed unit's </> fetches the
  // PR HEAD of that file and paints exactly its diff — code + highlight that match the PR, not base.
  // Keyed off the MATCHED node's location.file (same matching that seeds the graph), robust to any
  // path prefix. This is what makes the fast (synchronous) review show head code without re-extract.
  // SWAPPED mode carries neither field: node.location is already head-relative, so showCode's
  // headSpanFor remap must never run — it reads the local head checkout via activeSourceUrl instead.
  const reviewCommentRangesByFile = Object.create(null) as Record<string, LineRange[]>;
  for (const binding of fileBindings) {
    const file = binding.file;
    if (file.status === "removed" || file.diffComplete === false) {
      continue;
    }
    // GitHub accepts inline comments anywhere in the context-padded patch hunk. Keep those U3
    // ranges separate from the exact edit runs used for base→HEAD coordinate mapping.
    const ranges = file.contextHunks && file.contextHunks.length > 0
      ? file.contextHunks
      : (file.edits ?? [])
        .filter((edit) => edit.newStart >= 1 && edit.newLines > 0)
        .map((edit) => ({ start: edit.newStart, end: edit.newStart + edit.newLines - 1 }));
    if (ranges.length > 0) {
      for (const locFile of binding.headFiles) reviewCommentRangesByFile[locFile] = ranges;
    }
  }
  // Removed text is parsed from GitHub's patch in HEAD coordinates, so unlike the base→head edit
  // remap above it is valid in BOTH sync and swapped reviews. Join through the same matched module
  // path so the code panel can look it up with node.location.file in either graph.
  const reviewRemovedByFile = Object.create(null) as Record<
    string,
    { afterNewLine: number; lines: string[] }[]
  >;
  const reviewRemovedTruncatedByFile = Object.create(null) as Record<string, boolean>;
  for (const binding of fileBindings) {
    const prFile = binding.file;
    if ((prFile.removed?.length ?? 0) > 0) {
      for (const locFile of binding.aliases) reviewRemovedByFile[locFile] = prFile.removed ?? [];
    }
    if (prFile.removedTruncated === true) {
      for (const locFile of binding.aliases) reviewRemovedTruncatedByFile[locFile] = true;
    }
  }
  const progress = liveProgress ?? readReviewProgress(context.reviewKey, {
    legacyKeys: [`${prFilesUrl}|pr-${prSelected}`],
  });
  const migratedProgress = promoteFullyViewedUnitTicks(files, progress.unitTicks, progress.fileTicks);
  const currentSelection = get();
  const enteringReview = currentSelection.prReviewed !== prSelected;
  const loadedRevision = options.reprojecting
    ? currentSelection.prReviewRevision
    : summary === null ? null : reviewRevision(summary, swapped ? prPreparedHeadSha : null);
  const reviewComments = reconcileReviewLineAnchors(progress.comments, loadedRevision);
  const lineAnchorsInvalidated = reviewComments !== progress.comments;
  const revisionMismatch = options.reprojecting
    ? currentSelection.prReviewStale
    : loadedRevision !== null && summary !== null && isPrReviewStale(loadedRevision, summary);
  const excludedSelectionFiles = new Set(
    matchAffectedFiles(
      index,
      context.changedFiles
        .map((file) => file.path)
        .filter((path) => !visiblePaths.has(path)),
    ).matched.map((match) => match.file),
  );
  const visibleSelectionId = (id: string | null) => {
    if (id === null || (!currentSelection.showTests && index.testIds.has(id))) return false;
    const file = index.nodesById.get(id)?.location.file;
    return file === undefined || !excludedSelectionFiles.has(file);
  };
  const preservedModuleSelection = options.preserveReviewSelection
    ? new Set([...currentSelection.moduleSelected].filter(visibleSelectionId))
    : new Set<string>();
  const preservedReviewLitIds = options.preserveReviewSelection && currentSelection.reviewLitNodeIds !== null
    ? new Set([...currentSelection.reviewLitNodeIds].filter(visibleSelectionId))
    : null;
  const preservedReviewLit = preservedReviewLitIds !== null && preservedReviewLitIds.size > 0
    ? preservedReviewLitIds
    : null;
  set({
    artifact: reviewedArtifact,
    // Pin the index this review was computed on alongside its artifact: a mid-flow overlay close
    // (beginLensTransition → closeMinimalGraph's soft restore, when re-seeding a swapped review) can
    // swap the boot index back in, so the pair must be re-set together, not left to the prior swap.
    index,
    prPreparedArtifactCurrent: swapped,
    review,
    prReviewBlocked: null,
    prReviewed: prSelected,
    prReviewSource: {
      number: prSelected,
      files: reviewPrFiles,
      // The exact local manifest is complete for this extraction root even when GitHub's response
      // was capped. Preserve the warning only for the legacy/no-manifest fallback.
      truncated: exactManifest === null && get().prFilesTruncated,
      total: reviewFilesTotal,
      outside: prFilesOutside,
      suggestedSubdir: get().prFilesSuggestedSubdir,
    },
    prReviewRevision: loadedRevision,
    // If the head moved during a long extraction, its exact analyzed SHA and the earlier summary/file
    // snapshot disagree. Surface Refresh immediately instead of pretending those mixed inputs match.
    prReviewStale: revisionMismatch,
    reviewHeadRef: options.reprojecting
      ? currentSelection.reviewHeadRef
      : swapped ? null : summary?.headSha ?? summary?.headRef ?? null,
    reviewDiffByFile,
    reviewDiffLinesByFile,
    reviewBaseNodeIds: deletedProjection.baseSourceNodeIds,
    reviewDeletedNodeIds: deletedProjection.deletedNodeIds,
    reviewBaseSpanByHeadId: deletedProjection.baseSpanByHeadId,
    reviewCommentRangesByFile,
    reviewRemovedByFile,
    reviewRemovedTruncatedByFile,
    reviewTicks: progress.ticks,
    // Keep exact unit progress while retaining a whole-file synchronization intent when complete.
    reviewUnitTicks: migratedProgress.unitTicks,
    reviewFileTicks: migratedProgress.fileTicks,
    reviewFileViewedStates: options.reprojecting ? currentSelection.reviewFileViewedStates : null,
    reviewViewedFilesViewerId: options.reprojecting
      ? currentSelection.reviewViewedFilesViewerId
      : null,
    reviewViewedFilesViewerLogin: options.reprojecting
      ? currentSelection.reviewViewedFilesViewerLogin
      : null,
    reviewViewedFilesLoading: options.viewedFilesLoading
      ?? (options.reprojecting ? currentSelection.reviewViewedFilesLoading : false),
    reviewViewedFilesError: options.viewedFilesLoading === undefined && options.reprojecting
      ? currentSelection.reviewViewedFilesError
      : null,
    reviewViewedFileSyncPending: options.reprojecting
      ? currentSelection.reviewViewedFileSyncPending
      : new Set<string>(),
    reviewViewedFileSyncErrors: options.reprojecting
      ? currentSelection.reviewViewedFileSyncErrors
      : {},
    reviewComments,
    reviewPanelHidden: options.reprojecting ? currentSelection.reviewPanelHidden : false,
    // A Tests toggle can happen while a review POST is in flight. Reprojection must not disarm the
    // duplicate-submit guard or erase its outcome banners; fresh review entry still resets them.
    reviewSubmitStatus: options.reprojecting ? currentSelection.reviewSubmitStatus : "idle",
    reviewSubmitError: options.reprojecting ? currentSelection.reviewSubmitError : null,
    reviewSubmitNotice: options.reprojecting ? currentSelection.reviewSubmitNotice : null,
    reviewSubmittedUrl: options.reprojecting ? currentSelection.reviewSubmittedUrl : null,
    reviewAffectedIds: new Set(affected.map((node) => node.nodeId)),
    reviewDiffOnly: options.reprojecting || options.preserveReviewDiffOnly
      ? currentSelection.reviewDiffOnly
      : false,
    reviewFiles: files,
    reviewFileDelta,
    reviewLitNodeIds: preservedReviewLit,
    reviewSelectedId: options.preserveReviewSelection && visibleSelectionId(currentSelection.reviewSelectedId)
      ? currentSelection.reviewSelectedId
      : null,
    ...requestFlowPaneReset(),
    logicSelected: null,
    reviewFlowBaseline: null,
    reviewGroups: changeGroups,
    reviewActiveGroupId: null,
    reviewPathScope: null,
    reviewFocusedSubgraph: null,
    minimalGraphHistory: [],
    minimalView: "graph",
    minimalShowGhostNodes: enteringReview
      ? false
      : currentSelection.minimalShowGhostNodes,
    minimalShowNonDiffGhostNodes: true,
    minimalCodebaseExpansionOverrides: new Map<string, boolean>(),
    reviewShowHighways: enteringReview
      ? false
      : currentSelection.reviewShowHighways,
    reviewAllSeedIds: workspaceSeeds,
    viewMode: "modules",
    moduleFocus: null,
    moduleSelected: preservedModuleSelection,
    moduleExpanded: expanded,
    moduleRfNodes: [],
    moduleRfEdges: [],
    moduleSemanticLayers: [],
    moduleEffectiveFocus: null,
    moduleLayoutStatus: "idle",
    moduleLayoutActivity: null,
    minimalSeedIds: workspaceSeeds,
    minimalMemberIds: [...visibleSeeds],
    minimalRollups: rollupsRecord(rolledUp),
    minimalBasePositions: {},
    minimalArrange: false,
    minimalRfNodes: [],
    minimalRfEdges: [],
    minimalLayoutStatus: visibleSeeds.length > 0 ? "laying-out" : "idle",
    minimalLayoutActivity: visibleSeeds.length > 0 ? { label: "Preparing review graph…" } : null,
  });
  if (lineAnchorsInvalidated || Object.keys(progress.unitTicks).length > 0) {
    // Persist both one-way unit→file migration and invalidated line anchors under the stable key.
    // A reload must not resurrect partial unit progress or make an old numeric line look current.
    persistReviewProgress(get());
  }
  // Only the visible review graph is laid out. The underlying Map is intentionally absent until
  // closeMinimalGraph restores the base artifact and schedules one current-state source layout.
  if (visibleSeeds.length > 0 && options.scheduleLayout !== false) {
    void get().minimalRelayout({ label: "Preparing review graph…" });
  }
  return true;
}

/**
 * Add a cumulative canonical HEAD projection to the artifact currently painted by the review.
 * The painted artifact may also contain exact merge-base tombstones, so replacing it with
 * `projectionToArtifact(next)` would silently drop deletion review. Canonical HEAD payload wins on
 * ID collision; base-only nodes/edges and review-local extension data remain present.
 */
export function mergeProjectionIntoDisplayedArtifact(
  displayed: GraphArtifact,
  previous: GraphProjectionV1,
  next: GraphProjectionV1,
): GraphArtifact {
  if (previous.graphId !== next.graphId || previous.generation !== next.generation) {
    throw new Error("cannot hydrate a displayed graph from a different immutable generation");
  }
  const nodes = new Map(displayed.nodes.map((node) => [node.id, node]));
  for (const node of next.nodes) nodes.set(node.id, node);
  const edges = new Map(displayed.edges.map((edge) => [edge.id, edge]));
  for (const edge of next.edges) edges.set(edge.id, edge);

  const displayedExtensions = (displayed.extensions ?? {}) as Record<string, JsonValue>;
  const nextExtensions = (next.extensions ?? {}) as Record<string, JsonValue>;
  const extensions: Record<string, JsonValue> = { ...displayedExtensions, ...nextExtensions };
  const oldFlows = displayedExtensions.logicFlow;
  const newFlows = nextExtensions.logicFlow;
  if (
    typeof oldFlows === "object" && oldFlows !== null && !Array.isArray(oldFlows)
    && typeof newFlows === "object" && newFlows !== null && !Array.isArray(newFlows)
  ) {
    extensions.logicFlow = {
      ...(oldFlows as Record<string, JsonValue>),
      ...(newFlows as Record<string, JsonValue>),
    };
  }

  return {
    ...displayed,
    nodes: [...nodes.values()],
    edges: [...edges.values()],
    ...(Object.keys(extensions).length === 0 ? {} : { extensions }),
  };
}

/** Empty two-sided projection for synchronous reviews and older prepared-review servers. */
function emptyDeletedNodeProjection(artifact: GraphArtifact, index: GraphIndex): DeletedNodeProjection {
  return {
    artifact,
    index,
    baseSourceNodeIds: new Set<string>(),
    deletedNodeIds: new Set<string>(),
    survivingAffectedHeadIds: new Set<string>(),
    baseSpanByHeadId: new Map<string, LineRange>(),
    affected: [],
    files: [],
  };
}

/** HEAD affected nodes without fabricated pure-deletion seams. Paintable local kinds identify rows
 * that survive; exact base projection supplies both vanished tombstones and surviving declarations
 * touched only by deletions. This prevents the old seam from marking the next declaration red. */
function preparedHeadAffected(
  context: ReviewContext,
  prFiles: readonly PrChangedFile[],
  artifact: GraphArtifact,
  index: GraphIndex,
  survivingDeletionIds: ReadonlySet<string>,
): AffectedNode[] {
  const kindsByFile = changedLineKindsFromExtensions(artifact.extensions);
  const statsByFile = changedLineStatsFromExtensions(artifact.extensions);
  const rawByPath = new Map(prFiles.map((file) => [file.path, file]));
  const statusByCanonicalFile = new Map<string, AffectedNode["status"]>();
  const changedFiles = context.changedFiles.map((changed) => {
    const match = matchAffectedFiles(index, [changed.path]).matched[0];
    const canonicalPath = match === undefined
      ? changed.path
      : index.nodesById.get(match.moduleId)?.location.file ?? changed.path;
    statusByCanonicalFile.set(canonicalPath, changed.status);
    const aliases = new Set([changed.path, canonicalPath]);
    const raw = rawByPath.get(changed.path);
    const canonicalKinds = valueForReviewAliases(kindsByFile, aliases);
    const canonicalStats = valueForReviewAliases(statsByFile, aliases);
    // `raw` is the already-projected review file. In a prepared review it was assembled from the
    // same canonical extension, then had only syntax-proven formatting runs removed. Prefer those
    // effective kinds so the raw artifact channel cannot reintroduce an excluded node.
    const exactKinds = raw?.diffComplete === true
      ? raw.kinds ?? []
      : canonicalKinds;
    const file = { ...changed, path: canonicalPath };
    delete file.oldHunks;
    if (exactKinds !== undefined || canonicalStats !== undefined) {
      // `[]` is meaningful: a pure deletion has no surviving HEAD row, so core rings only the file
      // module fallback until the base-side pass supplies the real declaration target.
      file.hunks = (exactKinds ?? []).map((span) => ({ start: span.start, end: span.end }));
    } else {
      delete file.hunks; // incomplete/omitted detail keeps core's conservative module fallback.
    }
    return file;
  });
  const affected = computeAffectedNodes(artifact.nodes, changedFiles);
  const byId = new Map(affected.map((entry) => [entry.nodeId, entry]));
  for (const id of survivingDeletionIds) {
    const node = index.nodesById.get(id);
    if (!node || !statusByCanonicalFile.has(node.location.file)) continue;
    byId.set(id, {
      nodeId: id,
      status: statusByCanonicalFile.get(node.location.file)!,
      file: node.location.file,
      overlapsHunk: true,
    });
  }
  return [...byId.values()].sort(compareAffectedNodes);
}

function mergeAffectedNodes(head: readonly AffectedNode[], deleted: readonly AffectedNode[]): AffectedNode[] {
  const merged = new Map<string, AffectedNode>();
  for (const entry of [...head, ...deleted]) merged.set(entry.nodeId, entry);
  return [...merged.values()].sort(compareAffectedNodes);
}

function compareAffectedNodes(left: AffectedNode, right: AffectedNode): number {
  return left.file.localeCompare(right.file) || left.nodeId.localeCompare(right.nodeId);
}

/** Replace the checklist's seam-derived units with the exact two-sided affected set, then append
 * base-coordinate tombstone units. Every visible ChangedFile already has a row, so this preserves
 * progress, deleted-impact callers, and file fingerprints while changing only graph-backed units. */
function mergeDeletedReviewFiles(
  files: readonly ReviewFileRow[],
  headAffected: readonly AffectedNode[],
  deletedFiles: ReadonlyArray<DeletedNodeProjection["files"][number]>,
  index: GraphIndex,
): ReviewFileRow[] {
  const headIds = new Set(headAffected.map((entry) => entry.nodeId));
  const deletedByPath = new Map(deletedFiles.map((file) => [file.path, file]));
  return files.map((file) => {
    const deleted = deletedByPath.get(file.path);
    const units = new Map<string, ReviewUnitRow>();
    for (const unit of file.units) {
      if (headIds.has(unit.nodeId)) units.set(unit.nodeId, unit);
    }
    for (const unit of deleted?.units ?? []) units.set(unit.nodeId, unit);
    const moduleId = deleted?.moduleId ?? file.moduleId;
    return {
      ...file,
      moduleId,
      isTest: moduleId === null ? file.isTest : index.testIds.has(moduleId),
      units: [...units.values()].sort((left, right) =>
        left.startLine - right.startLine || left.nodeId.localeCompare(right.nodeId)),
      ...(deleted ? {
        fingerprint: deleted.fingerprint,
        address: deleted.address,
        previousAddress: null,
      } : {}),
    };
  });
}

interface BoundReviewFile {
  file: PrChangedFile;
  /** Every exact source/metadata spelling used by HEAD, merge-base, and a synthetic file target. */
  aliases: Set<string>;
  /** Current-graph aliases eligible for RIGHT-side comments or base→HEAD edit remapping. */
  headFiles: Set<string>;
}

/** Exact complete PR rows keyed in the same extraction-relative vocabulary as ReviewContext. */
function diffLinesByPrPath(files: readonly PrChangedFile[]): ChangedDiffLines {
  const result = Object.create(null) as ChangedDiffLines;
  for (const file of files) {
    if (file.diffComplete !== false && file.diffLines && file.diffLines.length > 0) {
      Object.defineProperty(result, file.path, {
        value: file.diffLines,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
  }
  return result;
}

/** Resolve each PR file once against both revisions. Every diff/delta/source/comment map consumes
 * these bindings so removed files cannot disappear merely because one call site joined HEAD only. */
function bindReviewFiles(
  files: readonly PrChangedFile[],
  headIndex: GraphIndex,
  baseIndex: GraphIndex | null,
  deleted: DeletedNodeProjection,
): BoundReviewFile[] {
  const deletedByPath = new Map(deleted.files.map((file) => [file.path, file]));
  return files.map((file) => {
    const aliases = new Set<string>([file.path]);
    const headFiles = new Set<string>();
    const headMatch = matchAffectedFiles(headIndex, [file.path]).matched[0];
    const headFile = headMatch === undefined ? undefined : headIndex.nodesById.get(headMatch.moduleId)?.location.file;
    if (headFile) {
      aliases.add(headFile);
      headFiles.add(headFile);
    }
    const baseCandidate = file.previousPath ?? file.path;
    if (file.previousPath) aliases.add(file.previousPath);
    const baseMatch = baseIndex === null ? undefined : matchAffectedFiles(baseIndex, [baseCandidate]).matched[0];
    const baseFile = baseMatch === undefined ? undefined : baseIndex!.nodesById.get(baseMatch.moduleId)?.location.file;
    if (baseFile) aliases.add(baseFile);
    const projected = deletedByPath.get(file.path);
    if (projected) aliases.add(projected.basePath);
    return { file, aliases, headFiles };
  });
}

/** Resolve only aliases proven while binding the exact PR path to the HEAD/base graph. */
function valueForReviewAliases<T>(
  record: Readonly<Record<string, T>> | null,
  aliases: ReadonlySet<string>,
): T | undefined {
  if (record === null) return undefined;
  for (const alias of aliases) {
    if (Object.hasOwn(record, alias)) return record[alias];
  }
  return undefined;
}

function valueForExactRecord<T>(
  record: Readonly<Record<string, T>>,
  path: string,
): T | undefined {
  return Object.hasOwn(record, path) ? record[path] : undefined;
}

/** A line number belongs to one immutable HEAD revision. On refresh OR a later restored session,
 * preserve draft text/labels but permanently disarm inline anchors without matching provenance.
 * Those drafts submit as file-level comments instead of being retargeted. File/unit drafts use
 * semantic heuristics at submit time and can continue to re-anchor safely. */
function reconcileReviewLineAnchors(comments: ReviewComment[], revision: PrReviewRevision | null): ReviewComment[] {
  const currentRevision = prReviewRevisionKey(revision);
  if (currentRevision === null) {
    return comments;
  }
  let changed = false;
  const next = comments.map((comment) => {
    if (comment.line === null || comment.lineStale === true || comment.lineRevision === currentRevision) {
      return comment;
    }
    changed = true;
    return { ...comment, lineStale: true };
  });
  return changed ? next : comments;
}

/** The selected PR's summary row (its refs feed the analyze request); null when unavailable.
 * An explicit number lets URL restoration resolve a row before selecting it. */
export function selectedPrSummary(state: BlueprintState, number: number | null = state.prSelected): PrSummary | null {
  if (number === null) {
    return null;
  }
  const { prsList, prExtraSummaries } = state;
  return [...(prsList.open ?? []), ...(prsList.closed ?? [])].find((pr) => pr.number === number) ?? prExtraSummaries[number] ?? null;
}

/** End either review mode through the existing baseline restore. Sync mode normally has no saved
 * pair, so selectPr seeds the immutable boot pair just for this immediate end-session restore. */
function restoreSelectedPrReview(
  get: () => BlueprintState,
  set: (partial: Partial<BlueprintState>) => void,
  bootBaseline: PrReviewBaseline,
  restoreBaseline: () => boolean,
): boolean {
  const state = get();
  if (state.prReviewed !== null && state.prReviewBaseline === null) {
    set({ prReviewBaseline: bootBaseline });
  }
  return restoreBaseline();
}

function prepareErrorMessage(error: unknown): string {
  return error instanceof Error && error.message.length > 0 ? error.message : "PR analysis failed.";
}

/** Route an in-place expansion relayout to whichever module surface is showing: the minimal-graph
 * overlay when it is open (it shares the one `moduleExpanded` id space), else the Module map beneath.
 * Relaying out the covered Map instead would be work the reader can't see. */
function relayoutActiveModuleSurface(get: () => BlueprintState, activity?: LayoutActivity): Promise<void> {
  return get().minimalSeedIds.length > 0
    ? get().minimalRelayout(activity)
    : get().moduleRelayout(activity);
}

/**
 * The side effects EVERY lens entry owes before it lands: the Map-only minimal overlay closes (it
 * must never linger hidden behind another tab; its URL `mgraph` clears with the switch), and the
 * scoped Service sub-view exits (it is session state of ONE call-lens visit). Centralized because
 * each entry point used to re-inline these and the scope clear got missed twice (openLogicFlow /
 * openComposition set viewMode directly) — one helper means the next lens-entry side effect cannot
 * be forgotten four times over. openServiceScope runs it too, then SETS its own fresh scope.
 */
function beginLensTransition(
  get: BlueprintStore["getState"],
  set: (partial: Partial<BlueprintState>) => void,
  replayAfterDeferredRestore?: () => void,
): boolean {
  // Most lens entries route through setViewMode, but direct pivots (openLogicFlow,
  // openComposition, openServiceScope) call this helper themselves. They must abandon the same
  // prepare-first waiting lane before changing view. Successful prepared entry sets the lane idle
  // before it calls this helper, so its own PRs → Map transition is deliberately not canceled.
  if (get().prReviewStatus === "preparing") {
    get().cancelPrReviewPreparation();
  }
  if (get().minimalSeedIds.length > 0) {
    if (!get().closeMinimalGraph(replayAfterDeferredRestore)) return false;
  }
  const state = get();
  // Ghost-path inspection belongs to the exact current projection. A real lens transition leaves
  // it behind; ordinary paint/layout toggles never route through this helper and therefore retain it.
  if (state.moduleGhostInspection !== null) {
    set({ moduleGhostInspection: null });
  }
  if (state.flowPaneOrigin === "request") {
    set(requestFlowPaneReset());
  }
  const focusedService = state.moduleFocus !== null
    && (leadIdOf(state.moduleFocus) !== null || isServiceDomainId(state.moduleFocus));
  const resetServiceScene = state.serviceScope !== null || focusedService;
  // A service/domain zoom is CALL-LENS state — stale on the next visit and meaningless anywhere
  // else: clear it so a lens entry that lands back on "call" (openComposition's pivot) can't hide
  // its target under a lingering zoom. Only Service synthetic ids clear — a Map folder focus is that
  // lens's own state and must survive. Every caller either lays out its destination or leaves the
  // shared canvas, so deriving the old full Service root here would only add a large stale ELK pass.
  if (resetServiceScene) {
    set({
      serviceScope: null,
      ...(focusedService ? { moduleFocus: null } : {}),
      moduleEffectiveFocus: null,
      moduleRfNodes: [],
      moduleRfEdges: [],
      moduleSemanticLayers: [],
      moduleLayoutStatus: "idle",
      moduleLayoutActivity: null,
    });
  }
  return true;
}

type CanonicalRequestMapKey =
  | "viewMode"
  | "mapExtra"
  | "mapGhostPins"
  | "moduleGhostInspection"
  | "moduleRfNodes"
  | "moduleRfEdges"
  | "moduleSemanticLayers"
  | "moduleEffectiveFocus"
  | "serviceScope"
  | "moduleFocus"
  | "moduleExpanded"
  | "moduleSelected"
  | "hiddenCategories"
  | "showPrivate"
  | "showTests";

/** Install one canonical folder-Map reveal without routing through ordinary lens navigation, which
 * would close the request split. Both bulk and one-node request entry points use this exact patch. */
function canonicalRequestMapPatch(
  state: Pick<BlueprintState, "index" | "showTests">,
  context: MinimalCodebaseContext,
): Pick<BlueprintState, CanonicalRequestMapKey> {
  return {
    viewMode: "modules",
    mapExtra: new Set<string>(),
    mapGhostPins: new Map<string, ReadonlySet<string>>(),
    moduleGhostInspection: null,
    moduleRfNodes: [],
    moduleRfEdges: [],
    moduleSemanticLayers: [],
    moduleEffectiveFocus: null,
    serviceScope: null,
    ...context.reveal,
    // An explicit reveal must not leave a target paint-hidden by a prior preference.
    hiddenCategories: new Set<ModuleCategory>(),
    showPrivate: true,
    showTests: state.showTests || [...context.highlightTargetIds].some((id) => state.index.testIds.has(id)),
  };
}

/** A click may target either a top-level runtime span or a mapped static node grafted inside an
 * expanded span. The latter has no dedicated span, but its exact artifact target is present in the
 * rendered request pane and is therefore safe to reveal. */
function requestFlowContainsTarget(
  state: Pick<BlueprintState, "flowPaneRfNodes">,
  trace: RequestTrace,
  targetId: string,
): boolean {
  return trace.spans.some((span) => span.nodeId === targetId)
    || state.flowPaneRfNodes.some((node) => (
      (node.data as Partial<LogicNodeData>).targetId === targetId
    ));
}

function requestFlowPaneReset(state?: BlueprintState): Partial<BlueprintState> {
  if (state !== undefined && state.flowPaneOrigin !== "request") return {};
  return {
    flowSelection: null,
    reviewFlowExplicitView: null,
    flowPaneOrigin: null,
    requestFlowTraceId: null,
    requestFlowExpansionOverrides: new Set<string>(),
    flowPaneExpansionOverrides: new Set<string>(),
    flowPaneCollapsedEdges: new Set<string>(),
    flowPaneRfNodes: [],
    flowPaneRfEdges: [],
    flowPaneLayoutStatus: "idle",
  };
}

function syntheticExecutionReset(): Pick<
  BlueprintState,
  | "syntheticExecution"
  | "syntheticPreviousExecution"
  | "syntheticExecutionRootId"
  | "syntheticExecutionHost"
  | "syntheticExecutionStatus"
  | "syntheticExecutionError"
  | "syntheticSelectedMomentId"
  | "syntheticFlowPresentation"
> {
  return {
    syntheticExecution: null,
    syntheticPreviousExecution: null,
    syntheticExecutionRootId: null,
    syntheticExecutionHost: null,
    syntheticExecutionStatus: "idle",
    syntheticExecutionError: null,
    syntheticSelectedMomentId: null,
    syntheticFlowPresentation: "focused",
  };
}

function syntheticExecutionContextMatches(
  state: Pick<
    BlueprintState,
    | "viewMode"
    | "logicRoot"
    | "flowSelection"
    | "flowPaneOrigin"
    | "syntheticExecutionHost"
    | "syntheticExecutionRootId"
  >,
  host: SyntheticExecutionHost,
  rootId: NodeId,
): boolean {
  if (host === "flow-pane") return state.flowSelection?.rootId === rootId;
  return (state.viewMode === "logic" && state.logicRoot === rootId)
    || (
      // Selecting an observed occurrence deliberately reveals its codebase node in Map. The
      // synthetic pane still owns the originating Logic flow, so edits and watcher reruns must
      // remain valid until that pane is closed or replaced.
      state.flowPaneOrigin === "synthetic"
      && state.syntheticExecutionHost === "logic"
      && state.syntheticExecutionRootId === rootId
      && state.flowSelection?.rootId === rootId
    );
}

function shouldResetLogicHostedSynthetic(
  state: Pick<BlueprintState, "syntheticExecutionHost" | "syntheticExecutionRootId">,
  nextRootId: NodeId,
): boolean {
  return state.syntheticExecutionHost === "logic"
    && state.syntheticExecutionRootId !== null
    && state.syntheticExecutionRootId !== nextRootId;
}

function logicHostedSyntheticReset(): Partial<BlueprintState> {
  return {
    flowSelection: null,
    reviewFlowExplicitView: null,
    flowPaneOrigin: null,
    requestFlowTraceId: null,
    requestFlowExpansionOverrides: new Set<string>(),
    flowPaneRfNodes: [],
    flowPaneRfEdges: [],
    flowPaneLayoutStatus: "idle",
    ...syntheticExecutionReset(),
  };
}

/** Order-independent equality of two id lists — the minimal overlay's "members === origin" test. */
function sameMembers(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  const set = new Set(a);
  return b.every((id) => set.has(id));
}

function sameStringSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  return a.size === b.size && [...a].every((id) => b.has(id));
}

function sameFlowSelection(a: FlowSelectionRef | null, b: FlowSelectionRef): boolean {
  if (a === null || a.rootId !== b.rootId || a.blockPath.length !== b.blockPath.length) {
    return false;
  }
  return a.blockPath.every((segment, index) => {
    const other = b.blockPath[index];
    return segment.step === other.step && segment.path === other.path;
  });
}

/** Derive the minimal overlay state for the intersection of one connectivity group and path. */
function deriveReviewScopeGraph(
  index: GraphIndex,
  reviewFiles: readonly ReviewFileRow[],
  allowedModuleIds: ReadonlySet<string> | null,
  pathScope: string | null,
  baseNodes: ReviewScopeBaseNodes,
): {
  seeds: string[];
  rolledUp: Map<string, string[]>;
  expanded: Set<string>;
} {
  const paths = reviewFiles
    .filter((file) => isReviewPathInScope(file.path, pathScope))
    .map((file) => file.path);
  const matched = matchAffectedFiles(index, paths).matched
    .filter((match) => allowedModuleIds === null || allowedModuleIds.has(match.moduleId));
  const { seeds, rolledUp } = rollupSeeds(matched, index);
  const fileExpansion = reviewExpansionForMatches(index, matched, rolledUp);
  return {
    seeds,
    rolledUp,
    expanded: expandReviewScopeBaseUnits(
      fileExpansion,
      index,
      reviewFiles,
      new Set(matched.map((match) => match.path)),
      baseNodes,
      new Set(rolledUp.keys()),
    ),
  };
}

function deriveReviewScopedFrame(
  index: GraphIndex,
  reviewFiles: readonly ReviewFileRow[],
  activeGroup: { files: readonly string[]; moduleIds: readonly string[] } | null,
  pathScope: string | null,
  focused: BlueprintState["reviewFocusedSubgraph"],
  baseNodes: ReviewScopeBaseNodes,
): {
  seeds: string[];
  rolledUp: Map<string, string[]>;
  expanded: Set<string>;
  focused: BlueprintState["reviewFocusedSubgraph"];
} {
  if (focused === null) {
    return {
      ...deriveReviewScopeGraph(
        index,
        reviewFiles,
        activeGroup === null ? null : new Set(activeGroup.moduleIds),
        pathScope,
        baseNodes,
      ),
      focused: null,
    };
  }
  const groupFiles = activeGroup === null ? null : new Set(activeGroup.files);
  const candidates = reviewFiles.filter((file) =>
    file.moduleId !== null
    && (groupFiles === null || groupFiles.has(file.path))
    && isReviewPathInScope(file.path, pathScope)
    && index.isWithinFocus(focused.rootId, file.moduleId),
  );
  const matched = matchAffectedFiles(index, candidates.map((file) => file.path)).matched
    .filter((match) => index.isWithinFocus(focused.rootId, match.moduleId));
  const seeds = [...new Set(matched.map((match) => match.moduleId))].sort();
  const boundary = new Map<string, string[]>([[focused.rootId, seeds]]);
  return {
    seeds,
    rolledUp: new Map(),
    expanded: reviewExpansionForMatches(index, matched, boundary),
    focused: {
      ...focused,
      filePaths: [...new Set(matched.map((match) => match.path))].sort(),
      moduleIds: seeds,
    },
  };
}

function deriveReviewScopedFlowScene(
  index: GraphIndex,
  flows: LogicFlows,
  selection: FlowSelectionRef,
  scoped: {
    seeds: readonly string[];
    rolledUp: ReadonlyMap<string, readonly string[]>;
    expanded: ReadonlySet<string>;
  },
): {
  minimalSeedIds: string[];
  minimalMemberIds: string[];
  moduleExpanded: Set<string>;
} {
  const related = relatedNodeIds(index, flows, selection);
  return {
    ...expandFlowRollupsFor(
      index,
      rollupsRecord(scoped.rolledUp),
      related,
      scoped.seeds,
      scoped.seeds,
    ),
    moduleExpanded: expandedCodePaths(scoped.expanded, related, index),
  };
}

function rollupsRecord(rolledUp: ReadonlyMap<string, readonly string[]>): Record<string, string[]> {
  return Object.fromEntries([...rolledUp].map(([packageId, fileIds]) => [packageId, [...fileIds]]));
}

function mergeReviewProjectionFrame(
  unfiltered: MinimalGraphHistoryEntry,
  projected: MinimalGraphHistoryEntry,
  current: MinimalGraphHistoryEntry,
): MinimalGraphHistoryEntry {
  // Closing a flow while filtered restores its pre-flow base scene. Compare that scene with the
  // equivalent U/P bases too; flow-expanded file substitutions are projection mechanics, not user
  // curation, and merging them against a closed rollup can otherwise create overlapping seeds.
  const unfilteredCuration = reviewProjectionCurationFrame(unfiltered, current.flowSelection === null);
  const projectedCuration = reviewProjectionCurationFrame(projected, current.flowSelection === null);
  return {
    ...current,
    minimalMemberIds: mergeProjectionList(
      unfilteredCuration.minimalMemberIds,
      projectedCuration.minimalMemberIds,
      current.minimalMemberIds,
    ),
    minimalRollups: mergeProjectionRollups(
      unfilteredCuration.minimalRollups,
      projectedCuration.minimalRollups,
      current.minimalRollups,
    ),
    minimalBasePositions: {
      ...unfilteredCuration.minimalBasePositions,
      ...current.minimalBasePositions,
    },
    moduleSelected: mergeProjectionSet(
      unfilteredCuration.moduleSelected,
      projectedCuration.moduleSelected,
      current.moduleSelected,
    ),
    moduleExpanded: mergeProjectionSet(
      unfilteredCuration.moduleExpanded,
      projectedCuration.moduleExpanded,
      current.moduleExpanded,
    ),
    reviewSelectedId: current.reviewSelectedId === projectedCuration.reviewSelectedId
      ? unfilteredCuration.reviewSelectedId
      : current.reviewSelectedId,
    reviewLitNodeIds: mergeProjectionNullableSet(
      unfilteredCuration.reviewLitNodeIds,
      projectedCuration.reviewLitNodeIds,
      current.reviewLitNodeIds,
    ),
    reviewFocusedSubgraph: mergeProjectionFocusedSubgraph(
      unfilteredCuration.reviewFocusedSubgraph,
      projectedCuration.reviewFocusedSubgraph,
      current.reviewFocusedSubgraph,
    ),
    reviewActiveGroupId: current.reviewActiveGroupId === projectedCuration.reviewActiveGroupId
      ? unfilteredCuration.reviewActiveGroupId
      : current.reviewActiveGroupId,
    reviewPathScope: current.reviewPathScope === projectedCuration.reviewPathScope
      ? unfilteredCuration.reviewPathScope
      : current.reviewPathScope,
    reviewFlowBaseline: mergeProjectionFlowBaseline(unfiltered, projected, current),
  };
}

function reviewProjectionCurationFrame(
  frame: MinimalGraphHistoryEntry,
  unwrapFlow: boolean,
): MinimalGraphHistoryEntry {
  const baseline = unwrapFlow ? frame.reviewFlowBaseline : null;
  if (baseline === null) return frame;
  return {
    ...frame,
    moduleSelected: baseline.moduleSelected,
    moduleExpanded: baseline.moduleExpanded,
    minimalSeedIds: baseline.minimalSeedIds,
    minimalMemberIds: baseline.minimalMemberIds,
    minimalBasePositions: baseline.minimalBasePositions,
    minimalArrange: baseline.minimalArrange,
    reviewSelectedId: baseline.reviewSelectedId,
    reviewLitNodeIds: baseline.reviewLitNodeIds,
    flowSelection: null,
    reviewFlowBaseline: null,
  };
}

function mergeProjectionFlowBaseline(
  unfilteredFrame: MinimalGraphHistoryEntry,
  projectedFrame: MinimalGraphHistoryEntry,
  currentFrame: MinimalGraphHistoryEntry,
): BlueprintState["reviewFlowBaseline"] {
  // A flow baseline is the graph scene before flow inspection, regardless of which flow happens
  // to be open. A reader may open or switch flows while a review projection is active, so compare
  // each frame's underlying base scene instead of requiring matching flow selections.
  const current = currentFrame.reviewFlowBaseline;
  if (currentFrame.flowSelection === null || current === null) {
    return current;
  }
  const unfiltered = reviewProjectionBaseScene(unfilteredFrame);
  const projected = reviewProjectionBaseScene(projectedFrame);
  if (unfiltered === null || projected === null) return current;
  return {
    ...current,
    moduleSelected: mergeProjectionSet(
      unfiltered.moduleSelected,
      projected.moduleSelected,
      current.moduleSelected,
    ),
    moduleExpanded: mergeProjectionSet(
      unfiltered.moduleExpanded,
      projected.moduleExpanded,
      current.moduleExpanded,
    ),
    minimalSeedIds: mergeProjectionList(
      unfiltered.minimalSeedIds,
      projected.minimalSeedIds,
      current.minimalSeedIds,
    ),
    minimalMemberIds: mergeProjectionList(
      unfiltered.minimalMemberIds,
      projected.minimalMemberIds,
      current.minimalMemberIds,
    ),
    reviewSelectedId: current.reviewSelectedId === projected.reviewSelectedId
      ? unfiltered.reviewSelectedId
      : current.reviewSelectedId,
    reviewLitNodeIds: mergeProjectionNullableSet(
      unfiltered.reviewLitNodeIds,
      projected.reviewLitNodeIds,
      current.reviewLitNodeIds,
    ),
  };
}

function reviewProjectionBaseScene(
  frame: MinimalGraphHistoryEntry,
): NonNullable<BlueprintState["reviewFlowBaseline"]> | null {
  if (frame.reviewFlowBaseline !== null) return frame.reviewFlowBaseline;
  if (frame.flowSelection !== null) return null;
  return {
    moduleSelected: frame.moduleSelected,
    moduleExpanded: frame.moduleExpanded,
    minimalSeedIds: frame.minimalSeedIds,
    minimalMemberIds: frame.minimalMemberIds,
    minimalBasePositions: frame.minimalBasePositions,
    minimalArrange: frame.minimalArrange,
    reviewSelectedId: frame.reviewSelectedId,
    reviewLitNodeIds: frame.reviewLitNodeIds,
  };
}

function mergeProjectionList(
  unfiltered: readonly string[],
  projected: readonly string[],
  current: readonly string[],
): string[] {
  const projectedSet = new Set(projected);
  const currentSet = new Set(current);
  const removedByUser = new Set(projected.filter((id) => !currentSet.has(id)));
  const merged = unfiltered.filter((id) => !removedByUser.has(id));
  for (const id of current) {
    if (!projectedSet.has(id) && !merged.includes(id)) merged.push(id);
  }
  return merged;
}

function mergeProjectionSet(
  unfiltered: ReadonlySet<string>,
  projected: ReadonlySet<string>,
  current: ReadonlySet<string>,
): Set<string> {
  return new Set(mergeProjectionList([...unfiltered], [...projected], [...current]));
}

function mergeProjectionNullableSet(
  unfiltered: ReadonlySet<string> | null,
  projected: ReadonlySet<string> | null,
  current: ReadonlySet<string> | null,
): Set<string> | null {
  if (projected === null) {
    return current === null
      ? unfiltered === null ? null : new Set(unfiltered)
      : mergeProjectionSet(unfiltered ?? new Set<string>(), new Set<string>(), current);
  }
  if (current === null) return null;
  return mergeProjectionSet(unfiltered ?? new Set<string>(), projected, current);
}

function mergeProjectionRollups(
  unfiltered: Readonly<Record<string, readonly string[]>>,
  projected: Readonly<Record<string, readonly string[]>>,
  current: Readonly<Record<string, readonly string[]>>,
): Record<string, string[]> {
  const merged: Record<string, string[]> = {};
  const keys = new Set([...Object.keys(unfiltered), ...Object.keys(projected), ...Object.keys(current)]);
  for (const key of keys) {
    const original = unfiltered[key];
    const visible = projected[key];
    const now = current[key];
    if (visible !== undefined && now === undefined) continue;
    if (now === undefined) {
      if (visible === undefined && original !== undefined) merged[key] = [...original];
      continue;
    }
    merged[key] = mergeProjectionList(original ?? [], visible ?? [], now);
  }
  return merged;
}

function mergeProjectionFocusedSubgraph(
  unfiltered: BlueprintState["reviewFocusedSubgraph"],
  projected: BlueprintState["reviewFocusedSubgraph"],
  current: BlueprintState["reviewFocusedSubgraph"],
): BlueprintState["reviewFocusedSubgraph"] {
  if (projected === null) {
    return current === null
      ? unfiltered === null ? null : {
          ...unfiltered,
          filePaths: [...unfiltered.filePaths],
          moduleIds: [...unfiltered.moduleIds],
        }
      : {
          ...current,
          filePaths: [...current.filePaths],
          moduleIds: [...current.moduleIds],
        };
  }
  if (current === null) return null;
  if (unfiltered === null || current.rootId !== projected.rootId || unfiltered.rootId !== projected.rootId) {
    return {
      ...current,
      filePaths: [...current.filePaths],
      moduleIds: [...current.moduleIds],
    };
  }
  return {
    ...current,
    filePaths: mergeProjectionList(unfiltered.filePaths, projected.filePaths, current.filePaths),
    moduleIds: mergeProjectionList(unfiltered.moduleIds, projected.moduleIds, current.moduleIds),
  };
}

/** Declaration-level expansion for the current review seed set. Changed paths are pre-armed exactly
 * as on the Map, except every expansion inside a rolled package stays closed. Its first chevron
 * therefore reveals one level of collapsed children instead of materializing every declaration tree
 * at once — essential for large review folders such as a 25-file package. */
export function reviewExpansionForMatches(
  index: GraphIndex,
  matched: readonly { moduleId: string }[],
  rolledUp: ReadonlyMap<string, readonly string[]>,
): Set<string> {
  const expanded = new Set<string>();
  for (const match of matched) {
    for (const ancestor of index.ancestorsOf(match.moduleId)) {
      if (ancestor.kind === "package" || ancestor.kind === "module") {
        expanded.add(ancestor.id);
      }
    }
  }
  const rollupIds = [...rolledUp.keys()];
  for (const expandedId of [...expanded]) {
    if (rollupIds.some((packageId) => index.isWithinFocus(packageId, expandedId))) {
      expanded.delete(expandedId);
    }
  }
  return expanded;
}

/** Union the containment gates required to draw exact flow callables in an already-open module
 * surface. Files reveal their top-level declarations; class/interface/object units reveal nested
 * methods. The callable itself stays collapsed — the bottom pane owns its intra-procedural steps. */
function expandedCodePaths(
  current: ReadonlySet<string>,
  nodeIds: ReadonlySet<string>,
  index: GraphIndex,
): Set<string> {
  const expanded = new Set(current);
  for (const nodeId of nodeIds) {
    for (const ancestor of index.ancestorsOf(nodeId)) {
      if (isCanonicalFileNode(ancestor) || UNIT_CARD_KINDS.has(ancestor.kind)) {
        expanded.add(ancestor.id);
      }
    }
  }
  return expanded;
}

/** A large review may summarize changed files as one package card. Selecting a flow inside that
 * summary is an explicit request for code-level detail, so decompose only the rollup(s) containing
 * the flow's home files through the same package→files substitution as the card's Expand action. */
function expandFlowRollups(
  state: BlueprintState,
  related: ReadonlySet<string>,
  baseSeedIds: readonly string[] = state.minimalSeedIds,
  baseMemberIds: readonly string[] = state.minimalMemberIds,
): { minimalSeedIds: string[]; minimalMemberIds: string[] } {
  return expandFlowRollupsFor(
    state.index,
    state.minimalRollups,
    related,
    baseSeedIds,
    baseMemberIds,
  );
}

function expandFlowRollupsFor(
  index: GraphIndex,
  rollups: Readonly<Record<string, readonly string[]>>,
  related: ReadonlySet<string>,
  baseSeedIds: readonly string[],
  baseMemberIds: readonly string[],
): { minimalSeedIds: string[]; minimalMemberIds: string[] } {
  const homeFiles = new Set(nearestModuleIds([...related], index));
  let minimalSeedIds = [...baseSeedIds];
  let minimalMemberIds = [...baseMemberIds];
  for (const [packageId, fileIds] of Object.entries(rollups)) {
    if (!fileIds.some((fileId) => homeFiles.has(fileId))) {
      continue;
    }
    minimalSeedIds = replaceRollupSeed(minimalSeedIds, packageId, fileIds);
    minimalMemberIds = replaceRollupSeed(minimalMemberIds, packageId, fileIds);
  }
  return { minimalSeedIds, minimalMemberIds };
}

/** During PR flow inspection, temporarily promote one anchor's home file into the derive inputs.
 * At rest that anchor is the flow root, which guarantees an impacted flow whose root itself did not
 * change can still project every charted call target. After a node click the anchor becomes that
 * target, making it a real expanded block whose complete caller/callee ring can fan out as ghosts.
 * Stored review curation is never changed; closing the flow removes this temporary context. */
function minimalMembersForFlowInspection(state: BlueprintState): Set<string> {
  const members = new Set(state.minimalMemberIds);
  if (state.review === null || state.flowSelection === null || state.reviewFlowBaseline === null) {
    return members;
  }
  const anchor = state.reviewSelectedId ?? state.flowSelection.rootId;
  for (const fileId of nearestModuleIds([anchor], state.index)) {
    members.add(fileId);
  }
  return members;
}

function replaceRollupSeed(ids: readonly string[], packageId: string, fileIds: readonly string[]): string[] {
  if (!ids.includes(packageId)) {
    return [...ids];
  }
  return [...new Set(ids.flatMap((id) => (id === packageId ? fileIds : [id])))].sort();
}

/** Invert changed-file-only substitutions used by temporary flow review. Ordinary package
 * disclosure keeps the rollup id in both member lists and therefore needs no restoration. */
function restoreRolledSeeds(seedIds: readonly string[], rollups: Readonly<Record<string, string[]>>): string[] {
  const restored = new Set(seedIds);
  for (const [packageId, fileIds] of Object.entries(rollups)) {
    if (!fileIds.some((fileId) => restored.has(fileId))) {
      continue;
    }
    for (const fileId of fileIds) {
      restored.delete(fileId);
    }
    restored.add(packageId);
  }
  return [...restored].sort();
}

/** Union the folder-Map containment gates needed to draw `anchors` into an existing expansion set.
 * Callers intentionally take ONLY this field from the reveal: pin/promote edit the current canvas
 * in place, so they must not replace its focus or selection with the resolver's navigation state. */
function withMapRevealExpansion(current: ReadonlySet<string>, anchors: readonly string[], index: GraphIndex): Set<string> {
  const next = new Set(current);
  mapRevealStateForMany(anchors, index)?.moduleExpanded.forEach((id) => next.add(id));
  return next;
}

/** The member a promoted ghost satellite becomes: a folder group-ghost joins as that folder, a
 * symbol satellite as its home FILE (nearest module ancestor-or-self) — members are always the
 * file/package boxes the overlay draws, never bare symbols. Null when the index can't place the id. */
function ghostMemberId(index: GraphIndex, ghostId: string): string | null {
  const kind = index.nodesById.get(ghostId)?.kind;
  if (kind === undefined) {
    return null;
  }
  if (kind === "module" || kind === "package" || kind === "directory") {
    return ghostId;
  }
  const ancestors = index.ancestorsOf(ghostId);
  for (let i = ancestors.length - 1; i >= 0; i -= 1) {
    if (isCanonicalFileNode(ancestors[i])) {
      return ancestors[i].id;
    }
  }
  return null;
}

/** Bound on how many of a folder group-ghost's files one "+" pins — a huge folder must not flood the level. */
const FOLDER_PIN_CAP = 12;

/** The contributing home FILES a drawn folder group-ghost recorded at fold time (GhostData.members)
 * — the "+" pin's real payload; undefined on individual ghosts and unknown ids. */
function drawnGhostMembers(nodes: readonly Node[], ghostId: string): readonly string[] | undefined {
  const ghost = nodes.find((node) => node.id === ghostId);
  return ghost === undefined ? undefined : (ghost.data as GhostData).members;
}

/** What the general ghost "+" pins into `mapExtra`: a symbol satellite pins its home FILE; a folder
 * group-ghost the CONTRIBUTING files recorded on its card — the files whose symbols the ghost
 * actually charted, so every pin lands wired to the level (falling back to the folder's direct
 * files only for a card with no record). Id-sorted and CAPPED; `mapExtra` holds no containers
 * (`extraRoots`/`appendExtras` only draw file/unit/block cards), so the folder id itself can't pin. */
function ghostPinIds(index: GraphIndex, ghostId: string, members?: readonly string[]): string[] {
  if (members !== undefined && members.length > 0) {
    return [...members].sort().slice(0, FOLDER_PIN_CAP);
  }
  const member = ghostMemberId(index, ghostId);
  if (member === null) {
    return [];
  }
  if (isCanonicalFileNode(index.nodesById.get(member))) {
    return [member];
  }
  return index
    .childrenOf(member)
    .filter(isCanonicalFileNode)
    .map((child) => child.id)
    .sort()
    .slice(0, FOLDER_PIN_CAP);
}

function withToggled(expanded: Set<string>, nodeId: string): Set<string> {
  const next = new Set(expanded);
  if (next.has(nodeId)) {
    next.delete(nodeId);
  } else {
    next.add(nodeId);
  }
  return next;
}

/** Flip every id in `ids` in/out of the set — the batch sibling of `withToggled`, used by the
 * Logic surface whose expansion set is XOR-from-default (toggling an id forces the opposite state). */
function withToggledMany(expanded: ReadonlySet<string>, ids: readonly string[]): Set<string> {
  const next = new Set(expanded);
  for (const id of ids) {
    if (!next.delete(id)) {
      next.add(id);
    }
  }
  return next;
}

type ScopedPick = (nodes: readonly ExpandableNode[], scope: readonly (string | null)[]) => string[];

/** Apply a containment command to Logic's transient exact-occurrence selection. The ordinary
 * surface-wide actions keep using `logicSelected`; this narrow adapter is used only after the
 * one-hop action has widened the selection beyond one serializable call target. */
function applyLogicOccurrenceScope(
  get: BlueprintStore["getState"],
  set: (partial: Partial<BlueprintState>) => void,
  nodeIds: readonly string[],
  pick: ScopedPick,
  activity: LayoutActivity,
): void {
  const state = get();
  if (state.viewMode !== "logic" || nodeIds.length === 0) {
    return;
  }
  const ids = pick(logicVisibleNodes(state), nodeIds);
  if (ids.length === 0) {
    return;
  }
  set({ expandedLogic: withToggledMany(state.expandedLogic, ids) });
  void get().logicRelayout(activity);
}

/**
 * The shared body of `expandAll`/`collapseAll`: read the active surface's visible frontier and
 * selection, let `pick` (idsToExpand reveals one level / idsToCollapse closes all open in scope)
 * choose the ids, then fold them into that surface's own expansion set — a plain add/remove on the
 * module surfaces, an XOR toggle on the Logic graph (its set is default-relative, so forcing a node
 * to the picked state is a flip). No selection ⇒ `[null]` scope ≡ the root container.
 */
function applyScoped(
  get: BlueprintStore["getState"],
  set: (partial: Partial<BlueprintState>) => void,
  getGraph: () => ModuleGraph,
  getDeps: () => BlockDeps,
  pick: ScopedPick,
  mode: "open" | "close",
  activity: LayoutActivity,
): void {
  const state = get();
  // A registered module surface (Map/Service/UI) shares one frontier read + expansion set; the
  // strict registry returns null for the logic lens, which keeps its own branch below.
  if (moduleSurfaceSpec(state.viewMode) !== null) {
    const scope = state.moduleSelected.size ? [...state.moduleSelected] : [null];
    // The minimal graph covers the registered lens while it is open. Its laid nodes are therefore
    // the authoritative visible frontier for the canvas action bar; deriving the covered lens here
    // would expand/collapse containers the user cannot see.
    const visible = state.minimalSeedIds.length > 0
      ? minimalVisibleNodes(state)
      : moduleTreeNodes(state, getGraph(), getDeps());
    const ids = pick(visible, scope);
    if (ids.length === 0) {
      return;
    }
    set({ moduleExpanded: foldIds(state.moduleExpanded, ids, mode) });
    // `moduleExpanded` is shared with the minimal-graph overlay, so when it is open the scoped
    // expand/collapse must re-lay the overlay, not the covered Map — the same seam the in-place
    // toggle/expand/collapse actions route through.
    void relayoutActiveModuleSurface(get, activity);
  } else if (state.viewMode === "logic") {
    // Logic selects by callable target, while its expansion set is keyed by visible occurrence.
    // Scope every action to all call sites carrying the selected target; no selection retains the
    // canvas-wide fallback used by the existing generic commands.
    const selectedOccurrences = logicSelectedOccurrenceIds(state);
    const scope = state.logicSelected === null ? [null] : selectedOccurrences;
    const ids = pick(logicVisibleNodes(state), scope);
    if (ids.length === 0) {
      return;
    }
    set({ expandedLogic: withToggledMany(state.expandedLogic, ids) });
    void get().logicRelayout(activity);
  }
  // "prs" has no containment to expand — deliberately a no-op.
}

/** Resolve the action's final collapse set from the current painted review frontier. A completed
 * parent is a scope: every open descendant inside it closes too, including flow-step pseudo nodes
 * that do not own review progress themselves. */
function collapsibleViewedNodeIds(state: BlueprintState): string[] {
  if (
    state.review === null
    || state.minimalSeedIds.length === 0
    || state.minimalView !== "graph"
    || moduleSurfaceSpec(state.viewMode) === null
  ) {
    return [];
  }
  const visible = minimalViewedCollapseNodes(state);
  const viewedScopes = visible.flatMap((node) => {
    if (!node.isContainer || !node.isExpanded) {
      return [];
    }
    const folderMembers = Object.hasOwn(state.minimalRollups, node.id)
      ? state.minimalRollups[node.id]
      : undefined;
    const target = reviewViewedTargetFor(
      state.reviewFiles,
      folderMembers === undefined ? "source" : "folder",
      node.id,
      folderMembers,
      state.index.nodesById.get(node.id)?.displayName ?? node.id,
      state.index,
    );
    const viewState = reviewViewedTargetState(
      target,
      state.reviewUnitTicks,
      state.reviewFileTicks,
      state.reviewFileViewedStates,
      {
        viewerId: state.reviewViewedFilesViewerId,
        headSha: state.prReviewRevision?.headSha,
      },
    );
    return viewState === "done" ? [node.id] : [];
  });
  return idsToCollapse(visible, viewedScopes);
}

/** Minimal graph nodes use `isContainer` for frames/steps and `expandable` for callable blocks.
 * Normalize both without reading hidden expansion ids from the covered source map. */
function minimalViewedCollapseNodes(state: BlueprintState): ExpandableNode[] {
  return state.minimalRfNodes.flatMap((rfNode) => {
    const data = rfNode.data as { isContainer?: unknown; expandable?: unknown };
    const isContainer = typeof data.isContainer === "boolean"
      ? data.isContainer
      : typeof data.expandable === "boolean" ? data.expandable : null;
    if (isContainer === null) {
      return [];
    }
    return [{
      id: rfNode.id,
      parentId: rfNode.parentId ?? null,
      isContainer,
      isExpanded: state.moduleExpanded.has(rfNode.id),
    }];
  });
}

/** Add (open) or remove (close) `ids` in a plain expansion set. */
function foldIds(expanded: ReadonlySet<string>, ids: readonly string[], mode: "open" | "close"): Set<string> {
  const next = new Set(expanded);
  for (const id of ids) {
    if (mode === "open") {
      next.add(id);
    } else {
      next.delete(id);
    }
  }
  return next;
}

/** The Map surface's visible frontier (the folder Map or service-cluster tree), read through the
 * SurfaceSpec registry — shared by the scoped expand/collapse actions and applyScoped. No
 * extras (palette pins / hidden tests) here, exactly as the old per-viewMode derive calls. */
function moduleTreeNodes(state: BlueprintState, graph: ModuleGraph, deps: BlockDeps): VisibleModuleNode[] {
  const flows = (state.artifact.extensions?.logicFlow ?? {}) as unknown as LogicFlows;
  return activeModuleSurfaceSpec(state.viewMode).deriveTree(state, { graph, deps, flows }).nodes;
}

/** The Logic graph's laid-out nodes as `ExpandableNode`s — expandable flags stand in for containment. */
function logicVisibleNodes(state: BlueprintState): ExpandableNode[] {
  return state.logicRfNodes
    .filter((rfNode) => typeof (rfNode.data as { expandable?: unknown }).expandable === "boolean")
    .map((rfNode) => {
      const data = rfNode.data as { expandable: boolean; isExpanded?: boolean };
      return { id: rfNode.id, parentId: rfNode.parentId ?? null, isContainer: data.expandable, isExpanded: data.isExpanded === true };
    });
}

/** Visible React Flow occurrence ids for Logic's target-based selection. The same callable can be
 * invoked more than once, so selection actions deliberately operate on every matching call site. */
function logicSelectedOccurrenceIds(state: BlueprintState): string[] {
  if (state.logicSelected === null) {
    return [];
  }
  return state.logicRfNodes
    .filter((rfNode) => rfNode.data.targetId === state.logicSelected)
    .map((rfNode) => rfNode.id);
}

/** The minimal overlay's CURRENT rendered containment frontier. Ghosts carry no expansion facts and
 * are intentionally omitted; ordinary leaves remain so selection scoping retains the real tree. */
function minimalVisibleNodes(state: BlueprintState): ExpandableNode[] {
  return state.minimalRfNodes
    .filter((rfNode) => typeof (rfNode.data as { isContainer?: unknown }).isContainer === "boolean")
    .map((rfNode) => {
      const data = rfNode.data as { isContainer: boolean; isExpanded?: boolean };
      return {
        id: rfNode.id,
        parentId: rfNode.parentId ?? null,
        isContainer: data.isContainer,
        isExpanded: data.isExpanded === true,
      };
    });
}

/** Flip a category's membership in the hidden-category set (typed sibling of `withToggled`). */
function withToggledCategory(hidden: Set<ModuleCategory>, category: ModuleCategory): Set<ModuleCategory> {
  const next = new Set(hidden);
  if (next.has(category)) {
    next.delete(category);
  } else {
    next.add(category);
  }
  return next;
}

function requestOrigin(): string {
  return typeof window === "undefined" ? "http://meridian.local" : window.location.origin;
}

function performanceMark(name: string, detail?: Record<string, string | number>): void {
  if (typeof performance === "undefined" || typeof performance.mark !== "function") return;
  try {
    performance.mark(name, detail === undefined ? undefined : { detail });
  } catch {
    // Older WebViews accept only the mark name; instrumentation must never affect review behavior.
    performance.mark(name);
  }
}

function performanceTimestamp(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : -1;
}

async function fetchPrSummary(baseUrl: string, number: number): Promise<PrSummary> {
  const url = new URL(baseUrl, requestOrigin());
  url.searchParams.set("n", String(number));
  const response = await fetch(url, { credentials: "same-origin", cache: "no-store" });
  if (!response.ok) {
    throw new Error(await errorMessage(response));
  }
  return ((await response.json()) as PrOneResponse).pr;
}

async function fetchPrFiles(baseUrl: string, number: number): Promise<PrFilesResponse> {
  const url = new URL(baseUrl, requestOrigin());
  url.searchParams.set("n", String(number));
  const response = await fetch(url, { credentials: "same-origin", cache: "no-store" });
  if (!response.ok) {
    throw new Error(await errorMessage(response));
  }
  return (await response.json()) as PrFilesResponse;
}

function normalizedGitHubSha(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase();
  return normalized ? normalized : null;
}

/**
 * Authenticated partial unit progress belongs to one immutable viewer/head coordinate. A different
 * viewer must never inherit it. On a newer head, semantically addressed ticks can safely fall back
 * to content validation; address-less ticks cannot be revalidated and are discarded.
 */
function reconcileReviewUnitTickCoordinates(
  ticks: Record<string, ReviewTick>,
  viewerId: string,
  headSha: string,
): Record<string, ReviewTick> {
  let next = ticks;
  const mutate = (): Record<string, ReviewTick> => {
    if (next === ticks) next = { ...ticks };
    return next;
  };
  for (const [key, tick] of Object.entries(ticks)) {
    const coordinateBound = tick.viewerId !== undefined
      || tick.viewerLogin !== undefined
      || tick.headSha !== undefined;
    if (!coordinateBound) continue;
    const complete = tick.viewerId !== undefined
      && tick.viewerLogin !== undefined
      && tick.headSha !== undefined;
    if (!complete) {
      const localHeadOnly = tick.viewerId === undefined
        && tick.viewerLogin === undefined
        && tick.headSha !== undefined;
      if (localHeadOnly && tick.address !== undefined) {
        setReviewTick(mutate(), key, {
          at: tick.at,
          fingerprint: tick.fingerprint,
          address: tick.address,
        });
      } else {
        delete mutate()[key];
      }
      continue;
    }
    if (tick.viewerId !== viewerId) {
      delete mutate()[key];
      continue;
    }
    if (normalizedGitHubSha(tick.headSha) === normalizedGitHubSha(headSha)) continue;
    if (tick.address === undefined) {
      delete mutate()[key];
      continue;
    }
    setReviewTick(mutate(), key, {
      at: tick.at,
      fingerprint: tick.fingerprint,
      address: tick.address,
    });
  }
  return next;
}

function normalizedGitHubLogin(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase();
  return normalized ? normalized : null;
}

function normalizedGitHubViewerId(value: string | null | undefined): string | null {
  return typeof value === "string" && value.length > 0 && value === value.trim()
    ? value
    : null;
}

function parseGitHubViewerId(value: unknown): string {
  const viewerId = typeof value === "string" ? normalizedGitHubViewerId(value) : null;
  if (viewerId === null) {
    throw new Error("GitHub returned an invalid viewed-file viewer");
  }
  return viewerId;
}

function parseGitHubViewerLogin(value: unknown): string {
  if (
    typeof value !== "string"
    || normalizedGitHubLogin(value) === null
    || value !== value.trim()
  ) {
    throw new Error("GitHub returned an invalid viewed-file viewer");
  }
  return value;
}

function parseViewedFileStates(
  files: PrViewedFilesResponse["files"],
): Record<string, PrFileViewedState> {
  if (!Array.isArray(files)) throw new Error("GitHub returned invalid viewed-file state");
  const entries: Array<[string, PrFileViewedState]> = [];
  const paths = new Set<string>();
  for (const file of files) {
    if (
      typeof file?.path !== "string"
      || file.path.length === 0
      || (file.state !== "VIEWED" && file.state !== "UNVIEWED" && file.state !== "DISMISSED")
      || paths.has(file.path)
    ) {
      throw new Error("GitHub returned invalid viewed-file state");
    }
    paths.add(file.path);
    entries.push([file.path, file.state]);
  }
  // Object.fromEntries defines data properties for Git-valid names such as "__proto__".
  return Object.fromEntries(entries);
}

/** Assign a Git-controlled key as data, never through Object.prototype's legacy setters. */
function setOwnRecordValue<T>(record: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(record, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

/** Keep every place selectedPrSummary can read in sync with a forced one-PR refresh. The extra
 * cache alone is insufficient because paged rows intentionally take precedence. */
function refreshedPrSummaryState(
  state: Pick<BlueprintState, "prsList" | "prExtraSummaries">,
  latest: PrSummary,
): Pick<BlueprintState, "prsList" | "prExtraSummaries"> {
  const refreshList = (tab: PrsTab, list: PrSummary[] | null): PrSummary[] | null => {
    if (list === null) {
      return null;
    }
    if (!list.some((pr) => pr.number === latest.number)) {
      return list; // a one-off summary must not pollute a paged queue.
    }
    return latest.state === tab
      ? list.map((pr) => (pr.number === latest.number ? latest : pr))
      : list.filter((pr) => pr.number !== latest.number);
  };
  return {
    prsList: {
      open: refreshList("open", state.prsList.open),
      closed: refreshList("closed", state.prsList.closed),
    },
    prExtraSummaries: { ...state.prExtraSummaries, [latest.number]: latest },
  };
}

function sameReviewRefresh(state: BlueprintState, number: number, revision: PrReviewRevision): boolean {
  return state.prReviewed === number
    && state.prReviewRevision === revision
    && state.prReviewRefreshing
    && state.viewMode === "modules"
    && state.minimalSeedIds.length > 0;
}

function refreshErrorMessage(error: unknown): string {
  return error instanceof Error && error.message.length > 0 ? error.message : "Could not refresh pull request contents.";
}

function resumeErrorMessage(error: unknown): string {
  const detail = error instanceof Error && error.message.length > 0 ? ` ${error.message}` : "";
  return `Could not resume the pull request review.${detail}`;
}

async function fetchPrDiscussion(baseUrl: string, number: number): Promise<PrDiscussionResult> {
  const url = new URL(baseUrl, requestOrigin());
  url.searchParams.set("n", String(number));
  const response = await fetch(url, { credentials: "same-origin", cache: "no-store" });
  if (!response.ok) {
    throw new Error("PR discussion unavailable");
  }
  return (await response.json()) as PrDiscussionResult;
}

async function fetchPrChecks(baseUrl: string, number: number, sha: string): Promise<PrChecks> {
  const url = new URL(baseUrl, requestOrigin());
  url.searchParams.set("n", String(number));
  url.searchParams.set("sha", sha);
  const response = await fetch(url, { credentials: "same-origin", cache: "no-store" });
  if (!response.ok) {
    throw new Error("PR checks unavailable");
  }
  return (await response.json()) as PrChecks;
}

async function viewedFileMutationFailure(
  response: Response,
): Promise<{ message: string; conflict: "head" | "viewer" | null }> {
  try {
    const data = (await response.json()) as { error?: unknown; conflict?: unknown };
    return {
      message: typeof data.error === "string" && data.error.length > 0
        ? data.error
        : "Could not synchronize viewed state with GitHub.",
      conflict: data.conflict === "head" || data.conflict === "viewer" ? data.conflict : null,
    };
  } catch {
    return { message: "Could not synchronize viewed state with GitHub.", conflict: null };
  }
}

async function errorMessage(response: Response): Promise<string> {
  if (response.status === 404) {
    return PRS_UNAVAILABLE_ERROR;
  }
  try {
    const data = (await response.json()) as { error?: unknown };
    return typeof data.error === "string" && data.error.length > 0 ? data.error : "Could not load pull requests.";
  } catch {
    return "Could not load pull requests.";
  }
}

/** Browser-safe telemetry failure text. Providers already omit secrets from their messages; unknown
 * rejection values still collapse to a fixed fallback rather than being stringified into the UI. */
function telemetryFailure(reason: unknown, fallback: string): string {
  return reason instanceof Error && reason.message.length > 0 ? reason.message : fallback;
}

function syntheticExecutionFailure(reason: unknown): string {
  return reason instanceof Error && reason.message.trim().length > 0
    ? reason.message
    : "Synthetic execution failed.";
}

function newestTrace(traces: readonly RequestTrace[]): RequestTrace | undefined {
  return traces.reduce<RequestTrace | undefined>((newest, trace) => {
    if (newest === undefined) return trace;
    try {
      const startedAt = BigInt(trace.startedAtUnixNano);
      const newestStartedAt = BigInt(newest.startedAtUnixNano);
      if (startedAt !== newestStartedAt) return startedAt > newestStartedAt ? trace : newest;
    } catch {
      // A validated provider cannot reach this branch. Keep the choice deterministic for custom
      // test/dev providers instead of throwing out of a successful trace-channel refresh.
    }
    return trace.traceId < newest.traceId ? trace : newest;
  }, undefined);
}

async function submitErrorMessage(response: Response): Promise<string> {
  try {
    const data = (await response.json()) as { error?: unknown };
    if (typeof data.error === "string" && data.error.length > 0) {
      return data.error;
    }
  } catch {
    // No JSON body — fall through to the status-based message.
  }
  return response.status === 404 ? "submitting needs a web GitHub session" : "could not submit the review";
}

async function prCommentErrorMessage(response: Response): Promise<string> {
  try {
    const data = (await response.json()) as { error?: unknown };
    if (typeof data.error === "string" && data.error.length > 0) {
      return data.error;
    }
  } catch {
    // No JSON body — fall through to the fixed user-facing message.
  }
  return response.status === 404 ? "comment updates need a web GitHub session" : "could not update the comment";
}

/** Persist the review progress WHOLE under its reviewKey — every mutating action funnels here. */
function persistReviewProgress(
  state: Pick<BlueprintState, "review" | "reviewTicks" | "reviewUnitTicks" | "reviewFileTicks" | "reviewComments">,
): void {
  if (!state.review) {
    return;
  }
  const progress: ReviewProgress = {
    version: 3,
    ticks: state.reviewTicks,
    unitTicks: state.reviewUnitTicks,
    fileTicks: state.reviewFileTicks,
    comments: state.reviewComments,
  };
  writeReviewProgress(state.review.context.reviewKey, progress);
}

/** Drop the SUBMITTED drafts from a review scope's storage, keeping ticks and any draft added
 * while the submit was in flight. */
function stripStoredComments(reviewKey: string, submittedIds: ReadonlySet<string>): void {
  const progress = readReviewProgress(reviewKey);
  writeReviewProgress(reviewKey, { ...progress, comments: progress.comments.filter((comment) => !submittedIds.has(comment.id)) });
}

/** Collision-safe enough for a per-review draft list; randomUUID exists on localhost (secure context). */
function newCommentId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function mergePrSummaries(existing: readonly PrSummary[], incoming: readonly PrSummary[]): PrSummary[] {
  const byNumber = new Map<number, PrSummary>();
  for (const pr of existing) {
    byNumber.set(pr.number, pr);
  }
  for (const pr of incoming) {
    byNumber.set(pr.number, pr);
  }
  return [...byNumber.values()];
}
