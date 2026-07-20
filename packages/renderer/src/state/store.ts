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
  changedLineKindsFromExtensions,
  changedLineStatsFromExtensions,
  computeAffectedNodes,
  computeChangeGroups,
} from "@meridian/core";
import type {
  AffectedNode,
  ChangedDiffLine,
  ChangedLineKind,
  ChangedLineSpan,
  ChangeGroupsResult,
  FlowSourceAnchor,
  FlowPath,
  FlowStep,
  GraphArtifact,
  GraphNode,
  JsonValue,
  LineRange,
  LogicFlows,
  NodeId,
  NodeMetrics,
  RequestTrace,
  ReviewContext,
  SyntheticExecution,
  SyntheticFieldWatcher,
  SyntheticInputOverride,
  SyntheticScenarioDescriptor,
  TraceBundle,
  TraceGraphRef,
} from "@meridian/core";
import {
  applyChangedIds,
  applyChangedStatus,
  buildGraphIndex,
  graphIndexMetadataWithoutPresentationNodes,
  type GraphIndex,
} from "../graph/graphIndex";
import {
  canonicalProjectionKey,
  canonicalReviewProjectionKey,
  OVERVIEW_PROJECTION_REQUEST,
} from "../graph/graphProjectionClient";
import type {
  GraphProjectionDataSource,
  GraphProjectionEndpoints,
  GraphProjectionRequest,
  LoadedGraphProjection,
  StagedGraphProjection,
  StagedReviewProjection,
} from "../graph/graphProjectionClient";
import {
  localSymbolSearch,
  type GraphSymbolSearchRequest,
  type GraphSymbolSearchResult,
} from "../graph/graphSymbolSearch";
import { matchAffectedFiles } from "../derive/matchAffectedFiles";
import { isReviewPathInScope, normalizeReviewPathScope } from "../derive/reviewPathScope";
import { isSourceBackedNode } from "../derive/sourceBackedNode";
import { rollupSeeds } from "../derive/seedRollup";
import { minimalGraphConnectorIds } from "../derive/minimalGraphConnectors";
import { filesInScope } from "../derive/filesInScope";
import { deriveRequestGraphOverlay } from "../derive/requestGraphOverlay";
import {
  traceGraphRevisionIdentity,
  traceGraphRefMismatches,
} from "../derive/requestTimelineModel";
import {
  requestFlowProjectionIds,
  requestFlowProjectionPassBudget,
} from "../derive/requestFlowProjection";
import {
  deriveMinimalCodebaseContext,
  type MinimalCodebaseContext,
} from "../derive/minimalCodebaseContext";
import type { LogicNodeData } from "../derive/logicGraph";
import {
  buildRendererReachabilityReport,
  type RendererReachabilityReport,
  withReachabilityTestIds,
} from "../derive/reachabilityFacts";
import type {
  TelemetryProvider,
  TelemetrySourceDescriptor,
  TelemetrySourceRegistration,
} from "../telemetry/provider";
import type { ViewMode } from "../derive/edgeSelection";
import { relatedNodeIds, type FlowSelectionRef } from "../derive/flowBlocks";
import { idsToExpand, idsToCollapse, type ExpandableNode } from "../derive/scopedExpansion";
import type { LogicViewMode } from "../derive/flowViewModel";
import { deriveLogicLayout } from "./deriveLogicLayout";
import { deriveFlowPaneLayout } from "./deriveFlowPaneLayout";
import { deriveFocusedRequestFlowPaneLayout, deriveRequestFlowPaneLayout } from "./deriveRequestFlowPaneLayout";
import { defaultSyntheticMomentId, syntheticOccurrenceSteps } from "../synthetic/syntheticFlowModel";
import { requestSyntheticExecution } from "../synthetic/client";
import type { SyntheticExecutionTrust } from "./syntheticExecutionTrust";
import { layoutModuleTree } from "../layout/moduleLevelLayout";
import { deriveMinimalGraphLayout, reviewDiffVisibleIds } from "./deriveMinimalGraphLayout";
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
import { clusteringFor, clusteringForIfAvailable } from "../derive/serviceClusteringCache";
import { deriveServiceDomains, isServiceDomainId, serviceDomainById } from "../derive/serviceDomains";
import {
  DEFAULT_SERVICE_GROUPING_LABEL_MODE,
  SERVICE_GROUPING_OPTIONS,
  type ServiceGroupingLabelMode,
  type ServiceGroupingMode,
} from "../derive/serviceClusteringModes";
import type { ModuleCategory } from "../derive/moduleCategory";
import type { HighlightMode } from "../components/moduleMapPaint";
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
import { moduleRevealStateFor, nearestModuleIds } from "./flowExplorer";
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
  type PrChangedFile,
  type PrChecks,
  type PrDiscussionResult,
  type PrFilesResponse,
  type PrFileStatus,
  type LineEdit,
  type PrListResponse,
  type PrOneResponse,
  type PrReviewSubmissionEvent,
  type PrSessionSource,
  type PrSummary,
  type PrsTab,
  type RelatedPrsResponse,
  type RelatedPrsState,
} from "./prTypes";
import { headKindsWithin, headSpanFor } from "./headSpan";
import {
  reviewNodeStatusEntries,
  reviewNodeStatusSourcesFromDiff,
  reviewNodeStatusSourcesFromKinds,
  reviewSourceChangeStatus,
} from "./reviewNodeStatus";
import {
  fetchPreparedReviewHandoff,
  preparedReviewFileCursor,
  remapPreparedReviewFilePath,
  streamPrPreparation,
  totalPrPrepareElapsedMs,
  type PreparedGraphDescriptor,
  type PreparedChangedFile,
  type PreparedReviewHandoff,
  type PrPrepareRequest,
  type PrPrepareStage,
} from "./prPreparation";
import { assertPreparedReviewProjectionFacts } from "./preparedReviewProjection";
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
  fetchPreparedSyntheticCapability,
  resetChangedIdsToArtifact,
  restorePrReviewBaseline,
  swapToPreparedReviewProjection,
  type PreparedSyntheticCapability,
  type PrReviewBaseline,
} from "./prReviewSession";
import { deriveReviewData, applyTick, type ReviewData } from "../derive/reviewData";
import { readReviewProgress, writeReviewProgress, type ReviewComment, type ReviewProgress, type ReviewTick } from "./reviewTicksPref";
import { reviewContextFromPrFiles } from "../derive/prReviewContext";
import {
  applyFilesToggle,
  applyFileToggle,
  applyUnitTick,
  applyUnitsToggle,
  isReviewTestPath,
  type ReviewFileRow,
  type ReviewUnitRow,
} from "../derive/reviewFiles";
import { deriveReviewProjection } from "../derive/reviewProjection";
import { deriveDeletedNodeProjection, type DeletedNodeProjection } from "../derive/deletedNodeProjection";
import { canonicalPrFiles } from "../derive/canonicalPrFiles";
import { expandReviewScopeBaseUnits, type ReviewScopeBaseNodes } from "../derive/reviewScopeExpansion";
import { buildReviewSubmission } from "../derive/reviewSubmit";
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
  boundMinimalGraphHistory,
  captureMinimalGraphScene,
  captureMinimalGraphHistory,
  emptyMinimalGraphScene,
  minimalGraphResidentBytes,
  minimalGraphSceneResidentBytes,
  restoreMinimalGraphHistory,
  restoreMinimalGraphScene,
  type MinimalGraphHistoryEntry,
  type MinimalGraphSceneSnapshot,
} from "./minimalGraphHistory";
import { resolveFlowStep } from "../derive/minimalExpansion";
import {
  DEFAULT_RECENT_ALLOCATION_BUDGET_LIMITS,
  RecentViewProjectionCache,
  type RecentAllocationBudget,
} from "./recentViewProjectionCache";
import { BoundedAsyncValueCache } from "./boundedAsyncValueCache";
import {
  SOURCE_TEXT_TRANSIENT_BYTES,
  fetchSourceText,
  type SourceTextPayload,
} from "./sourceTextClient";
import {
  LatestOnlyLayoutCoordinator,
  type LayoutWorkOwner,
} from "./latestOnlyLayoutCoordinator";
import { SubscriberAwareAsyncFlight } from "./subscriberAwareAsyncFlight";

/**
 * The "All" setting for the related-flows depth dial: a depth larger than any real call-graph chain.
 * `transitiveCallers`' BFS terminates when the frontier empties (no more callers to visit), so 99 ≡
 * "the entire transitive-caller closure" — it just never bottoms out on a real graph — with no perf
 * risk, since the walk is bounded by the callers that exist, not by this number.
 */
export const GHOST_DEPTH_ALL = 99;
const MAX_MINIMAL_PROJECTION_EXTRA_IDS = 128;

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

/** Boot-only observation hook for the first visible PR scene. Preparation/extraction intentionally
 * happens before this boundary; the callback brackets only the review layout the user will see. */
export interface ReviewEntryOptions {
  onVisibleLayoutStart?: () => void;
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
  /** The mounted preview owns this subscription; hiding/unmounting aborts it immediately. */
  signal?: AbortSignal;
}

/** A review container opened as its own exact-file graph. Navigation history is owned by the
 * generic minimal-graph stack, so this value only scopes the review panel to the current frame. */
export interface ReviewFocusedSubgraph {
  rootId: string;
  label: string;
  filePaths: string[];
  moduleIds: string[];
}

/** One authority for deciding which structural module surface is mounted. Review data alone is not
 * ownership: an artifact-carried review initially decorates the ordinary source Map, while a live
 * prepared review owns an explicit source-only overview until a file projection is selected. */
export type ModuleGraphSurfaceOwner = "source" | "extracted" | "prepared-review-overview";

export interface PreparedFileProjectionPending {
  /** Monotonic request identity exposed only for deterministic UI/test correlation. */
  token: number;
  path: string;
  cursor: string;
}

export interface PreparedFileProjectionError {
  path: string;
  message: string;
}

export interface BlueprintState {
  /** The one graph presentation mounted by the renderer. Ordinary views share the transport's
   * active artifact/index. A review with deletions owns one current-only composite/index here while
   * the transport owns the pure HEAD + merge-base pair: at most the pair's combined node count,
   * HEAD's edge count, and one derived index. This presentation is not a navigation-cache entry;
   * replacement or parking swaps both fields and clears every review-derived graph reference. */
  artifact: GraphArtifact;
  index: GraphIndex;
  /** Identity only; decoded projection bodies live in the transport's bounded active/recent cache. */
  activeProjectionKey: string | null;
  activeProjectionId: string | null;
  activeProjectionGraphId: string | null;
  activeProjectionRequest: GraphProjectionRequest | null;
  /** Exact immutable transport endpoints for the active graph identity. Retained with a review's
   * lightweight baseline so an evicted decoded projection can be reloaded without guessing URLs. */
  activeProjectionEndpoints: GraphProjectionEndpoints | null;
  /** Which relationship story is on screen: the call graph, or the React composition tree. */
  viewMode: ViewMode;
  /** Whether test code (nodes tagged/heuristically detected as tests) is drawn at all. */
  showTests: boolean;
  /** Coverage lens: imported runtime counters when present, otherwise estimated static reachability. */
  coverageMode: boolean;
  /** Computed lazily for the active projection and invalidated whenever projection identity changes. */
  coverage: RendererReachabilityReport | null;
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
  /** Whether cross-container edges merge into thick "highway" bundles. Every surface switches at
   * paint time over its settled exact-edge substrate; selected-node wires always draw individually. */
  showHighways: boolean;
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
  /** The ORIGIN membership of an extracted graph: the raw selection ids (any kind), verbatim.
   * Empty closes an ordinary extraction, but an active review may intentionally own the surface
   * with no graph members while its file projection remains unselected. Immutable per build — it
   * is the seed-tier baseline and the Reset target. URL-synced as `mgraph`. */
  minimalSeedIds: string[];
  /** The mutable working set of MEMBERS shown in the overlay (starts = origin). Promoting a ghost adds
   * to it; removing a member drops from it. Ghosts are the members' on-map 1-hop ring, derived (not
   * stored). Reset restores it to the origin. */
  minimalMemberIds: string[];
  /** Explicit palette additions whose graph bodies may sit outside the semantic review slice.
   * Identity-only, capped by the projection contract, and captured with lightweight history. */
  minimalProjectionExtraIds: Set<string>;
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
  /** Codebase presentation's local disclosure overrides, preserved across nested extraction. */
  minimalCodebaseExpansionOverrides: Map<string, boolean>;
  /** Lightweight ids captured before the extracted ReactFlow scene is released for Codebase view. */
  minimalCodebaseTargetIds: string[];
  /** Disclosure gates captured with the target ids; never retains hidden ReactFlow nodes. */
  minimalCodebaseRetainedExpandedIds: Set<string>;
  /** True while a wider immutable projection pair is replacing the Codebase context. The view
   * renders an explicit busy shell instead of exposing nodes whose camera/layout may go stale. */
  minimalCodebaseProjectionPending: boolean;
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
  /** Per-unit ticks of the files checklist, keyed by nodeId — same persistence as reviewTicks. */
  reviewUnitTicks: Record<string, ReviewTick>;
  /** Explicit per-file viewed ticks, keyed by path (unit-less files only; else units derive it). */
  reviewFileTicks: Record<string, ReviewTick>;
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
  /** Show newly added, comment-only source rows as neutral context instead of diff additions.
   * Browser-local so the reader's source-diff preference follows them between reviews. */
  reviewHideAddedSourceCommentDiffs: boolean;
  /** Hides the review side panel so the graph takes the full width; session-only. */
  reviewPanelHidden: boolean;
  /** Shows existing GitHub review comments in canvas source widgets. Session-only; draft comment
   * composers and the submit queue stay available independently of this reader-facing layer. */
  reviewCommentsVisible: boolean;
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
  /** Lightweight parent coordinates for nested extraction. Rendered scenes live separately in the
   * shared bounded recent-view cache and may be evicted without removing a Back step. */
  minimalGraphHistory: MinimalGraphHistoryEntry[];
  /** Snapshot of the full seed list at review time — the "All groups" restore target. */
  reviewAllSeedIds: string[];
  /** Bumped by the Toolbar's "Recenter" action. The active graph surface subscribes to it and, on a
   * change, re-fits its viewport to the current selection — or to the whole graph when nothing is
   * selected. Ephemeral: never serialized to the URL (it is a signal, not navigation state). */
  recenterSeq: number;
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
  /** Direct POST endpoint for immutable PR head + merge-base preparation. */
  prepareUrl: string | null;
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
  /** Immutable head SHA (falling back to the ref only when GitHub omitted it) used by direct
   * PR-head source requests. Strict prepared reviews leave this null and use descriptor source. */
  reviewHeadRef: string | null;
  /** Base-to-HEAD edit mapping for a review whose active nodes still use base coordinates. */
  reviewDiffByFile: Record<string, { edits: LineEdit[]; kinds: ChangedLineSpan[] }>;
  /** Exact ordered +/- rows from the selected PR, keyed by canonical source path. */
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
  /** Removed patch text keyed like reviewDiffLinesByFile. */
  reviewRemovedByFile: Record<string, { afterNewLine: number; lines: string[] }[]>;
  /** Files whose removed patch text exceeded the server-side cap, keyed like reviewRemovedByFile. */
  reviewRemovedTruncatedByFile: Record<string, boolean>;
  /** The review-preparation lane: "preparing" while the server resolves refs, updates the shared
   * mirror, extracts both revisions, and publishes their bounded projections; otherwise idle/error. */
  prReviewStatus: "idle" | "preparing" | "error";
  /** The preparation stage currently running server-side; null outside "preparing". */
  prPrepareStage: PrPrepareStage | null;
  /** Server-reported elapsed time for the current v1 progress line. */
  prPrepareElapsedMs: number | null;
  /** Why preparation failed; null outside "error". */
  prPrepareError: string | null;
  /** Direct immutable endpoints for the prepared head; retained across a soft close. */
  prPreparedHead: PreparedGraphDescriptor | null;
  /** Direct immutable endpoints for the prepared merge base; retained across a soft close. */
  prPreparedMergeBase: PreparedGraphDescriptor | null;
  /** Opaque canonical changed-file coordinate currently projected on both comparison sides. */
  prPreparedReviewCursor: string | null;
  /** The latest requested file coordinate, separate from the committed cursor until both sides have
   * staged and passed the same-session compare-and-swap guard. */
  prPreparedFileProjectionPending: PreparedFileProjectionPending | null;
  /** Retryable per-file projection failure. It never changes the committed artifact/cursor. */
  prPreparedFileProjectionError: PreparedFileProjectionError | null;
  /** Canonical prepare inventory whose stable indexes define every review cursor. */
  prPreparedChangedFiles: PreparedChangedFile[];
  /** The head commit the server extracted for the prepared projection (the "done" payload's
   * provenance); shown in the review header. */
  prPreparedHeadSha: string | null;
  prPreparedMergeBaseSha: string | null;
  /** The merge-base half of the active, byte-charged composite review projection. */
  prReviewComparison: LoadedGraphProjection | null;
  /** True only while the active projection is the prepared PR-head graph. Unlike its id,
   * this disarms on a soft baseline restore and re-arms when resumePrReview swaps the graph back. */
  prPreparedArtifactCurrent: boolean;
  /** Lightweight boot-projection return coordinate. Decoded graph/index data stays exclusively in
   * the bounded projection cache and may be evicted while a prepared review is active. */
  prReviewBaseline: PrReviewBaseline | null;
  /** The open source view (inline panel or modal); null when nothing is being shown. */
  codeView: CodeView | null;
  /** Reveal one more containment level within the current selection (or the whole view / root
   * container when nothing is selected). Surface-aware: module surfaces and the Logic graph each. */
  expandAll(): void;
  /** Fully collapse the current selection (or the whole view / root container when nothing is
   * selected) — closes every open container in scope in one click. Surface-aware. */
  collapseAll(): void;
  recenter(): void;
  toggleFlowExplorer(): void;
  /** Select a flow and resolve only after every graph surface changed by that selection has
   * completed its current layout. Callers handling ordinary clicks may intentionally ignore the
   * promise; boot restoration awaits it before declaring the restored scene usable. */
  selectFlowEntry(ref: FlowSelectionRef | null): Promise<void>;
  /** Open one review flow in a requested projection without changing saved review preferences. */
  openReviewFlow(ref: FlowSelectionRef, view: ReviewFlowSplitView): void;
  /** Select one artifact node from the bottom flow pane. Request execution reveals/highlights the
   * exact observed node on the graph; PR review narrows the Map to that node's incident relationships
   * (including on-demand ghosts). Null clears request emphasis or restores the whole review flow. */
  selectFlowPaneTarget(nodeId: NodeId | null): Promise<void>;
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
  revealInView(rawId: string, expectedGraphId?: string | null): Promise<void>;
  /** ⌘P palette "+": add a picked symbol to the graph which is actually on screen. A minimal
   * graph owns its member list; otherwise the current map lens pins the owning unit/file as an
   * extra card. Inert outside those module surfaces. */
  addToView(rawId: string, expectedGraphId?: string | null): Promise<void>;
  openPaletteLogicFlow(rawId: string, expectedGraphId?: string | null): Promise<void>;
  /** Repository-wide in server sessions; bounded-current-projection only for local embedders. */
  searchSymbols(request: GraphSymbolSearchRequest, signal?: AbortSignal): Promise<GraphSymbolSearchResult>;
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
  buildMinimalGraph(): Promise<void>;
  setMinimalView(view: "graph" | "codebase"): Promise<void>;
  setMinimalShowGhostNodes(visible: boolean): void;
  setMinimalCodebaseExpansionOverride(nodeId: string, expanded: boolean): void;
  /** Restore one exact parent extracted graph without closing the overall overlay/review. */
  backMinimalGraph(): Promise<void>;
  closeMinimalGraph(): Promise<void>;
  resetMinimalGraph(): void;
  rearrangeMinimalGraph(): void;
  minimalRelayout(activity?: LayoutActivity): Promise<void>;
  setReviewLit(ids: Set<string> | null): void;
  setReviewFilesSort(sort: "path" | "risk"): void;
  /** Reveal a review unit, focusing its owning rollup first when the unit is not in the current scene. */
  selectReviewNode(id: string | null): void;
  /** Isolate one change group on the Map (null = "All groups"): re-seed the minimal overlay with only
   * that group's module ids and relayout. A no-op outside a review or when already active. */
  selectReviewGroup(groupId: string | null): Promise<void>;
  /** Further narrow the active review/group to a repo-relative path prefix. Null restores the group. */
  selectReviewPathScope(path: string | null): Promise<void>;
  /** Open one review container as an exact-file subgraph, bypassing the large-review rollup. */
  openReviewSubgraph(rootId: string): Promise<void>;
  /** Restore the exact immediate parent captured before openReviewSubgraph. */
  closeReviewSubgraph(): void;
  toggleReviewTick(flowId: string): void;
  resetReviewTicks(): void;
  /** Reveal a changed file, focusing its owning rollup first, then select/light/center its frame. */
  focusReviewFile(path: string): Promise<void>;
  toggleReviewUnitTick(nodeId: string): void;
  toggleReviewUnitsViewed(nodeIds: readonly string[]): void;
  toggleReviewFileViewed(path: string): void;
  toggleReviewFilesViewed(paths: readonly string[]): void;
  addReviewComment(path: string, nodeId: string | null, body: string, line?: number | null): void;
  openReviewLineComposer(path: string, line: number): void;
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
  setReviewHideAddedSourceCommentDiffs(hide: boolean): void;
  toggleReviewDiffOnly(): void;
  toggleReviewPanel(): void;
  toggleReviewCommentsVisible(): void;
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
  exploreRelatedPrs(): Promise<void>;
  clearRelatedPrs(): void;
  ensurePrSummary(number: number): Promise<void>;
  selectPr(number: number | null, options?: { endReviewSession?: boolean }): Promise<void>;
  /** Quietly compare the live GitHub head with the revision currently rendered. */
  checkPrReviewFreshness(): Promise<void>;
  /** Replace a stale review's files, discussion, checks, and graph without a page reload. */
  refreshPrReview(): Promise<void>;
  reviewPrInGraph(options?: ReviewEntryOptions): Promise<void>;
  /** Prepare the selected PR at a different extraction root and return the server-validated
   * immutable review URL. This never generates or installs an intermediate base graph. */
  preparePrReviewNavigation(subdir: string, signal?: AbortSignal): Promise<string>;
  /** Consume the immutable handoff injected for a validated shared review URL. Returns false only
   * when this boot has no handoff; any present-but-invalid handoff fails closed without POSTing. */
  restorePreparedPrReview(number: number, options?: ReviewEntryOptions): Promise<boolean>;
  /** Prepare both revisions: stream mirror/extraction progress, activate the paired bounded
   * projections, and run the review in head coordinates. On entry failure the PRs page stays put;
   * on refresh failure the prior immutable pair remains active. */
  prepareHeadGraph(options?: ReviewEntryOptions): Promise<void>;
  /** Re-open a review whose surface was soft-closed (explicit Close/lens switch) WITHOUT re-running
   * the expensive head prepare: reactivate the already-prepared projection if there was one,
   * repaint the kept amber, and rebuild the current review projection. Guarded on retained review
   * metadata with no active `review` payload; seed ids describe graph membership, not ownership. */
  resumePrReview(options?: ReviewEntryOptions): Promise<void>;
  /** Abandon an in-flight prepare-first entry; server work may continue behind the stale-seq guard. */
  cancelPrReviewPreparation(): void;
  /** Dismiss the head-extraction failure warning: clears the prepare-error lane. */
  dismissPrepareError(): void;
  relayout(): Promise<void>;
}

export interface StoreDependencies {
  artifact: GraphArtifact;
  index: GraphIndex;
  /** Required for server sessions; omitted only by isolated local/test embedders. */
  projectionDataSource?: GraphProjectionDataSource | null;
  /** Browser-wide inactive-memory coordinator shared by projections and navigation scenes. */
  recentAllocationBudget?: RecentAllocationBudget;
  /** The overview projection already activated during boot (avoids retaining a second pair). */
  initialProjection?: LoadedGraphProjection | null;
  /** Exact endpoints that produced initialProjection. Null only when no projection is active. */
  projectionEndpoints?: GraphProjectionEndpoints | null;
  provider: TelemetryProvider | null;
  telemetrySources?: TelemetrySourceRegistration[];
  telemetrySourceId?: string | null;
  hasOverlay: boolean;
  sourceUrl: string | null;
  /** Explicit, server-authored execution capability; null means code execution is disabled. */
  syntheticExecutionUrl?: string | null;
  syntheticExecutionTrust?: SyntheticExecutionTrust | null;
  syntheticScenarios?: SyntheticScenarioDescriptor[];
  prSessionSource?: PrSessionSource | null;
  prsUrl: string;
  prOneUrl: string;
  prFilesUrl: string;
  prRelatedUrl: string;
  prCommentsUrl: string;
  prChecksUrl: string;
  /** GET base for one changed file's text at the PR head ref (the review code panel's head-fetch). */
  prFileUrl?: string;
  /** Direct POST endpoint for PR preparation. Null only for non-GitHub/dev embedders. */
  prepareUrl?: string | null;
  /** Strict GET endpoint injected only for a server-validated shared review URL. */
  preparedReviewUrl?: string | null;
  /** POST target for submitting review comments (web sessions only; 404s elsewhere). */
  prReviewUrl: string;
}

export type BlueprintStore = StoreApi<BlueprintState>;

/** Metadata-only return coordinate for an ordinary projected graph while its broader codebase
 * sibling is active. Decoded artifacts remain owned exclusively by the bounded transport cache. */
interface MinimalCodebaseSingleProjectionBaseline {
  kind: "single";
  graphId: string;
  key: string;
  request: GraphProjectionRequest;
  endpoints: GraphProjectionEndpoints;
}

/** A prepared review is one atomic two-revision allocation, so its return coordinate carries both
 * immutable descriptors and promotes them together after cache eviction. */
interface MinimalCodebaseReviewProjectionBaseline {
  kind: "review";
  reviewNumber: number;
  headGraphId: string;
  mergeBaseGraphId: string;
  key: string;
  headRequest: GraphProjectionRequest;
  mergeBaseRequest: GraphProjectionRequest;
  headEndpoints: GraphProjectionEndpoints;
  mergeBaseEndpoints: GraphProjectionEndpoints;
}

type MinimalCodebaseProjectionBaseline =
  | MinimalCodebaseSingleProjectionBaseline
  | MinimalCodebaseReviewProjectionBaseline;

type ProjectionLayoutOwner = LayoutWorkOwner;

type ModuleLensMode = Exclude<ViewMode, "logic" | "prs">;

/** A cross-lens carry is resolved only after the destination projection is active. The staged raw
 * anchors are real immutable ids and therefore safe transport selectors; no outgoing view is asked
 * to manufacture another view's topology. */
interface PendingModuleLensTransition {
  mode: ModuleLensMode;
  anchors: string[];
}

/** One store installation may feed multiple layouts. Consumers of the exact same immutable
 * projection coordinate share both the read and the atomic promotion; only a different coordinate
 * is navigation and therefore allowed to supersede it. */
interface ProjectionHydrationFlight {
  key: string;
  shared: SubscriberAwareAsyncFlight<ProjectionLayoutOwner, boolean>;
}

interface PreparedReviewProjectionCoordinate {
  key: string;
  head: {
    graphId: string;
    request: GraphProjectionRequest;
    endpoints: GraphProjectionEndpoints;
  };
  mergeBase: {
    graphId: string;
    request: GraphProjectionRequest;
    endpoints: GraphProjectionEndpoints;
  };
}

/** Projection coordinates are metadata only; decoded pairs remain in the shared bounded cache. */
interface MinimalGraphProjectionFrame {
  active: MinimalCodebaseProjectionBaseline | null;
  codebaseBaseline: MinimalCodebaseProjectionBaseline | null;
}

/** Turn renderer navigation into the bounded, canonical server projection contract. The review
 * view is semantic: the server derives its changed-node rollups, so a repository-wide PR never
 * serializes every affected id back into the request body. */
export function projectionRequestForState(state: Pick<
  BlueprintState,
  | "viewMode"
  | "moduleFocus"
  | "moduleExpanded"
  | "moduleSelected"
  | "mapExtra"
  | "moduleGhostInspection"
  | "minimalMemberIds"
  | "minimalProjectionExtraIds"
  | "logicRoot"
  | "logicStack"
  | "logicFocus"
  | "expandedLogic"
  | "logicInlineDepth"
  | "logicSelected"
  | "compRoot"
  | "compSelectedId"
  | "flowSelection"
  | "flowPaneOrigin"
  | "requestFlowExpansionOverrides"
  | "requestFlowTraceId"
  | "selectedTraceId"
  | "requestTraces"
  | "syntheticExecution"
  | "artifact"
  | "showTests"
  | "coverageMode"
  | "prReviewed"
  | "prPreparedArtifactCurrent"
  | "prPreparedReviewCursor"
  | "prFiles"
  | "reviewBaseNodeIds"
>): GraphProjectionRequest {
  // A parked review keeps its lightweight payload/chip but is back on the ordinary baseline graph.
  // Only an actually-active prepared artifact may request the semantic review projection; deriving
  // it from prReviewed would silently reload HEAD again during baseline soft-close/navigation.
  const reviewView = state.prPreparedArtifactCurrent;
  const view: GraphProjectionRequest["view"] = reviewView
    ? "review" as const
    : state.viewMode === "prs"
      ? "modules" as const
      : state.viewMode === "call"
        ? "service" as const
        : state.viewMode;
  const logic = state.viewMode === "logic";
  // One file cursor already publishes that file's complete semantic subtree on both revisions.
  // Its disclosure set is therefore renderer presentation, not another transport coordinate. Only
  // explicit additions/flow work widen the pair; this prevents every file click from fetching the
  // same pair twice merely because the review auto-opens its changed declarations.
  const reviewCursorOwnsExpandedSubtree = reviewView
    && state.prPreparedReviewCursor !== null
    && state.minimalProjectionExtraIds.size === 0
    && state.flowSelection === null
    && state.flowPaneOrigin === null;
  const headIds = (ids: string[]): string[] => reviewView
    ? ids.filter((id) => !state.reviewBaseNodeIds.has(id))
    : ids;
  const focusIds = headIds(realProjectionIds([
    state.moduleFocus,
    state.compRoot,
    state.logicRoot,
    ...state.logicStack,
    ...state.logicFocus.map((focus) => focus.id),
  ]));
  // Large review membership is intentionally absent: `view: review` asks the server for its
  // precomputed semantic rollup. Only direct reader anchors join the current slice.
  const extraIds = headIds(realProjectionIds([
    ...state.moduleSelected,
    ...state.mapExtra,
    ...(state.moduleGhostInspection?.visitedIds ?? []),
    ...(reviewView ? state.minimalProjectionExtraIds : state.minimalMemberIds),
    state.logicSelected,
    state.compSelectedId,
    state.flowSelection?.rootId ?? null,
  ]));
  const expanded = logic ? state.expandedLogic : state.moduleExpanded;
  return {
    ...OVERVIEW_PROJECTION_REQUEST,
    view,
    filePaths: [],
    reviewCursor: reviewView ? state.prPreparedReviewCursor : null,
    focusIds,
    // Synthetic Service frames have their own selector. Keeping them out of the graph-id fields
    // makes the network contract honest: every generic id is an actual immutable graph identity.
    expandedIds: reviewCursorOwnsExpandedSubtree
      ? []
      : headIds(realProjectionIds(expanded, false)),
    extraIds,
    causalIds: headIds(projectionCausalIds(state)),
    serviceExpandedLeadIds: headIds(serviceExpandedLeadIds(expanded)),
    depth: Math.min(4, logic ? Math.max(1, state.logicInlineDepth + 1) : 1),
    includeTests: state.showTests,
    includeReachability: state.coverageMode,
  };
}

/** Translate renderer-only Service frames at the transport boundary. Domain wrappers never cross
 * that boundary: their immutable topology is response metadata, while an individual `svc:` frame
 * names one real lead unit. */
function realProjectionIds(
  ids: Iterable<string | null | undefined>,
  includeServiceLeads = true,
): string[] {
  const real = new Set<string>();
  for (const id of ids) {
    if (typeof id !== "string" || id.length === 0 || isServiceDomainId(id)) continue;
    const leadId = leadIdOf(id);
    if (leadId !== null) {
      if (includeServiceLeads && leadId.length > 0) real.add(leadId);
      continue;
    }
    real.add(id);
  }
  return [...real];
}

function serviceExpandedLeadIds(ids: Iterable<string | null | undefined>): string[] {
  const leads = new Set<string>();
  for (const id of ids) {
    if (typeof id !== "string") continue;
    const leadId = leadIdOf(id);
    if (leadId !== null && leadId.length > 0) leads.add(leadId);
  }
  return [...leads];
}

/** Exact runtime joins are an explicit bounded projection selector, never an inferred edge radius. */
const NO_REQUEST_FLOW_EXPANSIONS: ReadonlySet<string> = new Set<string>();

function projectionCausalIds(state: Pick<
  BlueprintState,
  | "flowPaneOrigin"
  | "requestFlowExpansionOverrides"
  | "requestFlowTraceId"
  | "selectedTraceId"
  | "requestTraces"
  | "syntheticExecution"
  | "artifact"
>): string[] {
  const traceIds = new Set<string>();
  if (state.selectedTraceId !== null) traceIds.add(state.selectedTraceId);
  if (state.flowPaneOrigin === "request" && state.requestFlowTraceId !== null) {
    traceIds.add(state.requestFlowTraceId);
  }
  const flows = (state.artifact.extensions?.logicFlow ?? {}) as unknown as LogicFlows;
  const nodeIds: string[] = [];
  for (const trace of state.requestTraces) {
    if (!traceIds.has(trace.traceId)) continue;
    nodeIds.push(...requestFlowProjectionIds(
      trace,
      flows,
      state.flowPaneOrigin === "request" && state.requestFlowTraceId === trace.traceId
        ? state.requestFlowExpansionOverrides
        : NO_REQUEST_FLOW_EXPANSIONS,
    ));
  }
  if (state.flowPaneOrigin === "synthetic" && state.syntheticExecution !== null) {
    nodeIds.push(...requestFlowProjectionIds(
      state.syntheticExecution.trace,
      flows,
      state.requestFlowExpansionOverrides,
    ));
  }
  return realProjectionIds(nodeIds).slice(0, 2_000);
}

/** Projection responses carry whole-revision claims and paint facts only for resident nodes. Test
 * identities come from that same resident index, so attaching them never retains another graph. */
function reachabilityForProjection(
  projection: LoadedGraphProjection,
): RendererReachabilityReport | null {
  return projection.reachability === null
    ? null
    : withReachabilityTestIds(projection.reachability, projection.index.testIds);
}

/** The `/api/source` base for the CURRENT graph: after a head projection swap the server serves the
 * PR-head checkout under the descriptor published by `/api/pr/prepare`,
 * so the boot URL's `id` is exchanged — else every source fetch would read base-clone bytes
 * against head-relative node locations. Every store source fetch must route through this. */
function activeSourceUrl(state: BlueprintState): string | null {
  if (!state.prPreparedArtifactCurrent || state.prPreparedHead === null) {
    return state.sourceUrl;
  }
  return state.prPreparedHead.sourceUrl;
}

/** Retained direct-preparation descriptors keep identifying a prepared review while its immutable
 * HEAD projection is softly parked. Treat either descriptor as ownership so a malformed partial
 * coordinate fails closed instead of silently falling back to the mutable live-PR source route. */
function hasPreparedReviewCoordinate(
  state: Pick<BlueprintState, "prPreparedHead" | "prPreparedMergeBase">,
): boolean {
  return state.prPreparedHead !== null || state.prPreparedMergeBase !== null;
}

/** The active capability URL is already immutable and graph-specific: boot injects the baseline
 * URL, while a prepared HEAD swap installs the descriptor's validated meta capability atomically. */
function activeSyntheticExecutionUrl(state: BlueprintState): string | null {
  return state.syntheticExecutionUrl;
}

function graphProjectionEndpoints(descriptor: PreparedGraphDescriptor): GraphProjectionEndpoints {
  return {
    graphId: descriptor.graphId,
    manifestUrl: descriptor.manifestUrl,
    projectionUrl: descriptor.projectionUrl,
    searchUrl: descriptor.searchUrl,
  };
}

async function stagePreparedReviewProjection(
  source: GraphProjectionDataSource,
  state: BlueprintState,
  signal?: AbortSignal,
): Promise<StagedReviewProjection> {
  const coordinate = preparedReviewProjectionCoordinate(state);
  const staged = source.stageCachedReview(coordinate.key)
    ?? await source.stageReviewPair({
      head: { request: coordinate.head.request, endpoints: coordinate.head.endpoints },
      mergeBase: { request: coordinate.mergeBase.request, endpoints: coordinate.mergeBase.endpoints },
      signal,
    });
  const projection = staged.projection;
  if (projection.head.graphId !== coordinate.head.endpoints.graphId
    || projection.mergeBase.graphId !== coordinate.mergeBase.endpoints.graphId) {
    staged.release();
    throw new Error("prepared review projection identity does not match its descriptor capability");
  }
  assertPreparedReviewProjectionFacts(
    projection,
    state.prPreparedChangedFiles,
    state.prPreparedReviewCursor,
  );
  return staged;
}

function preparedReviewProjectionCoordinate(
  state: BlueprintState,
): PreparedReviewProjectionCoordinate {
  if (state.prPreparedHead === null || state.prPreparedMergeBase === null) {
    throw new Error("prepared PR review requires both HEAD and merge-base descriptors");
  }
  const headRequest: GraphProjectionRequest = {
    ...projectionRequestForState(state),
    view: "review",
    filePaths: [],
    reviewCursor: state.prPreparedReviewCursor,
  };
  const mergeBaseRequest = mergeBaseProjectionRequest(headRequest);
  const headKey = canonicalProjectionKey(state.prPreparedHead.graphId, headRequest);
  const mergeBaseKey = canonicalProjectionKey(state.prPreparedMergeBase.graphId, mergeBaseRequest);
  return {
    key: canonicalReviewProjectionKey(headKey, mergeBaseKey),
    head: {
      graphId: state.prPreparedHead.graphId,
      request: headRequest,
      endpoints: graphProjectionEndpoints(state.prPreparedHead),
    },
    mergeBase: {
      graphId: state.prPreparedMergeBase.graphId,
      request: mergeBaseRequest,
      endpoints: graphProjectionEndpoints(state.prPreparedMergeBase),
    },
  };
}

function mergeBaseProjectionRequest(headRequest: GraphProjectionRequest): GraphProjectionRequest {
  return {
    ...headRequest,
    // Node ids from HEAD are not stable evidence that the same declaration exists at merge-base.
    // Paths are the cross-revision routing key; the server supplies the relevant base-side subtree.
    focusIds: [],
    expandedIds: [],
    extraIds: [],
    causalIds: [],
    serviceExpandedLeadIds: [],
    depth: 1,
    includeReachability: false,
  };
}

function snapshotProjectionRequest(request: GraphProjectionRequest): GraphProjectionRequest {
  return {
    ...request,
    filePaths: [...request.filePaths],
    focusIds: [...request.focusIds],
    expandedIds: [...request.expandedIds],
    extraIds: [...request.extraIds],
    causalIds: [...request.causalIds],
    serviceExpandedLeadIds: [...request.serviceExpandedLeadIds],
  };
}

function projectionWithContextGates(
  request: GraphProjectionRequest,
  expansionIds: Iterable<string>,
): GraphProjectionRequest {
  return {
    ...snapshotProjectionRequest(request),
    expandedIds: [...new Set([...request.expandedIds, ...expansionIds])].sort(),
  };
}

/** A two-sided presentation can contain merge-base tombstone ids. Strip them from every HEAD-only
 * selector before widening a request; filtering only the new gates would let an older baseline
 * reintroduce the same invalid identity during a later Codebase expansion. */
function projectionWithoutIds(
  request: GraphProjectionRequest,
  excludedIds: ReadonlySet<string>,
): GraphProjectionRequest {
  if (excludedIds.size === 0) return snapshotProjectionRequest(request);
  const keep = (id: string) => !excludedIds.has(id);
  return {
    ...snapshotProjectionRequest(request),
    focusIds: request.focusIds.filter(keep),
    expandedIds: request.expandedIds.filter(keep),
    extraIds: request.extraIds.filter(keep),
    causalIds: request.causalIds.filter(keep),
    serviceExpandedLeadIds: request.serviceExpandedLeadIds.filter(keep),
  };
}

/** Map a required HEAD disclosure gate to a comparison-side gate only through a unique semantic
 * source path. A coincidentally equal graph id is never treated as cross-revision evidence. */
function pathDerivedComparisonGates(
  headIndex: GraphIndex,
  comparisonIndex: GraphIndex,
  headExpansionIds: Iterable<string>,
): string[] {
  const comparisonByPath = new Map<string, string[]>();
  for (const node of comparisonIndex.nodesById.values()) {
    const key = contextGatePathKey(node);
    if (key === null) continue;
    const matches = comparisonByPath.get(key);
    if (matches === undefined) comparisonByPath.set(key, [node.id]);
    else matches.push(node.id);
  }
  const resolved = new Set<string>();
  for (const headId of headExpansionIds) {
    const headNode = headIndex.nodesById.get(headId);
    const key = headNode === undefined ? null : contextGatePathKey(headNode);
    if (key === null) continue;
    const matches = comparisonByPath.get(key);
    if (matches?.length === 1) resolved.add(matches[0]);
  }
  return [...resolved].sort();
}

function contextGatePathKey(node: GraphNode): string | null {
  const path = node.location?.file;
  if (typeof path !== "string" || path.length === 0) return null;
  return `${node.kind}\u0000${path}\u0000${node.qualifiedName}`;
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

/** `/api/prs/file` URL for one changed file's text at the selected PR head ref. */
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
  /** Present when base-relative node coordinates must be sliced from a whole HEAD file. */
  headSpan: { start: number; end: number } | null;
  headKinds: readonly ChangedLineSpan[];
  diffLines: readonly ChangedDiffLine[];
  /** See CodeView.diffOldSpan. */
  diffOldSpan: LineRange | null | undefined;
  sourceSide: "head" | "base";
}

type CodePayload = SourceTextPayload;

type CodePayloadCache = BoundedAsyncValueCache<string, CodePayload>;

const CODE_PAYLOAD_CACHE_LIMITS = {
  maxEntries: 32,
  maxResidentBytes: 8 * 1024 * 1024,
  maxFlights: 8,
  maxActiveFlights: 2,
  maxActiveBytes: SOURCE_TEXT_TRANSIENT_BYTES * 2,
  maxSubscribers: 32,
} as const;

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

/** Map base-projection evidence onto the source coordinates codeLoadRequest will display. */
function displayedEvidenceSpan(
  context: EdgeEvidenceContext,
  state: BlueprintState,
  prFileUrl: string | null,
): { start: number; end: number } {
  const start = context.site.line;
  const end = Math.max(start, context.site.endLine ?? start);
  const diff = state.reviewDiffByFile[context.site.file] ?? null;
  const removedAtHead = state.reviewFileDelta[context.site.file]?.status === "removed";
  const readsLiveReviewHead = !hasPreparedReviewCoordinate(state)
    && !removedAtHead
    && state.prReviewed !== null
    && prFileUrl !== null
    && state.reviewHeadRef !== null;
  return readsLiveReviewHead && diff !== null ? headSpanFor(start, end, diff.edits) : { start, end };
}

/** Resolve the source request once so click-to-open and hover-preview read identical code. */
function codeLoadRequest(
  node: GraphNode,
  opts: { wholeFile?: boolean } | undefined,
  state: BlueprintState,
  sourceUrl: string | null,
  prFileUrl: string | null,
): CodeLoadRequest | null {
  if (!isSourceBackedNode(node)) {
    return null;
  }
  // A prepared PR projection has its own retained source root. Every code surface reads the exact
  // immutable HEAD or merge-base descriptor; GitHub patch text is never used as a source fallback.
  const preparedArtifactCurrent = state.prPreparedArtifactCurrent;
  const preparedReviewCoordinate = hasPreparedReviewCoordinate(state);
  const removedAtHead = state.reviewFileDelta[node.location.file]?.status === "removed";
  const readsComparisonBase = state.reviewBaseNodeIds.has(node.id) || removedAtHead;
  const resolvedSourceUrl = preparedArtifactCurrent
    ? readsComparisonBase
      ? state.prPreparedMergeBase?.sourceUrl ?? null
      : activeSourceUrl(state)
    : sourceUrl;
  // The strict prepared path reads immutable descriptor source directly. The PR-head endpoint is
  // still required for the current main-side base-coordinate source contract (including files
  // without graph nodes); it is never an analysis or graph fallback.
  const reviewDiff = !preparedReviewCoordinate && state.prReviewed !== null && prFileUrl !== null && state.reviewHeadRef !== null
    ? state.reviewDiffByFile[node.location.file] ?? null
    : null;
  const readsLiveReviewHead = !preparedReviewCoordinate && !readsComparisonBase
    && state.prReviewed !== null && prFileUrl !== null && state.reviewHeadRef !== null
    && (reviewDiff !== null || state.reviewFileDelta[node.location.file] !== undefined);
  if (!readsLiveReviewHead && !resolvedSourceUrl) {
    return null;
  }
  const wholeFile = opts?.wholeFile ?? false;
  const headSpan = readsLiveReviewHead && !wholeFile
    ? reviewDiff === null
      ? { start: node.location.startLine, end: node.location.endLine ?? node.location.startLine }
      : headSpanFor(node.location.startLine, node.location.endLine ?? node.location.startLine, reviewDiff.edits)
    : null;
  const baseLine = wholeFile ? 1 : headSpan?.start ?? node.location.startLine;
  // A deletion cursor at `endLine + 1` is inherently shared by the declarations on either side of
  // that boundary. Declaration previews therefore need the exact old-side counterpart span before
  // accepting the row. The comparison projection supplies the fail-closed semantic counterpart. File
  // modules and explicit whole-file views intentionally remain cursor-scoped so EOF deletions stay
  // visible even when the extractor's module span stops before the physical final line.
  const scopesDeletedRows = !wholeFile && node.kind !== "module" && !readsComparisonBase;
  const diffOldSpan: LineRange | null | undefined = !scopesDeletedRows
    ? undefined
    : preparedArtifactCurrent && state.prReviewComparison !== null
      ? state.reviewBaseSpanByHeadId.get(node.id) ?? null
      : readsLiveReviewHead
        ? { start: node.location.startLine, end: node.location.endLine ?? node.location.startLine }
        : undefined;
  const normalizedFile = node.location.file.replace(/\\/g, "/");
  // Prepared/local artifacts carry the canonical merge-base diff beside the graph. A base-shaped
  // PR source view uses its explicit HEAD edit map and never hybridizes the two authorities.
  const artifactKinds = !readsComparisonBase && (preparedArtifactCurrent || state.prReviewed === null)
    ? changedLineKindsFromExtensions(state.artifact.extensions)?.[normalizedFile]
    : undefined;
  const artifactDiffLines = preparedArtifactCurrent || state.prReviewed === null
    ? changedDiffLinesFromExtensions(state.artifact.extensions)?.[normalizedFile]
    : undefined;
  const reviewDiffLines = preparedArtifactCurrent || readsLiveReviewHead
    ? state.reviewDiffLinesByFile[node.location.file] ?? state.reviewDiffLinesByFile[normalizedFile]
    : undefined;
  return {
    node,
    url: readsLiveReviewHead
      ? prFileHeadUrl(prFileUrl, node.location.file, state.reviewHeadRef!)
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

/** Attach a structural focus without changing canonical declaration or diff ownership. */
function withCodePreviewFocus(
  view: CodeView,
  node: GraphNode,
  focus: FlowSourceAnchor,
  request: CodeLoadRequest,
  state: BlueprintState,
): CodeView {
  if (
    normalizeReviewFilePath(focus.file) !== normalizeReviewFilePath(node.location.file)
    || view.code === null
  ) {
    return view;
  }
  let range: LineRange = {
    start: Math.max(1, focus.line),
    end: Math.max(Math.max(1, focus.line), focus.endLine ?? focus.line),
  };
  if (request.headSpan !== null && !state.prPreparedArtifactCurrent) {
    const normalizedFile = normalizeReviewFilePath(focus.file);
    const reviewDiff = state.reviewDiffByFile[focus.file]
      ?? state.reviewDiffByFile[normalizedFile]
      ?? null;
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
  payloadCache: CodePayloadCache,
  signal?: AbortSignal,
): Promise<CodeView | null> {
  const key = request.url.toString();
  try {
    const data = await payloadCache.load(
      key,
      { estimatedBytes: SOURCE_TEXT_TRANSIENT_BYTES, signal },
      (flightSignal) => fetchSourceText(globalThis.fetch.bind(globalThis), request.url, flightSignal),
    );
    if (request.headSpan !== null) {
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
    const baseLine = data.startLine;
    const lineCount = data.lineCount;
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
  } catch (error) {
    if (signal?.aborted || (error instanceof DOMException && error.name === "AbortError")) return null;
    // Failed payloads never enter the shared LRU; a later hover/click may retry them.
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

/** Slice a whole HEAD-file response to the mapped declaration span and retain exact diff paint. */
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
    ...(changedLineKinds.size > 0
      ? { changedLineKinds, changedLines: new Set(changedLineKinds.keys()) }
      : {}),
  };
}

/** Whether changing only this view's chrome keeps the active composer mounted on the exact same
 * HEAD source row. This lets inline → modal expansion feel continuous while still guarding an
 * unrelated hover-card draft that happens to coexist with an older inline source view. */
function codeViewCanHostReviewLineComposer(state: BlueprintState, view: CodeView): boolean {
  const composer = state.reviewLineComposer;
  if (
    composer === null
    || state.review === null
    || composer.reviewKey !== state.review.context.reviewKey
    || composer.lineRevision !== prReviewRevisionKey(state.prReviewRevision)
    || composer.path !== view.node.location.file
    || (view.sourceSide ?? "head") !== "head"
    || view.code === null
  ) {
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
  if (moduleGraphSurfaceOwner(state) === "prepared-review-overview") {
    return 0;
  }
  if (moduleGraphSurfaceOwner(state) === "extracted") {
    return minimalSelectionRemovalIds(state).length;
  }
  return moduleSelectionRemovalPlan(state).selectionIds.length;
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
    || moduleGraphSurfaceOwner(state) !== "source"
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
  const projectionDataSource = dependencies.projectionDataSource ?? null;
  const initialProjectionEndpoints = dependencies.projectionEndpoints ?? null;
  if (dependencies.initialProjection != null && initialProjectionEndpoints === null) {
    throw new Error("an initial graph projection requires its exact transport endpoints");
  }
  let projectionRequestSeq = 0;
  let projectionRequestController: AbortController | null = null;
  let projectionHydrationFlight: ProjectionHydrationFlight | null = null;
  let preparedFileProjectionSeq = 0;
  let preparedFileProjectionRequest: {
    token: number;
    path: string;
    cursor: string;
    committedCursor: string | null;
    reviewNumber: number;
    head: PreparedGraphDescriptor;
    mergeBase: PreparedGraphDescriptor;
    changedFiles: PreparedChangedFile[];
    controller: AbortController;
    promise: Promise<boolean>;
  } | null = null;
  let pendingModuleLensTransition: PendingModuleLensTransition | null = null;
  let minimalCodebaseProjectionBaseline: MinimalCodebaseProjectionBaseline | null = null;
  let minimalCodebaseProjectionActivitySeq = 0;
  const minimalSceneCache = new RecentViewProjectionCache<string, MinimalGraphSceneSnapshot>(
    DEFAULT_RECENT_ALLOCATION_BUDGET_LIMITS,
    dependencies.recentAllocationBudget,
  );
  const minimalProjectionFrames = new Map<string, MinimalGraphProjectionFrame>();
  /** One combined history-entry + projection-frame charge for every semantic Back coordinate. */
  const minimalNavigationResidentBytes = new Map<string, number>();
  let minimalSceneSequence = 0;
  let currentMinimalSceneKey: string | null = null;
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
  const cancelProjectionHydration = () => {
    const flight = projectionHydrationFlight;
    flight?.shared.abort(new DOMException("Projection hydration was superseded", "AbortError"));
    projectionRequestController?.abort();
    projectionRequestController = null;
    projectionRequestSeq += 1;
    if (projectionHydrationFlight === flight) projectionHydrationFlight = null;
  };
  // Selected ids whose just-removed membership may leave no settled card. Any winning module
  // layout consumes this set, so a superseded Remove layout cannot strand a palette-only pick.
  const pendingModuleSelectionPrune = new Set<string>();
  // Opening Extract from temporary ghost exploration hides the source scene. Defer rebuilding that
  // source until Extract closes instead of retaining a second invisible structural ELK input.
  let moduleSceneNeedsRestore = false;
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
    options: {
      minimalRollups?: Readonly<Record<string, readonly string[]>>;
      expandedIds?: ReadonlySet<string>;
    } = {},
  ): MinimalCodebaseContext | null => {
    const flows = (state.artifact.extensions?.logicFlow ?? {}) as unknown as LogicFlows;
    return deriveMinimalCodebaseContext({
      index: state.index,
      moduleGraph: (moduleGraph ??= buildModuleGraph(state.index)),
      blockDeps: (blockDeps ??= buildBlockDeps(state.index)),
      flows,
      minimalMemberIds: targetIds,
      minimalRollups: options.minimalRollups,
      expandedIds: options.expandedIds,
      hiddenIds: state.showTests ? EMPTY_HIDDEN_IDS : state.index.testIds,
      demoteCommons: false,
    });
  };
  const minimalCodebaseInputsForState = (state: BlueprintState): {
    targetIds: string[];
    retainedExpandedIds: Set<string>;
  } => {
    const currentMinimalNodes = state.minimalLayoutStatus === "ready" ? state.minimalRfNodes : [];
    const derivedTargetIds = [...new Set([
      ...state.minimalMemberIds,
      ...state.moduleSelected,
      ...currentMinimalNodes
        .filter((node) => node.type !== "ghost" && state.index.nodesById.has(node.id))
        .map((node) => node.id),
    ])];
    const derivedExpandedIds = new Set([
      ...[...state.moduleExpanded].filter((id) => id.startsWith("step:")),
      ...currentMinimalNodes
        .filter((node) => (node.data as { isExpanded?: unknown }).isExpanded === true)
        .map((node) => node.id),
    ]);
    return state.minimalView === "codebase" && state.minimalCodebaseTargetIds.length > 0
      ? {
          targetIds: [...new Set([...state.minimalCodebaseTargetIds, ...state.moduleSelected])],
          retainedExpandedIds: new Set(state.minimalCodebaseRetainedExpandedIds),
        }
      : { targetIds: derivedTargetIds, retainedExpandedIds: derivedExpandedIds };
  };
  /** The codebase-context projection is derived from exactly what the extracted graph already
   * disclosed. Its canonical ancestor gates are transport selectors only: the hidden graph's
   * moduleExpanded/minimal RF state is never mutated. */
  const minimalCodebaseContextForState = (state: BlueprintState): MinimalCodebaseContext | null => {
    const { targetIds, retainedExpandedIds } = minimalCodebaseInputsForState(state);
    const flows = (state.artifact.extensions?.logicFlow ?? {}) as unknown as LogicFlows;
    return deriveMinimalCodebaseContext({
      index: state.index,
      moduleGraph: (moduleGraph ??= buildModuleGraph(state.index)),
      blockDeps: (blockDeps ??= buildBlockDeps(state.index)),
      flows,
      minimalMemberIds: targetIds,
      minimalRollups: state.minimalRollups,
      hiddenIds: state.showTests ? EMPTY_HIDDEN_IDS : state.index.testIds,
      expandedIds: retainedExpandedIds,
      demoteCommons: false,
    });
  };
  // The composition unit index (member → owning unit), built lazily on the first ⌘P reveal/add so a
  // picked symbol resolves to the unit/module card that draws it. Cached like moduleGraph/blockDeps.
  let unitIndex: UnitIndex | null = null;
  // Resolve any symbol to the card the map lenses actually draw: its nearest owning unit
  // (class/interface/object), or its module for a top-level callable (module is itself a UNIT_KIND).
  const resolveCard = (id: string, index: GraphIndex): string => {
    unitIndex ??= buildUnitIndex([...index.nodesById.values()]);
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
  let relatedPrsSeq = 0;
  let prFilesSeq = 0;
  const prSummaryRequests = new Map<number, Promise<void>>();
  // Every discussion read (selection, refresh, or post-submit) shares one last-started-wins lane.
  let prDiscussionSeq = 0;
  let prFilesRequest: { number: number; sequence: number; promise: Promise<void> } | null = null;
  let prFreshnessRequest: { number: number; revision: PrReviewRevision; promise: Promise<void> } | null = null;
  let prReviewRefreshSeq = 0;
  let prPrepareSeq = 0;
  // Aggregate metrics and request traces share one invalidation sequence. Each settles independently,
  // while a newer load/environment prevents either stale channel from repainting the store.
  let telemetryFetchSeq = 0;
  // Local code execution is explicit and independently stale-guarded. Selecting another flow or
  // starting a newer run invalidates the prior child-process response without touching telemetry.
  let syntheticExecutionSeq = 0;
  let prPrepareCancellation: { sequence: number; resolve: () => void; controller: AbortController } | null = null;
  let preparedReviewRestoreController: AbortController | null = null;
  let prReviewEntryRequest: { number: number; promise: Promise<void> } | null = null;
  let prReviewResumeGeneration = 0;
  let prReviewResumeRequest: {
    generation: number;
    number: number;
    controller: AbortController;
  } | null = null;
  const cancelPrReviewResumeRequest = (): void => {
    prReviewResumeGeneration += 1;
    const request = prReviewResumeRequest;
    prReviewResumeRequest = null;
    request?.controller.abort();
  };
  // Edge-evidence context switches are asynchronous source reads; only the latest click may win.
  let edgeEvidenceSeq = 0;
  // Every global source host shares this lane. Node id alone is insufficient because a node slice,
  // its whole file, and edge evidence can all request the same id with different coordinates.
  let codeViewSeq = 0;
  let codeViewController: AbortController | null = null;
  const cancelCodeViewRequest = () => {
    codeViewController?.abort(new DOMException("Source view was superseded", "AbortError"));
    codeViewController = null;
  };
  // Dirty-composer navigation stays out of Zustand because callbacks are ephemeral behavior, not
  // renderable state. The composer itself carries the visible confirmation; Discard replays the
  // exact attempted source/lens/revision transition, while Keep editing clears this callback.
  let pendingReviewLineComposerTransition: (() => void) | null = null;
  const prsNextPage: Record<PrsTab, number> = { open: 1, closed: 1 };
  // PR-head reads return an entire file. Share that response across every changed node in the file;
  // fetchCodeView still slices and annotates a separate node-specific view for each caller.
  const codePayloadCache: CodePayloadCache = new BoundedAsyncValueCache(
    CODE_PAYLOAD_CACHE_LIMITS,
    // JavaScript strings may occupy two bytes per code unit. The small fixed allowance covers the
    // payload record and numeric metadata without pretending to be an exact heap measurement.
    (payload) => payload.code.length * 2 + 128,
  );
  // ELK does not currently stop once its bundled main-thread pass begins. Each surface therefore
  // uses one serialized structural lane which can retain only the physical active pass and newest
  // coordinate ACROSS Map, Logic, and Extract. Flow-pane layout has a second lane because it is a
  // visibly concurrent split surface. Superseded coordinates never start beside the active pass.
  const layoutCoordinator = new LatestOnlyLayoutCoordinator();
  const invalidateLogicLayout = () => {
    logicLayoutSeq += 1;
    layoutCoordinator.cancel("logic");
  };
  // Rebuilding/closing the minimal overlay must discard any of its ELK passes still in flight; the
  // extracted review body shares this invalidation with the in-store actions that own the counter.
  const invalidateMinimalLayout = () => {
    minimalLayoutSeq += 1;
    layoutCoordinator.cancel("minimal");
  };
  const invalidateModuleLayout = () => {
    moduleLayoutSeq += 1;
    layoutCoordinator.cancel("module");
  };
  const invalidateFlowPaneLayout = () => {
    flowPaneLayoutSeq += 1;
    layoutCoordinator.cancel("flow-pane");
  };
  const invalidateRequestFlowWork = () => {
    invalidateFlowPaneLayout();
    requestTargetRevealSeq += 1;
  };
  // A PR-review swap/restore replaces the WHOLE artifact/index, so every "built once per artifact"
  // cache must rebuild from the incoming index — and any overlay ELK pass in flight must drop.
  const invalidateArtifactCaches = (
    options: {
      layoutOwner?: ProjectionLayoutOwner;
      layoutOwners?: ReadonlySet<ProjectionLayoutOwner>;
    } = {},
  ) => {
    moduleGraph = null;
    blockDeps = null;
    unitIndex = null;
    cancelCodeViewRequest();
    codePayloadCache.clear();
    const retainedOwners: ReadonlySet<ProjectionLayoutOwner> = options.layoutOwners
      ?? (options.layoutOwner === undefined
        ? new Set<ProjectionLayoutOwner>()
        : new Set([options.layoutOwner]));
    // Promotion swaps the whole artifact/index. Only layouts explicitly sharing this install may
    // keep running; every other structural or split-pane task still owns the outgoing projection.
    layoutCoordinator.cancelAllExcept(retainedOwners);
    const owns = (owner: ProjectionLayoutOwner): boolean => retainedOwners.has(owner);
    if (!owns("module")) invalidateModuleLayout();
    if (!owns("minimal")) invalidateMinimalLayout();
    if (!owns("logic")) invalidateLogicLayout();
    if (!owns("flow-pane")) invalidateFlowPaneLayout();
  };
  const invalidateSyntheticArtifactBoundary = () => {
    syntheticExecutionSeq += 1;
    invalidateFlowPaneLayout();
  };
  // The parsed review payload from the initial `meridian review` projection (null when it carries no
  // valid `review` extension). Live PR projections populate their review independently at runtime.
  const artifactReview = deriveReviewData(dependencies.artifact, dependencies.index);
  // Only the schema-level context is needed for later Tests re-projection. Capturing ReviewData here
  // would pin its complete LogicFlows object for the lifetime of the store outside the graph cache.
  const artifactReviewContext = artifactReview?.context ?? null;
  const initialReviewProjection = artifactReviewContext
    ? deriveReviewProjection(artifactReviewContext, dependencies.artifact, dependencies.index, { baseIndex: null, showTests: false })
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
          changedLineKindsFromExtensions(dependencies.artifact.extensions),
          changedDiffLinesFromExtensions(dependencies.artifact.extensions),
        ),
      ),
    );
  }
  const initialSyntheticExecutionUrl = dependencies.syntheticExecutionUrl ?? null;
  const initialSyntheticExecutionTrust = dependencies.syntheticExecutionTrust ?? null;
  const initialSyntheticScenarios = [...(dependencies.syntheticScenarios ?? [])];
  // The files checklist + persisted progress for an artifact-sourced review; a GitHub PR opened via
  // reviewPrInGraph re-derives both at runtime under its own reviewKey.
  const reviewFiles = initialReviewProjection?.files ?? [];
  const initialProgress = review ? readReviewProgress(review.context.reviewKey) : null;
  const reviewPreferences = readReviewPreferences();
  // Null when the server didn't ship source access — the code drawer is then inert.
  const sourceUrl = dependencies.sourceUrl;
  const prSessionSource = dependencies.prSessionSource ?? null;
  const githubSource = prSessionSource !== null;
  const prsUrl = dependencies.prsUrl;
  const prOneUrl = dependencies.prOneUrl;
  const prFilesUrl = dependencies.prFilesUrl;
  const prRelatedUrl = dependencies.prRelatedUrl;
  const prCommentsUrl = dependencies.prCommentsUrl;
  const prChecksUrl = dependencies.prChecksUrl;
  const prFileUrl = dependencies.prFileUrl ?? null;
  const prepareUrl = prSessionSource === null ? null : dependencies.prepareUrl ?? null;
  const preparedReviewUrl = prSessionSource === null ? null : dependencies.preparedReviewUrl ?? null;
  if (prepareUrl !== null && projectionDataSource === null) {
    throw new Error("PR preparation requires graph projection transport");
  }
  if (preparedReviewUrl !== null && projectionDataSource === null) {
    throw new Error("Prepared PR handoff requires graph projection transport");
  }
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
    const nextMinimalSceneKey = (): string => `minimal-scene:${++minimalSceneSequence}`;
    const ensureMinimalSceneKey = (): string => {
      currentMinimalSceneKey ??= nextMinimalSceneKey();
      return currentMinimalSceneKey;
    };
    const publishCurrentMinimalScene = (state: BlueprintState): string => {
      const key = ensureMinimalSceneKey();
      if (state.minimalView !== "graph" || state.minimalSeedIds.length === 0) return key;
      const scene = captureMinimalGraphScene(state);
      minimalSceneCache.setActive(key, scene, minimalGraphSceneResidentBytes(scene));
      return key;
    };
    /** Offer the current graph scene to the shared inactive budget before hiding/nesting it. */
    const retainCurrentMinimalScene = (state: BlueprintState): string => {
      const key = ensureMinimalSceneKey();
      if (state.minimalView === "graph") {
        publishCurrentMinimalScene(state);
        minimalSceneCache.deactivateActive();
      } else {
        // The extracted sibling was already released on Codebase entry. A history push is real reuse
        // and should refresh its global LRU recency when the scene still exists.
        void minimalSceneCache.get(key);
      }
      return key;
    };
    const startNewMinimalScene = (): string => {
      currentMinimalSceneKey = nextMinimalSceneKey();
      return currentMinimalSceneKey;
    };
    const clearMinimalSceneNavigation = (): void => {
      minimalSceneCache.clear();
      minimalProjectionFrames.clear();
      minimalNavigationResidentBytes.clear();
      currentMinimalSceneKey = null;
    };
    const resetMinimalProjectionNavigationForRevision = (): void => {
      projectionRequestController?.abort();
      projectionRequestController = null;
      projectionRequestSeq += 1;
      minimalCodebaseProjectionActivitySeq += 1;
      minimalCodebaseProjectionBaseline = null;
      clearMinimalSceneNavigation();
      set({
        minimalCodebaseProjectionPending: false,
        minimalProjectionExtraIds: new Set<string>(),
      });
    };
    const restoreCurrentMinimalScene = async (
      activity: LayoutActivity = { label: "Restoring extracted graph…" },
    ): Promise<boolean> => {
      const key = ensureMinimalSceneKey();
      const scene = minimalSceneCache.activate(key);
      if (scene !== undefined) {
        set({
          ...restoreMinimalGraphScene(scene),
          minimalCodebaseTargetIds: [],
          minimalCodebaseRetainedExpandedIds: new Set<string>(),
          minimalCodebaseProjectionPending: false,
        });
        return true;
      }
      const state = get();
      const needsLayout = state.minimalMemberIds.length > 0;
      set({
        minimalBasePositions: {},
        minimalRfNodes: [],
        minimalRfEdges: [],
        minimalLayoutStatus: needsLayout ? "laying-out" : "idle",
        minimalLayoutActivity: needsLayout ? activity : null,
        minimalCodebaseTargetIds: [],
        minimalCodebaseRetainedExpandedIds: new Set<string>(),
        minimalCodebaseProjectionPending: false,
      });
      if (needsLayout) await get().minimalRelayout(activity);
      return false;
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
    const focusReviewSubgraph = async (
      rootId: string,
      reveal: ReviewSubgraphReveal | null,
      retry: () => void,
    ): Promise<boolean> => {
      if (
        get().minimalView === "graph"
        && minimalCodebaseProjectionBaseline !== null
        && !await ensureExtractedGraphProjection()
      ) return false;
      const state = get();
      const root = state.index.nodesById.get(rootId);
      if (
        state.review === null
        || state.minimalCodebaseProjectionPending
        || state.minimalSeedIds.length === 0
        || (state.minimalView === "graph" && state.minimalLayoutStatus !== "ready")
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
      invalidateFlowPaneLayout();
      invalidateMinimalLayout();
      const history = appendMinimalGraphHistoryFrame(state);
      startNewMinimalScene();
      minimalCodebaseProjectionBaseline = null;
      set({
        reviewFocusedSubgraph: {
          rootId,
          label: root.displayName || rootId,
          filePaths: [...new Set(matched.map((match) => match.path))].sort(),
          moduleIds: seeds,
        },
        minimalGraphHistory: history,
        minimalView: "graph",
        minimalShowGhostNodes: true,
        minimalCodebaseExpansionOverrides: new Map<string, boolean>(),
        minimalCodebaseTargetIds: [],
        minimalCodebaseRetainedExpandedIds: new Set<string>(),
        minimalCodebaseProjectionPending: false,
        minimalProjectionExtraIds: new Set<string>(),
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
      void requestMinimalRelayout(activity).then(() => {
        const current = get();
        if (
          reveal !== null
          && current.minimalLayoutStatus === "ready"
          && current.reviewFocusedSubgraph?.rootId === rootId
          && current.reviewSelectedId === reveal.selectedId
          && isRealMinimalNode(current, reveal.selectedId)
        ) {
          set({ recenterSeq: current.recenterSeq + 1 });
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
      if (state.flowSelection !== null || state.flowPaneOrigin !== null) {
        invalidateFlowPaneLayout();
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
          set({ recenterSeq: current.recenterSeq + 1 });
        }
      });
      return true;
    };

    const reprojectArtifactReview = (showTests: boolean): void => {
      const state = get();
      if (state.prReviewed !== null || artifactReviewContext === null || state.review === null) {
        return;
      }
      const projection = deriveReviewProjection(artifactReviewContext, state.artifact, state.index, {
        baseIndex: null,
        showTests,
      });
      applyChangedIds(state.index, projection.affected.map((node) => node.nodeId));
      applyChangedStatus(
        state.index,
        reviewNodeStatusEntries(
          state.index,
          projection.affected,
          reviewNodeStatusSourcesFromDiff(
            changedLineKindsFromExtensions(state.artifact.extensions),
            changedDiffLinesFromExtensions(state.artifact.extensions),
          ),
        ),
      );
      set({
        review: projection.review,
        reviewFiles: projection.files,
        reviewAffectedIds: new Set(projection.affected.map((node) => node.nodeId)),
      });
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
     * current recursively extracted frame. The queued root layout becomes stale as soon as this
     * restored child requests its own pass. */
    const reprojectLivePrReview = (label: string, rebuildFlowPane = false): boolean => {
      const before = get();
      if (before.prReviewed === null) {
        return false;
      }
      const frame = captureMinimalGraphHistory(before);
      const frameScene = captureMinimalGraphScene(before);
      const history = before.minimalGraphHistory;
      const previousGroup = before.reviewActiveGroupId === null
        ? null
        : before.reviewGroups?.groups.find((group) => group.id === before.reviewActiveGroupId) ?? null;
      const applied = applyPrReviewToMap(
        get,
        set,
        prFilesUrl,
        invalidateMinimalLayout,
        invalidateModuleLayout,
        invalidateRequestFlowWork,
        invalidateArtifactCaches,
        { surfaceTransition: "reproject", preserveReviewSelection: true },
      );
      if (!applied) {
        return false;
      }

      const projected = get();
      // applyPrReviewToMap queued a root-review layout. This frame restoration owns the next scene,
      // even when filtering leaves it intentionally empty, so invalidate that root pass now.
      invalidateMinimalLayout();
      const keep = (id: string) => idPassesTestsProjection(projected, id, frame.moduleExpanded);
      const projectedFilePaths = new Set(projected.reviewFiles.map((file) => file.path));
      const survivingGroupFiles = new Set(
        (previousGroup?.files ?? []).filter((path) => projectedFilePaths.has(path)),
      );
      const projectedGroup = previousGroup === null || survivingGroupFiles.size === 0
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
      const reviewPathScope = before.reviewPathScope !== null
        && projected.reviewFiles.some((file) =>
          (activeGroupFiles === null || activeGroupFiles.has(file.path))
          && isReviewPathInScope(file.path, before.reviewPathScope),
        )
          ? before.reviewPathScope
          : null;
      // Origins remain as the overlay sentinel when every current member is filtered (the live PR
      // root uses the same raw-seed/empty-member contract for an all-test review), keeping Back
      // reachable from a test-only nested child.
      const minimalSeedIds = frame.minimalSeedIds;
      const minimalMemberIds = frame.minimalMemberIds.filter(keep);
      const moduleSelected = new Set([...frame.moduleSelected].filter(keep));
      const moduleExpanded = new Set([...frame.moduleExpanded].filter(keep));
      const reviewLitNodeIds = frame.reviewLitNodeIds === null
        ? null
        : new Set([...frame.reviewLitNodeIds].filter(keep));
      const reviewSelectedId = frame.reviewSelectedId !== null && keep(frame.reviewSelectedId)
        ? frame.reviewSelectedId
        : null;
      const logicSelected = frame.logicSelected !== null && keep(frame.logicSelected)
        ? frame.logicSelected
        : null;
      const flowSelection = frame.flowSelection !== null && keep(frame.flowSelection.rootId)
        ? frame.flowSelection
        : null;
      const projectedFlowBaseline = frame.reviewFlowBaseline === null
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
      }
      if (frame.flowSelection !== null || frame.flowPaneOrigin !== null) {
        invalidateFlowPaneLayout();
      }
      const visibleReviewPaths = new Set(projected.reviewFiles.map((file) => file.path));
      const reviewFocusedSubgraph = frame.reviewFocusedSubgraph === null
        ? null
        : {
            ...frame.reviewFocusedSubgraph,
            moduleIds: frame.reviewFocusedSubgraph.moduleIds.filter(keep),
            filePaths: frame.reviewFocusedSubgraph.filePaths.filter((path) => visibleReviewPaths.has(path)),
          };
      const restore = restoreMinimalGraphHistory(frame);
      set({
        ...restore,
        ...restoreMinimalGraphScene(frameScene),
        minimalGraphHistory: history,
        reviewActiveGroupId,
        reviewPathScope,
        reviewFocusedSubgraph,
        minimalSeedIds: effectiveMinimalSeedIds,
        minimalMemberIds: effectiveMinimalMemberIds,
        minimalProjectionExtraIds: new Set([...frame.minimalProjectionExtraIds].filter(keep)),
        ...(filteredFlow && projectedFlowBaseline !== null
          ? {
              minimalBasePositions: projectedFlowBaseline.minimalBasePositions,
              minimalArrange: projectedFlowBaseline.minimalArrange,
            }
          : {}),
        minimalRollups: Object.fromEntries(
          Object.entries(frame.minimalRollups)
            .map(([id, fileIds]) => [id, fileIds.filter(keep)] as const)
            .filter(([id, fileIds]) => keep(id) && fileIds.length > 0),
        ),
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
        minimalRfNodes: [],
        minimalRfEdges: [],
        minimalLayoutStatus: effectiveMinimalMemberIds.length > 0 ? "laying-out" : "idle",
        minimalLayoutActivity: effectiveMinimalMemberIds.length > 0 ? { label } : null,
      });
      if (effectiveMinimalMemberIds.length > 0) {
        void requestMinimalRelayout({ label });
      }
      if (
        rebuildFlowPane
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

    const captureMinimalCodebaseProjectionBaseline = (
      state: BlueprintState,
    ): MinimalCodebaseProjectionBaseline | null => {
      if (
        projectionDataSource === null
        || state.activeProjectionKey === null
        || state.activeProjectionRequest === null
        || state.activeProjectionGraphId === null
        || state.activeProjectionEndpoints === null
      ) {
        return null;
      }
      if (!state.prPreparedArtifactCurrent) {
        return {
          kind: "single",
          graphId: state.activeProjectionGraphId,
          key: state.activeProjectionKey,
          request: snapshotProjectionRequest(state.activeProjectionRequest),
          endpoints: state.activeProjectionEndpoints,
        };
      }
      if (
        state.prReviewed === null
        || state.prPreparedHead === null
        || state.prPreparedMergeBase === null
        || state.prReviewComparison === null
        || state.activeProjectionGraphId !== state.prPreparedHead.graphId
        || state.prReviewComparison.graphId !== state.prPreparedMergeBase.graphId
      ) {
        return null;
      }
      return {
        kind: "review",
        reviewNumber: state.prReviewed,
        headGraphId: state.prPreparedHead.graphId,
        mergeBaseGraphId: state.prPreparedMergeBase.graphId,
        key: state.activeProjectionKey,
        headRequest: snapshotProjectionRequest(state.activeProjectionRequest),
        mergeBaseRequest: snapshotProjectionRequest(state.prReviewComparison.request),
        headEndpoints: graphProjectionEndpoints(state.prPreparedHead),
        mergeBaseEndpoints: graphProjectionEndpoints(state.prPreparedMergeBase),
      };
    };

    const projectionCoordinateMatchesSession = (
      coordinate: MinimalCodebaseProjectionBaseline,
      state: BlueprintState,
    ): boolean => coordinate.kind === "single"
      ? !state.prPreparedArtifactCurrent && state.activeProjectionGraphId === coordinate.graphId
      : state.prReviewed === coordinate.reviewNumber
        && state.prPreparedArtifactCurrent
        && state.prPreparedHead?.graphId === coordinate.headGraphId
        && state.prPreparedMergeBase?.graphId === coordinate.mergeBaseGraphId;

    const appendMinimalGraphHistoryFrame = (state: BlueprintState): MinimalGraphHistoryEntry[] => {
      const sceneKey = retainCurrentMinimalScene(state);
      const frame: MinimalGraphProjectionFrame = {
        active: captureMinimalCodebaseProjectionBaseline(state),
        codebaseBaseline: minimalCodebaseProjectionBaseline,
      };
      const entry = captureMinimalGraphHistory(state, sceneKey);
      minimalProjectionFrames.set(sceneKey, frame);
      minimalNavigationResidentBytes.set(
        sceneKey,
        minimalGraphResidentBytes([entry, frame]),
      );
      const bounded = boundMinimalGraphHistory(
        [...state.minimalGraphHistory, entry],
        minimalNavigationResidentBytes,
      );
      for (const truncatedSceneKey of bounded.truncatedSceneKeys) {
        // Rendered scenes have a separate, much smaller count+byte LRU. Once their semantic
        // coordinate leaves this window it can no longer be activated, so its projection metadata
        // and accounting record leave atomically; any still-recent scene remains strictly bounded
        // by that cache and will age out normally without pinning a decoded graph here.
        minimalProjectionFrames.delete(truncatedSceneKey);
        minimalNavigationResidentBytes.delete(truncatedSceneKey);
      }
      return bounded.history;
    };

    const installReviewProjectionPair = (
      staged: StagedReviewProjection,
      expected: MinimalCodebaseReviewProjectionBaseline,
      headRequest: GraphProjectionRequest,
      mergeBaseRequest: GraphProjectionRequest,
      options: {
        layoutOwner?: ProjectionLayoutOwner;
        layoutOwners?: ReadonlySet<ProjectionLayoutOwner>;
        /** State which becomes authoritative only with this exact pair. Used by file navigation so
         * subscribers never observe a new graph under the previous committed cursor. */
        commitState?: Partial<BlueprintState>;
      } = {},
    ): void => {
      try {
        const pair = staged.projection;
        if (
          pair.head.graphId !== expected.headGraphId
          || pair.mergeBase.graphId !== expected.mergeBaseGraphId
          || canonicalProjectionKey(pair.head.graphId, pair.head.request)
            !== canonicalProjectionKey(expected.headGraphId, headRequest)
          || canonicalProjectionKey(pair.mergeBase.graphId, pair.mergeBase.request)
            !== canonicalProjectionKey(expected.mergeBaseGraphId, mergeBaseRequest)
        ) {
          throw new Error("codebase context returned a different review projection");
        }
        const state = get();
        const reviewNumber = state.prReviewed ?? state.prSelected;
        if (reviewNumber === null || state.prFiles === null) {
          throw new Error("codebase context requires the canonical prepared review manifest");
        }
        const summary = selectedPrSummary(state, reviewNumber);
        const context = reviewContextFromPrFiles({
          prNumber: reviewNumber,
          headRef: summary?.headRef ?? null,
          baseRef: summary?.baseRef ?? null,
          scopeId: prFilesUrl,
          files: state.prFiles,
        }, { baseSide: false });
        // Projection transport caches only the pure revision pair. Rebuild the current,
        // presentation-only two-sided composite on promotion so deleted/renamed base ghosts
        // survive context switches without retaining another decoded graph outside the bounded LRU.
        const presentation = deriveDeletedNodeProjection({
          headArtifact: pair.head.artifact,
          headIndex: pair.head.index,
          baseArtifact: pair.mergeBase.artifact,
          baseIndex: pair.mergeBase.index,
          context,
          prFiles: state.prFiles,
        });
        const outgoing = get().index;
        const changedIds = [...outgoing.changedIds]
          .filter((id) => presentation.index.nodesById.has(id));
        const changedStatus = [...outgoing.changedStatus]
          .filter(([id]) => presentation.index.nodesById.has(id));
        applyChangedIds(presentation.index, changedIds);
        applyChangedStatus(presentation.index, changedStatus);
        // Validation and presentation derivation are complete. Transfer the bounded staged owner
        // into the active cache immediately before the synchronous store commit.
        staged.commit();
        invalidateArtifactCaches(options);
        set({
          artifact: presentation.artifact,
          index: presentation.index,
          activeProjectionGraphId: pair.head.graphId,
          activeProjectionRequest: pair.head.request,
          activeProjectionKey: pair.key,
          activeProjectionId: pair.projectionId,
          activeProjectionEndpoints: expected.headEndpoints,
          prReviewComparison: pair.mergeBase,
          reviewBaseNodeIds: presentation.baseSourceNodeIds,
          reviewDeletedNodeIds: presentation.deletedNodeIds,
          reviewBaseSpanByHeadId: presentation.baseSpanByHeadId,
          coverage: get().coverageMode ? reachabilityForProjection(pair.head) : null,
          ...(options.commitState ?? {}),
        });
      } finally {
        staged.release();
      }
    };

    const installMinimalCodebaseSingleProjection = (
      staged: StagedGraphProjection,
      expected: MinimalCodebaseSingleProjectionBaseline,
      request: GraphProjectionRequest,
    ): void => {
      try {
        const projection = staged.projection;
        if (
          projection.graphId !== expected.graphId
          || canonicalProjectionKey(projection.graphId, projection.request)
            !== canonicalProjectionKey(expected.graphId, request)
        ) {
          throw new Error("codebase context returned a different graph projection");
        }
        staged.commit();
        invalidateArtifactCaches();
        set({
          artifact: projection.artifact,
          index: projection.index,
          activeProjectionGraphId: projection.graphId,
          activeProjectionRequest: projection.request,
          activeProjectionKey: projection.key,
          activeProjectionId: projection.projectionId,
          activeProjectionEndpoints: expected.endpoints,
          prReviewComparison: null,
          coverage: get().coverageMode ? reachabilityForProjection(projection) : null,
        });
      } finally {
        staged.release();
      }
    };

    /** Resolve a repository-wide palette identity into the active bounded graph before an action
     * touches it. Review additions widen HEAD only; merge-base remains path-addressed and the pair
     * is published atomically through the same installer as Codebase navigation. */
    const ensurePaletteSymbolProjection = async (
      rawId: string,
      expectedGraphId?: string | null,
    ): Promise<void> => {
      let state = get();
      if (projectionDataSource === null) {
        if (!state.index.nodesById.has(rawId)) throw new Error("This symbol is outside the local projection.");
        return;
      }
      if (expectedGraphId !== undefined && expectedGraphId !== null
        && expectedGraphId !== state.activeProjectionGraphId) {
        throw new Error("The graph changed while the symbol palette was open. Search again.");
      }
      if (state.index.nodesById.has(rawId)) return;
      if (state.activeProjectionGraphId === null || state.activeProjectionRequest === null
        || state.activeProjectionEndpoints === null) {
        throw new Error("The active graph cannot load this symbol.");
      }
      if (minimalCodebaseProjectionBaseline !== null && !await ensureExtractedGraphProjection()) {
        throw new Error("Could not restore the extracted graph before adding this symbol.");
      }
      state = get();
      const activeProjectionGraphId = state.activeProjectionGraphId;
      const activeProjectionRequest = state.activeProjectionRequest;
      const activeProjectionEndpoints = state.activeProjectionEndpoints;
      if (activeProjectionGraphId === null || activeProjectionRequest === null
        || activeProjectionEndpoints === null) {
        throw new Error("The active graph cannot load this symbol.");
      }
      projectionRequestController?.abort();
      const controller = new AbortController();
      projectionRequestController = controller;
      const sequence = ++projectionRequestSeq;
      const activity = ++minimalCodebaseProjectionActivitySeq;
      set({ minimalCodebaseProjectionPending: true });
      try {
        if (state.prPreparedArtifactCurrent) {
          const baseline = captureMinimalCodebaseProjectionBaseline(state);
          if (baseline?.kind !== "review" || state.prReviewComparison === null) {
            throw new Error("Prepared review comparison is unavailable.");
          }
          const extras = new Set([...state.minimalProjectionExtraIds, rawId]);
          if (extras.size > MAX_MINIMAL_PROJECTION_EXTRA_IDS) {
            throw new Error("This extracted graph has reached its palette-addition limit.");
          }
          // Rebuild from durable renderer state instead of widening the last transport request.
          // The latter may still contain a transient reveal/logic admission that has since been
          // replaced by its semantic focus, and unioning it would turn navigation into a leak.
          const semanticRequest = projectionRequestForState(state);
          const headRequest = snapshotProjectionRequest({
            ...semanticRequest,
            extraIds: [...new Set([...semanticRequest.extraIds, ...extras])],
          });
          const mergeBaseRequest = mergeBaseProjectionRequest(headRequest);
          const staged = await projectionDataSource.stageReviewPair({
            head: { request: headRequest, endpoints: baseline.headEndpoints },
            mergeBase: { request: mergeBaseRequest, endpoints: baseline.mergeBaseEndpoints },
            signal: controller.signal,
          });
          const current = get();
          if (controller.signal.aborted || projectionRequestSeq !== sequence
            || current.activeProjectionGraphId !== baseline.headGraphId
            || current.prReviewed !== baseline.reviewNumber) {
            staged.release();
            throw new DOMException("Symbol projection was superseded", "AbortError");
          }
          installReviewProjectionPair(staged, baseline, headRequest, mergeBaseRequest);
          if (!get().index.nodesById.has(rawId)) throw new Error("The symbol is unavailable in the current revision.");
          set({ minimalProjectionExtraIds: extras });
          return;
        }

        const currentRequest = projectionRequestForState(state);
        const request = snapshotProjectionRequest({
          ...currentRequest,
          extraIds: [...new Set([...currentRequest.extraIds, rawId])],
        });
        const staged = await projectionDataSource.stage(request, {
          endpoints: activeProjectionEndpoints,
          signal: controller.signal,
        });
        if (controller.signal.aborted || projectionRequestSeq !== sequence
          || get().activeProjectionGraphId !== activeProjectionGraphId) {
          staged.release();
          throw new DOMException("Symbol projection was superseded", "AbortError");
        }
        const projection = staged.projection;
        installMinimalCodebaseSingleProjection(staged, {
          kind: "single",
          graphId: activeProjectionGraphId,
          key: projection.key,
          request,
          endpoints: activeProjectionEndpoints,
        }, request);
        if (!projection.index.nodesById.has(rawId)) {
          throw new Error("The symbol is unavailable in the current projection.");
        }
      } finally {
        if (projectionRequestController === controller) projectionRequestController = null;
        if (minimalCodebaseProjectionActivitySeq === activity) {
          set({ minimalCodebaseProjectionPending: false });
        }
      }
    };

    /** A repository search hit is a transport admission, not durable graph state. Once the action
     * has installed its real semantic anchor (focus/pin/logic root), release that transient id.
     * Minimal Graph additions are the sole exception and deliberately retain their bounded ids. */
    const releasePaletteProjectionExtra = (rawId: string): void => {
      const extras = get().minimalProjectionExtraIds;
      if (!extras.has(rawId)) return;
      const next = new Set(extras);
      next.delete(rawId);
      set({ minimalProjectionExtraIds: next });
    };

    /** Activate one metadata-only history coordinate. Fetching is allowed after LRU eviction, but
     * a failed or stale restore never mutates the current child frame. */
    const activateMinimalProjectionCoordinate = (
      coordinate: MinimalCodebaseProjectionBaseline | null,
    ): boolean | Promise<boolean> => {
      if (coordinate === null) return true;
      if (projectionDataSource === null || !projectionCoordinateMatchesSession(coordinate, get())) return false;
      projectionRequestController?.abort();
      const controller = new AbortController();
      projectionRequestController = controller;
      const sequence = ++projectionRequestSeq;
      const isCurrent = (): boolean => !controller.signal.aborted
        && projectionRequestSeq === sequence
        && projectionCoordinateMatchesSession(coordinate, get());
      const finishSingle = (staged: StagedGraphProjection): boolean => {
        if (!isCurrent() || coordinate.kind !== "single") {
          staged.release();
          return false;
        }
        installMinimalCodebaseSingleProjection(staged, coordinate, coordinate.request);
        return true;
      };
      const finishReview = (staged: StagedReviewProjection): boolean => {
        if (
          !isCurrent()
          || coordinate.kind !== "review"
        ) {
          staged.release();
          return false;
        }
        installReviewProjectionPair(
          staged,
          coordinate,
          coordinate.headRequest,
          coordinate.mergeBaseRequest,
        );
        return true;
      };
      const fail = (error: unknown): boolean => {
        if (!controller.signal.aborted && projectionRequestSeq === sequence) {
          set({ prPrepareError: `Could not restore recent graph. ${prepareErrorMessage(error)}` });
        }
        return false;
      };
      const release = (): void => {
        if (projectionRequestController === controller) projectionRequestController = null;
      };
      if (coordinate.kind === "single") {
        const cached = projectionDataSource.stageCached(coordinate.key);
        if (cached !== undefined) {
          try {
            return finishSingle(cached);
          } catch (error) {
            return fail(error);
          } finally {
            release();
          }
        }
        return projectionDataSource.stage(coordinate.request, {
          endpoints: coordinate.endpoints,
          signal: controller.signal,
        }).then(finishSingle, fail).finally(release);
      }
      const cachedReview = projectionDataSource.stageCachedReview(coordinate.key);
      if (cachedReview !== undefined) {
        try {
          return finishReview(cachedReview);
        } catch (error) {
          return fail(error);
        } finally {
          release();
        }
      }
      return projectionDataSource.stageReviewPair({
            head: { request: coordinate.headRequest, endpoints: coordinate.headEndpoints },
            mergeBase: { request: coordinate.mergeBaseRequest, endpoints: coordinate.mergeBaseEndpoints },
            signal: controller.signal,
          })
        .then(finishReview, fail)
        .finally(release);
    };

    const activateMinimalCodebaseProjection = async (additionalGateIds: readonly string[] = []): Promise<void> => {
      let baseline: MinimalCodebaseProjectionBaseline | null = null;
      let controller: AbortController | null = null;
      let sequence: number | null = null;
      try {
        const state = get();
        const captured = captureMinimalCodebaseProjectionBaseline(state);
        const existing = minimalCodebaseProjectionBaseline;
        baseline = existing !== null && projectionCoordinateMatchesSession(existing, state)
            ? existing
            : captured;
        if (baseline === null || projectionDataSource === null) return;
        minimalCodebaseProjectionBaseline = baseline;
        const context = minimalCodebaseContextForState(state);
        if (context === null) return;
        const baselineRequest = baseline.kind === "review"
          ? projectionWithoutIds(baseline.headRequest, state.reviewBaseNodeIds)
          : baseline.request;
        const gates = new Set([
          ...baselineRequest.expandedIds,
          ...(context.reveal.moduleFocus === null ? [] : [context.reveal.moduleFocus]),
          ...context.reveal.moduleExpanded,
          ...[...state.minimalCodebaseExpansionOverrides]
            .filter(([, expanded]) => expanded)
            .map(([id]) => id),
          ...additionalGateIds,
        ]);
        if (gates.size > 512) {
          throw new Error("codebase context exceeds the bounded projection expansion limit");
        }
        projectionRequestController?.abort();
        controller = new AbortController();
        projectionRequestController = controller;
        sequence = ++projectionRequestSeq;
        if (baseline.kind === "single") {
          const request = projectionWithContextGates(baseline.request, gates);
          const staged = await projectionDataSource.stage(request, {
            endpoints: baseline.endpoints,
            signal: controller.signal,
          });
          const current = get();
          if (
            controller.signal.aborted
            || projectionRequestSeq !== sequence
            || minimalCodebaseProjectionBaseline !== baseline
            || current.minimalView !== "codebase"
            || !projectionCoordinateMatchesSession(baseline, current)
          ) {
            if (
              minimalCodebaseProjectionBaseline === baseline
              && !projectionCoordinateMatchesSession(baseline, current)
            ) {
              minimalCodebaseProjectionBaseline = null;
              if (current.activeProjectionKey === baseline.key) set({ minimalView: "graph" });
            }
            staged.release();
            return;
          }
          installMinimalCodebaseSingleProjection(staged, baseline, request);
          return;
        }
        // Base-only tombstones belong exclusively to the comparison request. Sending their ids to
        // HEAD would either waste the gate or make a strict projection endpoint reject the request.
        const headGates = [...gates].filter((id) => !state.reviewBaseNodeIds.has(id));
        const headRequest = projectionWithContextGates(baselineRequest, headGates);
        // Never copy HEAD ids across revisions. Only a unique kind/path/qualified-name match in the
        // already path-addressed comparison slice may become a merge-base disclosure gate.
        const comparisonGates = pathDerivedComparisonGates(
          state.index,
          state.prReviewComparison?.index ?? state.index,
          gates,
        );
        const mergeBaseRequest = projectionWithContextGates(baseline.mergeBaseRequest, comparisonGates);
        const staged = await projectionDataSource.stageReviewPair({
          head: { request: headRequest, endpoints: baseline.headEndpoints },
          mergeBase: { request: mergeBaseRequest, endpoints: baseline.mergeBaseEndpoints },
          signal: controller.signal,
        });
        const current = get();
        if (
          controller.signal.aborted
          || projectionRequestSeq !== sequence
          || minimalCodebaseProjectionBaseline !== baseline
          || current.minimalView !== "codebase"
          || !projectionCoordinateMatchesSession(baseline, current)
        ) {
          if (
            minimalCodebaseProjectionBaseline === baseline
            && !projectionCoordinateMatchesSession(baseline, current)
          ) {
            minimalCodebaseProjectionBaseline = null;
            if (current.activeProjectionKey === baseline.key) set({ minimalView: "graph" });
          }
          staged.release();
          return;
        }
        installReviewProjectionPair(staged, baseline, headRequest, mergeBaseRequest);
      } catch (error) {
        if (controller?.signal.aborted || (sequence !== null && projectionRequestSeq !== sequence)) return;
        const current = get();
        if (baseline !== null && current.minimalView === "codebase" && projectionCoordinateMatchesSession(baseline, current)) {
          set({
            ...(current.activeProjectionKey === baseline.key ? { minimalView: "graph" as const } : {}),
            prPrepareError: `Could not load codebase context. ${prepareErrorMessage(error)}`,
          });
        }
      } finally {
        if (controller !== null && projectionRequestController === controller) projectionRequestController = null;
      }
    };

    /** Keep every Codebase projection replacement visibly atomic. A superseded expand/collapse may
     * finish later, but only the newest activity can release the busy shell. */
    const refreshMinimalCodebaseProjection = async (additionalGateIds: readonly string[] = []): Promise<void> => {
      const activity = ++minimalCodebaseProjectionActivitySeq;
      set({ minimalCodebaseProjectionPending: true });
      try {
        await activateMinimalCodebaseProjection(additionalGateIds);
      } finally {
        if (minimalCodebaseProjectionActivitySeq === activity) {
          set({ minimalCodebaseProjectionPending: false });
        }
      }
    };

    const restoreMinimalCodebaseProjection = async (): Promise<boolean> => {
      const baseline = minimalCodebaseProjectionBaseline;
      if (baseline === null) return true;
      if (projectionDataSource === null) return false;
      projectionRequestController?.abort();
      const controller = new AbortController();
      projectionRequestController = controller;
      const sequence = ++projectionRequestSeq;
      try {
        const restorationStillOwnsCoordinate = (): boolean => {
          const current = get();
          const coordinateMatches = projectionCoordinateMatchesSession(baseline, current);
          const ownsCoordinate = !controller.signal.aborted
            && projectionRequestSeq === sequence
            && minimalCodebaseProjectionBaseline === baseline
            && current.minimalView === "graph"
            && coordinateMatches;
          if (!ownsCoordinate && minimalCodebaseProjectionBaseline === baseline && !coordinateMatches) {
            minimalCodebaseProjectionBaseline = null;
          }
          return ownsCoordinate;
        };

        if (baseline.kind === "single") {
          const staged = projectionDataSource.stageCached(baseline.key)
            ?? await projectionDataSource.stage(baseline.request, {
              endpoints: baseline.endpoints,
              signal: controller.signal,
            });
          try {
            if (!restorationStillOwnsCoordinate()) return false;
            installMinimalCodebaseSingleProjection(staged, baseline, baseline.request);
          } finally {
            staged.release();
          }
        } else {
          const staged = projectionDataSource.stageCachedReview(baseline.key)
            ?? await projectionDataSource.stageReviewPair({
              head: { request: baseline.headRequest, endpoints: baseline.headEndpoints },
              mergeBase: { request: baseline.mergeBaseRequest, endpoints: baseline.mergeBaseEndpoints },
              signal: controller.signal,
            });
          try {
            if (!restorationStillOwnsCoordinate()) return false;
            installReviewProjectionPair(
              staged,
              baseline,
              baseline.headRequest,
              baseline.mergeBaseRequest,
            );
          } finally {
            staged.release();
          }
        }
        minimalCodebaseProjectionBaseline = null;
        return true;
      } catch (error) {
        if (controller.signal.aborted || projectionRequestSeq !== sequence) return false;
        const current = get();
        if (current.minimalView === "graph" && projectionCoordinateMatchesSession(baseline, current)) {
          set({
            minimalView: "codebase",
            prPrepareError: `Could not restore extracted graph. ${prepareErrorMessage(error)}`,
          });
        }
        return false;
      } finally {
        if (projectionRequestController === controller) projectionRequestController = null;
      }
    };

    /** Return from a context projection before any action reads, derives, or mutates the extracted
     * graph. The exact coordinate stays live until promotion succeeds; failure leaves the codebase
     * view mounted and cannot strand graph state on the broader context slice. */
    const ensureExtractedGraphProjection = async (): Promise<boolean> => {
      const baseline = minimalCodebaseProjectionBaseline;
      if (baseline === null) return true;
      if (!projectionCoordinateMatchesSession(baseline, get())) {
        minimalCodebaseProjectionBaseline = null;
        return true;
      }
      if (get().minimalView === "codebase") {
        minimalCodebaseProjectionActivitySeq += 1;
        set({ minimalView: "graph", minimalCodebaseProjectionPending: false });
      }
      const restored = await restoreMinimalCodebaseProjection();
      const current = get();
      return restored
        && minimalCodebaseProjectionBaseline === null
        && current.minimalView === "graph"
        && current.activeProjectionKey === baseline.key;
    };

    const projectionHydrationKeyForState = (state: BlueprintState): string => {
      if (state.prPreparedArtifactCurrent) {
        const coordinate = preparedReviewProjectionCoordinate(state);
        // The immutable pair determines the bytes, while the PR identity determines the
        // presentation-only deleted/renamed overlay installed from the canonical manifest.
        return `${coordinate.key}\u0000pr:${state.prReviewed ?? state.prSelected ?? "unknown"}`;
      }
      const request = projectionRequestForState(state);
      if (state.activeProjectionEndpoints === null) {
        throw new Error("The active graph has no projection transport endpoints.");
      }
      return canonicalProjectionKey(
        state.activeProjectionGraphId
          ?? `unresolved:${state.activeProjectionEndpoints.manifestUrl}`,
        request,
      );
    };

    /** Activate exactly the graph slice named by the current navigation state. Only this method
     * installs decoded projection pairs in Zustand; the transport owns the bounded recent-view LRU.
     * Concurrent layouts of one coordinate share its hydration and atomic install. A genuinely
     * different navigation coordinate still aborts and supersedes the prior flight. */
    const ensureCurrentProjection = async (
      options: { layoutOwner?: ProjectionLayoutOwner; signal?: AbortSignal } = {},
    ): Promise<boolean> => {
      if (projectionDataSource === null || get().viewMode === "prs") {
        return true;
      }
      if (options.signal?.aborted) return false;
      const state = get();
      const activeProjectionEndpoints = state.activeProjectionEndpoints;
      if (activeProjectionEndpoints === null) {
        throw new Error("The active graph has no projection transport endpoints.");
      }
      const hydrationKey = projectionHydrationKeyForState(state);
      const existingFlight = projectionHydrationFlight;
      if (existingFlight !== null
        && existingFlight.key === hydrationKey
        && !existingFlight.shared.signal.aborted) {
        const outcome = await existingFlight.shared.subscribe({
          owner: options.layoutOwner,
          signal: options.signal,
        });
        return outcome.status === "completed" ? outcome.value : false;
      }
      existingFlight?.shared.abort(new DOMException("Projection coordinate changed", "AbortError"));
      projectionRequestController?.abort();
      const sequence = ++projectionRequestSeq;
      let flight!: ProjectionHydrationFlight;
      const shared = new SubscriberAwareAsyncFlight<ProjectionLayoutOwner, boolean>(async (physicalSignal) => {
        let stagedReview: StagedReviewProjection | null = null;
        let stagedSingle: StagedGraphProjection | null = null;
        try {
          stagedReview = state.prPreparedArtifactCurrent
            ? await stagePreparedReviewProjection(
                projectionDataSource,
                state,
                physicalSignal,
              )
            : null;
          const reviewPair = stagedReview?.projection ?? null;
          stagedSingle = reviewPair === null
            ? await projectionDataSource.stage(
                projectionRequestForState(state),
                {
                  endpoints: activeProjectionEndpoints,
                  signal: physicalSignal,
                },
              )
            : null;
          const projection = reviewPair?.head ?? stagedSingle!.projection;
          if (projectionRequestSeq !== sequence || physicalSignal.aborted) {
            stagedReview?.release();
            stagedSingle?.release();
            return false;
          }
          // A cache hit for the already-active request must not churn the store or invalidate derive
          // caches; this is the common path for repaint-only actions.
          const activeKey = reviewPair?.key ?? projection.key;
          const current = get();
          const activeReviewPresentation = reviewPair !== null
            && current.prPreparedArtifactCurrent
            && current.activeProjectionGraphId === reviewPair.head.graphId
            && current.prReviewComparison?.graphId === reviewPair.mergeBase.graphId;
          if (
            current.activeProjectionKey === activeKey
            && (activeReviewPresentation || current.artifact === projection.artifact)
          ) {
            if (current.coverageMode && current.coverage === null) {
              const coverage = reachabilityForProjection(projection);
              if (coverage !== null) set({ coverage });
            } else if (!current.coverageMode && current.coverage !== null) {
              set({ coverage: null });
            }
            stagedReview?.release();
            stagedSingle?.release();
            return true;
          }
          // Owners are read at the synchronous promotion boundary, after cancelled subscribers have
          // detached. An obsolete layout can therefore neither retain itself nor cancel a newer one.
          const layoutOwners = shared.owners;
          if (reviewPair !== null) {
            const coordinate = captureMinimalCodebaseProjectionBaseline(state);
            if (coordinate?.kind !== "review") {
              stagedReview?.release();
              throw new Error("prepared review projection changed without an active two-sided coordinate");
            }
            // Any selector change (coverage, trace, disclosure, palette) still promotes the canonical
            // two-sided presentation. Installing the transport's pure HEAD artifact here would drop
            // deleted/renamed base ghosts and changed-status metadata on ordinary navigation.
            installReviewProjectionPair(
              stagedReview!,
              coordinate,
              reviewPair.head.request,
              reviewPair.mergeBase.request,
              { layoutOwners },
            );
            return true;
          }
          // A projection swap invalidates independent layouts. Every live subscriber consuming this
          // shared install keeps its sequence; unrelated and already-cancelled passes are retired.
          try {
            stagedSingle!.commit();
            invalidateArtifactCaches({ layoutOwners });
            set({
              artifact: projection.artifact,
              index: projection.index,
              activeProjectionGraphId: projection.graphId,
              activeProjectionRequest: projection.request,
              activeProjectionKey: activeKey,
              activeProjectionId: projection.projectionId,
              activeProjectionEndpoints,
              coverage: get().coverageMode ? reachabilityForProjection(projection) : null,
              prReviewComparison: null,
            });
          } finally {
            stagedSingle!.release();
          }
          return true;
        } catch (error) {
          if (physicalSignal.aborted || projectionRequestSeq !== sequence) {
            return false;
          }
          throw error;
        } finally {
          stagedReview?.release();
          stagedSingle?.release();
          if (projectionHydrationFlight === flight) {
            projectionHydrationFlight = null;
          }
          if (projectionRequestController === shared.controller) {
            projectionRequestController = null;
          }
        }
      });
      flight = { key: hydrationKey, shared };
      projectionHydrationFlight = flight;
      projectionRequestController = shared.controller;
      const outcome = await shared.subscribe({
        owner: options.layoutOwner,
        signal: options.signal,
      });
      return outcome.status === "completed" ? outcome.value : false;
    };

    /** Static request occurrences address nested call bodies by renderer path, while the transport
     * accepts immutable graph ids. Each successful projection can reveal the next exact callee on
     * one retained expansion path. Refine until the semantic request is stable, then lay out once.
     * The finite occurrence address bounds the number of passes; no timeout or blind retry is part
     * of this contract. */
    const ensureRequestFlowProjectionClosure = async (options: {
      sequence: number;
      origin: "request" | "synthetic";
      traceId: string;
      expansionOverrides: ReadonlySet<string>;
      signal: AbortSignal;
    }): Promise<boolean> => {
      const currentTransition = (): boolean => {
        const current = get();
        return !options.signal.aborted
          && flowPaneLayoutSeq === options.sequence
          && current.flowPaneOrigin === options.origin
          && (options.origin === "request"
            ? current.requestFlowTraceId === options.traceId
            : current.syntheticExecution?.trace.traceId === options.traceId);
      };
      const passBudget = requestFlowProjectionPassBudget(options.expansionOverrides);
      for (let pass = 0; pass < passBudget; pass += 1) {
        if (!currentTransition()) return false;
        const beforeKey = canonicalProjectionKey(
          "request-flow-closure",
          projectionRequestForState(get()),
        );
        if (!await ensureCurrentProjection({ layoutOwner: "flow-pane", signal: options.signal })) return false;
        if (!currentTransition()) return false;
        const afterKey = canonicalProjectionKey(
          "request-flow-closure",
          projectionRequestForState(get()),
        );
        if (afterKey === beforeKey) return true;
      }
      throw new Error("request-flow projection did not converge within its occurrence address");
    };

    const loadPreparedReview = async (
      head: PreparedGraphDescriptor,
      mergeBase: PreparedGraphDescriptor,
      changedFiles: readonly PreparedChangedFile[],
      reviewCursor: string | null,
      signal?: AbortSignal,
    ): Promise<StagedReviewProjection> => {
      if (projectionDataSource === null) {
        throw new Error("PR preparation requires graph projection transport");
      }
      const state = get();
      return stagePreparedReviewProjection(projectionDataSource, {
        ...state,
        prPreparedHead: head,
        prPreparedMergeBase: mergeBase,
        prPreparedChangedFiles: [...changedFiles],
        prPreparedReviewCursor: reviewCursor,
        // A review cursor is the complete semantic coordinate for this bounded view. Never carry
        // selectors from the prior source/file scene into the new pair: doing so grows a file
        // projection with unrelated graph state and makes navigation history determine memory use.
        moduleFocus: null,
        moduleExpanded: new Set<string>(),
        moduleSelected: new Set<string>(),
        mapExtra: new Set<string>(),
        moduleGhostInspection: null,
        minimalMemberIds: [],
        minimalProjectionExtraIds: new Set<string>(),
        logicRoot: null,
        logicStack: [],
        logicFocus: [],
        expandedLogic: new Set<string>(),
        logicSelected: null,
        compRoot: null,
        compSelectedId: null,
        flowSelection: null,
        flowPaneOrigin: null,
        requestFlowTraceId: null,
        requestFlowExpansionOverrides: new Set<string>(),
        selectedTraceId: null,
        syntheticExecution: null,
      }, signal);
    };

    /** Load graph bytes and execution metadata as one cancellable staging transaction. If either
     * lane fails, the sibling is aborted and any pair which decoded first releases its budgeted
     * staged owner before the error escapes. */
    const stagePreparedReviewWithCapability = async (
      head: PreparedGraphDescriptor,
      mergeBase: PreparedGraphDescriptor,
      changedFiles: readonly PreparedChangedFile[],
      reviewCursor: string | null,
      identity: { repository: string | null; headSha: string | null },
      signal?: AbortSignal,
    ): Promise<[StagedReviewProjection, PreparedSyntheticCapability]> => {
      signal?.throwIfAborted();
      const controller = new AbortController();
      const relayAbort = () => controller.abort(signal?.reason);
      signal?.addEventListener("abort", relayAbort, { once: true });
      let staged: StagedReviewProjection | undefined;
      const stagedPromise = loadPreparedReview(
        head,
        mergeBase,
        changedFiles,
        reviewCursor,
        controller.signal,
      )
        .then((value) => {
          staged = value;
          return value;
        });
      try {
        return await Promise.all([
          stagedPromise,
          fetchPreparedSyntheticCapability(head.metaUrl, identity, controller.signal),
        ]);
      } catch (error) {
        controller.abort(error);
        try {
          (staged ?? await stagedPromise)?.release();
        } catch {
          // The graph lane failed before producing an owned stage.
        }
        throw error;
      } finally {
        signal?.removeEventListener("abort", relayAbort);
      }
    };

    /** Cancel only the per-file projection lane. Preparation/Resume status belongs to server work
     * and remains untouched, so closing or superseding a file load can never disable Resume. */
    const cancelPreparedFileProjection = (clearError = true): void => {
      preparedFileProjectionSeq += 1;
      const request = preparedFileProjectionRequest;
      preparedFileProjectionRequest = null;
      request?.controller.abort();
      const state = get();
      if (state.prPreparedFileProjectionPending !== null
        || (clearError && state.prPreparedFileProjectionError !== null)) {
        set({
          prPreparedFileProjectionPending: null,
          ...(clearError ? { prPreparedFileProjectionError: null } : {}),
        });
      }
    };

    /** Latest-only, two-sided file hydration. The committed cursor is deliberately absent from the
     * pending state: both revisions stage first, then the decoded pair and cursor publish in the
     * same Zustand transaction. A failed/aborted request leaves the prior graph fully navigable. */
    const hydratePreparedReviewFile = (path: string, cursor: string): Promise<boolean> => {
      const initial = get();
      if (initial.prPreparedArtifactCurrent && initial.prPreparedReviewCursor === cursor) {
        if (preparedFileProjectionRequest !== null) {
          cancelPreparedFileProjection();
        }
        if (initial.prPreparedFileProjectionError !== null) {
          set({ prPreparedFileProjectionError: null });
        }
        return Promise.resolve(true);
      }
      const reviewNumber = initial.prReviewed;
      const head = initial.prPreparedHead;
      const mergeBase = initial.prPreparedMergeBase;
      const changedFiles = initial.prPreparedChangedFiles;
      if (
        reviewNumber === null
        || head === null
        || mergeBase === null
        || !initial.prPreparedArtifactCurrent
        || initial.review === null
        || initial.viewMode !== "modules"
        || initial.minimalView !== "graph"
      ) {
        return Promise.resolve(false);
      }
      const existing = preparedFileProjectionRequest;
      if (
        existing !== null
        && !existing.controller.signal.aborted
        && existing.path === path
        && existing.cursor === cursor
        && existing.committedCursor === initial.prPreparedReviewCursor
        && existing.reviewNumber === reviewNumber
        && existing.head === head
        && existing.mergeBase === mergeBase
        && existing.changedFiles === changedFiles
      ) {
        return existing.promise;
      }

      existing?.controller.abort();
      const token = ++preparedFileProjectionSeq;
      const controller = new AbortController();
      const request = {
        token,
        path,
        cursor,
        committedCursor: initial.prPreparedReviewCursor,
        reviewNumber,
        head,
        mergeBase,
        changedFiles,
        controller,
        promise: Promise.resolve(false),
      };
      preparedFileProjectionRequest = request;
      set({
        prPreparedFileProjectionPending: { token, path, cursor },
        prPreparedFileProjectionError: null,
      });

      const isCurrent = (): boolean => {
        const current = get();
        return preparedFileProjectionSeq === token
          && preparedFileProjectionRequest === request
          && !controller.signal.aborted
          && current.prReviewed === reviewNumber
          && current.prPreparedHead === head
          && current.prPreparedMergeBase === mergeBase
          && current.prPreparedChangedFiles === changedFiles
          && current.prPreparedReviewCursor === request.committedCursor
          && current.prPreparedArtifactCurrent
          && current.review !== null
          && current.viewMode === "modules"
          && current.minimalView === "graph";
      };

      request.promise = (async (): Promise<boolean> => {
        let staged: StagedReviewProjection | null = null;
        try {
          staged = await loadPreparedReview(head, mergeBase, changedFiles, cursor, controller.signal);
          if (!isCurrent()) return false;
          const pair = staged.projection;
          const expected: MinimalCodebaseReviewProjectionBaseline = {
            kind: "review",
            reviewNumber,
            headGraphId: head.graphId,
            mergeBaseGraphId: mergeBase.graphId,
            key: pair.key,
            headRequest: snapshotProjectionRequest(pair.head.request),
            mergeBaseRequest: snapshotProjectionRequest(pair.mergeBase.request),
            headEndpoints: graphProjectionEndpoints(head),
            mergeBaseEndpoints: graphProjectionEndpoints(mergeBase),
          };
          resetMinimalProjectionNavigationForRevision();
          if (!isCurrent()) return false;
          invalidateSyntheticArtifactBoundary();
          const owned = staged;
          staged = null;
          installReviewProjectionPair(owned, expected, pair.head.request, pair.mergeBase.request, {
            commitState: {
              prPreparedReviewCursor: cursor,
              prPreparedFileProjectionPending: null,
              prPreparedFileProjectionError: null,
              codeView: null,
              ...requestFlowPaneReset(),
              logicSelected: null,
              reviewFlowBaseline: null,
              ...syntheticExecutionReset(),
              syntheticExperimentRootId: null,
              syntheticInputOverrides: [],
              syntheticFieldWatchers: [],
              syntheticEditorRequest: null,
            },
          });
          return true;
        } catch (error) {
          if (isCurrent()) {
            set({
              prPreparedFileProjectionPending: null,
              prPreparedFileProjectionError: { path, message: prepareErrorMessage(error) },
            });
          }
          return false;
        } finally {
          staged?.release();
          if (preparedFileProjectionRequest === request) {
            preparedFileProjectionRequest = null;
          }
        }
      })();
      return request.promise;
    };

    /** Promote the exact pre-review projection before clearing/parking the review. The decoded pair
     * may have been evicted (or rejected as oversized) by the bounded browser LRU, so cache miss
     * reloads the same graph/request through its retained immutable endpoints. */
    const restoreReviewSession = (
      options: {
        endSession?: boolean;
        signal?: AbortSignal;
        isCurrent?: () => boolean;
      } = {},
    ): boolean | Promise<boolean> => {
      const ownsRestore = (): boolean => (
        options.signal?.aborted !== true && (options.isCurrent?.() ?? true)
      );
      if (!ownsRestore()) return false;
      const baseline = get().prReviewBaseline;
      if (baseline === null && get().prReviewed !== null && options.endSession === false) {
        resetChangedIdsToArtifact(get().artifact, get().index);
      }
      if (baseline === null) {
        return restorePrReviewBaseline(get, set, invalidateArtifactCaches, options);
      }
      if (projectionDataSource === null) {
        throw new Error("cannot restore an evicted review baseline without graph projection transport");
      }
      const reviewed = get().prReviewed;
      const promote = (staged: StagedGraphProjection): boolean => {
        try {
          if (!ownsRestore()) return false;
          const projection = staged.projection;
          if (
            projection.graphId !== baseline.graphId
            || canonicalProjectionKey(projection.graphId, projection.request)
              !== canonicalProjectionKey(baseline.graphId, baseline.request)
          ) {
            throw new Error("review baseline reload returned a different graph projection");
          }
          if (
            !ownsRestore()
            || get().prReviewBaseline !== baseline
            || get().prReviewed !== reviewed
          ) {
            return false;
          }
          resetChangedIdsToArtifact(projection.artifact, projection.index);
          staged.commit();
          set({
            artifact: projection.artifact,
            index: projection.index,
            activeProjectionGraphId: projection.graphId,
            activeProjectionRequest: projection.request,
            activeProjectionKey: projection.key,
            activeProjectionId: projection.projectionId,
            activeProjectionEndpoints: baseline.endpoints,
            coverage: get().coverageMode ? reachabilityForProjection(projection) : null,
          });
          return restorePrReviewBaseline(get, set, invalidateArtifactCaches, options);
        } finally {
          staged.release();
        }
      };
      const cached = projectionDataSource.stageCached(baseline.projectionKey);
      if (cached !== undefined) {
        return promote(cached);
      }
      return projectionDataSource.stage(baseline.request, {
        endpoints: baseline.endpoints,
        signal: options.signal,
      }).then(promote);
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

    return {
    artifact: dependencies.artifact,
    index: dependencies.index,
    activeProjectionKey: dependencies.initialProjection?.key ?? null,
    activeProjectionId: dependencies.initialProjection?.projectionId ?? null,
    activeProjectionGraphId: dependencies.initialProjection?.graphId ?? null,
    activeProjectionRequest: dependencies.initialProjection?.request ?? null,
    activeProjectionEndpoints: initialProjectionEndpoints,
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
    minimalProjectionExtraIds: new Set<string>(),
    minimalRollups: {},
    minimalBasePositions: {},
    minimalArrange: false,
    minimalRfNodes: [],
    minimalRfEdges: [],
    minimalLayoutStatus: "idle",
    minimalLayoutActivity: null,
    minimalView: "graph",
    minimalShowGhostNodes: true,
    minimalCodebaseExpansionOverrides: new Map<string, boolean>(),
    minimalCodebaseTargetIds: [],
    minimalCodebaseRetainedExpandedIds: new Set<string>(),
    minimalCodebaseProjectionPending: false,
    review,
    reviewAffectedIds: new Set(initialReviewProjection?.affected.map((node) => node.nodeId) ?? []),
    reviewDiffOnly: false,
    reviewFiles,
    reviewFilesSort: "path",
    reviewFileDelta: {},
    reviewTicks: initialProgress?.ticks ?? {},
    reviewUnitTicks: initialProgress?.unitTicks ?? {},
    reviewFileTicks: initialProgress?.fileTicks ?? {},
    reviewComments: initialProgress?.comments ?? [],
    reviewLineComposer: null,
    reviewFlowSplitView: reviewPreferences.flowSplitView,
    reviewOpenFlowSplitOnSelect: reviewPreferences.openFlowSplitOnSelect,
    reviewFlowExplicitView: null,
    reviewCodePreviewTrigger: reviewPreferences.codePreviewTrigger,
    reviewHideAddedSourceCommentDiffs: reviewPreferences.hideAddedSourceCommentDiffs,
    reviewPanelHidden: false,
    reviewCommentsVisible: true,
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
    prepareUrl,
    githubSource,
    prsUrl,
    prOneUrl,
    prFilesUrl,
    prCommentsUrl,
    prChecksUrl,
    prSessionSource,
    prsTab: "open",
    prsList: { open: null, closed: null },
    prExtraSummaries: {},
    prsHasMore: { open: false, closed: false },
    prsLoading: false,
    prsError: null,
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
    prPrepareElapsedMs: null,
    prPrepareError: null,
    prPreparedHead: null,
    prPreparedMergeBase: null,
    prPreparedReviewCursor: null,
    prPreparedFileProjectionPending: null,
    prPreparedFileProjectionError: null,
    prPreparedChangedFiles: [],
    prPreparedHeadSha: null,
    prPreparedMergeBaseSha: null,
    prReviewComparison: null,
    prPreparedArtifactCurrent: false,
    prReviewBaseline: null,
    codeView: null,

    // Reveal one more containment level, scoped to the current selection (or the whole view when
    // nothing is selected). Each surface reads its own visible frontier + selection and folds the
    // ids scopedExpansion picks into its own expansion set — see applyScoped below.
    expandAll() {
      applyScoped(get, set, () => (moduleGraph ??= buildModuleGraph(get().index)), () => (blockDeps ??= buildBlockDeps(get().index)), idsToExpand, "open", { label: "Expanding one level…" });
    },

    // Fully collapse the same scope: close every open container within it in one click.
    collapseAll() {
      applyScoped(get, set, () => (moduleGraph ??= buildModuleGraph(get().index)), () => (blockDeps ??= buildBlockDeps(get().index)), idsToCollapse, "close", { label: "Collapsing graph…" });
    },

    // Bump the recenter signal so the active graph surface re-fits its viewport (to the current
    // selection, or the whole graph if none). A pure signal — no relayout, no navigation change; the
    // surface reads the value change via useRecenter and calls React Flow's fitView.
    recenter() {
      if (moduleGraphSurfaceOwner(get()) === "prepared-review-overview") return;
      set({ recenterSeq: get().recenterSeq + 1 });
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

    async selectFlowEntry(ref) {
      syntheticExecutionSeq += 1;
      if (ref === null) {
        const state = get();
        const baseline = state.reviewFlowBaseline;
        const reviewFlowOpen = state.review !== null
          && state.minimalSeedIds.length > 0
          && state.flowSelection !== null
          && baseline !== null;
        invalidateFlowPaneLayout();
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
          await requestMinimalRelayout({ label: "Closing logic flow review…" });
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
          invalidateFlowPaneLayout();
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
        const pendingLayouts: Promise<void>[] = [];
        if (needsExecutionGraph) pendingLayouts.push(get().flowPaneRelayout());
        const recenterIfCurrent = () => {
          if (get().flowSelection === ref && get().logicSelected === null) {
            set({ recenterSeq: get().recenterSeq + 1 });
          }
        };
        if (needsRelayout) {
          pendingLayouts.push(
            requestMinimalRelayout({ label: "Revealing logic flow in review…" }).then(recenterIfCurrent),
          );
        } else {
          recenterIfCurrent();
        }
        await Promise.all(pendingLayouts);
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
      const pendingLayouts: Promise<void>[] = [];
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
          pendingLayouts.push(get().moduleRelayout({ label: "Revealing selected flow…" }));
        } else {
          set({ moduleSelected: new Set<string>(), moduleGhostInspection: null });
          if (state.moduleGhostInspection !== null) {
            pendingLayouts.push(get().moduleRelayout({ label: "Closing ghost exploration…" }));
          }
        }
      }
      pendingLayouts.push(get().flowPaneRelayout());
      await Promise.all(pendingLayouts);
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
      if (trace === null || traceGraphRefMismatches(
        state.traceGraphRef,
        traceGraphRevisionIdentity(state.index.graphSummary, state.artifact.target),
      ).length > 0) {
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
          set({ recenterSeq: current.recenterSeq + 1 });
        }
      });
    },

    openSelectedRequestFlowPane() {
      const state = get();
      if (
        (state.viewMode !== "modules" && state.viewMode !== "call" && state.viewMode !== "ui")
        || moduleGraphSurfaceOwner(state) !== "source"
        || (state.flowSelection !== null && state.flowPaneOrigin !== "request")
      ) {
        return;
      }
      const trace = state.selectedTraceId === null
        ? null
        : state.requestTraces.find((candidate) => candidate.traceId === state.selectedTraceId) ?? null;
      if (
        trace === null
        || traceGraphRefMismatches(
          state.traceGraphRef,
          traceGraphRevisionIdentity(state.index.graphSummary, state.artifact.target),
        ).length > 0
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
        invalidateFlowPaneLayout();
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
        invalidateFlowPaneLayout();
        set({
          reviewFlowExplicitView: view,
          recenterSeq: state.recenterSeq + 1,
          flowPaneRfNodes: [],
          flowPaneRfEdges: [],
          flowPaneLayoutStatus: "idle",
        });
        return;
      }
      set({ reviewFlowExplicitView: view, recenterSeq: state.recenterSeq + 1 });
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
        invalidateFlowPaneLayout();
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
      invalidateFlowPaneLayout();
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

    async selectFlowPaneTarget(nodeId) {
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
          && (executionOrigin === "synthetic" || traceGraphRefMismatches(
            state.traceGraphRef,
            traceGraphRevisionIdentity(state.index.graphSummary, state.artifact.target),
          ).length === 0)
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
            set({ recenterSeq: current.recenterSeq + 1 });
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
            set({ recenterSeq: current.recenterSeq + 1 });
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
        await get().moduleRelayout({
          label: `Revealing ${state.index.nodesById.get(graphTarget)?.displayName ?? graphTarget} from ${subject}…`,
        }).then(recenterIfCurrent);
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
          set({ recenterSeq: get().recenterSeq + 1 });
        }
      };
      if (needsRelayout) {
        await requestMinimalRelayout({
          label: nodeId === null ? "Restoring logic flow context…" : "Revealing logic flow node…",
        }).then(recenterIfCurrent);
      } else {
        recenterIfCurrent();
      }
    },

    async flowPaneRelayout() {
      const requested = get();
      const requestedTrace = requested.flowPaneOrigin === "synthetic"
        ? requested.syntheticExecution?.trace ?? null
        : requested.flowPaneOrigin === "request" && requested.requestFlowTraceId !== null
          ? requested.requestTraces.find((candidate) => candidate.traceId === requested.requestFlowTraceId) ?? null
          : null;
      if (
        (requested.flowPaneOrigin === "request" || requested.flowPaneOrigin === "synthetic")
          ? requestedTrace === null
          : requested.flowSelection === null
      ) {
        invalidateFlowPaneLayout();
        set({ flowPaneRfNodes: [], flowPaneRfEdges: [], flowPaneLayoutStatus: "idle" });
        return;
      }
      const sequence = ++flowPaneLayoutSeq;
      set({ flowPaneLayoutStatus: "laying-out" });
      await layoutCoordinator.run("flow-pane", async (signal) => {
        const initial = get();
        if (signal.aborted || flowPaneLayoutSeq !== sequence) return;
        if (initial.flowPaneOrigin === "request" || initial.flowPaneOrigin === "synthetic") {
          const origin = initial.flowPaneOrigin;
          const initialExecution = origin === "synthetic" ? initial.syntheticExecution : null;
          const trace = origin === "synthetic"
            ? initialExecution?.trace ?? null
            : initial.requestFlowTraceId === null
              ? null
              : initial.requestTraces.find((candidate) => candidate.traceId === initial.requestFlowTraceId) ?? null;
          if (trace === null) return;
          const traceId = trace.traceId;
          try {
            if (projectionDataSource !== null && !await ensureRequestFlowProjectionClosure({
              sequence,
              origin,
              traceId,
              expansionOverrides: new Set(initial.requestFlowExpansionOverrides),
              signal,
            })) return;
            const current = get();
            if (
              signal.aborted
              || flowPaneLayoutSeq !== sequence
              || current.flowPaneOrigin !== origin
              || (origin === "request" && current.requestFlowTraceId !== traceId)
              || (origin === "synthetic" && current.syntheticExecution?.trace.traceId !== traceId)
            ) return;
            const execution = origin === "synthetic" ? current.syntheticExecution : null;
            const currentTrace = origin === "synthetic"
              ? execution?.trace ?? null
              : current.requestTraces.find((candidate) => candidate.traceId === traceId) ?? null;
            if (currentTrace === null) return;
            const {
              requestFlowExpansionOverrides,
              flowPaneCollapsedEdges,
              syntheticSelectedMomentId,
              syntheticFlowOrientation,
              syntheticFlowPresentation,
              index,
              artifact,
            } = current;
            const flows = (artifact.extensions?.logicFlow ?? {}) as unknown as LogicFlows;
            const graph = origin === "synthetic"
              && syntheticFlowPresentation === "focused"
              && syntheticSelectedMomentId !== null
              ? await deriveFocusedRequestFlowPaneLayout(
                  currentTrace,
                  index,
                  flows,
                  syntheticSelectedMomentId,
                  syntheticFlowOrientation,
                  requestFlowExpansionOverrides,
                  execution?.snapshots ?? [],
                  flowPaneCollapsedEdges,
                )
              : await deriveRequestFlowPaneLayout(
                  currentTrace,
                  index,
                  flows,
                  requestFlowExpansionOverrides,
                  execution?.snapshots ?? [],
                  flowPaneCollapsedEdges,
                );
            if (
              signal.aborted
              || flowPaneLayoutSeq !== sequence
              || get().flowPaneOrigin !== origin
              || (origin === "request" && get().requestFlowTraceId !== traceId)
              || (origin === "synthetic" && get().syntheticExecution?.trace.traceId !== traceId)
              || (origin === "synthetic" && get().syntheticSelectedMomentId !== syntheticSelectedMomentId)
              || (origin === "synthetic" && get().syntheticFlowOrientation !== syntheticFlowOrientation)
              || (origin === "synthetic" && get().syntheticFlowPresentation !== syntheticFlowPresentation)
            ) return;
            set({ flowPaneRfNodes: graph.nodes, flowPaneRfEdges: graph.edges, flowPaneLayoutStatus: "ready" });
          } catch {
            if (!signal.aborted && flowPaneLayoutSeq === sequence && get().flowPaneOrigin === origin) {
              set({ flowPaneLayoutStatus: "error" });
            }
          }
          return;
        }
        const {
          flowSelection,
          flowPaneOrigin,
        } = initial;
        if (flowSelection === null) return;
        try {
          // Explorer/review flows are projection consumers too. Join the same coordinate flight as
          // the visible structural scene before retaining artifact/index inputs; otherwise that
          // scene's promotion cancels this pane as an apparent outgoing owner and leaves it busy.
          if (projectionDataSource !== null
            && !await ensureCurrentProjection({ layoutOwner: "flow-pane", signal })) return;
          const current = get();
          if (
            signal.aborted
            || flowPaneLayoutSeq !== sequence
            || current.flowSelection !== flowSelection
            || current.flowPaneOrigin !== flowPaneOrigin
          ) return;
          const {
            flowPaneExpansionOverrides,
            flowPaneCollapsedEdges,
            index,
            artifact,
          } = current;
          const flows = (artifact.extensions?.logicFlow ?? {}) as unknown as LogicFlows;
          // A flow node's PR status belongs to its own source site. Prepared projections carry the
          // canonical head-coordinate changed-line kinds beside the graph.
          const stepStatusSources = reviewNodeStatusSourcesFromKinds(
            changedLineKindsFromExtensions(artifact.extensions),
          );
          const graph = await deriveFlowPaneLayout(flowSelection, flows, index, flowPaneExpansionOverrides, {
            changedStatusForSource: (source) => reviewSourceChangeStatus(source, stepStatusSources),
          }, flowPaneCollapsedEdges);
          if (
            signal.aborted
            || flowPaneLayoutSeq !== sequence
            || get().flowSelection !== flowSelection
            || get().flowPaneOrigin !== flowPaneOrigin
          ) return;
          set({ flowPaneRfNodes: graph.nodes, flowPaneRfEdges: graph.edges, flowPaneLayoutStatus: "ready" });
        } catch {
          if (!signal.aborted && flowPaneLayoutSeq === sequence) {
            set({ flowPaneLayoutStatus: "error" });
          }
        }
      });
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
      invalidateModuleLayout();
      if (!beginLensTransition(get, set, invalidateRequestFlowWork, () => get().openLogicFlow(nodeId))) {
        return;
      }
      const resetSynthetic = shouldResetLogicHostedSynthetic(state, nodeId);
      if (resetSynthetic) {
        syntheticExecutionSeq += 1;
        invalidateFlowPaneLayout();
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
        ...releasedModuleScene(),
        ...releasedLogicScene(),
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
      invalidateLogicLayout();
      if (!beginLensTransition(get, set, invalidateRequestFlowWork, () => get().openComposition(unitId))) {
        return;
      }
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
        ...releasedLogicScene(),
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
        invalidateFlowPaneLayout();
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
        invalidateFlowPaneLayout();
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
      if (get().logicRoot === null) {
        invalidateLogicLayout();
        set({ logicRfNodes: [], logicRfEdges: [], logicLayoutStatus: "idle", logicLayoutActivity: null });
        return;
      }
      const sequence = ++logicLayoutSeq;
      set({
        logicLayoutStatus: "laying-out",
        logicLayoutActivity: activity ?? { label: "Arranging logic flow…" },
      });
      await layoutCoordinator.run("logic", async (signal) => {
        try {
          if (
            signal.aborted
            || (projectionDataSource !== null && !await ensureCurrentProjection({ layoutOwner: "logic", signal }))
            || signal.aborted
            || logicLayoutSeq !== sequence
          ) {
            return;
          }
          const {
            logicRoot,
            index,
            artifact,
            expandedLogic,
            collapsedLogicEdges,
            hideGreyed,
            nestByService,
            logicFocus,
          } = get();
          if (logicRoot === null) {
            return;
          }
          const flows = (artifact.extensions?.logicFlow ?? {}) as unknown as LogicFlows;
          await yieldForPaint();
          if (signal.aborted || logicLayoutSeq !== sequence) {
            return;
          }
          // A container dive charts only the TOP focus entry's bodies; else the whole callable flow.
          const top = logicFocus[logicFocus.length - 1];
          const focus = top ? { id: top.id, bodies: top.bodies } : undefined;
          // Flow nodes represent source sites, not their callees. Resolve their PR status from each
          // FlowStep source anchor using the same aligned line-kind source as node colouring.
          const stepStatusSources = reviewNodeStatusSourcesFromDiff(
            changedLineKindsFromExtensions(artifact.extensions),
            changedDiffLinesFromExtensions(artifact.extensions),
          );
          const graph = await deriveLogicLayout(logicRoot, flows, index, expandedLogic, {
            hideGreyed,
            nestByService,
            changedStatusForSource: (source) => reviewSourceChangeStatus(source, stepStatusSources),
          }, focus, collapsedLogicEdges);
          if (signal.aborted || logicLayoutSeq !== sequence) {
            return; // a newer layout superseded this one.
          }
          set({
            logicRfNodes: graph.nodes,
            logicRfEdges: graph.edges,
            logicLayoutStatus: "ready",
            logicLayoutActivity: null,
          });
        } catch {
          if (!signal.aborted && logicLayoutSeq === sequence) {
            set({ logicLayoutStatus: "error", logicLayoutActivity: null });
          }
        }
      });
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
      if (moduleGraphSurfaceOwner(state) !== "source" || moduleSurfaceSpec(state.viewMode) === null) {
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
      if (moduleGraphSurfaceOwner(get()) !== "source") {
        return; // Extract/review owns the visible structural lane; no hidden source graph is retained.
      }
      const sequence = ++moduleLayoutSeq;
      const lensTransition = pendingModuleLensTransition;
      set({
        moduleLayoutStatus: "laying-out",
        moduleLayoutActivity: activity ?? defaultModuleLayoutActivity(get()),
      });
      await layoutCoordinator.run("module", async (signal) => {
        try {
          if (
            signal.aborted
            || (projectionDataSource !== null && !await ensureCurrentProjection({ layoutOwner: "module", signal }))
            || signal.aborted
            || moduleLayoutSeq !== sequence
          ) {
            return;
          }
          if (lensTransition !== null) {
            if (
              pendingModuleLensTransition !== lensTransition
              || get().viewMode !== lensTransition.mode
            ) {
              return;
            }
            // The first activation installs the destination's authoritative facts. Only now may the
            // carry translate into destination-local focus/expansion and a Service ownership scope.
            const state = get();
            const serviceResolution = lensTransition.mode === "call"
              ? resolveServiceAnchors(
                  lensTransition.anchors,
                  state.index,
                  state.serviceGroupingMode,
                  state.serviceGroupingTargetSize,
                )
              : null;
            const reveal = lensTransition.mode === "modules"
              ? mapRevealStateForMany(lensTransition.anchors, state.index)
              : lensTransition.mode === "call"
                ? serviceResolution?.reveal ?? null
                : uiRevealStateForMany(lensTransition.anchors, state.index);
            set({
              serviceScope: lensTransition.mode === "call" && serviceResolution !== null
                ? serviceScopeFor(serviceResolution.owningLeads, state.index)
                : null,
              ...(reveal ?? MODULE_TOP_LEVEL),
            });
            pendingModuleLensTransition = null;
            // Carry can add focus and disclosure selectors. Hydrate that exact final coordinate before
            // deriving any scene so an expanded Service frame never paints from a top-level slice.
            if (
              signal.aborted
              || (projectionDataSource !== null
                && !await ensureCurrentProjection({ layoutOwner: "module", signal }))
              || signal.aborted
              || moduleLayoutSeq !== sequence
            ) {
              return;
            }
          }
          await yieldForPaint();
          if (signal.aborted || moduleLayoutSeq !== sequence) {
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
          const hidden = state.showTests ? EMPTY_HIDDEN_IDS : state.index.testIds;
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
          if (signal.aborted || moduleLayoutSeq !== sequence) {
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
        } catch {
          if (!signal.aborted && moduleLayoutSeq === sequence) {
            if (pendingModuleLensTransition === lensTransition) {
              pendingModuleLensTransition = null;
            }
            set({ moduleLayoutStatus: "error", moduleLayoutActivity: null });
          }
        }
      });
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
    // filtered to folders/files. Reuses the SAME hidden-tests set the
    // layout hides, so the dropdown never lists a card that isn't on screen.
    folderChildrenFor(focus) {
      const state = get();
      const hidden = state.showTests ? EMPTY_HIDDEN_IDS : state.index.testIds;
      return levelChildren(state.index, focus, hidden);
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
      invalidateModuleLayout();
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
      const file = ancestors.find((node) => node.kind === "module");
      const unit = ancestors.find((node) => UNIT_CARD_KINDS.has(node.kind));
      const directory = [...ancestors].reverse().find((node) => node.kind === "package");
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
    revealInView(rawId, expectedGraphId) {
      const initial = get();
      if (moduleGraphSurfaceOwner(initial) === "prepared-review-overview") {
        return Promise.reject(new Error("Select a changed file before revealing symbols in its graph."));
      }
      if (projectionDataSource !== null && expectedGraphId !== undefined && expectedGraphId !== null
        && expectedGraphId !== initial.activeProjectionGraphId) {
        return Promise.reject(new Error("The graph changed while the symbol palette was open. Search again."));
      }
      if (!initial.index.nodesById.has(rawId)) {
        return ensurePaletteSymbolProjection(rawId, expectedGraphId)
          .then(() => get().revealInView(rawId, get().activeProjectionGraphId));
      }
      const viewMode = initial.viewMode;
      if (viewMode === "modules" || viewMode === "ui") {
        get().revealModule(rawId);
        releasePaletteProjectionExtra(rawId);
        return Promise.resolve();
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
      releasePaletteProjectionExtra(rawId);
      return Promise.resolve();
    },

    // ⌘P palette "+": add a picked symbol to the graph the reader can actually see. Minimal Graph
    // covers its source Map and owns a separate ordered member list, so it must win as the destination
    // just like the shared ghost "+" action below. Otherwise pin the owning card into the current map
    // lens as a scratch-card union for its next relayout. All ordinary module lenses share `mapExtra`.
    addToView(rawId, expectedGraphId) {
      const initial = get();
      if (moduleGraphSurfaceOwner(initial) === "prepared-review-overview") {
        return Promise.reject(new Error("Select a changed file before adding symbols to its graph."));
      }
      if (projectionDataSource !== null && expectedGraphId !== undefined && expectedGraphId !== null
        && expectedGraphId !== initial.activeProjectionGraphId) {
        return Promise.reject(new Error("The graph changed while the symbol palette was open. Search again."));
      }
      if (!initial.index.nodesById.has(rawId)) {
        return ensurePaletteSymbolProjection(rawId, expectedGraphId)
          .then(() => get().addToView(rawId, get().activeProjectionGraphId));
      }
      const state = initial;
      const viewMode = state.viewMode;
      const minimalOpen = moduleGraphSurfaceOwner(state) === "extracted";
      if (!minimalOpen && moduleSurfaceSpec(viewMode) === null) {
        releasePaletteProjectionExtra(rawId);
        return Promise.resolve();
      }
      const revealPrivate = !state.showPrivate && state.index.privateIds.has(rawId);
      if (minimalOpen) {
        if (revealPrivate) {
          set({ showPrivate: true });
        }
        get().promoteGhost(rawId);
        return Promise.resolve();
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
      releasePaletteProjectionExtra(rawId);
      return Promise.resolve();
    },

    openPaletteLogicFlow(rawId, expectedGraphId) {
      const state = get();
      if (projectionDataSource !== null && expectedGraphId !== undefined && expectedGraphId !== null
        && expectedGraphId !== state.activeProjectionGraphId) {
        return Promise.reject(new Error("The graph changed while the symbol palette was open. Search again."));
      }
      if (!state.index.nodesById.has(rawId)) {
        return ensurePaletteSymbolProjection(rawId, expectedGraphId)
          .then(() => get().openPaletteLogicFlow(rawId, get().activeProjectionGraphId));
      }
      get().openLogicFlow(rawId);
      releasePaletteProjectionExtra(rawId);
      return Promise.resolve();
    },

    searchSymbols(request, signal) {
      const state = get();
      if (projectionDataSource === null) {
        return Promise.resolve(localSymbolSearch(
          state.artifact,
          state.index.nodesById,
          request,
          state.activeProjectionGraphId ?? "local",
        ));
      }
      if (state.activeProjectionEndpoints === null) {
        return Promise.reject(new Error("Repository symbol search is unavailable for this graph."));
      }
      return projectionDataSource.searchSymbols(request, {
        endpoints: state.activeProjectionEndpoints,
        signal,
      });
    },

    // The one ghost "+" action used by every module canvas. First resolve the same containment
    // reveal for the clicked artifact, then add its owning member to whichever canvas is currently
    // visible. The destinations necessarily store membership differently: the minimal overlay owns
    // an ordered member list and captures the clicked position, while the Map/Service/UI canvases
    // own a set of extra file cards and let ELK place them. Focus and selection are never replaced.
    promoteGhost(ghostId, at) {
      const state = get();
      const surfaceOwner = moduleGraphSurfaceOwner(state);
      if (surfaceOwner === "prepared-review-overview") return;
      const minimalOpen = surfaceOwner === "extracted";
      if (surfaceOwner === "source" && moduleSurfaceSpec(state.viewMode) === null) {
        return;
      }

      const member = ghostMemberId(state.index, ghostId);
      if (member === null) {
        return;
      }
      const moduleExpanded = withMapRevealExpansion(state.moduleExpanded, [ghostId], state.index);

      if (minimalOpen) {
        if (state.minimalMemberIds.includes(member)) {
          return;
        }
        const minimalBasePositions =
          at === undefined
            ? state.minimalBasePositions
            : { ...state.minimalBasePositions, [member]: promotedMemberRect(at, state.index.nodesById.get(member)?.kind !== "module") };
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
      const surfaceOwner = moduleGraphSurfaceOwner(state);
      if (surfaceOwner === "prepared-review-overview") return;
      if (surfaceOwner === "extracted") {
        const memberIds = minimalSelectionRemovalIds(state);
        if (memberIds.length === 0) {
          return;
        }
        const removed = new Set(memberIds);
        set({
          minimalMemberIds: state.minimalMemberIds.filter((id) => !removed.has(id)),
          minimalProjectionExtraIds: new Set(
            [...state.minimalProjectionExtraIds].filter((id) => {
              const member = ghostMemberId(state.index, id);
              return member === null || !removed.has(member);
            }),
          ),
        });
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
      if (moduleGraphSurfaceOwner(get()) === "prepared-review-overview") return;
      set({ showHighways: !get().showHighways });
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

    async setMinimalView(view) {
      const state = get();
      if (moduleGraphSurfaceOwner(state) !== "extracted" || state.minimalView === view) return;
      if (!guardReviewLineComposerTransition(() => { void get().setMinimalView(view); })) return;
      if (view === "codebase") {
        cancelPreparedFileProjection();
        const { targetIds, retainedExpandedIds } = minimalCodebaseInputsForState(state);
        const needsProjection = captureMinimalCodebaseProjectionBaseline(state) !== null;
        retainCurrentMinimalScene(state);
        set({
          minimalView: "codebase",
          minimalCodebaseTargetIds: targetIds,
          minimalCodebaseRetainedExpandedIds: retainedExpandedIds,
          minimalCodebaseProjectionPending: needsProjection,
          // The exact extracted scene is now an inactive, evictable cache allocation. Keeping these
          // arrays in Zustand would pin the whole hidden graph outside the shared budget.
          minimalBasePositions: {},
          minimalRfNodes: [],
          minimalRfEdges: [],
          minimalLayoutStatus: "idle",
          minimalLayoutActivity: null,
          reviewFlowBaseline: state.reviewFlowBaseline === null
            ? null
            : { ...state.reviewFlowBaseline, minimalBasePositions: {} },
        });
        if (needsProjection) {
          await refreshMinimalCodebaseProjection();
          // A preflight failure can safely fall back before changing projections. Rehydrate the
          // extracted sibling from the bounded cache (or relayout after eviction) in that case.
          if (get().minimalView === "graph") await restoreCurrentMinimalScene();
        }
        return;
      }
      minimalCodebaseProjectionActivitySeq += 1;
      set({ minimalView: "graph", minimalCodebaseProjectionPending: false });
      if (
        minimalCodebaseProjectionBaseline !== null
        && !await restoreMinimalCodebaseProjection()
      ) return;
      await restoreCurrentMinimalScene();
    },

    setMinimalShowGhostNodes(visible) {
      if (get().minimalShowGhostNodes !== visible) {
        set({ minimalShowGhostNodes: visible });
      }
    },

    setMinimalCodebaseExpansionOverride(nodeId, expanded) {
      const next = new Map(get().minimalCodebaseExpansionOverrides);
      next.set(nodeId, expanded);
      set({ minimalCodebaseExpansionOverrides: next });
      const state = get();
      if (state.minimalView === "codebase" && minimalCodebaseProjectionBaseline !== null) {
        // Both directions are transport changes. A rapid expand→collapse aborts the first request,
        // and the final request is built from the current override map, so stale expanded pairs can
        // never install after the disclosure was closed.
        void refreshMinimalCodebaseProjection(expanded ? [nodeId] : []);
      }
    },

    // Extract the current selection into a child graph. The first extraction covers the module
    // surface; every later extraction snapshots the active graph and pushes another frame. An open
    // PR is ambient session context, not an overlay owner, so nested extraction never destroys it.
    async buildMinimalGraph() {
      if (get().minimalCodebaseProjectionPending) return;
      if (
        get().minimalView === "graph"
        && minimalCodebaseProjectionBaseline !== null
        && !await ensureExtractedGraphProjection()
      ) return;
      const state = get();
      const nested = state.minimalSeedIds.length > 0;
      if (
        state.moduleSelected.size === 0
        || (!nested && state.prReviewed !== null)
        || (nested && state.minimalView === "graph" && state.minimalLayoutStatus !== "ready")
        || state.flowPaneLayoutStatus === "laying-out"
        || state.syntheticExecutionStatus === "running"
      ) {
        return;
      }
      if (!guardReviewLineComposerTransition(() => { void get().buildMinimalGraph(); })) {
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
        invalidateFlowPaneLayout();
        requestTargetRevealSeq += 1;
      }
      syntheticExecutionSeq += 1;
      const inspectedSource = !nested && state.moduleGhostInspection !== null;
      if (!nested) moduleSceneNeedsRestore = inspectedSource;
      const minimalBasePositions = captureMapPositions(nested ? state.minimalRfNodes : state.moduleRfNodes);
      const history = nested ? appendMinimalGraphHistoryFrame(state) : [];
      if (nested) startNewMinimalScene();
      // A Codebase-origin child promotes the current context pair into its own extracted coordinate.
      // The parent's exact context+baseline pair lives in metadata beside its evictable scene.
      minimalCodebaseProjectionBaseline = null;
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
        minimalProjectionExtraIds: new Set<string>(),
        minimalRollups: {},
        minimalBasePositions,
        minimalArrange: false,
        minimalRfNodes: [],
        minimalRfEdges: [],
        minimalLayoutStatus: "laying-out",
        minimalLayoutActivity: { label: "Extracting selection…" },
        minimalGraphHistory: history,
        minimalView: "graph",
        minimalShowGhostNodes: true,
        minimalCodebaseExpansionOverrides: new Map<string, boolean>(),
        minimalCodebaseTargetIds: [],
        minimalCodebaseRetainedExpandedIds: new Set<string>(),
        minimalCodebaseProjectionPending: false,
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
              reviewHeadRef: null,
              reviewDiffByFile: {},
              ...requestFlowPaneReset(state),
            }),
        ...clearSyntheticFlow,
        ...clearArtifactReviewFlow,
      });
      void requestMinimalRelayout({ label: "Extracting selection…" });
    },

    // Navigate exactly one graph outward. A recent parent promotes its cached scene synchronously;
    // an evicted parent reloads only its projection coordinate and relayouts once. At the root, use
    // the canonical close path so source/PR baselines and URL state receive identical cleanup.
    async backMinimalGraph() {
      const initial = get();
      const parent = initial.minimalGraphHistory.at(-1);
      if (parent === undefined) {
        await get().closeMinimalGraph();
        return;
      }
      if (!guardReviewLineComposerTransition(() => { void get().backMinimalGraph(); })) {
        return;
      }
      // Back owns the next projection coordinate. Cancel any wider Codebase refresh and retire its
      // busy-state lease before restoring the parent; an abort-ignorant transport may settle much
      // later, but its activity can no longer keep or clear the parent's shell.
      minimalCodebaseProjectionActivitySeq += 1;
      projectionRequestController?.abort();
      projectionRequestController = null;
      projectionRequestSeq += 1;
      if (initial.minimalCodebaseProjectionPending) {
        set({ minimalCodebaseProjectionPending: false });
      }
      const projectionFrame = minimalProjectionFrames.get(parent.sceneKey) ?? null;
      if (projectionFrame?.active !== null && projectionFrame?.active !== undefined) {
        const activation = activateMinimalProjectionCoordinate(projectionFrame.active);
        if (activation instanceof Promise ? !await activation : !activation) return;
      }
      const state = get();
      // A competing navigation may have replaced the stack while an evicted projection reloaded.
      if (state.minimalGraphHistory.at(-1) !== parent) return;
      invalidateMinimalLayout();
      invalidateFlowPaneLayout();
      requestTargetRevealSeq += 1;
      syntheticExecutionSeq += 1;
      currentMinimalSceneKey = parent.sceneKey || nextMinimalSceneKey();
      const cachedScene = parent.minimalView === "graph"
        ? minimalSceneCache.activateAndDiscardPrevious(currentMinimalSceneKey)
        : undefined;
      if (parent.minimalView === "codebase") {
        // The popped child has no forward owner. Release it while keeping the parent's extracted
        // sibling as a budgeted inactive allocation for a later Graph switch.
        minimalSceneCache.discardActive();
        void minimalSceneCache.get(currentMinimalSceneKey);
      }
      const sceneState = cachedScene === undefined
        ? emptyMinimalGraphScene(parent)
        : restoreMinimalGraphScene(cachedScene);
      const restoredIndex = get().index;
      const restoredModuleSelected = new Set(
        [...parent.moduleSelected].filter((id) =>
          (state.showExternalGhosts || !id.startsWith("ext:"))
          && (state.showPrivate || !restoredIndex.privateIds.has(id)),
        ),
      );
      minimalCodebaseProjectionBaseline = parent.minimalView === "codebase"
        && projectionFrame?.codebaseBaseline !== null
        && projectionFrame?.codebaseBaseline !== undefined
        && projectionCoordinateMatchesSession(projectionFrame.codebaseBaseline, get())
          ? projectionFrame.codebaseBaseline
          : null;
      set({
        ...restoreMinimalGraphHistory(parent),
        ...sceneState,
        moduleSelected: restoredModuleSelected,
        minimalGraphHistory: state.minimalGraphHistory.slice(0, -1),
      });
      minimalProjectionFrames.delete(parent.sceneKey);
      minimalNavigationResidentBytes.delete(parent.sceneKey);
      // A cache hit restores the exact geometry. A miss keeps only the lightweight coordinate and
      // rebuilds one current scene; no evicted graph data is resurrected outside the shared budget.
      const showTestsChanged = state.showTests !== parent.showTests;
      if (showTestsChanged) {
        const liveReprojected = reprojectLivePrReview(
          parent.showTests ? "Restoring tests…" : "Restoring production review…",
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
            invalidateFlowPaneLayout();
            set({ flowPaneRfNodes: [], flowPaneRfEdges: [], flowPaneLayoutStatus: "idle" });
          }
        } else if (flowPresentationChanged || restored.flowPaneLayoutStatus !== "ready") {
          void get().flowPaneRelayout();
        }
      }
      if (
        cachedScene === undefined
        && get().minimalView === "graph"
        && get().minimalMemberIds.length > 0
        && get().minimalLayoutStatus !== "ready"
      ) {
        await get().minimalRelayout({ label: "Restoring extracted graph…" });
      }
    },

    // Close the overlay back to the Module-map level canvas. The selection is kept, so the reader
    // can adjust it and rebuild without re-picking every card. Bumping the seq discards any ELK
    // pass still in flight, so a slow layout can't repopulate the arrays after the close.
    closeMinimalGraph() {
      if (!guardReviewLineComposerTransition(() => { void get().closeMinimalGraph(); })) {
        return Promise.resolve();
      }
      const stateBeforeClose = get();
      cancelPreparedFileProjection();
      const closingPrReview = stateBeforeClose.prReviewed;
      minimalCodebaseProjectionActivitySeq += 1;
      projectionRequestController?.abort();
      projectionRequestController = null;
      projectionRequestSeq += 1;
      minimalCodebaseProjectionBaseline = null;
      // A user close/lens transition wins over a refresh. Invalidate both its data-fetch lane and
      // any streamed head preparation so a late response cannot reopen the overlay they just left.
      if (stateBeforeClose.prReviewRefreshing) {
        prReviewRefreshSeq += 1;
        get().cancelPrReviewPreparation();
        set({ prReviewRefreshing: false });
      }
      const flowBaseline = stateBeforeClose.reviewFlowBaseline;
      const reviewFlowOpen = stateBeforeClose.review !== null
        && stateBeforeClose.flowSelection !== null
        && flowBaseline !== null;
      const finishClose = (): Promise<void> => {
      const sourceRestoreSequence = moduleLayoutSeq;
      const restoreDeferredModuleScene = moduleSceneNeedsRestore;
      moduleSceneNeedsRestore = false;
      invalidateMinimalLayout();
      invalidateFlowPaneLayout();
      clearMinimalSceneNavigation();
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
        minimalProjectionExtraIds: new Set<string>(),
        minimalRollups: {},
        minimalBasePositions: {},
        minimalArrange: false,
        minimalRfNodes: [],
        minimalRfEdges: [],
        minimalLayoutStatus: "idle",
        minimalLayoutActivity: null,
        minimalGraphHistory: [],
        minimalView: "graph",
        minimalShowGhostNodes: true,
        minimalCodebaseExpansionOverrides: new Map<string, boolean>(),
        minimalCodebaseTargetIds: [],
        minimalCodebaseRetainedExpandedIds: new Set<string>(),
        minimalCodebaseProjectionPending: false,
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
        return (async () => {
          await yieldForPaint();
          const current = get();
          if (
            moduleLayoutSeq !== sourceRestoreSequence
            || current.prReviewed !== closingPrReview
            || moduleGraphOverlayIsOpen(current)
            || moduleSurfaceSpec(current.viewMode) === null
          ) {
            return;
          }
          await current.moduleRelayout({ label: "Restoring review map…" });
        })();
      } else if (restoreDeferredModuleScene && moduleSurfaceSpec(get().viewMode) !== null) {
        // The source graph was invisible while Extract owned the structural lane. Rebuild it only
        // after the overlay has released its scene, so no hidden projection is retained in parallel.
        return get().moduleRelayout({ label: "Restoring source graph…" });
      }
      return Promise.resolve();
      };
      // Closing the overlay mid-review must never expose the swapped HEAD as an ordinary Map. A
      // retained baseline promotes synchronously; an evicted/oversized one reloads first, leaving
      // the review overlay intact until the exact prior artifact/index are active again.
      if (get().prReviewed !== null) {
        try {
          const restoration = restoreReviewSession({ endSession: false });
          if (restoration instanceof Promise) {
            return restoration.then((restored) => {
              if (restored) return finishClose();
            }, (error) => {
              set({
                prReviewStatus: "error",
                prPrepareError: prepareErrorMessage(error),
              });
            });
          }
          if (!restoration && stateBeforeClose.prReviewBaseline !== null) return Promise.resolve();
        } catch (error) {
          set({ prReviewStatus: "error", prPrepareError: prepareErrorMessage(error) });
          return Promise.resolve();
        }
      }
      return finishClose();
    },

    // Reset the overlay to its base: restore the working set to the origin selection, collapse any
    // opened review rollups, and drop re-arrangement (back to the captured map-mirror).
    resetMinimalGraph() {
      const {
        minimalSeedIds,
        minimalMemberIds,
        minimalProjectionExtraIds,
        minimalRollups,
        minimalArrange,
        moduleExpanded,
      } = get();
      // An all-test review with Tests hidden retains a seed-only sentinel so the empty review panel
      // stays mounted. It is not a real origin/member and Reset must never promote it into view.
      if (minimalMemberIds.length === 0) {
        return;
      }
      // Flow review may temporarily substitute exact changed files; restore those to their package
      // summaries. Ordinary chevron disclosure never changes either member list.
      const origin = restoreRolledSeeds(minimalSeedIds, minimalRollups);
      const rolledIds = Object.keys(minimalRollups);
      const hasOpenRollup = rolledIds.some((id) => moduleExpanded.has(id));
      if (
        sameMembers(minimalMemberIds, origin)
        && sameMembers(minimalSeedIds, origin)
        && minimalProjectionExtraIds.size === 0
        && !minimalArrange
        && !hasOpenRollup
      ) {
        return;
      }
      const collapsed = new Set(moduleExpanded);
      rolledIds.forEach((id) => collapsed.delete(id));
      set({
        minimalSeedIds: origin,
        minimalMemberIds: [...origin],
        minimalProjectionExtraIds: new Set<string>(),
        moduleExpanded: collapsed,
        minimalArrange: false,
      });
      void requestMinimalRelayout({ label: "Resetting extracted graph…" });
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
        invalidateMinimalLayout();
        set({ minimalLayoutStatus: "idle", minimalLayoutActivity: null });
        if (get().minimalSeedIds.length > 0 && get().minimalView === "graph") {
          publishCurrentMinimalScene(get());
        }
        return;
      }
      const sequence = ++minimalLayoutSeq;
      set({
        minimalLayoutStatus: "laying-out",
        minimalLayoutActivity: activity ?? { label: "Arranging extracted graph…" },
      });
      await layoutCoordinator.run("minimal", async (signal) => {
        try {
          // Minimal Graph is another bounded view of the active revision, not a license to reuse
          // whichever source slice happened to be installed underneath it. Its members and explicit
          // disclosure gates must be admitted before derivation so expanding a file/class never
          // depends on stale children left over from an earlier Map projection.
          if (signal.aborted
          || (projectionDataSource !== null && !await ensureCurrentProjection({ layoutOwner: "minimal", signal }))
            || signal.aborted
            || minimalLayoutSeq !== sequence) {
            return;
          }
          await yieldForPaint();
          if (signal.aborted || minimalLayoutSeq !== sequence) {
            return;
          }
          const state = get();
          const { index, minimalSeedIds, minimalBasePositions, minimalArrange, moduleExpanded, artifact, showTests } = state;
          moduleGraph ??= buildModuleGraph(index);
          const deps = (blockDeps ??= buildBlockDeps(index));
          const flows = (artifact.extensions?.logicFlow ?? {}) as unknown as LogicFlows;
          const hidden = showTests ? EMPTY_HIDDEN_IDS : index.testIds;
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
              ? reviewDiffVisibleIds(index, state.reviewAffectedIds)
              : undefined,
          }, minimalArrange, hidden, surface.relations);
          if (signal.aborted || minimalLayoutSeq !== sequence) {
            return; // a newer build/promote/demote/reset/re-arrange superseded this one.
          }
          set({
            minimalRfNodes: layout.nodes,
            minimalRfEdges: layout.edges,
            minimalLayoutStatus: "ready",
            minimalLayoutActivity: null,
          });
          publishCurrentMinimalScene(get());
        } catch (error) {
          if (!signal.aborted && minimalLayoutSeq === sequence) {
            console.error("[meridian] Minimal graph layout failed.", error);
            set({ minimalLayoutStatus: "error", minimalLayoutActivity: null });
          }
        }
      });
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
    // to them in EITHER direction (1-hop). From another lens, setViewMode owns destination hydration
    // and performs this same resolution only after Service facts arrive. Inside Service, this action
    // narrows the already-authoritative projection and preserves its open frames.
    openServiceScope() {
      const initial = get();
      if (initial.viewMode !== "call" && clusteringForIfAvailable(initial.index) === null) {
        initial.setViewMode("call");
        return;
      }
      if (pendingModuleLensTransition !== null) {
        return;
      }
      const { index, viewMode, moduleExpanded, serviceGroupingMode, serviceGroupingTargetSize } = initial;
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
      if (!beginLensTransition(get, set, invalidateRequestFlowWork, () => get().openServiceScope())) {
        return;
      }
      if (viewMode === "logic") {
        invalidateLogicLayout();
      }
      const revealExpanded = viewMode === "call"
        ? new Set([...moduleExpanded, ...resolution.reveal.moduleExpanded])
        : resolution.reveal.moduleExpanded;
      set({
        viewMode: "call",
        serviceScope: serviceScopeFor(resolution.owningLeads, index),
        moduleRfNodes: [],
        moduleRfEdges: [],
        moduleSemanticLayers: [],
        moduleEffectiveFocus: null,
        ...releasedLogicScene(),
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
          void focusReviewSubgraph(
            rootId,
            { selectedId: id, litNodeIds: new Set([id]) },
            () => get().selectReviewNode(id),
          );
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
      if (before.flowSelection !== null || before.flowPaneOrigin !== null) {
        invalidateFlowPaneLayout();
      }
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
          set({ recenterSeq: get().recenterSeq + 1 });
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

    // The file row's click first activates one exact two-sided file coordinate, then focuses its
    // owning frame. A file that still has no semantic match after that honest load opens as source.
    async focusReviewFile(path) {
      let state = get();
      const targetCursor = preparedReviewFileCursor(state.prPreparedChangedFiles, path);
      if (state.prPreparedArtifactCurrent && targetCursor !== null) {
        if (!guardReviewLineComposerTransition(() => { void get().focusReviewFile(path); })) return;
        const coordinateChanged = targetCursor !== state.prPreparedReviewCursor;
        if (!await hydratePreparedReviewFile(path, targetCursor)
          || get().prPreparedReviewCursor !== targetCursor) return;
        if (coordinateChanged) {
          const layouts: Promise<void>[] = [];
          const applied = applyPrReviewToMap(
            get,
            set,
            prFilesUrl,
            invalidateMinimalLayout,
            invalidateModuleLayout,
            invalidateRequestFlowWork,
            invalidateArtifactCaches,
            {
              surfaceTransition: "reproject",
              preserveReviewSelection: false,
              captureVisibleLayout: (layout) => layouts.push(layout),
            },
          );
          if (!applied) return;
          await Promise.all(layouts);
          if (get().prPreparedReviewCursor !== targetCursor) return;
        }
        state = get();
      }
      const file = state.reviewFiles.find((candidate) => candidate.path === path);
      if (!file || file.moduleId === null) {
        await get().showReviewFile(path);
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
          await focusReviewSubgraph(
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
      if (state.flowSelection !== null || state.flowPaneOrigin !== null) {
        invalidateFlowPaneLayout();
      }
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
          set({ recenterSeq: get().recenterSeq + 1 });
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
    async selectReviewGroup(groupId) {
      const initial = get();
      if (
        !initial.review
        || !initial.reviewGroups
        || (groupId === initial.reviewActiveGroupId
          && initial.reviewPathScope === null
          && initial.reviewFocusedSubgraph === null)
      ) return;
      if (
        minimalCodebaseProjectionBaseline !== null
        && !await ensureExtractedGraphProjection()
      ) return;
      const {
        review,
        reviewFiles,
        reviewGroups,
        reviewBaseNodeIds,
        reviewDeletedNodeIds,
        index,
      } = get();
      if (!review || !reviewGroups) return;
      if (!guardReviewLineComposerTransition(() => { void get().selectReviewGroup(groupId); })) {
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
      invalidateFlowPaneLayout();
      clearMinimalSceneNavigation();
      startNewMinimalScene();
      minimalCodebaseProjectionBaseline = null;
      set({
        reviewActiveGroupId: group ? group.id : null,
        reviewPathScope: null,
        reviewFocusedSubgraph: null,
        minimalGraphHistory: [],
        minimalView: "graph",
        minimalShowGhostNodes: true,
        minimalCodebaseExpansionOverrides: new Map<string, boolean>(),
        minimalCodebaseTargetIds: [],
        minimalCodebaseRetainedExpandedIds: new Set<string>(),
        minimalCodebaseProjectionPending: false,
        minimalProjectionExtraIds: new Set<string>(),
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
      await requestMinimalRelayout({ label: group ? `Opening ${group.label}…` : "Opening all review groups…" });
    },

    // A path scope is an additional, segment-safe filter over the active connectivity group. It
    // reuses the exact group-isolation machinery so graph, files, and flows remain one coherent
    // review lens. Empty/unmatched input cannot close the overlay and strand the review panel.
    async selectReviewPathScope(path) {
      const initial = get();
      if (initial.review === null) {
        return;
      }
      const normalized = path === null ? null : normalizeReviewPathScope(path) || null;
      if (normalized === initial.reviewPathScope && initial.reviewFocusedSubgraph === null) {
        return;
      }
      if (
        minimalCodebaseProjectionBaseline !== null
        && !await ensureExtractedGraphProjection()
      ) return;
      const state = get();
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
      if (!guardReviewLineComposerTransition(() => { void get().selectReviewPathScope(path); })) {
        return;
      }
      invalidateMinimalLayout();
      invalidateFlowPaneLayout();
      clearMinimalSceneNavigation();
      startNewMinimalScene();
      minimalCodebaseProjectionBaseline = null;
      set({
        reviewPathScope: normalized,
        reviewFocusedSubgraph: null,
        minimalGraphHistory: [],
        minimalView: "graph",
        minimalShowGhostNodes: true,
        minimalCodebaseExpansionOverrides: new Map<string, boolean>(),
        minimalCodebaseTargetIds: [],
        minimalCodebaseRetainedExpandedIds: new Set<string>(),
        minimalCodebaseProjectionPending: false,
        minimalProjectionExtraIds: new Set<string>(),
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
      await get().minimalRelayout({ label: normalized === null ? "Opening review group…" : `Opening ${normalized}…` });
    },

    // A review container focus is a child surface of the current PR graph, not a moduleFocus dive.
    // Exact file seeds deliberately bypass rollupSeeds so opening a large `fs` package reveals its
    // files rather than reproducing the same summary card. Every open pushes lightweight metadata;
    // exact scenes remain bounded and evictable under the shared navigation-memory budget.
    async openReviewSubgraph(rootId) {
      await focusReviewSubgraph(rootId, null, () => { void get().openReviewSubgraph(rootId); });
    },

    // Back reactivates the exact parent scene while it remains resident; an evicted scene keeps its
    // lightweight navigation frame and pays one relayout instead of retaining unbounded graph data.
    closeReviewSubgraph() {
      if (get().reviewFocusedSubgraph === null) {
        return;
      }
      void get().backMinimalGraph();
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
      if (!get().review) {
        return;
      }
      set({ reviewTicks: {}, reviewUnitTicks: {}, reviewFileTicks: {} });
      persistReviewProgress(get());
    },

    // Tick one touched unit in the files checklist; the owning file's viewed state derives from these.
    toggleReviewUnitTick(nodeId) {
      const { reviewFiles, reviewUnitTicks } = get();
      const unit = reviewFiles.flatMap((file) => file.units).find((candidate) => candidate.nodeId === nodeId);
      if (!unit) {
        return;
      }
      set({ reviewUnitTicks: applyUnitTick(reviewUnitTicks, unit, new Date().toISOString()) });
      persistReviewProgress(get());
    },

    // Structural cards derive their progress from the directly changed leaves they contain.
    toggleReviewUnitsViewed(nodeIds) {
      const { reviewFiles, reviewUnitTicks } = get();
      const selectedIds = new Set(nodeIds);
      const units = reviewFiles.flatMap((file) => file.units)
        .filter((unit) => selectedIds.has(unit.nodeId));
      if (units.length === 0) {
        return;
      }
      set({ reviewUnitTicks: applyUnitsToggle(units, reviewUnitTicks, new Date().toISOString()) });
      persistReviewProgress(get());
    },

    // The per-file "viewed" checkbox: cascades over the file's units (all on / all off); an
    // unit-less file flips its own explicit tick.
    toggleReviewFileViewed(path) {
      const { reviewFiles, reviewUnitTicks, reviewFileTicks } = get();
      const file = reviewFiles.find((candidate) => candidate.path === path);
      if (!file) {
        return;
      }
      const next = applyFileToggle(file, reviewUnitTicks, reviewFileTicks, new Date().toISOString());
      set({ reviewUnitTicks: next.unitTicks, reviewFileTicks: next.fileTicks });
      persistReviewProgress(get());
    },

    // Folder markers bulk-toggle exactly the changed descendant files represented by that folder.
    // Persist once so the graph marker and review rail advance as one atomic progress update.
    toggleReviewFilesViewed(paths) {
      const { reviewFiles, reviewUnitTicks, reviewFileTicks } = get();
      const selectedPaths = new Set(paths);
      const files = reviewFiles.filter((candidate) => selectedPaths.has(candidate.path));
      if (files.length === 0) {
        return;
      }
      const next = applyFilesToggle(files, reviewUnitTicks, reviewFileTicks, new Date().toISOString());
      set({ reviewUnitTicks: next.unitTicks, reviewFileTicks: next.fileTicks });
      persistReviewProgress(get());
    },

    // The line composer is one session-only editing surface shared by hover, inline, modal, and
    // edge source hosts. Capturing the review revision prevents a remounted view from silently
    // retargeting unfinished prose after the PR head changes.
    openReviewLineComposer(path, line) {
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
      };
      const current = state.reviewLineComposer;
      if (matchesReviewLineComposerTarget(current, target)) {
        // Re-selecting the current line is an explicit return to the draft, so it also cancels a
        // previously queued source transition and leaves confirmation mode.
        pendingReviewLineComposerTransition = null;
        set({ reviewLineComposer: openReviewLineComposerState(current, target) });
        return;
      }
      if (!guardReviewLineComposerTransition(() => get().openReviewLineComposer(path, line))) {
        return;
      }
      set({ reviewLineComposer: openReviewLineComposerState(get().reviewLineComposer, target) });
    },

    setReviewLineComposerBody(body) {
      const current = get().reviewLineComposer;
      if (current === null) return;
      set({ reviewLineComposer: setReviewLineComposerBodyState(current, body) });
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
      set({ reviewLineComposer: discardReviewLineComposerState() });
      transition?.();
    },

    // Add a draft comment on a file (nodeId null), touched unit, or explicit HEAD-side line. Drafts
    // persist under the reviewKey until submitted or deleted.
    addReviewComment(path, nodeId, body, line = null) {
      const { review, reviewComments, index, prReviewRevision } = get();
      const trimmed = body.trim();
      if (!review || trimmed.length === 0) {
        return;
      }
      const lineRevision = line === null ? null : prReviewRevisionKey(prReviewRevision);
      const comment: ReviewComment = {
        id: newCommentId(),
        path,
        nodeId,
        line,
        ...(lineRevision === null ? {} : { lineRevision }),
        anchorLabel: line === null ? (nodeId === null ? null : (index.nodesById.get(nodeId)?.displayName ?? null)) : `L${line}`,
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
        version: 4,
        flowSplitView: view,
        openFlowSplitOnSelect: state.reviewOpenFlowSplitOnSelect,
        codePreviewTrigger: state.reviewCodePreviewTrigger,
        hideAddedSourceCommentDiffs: state.reviewHideAddedSourceCommentDiffs,
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
        invalidateFlowPaneLayout();
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
        version: 4,
        flowSplitView: state.reviewFlowSplitView,
        openFlowSplitOnSelect: open,
        codePreviewTrigger: state.reviewCodePreviewTrigger,
        hideAddedSourceCommentDiffs: state.reviewHideAddedSourceCommentDiffs,
      });
      const reviewFlowSelected = state.review !== null
        && state.minimalSeedIds.length > 0
        && state.flowSelection !== null
        && state.reviewFlowBaseline !== null;
      set({
        reviewOpenFlowSplitOnSelect: open,
        ...(reviewFlowSelected ? { recenterSeq: state.recenterSeq + 1 } : {}),
      });
      if (!reviewFlowSelected) {
        return;
      }
      const effectiveView = state.reviewFlowExplicitView ?? state.reviewFlowSplitView;
      const executionGraph = state.flowPaneOrigin === "synthetic" || effectiveView === "graph";
      const splitOpen = open || state.reviewFlowExplicitView !== null;
      if (!splitOpen || !executionGraph) {
        invalidateFlowPaneLayout();
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
        version: 4,
        flowSplitView: state.reviewFlowSplitView,
        openFlowSplitOnSelect: state.reviewOpenFlowSplitOnSelect,
        codePreviewTrigger: trigger,
        hideAddedSourceCommentDiffs: state.reviewHideAddedSourceCommentDiffs,
      });
      set({ reviewCodePreviewTrigger: trigger });
    },

    setReviewHideAddedSourceCommentDiffs(hide) {
      const state = get();
      if (state.reviewHideAddedSourceCommentDiffs === hide) {
        return;
      }
      writeReviewPreferences({
        version: 4,
        flowSplitView: state.reviewFlowSplitView,
        openFlowSplitOnSelect: state.reviewOpenFlowSplitOnSelect,
        codePreviewTrigger: state.reviewCodePreviewTrigger,
        hideAddedSourceCommentDiffs: hide,
      });
      set({ reviewHideAddedSourceCommentDiffs: hide });
    },

    toggleReviewDiffOnly() {
      if (minimalCodebaseProjectionBaseline !== null) {
        void ensureExtractedGraphProjection().then((restored) => {
          if (restored) get().toggleReviewDiffOnly();
        });
        return;
      }
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
        prReviewed: prNumber,
        reviewSubmitStatus,
        prReviewStale,
        prReviewRefreshing,
        prReviewStatus,
        prReviewRevision: submittedRevision,
        showTests,
        index,
      } = get();
      const visibleComments = showTests
        ? reviewComments
        : reviewComments.filter((comment) => !isReviewTestPath(comment.path, index, null));
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
      // Hidden test drafts remain persisted and reappear when Tests is restored; they must neither
      // submit invisibly nor block the visible draft set while their rows are absent.
      const forceFileComments = event === "COMMENT"
        && prReviewStale
        && submittedRevision?.headSha == null;
      const submission = buildReviewSubmission(
        visibleComments,
        reviewFiles,
        review.context,
        reviewCommentRangesByFile,
        { forceFileComments },
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
        if (pendingModuleLensTransition !== null) {
          return;
        }
        if (moduleSurfaceSpec(mode) !== null && get().moduleLayoutStatus === "error") {
          void get().moduleRelayout({ label: "Retrying graph view…" });
          return;
        }
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
      // Capture module-family carry before beginLensTransition clears outgoing Service scope/focus.
      // Logic and PR entry own no module canvas, so they leave this empty and perform no topology
      // work at all.
      let anchors: string[] = [];
      if (mode !== "logic" && mode !== "prs") {
        const outgoing = get();
        const rawAnchors = anchorNodeIds(outgoing);
        anchors = outgoing.viewMode === "call"
          ? expandServiceSyntheticAnchors(
              rawAnchors,
              outgoing.index,
              outgoing.serviceGroupingMode,
              outgoing.serviceGroupingTargetSize,
            )
          : [...new Set(rawAnchors)];
      }
      if (!beginLensTransition(get, set, invalidateRequestFlowWork, () => get().setViewMode(mode))) {
        return;
      }
      if (mode === "logic") {
        pendingModuleLensTransition = null;
        cancelProjectionHydration();
        invalidateModuleLayout();
        const restoreLogicScene = get().logicRoot !== null && get().logicRfNodes.length === 0;
        set({ viewMode: mode, ...releasedModuleScene() });
        if (restoreLogicScene) {
          void get().logicRelayout({ label: "Restoring logic flow…" });
        }
        return;
      }
      if (mode === "prs") {
        pendingModuleLensTransition = null;
        cancelProjectionHydration();
        invalidateModuleLayout();
        invalidateLogicLayout();
        // beginLensTransition softly parked any open review and restored its prior projection when
        // cached. Keep the review
        // payload and prepared id alive while the queue is browsed; starting another review is the
        // commit point that replaces it. No relayout here because the PR page has no canvas.
        // Remember the lens we're leaving so `togglePrsView` can resume it (previous !== "prs" here).
        lensBeforePrs = previous;
        set({ viewMode: mode, ...releasedModuleScene(), ...releasedLogicScene() });
        if (get().prsList[get().prsTab] === null) {
          void get().loadPrs(1);
        }
        return;
      }
      // A shared/reloaded deep link is unaffected: it restores via setState on boot (not this click
      // path), so an explicit ?mfocus=… still opens exactly where the link points. The palette's
      // "+" pins (`mapExtra`) are session scratch of the level we leave — always cleared. Every
      // remaining mode is a module surface (Map / Service / UI) with its own anchor reveal.
      invalidateLogicLayout();
      pendingModuleLensTransition = { mode, anchors };
      // Commit destination intent and its real selector ids. moduleRelayout hydrates the target,
      // resolves the carry with target facts, hydrates the exact final coordinate, then lays it out.
      // No outgoing scene remains mounted during either projection boundary.
      set({
        viewMode: mode,
        mapExtra: new Set<string>(),
        mapGhostPins: new Map<string, ReadonlySet<string>>(),
        moduleRfNodes: [],
        moduleRfEdges: [],
        moduleSemanticLayers: [],
        moduleEffectiveFocus: null,
        ...releasedLogicScene(),
        serviceScope: null,
        ...MODULE_TOP_LEVEL,
        moduleSelected: new Set(anchors),
      });
      void get().moduleRelayout({
        label: mode === "call" ? "Opening Service lens…" : mode === "ui" ? "Opening UI lens…" : "Opening Map lens…",
      });
    },

    // The "PR review" control is a toggle: off → open the full PR page; on → resume the lens you came
    // from (Map/Service/UI/Logic). Navigation state stays intact while PRs are open, but derived
    // React Flow arrays are released; flipping back rebuilds only the scene that becomes visible.
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
      } else if (back === "logic" && get().logicRoot !== null && get().logicRfNodes.length === 0) {
        void get().logicRelayout({ label: "Restoring logic flow…" });
      }
    },

    // Hiding tests while having selected test code would strand the view on nodes that no longer
    // exist, so selection — including the composition panel's own selection/root — retreats first.
    toggleShowTests() {
      if (minimalCodebaseProjectionBaseline !== null) {
        void ensureExtractedGraphProjection().then((restored) => {
          if (restored) get().toggleShowTests();
        });
        return;
      }
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
      const { compSelectedId, compRoot, moduleSelected, viewMode, index, prReviewed } = get();
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
      if (prReviewed !== null && reviewSurfaceIsOpen(get())) {
        if (get().minimalGraphHistory.length > 0) {
          reprojectLivePrReview(showTests ? "Showing tests…" : "Hiding tests…", true);
        } else {
          applyPrReviewToMap(get, set, prFilesUrl, invalidateMinimalLayout, invalidateModuleLayout, invalidateRequestFlowWork, invalidateArtifactCaches, {
            surfaceTransition: "reproject",
            preserveReviewSelection: true,
          });
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

    // Coverage only recolors. Projected sessions switch to the same structural slice with optional
    // whole-revision facts attached; that response is another bounded LRU entry, so rapid toggles
    // can navigate back without pinning analysis data in Zustand while the lens is off.
    toggleCoverageMode() {
      const previous = get();
      const coverageMode = !previous.coverageMode;
      if (projectionDataSource === null) {
        set({
          coverageMode,
          coverage: coverageMode
            ? buildRendererReachabilityReport(previous.artifact.nodes, previous.artifact.edges)
            : null,
        });
        return;
      }
      set({ coverageMode, coverage: null });
      void ensureCurrentProjection().catch(() => {
        // The toggle is transactional. If this exact request is still current, restore the prior
        // paint state; a newer navigation/toggle owns its own projection request and is untouched.
        if (get().coverageMode === coverageMode) {
          set({ coverageMode: previous.coverageMode, coverage: previous.coverage });
        }
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
        invalidateFlowPaneLayout();
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
      if (get().flowPaneOrigin === "request") invalidateFlowPaneLayout();
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
      if (get().flowPaneOrigin === "request") invalidateFlowPaneLayout();
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
      invalidateFlowPaneLayout();
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
                && traceGraphRefMismatches(
                  bundle.graphRef,
                  traceGraphRevisionIdentity(current.index.graphSummary, current.artifact.target),
                ).length === 0;
              if (current.flowPaneOrigin === "request") invalidateFlowPaneLayout();
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
      const view = await fetchCodeView(request, "inline", codePayloadCache, opts?.signal);
      return view === null || opts?.focus === undefined
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
      cancelCodeViewRequest();
      const controller = new AbortController();
      codeViewController = controller;
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
      const view = await fetchCodeView(request, requestedMode, codePayloadCache, controller.signal);
      if (codeViewController === controller) codeViewController = null;
      if (view === null || sequence !== codeViewSeq || get().codeView?.node.id !== node.id) {
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
      const request = codeLoadRequest(node, undefined, state, sourceUrl, prFileUrl);
      if (!request) {
        get().closeEdgeEvidence();
        return; // The pinned inspector remains visible and truthfully reports attribution only.
      }
      if (!guardReviewLineComposerTransition(
        () => { void get().showEdgeEvidence(contexts, activeIndex); },
      )) {
        return;
      }
      cancelCodeViewRequest();
      const controller = new AbortController();
      codeViewController = controller;
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
      const view = await fetchCodeView(request, "modal", codePayloadCache, controller.signal);
      if (codeViewController === controller) codeViewController = null;
      const current = get().codeView;
      const currentContext = current?.edgeEvidence?.contexts[current.edgeEvidence.activeIndex];
      if (
        sequence !== edgeEvidenceSeq
        || codeSequence !== codeViewSeq
        || view === null
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
      cancelCodeViewRequest();
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
      cancelCodeViewRequest();
      set({ codeView: null });
    },

    setPrsTab(tab) {
      if (get().prsTab === tab) {
        return;
      }
      // A tab switch is also a selection reset, so invalidate every selected-PR response lane.
      prFilesSeq += 1;
      get().cancelPrReviewPreparation();
      set({
        prsTab: tab,
        prsError: null,
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
      const inFlight = prSummaryRequests.get(number);
      if (inFlight !== undefined) {
        await inFlight;
        return;
      }
      const request = (async () => {
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
      })();
      prSummaryRequests.set(number, request);
      try {
        await request;
      } finally {
        if (prSummaryRequests.get(number) === request) prSummaryRequests.delete(number);
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
      if (options.endReviewSession && await restoreSelectedPrReview(get, restoreReviewSession)) {
        void get().relayout();
      }
      const prepareReset = {
        prReviewStatus: "idle" as const,
        prPrepareStage: null,
        prPrepareElapsedMs: null,
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
          const current = get();
          const preparedManifest = current.prReviewed === number
            && current.prPreparedArtifactCurrent
            && current.prFiles !== null
            ? preparedManifestFromCanonicalFiles(current.prFiles)
            : null;
          const hydratedFiles = preparedManifest === null
            ? data.files
            : canonicalPreparedPrFiles(data.files, preparedManifest, current.artifact);
          set({
            prFiles: hydratedFiles,
            prFilesTruncated: data.truncated,
            prFilesTotal: data.totalFiles ?? data.files.length,
            prFilesOutside: data.outsideCount ?? 0,
            prFilesSuggestedSubdir: data.suggestedSubdir ?? "",
            prsLoading: false,
            prsError: null,
          });
          if (preparedManifest !== null) {
            // The prepare manifest owns membership/status/rename identity. GitHub detail contributes
            // patches, comment ranges, and totals only; reproject the current immutable HEAD without
            // another server preparation or replacing the canonical inventory.
            if (await ensureExtractedGraphProjection()) {
              if (get().minimalGraphHistory.length > 0) {
                reprojectLivePrReview("Updating review details…", true);
              } else {
                applyPrReviewToMap(
                  get,
                  set,
                  prFilesUrl,
                  invalidateMinimalLayout,
                  invalidateModuleLayout,
                  invalidateRequestFlowWork,
                  invalidateArtifactCaches,
                  { surfaceTransition: "reproject", preserveReviewSelection: true, preserveReviewDiffOnly: true },
                );
              }
            }
          }
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
          set({
            ...refreshedPrSummaryState(current, latest),
            prReviewStale: isPrReviewStale(revision, latest),
          });
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
    // fresh files, discussion, checks, and prepared head projection replace the old
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
        || !reviewSurfaceIsOpen(before)
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
      const restoreRetainedReviewFiles = () => {
        const current = get();
        if (
          current.prReviewed !== number
          || current.prSelected !== number
          || current.prReviewRevision !== revision
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
        prPrepareElapsedMs: null,
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

        if (prepareUrl !== null && prSessionSource !== null) {
          await get().prepareHeadGraph();
          // Successful projection replaces the revision object. If it did not, preparation either
          // failed, found no matching HEAD nodes, or was canceled by a soft close; all three keep
          // the prior review and therefore must keep its matching GitHub payload as well.
          restoreRetainedReviewFiles();
        } else {
          throw new Error("PR refresh requires direct graph preparation transport");
        }
      } catch (error) {
        restoreRetainedReviewFiles();
        if (active()) {
          set({
            prReviewStatus: "error",
            prPrepareStage: null,
            prPrepareElapsedMs: null,
            prPrepareError: refreshErrorMessage(error),
          });
        }
      } finally {
        if (prReviewRefreshSeq === sequence && get().prReviewed === number) {
          set({ prReviewRefreshing: false });
        }
      }
    },

    async restorePreparedPrReview(number, options) {
      if (preparedReviewUrl === null) {
        return false;
      }
      // A server-injected handoff is authoritative for this URL. Abort/supersede any older restore,
      // but never fall through to POST when this immutable GET is malformed or stale.
      preparedReviewRestoreController?.abort();
      const controller = new AbortController();
      preparedReviewRestoreController = controller;
      const sequence = ++prPrepareSeq;
      const fileSequence = ++prFilesSeq;
      const discussionSequence = ++prDiscussionSeq;
      const activeBeforeEntry = () => prPrepareSeq === sequence
        && !controller.signal.aborted
        && get().viewMode === "prs"
        && get().prSelected === number
        && get().prReviewed === null;
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
        prReviewStatus: "preparing",
        prPrepareStage: "resolve",
        prPrepareElapsedMs: 0,
        prPrepareError: null,
      });

      const files = fetchPrFiles(prFilesUrl, number).then(
        (result) => result,
        () => null,
      );
      const discussion = fetchPrDiscussion(prCommentsUrl, number).catch(() => null);
      let restoringGraphId: string | null = null;
      let stagedRestore: StagedReviewProjection | null = null;
      try {
        const [handoff, summary] = await Promise.all([
          fetchPreparedReviewHandoff(preparedReviewUrl, controller.signal),
          fetchPrSummary(prOneUrl, number),
        ]);
        if (!activeBeforeEntry()) return true;
        assertPreparedReviewHandoffIdentity(
          handoff,
          number,
          summary,
          prSessionSource,
          get().activeProjectionGraphId,
        );
        restoringGraphId = handoff.head.graphId;
        set({
          ...refreshedPrSummaryState(get(), summary),
          prPrepareStage: "publish",
          prPrepareElapsedMs: totalPrPrepareElapsedMs(handoff.timings),
        });
        const checks = fetchPrChecks(prChecksUrl, number, handoff.headSha).catch(() => null);
        const reviewCursor = preparedReviewFileCursor(handoff.changedFiles);
        const [staged, capability] = await stagePreparedReviewWithCapability(
          handoff.head,
          handoff.mergeBase,
          handoff.changedFiles,
          reviewCursor,
          {
            repository: prSessionSource?.repository ?? null,
            headSha: handoff.headSha,
          },
          controller.signal,
        );
        stagedRestore = staged;
        if (!activeBeforeEntry()) {
          staged.release();
          return true;
        }
        const prepared = staged.projection;
        // Observe already-settled detail without putting it on the critical path. The immediately
        // resolved sentinel wins while the network request is still pending.
        const initialDetails = await Promise.race<PrFilesResponse | null>([files, Promise.resolve(null)]);
        if (!activeBeforeEntry()) {
          staged.release();
          return true;
        }
        const canonicalFiles = canonicalPreparedPrFiles(
          initialDetails?.files ?? [],
          handoff.changedFiles,
          prepared.head.artifact,
        );
        resetMinimalProjectionNavigationForRevision();
        invalidateSyntheticArtifactBoundary();
        swapToPreparedReviewProjection(
          get,
          set,
          staged,
          invalidateArtifactCaches,
          graphProjectionEndpoints(handoff.head),
          capability,
          {
            prPreparedHead: handoff.head,
            prPreparedMergeBase: handoff.mergeBase,
            prPreparedReviewCursor: reviewCursor,
            prPreparedFileProjectionPending: null,
            prPreparedFileProjectionError: null,
            prPreparedChangedFiles: [...handoff.changedFiles],
            prPreparedHeadSha: handoff.headSha,
            prPreparedMergeBaseSha: handoff.mergeBaseSha,
            prFiles: canonicalFiles,
            prFilesTruncated: false,
            prFilesTotal: Math.max(
              canonicalFiles.length,
              initialDetails?.totalFiles ?? initialDetails?.files.length ?? 0,
            ),
            prFilesOutside: initialDetails?.outsideCount ?? 0,
            prFilesSuggestedSubdir: initialDetails?.suggestedSubdir ?? "",
            prsLoading: false,
            prsError: null,
          },
        );
        const visibleLayouts: Promise<void>[] = [];
        const entered = applyPrReviewToMap(
          get,
          set,
          prFilesUrl,
          invalidateMinimalLayout,
          invalidateModuleLayout,
          invalidateRequestFlowWork,
          invalidateArtifactCaches,
          {
            beforeVisibleLayout: options?.onVisibleLayoutStart,
            captureVisibleLayout: (layout) => visibleLayouts.push(layout),
          },
        );
        if (!entered) {
          await restoreReviewSession({ endSession: true });
          set({
            prReviewStatus: "error",
            prPrepareStage: null,
            prPrepareElapsedMs: null,
            prPrepareError: "The prepared pull request does not match this graph.",
          });
          return true;
        }
        await Promise.all(visibleLayouts);
        if (get().prReviewed === number && get().prPreparedHead?.graphId === handoff.head.graphId) {
          set({ prReviewStatus: "idle", prPrepareStage: null, prPrepareElapsedMs: null, prPrepareError: null });
        }

        // GitHub detail is enrichment only. The status-rich handoff controls membership immediately;
        // if patches/comments arrive later, reproject the same immutable HEAD without another POST.
        if (initialDetails === null) {
          void files.then(async (detail) => {
            let current = get();
            if (
              detail === null
              || prFilesSeq !== fileSequence
              || current.prReviewed !== number
              || current.prPreparedHead?.graphId !== handoff.head.graphId
            ) return;
            if (!await ensureExtractedGraphProjection()) return;
            current = get();
            if (
              prFilesSeq !== fileSequence
              || current.prReviewed !== number
              || current.prPreparedHead?.graphId !== handoff.head.graphId
            ) return;
            set({
              prFiles: canonicalPreparedPrFiles(detail.files, handoff.changedFiles, current.artifact),
              prFilesTruncated: false,
              prFilesTotal: Math.max(handoff.changedFiles.length, detail.totalFiles ?? detail.files.length),
              prFilesOutside: detail.outsideCount ?? 0,
              prFilesSuggestedSubdir: detail.suggestedSubdir ?? "",
            });
            if (get().minimalGraphHistory.length > 0) {
              reprojectLivePrReview("Updating review details…", true);
            } else {
              applyPrReviewToMap(
                get,
                set,
                prFilesUrl,
                invalidateMinimalLayout,
                invalidateModuleLayout,
                invalidateRequestFlowWork,
                invalidateArtifactCaches,
                { surfaceTransition: "reproject", preserveReviewSelection: true, preserveReviewDiffOnly: true },
              );
            }
          });
        }
        void discussion.then((result) => {
          if (
            result !== null
            && prDiscussionSeq === discussionSequence
            && get().prReviewed === number
          ) {
            set({ prDiscussion: { comments: result.comments, reviews: result.reviews } });
          }
        });
        void checks.then((result) => {
          if (result !== null && prFilesSeq === fileSequence && get().prReviewed === number) {
            set({ prChecks: result });
          }
        });
        return true;
      } catch (error) {
        const current = get();
        if (
          activeBeforeEntry()
          || (
            restoringGraphId !== null
            && current.prReviewed === number
            && current.prPreparedHead?.graphId === restoringGraphId
          )
        ) {
          set({
            prsLoading: false,
            prReviewStatus: "error",
            prPrepareStage: null,
            prPrepareElapsedMs: null,
            prPrepareError: preparedHandoffErrorMessage(error),
          });
        }
        return true;
      } finally {
        stagedRestore?.release();
        if (preparedReviewRestoreController === controller) preparedReviewRestoreController = null;
      }
    },

    async preparePrReviewNavigation(subdir, signal) {
      const state = get();
      const prNumber = state.prSelected;
      const summary = selectedPrSummary(state, prNumber);
      if (prepareUrl === null || prSessionSource === null) {
        throw new Error("This session does not provide direct PR preparation.");
      }
      if (prNumber === null || summary === null) {
        throw new Error("Select a pull request before preparing its review.");
      }
      const prepared = await streamPrPreparation(
        prepareUrl,
        prPrepareRequest(prSessionSource, summary, subdir),
        () => {},
        signal,
      );
      return prepared.handoff.viewUrl;
    },

    // A selected summary is sufficient to start direct preparation. GitHub's changed-file/detail
    // lane hydrates concurrently and may enrich the immutable status-rich prepare manifest later;
    // it is deliberately not on the graph entry critical path.
    async reviewPrInGraph(options) {
      const selected = get().prSelected;
      if (selected === null) {
        return;
      }
      if (get().prReviewed === selected) {
        await get().resumePrReview(options);
        return;
      }
      if (selectedPrSummary(get(), selected) === null) {
        await get().ensurePrSummary(selected);
        if (get().prSelected !== selected || selectedPrSummary(get(), selected) === null) {
          return;
        }
      }
      // A programmatic selection can arrive without selectPr's detail request. Start that lane now,
      // before prepareHeadGraph, because selectPr intentionally cancels older preparation when it
      // starts. Never await it: the prepare manifest is the canonical review inventory.
      if (
        get().prFiles === null
        && !(prFilesRequest?.number === selected && prFilesRequest.sequence === prFilesSeq)
      ) {
        void get().selectPr(selected);
      }
      // Selection is only browsing; pressing Review in graph is the commit point that replaces an
      // older parked session. Drop its lightweight return coordinate before preparing the new PR.
      if (get().prReviewed !== null) {
        await restoreSelectedPrReview(get, restoreReviewSession);
      }
      if (prepareUrl === null || prSessionSource === null) {
        set({
          prReviewStatus: "error",
          prPrepareStage: null,
          prPrepareElapsedMs: null,
          prPrepareError: "This session does not provide direct PR preparation.",
        });
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

    // Re-open a review whose overlay was soft-closed (explicit Close/lens switch) — cheaply. The
    // expensive mirror/extraction pipeline NEVER re-runs here: a swapped review reactivates its
    // already-prepared head projection (against the same lightweight return coordinate). Then
    // re-project the review through the current Tests setting so a toggle changed while the
    // workspace was parked is honored.
    async resumePrReview(options) {
      const {
        prReviewed,
        prReviewSource,
        prReviewBaseline,
        prReviewRevision,
        review,
        prPreparedHead,
        prPreparedMergeBase,
        prPreparedReviewCursor,
        prPreparedChangedFiles,
        prPreparedHeadSha,
        prPreparedMergeBaseSha,
        reviewActiveGroupId: resumeGroupId,
        reviewPathScope: resumePathScope,
        viewMode: resumeViewMode,
      } = get();
      if (prReviewed === null || review !== null) {
        return;
      }
      cancelPreparedFileProjection();
      // Resume is a last-intent-wins navigation lane, not background work. A new click owns a new
      // generation and aborts both reads from the older one, even when it targets the same PR.
      cancelPrReviewResumeRequest();
      const generation = prReviewResumeGeneration;
      const controller = new AbortController();
      const request = { generation, number: prReviewed, controller };
      prReviewResumeRequest = request;
      const sameSession = (): boolean => {
        const current = get();
        return prReviewResumeGeneration === generation
          && prReviewResumeRequest === request
          && !controller.signal.aborted
          && current.prReviewed === prReviewed
          && current.prReviewBaseline === prReviewBaseline
          && current.prReviewRevision === prReviewRevision
          && current.prPreparedHead === prPreparedHead
          && current.prPreparedMergeBase === prPreparedMergeBase
          && current.prPreparedReviewCursor === prPreparedReviewCursor
          && current.prPreparedChangedFiles === prPreparedChangedFiles
          && current.prPreparedHeadSha === prPreparedHeadSha
          && current.prPreparedMergeBaseSha === prPreparedMergeBaseSha;
      };
      const activeBeforeInstall = (): boolean => {
        const current = get();
        return sameSession()
          && current.viewMode === resumeViewMode
          && !reviewSurfaceIsOpen(current);
      };
      const activeAfterInstall = (): boolean => {
        const current = get();
        return sameSession()
          && current.viewMode === "modules"
          && current.prPreparedArtifactCurrent
          && current.review !== null;
      };
      // A normal Code Flow may have been opened on the restored Map after the review overlay soft-
      // closed. It belongs to that Map, not the resumed review/head artifact; clear it before any
      // possible artifact swap so only a flow selected inside the review enters review mode.
      const clearResumeFlow = () => {
        const staleFlowOpen = get().flowSelection !== null;
        invalidateFlowPaneLayout();
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
      let stagedResume: StagedReviewProjection | null = null;
      try {
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
        set({ prReviewStatus: "preparing", prPrepareStage: null, prPrepareElapsedMs: null, prPrepareError: null });
        try {
          if (prPreparedHead !== null && prPreparedMergeBase !== null) {
            const [staged, capability] = await stagePreparedReviewWithCapability(
              prPreparedHead,
              prPreparedMergeBase,
              prPreparedChangedFiles,
              prPreparedReviewCursor,
              {
                repository: prSessionSource?.repository ?? null,
                headSha: prPreparedHeadSha,
              },
              controller.signal,
            );
            stagedResume = staged;
            if (!activeBeforeInstall()) {
              staged.release();
              return; // the review moved on (or resumed elsewhere) while the artifact was in flight.
            }
            if (prReviewSource !== null && prReviewSource.number === prReviewed) {
              set({
                prFiles: canonicalPrFiles(prReviewSource.files, staged.projection.head.artifact),
                prFilesTruncated: false,
                prFilesTotal: prReviewSource.total,
                prFilesOutside: prReviewSource.outside,
                prFilesSuggestedSubdir: prReviewSource.suggestedSubdir,
              });
            }
            // The restored Map stayed interactive during the fetch. Clear once more so a Code Flow opened
            // in that window cannot ride the stale base-artifact ref across the head-graph swap.
            clearResumeFlow();
            resetMinimalProjectionNavigationForRevision();
            swapToPreparedReviewProjection(
              get,
              set,
              staged,
              invalidateArtifactCaches,
              graphProjectionEndpoints(prPreparedHead),
              capability,
            );
          }
          const visibleLayouts: Promise<void>[] = [];
          const resumed = applyPrReviewToMap(
            get,
            set,
            prFilesUrl,
            invalidateMinimalLayout,
            invalidateModuleLayout,
            invalidateRequestFlowWork,
            invalidateArtifactCaches,
            {
              surfaceTransition: "reproject",
              preserveReviewSelection: true,
              beforeVisibleLayout: options?.onVisibleLayoutStart,
              captureVisibleLayout: (layout) => visibleLayouts.push(layout),
            },
          );
          if (!resumed) {
            // A corrupted or mutated retained payload must never leave the prepared HEAD projection
            // active behind a closed overlay; surface an honest retry state instead.
            if (prPreparedHead !== null) {
              await restoreReviewSession({
                endSession: false,
                signal: controller.signal,
                isCurrent: sameSession,
              });
            }
            if (activeBeforeInstall()) {
              set({
                prReviewStatus: "error",
                prPrepareStage: null,
                prPrepareElapsedMs: null,
                prPrepareError: "The retained pull request no longer matches this graph.",
              });
            }
            return;
          }
          if (!activeAfterInstall()) return;
          // Rebuild the reader's lightweight review context, not the entire PR. Each selector
          // invalidates the full pass that applyPrReviewToMap just queued before that pass derives,
          // so a scoped Resume remains cheap even for a repository-wide change.
          const groupLayout = get().selectReviewGroup(resumeGroupId);
          const pathLayout = get().selectReviewPathScope(resumePathScope);
          await Promise.all([...visibleLayouts, groupLayout, pathLayout]);
          if (activeAfterInstall()) {
            set({ prReviewStatus: "idle", prPrepareStage: null, prPrepareElapsedMs: null, prPrepareError: null });
          }
        } catch (error) {
          if (activeBeforeInstall()) {
            set({
              prReviewStatus: "error",
              prPrepareStage: null,
              prPrepareElapsedMs: null,
              prPrepareError: resumeErrorMessage(error),
            });
          }
        }
      } finally {
        stagedResume?.release();
        if (prReviewResumeRequest === request) {
          prReviewResumeRequest = null;
        }
      }
    },

    // Prepare-first entry and refresh: stream resolve/mirror/extract/publish progress, then swap to
    // the prepared HEAD + merge-base projection pair,
    // then run the review so marking, seeds, and line diff all compute in HEAD coordinates. The
    // stale-seq + identity guards drop a canceled entry, PR switch, or PRs-lens exit.
    async prepareHeadGraph(options) {
      const state = get();
      const prNumber = state.prReviewed ?? state.prSelected;
      const enteringFromPrs = state.prReviewed === null;
      const refreshingExistingReview = !enteringFromPrs && state.prReviewRefreshing;
      const summary = selectedPrSummary(state, prNumber);
      // A refresh/manual re-extract can start while an older prepared review is still current.
      // Keep only its projection coordinate. The transport may promote the bounded decoded entry
      // or reload it from disk, but this action must never retain a second artifact/index pair.
      const previousPrepared = !enteringFromPrs
        && state.prPreparedArtifactCurrent
        && state.activeProjectionGraphId !== null
        && state.activeProjectionRequest !== null
        && state.activeProjectionKey !== null
        && state.prPreparedHead !== null
        && state.prPreparedMergeBase !== null
        ? {
            projectionKey: state.activeProjectionKey,
            projectionRequest: state.activeProjectionRequest,
            preparedHead: state.prPreparedHead,
            mergeBase: state.prPreparedMergeBase,
            reviewCursor: state.prPreparedReviewCursor,
            changedFiles: state.prPreparedChangedFiles,
            headSha: state.prPreparedHeadSha,
            mergeBaseSha: state.prPreparedMergeBaseSha,
            syntheticExecutionUrl: state.syntheticExecutionUrl,
            syntheticScenarios: [...state.syntheticScenarios],
            syntheticExecutionTrust: state.syntheticExecutionTrust,
          }
        : null;
      if (
        prNumber === null
        || prepareUrl === null
        || prSessionSource === null
        || summary === null
        || (enteringFromPrs && state.viewMode !== "prs")
      ) {
        return;
      }
      if (!guardReviewLineComposerTransition(() => { void get().prepareHeadGraph(options); })) {
        return;
      }
      cancelPreparedFileProjection();
      // A direct manual re-run supersedes the prior action just like Retry does through
      // reviewPrInGraph; resolve its public waiter while its guarded stream drains.
      prPrepareCancellation?.controller.abort();
      prPrepareCancellation?.resolve();
      const sequence = ++prPrepareSeq;
      let resolveCanceled!: () => void;
      const canceled = new Promise<void>((resolve) => {
        resolveCanceled = resolve;
      });
      const cancellation = { sequence, resolve: resolveCanceled, controller: new AbortController() };
      prPrepareCancellation = cancellation;
      const active = () => {
        const current = get();
        return prPrepareSeq === sequence
          && current.prSelected === prNumber
          && (enteringFromPrs
            ? current.viewMode === "prs" && current.prReviewed === null
            : current.prReviewed === prNumber)
          && (!refreshingExistingReview
            || (current.prReviewRefreshing && current.viewMode === "modules" && reviewSurfaceIsOpen(current)));
      };
      set({
        prReviewStatus: "preparing",
        prPrepareStage: "resolve",
        prPrepareElapsedMs: 0,
        prPrepareError: null,
        ...(previousPrepared === null
          ? {
              prPreparedHead: null,
              prPreparedMergeBase: null,
              prPreparedReviewCursor: null,
              prPreparedFileProjectionPending: null,
              prPreparedFileProjectionError: null,
              prPreparedChangedFiles: [],
              prPreparedHeadSha: null,
              prPreparedMergeBaseSha: null,
              prReviewComparison: null,
              reviewBaseNodeIds: new Set<string>(),
              reviewDeletedNodeIds: new Set<string>(),
              reviewBaseSpanByHeadId: new Map<string, LineRange>(),
            }
          : {}),
        prReviewBlocked: null,
      });
      let swappedNewProjection = false;
      const restorePreviousPrepared = async (): Promise<boolean> => {
        if (previousPrepared === null || projectionDataSource === null) {
          return false;
        }
        try {
          const staged = projectionDataSource.stageCachedReview(previousPrepared.projectionKey)
            ?? await projectionDataSource.stageReviewPair({
              head: {
                request: previousPrepared.projectionRequest,
                endpoints: graphProjectionEndpoints(previousPrepared.preparedHead),
              },
              mergeBase: {
                request: mergeBaseProjectionRequest(previousPrepared.projectionRequest),
                endpoints: graphProjectionEndpoints(previousPrepared.mergeBase),
              },
              signal: cancellation.controller.signal,
          });
          try {
            if (!active()) return false;
            resetMinimalProjectionNavigationForRevision();
            invalidateSyntheticArtifactBoundary();
            swapToPreparedReviewProjection(
              get,
              set,
              staged,
              invalidateArtifactCaches,
              graphProjectionEndpoints(previousPrepared.preparedHead),
              {
                syntheticExecutionUrl: previousPrepared.syntheticExecutionUrl,
                syntheticScenarios: previousPrepared.syntheticScenarios,
                syntheticExecutionTrust: previousPrepared.syntheticExecutionTrust,
              },
              {
                prPreparedHead: previousPrepared.preparedHead,
                prPreparedMergeBase: previousPrepared.mergeBase,
                prPreparedReviewCursor: previousPrepared.reviewCursor,
                prPreparedFileProjectionPending: null,
                prPreparedFileProjectionError: null,
                prPreparedChangedFiles: previousPrepared.changedFiles,
                prPreparedHeadSha: previousPrepared.headSha,
                prPreparedMergeBaseSha: previousPrepared.mergeBaseSha,
                prReviewBlocked: null,
              },
            );
            return true;
          } finally {
            staged.release();
          }
        } catch {
          return false;
        }
      };
      const work = (async () => {
        let stagedPrepared: StagedReviewProjection | null = null;
        try {
          const request = prPrepareRequest(prSessionSource, summary);
          const analysis = await streamPrPreparation(prepareUrl, request, (stage, elapsedMs) => {
            if (active()) {
              set({ prPrepareStage: stage, prPrepareElapsedMs: elapsedMs });
            }
          }, cancellation.controller.signal);
          if (!active()) {
            return;
          }
          // SWAP: load the prepared PR-head projection and make it CURRENT before the review
          // body runs, so amber marking, seeds, and the line diff compute in HEAD coordinates.
          const preservedReviewPath = previousPrepared === null
            ? null
            : remapPreparedReviewFilePath(
                previousPrepared.changedFiles,
                previousPrepared.reviewCursor,
                analysis.changedFiles,
              );
          const reviewCursor = preparedReviewFileCursor(
            analysis.changedFiles,
            preservedReviewPath ?? undefined,
          );
          const [staged, capability] = await stagePreparedReviewWithCapability(
            analysis.head,
            analysis.mergeBase,
            analysis.changedFiles,
            reviewCursor,
            {
              repository: prSessionSource.repository,
              headSha: analysis.headSha,
            },
            cancellation.controller.signal,
          );
          stagedPrepared = staged;
          if (!active()) {
            staged.release();
            return;
          }
          const prepared = staged.projection;
          const canonicalFiles = canonicalPreparedPrFiles(
            get().prFiles ?? [],
            analysis.changedFiles,
            prepared.head.artifact,
          );
          resetMinimalProjectionNavigationForRevision();
          invalidateSyntheticArtifactBoundary();
          swapToPreparedReviewProjection(
            get,
            set,
            staged,
            invalidateArtifactCaches,
            graphProjectionEndpoints(analysis.head),
            capability,
            {
              prReviewStatus: "idle",
              prPrepareStage: null,
              prPrepareElapsedMs: null,
              prPrepareError: null,
              prPreparedHead: analysis.head,
              prPreparedMergeBase: analysis.mergeBase,
              prPreparedReviewCursor: reviewCursor,
              prPreparedFileProjectionPending: null,
              prPreparedFileProjectionError: null,
              prPreparedChangedFiles: [...analysis.changedFiles],
              prPreparedHeadSha: analysis.headSha,
              prPreparedMergeBaseSha: analysis.mergeBaseSha,
              prFiles: canonicalFiles,
              prFilesTruncated: false,
              prFilesTotal: Math.max(get().prFilesTotal, canonicalFiles.length + get().prFilesOutside),
            },
          );
          swappedNewProjection = true;
          const visibleLayouts: Promise<void>[] = [];
          const entered = applyPrReviewToMap(get, set, prFilesUrl, invalidateMinimalLayout, invalidateModuleLayout, invalidateRequestFlowWork, invalidateArtifactCaches, {
            surfaceTransition: enteringFromPrs ? "entry" : "replace",
            preserveReviewDiffOnly: !enteringFromPrs,
            beforeVisibleLayout: options?.onVisibleLayoutStart,
            captureVisibleLayout: (layout) => visibleLayouts.push(layout),
          });
          if (!entered) {
            // The zero-match decision was made against HEAD. Do not leak that unreviewed prepared
            // graph behind the PRs page (or replace an explicit base fallback that still matches).
            if (!await restorePreviousPrepared()) {
              await restoreReviewSession({ endSession: enteringFromPrs });
            }
            if (!enteringFromPrs && previousPrepared === null) {
              set({
                prPreparedHead: null,
                prPreparedMergeBase: null,
                prPreparedReviewCursor: null,
                prPreparedFileProjectionPending: null,
                prPreparedFileProjectionError: null,
                prPreparedChangedFiles: [],
                prPreparedHeadSha: null,
                prPreparedMergeBaseSha: null,
                prReviewComparison: null,
                reviewBaseNodeIds: new Set<string>(),
                reviewDeletedNodeIds: new Set<string>(),
                reviewBaseSpanByHeadId: new Map<string, LineRange>(),
              });
            }
            if (get().prReviewRefreshing) {
              set({
                prReviewStatus: "error",
                prPrepareStage: null,
                prPrepareElapsedMs: null,
                prPrepareError: "The refreshed pull request no longer matches this graph.",
              });
            }
          } else {
            await Promise.all(visibleLayouts);
          }
        } catch (error) {
          if (active()) {
            // Derivation after a successful fetch is still part of preparation. If it throws after
            // the swap, put the prior graph back before exposing the retry state.
            if (swappedNewProjection && !await restorePreviousPrepared()) {
              await restoreReviewSession({ endSession: enteringFromPrs });
              if (!enteringFromPrs && previousPrepared === null) {
                set({
                  prPreparedHead: null,
                  prPreparedMergeBase: null,
                  prPreparedReviewCursor: null,
                  prPreparedFileProjectionPending: null,
                  prPreparedFileProjectionError: null,
                  prPreparedChangedFiles: [],
                  prPreparedHeadSha: null,
                  prPreparedMergeBaseSha: null,
                  prReviewComparison: null,
                  reviewBaseNodeIds: new Set<string>(),
                  reviewDeletedNodeIds: new Set<string>(),
                  reviewBaseSpanByHeadId: new Map<string, LineRange>(),
                });
              }
            }
            set({
              prReviewStatus: "error",
              prPrepareStage: null,
              prPrepareElapsedMs: null,
              prPrepareError: prepareErrorMessage(error),
            });
          }
        } finally {
          stagedPrepared?.release();
        }
      })();
      try {
        // Cancel resolves the public action immediately and aborts the HTTP subscription. The
        // server keeps a shared job alive only when another subscriber is still interested.
        await Promise.race([work, canceled]);
      } finally {
        if (prPrepareCancellation === cancellation) {
          prPrepareCancellation = null;
        }
      }
    },

    cancelPrReviewPreparation() {
      prPrepareSeq += 1;
      cancelPreparedFileProjection();
      cancelPrReviewResumeRequest();
      preparedReviewRestoreController?.abort();
      preparedReviewRestoreController = null;
      const cancellation = prPrepareCancellation;
      prPrepareCancellation = null;
      cancellation?.controller.abort();
      cancellation?.resolve();
      set({ prReviewStatus: "idle", prPrepareStage: null, prPrepareElapsedMs: null, prPrepareError: null });
    },

    dismissPrepareError() {
      set({ prReviewStatus: "idle", prPrepareStage: null, prPrepareElapsedMs: null, prPrepareError: null });
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
 * Extracted from the store so direct preparation and cached resume share one derivation path.
 */
function applyPrReviewToMap(
  get: () => BlueprintState,
  set: (partial: Partial<BlueprintState>) => void,
  prFilesUrl: string,
  invalidateMinimalLayout: () => void,
  invalidateModuleLayout: () => void,
  invalidateRequestFlowWork: () => void,
  invalidateArtifactCaches: () => void,
  options: {
    surfaceTransition?: "entry" | "replace" | "reproject";
    preserveReviewSelection?: boolean;
    preserveReviewDiffOnly?: boolean;
    beforeVisibleLayout?: () => void;
    captureVisibleLayout?: (layout: Promise<void>) => void;
  } = {},
): boolean {
  const surfaceTransition = options.surfaceTransition ?? "entry";
  const reprojecting = surfaceTransition === "reproject";
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
  if (
    prSelected === null
    || prFiles === null
    || !prPreparedArtifactCurrent
    || prReviewComparison === null
  ) {
    return false;
  }
  // Tests reprojection and refresh can re-enter while the presentation composite is current. Strip
  // its prior base-only overlay first so every pass starts from one pure HEAD coordinate space and
  // cannot duplicate tombstones or let their old spans influence HEAD affected-node derivation.
  const headArtifact = activeBaseNodeIds.size > 0
    ? { ...activeArtifact, nodes: activeArtifact.nodes.filter((node) => !activeBaseNodeIds.has(node.id)) }
    : activeArtifact;
  const headIndex = headArtifact === activeArtifact
    ? activeIndex
    : buildGraphIndex(
        headArtifact,
        graphIndexMetadataWithoutPresentationNodes(activeIndex, activeBaseNodeIds),
      );
  // Direct preparation installs its canonical, status-rich done manifest into `prFiles` before the
  // projection swap. A projection-local extension is only a slice and must never define PR
  // completeness, even when it happens to mention every currently requested path.
  const reviewPrFiles = prFiles;
  const reviewFilesTotal = Math.max(prFilesTotal, reviewPrFiles.length + prFilesOutside);
  const summary = selectedPrSummary(get());
  const context = reviewContextFromPrFiles(
    {
      prNumber: prSelected,
      headRef: summary?.headRef ?? null,
      baseRef: summary?.baseRef ?? null,
      scopeId: prFilesUrl,
      files: reviewPrFiles,
    },
    { baseSide: false },
  );
  // A refresh re-enters this same reviewKey. Carry the in-memory progress directly so drafts made
  // while persistence is unavailable (or while the refresh request is in flight) cannot disappear.
  const liveProgress = liveReview?.context.reviewKey === context.reviewKey
    || (reprojecting && get().prReviewed === prSelected)
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
    baseIndex: prReviewComparison.index,
    // Causal-flow discovery is two-sided too: base-only flows come from the exact immutable
    // comparison descriptor, never from whichever base tip happened to boot the renderer.
    baseArtifact: prReviewComparison.artifact,
    showTests: get().showTests,
  });
  const { review, visibleContext } = projection;
  const reviewedHeadArtifact = headArtifact;
  const deletedProjection: DeletedNodeProjection = deriveDeletedNodeProjection({
    headArtifact: reviewedHeadArtifact,
    headIndex,
    baseArtifact: prReviewComparison.artifact,
    baseIndex: prReviewComparison.index,
    // Compose the COMPLETE PR before the Tests filter. An all-test deletion still needs a
    // hidden workspace sentinel so the review opens and the Tests toggle can reveal it.
    context,
    prFiles: reviewPrFiles,
  });
  const artifact = deletedProjection.artifact;
  const index = deletedProjection.index;
  const visiblePaths = new Set(visibleContext.changedFiles.map((file) => file.path));
  const visibleDeletedFiles = deletedProjection.files.filter((file) => visiblePaths.has(file.path));
  const headAffected = preparedHeadAffected(
    visibleContext,
    reviewPrFiles,
    reviewedHeadArtifact,
    headIndex,
    deletedProjection.survivingAffectedHeadIds,
  );
  const deletedAffected = visibleDeletedFiles.flatMap((file) => file.affected);
  const affected = mergeAffectedNodes(headAffected, deletedAffected);
  const files = mergeDeletedReviewFiles(projection.files, headAffected, visibleDeletedFiles, index);

  // Page/selection facts are complete even when this one current coordinate has no graph node.
  // Keep that source-less review mounted with an empty canvas; selecting a manifest entry lazily
  // swaps only that file's two-sided slice instead of treating a bounded view as whole-PR evidence.
  const allMatchedFiles = matchAffectedFiles(index, context.changedFiles.map((file) => file.path)).matched;
  const allRollup = rollupSeeds(allMatchedFiles, index);
  // Entering the review is a lens transition; replacing a mounted review is an atomic revision
  // transaction and must not soft-close it back to the boot graph. Same-revision reprojection is
  // separate again because it preserves drafts, revision identity, and local review controls.
  if (surfaceTransition === "entry") {
    if (!beginLensTransition(get, set, invalidateRequestFlowWork)) {
      return false;
    }
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
    prReviewComparison.index,
    deletedProjection,
  );
  const reviewDiffLinesByFile: Record<string, ChangedDiffLine[]> = {};
  const canonicalDiffLines = changedDiffLinesFromExtensions(reviewedHeadArtifact.extensions);
  for (const binding of fileBindings) {
    const rows = valueForReviewAliases(canonicalDiffLines, binding.aliases)
      ?? (binding.file.diffComplete !== false ? binding.file.diffLines : undefined);
    if (!rows || rows.length === 0) continue;
    for (const locFile of binding.aliases) reviewDiffLinesByFile[locFile] = rows;
  }
  const nodeStatusSources = reviewNodeStatusSourcesFromDiff(
    changedLineKindsFromExtensions(reviewedHeadArtifact.extensions),
    changedDiffLinesFromExtensions(reviewedHeadArtifact.extensions),
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
  const changeGroups = computeChangeGroups(artifact.nodes, artifact.edges, visibleContext.changedFiles, review.flows);
  // GitHub's whole-file +N/-M churn per changed file, keyed by node.location.file, for the marker a
  // changed FILE card shows before its name (files aren't coloured; only their touched blocks are).
  const artifactStats = changedLineStatsFromExtensions(reviewedHeadArtifact.extensions);
  const reviewFileDelta: Record<string, { added: number; deleted: number; status?: PrFileStatus }> = {};
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
  // The prepared projection's own merge-base diff is the sole line-level authority.
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
  // Comment ranges remain GitHub-API metadata; source and line ownership come only from the
  // immutable prepared descriptors and their canonical diff extension.
  const reviewCommentRangesByFile: Record<string, LineRange[]> = {};
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
  // Removed text is parsed from GitHub's patch in HEAD coordinates. Join through the same matched
  // module path so the code panel can look it up with node.location.file.
  const reviewRemovedByFile: Record<string, { afterNewLine: number; lines: string[] }[]> = {};
  const reviewRemovedTruncatedByFile: Record<string, boolean> = {};
  for (const binding of fileBindings) {
    const prFile = binding.file;
    if ((prFile.removed?.length ?? 0) > 0) {
      for (const locFile of binding.aliases) reviewRemovedByFile[locFile] = prFile.removed ?? [];
    }
    if (prFile.removedTruncated === true) {
      for (const locFile of binding.aliases) reviewRemovedTruncatedByFile[locFile] = true;
    }
  }
  const progress = liveProgress ?? readReviewProgress(context.reviewKey);
  const currentSelection = get();
  const loadedRevision = reprojecting
    ? currentSelection.prReviewRevision
    : summary === null ? null : reviewRevision(summary, prPreparedHeadSha);
  const reviewComments = reconcileReviewLineAnchors(progress.comments, loadedRevision);
  const lineAnchorsInvalidated = reviewComments !== progress.comments;
  const revisionMismatch = reprojecting
    ? currentSelection.prReviewStale
    : loadedRevision !== null && summary !== null && isPrReviewStale(loadedRevision, summary);
  const visibleSelectionId = (id: string | null) => id !== null && (currentSelection.showTests || !index.testIds.has(id));
  const preservedModuleSelection = options.preserveReviewSelection
    ? new Set([...currentSelection.moduleSelected].filter((id) => currentSelection.showTests || !index.testIds.has(id)))
    : new Set<string>();
  const preservedReviewLitIds = options.preserveReviewSelection && currentSelection.reviewLitNodeIds !== null
    ? new Set([...currentSelection.reviewLitNodeIds].filter((id) => currentSelection.showTests || !index.testIds.has(id)))
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
    prPreparedArtifactCurrent: true,
    review,
    prReviewBlocked: null,
    prReviewed: prSelected,
    prReviewSource: {
      number: prSelected,
      files: reviewPrFiles,
      // The direct-prepare name-status manifest is complete for this extraction root.
      truncated: false,
      total: reviewFilesTotal,
      outside: prFilesOutside,
      suggestedSubdir: get().prFilesSuggestedSubdir,
    },
    prReviewRevision: loadedRevision,
    // If the head moved during a long extraction, its exact prepared SHA and the earlier summary/file
    // snapshot disagree. Surface Refresh immediately instead of pretending those mixed inputs match.
    prReviewStale: revisionMismatch,
    // Prepared projections and their immutable source descriptor are already HEAD-relative.
    reviewHeadRef: null,
    reviewDiffByFile: {},
    reviewDiffLinesByFile,
    reviewBaseNodeIds: deletedProjection.baseSourceNodeIds,
    reviewDeletedNodeIds: deletedProjection.deletedNodeIds,
    reviewBaseSpanByHeadId: deletedProjection.baseSpanByHeadId,
    reviewCommentRangesByFile,
    reviewRemovedByFile,
    reviewRemovedTruncatedByFile,
    reviewTicks: progress.ticks,
    reviewUnitTicks: progress.unitTicks,
    reviewFileTicks: progress.fileTicks,
    reviewComments,
    reviewPanelHidden: reprojecting ? currentSelection.reviewPanelHidden : false,
    // A Tests toggle can happen while a review POST is in flight. Reprojection must not disarm the
    // duplicate-submit guard or erase its outcome banners; fresh review entry still resets them.
    reviewSubmitStatus: reprojecting ? currentSelection.reviewSubmitStatus : "idle",
    reviewSubmitError: reprojecting ? currentSelection.reviewSubmitError : null,
    reviewSubmitNotice: reprojecting ? currentSelection.reviewSubmitNotice : null,
    reviewSubmittedUrl: reprojecting ? currentSelection.reviewSubmittedUrl : null,
    reviewAffectedIds: new Set(affected.map((node) => node.nodeId)),
    reviewDiffOnly: reprojecting || options.preserveReviewDiffOnly
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
    minimalShowGhostNodes: true,
    minimalCodebaseExpansionOverrides: new Map<string, boolean>(),
    minimalCodebaseTargetIds: [],
    minimalCodebaseRetainedExpandedIds: new Set<string>(),
    minimalCodebaseProjectionPending: false,
    minimalProjectionExtraIds: reprojecting
      ? new Set(currentSelection.minimalProjectionExtraIds)
      : new Set<string>(),
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
  if (lineAnchorsInvalidated) {
    // The stable reviewKey intentionally carries drafts across pushes. Persist the invalidated
    // anchor marker with them so a reload cannot make an old numeric line look current again.
    persistReviewProgress(get());
  }
  // Only the visible review graph is laid out. The underlying Map is intentionally absent until
  // closeMinimalGraph restores the base artifact and schedules one current-state source layout.
  options.beforeVisibleLayout?.();
  const visibleLayout = visibleSeeds.length > 0
    ? get().minimalRelayout({ label: "Preparing review graph…" })
    : Promise.resolve();
  if (options.captureVisibleLayout) options.captureVisibleLayout(visibleLayout);
  else void visibleLayout;
  return true;
}

/** Join exact local diff detail onto the prepare stream's COMPLETE name-status inventory. The
 * stream controls membership/status/rename identity; projection extensions contribute detail only
 * and a missing exact body fails closed instead of promoting GitHub's possibly truncated patch. */
function canonicalPreparedPrFiles(
  githubFiles: readonly PrChangedFile[],
  manifest: readonly PreparedChangedFile[],
  headArtifact: GraphArtifact,
): PrChangedFile[] {
  const exactDetail = new Map(
    canonicalPrFiles(githubFiles, headArtifact)
      .map((file) => [normalizeReviewFilePath(file.path), file] as const),
  );
  const githubDetail = new Map(
    githubFiles.map((file) => [normalizeReviewFilePath(file.path), file] as const),
  );
  return manifest.map((entry) => {
    const key = normalizeReviewFilePath(entry.path);
    const exact = exactDetail.get(key);
    const fallback = githubDetail.get(key);
    const file: PrChangedFile = {
      ...(exact ?? fallback ?? {}),
      path: entry.path,
      status: entry.status === "deleted" ? "removed" : entry.status,
      additions: exact?.additions ?? fallback?.additions ?? 0,
      deletions: exact?.deletions ?? fallback?.deletions ?? 0,
      diffComplete: exact?.diffComplete === true,
    };
    if (entry.status === "renamed") {
      if (entry.previousPath === undefined) {
        throw new Error("prepared rename is missing its previous path");
      }
      file.previousPath = entry.previousPath;
    } else {
      delete file.previousPath;
    }
    return file;
  });
}

/** Reconstitute the immutable prepare inventory from the canonical files already installed for an
 * active review. A malformed rename must not let a late GitHub response replace that inventory. */
function preparedManifestFromCanonicalFiles(
  files: readonly PrChangedFile[],
): PreparedChangedFile[] | null {
  const manifest: PreparedChangedFile[] = [];
  for (const file of files) {
    const status = file.status === "removed" ? "deleted" : file.status;
    if (status === "renamed") {
      if (file.previousPath === undefined) return null;
      manifest.push({ path: file.path, status, previousPath: file.previousPath });
    } else {
      manifest.push({ path: file.path, status });
    }
  }
  return manifest;
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
  const rawByPath = new Map(prFiles.map((file) => [normalizeReviewFilePath(file.path), file]));
  const statusByCanonicalFile = new Map<string, AffectedNode["status"]>();
  const changedFiles = context.changedFiles.map((changed) => {
    const match = matchAffectedFiles(index, [changed.path]).matched[0];
    const canonicalPath = match === undefined
      ? changed.path
      : index.nodesById.get(match.moduleId)?.location.file ?? changed.path;
    statusByCanonicalFile.set(canonicalPath, changed.status);
    const aliases = new Set([changed.path, canonicalPath]);
    const raw = rawByPath.get(normalizeReviewFilePath(changed.path));
    const canonicalKinds = valueForReviewAliases(kindsByFile, aliases);
    const canonicalStats = valueForReviewAliases(statsByFile, aliases);
    const exactKinds = canonicalKinds
      ?? (raw?.diffComplete === true ? raw.kinds ?? [] : undefined);
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

/** Resolve each PR file once against both revisions. Every diff/delta/source/comment map consumes
 * these bindings so removed files cannot disappear merely because one call site joined HEAD only. */
function bindReviewFiles(
  files: readonly PrChangedFile[],
  headIndex: GraphIndex,
  baseIndex: GraphIndex | null,
  deleted: DeletedNodeProjection,
): BoundReviewFile[] {
  const deletedByPath = new Map(deleted.files.map((file) => [normalizeReviewFilePath(file.path), file]));
  return files.map((file) => {
    const aliases = new Set<string>([file.path, normalizeReviewFilePath(file.path)]);
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
    const projected = deletedByPath.get(normalizeReviewFilePath(file.path));
    if (projected) aliases.add(projected.basePath);
    return { file, aliases, headFiles };
  });
}

/** Exact key first, then one unambiguous slash-boundary suffix alias. The latter mirrors graph file
 * matching for extraction subfolders without guessing between duplicated monorepo tails. */
function valueForReviewAliases<T>(
  record: Readonly<Record<string, T>> | null,
  aliases: ReadonlySet<string>,
): T | undefined {
  if (record === null) return undefined;
  const normalizedAliases = new Set([...aliases].map(normalizeReviewFilePath));
  for (const [key, value] of Object.entries(record)) {
    if (normalizedAliases.has(normalizeReviewFilePath(key))) return value;
  }
  let bestLength = 0;
  let winner: T | undefined;
  let ambiguous = false;
  for (const [key, value] of Object.entries(record)) {
    const normalizedKey = normalizeReviewFilePath(key);
    for (const alias of normalizedAliases) {
      const length = normalizedKey.endsWith(`/${alias}`)
        ? alias.length
        : alias.endsWith(`/${normalizedKey}`) ? normalizedKey.length : 0;
      if (length > bestLength) {
        bestLength = length;
        winner = value;
        ambiguous = false;
      } else if (length > 0 && length === bestLength && winner !== value) {
        ambiguous = true;
      }
    }
  }
  return bestLength > 0 && !ambiguous ? winner : undefined;
}

function normalizeReviewFilePath(path: string): string {
  let normalized = path.replace(/\\/g, "/");
  while (normalized.startsWith("./")) normalized = normalized.slice(2);
  return normalized;
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

/** One explicit owner routes every module-family action and layout. A prepared review can be open
 * before any file projection exists; that overview owns the shell, but it is not an extracted graph
 * and must never route actions into the parked source artifact underneath it. */
export function moduleGraphSurfaceOwner(
  state: Pick<BlueprintState, "review" | "prReviewed" | "minimalSeedIds">,
): ModuleGraphSurfaceOwner {
  if (state.minimalSeedIds.length > 0) return "extracted";
  if (state.review !== null && state.prReviewed !== null) return "prepared-review-overview";
  return "source";
}

/** True only when a review actually owns the visible graph shell. Artifact reviews require an
 * extracted graph; prepared reviews additionally own their honest, zero-file overview. */
export function reviewSurfaceIsOpen(
  state: Pick<BlueprintState, "review" | "prReviewed" | "minimalSeedIds">,
): boolean {
  return state.review !== null && moduleGraphSurfaceOwner(state) !== "source";
}

/** Whether the source scene is covered by either an extracted graph or a prepared review overview. */
export function moduleGraphOverlayIsOpen(
  state: Pick<BlueprintState, "review" | "prReviewed" | "minimalSeedIds">,
): boolean {
  return moduleGraphSurfaceOwner(state) !== "source";
}

/** The selected PR's summary row (its refs feed the direct prepare request); null when unavailable.
 * An explicit number lets URL restoration resolve a row before selecting it. */
export function selectedPrSummary(state: BlueprintState, number: number | null = state.prSelected): PrSummary | null {
  if (number === null) {
    return null;
  }
  const { prsList, prExtraSummaries } = state;
  return [...(prsList.open ?? []), ...(prsList.closed ?? [])].find((pr) => pr.number === number) ?? prExtraSummaries[number] ?? null;
}

/** End either a prepared or explicit base review without retaining another graph pair. */
async function restoreSelectedPrReview(
  get: () => BlueprintState,
  restore: (options?: { endSession?: boolean }) => boolean | Promise<boolean>,
): Promise<boolean> {
  return get().prReviewed !== null && await restore();
}

function prepareErrorMessage(error: unknown): string {
  return error instanceof Error && error.message.length > 0 ? error.message : "PR analysis failed.";
}

function splitGitHubRepository(repository: string): { owner: string; repo: string } {
  const [owner, repo, extra] = repository.split("/");
  if (owner === undefined || owner.length === 0
    || repo === undefined || repo.length === 0
    || extra !== undefined) {
    throw new Error("invalid GitHub repository identity in renderer boot configuration");
  }
  return { owner, repo };
}

/** One request builder owns both in-place review entry and broader-root handoff navigation. */
function prPrepareRequest(
  source: PrSessionSource,
  summary: PrSummary,
  subdir: string = source.subdir,
): PrPrepareRequest {
  return {
    ...splitGitHubRepository(source.repository),
    ...(subdir.length > 0 ? { subdir } : {}),
    prNumber: summary.number,
    baseRef: summary.baseRef,
    headRef: summary.headRef,
  };
}

function assertPreparedReviewHandoffIdentity(
  handoff: PreparedReviewHandoff,
  number: number,
  summary: PrSummary,
  source: PrSessionSource | null,
  bootGraphId: string | null,
): void {
  if (source === null) throw new Error("prepared review handoff has no GitHub session identity");
  const repository = splitGitHubRepository(source.repository);
  const expectedSubdir = source.subdir.length > 0 ? source.subdir : undefined;
  if (
    handoff.request.owner !== repository.owner
    || handoff.request.repo !== repository.repo
    || handoff.request.subdir !== expectedSubdir
    || handoff.request.prNumber !== number
    || summary.number !== number
    || handoff.request.baseRef !== summary.baseRef
    || handoff.request.headRef !== summary.headRef
    || summary.headSha !== handoff.headSha
  ) {
    throw new Error("prepared review handoff does not match the requested pull request");
  }
  if (bootGraphId === null || handoff.head.graphId !== bootGraphId) {
    throw new Error("prepared review HEAD descriptor does not match the boot graph");
  }
  assertDescriptorEndpointsBound(handoff.head);
  assertDescriptorEndpointsBound(handoff.mergeBase);
}

function assertDescriptorEndpointsBound(descriptor: PreparedGraphDescriptor): void {
  const origin = requestOrigin();
  for (const endpoint of [
    descriptor.manifestUrl,
    descriptor.projectionUrl,
    descriptor.searchUrl,
    descriptor.sourceUrl,
    descriptor.metaUrl,
  ]) {
    const parsed = new URL(endpoint, origin);
    if (parsed.origin !== origin || parsed.searchParams.get("id") !== descriptor.graphId) {
      throw new Error("prepared review descriptor endpoint does not match its graph identity");
    }
  }
}

function preparedHandoffErrorMessage(error: unknown): string {
  const detail = error instanceof Error && error.message.trim().length > 0
    ? ` ${error.message}`
    : "";
  return `Could not restore the prepared pull request.${detail}`;
}

/** Route an in-place expansion relayout to whichever module surface is showing: the minimal-graph
 * overlay when it is open (it shares the one `moduleExpanded` id space), else the Module map beneath.
 * Relaying out the covered Map instead would be work the reader can't see. */
function relayoutActiveModuleSurface(get: () => BlueprintState, activity?: LayoutActivity): Promise<void> {
  const owner = moduleGraphSurfaceOwner(get());
  return owner === "extracted"
    ? get().minimalRelayout(activity)
    : owner === "source"
      ? get().moduleRelayout(activity)
      : Promise.resolve();
}

type ReleasedModuleScene = Pick<
  BlueprintState,
  | "moduleRfNodes"
  | "moduleRfEdges"
  | "moduleSemanticLayers"
  | "moduleEffectiveFocus"
  | "moduleLayoutStatus"
  | "moduleLayoutActivity"
>;

/** Drop only derived React Flow data; canonical navigation/selection remains available to rebuild. */
function releasedModuleScene(): ReleasedModuleScene {
  return {
    moduleRfNodes: [],
    moduleRfEdges: [],
    moduleSemanticLayers: [],
    moduleEffectiveFocus: null,
    moduleLayoutStatus: "idle",
    moduleLayoutActivity: null,
  };
}

type ReleasedLogicScene = Pick<
  BlueprintState,
  "logicRfNodes" | "logicRfEdges" | "logicLayoutStatus" | "logicLayoutActivity"
>;

/** The logic root/trails remain canonical; these ELK/React Flow arrays are safe to re-derive. */
function releasedLogicScene(): ReleasedLogicScene {
  return {
    logicRfNodes: [],
    logicRfEdges: [],
    logicLayoutStatus: "idle",
    logicLayoutActivity: null,
  };
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
  invalidateRequestFlowWork: () => void,
  retry?: () => void,
): boolean {
  // Most lens entries route through setViewMode, but direct pivots (openLogicFlow,
  // openComposition, openServiceScope) call this helper themselves. They must abandon either the
  // prepare-first lane or a parked-review Resume before changing view. Successful prepared entry
  // sets the lane idle before it calls this helper, so its own PRs → Map transition is not canceled.
  if (get().prReviewStatus === "preparing") {
    get().cancelPrReviewPreparation();
  }
  if (moduleGraphOverlayIsOpen(get())) {
    const close = get().closeMinimalGraph();
    if (moduleGraphOverlayIsOpen(get())) {
      // An evicted/oversized review baseline reloads asynchronously. Do not let the requested lens
      // expose HEAD underneath the overlay; replay the complete public action only after close has
      // installed the baseline and cleared the overlay. A failed restore leaves its surface owner
      // intact and therefore deliberately does not replay.
      if (retry !== undefined) {
        void close.then(() => {
          if (!moduleGraphOverlayIsOpen(get())) retry();
        });
      }
      return false;
    }
  }
  const state = get();
  // Ghost-path inspection belongs to the exact current projection. A real lens transition leaves
  // it behind; ordinary paint/layout toggles never route through this helper and therefore retain it.
  if (state.moduleGhostInspection !== null) {
    set({ moduleGhostInspection: null });
  }
  if (state.flowPaneOrigin === "request") {
    invalidateRequestFlowWork();
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

function rollupsRecord(rolledUp: ReadonlyMap<string, string[]>): Record<string, string[]> {
  return Object.fromEntries([...rolledUp].map(([packageId, fileIds]) => [packageId, [...fileIds]]));
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
      if (ancestor.kind === "module" || UNIT_CARD_KINDS.has(ancestor.kind)) {
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
  const homeFiles = new Set(nearestModuleIds([...related], state.index));
  let minimalSeedIds = [...baseSeedIds];
  let minimalMemberIds = [...baseMemberIds];
  for (const [packageId, fileIds] of Object.entries(state.minimalRollups)) {
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
    if (ancestors[i].kind === "module") {
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
  if (index.nodesById.get(member)?.kind === "module") {
    return [member];
  }
  return index
    .childrenOf(member)
    .filter((child) => child.kind === "module")
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
  const surfaceOwner = moduleGraphSurfaceOwner(state);
  if (surfaceOwner === "prepared-review-overview") return;
  // A registered module surface (Map/Service/UI) shares one frontier read + expansion set; the
  // strict registry returns null for the logic lens, which keeps its own branch below.
  if (moduleSurfaceSpec(state.viewMode) !== null) {
    const scope = state.moduleSelected.size ? [...state.moduleSelected] : [null];
    // The minimal graph covers the registered lens while it is open. Its laid nodes are therefore
    // the authoritative visible frontier for the canvas action bar; deriving the covered lens here
    // would expand/collapse containers the user cannot see.
    const visible = surfaceOwner === "extracted"
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
    && reviewSurfaceIsOpen(state);
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
    version: 2,
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
