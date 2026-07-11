/**
 * The single zustand store. `moduleExpanded` starts EMPTY so only roots show (progressive
 * disclosure begins at the package/system level), and `environment` starts null and is NEVER
 * auto-set or defaulted to prod. Every structural mutation bumps its surface's layout sequence and
 * re-runs the derive pipeline behind a stale guard so a slow ELK pass can never overwrite a newer one.
 */

import { createStore, type StoreApi } from "zustand/vanilla";
import type { Edge, Node } from "@xyflow/react";
import { changedRangesFromExtensions, computeAffectedNodes, computeChangeGroups, computeCoverage, type ChangeStatus } from "@meridian/core";
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
import { leadIdOf } from "../derive/serviceClusterEdges";
import type { ModuleCategory } from "../derive/moduleCategory";
import type { HighlightMode } from "../components/moduleMapPaint";
import { activeModuleSurfaceSpec, moduleSurfaceSpec } from "../components/canvas/surfaceSpec";
import { readSolidMetricsPref, writeSolidMetricsPref } from "./solidMetricsPref";
import { moduleRevealStateFor, nearestModuleIds } from "./flowExplorer";
import { anchorNodeIds, mapRevealStateForMany, resolveServiceAnchors, serviceRevealStateForMany, uiRevealStateForMany } from "./lensPath";
import type { LogicRfNode, LogicRfEdge } from "../layout/logicElk";
import { PRS_UNAVAILABLE_ERROR, type LineEdit, type PrChangedFile, type PrFilesResponse, type PrListResponse, type PrSummary, type PrsTab } from "./prTypes";
import { headKindsWithin, headSpanFor } from "./headSpan";
import { streamPrAnalysis, type PrAnalyzeStage } from "./prAnalysis";
import {
  fetchPreparedArtifact,
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

/**
 * The "All" setting for the related-flows depth dial: a depth larger than any real call-graph chain.
 * `transitiveCallers`' BFS terminates when the frontier empties (no more callers to visit), so 99 ≡
 * "the entire transitive-caller closure" — it just never bottoms out on a real graph — with no perf
 * risk, since the walk is bounded by the callers that exist, not by this number.
 */
export const GHOST_DEPTH_ALL = 99;

export type LayoutStatus = "idle" | "laying-out" | "ready" | "error";

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
  /** The laid-out Logic graph (React Flow), recomputed on open/drill/expand/toggle via ELK. */
  logicRfNodes: LogicRfNode[];
  logicRfEdges: LogicRfEdge[];
  logicLayoutStatus: LayoutStatus;
  /** The selected composition unit id; null == none. A repaint-only highlight — no relayout. */
  compSelectedId: string | null;
  /** EXPERIMENT: the callable method whose logic flow is previewed in the composition-tab side
   * drawer; null == the drawer is closed. Picked by clicking a scorecard member. Its flow is laid
   * out into `compMethodRf*` behind the `compMethodLayoutSeq` stale guard, mirroring logicRelayout. */
  compMethodId: NodeId | null;
  compMethodRfNodes: LogicRfNode[];
  compMethodRfEdges: LogicRfEdge[];
  compMethodLayoutStatus: LayoutStatus;
  /** The module/package the Service-composition tab is rooted at; null == the whole system. Defaults
   * to the app's first entry module. Only its subtree + 1-hop coupling neighbours are drawn. */
  compRoot: string | null;
  /** The package cards the AGGREGATED composition view has inline-expanded — each renders as a
   * frame holding the next level (sub-package cards / unit scorecards) instead of one summary card.
   * Reset on re-root: a new root is a fresh aggregation altitude. */
  compExpanded: ReadonlySet<string>;
  /** Whether the composition scorecards show their SOLID metric rows + smell chips. Off == a
   * structure-only view (kind + name), decluttered. Persisted to localStorage across reloads. */
  showSolidMetrics: boolean;
  /** The laid-out Module-map LEVEL graph (one containment level, ELK-laid), recomputed whenever the
   * "modules" lens is (re)entered or the focus changes. */
  moduleRfNodes: Node[];
  moduleRfEdges: Edge[];
  moduleLayoutStatus: LayoutStatus;
  /** The package/directory node the Module map is zoomed INTO; null == the whole-repo package overview
   * (level 0). Double-clicking a group card descends; the breadcrumb ascends. */
  moduleFocus: string | null;
  /** The node actually rendered from after chain-collapse (a single-child chain auto-descends); null
   * == the overview. Read by the surface for the containment breadcrumb. */
  moduleEffectiveFocus: string | null;
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
  /** The ORIGIN of the OPEN minimal-graph overlay: the raw selection ids (any kind), verbatim; empty
   * == the overlay is closed and the Module-map level canvas shows. Immutable per build — it is the
   * seed-tier baseline and the Reset target. URL-synced as `mgraph`. */
  minimalSeedIds: string[];
  /** The mutable working set of MEMBERS shown in the overlay (starts = origin). Promoting a ghost adds
   * to it; removing a member drops from it. Ghosts are the members' on-map 1-hop ring, derived (not
   * stored). Reset restores it to the origin. */
  minimalMemberIds: string[];
  /** The Module map's on-screen card positions, captured (absolute) when the overlay is BUILT, so the
   * overlay mirrors them: a captured card sits at its exact map spot, growth is placed around it.
   * Captured once at build (never on curation) so placed cards never jump; cleared on close. */
  minimalBasePositions: Record<string, PlacedRect>;
  /** When true, the overlay ABANDONS the captured map-mirror and lays the current cards out fresh with a
   * tidy left→right ELK pass (the "Re-arrange" action) — the fix for members that mirror far-apart map
   * spots. Stays on (so promote/demote keep the tidy layout) until the overlay is rebuilt or closed. */
  minimalArrange: boolean;
  /** The laid-out minimal subgraph for the overlay (flat, mirroring the map), under its own stale-seq guard. */
  minimalRfNodes: Node[];
  minimalRfEdges: Edge[];
  minimalLayoutStatus: LayoutStatus;
  /** The parsed PR-review data (affected-flow rows + flow trees); null hides the review surface.
   * Sourced EITHER from a `meridian review` artifact extension, OR built at runtime from a GitHub PR
   * (selectPr → reviewPrInGraph). */
  review: ReviewData | null;
  /** Artifact node ids that are affected — the coupling set between the graph and the flow panel. */
  reviewAffectedIds: Set<string>;
  /** Every changed file as a checklist row (touched units inside; empty units == not in the graph). */
  reviewFiles: ReviewFileRow[];
  /** Per changed file (keyed by node.location.file): GitHub's +N/-M churn, shown as a marker before
   * the file card's name (files themselves are not coloured — only the touched blocks inside are). */
  reviewFileDelta: Record<string, { added: number; deleted: number }>;
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
  /** PR API endpoints derived from the graph artifact URL; 404/network means this session lacks PRs. */
  prsUrl: string;
  prFilesUrl: string;
  prsTab: PrsTab;
  prsList: Record<PrsTab, PrSummary[] | null>;
  prsHasMore: Record<PrsTab, boolean>;
  prsLoading: boolean;
  prsError: string | null;
  prSelected: number | null;
  prFiles: PrChangedFile[] | null;
  prFilesTruncated: boolean;
  /** The PR whose changed files are currently highlighted in the graph (via "review in graph"). */
  prReviewed: number | null;
  /** Head ref of the PR under review — the code panel fetches changed files at this ref. Null off-review. */
  reviewHeadRef: string | null;
  /** Per changed file (keyed by node.location.file): the PR diff needed to slice + paint the head code. */
  reviewDiffByFile: Record<string, { edits: LineEdit[]; kinds: ChangedLineSpan[] }>;
  /** The review-PREPARATION lane: "preparing" while the server streams the clone→checkout→extract
   * analysis of the PR head; "error" when that stream failed (the panel offers Retry); else "idle". */
  prReviewStatus: "idle" | "preparing" | "error";
  /** The analyze stage currently running server-side; null outside "preparing". */
  prPrepareStage: PrAnalyzeStage | null;
  /** Why preparation failed; null outside "error". */
  prPrepareError: string | null;
  /** The server-side graph id of the prepared PR-head artifact (the analyze stream's "done"
   * payload). The streamed review swaps the loaded artifact to it via `graphUrl`. */
  prPreparedGraphId: string | null;
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
  logicRelayout(): Promise<void>;
  selectCompUnit(id: string | null): void;
  selectCompMethod(id: NodeId | null): void;
  compMethodRelayout(): Promise<void>;
  setCompRoot(id: string | null): void;
  toggleCompExpand(id: string): void;
  toggleSolidMetrics(): void;
  moduleRelayout(): Promise<void>;
  setModuleFocus(id: string | null): void;
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
  buildMinimalGraph(): void;
  closeMinimalGraph(): void;
  demoteMinimalMember(id: string): void;
  resetMinimalGraph(): void;
  rearrangeMinimalGraph(): void;
  minimalRelayout(): Promise<void>;
  setReviewLit(ids: Set<string> | null): void;
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
  addReviewComment(path: string, nodeId: string | null, body: string): void;
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
  showCode(node: GraphNode, opts?: { wholeFile?: boolean }): Promise<void>;
  expandCode(): void;
  closeCode(): void;
  setPrsTab(tab: PrsTab): void;
  loadPrs(page?: number): Promise<void>;
  selectPr(number: number | null): Promise<void>;
  reviewPrInGraph(): Promise<void>;
  relayout(): Promise<void>;
}

export interface StoreDependencies {
  artifact: GraphArtifact;
  index: GraphIndex;
  provider: TelemetryProvider | null;
  hasOverlay: boolean;
  sourceUrl: string | null;
  prsUrl: string;
  prFilesUrl: string;
  /** GET base for one changed file's text at the PR head ref (the review code panel's head-fetch). */
  prFileUrl?: string;
  /** POST endpoint for PR-head preparation. Null/absent (a plain `view` session, or an older
   * server) makes reviewPrInGraph skip streaming and review the loaded artifact synchronously. */
  analyzeUrl?: string | null;
  /** The current GitHub artifact id — the analyze POST body's `id`. */
  graphId?: string | null;
  /** The graph-fetch URL; wave 2 loads the prepared PR artifact from it by swapping the id. */
  graphUrl?: string;
  /** POST target for submitting review comments (web sessions only; 404s elsewhere). */
  prReviewUrl: string;
}

export type BlueprintStore = StoreApi<BlueprintState>;

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
  // And for the composition-tab method-preview drawer's logic layout (the EXPERIMENT surface).
  let compMethodLayoutSeq = 0;
  // Same guard for the Code flows explorer's embedded flow preview pane.
  let flowPaneLayoutSeq = 0;
  // PR list/file fetches and PR-head preparation are independent async lanes; newer requests win
  // when the reader switches PRs (or re-clicks Review) mid-stream.
  let prsListSeq = 0;
  let prFilesSeq = 0;
  let prAnalyzeSeq = 0;
  const prsNextPage: Record<PrsTab, number> = { open: 1, closed: 1 };
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
    invalidateMinimalLayout();
  };
  // The parsed review payload from a `meridian review` artifact (null when the artifact carries no
  // valid `review` extension — e.g. a plain `web`/`view` session). Computed once (the artifact never
  // changes after boot); a GitHub PR opened via reviewPrInGraph can later populate `review` at runtime.
  const review = deriveReviewData(dependencies.artifact, dependencies.index);
  // The files checklist + persisted progress for an artifact-sourced review; a GitHub PR opened via
  // reviewPrInGraph re-derives both at runtime under its own reviewKey.
  const reviewFiles = review ? deriveReviewFiles(review.context, dependencies.artifact, dependencies.index) : [];
  const initialProgress = review ? readReviewProgress(review.context.reviewKey) : null;
  // Null when the server didn't ship source access — the code drawer is then inert.
  const sourceUrl = dependencies.sourceUrl;
  const prsUrl = dependencies.prsUrl;
  const prFilesUrl = dependencies.prFilesUrl;
  const prFileUrl = dependencies.prFileUrl ?? null;
  // Null when the server can't prepare a PR head (no analyze route, or no stored GitHub artifact);
  // reviewPrInGraph then falls back to the synchronous loaded-artifact review.
  const analyzeUrl = dependencies.analyzeUrl ?? null;
  const analyzeGraphId = dependencies.graphId ?? null;
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
    logicRfNodes: [],
    logicRfEdges: [],
    logicLayoutStatus: "idle",
    compSelectedId: null,
    compMethodId: null,
    compMethodRfNodes: [],
    compMethodRfEdges: [],
    compMethodLayoutStatus: "idle",
    compRoot: defaultCompRoot,
    compExpanded: new Set<string>(),
    showSolidMetrics: readSolidMetricsPref(),
    moduleRfNodes: [],
    moduleRfEdges: [],
    moduleLayoutStatus: "idle",
    moduleFocus: null,
    moduleEffectiveFocus: null,
    moduleRadius: 1,
    highlightMode: "node",
    showHighways: true,
    showCommons: true,
    hiddenCategories: new Set<ModuleCategory>(),
    hiddenRelKinds: new Set<string>(),
    moduleSelected: new Set<string>(),
    moduleExpanded: new Set<string>(),
    mapExtra: new Set<string>(),
    showPrivate: true,
    serviceScope: null,
    minimalSeedIds: [],
    minimalMemberIds: [],
    minimalBasePositions: {},
    minimalArrange: false,
    minimalRfNodes: [],
    minimalRfEdges: [],
    minimalLayoutStatus: "idle",
    review,
    reviewAffectedIds: new Set(reviewFiles.flatMap((file) => file.units.map((unit) => unit.nodeId))),
    reviewFiles,
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
    prsUrl,
    prFilesUrl,
    prsTab: "open",
    prsList: { open: null, closed: null },
    prsHasMore: { open: false, closed: false },
    prsLoading: false,
    prsError: null,
    prSelected: null,
    prFiles: null,
    prFilesTruncated: false,
    prReviewed: null,
    reviewHeadRef: null,
    reviewDiffByFile: {},
    prReviewStatus: "idle",
    prPrepareStage: null,
    prPrepareError: null,
    prPreparedGraphId: null,
    prReviewBaseline: null,
    graphUrl: dependencies.graphUrl ?? "",
    codeView: null,

    // Reveal one more containment level, scoped to the current selection (or the whole view when
    // nothing is selected). Each surface reads its own visible frontier + selection and folds the
    // ids scopedExpansion picks into its own expansion set — see applyScoped below.
    expandAll() {
      applyScoped(get, set, () => (moduleGraph ??= buildModuleGraph(get().index)), () => (blockDeps ??= buildBlockDeps(get().index)), idsToExpand, "open");
    },

    // Fully collapse the same scope: close every open container within it in one click.
    collapseAll() {
      applyScoped(get, set, () => (moduleGraph ??= buildModuleGraph(get().index)), () => (blockDeps ??= buildBlockDeps(get().index)), idsToCollapse, "close");
    },

    // Bump the recenter signal so the active graph surface re-fits its viewport (to the current
    // selection, or the whole graph if none). A pure signal — no relayout, no navigation change; the
    // surface reads the value change via useRecenter and calls React Flow's fitView.
    recenter() {
      set({ recenterSeq: get().recenterSeq + 1 });
    },

    toggleFlowExplorer() {
      const flowExplorerOpen = !get().flowExplorerOpen;
      set(flowExplorerOpen
        ? { flowExplorerOpen }
        : {
            flowExplorerOpen,
            flowSelection: null,
            flowPaneRfNodes: [],
            flowPaneRfEdges: [],
            flowPaneLayoutStatus: "idle",
          });
    },

    selectFlowEntry(ref) {
      if (ref === null) {
        set({
          flowSelection: null,
          flowPaneRfNodes: [],
          flowPaneRfEdges: [],
          flowPaneLayoutStatus: "idle",
        });
        return;
      }
      const { artifact, index, viewMode } = get();
      const flows = (artifact.extensions?.logicFlow ?? {}) as unknown as LogicFlows;
      const related = relatedNodeIds(index, flows, ref);
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
          void get().moduleRelayout();
        } else {
          set({ moduleSelected: new Set<string>() });
        }
      }
      void get().flowPaneRelayout();
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
      if (flowPaneLayoutSeq !== sequence) {
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
      beginLensTransition(get, set);
      set({ viewMode: "logic", logicRoot: nodeId, logicStack: [nodeId], logicFocus: [], logicSelected: null, expandedLogic: new Set<string>() });
      void get().logicRelayout();
    },

    // The logic→composition link: a call block's owning-unit chip opens the Service lens HERE with
    // the unit revealed on canvas AND rooted/selected in the composition side panel, so a reader can
    // pivot from "who calls this" to "how healthy is the unit it lives in".
    openComposition(unitId) {
      beginLensTransition(get, set);
      const reveal = serviceRevealStateForMany([unitId], get().index);
      set({ viewMode: "call", compRoot: unitId, compExpanded: new Set<string>(), compSelectedId: unitId, mapExtra: new Set<string>(), ...(reveal ?? MODULE_TOP_LEVEL) });
      void get().moduleRelayout();
    },

    // Drill from a call node into its target's own flow — push it onto the trail, re-chart from it.
    // A changed callable starts unfocused, so any container dive is dropped.
    drillLogicFlow(nodeId) {
      set({ logicStack: [...get().logicStack, nodeId], logicRoot: nodeId, logicFocus: [], logicSelected: null, expandedLogic: new Set<string>() });
      void get().logicRelayout();
    },

    // Jump back to an earlier callable in the trail (a logic-breadcrumb click), truncating there.
    // Clears any container dive — returning to a callable crumb shows its full flow.
    logicFlowTo(nodeId) {
      const index = get().logicStack.indexOf(nodeId);
      if (index === -1) {
        return;
      }
      set({ logicStack: get().logicStack.slice(0, index + 1), logicRoot: nodeId, logicFocus: [], logicSelected: null, expandedLogic: new Set<string>() });
      void get().logicRelayout();
    },

    // Dive INTO a control container (loop/try): re-chart the canvas to show ONLY its bodies as a
    // focused sub-view, the breadcrumb gaining a segment. Push it, reset expansion, relayout.
    diveLogicContainer(id, label, bodies) {
      set({ logicFocus: [...get().logicFocus, { id, label, bodies }], logicSelected: null, expandedLogic: new Set<string>() });
      void get().logicRelayout();
    },

    // Jump back along the container-dive trail (a focus-breadcrumb click): truncate to `index + 1`;
    // a negative index clears focus entirely, back to the full callable flow. Reset, relayout.
    logicFocusTo(index) {
      set({ logicFocus: index < 0 ? [] : get().logicFocus.slice(0, index + 1), logicSelected: null, expandedLogic: new Set<string>() });
      void get().logicRelayout();
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
      set({ expandedLogic: withToggled(get().expandedLogic, nodeId) });
      void get().logicRelayout();
    },

    // Toggle hiding the greyed (non-expandable) building-block leaves — the library/leaf calls.
    toggleHideGreyed() {
      set({ hideGreyed: !get().hideGreyed });
      void get().logicRelayout();
    },

    // Toggle the service-frame nesting — flat blocks (default) vs consecutive same-owner calls grouped
    // under service frames. Mirrors toggleHideGreyed: flip the flag, then re-lay out the graph.
    toggleNestByService() {
      set({ nestByService: !get().nestByService });
      void get().logicRelayout();
    },

    // Re-derive the Logic graph for the current root through ELK, behind a stale-seq guard (a newer
    // open/drill/toggle discards an older in-flight layout). A null root clears the graph.
    async logicRelayout() {
      const { logicRoot, index, artifact, expandedLogic, hideGreyed, nestByService, logicFocus } = get();
      if (logicRoot === null) {
        set({ logicRfNodes: [], logicRfEdges: [], logicLayoutStatus: "idle" });
        return;
      }
      const flows = (artifact.extensions?.logicFlow ?? {}) as unknown as LogicFlows;
      const sequence = ++logicLayoutSeq;
      set({ logicLayoutStatus: "laying-out" });
      // A container dive charts only the TOP focus entry's bodies; else the whole callable flow.
      const top = logicFocus[logicFocus.length - 1];
      const focus = top ? { id: top.id, bodies: top.bodies } : undefined;
      const graph = await deriveLogicLayout(logicRoot, flows, index, expandedLogic, { hideGreyed, nestByService }, focus);
      if (logicLayoutSeq !== sequence) {
        return; // a newer layout superseded this one.
      }
      set({ logicRfNodes: graph.nodes, logicRfEdges: graph.edges, logicLayoutStatus: "ready" });
    },

    // Select a composition unit (pass null to clear). The view renders straight from the laid-out
    // graph, so this needs no relayout — it only repaints the highlight.
    selectCompUnit(id) {
      set({ compSelectedId: id });
    },

    // EXPERIMENT — the composition→logic PREVIEW link. Pick (or clear with null) the method whose
    // logic flow the side drawer charts, WITHOUT leaving the composition tab. A single click on a
    // scorecard member fires this; it's a preview within the tab, not a tab switch (double-click a
    // member still navigates to the full Logic tab). Kicks the drawer's own ELK relayout.
    selectCompMethod(id) {
      if (get().compMethodId === id) {
        return;
      }
      set({ compMethodId: id });
      void get().compMethodRelayout();
    },

    // Lay out the previewed method's logic flow into `compMethodRf*`, behind the compMethodLayoutSeq
    // stale guard (a newer pick discards an older in-flight ELK pass), exactly like logicRelayout.
    // Reuses the Logic-tab derive with a fresh (all-default) expansion, greyed leaves shown, and no
    // service nesting — the preview is a fixed at-a-glance read, not the interactive Logic surface. A
    // null pick (drawer closed) clears the arrays.
    async compMethodRelayout() {
      const { compMethodId, index, artifact } = get();
      if (compMethodId === null) {
        set({ compMethodRfNodes: [], compMethodRfEdges: [], compMethodLayoutStatus: "idle" });
        return;
      }
      const flows = (artifact.extensions?.logicFlow ?? {}) as unknown as LogicFlows;
      const sequence = ++compMethodLayoutSeq;
      set({ compMethodLayoutStatus: "laying-out" });
      const graph = await deriveLogicLayout(compMethodId, flows, index, new Set<string>(), { hideGreyed: false, nestByService: false });
      if (compMethodLayoutSeq !== sequence) {
        return; // a newer pick superseded this one.
      }
      set({ compMethodRfNodes: graph.nodes, compMethodRfEdges: graph.edges, compMethodLayoutStatus: "ready" });
    },

    // Re-root the Service-composition side panel at a module/package (null == whole system). Clears
    // the selection, the code view, the aggregate-expand set, and the method-preview drawer — none
    // carry meaning in a new rooted view. When the root is unchanged it still clears the stale
    // selection + code so navigation always returns to the graph first.
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
      set({ compRoot: id, compExpanded: new Set<string>(), compSelectedId: null, compMethodId: null, compMethodRfNodes: [], compMethodRfEdges: [], compMethodLayoutStatus: "idle", codeView: null });
    },

    // Inline-expand / collapse a package card in the AGGREGATED composition panel: an expanded
    // package renders as a frame holding the next level while the rest of the overview stays put.
    toggleCompExpand(id) {
      const next = new Set(get().compExpanded);
      if (!next.delete(id)) {
        next.add(id);
      }
      set({ compExpanded: next });
    },

    // Show/hide the per-card SOLID metrics (metric rows + smell chips) on the composition scorecards.
    // Persisted across reloads.
    toggleSolidMetrics() {
      const next = !get().showSolidMetrics;
      writeSolidMetricsPref(next);
      set({ showSolidMetrics: next });
    },

    // Re-derive the Module-surface LEVEL through ELK, behind the same stale-seq guard. BOTH lenses
    // write this slice: the surface's SurfaceSpec derives the tree — the "call" lens a
    // SERVICE-CLUSTER tree (no zoom/focus), "modules" the folder containment level for the current
    // focus. The import graph is built once (cached) and reused for every level.
    async moduleRelayout() {
      const state = get();
      const sequence = ++moduleLayoutSeq;
      set({ moduleLayoutStatus: "laying-out" });
      const graph = (moduleGraph ??= buildModuleGraph(state.index));
      const deps = (blockDeps ??= buildBlockDeps(state.index));
      const flows = (state.artifact.extensions?.logicFlow ?? {}) as unknown as LogicFlows;
      // Hidden tests are EXCLUDED from the layout (not just painted out): test code can be half the
      // cards, and paint-hiding it kept a crater of empty space. toggleShowTests relayouts this lens.
      // (The Service tree applies the hidden set to its GHOST tier only — cluster members still
      // hide at paint time, exactly as its old branch did. The Commons toggle rides in as part of
      // `state`: the Map's spec threads `showCommons` into its hub demotion; Service/UI ignore it.)
      const hidden = state.showTests ? EMPTY_HIDDEN_IDS : state.index.testIds;
      const tree = activeModuleSurfaceSpec(state.viewMode).deriveTree(state, { graph, deps, flows }, { extraIds: state.mapExtra, hiddenIds: hidden });
      const laid = await layoutModuleTree(tree.nodes, tree.edges);
      if (moduleLayoutSeq !== sequence) {
        return; // a newer focus change superseded this one.
      }
      set({
        moduleRfNodes: laid.nodes,
        moduleRfEdges: laid.edges,
        moduleEffectiveFocus: tree.effectiveFocus,
        moduleLayoutStatus: "ready",
      });
    },

    // Zoom the Module map into a package/directory (null == back to the whole-repo overview). Clears
    // the selection (it means nothing at a new level) and re-lays out. A no-op when already there.
    setModuleFocus(id) {
      if (get().moduleFocus === id) {
        return;
      }
      // A new level is a fresh id space, so the prior expansion set means nothing here — clear it so
      // the new level opens with only its frontier shown (mirrors logic's reset-on-drill).
      set({ moduleFocus: id, moduleSelected: new Set<string>(), moduleExpanded: new Set<string>(), mapExtra: new Set<string>() });
      void get().moduleRelayout();
    },

    // Expand/collapse a card of the module surface IN PLACE (the service tab's cluster frames, the
    // Map's inline file/block expansions). A relayout concern — the canvas gains/loses nested cards.
    toggleModuleExpand(nodeId) {
      set({ moduleExpanded: withToggled(get().moduleExpanded, nodeId) });
      void relayoutActiveModuleSurface(get);
    },

    // REVEAL a code node the reader can't see (a ghost card's real definition): refocus the Map at
    // the directory it lives in, with its file/unit chain expanded so the symbol is actually drawn.
    // The Map-native "go to definition" — a deliberate focus jump, so prior expansions reset like
    // any setModuleFocus navigation.
    revealModule(nodeId) {
      const ancestors = get().index.ancestorsOf(nodeId);
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
      void get().moduleRelayout();
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
      const { index, moduleExpanded, moduleFocus, serviceScope } = get();
      const resolution = resolveServiceAnchors([nodeId], index);
      if (resolution === null) {
        set({ moduleSelected: new Set([nodeId]) });
        return;
      }
      const focusLead = moduleFocus === null ? null : leadIdOf(moduleFocus);
      const staysInFocus = focusLead !== null && resolution.owningLeads.every((lead) => lead === focusLead);
      const expanded = new Set([...moduleExpanded, ...resolution.reveal.moduleExpanded]);
      if (!staysInFocus && focusLead !== null && moduleFocus !== null) {
        expanded.add(moduleFocus);
      }
      set({
        moduleFocus: staysInFocus ? moduleFocus : null,
        serviceScope: widenServiceScope(serviceScope, resolution.owningLeads),
        moduleExpanded: expanded,
        moduleSelected: resolution.reveal.moduleSelected,
      });
      // `moduleExpanded` is shared with the minimal overlay; when one covers this lens the reveal
      // must re-lay the overlay the reader can see, not the Map beneath it.
      void relayoutActiveModuleSurface(get);
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
        const card = resolveCard(rawId);
        set({ mapExtra: new Set(get().mapExtra).add(card), moduleSelected: new Set([card]) });
        void get().moduleRelayout();
      }
    },

    // ⌘P palette "+": pin a picked symbol's owning card (unit/file) INTO the current map lens WITHOUT
    // navigating — a scratch card unioned into the next relayout. A no-op when already pinned or off a
    // map lens. All module lenses share `mapExtra`, so the same pin surfaces in each.
    addToView(rawId) {
      const viewMode = get().viewMode;
      if (moduleSurfaceSpec(viewMode) === null) {
        return;
      }
      const card = resolveCard(rawId);
      if (!get().mapExtra.has(card)) {
        set({ mapExtra: new Set(get().mapExtra).add(card) });
        void get().moduleRelayout();
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
        void get().minimalRelayout();
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
      void get().moduleRelayout();
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
      void relayoutActiveModuleSurface(get);
    },

    // Collapse only direct child package/file/unit/block frames; deeper expansion ids deliberately
    // remain, so re-opening a parent restores the reader's deeper manual state.
    collapseModuleChildren(containerId) {
      const state = get();
      const nodes = moduleTreeNodes(state, (moduleGraph ??= buildModuleGraph(state.index)), (blockDeps ??= buildBlockDeps(state.index)));
      const expanded = new Set(state.moduleExpanded);
      moduleChildContainerIds({ nodes }, containerId).forEach((id) => expanded.delete(id));
      set({ moduleExpanded: expanded });
      void relayoutActiveModuleSurface(get);
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
      set({ showCommons: !get().showCommons });
      void get().moduleRelayout();
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
      set({ moduleSelected: id === null ? new Set<string>() : new Set([id]) });
    },

    // The "Extract selection" action: EXTRACT the current selection verbatim (any kind — a selected
    // package stays ONE card) as the overlay's members/origin, and open on their curated subgraph
    // (members + their on-map 1-hop ghost ring). A fresh build discards any prior curation. Inert when
    // nothing is selected.
    buildMinimalGraph() {
      // The active surface's spec decides how a selection seeds the overlay: identity on the Map,
      // while the Service lens decomposes a selected `svc:` frame into its cluster's member units.
      const origin = activeModuleSurfaceSpec(get().viewMode).minimalSeeds([...get().moduleSelected], get().index);
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
              reviewGroups: null,
              reviewActiveGroupId: null,
              reviewAllSeedIds: [] as string[],
              reviewSubmitStatus: "idle" as const,
              reviewSubmitError: null,
              reviewSubmittedUrl: null,
              reviewHeadRef: null,
              reviewDiffByFile: {} as Record<string, { edits: LineEdit[]; kinds: ChangedLineSpan[] }>,
            }
          : {};
      set({ minimalSeedIds: origin, minimalMemberIds: origin, minimalBasePositions: captureMapPositions(get().moduleRfNodes), minimalArrange: false, prReviewed: null, ...clearPrReview });
      void get().minimalRelayout();
    },

    // Close the overlay back to the Module-map level canvas. The selection is kept, so the reader
    // can adjust it and rebuild without re-picking every card. Bumping the seq discards any ELK
    // pass still in flight, so a slow layout can't repopulate the arrays after the close.
    closeMinimalGraph() {
      minimalLayoutSeq += 1;
      set({ minimalSeedIds: [], minimalMemberIds: [], minimalBasePositions: {}, minimalArrange: false, minimalRfNodes: [], minimalRfEdges: [], minimalLayoutStatus: "idle" });
    },

    // Remove a MEMBER (the members-panel ✕); it reappears as a satellite iff a remaining member still
    // couples to its code. Refuses to empty the set — the last member must stay so the overlay never
    // goes blank.
    demoteMinimalMember(id) {
      const { minimalMemberIds } = get();
      if (!minimalMemberIds.includes(id) || minimalMemberIds.length <= 1) {
        return;
      }
      set({ minimalMemberIds: minimalMemberIds.filter((member) => member !== id) });
      void get().minimalRelayout();
    },

    // Reset the overlay to its base: restore the working set to the origin selection AND drop any
    // re-arrangement (back to the captured map-mirror). A no-op when already at the origin and mirror.
    resetMinimalGraph() {
      const { minimalSeedIds, minimalMemberIds, minimalArrange } = get();
      if (sameMembers(minimalMemberIds, minimalSeedIds) && !minimalArrange) {
        return;
      }
      set({ minimalMemberIds: [...minimalSeedIds], minimalArrange: false });
      void get().minimalRelayout();
    },

    // Re-arrange: drop the captured map-mirror and lay the current cards out fresh (tidy left→right ELK),
    // so members that mirror far-apart map spots snap into a compact, in-view graph. Stays on so later
    // curation keeps the tidy layout. A no-op when already arranged.
    rearrangeMinimalGraph() {
      if (get().minimalArrange) {
        return;
      }
      set({ minimalArrange: true });
      void get().minimalRelayout();
    },

    // Lay out the overlay's curated subgraph (members + their ghost-satellite ring) through the
    // shared minimal-graph pass, behind its own stale-seq guard. `minimalArrange` picks the fresh
    // ELK layout over the map-mirror; hidden tests drop out of the ring like on the Map beneath.
    async minimalRelayout() {
      const { index, minimalSeedIds, minimalMemberIds, minimalBasePositions, minimalArrange, moduleExpanded, artifact, showTests } = get();
      if (minimalMemberIds.length === 0) {
        return;
      }
      moduleGraph ??= buildModuleGraph(index);
      const deps = (blockDeps ??= buildBlockDeps(index));
      const flows = (artifact.extensions?.logicFlow ?? {}) as unknown as LogicFlows;
      const hidden = showTests ? EMPTY_HIDDEN_IDS : index.testIds;
      const sequence = ++minimalLayoutSeq;
      set({ minimalLayoutStatus: "laying-out" });
      const layout = await deriveMinimalGraphLayout(index, moduleGraph, new Set(minimalMemberIds), new Set(minimalSeedIds), minimalBasePositions, {
        moduleExpanded,
        blockDeps: deps,
        flows,
      }, minimalArrange, hidden);
      if (minimalLayoutSeq !== sequence) {
        return; // a newer build/promote/demote/reset/re-arrange superseded this one.
      }
      set({ minimalRfNodes: layout.nodes, minimalRfEdges: layout.edges, minimalLayoutStatus: "ready" });
    },

    // Flip one Module-map node in/out of the selection WITHOUT touching the rest — the ctrl/cmd+click
    // gesture that accumulates a multi-selection. Repaint-only, like selectModule.
    toggleModuleSelect(id) {
      set({ moduleSelected: withToggled(get().moduleSelected, id) });
    },

    // Scope the Service lens to the current anchors' owning cluster(s) plus every cluster coupled
    // to them in EITHER direction (1-hop). Enters the lens DIRECTLY — going through setViewMode
    // would clear the very scope this is setting — so it runs the shared lens transition itself
    // (clear-then-set). The reveal seeds the owning frames open + anchors selected.
    openServiceScope() {
      const { index, viewMode, moduleExpanded } = get();
      // ONE anchors→clusters resolution feeds both the scope's leads and the reveal, so they can
      // never disagree about which anchors resolve (they read the same cached clustering too).
      const resolution = resolveServiceAnchors(anchorNodeIds(get()), index);
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
        ...resolution.reveal,
        moduleExpanded: revealExpanded,
      });
      void get().moduleRelayout();
    },

    clearServiceScope() {
      if (get().serviceScope === null) {
        return;
      }
      set({ serviceScope: null });
      void get().moduleRelayout();
    },

    // Paint-only: light a set of graph node ids (from a panel hover); null clears back to full strength.
    setReviewLit(ids) {
      set({ reviewLitNodeIds: ids });
    },

    // Select a review block (from the panel); also lights it and CENTERS the graph on it — a panel
    // click must always end with the target visible, not selected somewhere off-screen.
    selectReviewNode(id) {
      set({ reviewSelectedId: id, reviewLitNodeIds: id === null ? null : new Set([id]) });
      if (id !== null) {
        set({ recenterSeq: get().recenterSeq + 1 });
      }
    },

    // The file row's click: select the file's frame on the review graph (the emphasize ring), light
    // its touched units amber-strong, and center the viewport on the frame. Inert for files with no
    // module on the graph (the "not in graph" tail).
    focusReviewFile(path) {
      const file = get().reviewFiles.find((candidate) => candidate.path === path);
      if (!file || file.moduleId === null) {
        return;
      }
      const lit = file.units.length > 0 ? file.units.map((unit) => unit.nodeId) : [file.moduleId];
      set({
        moduleSelected: new Set([file.moduleId]),
        reviewSelectedId: file.moduleId,
        reviewLitNodeIds: new Set(lit),
        recenterSeq: get().recenterSeq + 1,
      });
    },

    // Isolate one change group on the Map: re-seed the minimal overlay with ONLY that group's module
    // ids (null restores the full review seed set), then relayout through the shared minimal machinery
    // — a pure seed/member swap, no dimming and no bespoke graph. Mirrors applyPrReviewToMap's reset
    // of the minimal fields exactly so the overlay rebuilds identically.
    selectReviewGroup(groupId) {
      const { review, reviewGroups, reviewActiveGroupId, reviewAllSeedIds } = get();
      if (!review || !reviewGroups || groupId === reviewActiveGroupId) {
        return;
      }
      // An unknown id falls back to "All" — a stale group id can never strand the reader on an empty Map.
      const group = groupId === null ? null : reviewGroups.groups.find((candidate) => candidate.id === groupId) ?? null;
      const nextSeeds = group ? group.moduleIds : reviewAllSeedIds;
      invalidateMinimalLayout();
      set({
        reviewActiveGroupId: group ? group.id : null,
        reviewSelectedId: null,
        reviewLitNodeIds: null,
        minimalSeedIds: nextSeeds,
        minimalMemberIds: [...nextSeeds],
        minimalBasePositions: {},
        minimalArrange: false,
        minimalRfNodes: [],
        minimalRfEdges: [],
        minimalLayoutStatus: nextSeeds.length > 0 ? "laying-out" : "idle",
      });
      void get().minimalRelayout();
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

    // Add a draft comment on a file (nodeId null) or on a touched unit inside it. Drafts persist
    // under the reviewKey until submitted or deleted.
    addReviewComment(path, nodeId, body) {
      const { review, reviewComments, index } = get();
      const trimmed = body.trim();
      if (!review || trimmed.length === 0) {
        return;
      }
      const comment: ReviewComment = {
        id: newCommentId(),
        path,
        nodeId,
        anchorLabel: nodeId === null ? null : (index.nodesById.get(nodeId)?.displayName ?? null),
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
      const previous = get().viewMode;
      if (previous === mode) {
        // Re-clicking the ACTIVE Service tab is the escape hatch back to the FULL lens: the scoped
        // sub-view exits AND any svc: cluster zoom clears (the breadcrumb stays the primary exit
        // for each); every other same-tab click remains a no-op.
        if (mode === "call") {
          get().clearServiceScope();
          const focus = get().moduleFocus;
          if (focus !== null && leadIdOf(focus) !== null) {
            get().setModuleFocus(null);
          }
        }
        return;
      }
      beginLensTransition(get, set);
      // The path nodes to carry — read BEFORE any state mutates the outgoing lens's selection/focus.
      const anchors = anchorNodeIds(get());
      if (mode === "logic") {
        set({ viewMode: mode });
        return;
      }
      if (mode === "prs") {
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
      const reveal =
        mode === "modules"
          ? mapRevealStateForMany(anchors, get().index)
          : mode === "call"
            ? serviceRevealStateForMany(anchors, get().index)
            : uiRevealStateForMany(anchors, get().index);
      set({ viewMode: mode, mapExtra: new Set<string>(), ...(reveal ?? MODULE_TOP_LEVEL) });
      void get().moduleRelayout();
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
      const back = lensBeforePrs ?? "modules";
      lensBeforePrs = null;
      set({ viewMode: back });
      if (moduleSurfaceSpec(back) !== null && get().moduleRfNodes.length === 0) {
        void get().moduleRelayout();
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
        void get().moduleRelayout();
        // An open minimal overlay derives its ghost-satellite ring with the same hidden set, so the
        // toggle refreshes it too (else stale test satellites linger over the recomputed Map).
        if (get().minimalSeedIds.length > 0) {
          void get().minimalRelayout();
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

    // Fetch and reveal a callable's source, starting inline on the node. Inert when the server
    // ships no source access or the node has no location. A race guard drops the result if a newer
    // click (a different node) has since taken over the view; the mode is preserved across the
    // fetch so a mid-flight expand-to-modal is not clobbered when the code lands.
    async showCode(node, opts) {
      if (!node.location) {
        return;
      }
      // While reviewing, a changed file opens from the PR HEAD (not the base clone) so the code shown
      // matches the PR — sliced to where the node moved to in the head, painted with the PR's own
      // added/modified lines. Any other file (or off-review) takes the base /api/source path.
      const st = get();
      const reviewDiff = st.prReviewed !== null && prFileUrl && st.reviewHeadRef
        ? st.reviewDiffByFile[node.location.file] ?? null
        : null;
      if (!reviewDiff && !sourceUrl) {
        return;
      }
      // Whole-file view (the diff `</>`) shows the entire file scrolled to the first change; a node
      // slice shows just the span. A head-fetch is always the node's own (head-shifted) span.
      const wholeFile = reviewDiff ? false : opts?.wholeFile ?? false;
      const headSpan = reviewDiff
        ? headSpanFor(node.location.startLine, node.location.endLine ?? node.location.startLine, reviewDiff.edits)
        : null;
      const baseLine = headSpan ? headSpan.start : wholeFile ? 1 : node.location.startLine;
      set({ codeView: { node, code: null, loading: true, error: null, mode: "inline", baseLine, wholeFile } });
      const fail = () => {
        if (get().codeView?.node.id !== node.id) {
          return;
        }
        const mode = get().codeView?.mode ?? "inline";
        set({ codeView: { node, code: null, loading: false, error: "Could not load source.", mode, baseLine, wholeFile } });
      };
      try {
        const url = reviewDiff && st.reviewHeadRef
          ? prFileHeadUrl(prFileUrl!, node.location.file, st.reviewHeadRef)
          : baseSourceUrl(sourceUrl!, node.location, wholeFile);
        const res = await fetch(url, { credentials: "same-origin" });
        if (get().codeView?.node.id !== node.id) {
          return;
        }
        if (!res.ok) {
          fail();
          return;
        }
        const data = await res.json();
        if (get().codeView?.node.id !== node.id) {
          return;
        }
        const mode = get().codeView?.mode ?? "inline";
        const view =
          reviewDiff && headSpan
            ? sliceHeadCodeView(node, String(data.code ?? ""), data.truncated === true, headSpan, reviewDiff.kinds, mode)
            : { node, code: data.code, loading: false, error: null, truncated: data.truncated, mode, baseLine: data.startLine ?? baseLine, wholeFile };
        set({ codeView: view });
      } catch {
        fail();
      }
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
      set({ prsTab: tab, prsError: null, prSelected: null, prFiles: null, prFilesTruncated: false });
      if (get().prsList[tab] === null) {
        void get().loadPrs(1);
      }
    },

    async loadPrs(page) {
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

    async selectPr(number) {
      const sequence = ++prFilesSeq;
      // Switching PRs abandons any review preparation in flight: bump its seq so a landing stream
      // is dropped, and clear the indicator so the panel never shows a stale progress/error card.
      prAnalyzeSeq += 1;
      // Leaving the reviewed PR (a different number, or Back/Escape's null) ends the review
      // session: put the boot artifact back and re-lay the visible surface. A no-op outside one.
      if (restorePrReviewBaseline(get, set, invalidateArtifactCaches)) {
        void get().relayout();
      }
      const prepareReset = { prReviewStatus: "idle" as const, prPrepareStage: null, prPrepareError: null };
      if (number === null) {
        set({ prSelected: null, prFiles: null, prFilesTruncated: false, prsLoading: false, prsError: null, ...prepareReset });
        return;
      }
      set({ prSelected: number, prFiles: null, prFilesTruncated: false, prsLoading: true, prsError: null, ...prepareReset });
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
        set({ prFiles: data.files, prFilesTruncated: data.truncated, prsLoading: false, prsError: null });
      } catch {
        if (prFilesSeq === sequence && get().prSelected === number) {
          set({ prsLoading: false, prsError: PRS_UNAVAILABLE_ERROR });
        }
      }
    },

    // Reviewing a PR lands on main's Module-map minimal-graph surface (applyPrReviewToMap). When
    // the server can prepare the PR head (analyzeUrl + a stored artifact id + a known PR summary),
    // it streams the clone→checkout→extract analysis into the prepare indicator, then SWAPS the
    // loaded artifact for the prepared head-accurate one (saving the boot pair for the session-end
    // restore) so the review computes in the diff's own coordinates. Without the endpoint (plain
    // `view`, older server) it reviews the loaded artifact synchronously, as before — no swap.
    // A stale-seq guard drops an older stream when a newer review (or PR switch) supersedes it.
    async reviewPrInGraph() {
      const prNumber = get().prSelected;
      if (prNumber === null) {
        return;
      }
      const summary = selectedPrSummary(get());
      if (analyzeUrl === null || analyzeGraphId === null || summary === null) {
        applyPrReviewToMap(get, set, prFilesUrl, invalidateMinimalLayout);
        return;
      }
      const sequence = ++prAnalyzeSeq;
      set({ prReviewStatus: "preparing", prPrepareStage: "clone", prPrepareError: null, prPreparedGraphId: null });
      try {
        const request = { id: analyzeGraphId, prNumber, baseRef: summary.baseRef, headRef: summary.headRef };
        const preparedGraphId = await streamPrAnalysis(analyzeUrl, request, (stage) => {
          if (prAnalyzeSeq === sequence) {
            set({ prPrepareStage: stage });
          }
        });
        if (prAnalyzeSeq !== sequence) {
          return; // a newer review (or PR switch) superseded this one.
        }
        // SWAP: load the prepared PR-head artifact and make it the CURRENT graph BEFORE the review
        // body runs, so amber marking, seeds, and the line diff all compute in the hunks' own
        // head coordinates (the loaded artifact is the analyzed branch — its line numbers drift).
        const prepared = await fetchPreparedArtifact(get().graphUrl, preparedGraphId);
        if (prAnalyzeSeq !== sequence) {
          return; // abandoned while the artifact was in flight — an old preparation must not swap.
        }
        swapToPreparedArtifact(get, set, prepared, invalidateArtifactCaches);
        set({ prReviewStatus: "idle", prPrepareStage: null, prPreparedGraphId: preparedGraphId });
        applyPrReviewToMap(get, set, prFilesUrl, invalidateMinimalLayout);
      } catch (error) {
        if (prAnalyzeSeq === sequence) {
          set({ prReviewStatus: "error", prPrepareStage: null, prPrepareError: prepareErrorMessage(error) });
        }
      }
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
): void {
  const { prFiles, prSelected, prsList, artifact, index } = get();
  if (prSelected === null) {
    return;
  }
  // This is a lens ENTRY (it lands on the Map lens below), so it owes the shared transition side
  // effects like every other entry point: a live Service scope must not survive into the review.
  beginLensTransition(get, set);
  const summary = [...(prsList.open ?? []), ...(prsList.closed ?? [])].find((pr) => pr.number === prSelected);
  const context = reviewContextFromPrFiles({
    prNumber: prSelected,
    headRef: summary?.headRef ?? null,
    scopeId: prFilesUrl,
    files: prFiles ?? [],
  });
  const review = deriveReviewDataFromContext(context, artifact, index);
  // The files-first checklist: every changed file with its touched code units (the panel's primary
  // section). Derived from the SAME context/artifact as the affected set below, so a checked unit
  // corresponds 1:1 with an amber-ringed card.
  const files = deriveReviewFiles(context, artifact, index);
  // The modified code blocks (hunks ∩ node ranges); repaint main's changed-node channel to THIS PR
  // so the Map + minimal overlay ring the edited blocks amber (reused `--changed-since` highlight).
  const affected = computeAffectedNodes(artifact.nodes, context.changedFiles);
  applyChangedIds(index, affected.map((node) => node.nodeId));
  // Colour each touched CODE BLOCK by its file's change kind (green added / gold modified / red
  // deleted). A file/module that only contains changes stays uncoloured — it shows a +/- stat instead.
  applyChangedStatus(index, affected.map((node) => [node.nodeId, node.status] as [string, ChangeStatus]));
  // Seed the minimal graph from the changed FILES (seeds must be module ids).
  const matchedFiles = matchAffectedFiles(index, context.changedFiles.map((file) => file.path)).matched;
  const seeds = [...new Set(matchedFiles.map((match) => match.moduleId))].sort();
  // Partition the change into disjoint groups (one per weakly-connected component of the changed
  // modules), sharing the SAME flow substrate the review rows already read. Stored so the rail can
  // offer per-group isolation; ignored (strip hidden) when the change is a single connected component.
  const changeGroups = computeChangeGroups(artifact.nodes, artifact.edges, context.changedFiles, review.flows);
  // GitHub's whole-file +N/-M churn per changed file, keyed by node.location.file, for the marker a
  // changed FILE card shows before its name (files aren't coloured; only their touched blocks are).
  const deltaByPath = new Map<string, { added: number; deleted: number }>(
    (prFiles ?? []).map((file) => [file.path, { added: file.additions, deleted: file.deletions }]),
  );
  const reviewFileDelta: Record<string, { added: number; deleted: number }> = {};
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
  // Pre-expand the packages and file modules on the path to each changed block (packages too,
  // else deriveModuleTree never descends to the file — mirrors flowExplorer's
  // expandedModulePaths): review reads at declaration level (class/type cards), so classes stay
  // collapsed "N members" cards and blocks never chart flow steps — drilling deeper stays a
  // manual gesture.
  const expanded = new Set<string>(seeds);
  for (const node of affected) {
    for (const ancestor of index.ancestorsOf(node.nodeId)) {
      if (ancestor.kind === "package" || ancestor.kind === "module") {
        expanded.add(ancestor.id);
      }
    }
  }
  invalidateMinimalLayout();
  // Capture the head ref + each changed file's real per-line diff (old/new spans + head-relative
  // added/modified lines), keyed by node.location.file, so opening a changed unit's </> fetches the
  // PR HEAD of that file and paints exactly its diff — code + highlight that match the PR, not base.
  // Keyed off the MATCHED node's location.file (same matching that seeds the graph), robust to any
  // path prefix. This is what makes the fast (synchronous) review show head code without re-extract.
  const diffByPath = new Map<string, { edits: LineEdit[]; kinds: ChangedLineSpan[] }>();
  for (const file of prFiles ?? []) {
    if (file.edits && file.edits.length > 0) {
      diffByPath.set(file.path, { edits: file.edits, kinds: file.kinds ?? [] });
    }
  }
  const reviewDiffByFile: Record<string, { edits: LineEdit[]; kinds: ChangedLineSpan[] }> = {};
  for (const match of matchedFiles) {
    const locFile = index.nodesById.get(match.moduleId)?.location?.file;
    const diff = diffByPath.get(match.path);
    if (locFile && diff) {
      reviewDiffByFile[locFile] = diff;
    }
  }
  const progress = readReviewProgress(context.reviewKey);
  set({
    artifact: reviewedArtifact,
    review,
    prReviewed: prSelected,
    reviewHeadRef: summary?.headRef ?? null,
    reviewDiffByFile,
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
    reviewGroups: changeGroups,
    reviewActiveGroupId: null,
    reviewAllSeedIds: seeds,
    viewMode: "modules",
    moduleFocus: null,
    moduleSelected: new Set<string>(),
    moduleExpanded: expanded,
    minimalSeedIds: seeds,
    minimalMemberIds: [...seeds],
    minimalBasePositions: {},
    minimalArrange: false,
    minimalRfNodes: [],
    minimalRfEdges: [],
    minimalLayoutStatus: seeds.length > 0 ? "laying-out" : "idle",
  });
  // Lay out the underlying Map (correct if the reader closes the overlay) and, when seeded, the overlay.
  void get().moduleRelayout();
  if (seeds.length > 0) {
    void get().minimalRelayout();
  }
}

/** The selected PR's summary row (its refs feed the analyze request); null when not listed. */
function selectedPrSummary(state: BlueprintState): PrSummary | null {
  const { prSelected, prsList } = state;
  return [...(prsList.open ?? []), ...(prsList.closed ?? [])].find((pr) => pr.number === prSelected) ?? null;
}

function prepareErrorMessage(error: unknown): string {
  return error instanceof Error && error.message.length > 0 ? error.message : "PR analysis failed.";
}

/** Route an in-place expansion relayout to whichever module surface is showing: the minimal-graph
 * overlay when it is open (it shares the one `moduleExpanded` id space), else the Module map beneath.
 * Relaying out the covered Map instead would be work the reader can't see. */
function relayoutActiveModuleSurface(get: () => BlueprintState): Promise<void> {
  return get().minimalSeedIds.length > 0 ? get().minimalRelayout() : get().moduleRelayout();
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
  if (get().minimalSeedIds.length > 0) {
    get().closeMinimalGraph();
  }
  if (get().serviceScope !== null) {
    set({ serviceScope: null });
  }
  // A svc: cluster zoom is CALL-LENS state — stale on the next visit and meaningless anywhere
  // else: clear it so a lens entry that lands back on "call" (openComposition's pivot) can't hide
  // its target under a lingering zoom. ONLY the `svc:` grammar clears — a Map folder focus is that
  // lens's own state and must survive. The relayout matters for entries that never re-lay the
  // module surface themselves; any entry that does supersedes it via the layout sequence guard.
  const focus = get().moduleFocus;
  if (focus !== null && leadIdOf(focus) !== null) {
    set({ moduleFocus: null });
    void get().moduleRelayout();
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
    void relayoutActiveModuleSurface(get);
  } else if (state.viewMode === "logic") {
    const ids = pick(logicVisibleNodes(state), [null]);
    if (ids.length === 0) {
      return;
    }
    set({ expandedLogic: withToggledMany(state.expandedLogic, ids) });
    void get().logicRelayout();
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
