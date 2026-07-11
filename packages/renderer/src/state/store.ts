/**
 * The single zustand store. `moduleExpanded` starts EMPTY so only roots show (progressive
 * disclosure begins at the package/system level), and `environment` starts null and is NEVER
 * auto-set or defaulted to prod. Every structural mutation bumps its surface's layout sequence and
 * re-runs the derive pipeline behind a stale guard so a slow ELK pass can never overwrite a newer one.
 */

import { createStore, type StoreApi } from "zustand/vanilla";
import type { Edge, Node } from "@xyflow/react";
import { changedLineKindsFromExtensions, changedRangesFromExtensions, computeAffectedNodes, computeChangeGroups, computeCoverage, type ChangeStatus } from "@meridian/core";
import type {
  ChangedLineKind,
  ChangedLineSpan,
  ChangeGroupsResult,
  CoverageReport,
  FlowPath,
  FlowStep,
  GraphArtifact,
  GraphNode,
  LogicFlows,
  NodeId,
  NodeMetrics,
} from "@meridian/core";
import { applyChangedIds, applyChangedStatus, type GraphIndex } from "../graph/graphIndex";
import { matchAffectedFiles } from "../derive/matchAffectedFiles";
import { rollupSeeds } from "../derive/seedRollup";
import { filesInScope } from "../derive/filesInScope";
import type { TelemetryProvider } from "../telemetry/provider";
import type { ViewMode } from "../derive/edgeSelection";
import { relatedNodeIds, type FlowSelectionRef } from "../derive/flowBlocks";
import { idsToExpand, idsToCollapse, type ExpandableNode } from "../derive/scopedExpansion";
import type { LogicViewMode } from "../derive/flowViewModel";
import { deriveLogicLayout } from "./deriveLogicLayout";
import { deriveFlowPaneLayout } from "./deriveFlowPaneLayout";
import { layoutModuleTree } from "../layout/moduleLevelLayout";
import { deriveMinimalGraphLayout } from "./deriveMinimalGraphLayout";
import { captureMapPositions, promotedMemberRect } from "./mapPositions";
import type { PlacedRect } from "../layout/minimalPlacement";
import { buildModuleGraph, type ModuleGraph } from "../derive/moduleGraph";
import { buildBlockDeps, UNIT_CARD_KINDS, type BlockDeps } from "../derive/blockDeps";
import type { GhostData } from "../derive/ghostDeps";
import { buildUnitIndex, type UnitIndex } from "@meridian/design-metrics";
import type { VisibleModuleNode } from "../derive/moduleTree";
import { moduleChildContainerIds } from "../derive/moduleChildContainers";
import { serviceScopeFor, widenServiceScope, type ServiceScope } from "./serviceScope";
import { expandServiceSyntheticAnchors, leadIdOf } from "../derive/serviceClusterEdges";
import { clusteringFor } from "../derive/serviceClusteringCache";
import { deriveServiceDomains, isServiceDomainId } from "../derive/serviceDomains";
import { SERVICE_GROUPING_OPTIONS, type ServiceGroupingMode } from "../derive/serviceClusteringModes";
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
import { moduleRevealStateFor, nearestModuleIds } from "./flowExplorer";
import {
  anchorNodeIds,
  mapRevealStateForMany,
  resolveServiceAnchors,
  serviceRevealStateForMany,
  uiRevealStateForMany,
} from "./lensPath";
import type { LogicRfNode, LogicRfEdge } from "../layout/logicElk";
import {
  PRS_UNAVAILABLE_ERROR,
  type LineEdit,
  type PrChangedFile,
  type PrChecks,
  type PrDiscussionResult,
  type PrFilesResponse,
  type PrFileStatus,
  type PrListResponse,
  type PrOneResponse,
  type PrSessionSource,
  type PrSummary,
  type PrsTab,
  type RelatedPrsResponse,
  type RelatedPrsState,
} from "./prTypes";
import { headKindsWithin, headSpanFor } from "./headSpan";
import { streamPrAnalysis, type PrAnalyzeStage } from "./prAnalysis";
import {
  fetchPreparedArtifact,
  resetChangedIdsToArtifact,
  restorePrReviewBaseline,
  swapToPreparedArtifact,
  withPrLineDiff,
  type PrReviewBaseline,
} from "./prReviewSession";
import { deriveReviewData, deriveReviewDataFromContext, applyTick, type ReviewData } from "../derive/reviewData";
import { readReviewProgress, writeReviewProgress, type ReviewComment, type ReviewProgress, type ReviewTick } from "./reviewTicksPref";
import { reviewContextFromPrFiles } from "../derive/prReviewContext";
import { applyFileToggle, applyUnitTick, deriveReviewFiles, type ReviewFileRow } from "../derive/reviewFiles";
import { buildReviewSubmission } from "../derive/reviewSubmit";
import {
  DEFAULT_SERVICE_GROUPING_TARGET_SIZE,
  isServiceGroupingTargetSize,
  type ServiceGroupingTargetSize,
} from "./serviceGroupingTargetSize";
import { yieldForPaint } from "./yieldForPaint";

/**
 * The "All" setting for the related-flows depth dial: a depth larger than any real call-graph chain.
 * `transitiveCallers`' BFS terminates when the frontier empties (no more callers to visit), so 99 ≡
 * "the entire transitive-caller closure" — it just never bottoms out on a real graph — with no perf
 * risk, since the walk is bounded by the callers that exist, not by this number.
 */
export const GHOST_DEPTH_ALL = 99;

export type LayoutStatus = "idle" | "laying-out" | "ready" | "error";

/** One in-flight layout request's copy. It is snapshotted at the initiating action, never inferred
 * later from sticky lens settings, and cleared only by that request's winning completion/failure. */
export interface LayoutActivity {
  label: string;
  detail?: string;
}

/** Lens-owned state carried by an already-mounted semantic parent. The compositor treats this as
 * opaque metadata; the surface spec supplies it and the generic commit applies it atomically. */
type SurfaceSemanticContext = NonNullable<SurfaceSemanticParent["context"]>;

/** The source view's state: which node, its fetched code, and the in-flight/error status.
 * `mode` decides where it renders — a compact panel inline on the node, or a centered modal. */
export interface CodeView {
  node: GraphNode;
  code: string | null;
  loading: boolean;
  error: string | null;
  /** Where the code shows: a compact panel hanging off the node, or a blown-up centered modal. */
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
}

export interface BlueprintState {
  artifact: GraphArtifact;
  index: GraphIndex;
  /** Which relationship story is on screen: the call graph, or the React composition tree. */
  viewMode: ViewMode;
  /** Whether test code (nodes tagged/heuristically detected as tests) is drawn at all. */
  showTests: boolean;
  /** Coverage mode recolors the graph by static test coverage and opens the coverage panel. */
  coverageMode: boolean;
  /** Computed once, on first entering coverage mode (the artifact never changes after boot). */
  coverage: CoverageReport | null;
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
  /** Coverage mode only: whether the tests that directly exercise the charted callable are drawn as
   * ghost nodes above the flow. A repaint-only flag (the view derives the ghosts), like `logicSelected`. */
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
  /** Hide the non-expandable (greyed) building-block leaves in the Logic graph. */
  hideGreyed: boolean;
  /** Nest consecutive same-owner calls under service frames in the Logic graph. Default OFF (flat):
   * the framing is opt-in, so the flow reads as plain blocks unless the reader turns it on. */
  nestByService: boolean;
  /** Phase-1 Code flows explorer state: the selection is shared by the tree and panes. */
  flowExplorerOpen: boolean;
  flowSelection: FlowSelectionRef | null;
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
  /** Whether cross-container edges merge into thick "highway" bundles on the Map. PAINT-ONLY like the
   * other Map toggles — off draws every edge individually. A selected node's own wires always draw
   * individually regardless, so you can read its links out of the highway they'd otherwise join. */
  showHighways: boolean;
  /** Whether utility hubs demote into the COMMONS DOCK below the graph (commonsDemotion). A
   * RELAYOUT toggle like Tests — the docked cards leave/rejoin ELK, so positions change. */
  showCommons: boolean;
  /** Whether the currently visible ghost neighbourhood collapses crowds of 4+ exact siblings under
   * their immediate semantic parent. Paint-only: exact ghosts remain canonical in the derived tree,
   * and disabling this reveals every related ghost without another ELK pass. */
  groupGhostsByParent: boolean;
  /** Module categories painted OUT of the map (a render-time filter — never a re-derive). */
  hiddenCategories: Set<ModuleCategory>;
  /** Relationship kinds painted OUT of the map (calls / instantiates / extends / implements /
   * references / imports / ipc) — a render-time filter, so isolating one kind is instant. */
  hiddenRelKinds: Set<string>;
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
  /** The ORIGIN of the OPEN minimal-graph overlay: the raw selection ids (any kind), verbatim; empty
   * == the overlay is closed and the Module-map level canvas shows. Immutable per build — it is the
   * seed-tier baseline and the Reset target. URL-synced as `mgraph`. */
  minimalSeedIds: string[];
  /** The mutable working set of MEMBERS shown in the overlay (starts = origin). Promoting a ghost adds
   * to it; removing a member drops from it. Ghosts are the members' on-map 1-hop ring, derived (not
   * stored). Reset restores it to the origin. */
  minimalMemberIds: string[];
  /** Original rolled package → changed file modules. Retained while expanded so Reset can summarize. */
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
  /** The parsed PR-review data (affected-flow rows + flow trees); null hides the review surface.
   * Sourced EITHER from a `meridian review` artifact extension, OR built at runtime from a GitHub PR
   * (selectPr → reviewPrInGraph). */
  review: ReviewData | null;
  /** Artifact node ids that are affected — the coupling set between the graph and the flow panel. */
  reviewAffectedIds: Set<string>;
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
  /** Hides the review side panel so the graph takes the full width; session-only. */
  reviewPanelHidden: boolean;
  reviewSubmitStatus: "idle" | "submitting";
  reviewSubmitError: string | null;
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
  /** Snapshot of the full seed list at review time — the "All groups" restore target. */
  reviewAllSeedIds: string[];
  /** Bumped by the Toolbar's "Recenter" action. The active graph surface subscribes to it and, on a
   * change, re-fits its viewport to the current selection — or to the whole graph when nothing is
   * selected. Ephemeral: never serialized to the URL (it is a signal, not navigation state). */
  recenterSeq: number;
  telemetry: Record<string, NodeMetrics>;
  environment: string | null;
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
  /** Head ref of the PR under review — the code panel fetches changed files at this ref. Null off-review. */
  reviewHeadRef: string | null;
  /** Per changed file (keyed by node.location.file): the PR diff needed to slice + paint the head code. */
  reviewDiffByFile: Record<string, { edits: LineEdit[]; kinds: ChangedLineSpan[] }>;
  /** Removed patch text keyed like reviewDiffByFile. Positions are HEAD-side in both review modes. */
  reviewRemovedByFile: Record<string, { afterNewLine: number; lines: string[] }[]>;
  /** Files whose removed patch text exceeded the server-side cap, keyed like reviewRemovedByFile. */
  reviewRemovedTruncatedByFile: Record<string, boolean>;
  /** The review-PREPARATION lane: "preparing" while the server streams the clone→checkout→extract
   * analysis of the PR head; "error" when that stream failed (Retry or base fallback); else "idle". */
  prReviewStatus: "idle" | "preparing" | "error";
  /** The analyze stage currently running server-side; null outside "preparing". */
  prPrepareStage: PrAnalyzeStage | null;
  /** Why preparation failed; null outside "error". */
  prPrepareError: string | null;
  /** The server-side graph id of the prepared PR-head artifact (the analyze stream's "done"
   * payload). Kept across a soft close so the review can resume without another extraction. */
  prPreparedGraphId: string | null;
  /** The head commit the server analyzed for the prepared artifact (the "done" payload's
   * provenance); shown in the review header. Set on swap, cleared with prPreparedGraphId. */
  prPreparedHeadSha: string | null;
  /** True only while the loaded artifact/index pair is the prepared PR-head graph. Unlike its id,
   * this disarms on a soft baseline restore and re-arms when resumePrReview swaps the graph back. */
  prPreparedArtifactCurrent: boolean;
  /** The boot artifact/index pair, saved ONCE when a streamed review swaps in the prepared PR-head
   * artifact and restored when the session ends (back to the PRs lens, switching PRs). Null outside
   * a swapped review — the synchronous fallback path never swaps, so it never sets this. */
  prReviewBaseline: PrReviewBaseline | null;
  /** The artifact endpoint this session loaded from; the wave-2 swap fetches the prepared PR
   * graph from it by exchanging the `id` query param. Empty when booted without a server. */
  graphUrl: string;
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
  selectFlowEntry(ref: FlowSelectionRef | null): void;
  /** Select one artifact node from the bottom flow pane. In a PR review this narrows the Map to
   * that node's incident relationships (including its on-demand ghosts); null restores the whole
   * selected flow as the graph emphasis. Outside review it is the pane-local selection only. */
  selectFlowPaneTarget(nodeId: NodeId | null): void;
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
  toggleHideGreyed(): void;
  toggleNestByService(): void;
  logicRelayout(activity?: LayoutActivity): Promise<void>;
  selectCompUnit(id: string | null): void;
  setCompRoot(id: string | null): void;
  toggleSolidMetrics(): void;
  moduleRelayout(activity?: LayoutActivity): Promise<void>;
  setModuleFocus(id: string | null): void;
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
  /** ⌘P palette "+": pin a picked symbol INTO the current map lens (its owning unit/file) as an extra
   * card, without navigating. Inert outside the map lenses. */
  addToView(rawId: string): void;
  /** The shared ghost "+" action. On the Map/Service/UI canvas it pins the ghost's home FILE(s)
   * into `mapExtra`; while the minimal overlay is open it adds the home member to that overlay and
   * preserves the clicked card's position. Both destinations open the target's containment path. */
  promoteGhost(ghostId: string, at?: { x: number; y: number }): void;
  expandModuleChildren(containerId: string | null): void;
  collapseModuleChildren(containerId: string | null): void;
  togglePrivateMembers(): void;
  setModuleRadius(radius: number): void;
  toggleHighlightMode(): void;
  toggleHighways(): void;
  toggleCommons(): void;
  toggleGhostGrouping(): void;
  toggleCategory(category: ModuleCategory): void;
  toggleRelKind(kind: string): void;
  resetCategoryFilter(): void;
  resetRelationshipFilter(): void;
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
  buildMinimalGraph(): void;
  closeMinimalGraph(): void;
  demoteMinimalMember(id: string): void;
  resetMinimalGraph(): void;
  /** Expand one rolled review package into its changed file cards. Reset is the only collapse-back. */
  expandMinimalGroup(packageId: string): void;
  rearrangeMinimalGraph(): void;
  minimalRelayout(activity?: LayoutActivity): Promise<void>;
  setReviewLit(ids: Set<string> | null): void;
  setReviewFilesSort(sort: "path" | "risk"): void;
  selectReviewNode(id: string | null): void;
  /** Isolate one change group on the Map (null = "All groups"): re-seed the minimal overlay with only
   * that group's module ids and relayout. A no-op outside a review or when already active. */
  selectReviewGroup(groupId: string | null): void;
  toggleReviewTick(flowId: string): void;
  resetReviewTicks(): void;
  /** Reveal a changed file on the review graph: select its frame, light its units, center on it. */
  focusReviewFile(path: string): void;
  toggleReviewUnitTick(nodeId: string): void;
  toggleReviewFileViewed(path: string): void;
  addReviewComment(path: string, nodeId: string | null, body: string, line?: number | null): void;
  deleteReviewComment(id: string): void;
  toggleReviewPanel(): void;
  submitReviewComments(): Promise<void>;
  setViewMode(mode: ViewMode): void;
  /** Toggle the full PR-review page: open it, or (when already open) resume the lens you came from. */
  togglePrsView(): void;
  toggleShowTests(): void;
  toggleCoverageMode(): void;
  setEnvironment(environment: string): void;
  refreshTelemetry(): Promise<void>;
  /** Load one node's review diff for the hover preview without taking over the global code modal. */
  loadCodePreview(node: GraphNode): Promise<CodeView | null>;
  showCode(node: GraphNode, opts?: { wholeFile?: boolean }): Promise<void>;
  expandCode(): void;
  closeCode(): void;
  setPrsTab(tab: PrsTab): void;
  loadPrs(page?: number): Promise<void>;
  exploreRelatedPrs(): Promise<void>;
  clearRelatedPrs(): void;
  ensurePrSummary(number: number): Promise<void>;
  selectPr(number: number | null): Promise<void>;
  reviewPrInGraph(): Promise<void>;
  /** Explicit fallback after prepare-first entry fails: review against the loaded base graph. */
  reviewPrOnBaseGraph(): Promise<void>;
  /** Head extract: stream the server's clone→checkout→extract of the PR head, swap the
   * loaded artifact for the head-accurate one, and run the review in head coordinates. On an
   * entry failure the PRs page stays put; a fallback review remains intact on manual failure. */
  prepareHeadGraph(): Promise<void>;
  /** Re-open a review whose overlay was soft-closed (explicit Close/lens switch) WITHOUT re-running
   * the expensive head prepare: re-swap the already-prepared artifact (a plain GET) if there was
   * one, repaint the kept amber, and reseed the minimal overlay from `reviewAllSeedIds`. Guarded on
   * a live-but-collapsed review (`prReviewed !== null && minimalSeedIds.length === 0`). */
  resumePrReview(): Promise<void>;
  /** Abandon an in-flight prepare-first entry; server work may continue behind the stale-seq guard. */
  cancelPrReviewPreparation(): void;
  /** Dismiss the head-extraction failure warning: clears the prepare-error lane. */
  dismissPrepareError(): void;
  relayout(): Promise<void>;
}

export interface StoreDependencies {
  artifact: GraphArtifact;
  index: GraphIndex;
  provider: TelemetryProvider | null;
  hasOverlay: boolean;
  sourceUrl: string | null;
  prSessionSource?: PrSessionSource | null;
  prsUrl: string;
  prOneUrl: string;
  prFilesUrl: string;
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
  /** The graph-fetch URL; wave 2 loads the prepared PR artifact from it by swapping the id. */
  graphUrl?: string;
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
  const url = new URL(state.sourceUrl, requestOrigin());
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
}

interface CodePayload {
  code: string;
  truncated: boolean;
  startLine?: number;
}

type CodePayloadCache = Map<string, Promise<CodePayload>>;

/** Resolve the source request once so click-to-open and hover-preview read identical code. */
function codeLoadRequest(
  node: GraphNode,
  opts: { wholeFile?: boolean } | undefined,
  state: BlueprintState,
  sourceUrl: string | null,
  prFileUrl: string | null,
): CodeLoadRequest | null {
  if (!node.location) {
    return null;
  }
  // A prepared PR artifact has its own retained source root. Route every code surface through that
  // graph id and keep it out of the GitHub head-file branch: its nodes and source already share HEAD
  // coordinates, while the head-file fallback below exists for reviews on the loaded base artifact.
  const preparedArtifactCurrent = state.prPreparedArtifactCurrent;
  const resolvedSourceUrl = preparedArtifactCurrent ? activeSourceUrl(state) : sourceUrl;
  // A live PR review reads changed files from the PR head. The synchronous path holds BASE node
  // coordinates and therefore needs the edit map; a prepared artifact is already in HEAD
  // coordinates, so mapping it again would double-shift the preview after an earlier hunk.
  const reviewDiff = !preparedArtifactCurrent && state.prReviewed !== null && prFileUrl && state.reviewHeadRef
    ? state.reviewDiffByFile[node.location.file] ?? null
    : null;
  // A patch can be absent for a binary/oversized change, but the file is still a PR-head file. Its
  // file-delta entry is the fallback capability signal so the preview never silently shows BASE
  // source just because GitHub omitted hunk detail. Removed files are the exception: no HEAD path
  // exists, so their old (entirely deleted) node span must come from the base source endpoint.
  const removedAtHead = state.reviewFileDelta[node.location.file]?.status === "removed";
  const readsPrHead = !preparedArtifactCurrent && !removedAtHead
    && state.prReviewed !== null && prFileUrl !== null && state.reviewHeadRef !== null
    && (reviewDiff !== null || state.reviewFileDelta[node.location.file] !== undefined);
  if (!readsPrHead && !resolvedSourceUrl) {
    return null;
  }
  const wholeFile = readsPrHead ? false : opts?.wholeFile ?? false;
  const headSpan = readsPrHead
    ? reviewDiff === null
      ? { start: node.location.startLine, end: node.location.endLine ?? node.location.startLine }
      : headSpanFor(node.location.startLine, node.location.endLine ?? node.location.startLine, reviewDiff.edits)
    : null;
  const baseLine = headSpan ? headSpan.start : wholeFile ? 1 : node.location.startLine;
  // A prepared head artifact's local diff is keyed to the CURRENT node coordinates and is more
  // accurate than GitHub's possibly-truncated patch detail. The synchronous path still needs the
  // latter because its artifact/node coordinates are on the base side.
  const artifactKinds = preparedArtifactCurrent
    ? changedLineKindsFromExtensions(state.artifact.extensions)?.[node.location.file]
    : undefined;
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
    headKinds: removedAtHead
      ? [{ start: node.location.startLine, end: node.location.endLine ?? node.location.startLine, kind: "deleted" }]
      : artifactKinds ?? reviewDiff?.kinds ?? [],
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
      const data = await response.json() as { code?: unknown; truncated?: unknown; startLine?: unknown };
      return {
        code: typeof data.code === "string" ? data.code : String(data.code ?? ""),
        truncated: data.truncated === true,
        ...(typeof data.startLine === "number" ? { startLine: data.startLine } : {}),
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
        data.truncated,
        request.headSpan,
        request.headKinds,
        mode,
      );
    }
    const baseLine = data.startLine ?? request.baseLine;
    const changedLineKinds = request.headKinds.length > 0
      ? headKindsWithin(request.headKinds, baseLine, baseLine + Math.max(data.code.split("\n").length - 1, 0))
      : undefined;
    return {
      node: request.node,
      code: data.code,
      loading: false,
      error: null,
      truncated: data.truncated,
      mode,
      baseLine,
      wholeFile: request.wholeFile,
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
    };
  }
}

/** Slice the fetched HEAD file to the node's head span and pin the PR's own change kinds onto it. */
function sliceHeadCodeView(
  node: GraphNode,
  fullCode: string,
  truncated: boolean,
  headSpan: { start: number; end: number },
  kinds: readonly ChangedLineSpan[],
  mode: "inline" | "modal",
): CodeView {
  const lines = fullCode.length > 0 ? fullCode.split("\n") : [];
  const start = Math.min(Math.max(headSpan.start, 1), Math.max(lines.length, 1));
  const end = Math.min(Math.max(headSpan.end, start), Math.max(lines.length, 1));
  const changedLineKinds = headKindsWithin(kinds, start, end);
  return {
    node,
    code: lines.slice(start - 1, end).join("\n"),
    loading: false,
    error: null,
    truncated,
    mode,
    baseLine: start,
    wholeFile: false,
    changedLineKinds,
    changedLines: new Set(changedLineKinds.keys()),
  };
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

export function createBlueprintStore(dependencies: StoreDependencies): BlueprintStore {
  // The lens to resume when the PR-review page is toggled back off; null == none captured yet.
  let lensBeforePrs: ViewMode | null = null;
  // Monotonic seq to drop a stale Logic-graph layout when a newer open/drill/toggle supersedes it.
  let logicLayoutSeq = 0;
  // And for the Module-map layout, so a newer focus change supersedes an older derivation.
  let moduleLayoutSeq = 0;
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
  // The composition unit index (member → owning unit), built lazily on the first ⌘P reveal/add so a
  // picked symbol resolves to the unit/module card that draws it. Cached like moduleGraph/blockDeps.
  let unitIndex: UnitIndex | null = null;
  // Resolve any symbol to the card the map lenses actually draw: its nearest owning unit
  // (class/interface/object), or its module for a top-level callable (module is itself a UNIT_KIND).
  const resolveCard = (id: string): string => {
    unitIndex ??= buildUnitIndex([...dependencies.index.nodesById.values()]);
    return unitIndex.unitIdOf(id) ?? id;
  };
  // Same guard for the Code flows explorer's embedded flow preview pane.
  let flowPaneLayoutSeq = 0;
  // PR list/file fetches and PR-head preparation are independent async lanes; newer requests win
  // when the reader switches PRs (or re-clicks Review) mid-stream.
  let prsListSeq = 0;
  let relatedPrsSeq = 0;
  let prFilesSeq = 0;
  let prFilesRequest: { number: number; sequence: number; promise: Promise<void> } | null = null;
  let prAnalyzeSeq = 0;
  let prAnalyzeCancellation: { sequence: number; resolve: () => void } | null = null;
  let prReviewEntryRequest: { number: number; promise: Promise<void> } | null = null;
  const prsNextPage: Record<PrsTab, number> = { open: 1, closed: 1 };
  // PR-head reads return an entire file. Share that response across every changed node in the file;
  // fetchCodeView still slices and annotates a separate node-specific view for each caller.
  const codePayloadCache: CodePayloadCache = new Map();
  // Rebuilding/closing the minimal overlay must discard any of its ELK passes still in flight; the
  // extracted review body shares this invalidation with the in-store actions that own the counter.
  const invalidateMinimalLayout = () => {
    minimalLayoutSeq += 1;
  };
  // A PR-review swap/restore replaces the WHOLE artifact/index, so every "built once per artifact"
  // cache must rebuild from the incoming index — and any overlay ELK pass in flight must drop.
  const invalidateArtifactCaches = () => {
    moduleGraph = null;
    blockDeps = null;
    codePayloadCache.clear();
    invalidateMinimalLayout();
  };
  // The parsed review payload from a `meridian review` artifact (null when the artifact carries no
  // valid `review` extension — e.g. a plain `web`/`view` session). Computed once (the artifact never
  // changes after boot); a GitHub PR opened via reviewPrInGraph can later populate `review` at runtime.
  const review = deriveReviewData(dependencies.artifact, dependencies.index);
  const bootReviewBaseline: PrReviewBaseline = { artifact: dependencies.artifact, index: dependencies.index, review };
  // The files checklist + persisted progress for an artifact-sourced review; a GitHub PR opened via
  // reviewPrInGraph re-derives both at runtime under its own reviewKey.
  const reviewFiles = review ? deriveReviewFiles(review.context, dependencies.artifact, dependencies.index, { baseIndex: null }) : [];
  const initialProgress = review ? readReviewProgress(review.context.reviewKey) : null;
  // Null when the server didn't ship source access — the code drawer is then inert.
  const sourceUrl = dependencies.sourceUrl;
  const githubSource = (dependencies.prSessionSource ?? null) !== null;
  const prsUrl = dependencies.prsUrl;
  const prOneUrl = dependencies.prOneUrl;
  const prFilesUrl = dependencies.prFilesUrl;
  const prRelatedUrl = dependencies.prRelatedUrl;
  const prCommentsUrl = dependencies.prCommentsUrl;
  const prChecksUrl = dependencies.prChecksUrl;
  const prFileUrl = dependencies.prFileUrl ?? null;
  const analyzeGraphId = dependencies.graphId ?? null;
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

  return createStore<BlueprintState>((set, get) => ({
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
    hideGreyed: false,
    nestByService: false,
    flowExplorerOpen: false,
    flowSelection: null,
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
    groupGhostsByParent: true,
    hiddenCategories: new Set<ModuleCategory>(),
    hiddenRelKinds: new Set<string>(),
    moduleSelected: new Set<string>(),
    moduleExpanded: new Set<string>(),
    mapExtra: new Set<string>(),
    showPrivate: true,
    serviceScope: null,
    serviceGroupingMode: "folder",
    serviceGroupingTargetSize: DEFAULT_SERVICE_GROUPING_TARGET_SIZE,
    minimalSeedIds: [],
    minimalMemberIds: [],
    minimalRollups: {},
    minimalBasePositions: {},
    minimalArrange: false,
    minimalRfNodes: [],
    minimalRfEdges: [],
    minimalLayoutStatus: "idle",
    minimalLayoutActivity: null,
    review,
    reviewAffectedIds: new Set(reviewFiles.flatMap((file) => file.units.map((unit) => unit.nodeId))),
    reviewFiles,
    reviewFilesSort: "path",
    reviewFileDelta: {},
    reviewTicks: initialProgress?.ticks ?? {},
    reviewUnitTicks: initialProgress?.unitTicks ?? {},
    reviewFileTicks: initialProgress?.fileTicks ?? {},
    reviewComments: initialProgress?.comments ?? [],
    reviewPanelHidden: false,
    reviewSubmitStatus: "idle",
    reviewSubmitError: null,
    reviewSubmittedUrl: null,
    reviewLitNodeIds: null,
    reviewSelectedId: null,
    reviewGroups: null,
    reviewActiveGroupId: null,
    reviewAllSeedIds: [],
    recenterSeq: 0,
    telemetry: {},
    environment: null,
    provider: dependencies.provider,
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
    reviewHeadRef: null,
    reviewDiffByFile: {},
    reviewRemovedByFile: {},
    reviewRemovedTruncatedByFile: {},
    prReviewStatus: "idle",
    prPrepareStage: null,
    prPrepareError: null,
    prPreparedGraphId: null,
    prPreparedHeadSha: null,
    prPreparedArtifactCurrent: false,
    prReviewBaseline: null,
    graphUrl: dependencies.graphUrl ?? "",
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

    selectFlowEntry(ref) {
      if (ref === null) {
        const state = get();
        const baseline = state.reviewFlowBaseline;
        const reviewFlowOpen = state.review !== null
          && state.minimalSeedIds.length > 0
          && state.flowSelection !== null
          && baseline !== null;
        flowPaneLayoutSeq += 1;
        set({
          flowSelection: null,
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
          void get().minimalRelayout({ label: "Closing logic flow review…" });
        }
        return;
      }
      const state = get();
      const { artifact, index, viewMode } = state;
      const flows = (artifact.extensions?.logicFlow ?? {}) as unknown as LogicFlows;
      const related = relatedNodeIds(index, flows, ref);
      const reviewFlow = state.review !== null && state.minimalSeedIds.length > 0;
      if (reviewFlow) {
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
          || !sameStringSet(moduleExpanded, state.moduleExpanded)
          || !sameMembers(minimalSeedIds, state.minimalSeedIds)
          || !sameMembers(minimalMemberIds, state.minimalMemberIds);
        set({
          flowSelection: ref,
          logicSelected: null,
          moduleSelected: related,
          moduleExpanded,
          minimalSeedIds,
          minimalMemberIds,
          reviewFlowBaseline,
          reviewLitNodeIds: null,
          reviewSelectedId: null,
        });
        void get().flowPaneRelayout();
        const recenterIfCurrent = () => {
          if (get().flowSelection === ref && get().logicSelected === null) {
            set({ recenterSeq: get().recenterSeq + 1 });
          }
        };
        if (needsRelayout) {
          void get().minimalRelayout({ label: "Revealing logic flow in review…" }).then(recenterIfCurrent);
        } else {
          recenterIfCurrent();
        }
        return;
      }
      set({ flowSelection: ref });
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
          });
          void get().moduleRelayout({ label: "Revealing selected flow…" });
        } else {
          set({ moduleSelected: new Set<string>() });
        }
      }
      void get().flowPaneRelayout();
    },

    selectFlowPaneTarget(nodeId) {
      const state = get();
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
      const graphTarget = nodeId !== null && related.has(nodeId) && state.index.nodesById.has(nodeId) ? nodeId : null;
      const emphasized = graphTarget === null ? related : new Set([graphTarget]);
      const moduleExpanded = expandedCodePaths(state.moduleExpanded, emphasized, state.index);
      // Re-derive on every target change. When the selected node is currently an off-member ghost,
      // the layout pass temporarily treats its home file as a member so its full incident edge set
      // can fan out to ghost neighbours; clearing the target removes that temporary context again.
      const needsRelayout = moduleExpanded.size !== state.moduleExpanded.size || state.logicSelected !== nodeId;
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
        void get().minimalRelayout({ label: nodeId === null ? "Restoring logic flow context…" : "Revealing logic flow node…" }).then(recenterIfCurrent);
      } else {
        recenterIfCurrent();
      }
    },

    async flowPaneRelayout() {
      const { flowSelection, index, artifact } = get();
      if (flowSelection === null) {
        set({ flowPaneRfNodes: [], flowPaneRfEdges: [], flowPaneLayoutStatus: "idle" });
        return;
      }
      const flows = (artifact.extensions?.logicFlow ?? {}) as unknown as LogicFlows;
      const sequence = ++flowPaneLayoutSeq;
      set({ flowPaneLayoutStatus: "laying-out" });
      const graph = await deriveFlowPaneLayout(flowSelection, flows, index);
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
      const state = get();
      moduleLayoutSeq += 1;
      beginLensTransition(get, set);
      set({ viewMode: "logic", logicRoot: nodeId, logicStack: [nodeId], logicFocus: [], logicSelected: null, expandedLogic: new Set<string>() });
      void get().logicRelayout(nodeLayoutActivity(state, "Opening logic for", nodeId));
    },

    // The logic→composition link: a call block's owning-unit chip opens the Service lens HERE with
    // the unit revealed on canvas AND rooted/selected in the composition side panel, so a reader can
    // pivot from "who calls this" to "how healthy is the unit it lives in".
    openComposition(unitId) {
      const state = get();
      beginLensTransition(get, set);
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
      set({ logicStack: [...state.logicStack, nodeId], logicRoot: nodeId, logicFocus: [], logicSelected: null, expandedLogic: new Set<string>() });
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
      set({ logicStack: state.logicStack.slice(0, index + 1), logicRoot: nodeId, logicFocus: [], logicSelected: null, expandedLogic: new Set<string>() });
      void get().logicRelayout(nodeLayoutActivity(state, "Returning to", nodeId));
    },

    // Dive INTO a control container (loop/try): re-chart the canvas to show ONLY its bodies as a
    // focused sub-view, the breadcrumb gaining a segment. Push it, reset expansion, relayout.
    diveLogicContainer(id, label, bodies) {
      set({ logicFocus: [...get().logicFocus, { id, label, bodies }], logicSelected: null, expandedLogic: new Set<string>() });
      void get().logicRelayout({ label: `Opening ${label}…` });
    },

    // Jump back along the container-dive trail (a focus-breadcrumb click): truncate to `index + 1`;
    // a negative index clears focus entirely, back to the full callable flow. Reset, relayout.
    logicFocusTo(index) {
      set({ logicFocus: index < 0 ? [] : get().logicFocus.slice(0, index + 1), logicSelected: null, expandedLogic: new Set<string>() });
      void get().logicRelayout({ label: index < 0 ? "Returning to full logic flow…" : "Returning to parent flow…" });
    },

    // Set how many levels of resolved calls the Logic-flow view expands in place. Clamped to 0..2
    // (the cap that keeps a deep pre-expansion from hanging the browser). Sticky — never reset on
    // open/drill — so the reader's chosen inline depth carries across navigation.
    setLogicInlineDepth(depth) {
      set({ logicInlineDepth: Math.max(0, Math.min(2, Math.trunc(depth))) });
    },

    // Coverage mode: reveal/hide the tests that directly exercise the charted callable as ghost
    // nodes above the flow. Repaint only — the view derives the ghosts from this flag + the coverage
    // report, mirroring how the related-flows ghosts ride selection — so it never relayouts.
    toggleLogicTests() {
      set({ showLogicTests: !get().showLogicTests });
    },

    // Switch which projection of the charted flow is on screen. A pure view switch: root, drill
    // trail, and selection all stay put, and the exec graph's ELK layout is untouched (it re-mounts
    // from the already-derived logicRfNodes when switched back).
    setLogicView(mode) {
      set({ logicView: mode });
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
      const { logicRoot, index, artifact, expandedLogic, hideGreyed, nestByService, logicFocus } = get();
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
        const graph = await deriveLogicLayout(logicRoot, flows, index, expandedLogic, { hideGreyed, nestByService }, focus);
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
        const hidden = state.showTests ? EMPTY_HIDDEN_IDS : state.index.testIds;
        const spec = activeModuleSurfaceSpec(state.viewMode);
        // A focused surface mounts detail plus every real parent graph as independent ELK layers.
        // Commons demotion stays disabled for focused composites: independent Map layouts would
        // otherwise mint the same RF-only dock identity. Service/UI ignore this Map-only flag.
        const semanticState = state.moduleFocus !== null ? { ...state, showCommons: false } : state;
        const tree = spec.deriveTree(
          semanticState,
          { graph, deps, flows },
          { extraIds: state.mapExtra, hiddenIds: hidden },
        );
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
          const parent = spec.focus.semanticParent({ state: currentState, effectiveFocus: currentEffectiveFocus });
          if (parent === null) {
            break;
          }
          const parentState = {
            ...currentState,
            moduleFocus: parent.focus,
            moduleExpanded: new Set<string>(),
            ...(parent.context ?? {}),
          };
          const parentTree = spec.deriveTree(
            parentState,
            { graph, deps, flows },
            { hiddenIds: hidden },
          );
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
          laid = await layoutModuleTree(tree.nodes, tree.edges);
        } else {
          const layouts = await Promise.all(
            stack.layers.map((layer) => layoutModuleTree(layer.tree.nodes, layer.tree.edges)),
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
        set({
          moduleRfNodes: laid.nodes,
          moduleRfEdges: laid.edges,
          moduleEffectiveFocus: tree.effectiveFocus,
          moduleSemanticLayers: semanticLayers,
          moduleLayoutStatus: "ready",
          moduleLayoutActivity: null,
        });
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
      set({ moduleFocus: id, moduleSelected: new Set<string>(), moduleExpanded: new Set<string>(), mapExtra: new Set<string>() });
      void get().moduleRelayout(id === null
        ? { label: "Returning to overview…" }
        : nodeLayoutActivity(state, "Opening", id));
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
        mapExtra: new Set<string>(), // a focus jump ends the scratch "+" pins from the level we left.
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
        set({ moduleSelected: new Set([nodeId]) });
        return;
      }
      const focusLead = moduleFocus === null ? null : leadIdOf(moduleFocus);
      const focusDomain = moduleFocus === null
        ? undefined
        : deriveServiceDomains(clusteringFor(index), serviceGroupingMode, serviceGroupingTargetSize).domainById.get(moduleFocus);
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
        const card = resolveCard(rawId);
        set({ mapExtra: new Set(state.mapExtra).add(card), moduleSelected: new Set([card]) });
        void get().moduleRelayout(nodeLayoutActivity(state, "Revealing", card));
      }
    },

    // ⌘P palette "+": pin a picked symbol's owning card (unit/file) INTO the current map lens WITHOUT
    // navigating — a scratch card unioned into the next relayout. A no-op when already pinned or off a
    // map lens. All module lenses share `mapExtra`, so the same pin surfaces in each.
    addToView(rawId) {
      const state = get();
      const viewMode = state.viewMode;
      if (moduleSurfaceSpec(viewMode) === null) {
        return;
      }
      const card = resolveCard(rawId);
      if (!state.mapExtra.has(card)) {
        set({ mapExtra: new Set(state.mapExtra).add(card) });
        void get().moduleRelayout(nodeLayoutActivity(state, "Adding", card));
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
        void get().minimalRelayout(nodeLayoutActivity(state, "Adding", member));
        return;
      }

      // A folder group-ghost contributes its bounded set of drawn files; an individual symbol
      // contributes its home file. Map placement deliberately stays ELK's: the pinned files re-enter
      // the level wired to the cards that anchored the ghost, so a captured rect would fight relayout.
      const pins = ghostPinIds(state.index, ghostId, drawnGhostMembers(state.moduleRfNodes, ghostId));
      const mapExtra = new Set(state.mapExtra);
      pins.forEach((pin) => mapExtra.add(pin));
      if (mapExtra.size === state.mapExtra.size && moduleExpanded.size === state.moduleExpanded.size) {
        return; // unknown ghost, or its home file and reveal path are already present.
      }
      // Keep the current lens focus and selection. `mapRevealStateForMany` contributes expansion ids
      // only; adopting its other fields would unexpectedly navigate away from the canvas being edited.
      set({ mapExtra, moduleExpanded });
      void get().moduleRelayout(nodeLayoutActivity(state, "Adding", member));
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

    // Merge/unmerge cross-container edges into highway bundles. PAINT-ONLY — the Map re-bundles in a
    // useMemo, no relayout.
    toggleHighways() {
      set({ showHighways: !get().showHighways });
    },

    // Park/unpark utility hubs in the commons dock. A RELAYOUT toggle (like Tests): the docked
    // cards leave/rejoin ELK, so the level re-lays out and re-fits.
    toggleCommons() {
      const showCommons = !get().showCommons;
      set({ showCommons });
      void get().moduleRelayout({ label: showCommons ? "Showing shared utilities…" : "Hiding shared utilities…" });
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
      set({ hiddenRelKinds: withToggled(get().hiddenRelKinds, kind) });
    },

    // Clear the category / relationship filters back to "show everything". PAINT-ONLY — no relayout.
    resetCategoryFilter() {
      set({ hiddenCategories: new Set<ModuleCategory>() });
    },

    resetRelationshipFilter() {
      set({ hiddenRelKinds: new Set<string>() });
    },

    // Select a Module-map node, REPLACING the whole selection (pass null to clear) — the plain-click
    // gesture. A repaint-only highlight — no relayout.
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

    // The "Extract selection" action: EXTRACT the current selection verbatim (any kind — a selected
    // package stays ONE card) as the overlay's members/origin, and open on their curated subgraph
    // (members + their on-map 1-hop ghost ring). A fresh build discards any prior curation. Inert when
    // nothing is selected.
    buildMinimalGraph() {
      // The active surface's spec decides how a selection seeds the overlay: identity on the Map,
      // while the Service lens decomposes a selected `svc:` frame into its cluster's member units.
      const origin = activeModuleSurfaceSpec(get().viewMode).minimalSeeds(
        [...get().moduleSelected],
        get().index,
        get().serviceGroupingMode,
        get().serviceGroupingTargetSize,
      );
      if (origin.length === 0) {
        return;
      }
      // Snapshot the map's current on-screen card positions ONCE, at build — the overlay mirrors them,
      // and re-capturing on curation would let already-placed cards jump. A selection-built graph is not
      // a PR review, so drop any stale prReviewed marker (else the PR-review card would show it) AND,
      // when the live review came from a PR, its runtime review state — else the panel would ride this
      // unrelated hand-built graph showing the old PR's checklist. An artifact-sourced review
      // (prReviewed null) is the session's purpose and could never be re-derived, so it stays.
      const clearPrReview =
        get().prReviewed !== null
          ? {
              review: null,
              reviewFiles: [] as ReviewFileRow[],
              reviewAffectedIds: new Set<string>(),
              reviewComments: [] as ReviewComment[],
              reviewLitNodeIds: null,
              reviewSelectedId: null,
              flowSelection: null,
              logicSelected: null,
              flowPaneRfNodes: [] as LogicRfNode[],
              flowPaneRfEdges: [] as LogicRfEdge[],
              flowPaneLayoutStatus: "idle" as const,
              reviewFlowBaseline: null,
              reviewGroups: null,
              reviewActiveGroupId: null,
              reviewAllSeedIds: [] as string[],
              reviewSubmitStatus: "idle" as const,
              reviewSubmitError: null,
              reviewSubmittedUrl: null,
              reviewHeadRef: null,
              reviewDiffByFile: {} as Record<string, { edits: LineEdit[]; kinds: ChangedLineSpan[] }>,
              reviewRemovedByFile: {} as Record<string, { afterNewLine: number; lines: string[] }[]>,
              reviewRemovedTruncatedByFile: {} as Record<string, boolean>,
            }
          : {};
      const clearArtifactReviewFlow = get().review !== null && get().prReviewed === null
        ? {
            reviewLitNodeIds: null,
            reviewSelectedId: null,
            flowSelection: null,
            logicSelected: null,
            flowPaneRfNodes: [] as LogicRfNode[],
            flowPaneRfEdges: [] as LogicRfEdge[],
            flowPaneLayoutStatus: "idle" as const,
            reviewFlowBaseline: null,
          }
        : {};
      if (get().flowSelection !== null) {
        flowPaneLayoutSeq += 1;
      }
      set({
        minimalSeedIds: origin,
        minimalMemberIds: origin,
        minimalRollups: {},
        minimalBasePositions: captureMapPositions(get().moduleRfNodes),
        minimalArrange: false,
        prReviewed: null,
        ...clearArtifactReviewFlow,
        ...clearPrReview,
      });
      void get().minimalRelayout({ label: "Extracting selection…" });
    },

    // Close the overlay back to the Module-map level canvas. The selection is kept, so the reader
    // can adjust it and rebuild without re-picking every card. Bumping the seq discards any ELK
    // pass still in flight, so a slow layout can't repopulate the arrays after the close.
    closeMinimalGraph() {
      const stateBeforeClose = get();
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
        if (!restorePrReviewBaseline(get, set, invalidateArtifactCaches, { endSession: false })) {
          resetChangedIdsToArtifact(get().artifact, get().index);
        }
      }
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
        ...(reviewFlowOpen
          ? {
              flowSelection: null,
              logicSelected: null,
              flowPaneRfNodes: [] as LogicRfNode[],
              flowPaneRfEdges: [] as LogicRfEdge[],
              flowPaneLayoutStatus: "idle" as const,
              reviewFlowBaseline: null,
            }
          : {}),
      });
    },

    // Remove a MEMBER (the members-panel ✕); it reappears as a satellite iff a remaining member still
    // couples to its code. Refuses to empty the set — the last member must stay so the overlay never
    // goes blank.
    demoteMinimalMember(id) {
      const state = get();
      const { minimalMemberIds } = state;
      if (!minimalMemberIds.includes(id) || minimalMemberIds.length <= 1) {
        return;
      }
      set({ minimalMemberIds: minimalMemberIds.filter((member) => member !== id) });
      void get().minimalRelayout(nodeLayoutActivity(state, "Removing", id));
    },

    // Reset the overlay to its base: restore the working set to the origin selection AND drop any
    // re-arrangement (back to the captured map-mirror). A no-op when already at the origin and mirror.
    resetMinimalGraph() {
      const { minimalSeedIds, minimalMemberIds, minimalRollups, minimalArrange } = get();
      // Expanding a rollup replaces its package seed with file seeds. The retained mapping restores
      // the ORIGINAL rolled package here, so Reset re-summarizes; there is intentionally no inline
      // collapse-back gesture competing with the one-way "files ▸" affordance.
      const origin = restoreRolledSeeds(minimalSeedIds, minimalRollups);
      if (sameMembers(minimalMemberIds, origin) && sameMembers(minimalSeedIds, origin) && !minimalArrange) {
        return;
      }
      set({ minimalSeedIds: origin, minimalMemberIds: [...origin], minimalArrange: false });
      void get().minimalRelayout({ label: "Resetting extracted graph…" });
    },

    // Decompose one rolled package into exactly the changed file modules it summarized. Expanding
    // their package/module ancestry opens those files to declaration level through the overlay's
    // existing shared moduleExpanded path; the retained rollup mapping is Reset's collapse target.
    expandMinimalGroup(packageId) {
      const { index, minimalSeedIds, minimalMemberIds, minimalRollups, moduleExpanded } = get();
      const fileIds = minimalRollups[packageId];
      if (!fileIds || (!minimalSeedIds.includes(packageId) && !minimalMemberIds.includes(packageId))) {
        return;
      }
      const expanded = new Set(moduleExpanded);
      for (const fileId of fileIds) {
        for (const ancestor of index.ancestorsOf(fileId)) {
          if (ancestor.kind === "package" || ancestor.kind === "module") {
            expanded.add(ancestor.id);
          }
        }
      }
      set({
        minimalSeedIds: replaceRollupSeed(minimalSeedIds, packageId, fileIds),
        minimalMemberIds: replaceRollupSeed(minimalMemberIds, packageId, fileIds),
        moduleExpanded: expanded,
      });
      void get().minimalRelayout({ label: "Expanding directory…" });
    },

    // Re-arrange: drop the captured map-mirror and run the canonical canvas ELK layout. It stays
    // active so later curation keeps the arranged layout; repeated clicks deliberately run it again.
    rearrangeMinimalGraph() {
      if (!get().minimalArrange) {
        set({ minimalArrange: true });
      }
      void get().minimalRelayout({ label: "Re-arranging extracted graph…" });
    },

    // Lay out the overlay's curated subgraph (members + their ghost-satellite ring) through the
    // shared minimal-graph pass, behind its own stale-seq guard. `minimalArrange` picks the fresh
    // ELK layout over the map-mirror; hidden tests drop out of the ring like on the Map beneath.
    async minimalRelayout(activity) {
      if (get().minimalMemberIds.length === 0) {
        set({ minimalLayoutStatus: "idle", minimalLayoutActivity: null });
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
        const { index, minimalSeedIds, minimalBasePositions, minimalArrange, moduleExpanded, artifact, showTests } = state;
        moduleGraph ??= buildModuleGraph(index);
        const deps = (blockDeps ??= buildBlockDeps(index));
        const flows = (artifact.extensions?.logicFlow ?? {}) as unknown as LogicFlows;
        const hidden = showTests ? EMPTY_HIDDEN_IDS : index.testIds;
        const layout = await deriveMinimalGraphLayout(index, moduleGraph, minimalMembersForFlowInspection(state), new Set(minimalSeedIds), minimalBasePositions, {
          moduleExpanded,
          blockDeps: deps,
          flows,
          inspectionIds: flowInspectionIds(state, flows),
        }, minimalArrange, hidden);
        if (minimalLayoutSeq !== sequence) {
          return; // a newer build/promote/demote/reset/re-arrange superseded this one.
        }
        set({
          minimalRfNodes: layout.nodes,
          minimalRfEdges: layout.edges,
          minimalLayoutStatus: "ready",
          minimalLayoutActivity: null,
        });
      } catch {
        if (minimalLayoutSeq === sequence) {
          set({ minimalLayoutStatus: "error", minimalLayoutActivity: null });
        }
      }
    },

    // Flip one Module-map node in/out of the selection WITHOUT touching the rest — the ctrl/cmd+click
    // gesture that accumulates a multi-selection. Repaint-only, like selectModule.
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
      beginLensTransition(get, set);
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
      set({ serviceScope: null });
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

    // Paint-only: light a set of graph node ids (from a panel hover); null clears back to full strength.
    setReviewLit(ids) {
      set({ reviewLitNodeIds: ids });
    },

    setReviewFilesSort(sort) {
      set({ reviewFilesSort: sort });
    },

    // Select a review block (from the panel); also lights it and CENTERS the graph on it — a panel
    // click must always end with the target visible, not selected somewhere off-screen.
    selectReviewNode(id) {
      const flowBaseline = get().reviewFlowBaseline;
      set({
        ...(flowBaseline ?? {}),
        reviewSelectedId: id,
        reviewLitNodeIds: id === null ? null : new Set([id]),
        moduleSelected: id === null ? new Set<string>() : new Set([id]),
        // A file/unit click switches back to graph review; the bottom split belongs to a selected
        // logic flow and must not linger with a now-unrelated pane selection.
        flowSelection: null,
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
        void get().minimalRelayout({ label: "Returning to changed node review…" }).then(recenter);
      } else {
        recenter();
      }
    },

    // The file row's click: select the file's frame on the review graph (the emphasize ring), light
    // its touched units amber-strong, and center the viewport on the frame. Inert for files with no
    // module on the graph (the "not in graph" tail).
    focusReviewFile(path) {
      const state = get();
      const file = state.reviewFiles.find((candidate) => candidate.path === path);
      if (!file || file.moduleId === null) {
        return;
      }
      const flowBaseline = state.reviewFlowBaseline;
      const lit = file.units.length > 0 ? file.units.map((unit) => unit.nodeId) : [file.moduleId];
      set({
        ...(flowBaseline ?? {}),
        moduleSelected: new Set([file.moduleId]),
        reviewSelectedId: file.moduleId,
        reviewLitNodeIds: new Set(lit),
        flowSelection: null,
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
        void get().minimalRelayout({ label: "Returning to changed file review…" }).then(recenter);
      } else {
        recenter();
      }
    },

    // Isolate one change group on the Map: re-seed the minimal overlay with ONLY that group's module
    // ids (null restores the full review seed set), then relayout through the shared minimal machinery
    // — a pure seed/member swap, no dimming and no bespoke graph. Mirrors applyPrReviewToMap's reset
    // of the minimal fields exactly so the overlay rebuilds identically.
    selectReviewGroup(groupId) {
      const { review, reviewFiles, reviewGroups, reviewActiveGroupId, index } = get();
      if (!review || !reviewGroups || groupId === reviewActiveGroupId) {
        return;
      }
      // An unknown id falls back to "All" — a stale group id can never strand the reader on an empty Map.
      const group = groupId === null ? null : reviewGroups.groups.find((candidate) => candidate.id === groupId) ?? null;
      const allowed = group === null ? null : new Set(group.moduleIds);
      const matched = matchAffectedFiles(index, reviewFiles.map((file) => file.path)).matched
        .filter((match) => allowed === null || allowed.has(match.moduleId));
      // The threshold belongs to THIS isolated set, not the PR as a whole: an eight-file group stays
      // eight file cards even when the full review was large enough to roll up.
      const { seeds: nextSeeds, rolledUp } = rollupSeeds(matched, index);
      const moduleExpanded = reviewExpansionForMatches(index, matched, rolledUp);
      invalidateMinimalLayout();
      set({
        reviewActiveGroupId: group ? group.id : null,
        reviewSelectedId: null,
        reviewLitNodeIds: null,
        flowSelection: null,
        logicSelected: null,
        flowPaneRfNodes: [],
        flowPaneRfEdges: [],
        flowPaneLayoutStatus: "idle",
        reviewFlowBaseline: null,
        minimalSeedIds: nextSeeds,
        minimalMemberIds: [...nextSeeds],
        minimalRollups: rollupsRecord(rolledUp),
        moduleExpanded,
        minimalBasePositions: {},
        minimalArrange: false,
        minimalRfNodes: [],
        minimalRfEdges: [],
        minimalLayoutStatus: nextSeeds.length > 0 ? "laying-out" : "idle",
        minimalLayoutActivity: nextSeeds.length > 0 ? { label: "Opening review group…" } : null,
      });
      void get().minimalRelayout({ label: group ? `Opening ${group.label}…` : "Opening all review groups…" });
    },

    // Toggle a flow's reviewed tick and persist the whole record under the reviewKey.
    toggleReviewTick(flowId) {
      const { review, reviewTicks } = get();
      const row = review?.rows.find((candidate) => candidate.flow.flowId === flowId);
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

    // Add a draft comment on a file (nodeId null), touched unit, or explicit HEAD-side line. Drafts
    // persist under the reviewKey until submitted or deleted.
    addReviewComment(path, nodeId, body, line = null) {
      const { review, reviewComments, index } = get();
      const trimmed = body.trim();
      if (!review || trimmed.length === 0) {
        return;
      }
      const comment: ReviewComment = {
        id: newCommentId(),
        path,
        nodeId,
        line,
        anchorLabel: line === null ? (nodeId === null ? null : (index.nodesById.get(nodeId)?.displayName ?? null)) : `L${line}`,
        body: trimmed,
        at: new Date().toISOString(),
      };
      // A fresh draft supersedes the last submit's outcome banners (link and error alike).
      set({ reviewComments: [...reviewComments, comment], reviewSubmittedUrl: null, reviewSubmitError: null });
      persistReviewProgress(get());
    },

    deleteReviewComment(id) {
      if (!get().review) {
        return;
      }
      set({ reviewComments: get().reviewComments.filter((comment) => comment.id !== id), reviewSubmittedUrl: null, reviewSubmitError: null });
      persistReviewProgress(get());
    },

    toggleReviewPanel() {
      set({ reviewPanelHidden: !get().reviewPanelHidden });
    },

    // Submit every draft as ONE GitHub review (event COMMENT): unit/file drafts become inline
    // comments anchored to new-side diff lines, the rest ride as notes the server folds into the
    // review body (reviewSubmit.ts). Only the drafts SNAPSHOTTED here are cleared on success — a
    // comment added while the POST is in flight stays a draft; a failed submit keeps everything.
    async submitReviewComments() {
      const { review, reviewComments, reviewFiles, prReviewed: prNumber, reviewSubmitStatus } = get();
      if (!review || prNumber === null || reviewComments.length === 0 || reviewSubmitStatus === "submitting") {
        return;
      }
      const submission = buildReviewSubmission(reviewComments, reviewFiles, review.context);
      const submittedIds = new Set(reviewComments.map((comment) => comment.id));
      const submittedKey = review.context.reviewKey;
      set({ reviewSubmitStatus: "submitting", reviewSubmitError: null });
      try {
        const response = await fetch(prReviewUrl, {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ number: prNumber, comments: submission.comments, notes: submission.notes }),
        });
        if (!response.ok) {
          set({ reviewSubmitStatus: "idle", reviewSubmitError: await submitErrorMessage(response) });
          return;
        }
        const data = (await response.json()) as { url?: string | null };
        // The review may have moved to another PR while awaiting; drop the SUBMITTED drafts from
        // the submitted key's storage either way, but only touch live state on the same review.
        // "" marks submitted-without-a-link, so the footer still confirms the submit happened.
        stripStoredComments(submittedKey, submittedIds);
        if (get().review?.context.reviewKey === submittedKey) {
          set({
            reviewSubmitStatus: "idle",
            reviewComments: get().reviewComments.filter((comment) => !submittedIds.has(comment.id)),
            reviewSubmittedUrl: data.url ?? "",
          });
        } else {
          set({ reviewSubmitStatus: "idle" });
        }
      } catch {
        set({ reviewSubmitStatus: "idle", reviewSubmitError: "could not reach the server" });
      }
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
      beginLensTransition(get, set);
      if (mode === "logic") {
        moduleLayoutSeq += 1;
        set({ viewMode: mode });
        return;
      }
      if (mode === "prs") {
        moduleLayoutSeq += 1;
        // Returning to the PRs lens ends the review session: the boot artifact comes back so the
        // list is browsed against the graph the session booted with. No relayout here — the PRs
        // page has no canvas, and re-entering a graph lens always lays out afresh.
        restorePrReviewBaseline(get, set, invalidateArtifactCaches);
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
      const showTests = !get().showTests;
      const { compSelectedId, compRoot, moduleSelected, viewMode, index } = get();
      const strandedById = (id: string | null) => !showTests && id !== null && index.testIds.has(id);
      set({
        showTests,
        compSelectedId: strandedById(compSelectedId) ? null : compSelectedId,
        compRoot: strandedById(compRoot) ? null : compRoot,
        moduleSelected: showTests ? moduleSelected : new Set([...moduleSelected].filter((id) => !index.testIds.has(id))),
      });
      // The module surfaces (Map / Service / UI) re-derive: test code can be half a level's cards
      // (and a wall of off-level test ghosts), and paint-hiding kept a crater of empty space —
      // moduleRelayout re-derives the level with testIds excluded, so the survivors compact.
      // Positions do move on this toggle, by design.
      if (moduleSurfaceSpec(viewMode) !== null) {
        void get().moduleRelayout({ label: showTests ? "Showing tests…" : "Hiding tests…" });
        // An open minimal overlay derives its ghost-satellite ring with the same hidden set, so the
        // toggle refreshes it too (else stale test satellites linger over the recomputed Map).
        if (get().minimalSeedIds.length > 0) {
          void get().minimalRelayout({ label: showTests ? "Showing tests…" : "Hiding tests…" });
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

    setEnvironment(environment) {
      set({ environment });
    },

    async refreshTelemetry() {
      const { provider, environment } = get();
      if (environment === null) {
        throw new Error("refreshTelemetry called before an environment was selected");
      }
      if (!provider) {
        return;
      }
      set({ telemetry: await provider.fetchMetrics(environment) });
    },

    // Hover previews have their own local lifecycle. Loading through this action reuses the exact
    // click-to-open source rules without mutating `codeView`, so hovering can never replace an open
    // modal. The preview component owns dwell, stale-result, and per-node caching behavior.
    async loadCodePreview(node) {
      const request = codeLoadRequest(node, undefined, get(), sourceUrl, prFileUrl);
      return request ? fetchCodeView(request, "inline", codePayloadCache) : null;
    },

    // Fetch and reveal a callable's source, starting inline on the node. Inert when the server
    // ships no source access or the node has no location. A race guard drops the result if a newer
    // click (a different node) has since taken over the view; the mode is preserved across the
    // fetch so a mid-flight expand-to-modal is not clobbered when the code lands.
    async showCode(node, opts) {
      const request = codeLoadRequest(node, opts, get(), sourceUrl, prFileUrl);
      if (!request) {
        return;
      }
      set({
        codeView: {
          node,
          code: null,
          loading: true,
          error: null,
          mode: "inline",
          baseLine: request.baseLine,
          wholeFile: request.wholeFile,
        },
      });
      const view = await fetchCodeView(request, "inline", codePayloadCache);
      if (get().codeView?.node.id !== node.id) {
        return;
      }
      // The reader may expand the loading inline panel before the response lands.
      set({ codeView: { ...view, mode: get().codeView?.mode ?? "inline" } });
    },

    // Blow the current inline panel up into the centered modal. A no-op when nothing is shown.
    expandCode() {
      const { codeView } = get();
      if (!codeView) {
        return;
      }
      set({ codeView: { ...codeView, mode: "modal" } });
    },

    closeCode() {
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

    async selectPr(number) {
      if (number !== null && !get().githubSource) {
        return;
      }
      const sequence = ++prFilesSeq;
      // Switching PRs abandons any review preparation in flight: bump its seq so a landing stream
      // is dropped, and clear the indicator so the panel never shows a stale progress/error card.
      get().cancelPrReviewPreparation();
      // Leaving the reviewed PR (a different number, or Back/Escape's null) ends the review
      // session: put the boot artifact back and re-lay the visible surface. A no-op outside one.
      if (restoreSelectedPrReview(get, set, invalidateArtifactCaches, bootReviewBaseline)) {
        void get().relayout();
      }
      const prepareReset = { prReviewStatus: "idle" as const, prPrepareStage: null, prPrepareError: null };
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
          void fetchPrDiscussion(prCommentsUrl, number).then(
            (discussion) => {
              if (prFilesSeq === sequence && get().prSelected === number) {
                set({ prDiscussion: { comments: discussion.comments, reviews: discussion.reviews } });
              }
            },
            () => {
              if (prFilesSeq === sequence && get().prSelected === number) {
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

    // Once the selected PR's files are ready, a capable web session PREPARES first while the PRs
    // page remains visible. Only the swapped PR-head graph is allowed to enter the Map. A plain
    // view (no analyze capability) retains the synchronous loaded-artifact entry path.
    async reviewPrInGraph() {
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
      const promise = get().prepareHeadGraph();
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
      applyPrReviewToMap(get, set, prFilesUrl, invalidateMinimalLayout);
    },

    // Re-open a review whose overlay was soft-closed (explicit Close/lens switch) — cheaply. The
    // expensive clone→checkout→extract NEVER re-runs here: a swapped review re-fetches its already-
    // prepared head artifact with one GET and re-swaps (against the SAME saved baseline); a sync
    // review keeps the boot artifact it never left. Then repaint the kept amber and reseed the
    // overlay from reviewAllSeedIds, rebuilding declaration-level expansion for those restored seeds.
    async resumePrReview() {
      const { prReviewed, minimalSeedIds, prPreparedGraphId, reviewAffectedIds, reviewAllSeedIds } = get();
      if (prReviewed === null || minimalSeedIds.length > 0) {
        return;
      }
      // A normal Code Flow may have been opened on the base Map after the review overlay soft-
      // closed. It belongs to that Map, not the resumed review/head artifact; clear it before any
      // possible artifact swap so only a flow selected inside the review enters review mode.
      const clearResumeFlow = () => {
        const staleFlowOpen = get().flowSelection !== null;
        flowPaneLayoutSeq += 1;
        set({
          flowSelection: null,
          logicSelected: null,
          flowPaneRfNodes: [],
          flowPaneRfEdges: [],
          flowPaneLayoutStatus: "idle",
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
      clearResumeFlow();
      if (prPreparedGraphId !== null) {
        const prepared = await fetchPreparedArtifact(get().graphUrl, prPreparedGraphId);
        if (get().prReviewed !== prReviewed || get().minimalSeedIds.length > 0) {
          return; // the review moved on (or resumed elsewhere) while the artifact was in flight.
        }
        // The base Map stayed interactive during the fetch. Clear once more so a Code Flow opened
        // in that window cannot ride the stale base-artifact ref across the head-graph swap.
        clearResumeFlow();
        swapToPreparedArtifact(get, set, prepared, invalidateArtifactCaches);
      }
      // Repaint the review's amber onto the current index — the soft close reset it to the boot
      // marking (and a re-swap built a fresh index). Same channel applyPrReviewToMap writes.
      applyChangedIds(get().index, [...reviewAffectedIds]);
      const resumedMatches = matchAffectedFiles(get().index, get().reviewFiles.map((file) => file.path)).matched;
      const resumedRollup = rollupSeeds(resumedMatches, get().index);
      set({
        viewMode: "modules",
        minimalSeedIds: reviewAllSeedIds,
        minimalMemberIds: [...reviewAllSeedIds],
        minimalRollups: rollupsRecord(resumedRollup.rolledUp),
        moduleExpanded: reviewExpansionForMatches(get().index, resumedMatches, resumedRollup.rolledUp),
        reviewActiveGroupId: null,
        reviewPanelHidden: false,
      });
      void get().minimalRelayout();
    },

    // Prepare-first entry (and the fallback review's manual "Extract head graph"): stream the
    // clone→checkout→extract analysis, SWAP the loaded artifact for the prepared head-accurate one,
    // then run the review so marking, seeds, and line diff all compute in HEAD coordinates. The
    // stale-seq + identity guards drop a canceled entry, PR switch, or PRs-lens exit.
    async prepareHeadGraph() {
      const state = get();
      const prNumber = state.prReviewed ?? state.prSelected;
      const enteringFromPrs = state.prReviewed === null;
      const summary = selectedPrSummary(state, prNumber);
      if (
        prNumber === null
        || analyzeUrl === null
        || analyzeGraphId === null
        || summary === null
        || (enteringFromPrs && state.viewMode !== "prs")
      ) {
        return;
      }
      // A direct manual re-run supersedes the prior action just like Retry does through
      // reviewPrInGraph; resolve its public waiter while its guarded stream drains.
      prAnalyzeCancellation?.resolve();
      const sequence = ++prAnalyzeSeq;
      let resolveCanceled!: () => void;
      const canceled = new Promise<void>((resolve) => {
        resolveCanceled = resolve;
      });
      const cancellation = { sequence, resolve: resolveCanceled };
      prAnalyzeCancellation = cancellation;
      const active = () => {
        const current = get();
        return prAnalyzeSeq === sequence
          && current.prSelected === prNumber
          && (enteringFromPrs
            ? current.viewMode === "prs" && current.prReviewed === null
            : current.prReviewed === prNumber);
      };
      set({
        prReviewStatus: "preparing",
        prPrepareStage: "clone",
        prPrepareError: null,
        prPreparedGraphId: null,
        prPreparedHeadSha: null,
        prReviewBlocked: null,
      });
      const work = (async () => {
        try {
          const request = { id: analyzeGraphId, prNumber, baseRef: summary.baseRef, headRef: summary.headRef };
          const analysis = await streamPrAnalysis(analyzeUrl, request, (stage) => {
            if (active()) {
              set({ prPrepareStage: stage });
            }
          });
          if (!active()) {
            return;
          }
          // SWAP: load the prepared PR-head artifact and make it the CURRENT graph BEFORE the review
          // body runs, so amber marking, seeds, and the line diff compute in HEAD coordinates.
          const prepared = await fetchPreparedArtifact(get().graphUrl, analysis.graphId);
          if (!active()) {
            return;
          }
          swapToPreparedArtifact(get, set, prepared, invalidateArtifactCaches);
          set({ prReviewStatus: "idle", prPrepareStage: null, prPrepareError: null, prPreparedGraphId: analysis.graphId, prPreparedHeadSha: analysis.headSha });
          const entered = applyPrReviewToMap(get, set, prFilesUrl, invalidateMinimalLayout);
          if (!entered) {
            // The zero-match decision was made against HEAD. Do not leak that unreviewed prepared
            // graph behind the PRs page (or replace an explicit base fallback that still matches).
            restorePrReviewBaseline(get, set, invalidateArtifactCaches, { endSession: enteringFromPrs });
            if (!enteringFromPrs) {
              set({ prPreparedGraphId: null, prPreparedHeadSha: null });
            }
          }
        } catch (error) {
          if (active()) {
            // Derivation after a successful fetch is still part of preparation. If it throws after
            // the swap, put the prior graph back before exposing the retry/fallback state.
            if (get().prPreparedArtifactCurrent) {
              restorePrReviewBaseline(get, set, invalidateArtifactCaches, { endSession: enteringFromPrs });
              if (!enteringFromPrs) {
                set({ prPreparedGraphId: null, prPreparedHeadSha: null });
              }
            }
            set({ prReviewStatus: "error", prPrepareStage: null, prPrepareError: prepareErrorMessage(error) });
          }
        }
      })();
      try {
        // Cancel resolves the public/blocking action immediately. `work` deliberately keeps
        // draining server output, but every landing point is fenced by `active()`.
        await Promise.race([work, canceled]);
      } finally {
        if (prAnalyzeCancellation === cancellation) {
          prAnalyzeCancellation = null;
        }
      }
    },

    cancelPrReviewPreparation() {
      prAnalyzeSeq += 1;
      const cancellation = prAnalyzeCancellation;
      prAnalyzeCancellation = null;
      cancellation?.resolve();
      set({ prReviewStatus: "idle", prPrepareStage: null, prPrepareError: null });
    },

    dismissPrepareError() {
      set({ prReviewStatus: "idle", prPrepareStage: null, prPrepareError: null });
    },

    async relayout() {
      // Post-unification, every graph lens with an ELK canvas is a module surface ("modules" /
      // "call" / "ui" — the registry decides): they all route through the ONE moduleRelayout.
      // Logic owns its own pass (logicRelayout) and the PRs page has no canvas.
      if (moduleSurfaceSpec(get().viewMode) !== null) {
        await get().moduleRelayout();
      }
    },
  }));
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
): boolean {
  const {
    prFiles,
    prSelected,
    prFilesTotal,
    prFilesOutside,
    artifact,
    index,
    prPreparedArtifactCurrent,
    prReviewBaseline,
  } = get();
  if (prSelected === null) {
    return false;
  }
  // "Swapped" == the loaded artifact IS the prepared PR-head graph: node locations are already
  // head-relative, so every base→head remap below must stand down (running it would corrupt an
  // already-correct coordinate space — the #134 machinery is for the base-graph sync mode only).
  const swapped = prPreparedArtifactCurrent;
  const summary = selectedPrSummary(get());
  const context = reviewContextFromPrFiles(
    {
      prNumber: prSelected,
      headRef: summary?.headRef ?? null,
      baseRef: summary?.baseRef ?? null,
      scopeId: prFilesUrl,
      files: prFiles ?? [],
    },
    // Base-side hunks mark base coordinates — right for the boot artifact, wrong for a head graph.
    { baseSide: !swapped },
  );
  // Derive the overlay's seeds before ANY lens or review mutation. An empty review remains on the
  // PR detail page, where the reader can re-extract and retry without losing the rest of the queue.
  const matchedFiles = matchAffectedFiles(index, context.changedFiles.map((file) => file.path)).matched;
  const { seeds, rolledUp } = rollupSeeds(matchedFiles, index);
  if (seeds.length === 0) {
    const allOutside = (prFiles?.length ?? 0) === 0 && prFilesOutside > 0;
    const changedFileCount = prFilesTotal > 0 ? prFilesTotal : (prFiles?.length ?? 0) + prFilesOutside;
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
  // This is a lens ENTRY (it lands on the Map lens below), so it owes the shared transition side
  // effects like every other entry point: a live Service scope must not survive into the review.
  beginLensTransition(get, set);
  const review = deriveReviewDataFromContext(context, artifact, index);
  // The files-first checklist: every changed file with its touched code units (the panel's primary
  // section). Derived from the SAME context/artifact as the affected set below, so a checked unit
  // corresponds 1:1 with an amber-ringed card.
  const files = deriveReviewFiles(context, artifact, index, {
    baseIndex: swapped ? (prReviewBaseline?.index ?? null) : null,
  });
  // The modified code blocks (hunks ∩ node ranges); repaint main's changed-node channel to THIS PR
  // so the Map + minimal overlay ring the edited blocks amber (reused `--changed-since` highlight).
  const affected = computeAffectedNodes(artifact.nodes, context.changedFiles);
  applyChangedIds(index, affected.map((node) => node.nodeId));
  // Colour each touched CODE BLOCK by its file's change kind (green added / gold modified / red
  // deleted). A file/module that only contains changes stays uncoloured — it shows a +/- stat instead.
  applyChangedStatus(index, affected.map((node) => [node.nodeId, node.status] as [string, ChangeStatus]));
  // Partition the change into disjoint groups (one per weakly-connected component of the changed
  // modules), sharing the SAME flow substrate the review rows already read. Stored so the rail can
  // offer per-group isolation; ignored (strip hidden) when the change is a single connected component.
  const changeGroups = computeChangeGroups(artifact.nodes, artifact.edges, context.changedFiles, review.flows);
  // GitHub's whole-file +N/-M churn per changed file, keyed by node.location.file, for the marker a
  // changed FILE card shows before its name (files aren't coloured; only their touched blocks are).
  const deltaByPath = new Map<string, { added: number; deleted: number; status: PrFileStatus }>(
    (prFiles ?? []).map((file) => [file.path, { added: file.additions, deleted: file.deletions, status: file.status }]),
  );
  const reviewFileDelta: Record<string, { added: number; deleted: number; status?: PrFileStatus }> = {};
  for (const match of matchedFiles) {
    const locFile = index.nodesById.get(match.moduleId)?.location?.file;
    const delta = deltaByPath.get(match.path);
    if (locFile && delta) {
      reviewFileDelta[locFile] = delta;
    }
  }
  // ONE source of truth for the line-level changedSince channel (the code panel's </> diff): the
  // artifact's OWN stamp when it carries one — the prepared PR-head artifact does, computed by the
  // extract pipeline from the real merge-base git diff, keyed by the extractor's own location.file
  // paths, with true added/modified/deleted span kinds and no truncation. The client-side join from
  // the GitHub patch hunks is strictly weaker (suffix-matched paths, "added"-only kinds, and it
  // silently misses files whenever the server capped the PR file list), so it remains only as the
  // fallback for a boot artifact that carries no stamp (the synchronous, no-analyze-endpoint path).
  const reviewedArtifact =
    changedRangesFromExtensions(artifact.extensions) !== null
      ? artifact
      : withPrLineDiff(artifact, index, context, matchedFiles, prSelected);
  // Pre-expand the packages and file modules on the path to each changed file (packages too,
  // else deriveModuleTree never descends to the file — mirrors flowExplorer's
  // expandedModulePaths): review reads at declaration level (class/type cards), so classes stay
  // collapsed "N members" cards and blocks never chart flow steps — drilling deeper stays a
  // manual gesture.
  const expanded = reviewExpansionForMatches(index, matchedFiles, rolledUp);
  invalidateMinimalLayout();
  // Capture the head ref + each changed file's real per-line diff (old/new spans + head-relative
  // added/modified lines), keyed by node.location.file, so opening a changed unit's </> fetches the
  // PR HEAD of that file and paints exactly its diff — code + highlight that match the PR, not base.
  // Keyed off the MATCHED node's location.file (same matching that seeds the graph), robust to any
  // path prefix. This is what makes the fast (synchronous) review show head code without re-extract.
  // SWAPPED mode carries neither field: node.location is already head-relative, so showCode's
  // headSpanFor remap must never run — it reads the local head checkout via activeSourceUrl instead.
  const reviewDiffByFile: Record<string, { edits: LineEdit[]; kinds: ChangedLineSpan[] }> = {};
  if (!swapped) {
    const diffByPath = new Map<string, { edits: LineEdit[]; kinds: ChangedLineSpan[] }>();
    for (const file of prFiles ?? []) {
      if (file.edits && file.edits.length > 0) {
        diffByPath.set(file.path, { edits: file.edits, kinds: file.kinds ?? [] });
      }
    }
    for (const match of matchedFiles) {
      const locFile = index.nodesById.get(match.moduleId)?.location?.file;
      const diff = diffByPath.get(match.path);
      if (locFile && diff) {
        reviewDiffByFile[locFile] = diff;
      }
    }
  }
  // Removed text is parsed from GitHub's patch in HEAD coordinates, so unlike the base→head edit
  // remap above it is valid in BOTH sync and swapped reviews. Join through the same matched module
  // path so the code panel can look it up with node.location.file in either graph.
  const reviewRemovedByFile: Record<string, { afterNewLine: number; lines: string[] }[]> = {};
  const reviewRemovedTruncatedByFile: Record<string, boolean> = {};
  const removedByPath = new Map((prFiles ?? []).map((file) => [file.path, file]));
  for (const match of matchedFiles) {
    const locFile = index.nodesById.get(match.moduleId)?.location?.file;
    const prFile = removedByPath.get(match.path);
    if (!locFile || !prFile) {
      continue;
    }
    if ((prFile.removed?.length ?? 0) > 0) {
      reviewRemovedByFile[locFile] = prFile.removed ?? [];
    }
    if (prFile.removedTruncated === true) {
      reviewRemovedTruncatedByFile[locFile] = true;
    }
  }
  const progress = readReviewProgress(context.reviewKey);
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
    reviewHeadRef: swapped ? null : summary?.headRef ?? null,
    reviewDiffByFile,
    reviewRemovedByFile,
    reviewRemovedTruncatedByFile,
    reviewTicks: progress.ticks,
    reviewUnitTicks: progress.unitTicks,
    reviewFileTicks: progress.fileTicks,
    reviewComments: progress.comments,
    reviewPanelHidden: false,
    reviewSubmitStatus: "idle",
    reviewSubmitError: null,
    reviewSubmittedUrl: null,
    reviewAffectedIds: new Set(affected.map((node) => node.nodeId)),
    reviewFiles: files,
    reviewFileDelta,
    reviewLitNodeIds: null,
    reviewSelectedId: null,
    flowSelection: null,
    logicSelected: null,
    flowPaneRfNodes: [],
    flowPaneRfEdges: [],
    flowPaneLayoutStatus: "idle",
    reviewFlowBaseline: null,
    reviewGroups: changeGroups,
    reviewActiveGroupId: null,
    reviewAllSeedIds: seeds,
    viewMode: "modules",
    moduleFocus: null,
    moduleSelected: new Set<string>(),
    moduleExpanded: expanded,
    minimalSeedIds: seeds,
    minimalMemberIds: [...seeds],
    minimalRollups: rollupsRecord(rolledUp),
    minimalBasePositions: {},
    minimalArrange: false,
    minimalRfNodes: [],
    minimalRfEdges: [],
    minimalLayoutStatus: seeds.length > 0 ? "laying-out" : "idle",
    minimalLayoutActivity: seeds.length > 0 ? { label: "Preparing review graph…" } : null,
  });
  // Lay out the underlying Map (correct if the reader closes the overlay) and, when seeded, the overlay.
  void get().moduleRelayout({ label: "Preparing review map…" });
  if (seeds.length > 0) {
    void get().minimalRelayout({ label: "Preparing review graph…" });
  }
  return true;
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
  invalidateArtifactCaches: () => void,
  bootBaseline: PrReviewBaseline,
): boolean {
  const state = get();
  if (state.prReviewed !== null && state.prReviewBaseline === null) {
    set({ prReviewBaseline: bootBaseline });
  }
  return restorePrReviewBaseline(get, set, invalidateArtifactCaches);
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
function beginLensTransition(get: BlueprintStore["getState"], set: (partial: Partial<BlueprintState>) => void): void {
  // Most lens entries route through setViewMode, but direct pivots (openLogicFlow,
  // openComposition, openServiceScope) call this helper themselves. They must abandon the same
  // prepare-first waiting lane before changing view. Successful prepared entry sets the lane idle
  // before it calls this helper, so its own PRs → Map transition is deliberately not canceled.
  if (get().viewMode === "prs" && get().prReviewStatus === "preparing") {
    get().cancelPrReviewPreparation();
  }
  if (get().minimalSeedIds.length > 0) {
    get().closeMinimalGraph();
  }
  const state = get();
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

function rollupsRecord(rolledUp: ReadonlyMap<string, string[]>): Record<string, string[]> {
  return Object.fromEntries([...rolledUp].map(([packageId, fileIds]) => [packageId, [...fileIds]]));
}

/** Declaration-level expansion for the current review seed set. Non-rolled files retain their full
 * package→file path; a rolled file stops at its summary package so nothing strictly inside opens. */
function reviewExpansionForMatches(
  index: GraphIndex,
  matched: readonly { moduleId: string }[],
  rolledUp: ReadonlyMap<string, readonly string[]>,
): Set<string> {
  const rolledPackageByFile = new Map<string, string>();
  for (const [packageId, fileIds] of rolledUp) {
    for (const fileId of fileIds) {
      rolledPackageByFile.set(fileId, packageId);
    }
  }
  const expanded = new Set<string>();
  for (const match of matched) {
    const rolledPackageId = rolledPackageByFile.get(match.moduleId);
    let insideRolledPackage = false;
    for (const ancestor of index.ancestorsOf(match.moduleId)) {
      if (ancestor.id === rolledPackageId) {
        insideRolledPackage = true;
      }
      if (
        (ancestor.kind === "package" || ancestor.kind === "module")
        && (!insideRolledPackage || ancestor.id === rolledPackageId)
      ) {
        expanded.add(ancestor.id);
      }
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

/** Exact dependency projection follows the same two review states as paint: the complete selected
 * flow while no resolvable pane node is selected, then only the selected node's incident edges.
 * External/unresolved pane calls leave `reviewSelectedId` null and honestly fall back to the whole
 * in-graph flow context. */
function flowInspectionIds(state: BlueprintState, flows: LogicFlows): ReadonlySet<string> | undefined {
  if (state.review === null || state.flowSelection === null || state.reviewFlowBaseline === null) {
    return undefined;
  }
  return state.reviewSelectedId === null
    ? relatedNodeIds(state.index, flows, state.flowSelection)
    : new Set([state.reviewSelectedId]);
}

function replaceRollupSeed(ids: readonly string[], packageId: string, fileIds: readonly string[]): string[] {
  if (!ids.includes(packageId)) {
    return [...ids];
  }
  return [...new Set(ids.flatMap((id) => (id === packageId ? fileIds : [id])))].sort();
}

/** Invert any expanded package→files substitutions while leaving ordinary seed ids untouched. */
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
  // A registered module surface (Map/Service/UI) shares one frontier read + expansion set; the
  // strict registry returns null for the logic lens, which keeps its own branch below.
  if (moduleSurfaceSpec(state.viewMode) !== null) {
    const scope = state.moduleSelected.size ? [...state.moduleSelected] : [null];
    const ids = pick(moduleTreeNodes(state, getGraph(), getDeps()), scope);
    if (ids.length === 0) {
      return;
    }
    set({ moduleExpanded: foldIds(state.moduleExpanded, ids, mode) });
    // `moduleExpanded` is shared with the minimal-graph overlay, so when it is open the scoped
    // expand/collapse must re-lay the overlay, not the covered Map — the same seam the in-place
    // toggle/expand/collapse actions route through.
    void relayoutActiveModuleSurface(get, activity);
  } else if (state.viewMode === "logic") {
    const ids = pick(logicVisibleNodes(state), [null]);
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

async function fetchPrDiscussion(baseUrl: string, number: number): Promise<PrDiscussionResult> {
  const url = new URL(baseUrl, requestOrigin());
  url.searchParams.set("n", String(number));
  const response = await fetch(url, { credentials: "same-origin" });
  if (!response.ok) {
    throw new Error("PR discussion unavailable");
  }
  return (await response.json()) as PrDiscussionResult;
}

async function fetchPrChecks(baseUrl: string, number: number, sha: string): Promise<PrChecks> {
  const url = new URL(baseUrl, requestOrigin());
  url.searchParams.set("n", String(number));
  url.searchParams.set("sha", sha);
  const response = await fetch(url, { credentials: "same-origin" });
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
