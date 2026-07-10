/**
 * The single zustand store. `expanded` starts EMPTY so only roots show (progressive
 * disclosure begins at the package/system level), and `environment` starts null and is NEVER
 * auto-set or defaulted to prod. Every structural mutation bumps `layoutSeq` and re-runs the
 * derive pipeline behind a stale guard so a slow ELK pass can never overwrite a newer one.
 */

import { createStore, type StoreApi } from "zustand/vanilla";
import type { Edge, Node } from "@xyflow/react";
import { changedRangesFromExtensions, computeAffectedNodes, computeCoverage, unmappedChangedFiles } from "@meridian/core";
import type {
  ChangedFile,
  CoverageReport,
  FlowPath,
  FlowStep,
  GraphArtifact,
  GraphNode,
  LogicFlows,
  NodeId,
  NodeMetrics,
} from "@meridian/core";
import { applyChangedIds, type GraphIndex } from "../graph/graphIndex";
import { matchAffectedFiles } from "../derive/matchAffectedFiles";
import type { BlueprintEdge, BlueprintNode } from "../layout/rfTypes";
import type { TelemetryProvider } from "../telemetry/provider";
import type { ViewMode } from "../derive/edgeSelection";
import { relatedNodeIds, type FlowSelectionRef } from "../derive/flowBlocks";
import { computeVisible } from "../derive/computeVisible";
import { idsToExpand, idsToCollapse, type ExpandableNode } from "../derive/scopedExpansion";
import type { LogicViewMode } from "../derive/flowViewModel";
import { uiFocusTarget } from "../derive/uiFocus";
import { deriveLayout } from "./deriveLayout";
import { deriveLogicLayout } from "./deriveLogicLayout";
import { deriveFlowPaneLayout } from "./deriveFlowPaneLayout";
import { deriveCompositionLayout } from "./deriveCompositionLayout";
import { deriveModuleLevelLayout, type ModuleLevelLayout } from "./deriveModuleMapLayout";
import { deriveServiceLevelLayout } from "./deriveServiceMapLayout";
import { deriveMinimalGraphLayout } from "./deriveMinimalGraphLayout";
import { captureMapPositions } from "./mapPositions";
import type { PlacedRect } from "../layout/minimalPlacement";
import { buildModuleGraph, type ModuleGraph } from "../derive/moduleGraph";
import { buildBlockDeps, UNIT_CARD_KINDS, type BlockDeps } from "../derive/blockDeps";
import { buildUnitIndex, type UnitIndex } from "@meridian/design-metrics";
import { deriveModuleTree } from "../derive/moduleTree";
import { moduleChildContainerIds } from "../derive/moduleChildContainers";
import { deriveServiceTree } from "../derive/serviceClusterTree";
import type { ModuleCategory } from "../derive/moduleCategory";
import type { HighlightMode } from "../components/moduleMapPaint";
import { readSolidMetricsPref, writeSolidMetricsPref } from "./solidMetricsPref";
import { moduleRevealStateFor, withAncestorsOf, withAncestorsOfMany } from "./flowExplorer";
import type { LogicRfNode, LogicRfEdge } from "../layout/logicElk";
import type { CompRfNode, CompRfEdge } from "../layout/compositionElk";
import { PRS_UNAVAILABLE_ERROR, type PrChangedFile, type PrFilesResponse, type PrListResponse, type PrSummary, type PrsTab } from "./prTypes";
import { streamPrAnalysis, type PrAnalyzeStage } from "./prAnalysis";
import {
  fetchPreparedArtifact,
  restorePrReviewBaseline,
  swapToPreparedArtifact,
  withPrLineDiff,
  type PrReviewBaseline,
} from "./prReviewSession";
import { deriveReviewData, deriveReviewDataFromContext, applyTick, type ReviewData } from "../derive/reviewData";
import { readReviewProgress, writeReviewProgress, clearReviewProgress, type ReviewTick } from "./reviewTicksPref";
import { reviewContextFromPrFiles } from "../derive/prReviewContext";

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
}

export interface BlueprintState {
  artifact: GraphArtifact;
  index: GraphIndex;
  expanded: Set<string>;
  selectedId: string | null;
  /** The dived-into container; null == the graph roots (top level). Never drawn — it IS the breadcrumb. */
  focusId: string | null;
  /** Which relationship story is on screen: the call graph, or the React composition tree. */
  viewMode: ViewMode;
  /** Whether test code (nodes tagged/heuristically detected as tests) is drawn at all. */
  showTests: boolean;
  /** Coverage mode recolors the graph by static test coverage and opens the coverage panel. */
  coverageMode: boolean;
  /** Computed once, on first entering coverage mode (the artifact never changes after boot). */
  coverage: CoverageReport | null;
  /** The entry node whose forward call-flow is isolated on screen; null == the whole graph. */
  flowRootId: string | null;
  /** Hop cap from the flow entry; null == follow the flow all the way. */
  flowDepth: number | null;
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
  /** Phase-1 Code flows explorer state: selection/emphasis are shared by the future tree and panes. */
  flowExplorerOpen: boolean;
  flowSelection: FlowSelectionRef | null;
  flowEmphasis: Set<string>;
  flowPaneRfNodes: LogicRfNode[];
  flowPaneRfEdges: LogicRfEdge[];
  flowPaneLayoutStatus: LayoutStatus;
  /** The laid-out Logic graph (React Flow), recomputed on open/drill/expand/toggle via ELK. */
  logicRfNodes: LogicRfNode[];
  logicRfEdges: LogicRfEdge[];
  logicLayoutStatus: LayoutStatus;
  /** The laid-out Service-composition graph (React Flow), recomputed via ELK whenever the "call"
   * lens is (re)entered. Composition IS the "call" surface now — the old call graph no longer renders. */
  compRfNodes: CompRfNode[];
  compRfEdges: CompRfEdge[];
  compLayoutStatus: LayoutStatus;
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
  /** Changed files that mapped to no code block (deleted / not-extracted / edits outside any block). */
  reviewUnmapped: ChangedFile[];
  /** Per-flow review progress, keyed by flowId, persisted to localStorage under the reviewKey. */
  reviewTicks: Record<string, ReviewTick>;
  /** The graph node ids lit by a panel hover; null == nothing hovered (all blocks full strength). */
  reviewLitNodeIds: Set<string> | null;
  /** The selected review block/flow id; drives the graph selection ring and the panel row highlight. */
  reviewSelectedId: string | null;
  rfNodes: BlueprintNode[];
  rfEdges: BlueprintEdge[];
  layoutStatus: LayoutStatus;
  layoutSeq: number;
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
  toggleExpand(nodeId: string): void;
  expandPath(nodeId: string): void;
  expandPaths(nodeIds: string[]): void;
  /** Reveal one more containment level within the current selection (or the whole view / root
   * container when nothing is selected). Surface-aware: Map, UI graph, and Logic graph each. */
  expandAll(): void;
  /** Fully collapse the current selection (or the whole view / root container when nothing is
   * selected) — closes every open container in scope in one click. Surface-aware. */
  collapseAll(): void;
  recenter(): void;
  select(nodeId: string | null): void;
  diveInto(nodeId: string): void;
  diveTo(nodeId: string): void;
  diveHome(): void;
  isolateFlow(nodeId: string): void;
  clearFlow(): void;
  setFlowDepth(depth: number | null): void;
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
  compRelayout(): Promise<void>;
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
  /** ⌘P palette navigate: reveal a picked symbol in the CURRENT map lens — the Map goes to its
   * definition (revealModule), the Service lens pins + selects it. Inert outside the map lenses. */
  revealInView(rawId: string): void;
  /** ⌘P palette "+": pin a picked symbol INTO the current map lens (its owning unit/file) as an extra
   * card, without navigating. Inert outside the map lenses. */
  addToView(rawId: string): void;
  expandModuleChildren(containerId: string | null): void;
  collapseModuleChildren(containerId: string | null): void;
  togglePrivateMembers(): void;
  setModuleRadius(radius: number): void;
  toggleHighlightMode(): void;
  toggleHighways(): void;
  toggleCategory(category: ModuleCategory): void;
  toggleRelKind(kind: string): void;
  resetCategoryFilter(): void;
  resetRelationshipFilter(): void;
  selectModule(id: string | null): void;
  toggleModuleSelect(id: string): void;
  buildMinimalGraph(): void;
  closeMinimalGraph(): void;
  promoteMinimalGhost(id: string): void;
  demoteMinimalMember(id: string): void;
  resetMinimalGraph(): void;
  rearrangeMinimalGraph(): void;
  minimalRelayout(): Promise<void>;
  setReviewLit(ids: Set<string> | null): void;
  selectReviewNode(id: string | null): void;
  toggleReviewTick(flowId: string): void;
  resetReviewTicks(): void;
  setViewMode(mode: ViewMode): void;
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
  /** POST endpoint for PR-head preparation. Null/absent (a plain `view` session, or an older
   * server) makes reviewPrInGraph skip streaming and review the loaded artifact synchronously. */
  analyzeUrl?: string | null;
  /** The current GitHub artifact id — the analyze POST body's `id`. */
  graphId?: string | null;
  /** The graph-fetch URL; wave 2 loads the prepared PR artifact from it by swapping the id. */
  graphUrl?: string;
}

export type BlueprintStore = StoreApi<BlueprintState>;

export function createBlueprintStore(dependencies: StoreDependencies): BlueprintStore {
  // The focus to restore when leaving UI mode, kept off the reactive state (nothing renders it).
  let focusBeforeUi: string | null = null;
  // Monotonic seq to drop a stale Logic-graph layout when a newer open/drill/toggle supersedes it.
  let logicLayoutSeq = 0;
  // Same guard for the composition layout — a newer relayout discards an older in-flight ELK pass.
  let compLayoutSeq = 0;
  // And for the Module-map layout, so a newer focus change supersedes an older derivation.
  let moduleLayoutSeq = 0;
  // And for the Module-map selection's minimal-graph overlay (its own surface, its own guard).
  let minimalLayoutSeq = 0;
  // The file import graph, built once per ARTIFACT on first module-map relayout and reused for
  // every level — never rebuilt per relayout. A PR-review swap/restore replaces the artifact, so
  // invalidateArtifactCaches (below) nulls it for a lazy rebuild from the incoming index.
  let moduleGraph: ModuleGraph | null = null;
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
  // Null when the server didn't ship source access — the code drawer is then inert.
  const sourceUrl = dependencies.sourceUrl;
  const prsUrl = dependencies.prsUrl;
  const prFilesUrl = dependencies.prFilesUrl;
  // Null when the server can't prepare a PR head (no analyze route, or no stored GitHub artifact);
  // reviewPrInGraph then falls back to the synchronous loaded-artifact review.
  const analyzeUrl = dependencies.analyzeUrl ?? null;
  const analyzeGraphId = dependencies.graphId ?? null;
  // The composition tab opens on the WHOLE-SYSTEM overview (null root); file-rooting is the explicit
  // focus tool (⌘P / click a boundary or frame). Auto-rooting at the declared entry module proved a
  // poor default — a React entry (e.g. main.tsx) is a thin bootstrap with no cross-unit coupling, so
  // it roots to a lone card. Predictable overview-first beats a sometimes-empty auto-root; whether to
  // auto-root a meaningful entry is an open design question (see docs/service-composition-design.md §8).
  const defaultCompRoot = null;

  return createStore<BlueprintState>((set, get) => ({
    artifact: dependencies.artifact,
    index: dependencies.index,
    expanded: new Set<string>(),
    selectedId: null,
    focusId: null,
    // A `meridian review` artifact opens straight on the review surface; everything else (plain
    // `view`, or a `web` GitHub session) opens on the Map — the default lens.
    viewMode: "modules",
    // Tests are hidden by default — rarely what the reader is here for, and always in the graph (the
    // Tests toggle reveals them), so nothing is lost. Tagged ids come from `index.testIds`.
    showTests: false,
    coverageMode: false,
    coverage: null,
    flowRootId: null,
    flowDepth: null,
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
    flowEmphasis: new Set<string>(),
    flowPaneRfNodes: [],
    flowPaneRfEdges: [],
    flowPaneLayoutStatus: "idle",
    logicRfNodes: [],
    logicRfEdges: [],
    logicLayoutStatus: "idle",
    compRfNodes: [],
    compRfEdges: [],
    compLayoutStatus: "idle",
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
    hiddenCategories: new Set<ModuleCategory>(),
    hiddenRelKinds: new Set<string>(),
    moduleSelected: new Set<string>(),
    moduleExpanded: new Set<string>(),
    mapExtra: new Set<string>(),
    showPrivate: true,
    minimalSeedIds: [],
    minimalMemberIds: [],
    minimalBasePositions: {},
    minimalArrange: false,
    minimalRfNodes: [],
    minimalRfEdges: [],
    minimalLayoutStatus: "idle",
    review,
    reviewAffectedIds: new Set<string>(),
    reviewUnmapped: [],
    reviewTicks: review ? readReviewProgress(review.context.reviewKey).ticks : {},
    reviewLitNodeIds: null,
    reviewSelectedId: null,
    rfNodes: [],
    rfEdges: [],
    layoutStatus: "idle",
    layoutSeq: 0,
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
    prReviewStatus: "idle",
    prPrepareStage: null,
    prPrepareError: null,
    prPreparedGraphId: null,
    prReviewBaseline: null,
    graphUrl: dependencies.graphUrl ?? "",
    codeView: null,

    toggleExpand(nodeId) {
      set({ expanded: withToggled(get().expanded, nodeId) });
      void get().relayout();
    },

    expandPath(nodeId) {
      set({ expanded: withAncestorsOf(nodeId, get().index, get().expanded) });
      void get().relayout();
    },

    expandPaths(nodeIds) {
      set({ expanded: withAncestorsOfMany(nodeIds, get().index, get().expanded) });
      void get().relayout();
    },

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

    select(nodeId) {
      set({ selectedId: nodeId });
    },

    // Dive into a container (you are now INSIDE it, seeing its children). A no-op when already
    // there so a stray double-click doesn't trigger a redundant relayout.
    diveInto(nodeId) {
      if (get().focusId === nodeId) {
        return;
      }
      set({ focusId: nodeId });
      void get().relayout();
    },

    // Jump to a breadcrumb segment (an ancestor of the current focus, or the current one).
    diveTo(nodeId) {
      if (get().focusId === nodeId) {
        return;
      }
      set({ focusId: nodeId });
      void get().relayout();
    },

    diveHome() {
      if (get().focusId === null) {
        return;
      }
      set({ focusId: null });
      void get().relayout();
    },

    // Isolate the forward call-flow rooted at a node (always at full depth first — the reader
    // dials it back with setFlowDepth). Selecting it keeps a highlight on the entry.
    isolateFlow(nodeId) {
      set({ flowRootId: nodeId, flowDepth: null, selectedId: nodeId });
      void get().relayout();
    },

    clearFlow() {
      if (get().flowRootId === null) {
        return;
      }
      set({ flowRootId: null, flowDepth: null });
      void get().relayout();
    },

    setFlowDepth(depth) {
      if (get().flowDepth === depth) {
        return;
      }
      set({ flowDepth: depth });
      void get().relayout();
    },

    toggleFlowExplorer() {
      const flowExplorerOpen = !get().flowExplorerOpen;
      set(flowExplorerOpen
        ? { flowExplorerOpen }
        : {
            flowExplorerOpen,
            flowSelection: null,
            flowEmphasis: new Set<string>(),
            flowPaneRfNodes: [],
            flowPaneRfEdges: [],
            flowPaneLayoutStatus: "idle",
          });
    },

    selectFlowEntry(ref) {
      if (ref === null) {
        set({
          flowSelection: null,
          flowEmphasis: new Set<string>(),
          flowPaneRfNodes: [],
          flowPaneRfEdges: [],
          flowPaneLayoutStatus: "idle",
        });
        return;
      }
      const { artifact, index, viewMode } = get();
      const flows = (artifact.extensions?.logicFlow ?? {}) as unknown as LogicFlows;
      const related = relatedNodeIds(index, flows, ref);
      set({ flowSelection: ref, flowEmphasis: related });
      if (viewMode === "ui") {
        get().expandPaths([...related]);
      } else if (viewMode === "modules") {
        const reveal = moduleRevealStateFor([...related], index);
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
      set({ viewMode: "logic", logicRoot: nodeId, logicStack: [nodeId], logicFocus: [], selectedId: nodeId, logicSelected: null, expandedLogic: new Set<string>() });
      void get().logicRelayout();
    },

    // The logic→composition link: a call block's owning-unit chip opens that unit HERE, rooted and
    // selected, so a reader can pivot from "who calls this" to "how healthy is the unit it lives in".
    // No guard needed — compRelayout is idempotent, and rooting+selecting is always a fresh view.
    openComposition(unitId) {
      set({ viewMode: "call", compRoot: unitId, compExpanded: new Set<string>(), compSelectedId: unitId });
      void get().compRelayout();
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

    // Re-derive the Service-composition graph from the whole artifact through ELK, behind the same
    // stale-seq guard. Reads the raw nodes/edges off the index (built from the artifact); the derive
    // decides which units earn a card and wires their couplings.
    async compRelayout() {
      const { index, compRoot, compExpanded, showSolidMetrics } = get();
      // The layout ALWAYS includes test units, so toggling the Tests filter never moves a production
      // card — the composition view hides test cards in place (a repaint), it does not re-lay-out.
      // A giant repo's first layout stays cheap anyway: aggregated altitudes only COUNT test units
      // inside package summary cards, they never lay the individual cards out.
      const nodes = [...index.nodesById.values()];
      // deriveCompositionGraph self-decides whether to aggregate (based on how many unit cards the
      // current root's view would draw) and recurses a level deeper on each drill, so the store just
      // hands it the root.
      const sequence = ++compLayoutSeq;
      set({ compLayoutStatus: "laying-out" });
      const graph = await deriveCompositionLayout(nodes, index.edges, compRoot, showSolidMetrics, compExpanded);
      if (compLayoutSeq !== sequence) {
        return; // a newer layout superseded this one.
      }
      set({ compRfNodes: graph.nodes, compRfEdges: graph.edges, compLayoutStatus: "ready" });
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

    // Re-root the Service-composition graph at a module/package (null == whole system). Clears the
    // selection, the code view, the aggregate-expand set, and the method-preview drawer — none carry
    // meaning in a new rooted view — then re-lays out. When the root is unchanged it still clears the
    // stale selection + code so navigation always returns to the graph first.
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
      void get().compRelayout();
    },

    // Inline-expand / collapse a package card in the AGGREGATED composition view: an expanded
    // package renders as a frame holding the next level (sub-package cards / unit scorecards)
    // while the rest of the overview stays put. Relayouts — the canvas gains/loses cards.
    toggleCompExpand(id) {
      const next = new Set(get().compExpanded);
      if (!next.delete(id)) {
        next.add(id);
      }
      set({ compExpanded: next });
      void get().compRelayout();
    },

    // Show/hide the per-card SOLID metrics (metric rows + smell chips) on the composition scorecards.
    // Persisted across reloads; a relayout re-sizes the cards (compact when metrics are hidden).
    toggleSolidMetrics() {
      const next = !get().showSolidMetrics;
      writeSolidMetricsPref(next);
      set({ showSolidMetrics: next });
      void get().compRelayout();
    },

    // Re-derive the Module-surface LEVEL through ELK, behind the same stale-seq guard. BOTH lenses
    // write this slice: the "call" lens feeds the same view a SERVICE-CLUSTER tree (no zoom/focus),
    // while "modules" derives the folder containment level for the current focus. The import graph
    // is built once (cached) and reused for every folder level.
    async moduleRelayout() {
      const { index, moduleFocus, moduleExpanded, mapExtra, artifact, viewMode } = get();
      const sequence = ++moduleLayoutSeq;
      set({ moduleLayoutStatus: "laying-out" });
      const graph = (moduleGraph ??= buildModuleGraph(index));
      const deps = (blockDeps ??= buildBlockDeps(index));
      const flows = (artifact.extensions?.logicFlow ?? {}) as unknown as LogicFlows;
      let layout: ModuleLevelLayout;
      if (viewMode === "call") {
        layout = await deriveServiceLevelLayout(index, moduleExpanded, graph, deps, flows, mapExtra);
      } else {
        layout = await deriveModuleLevelLayout(index, moduleFocus, moduleExpanded, graph, deps, flows, mapExtra);
      }
      if (moduleLayoutSeq !== sequence) {
        return; // a newer focus change superseded this one.
      }
      set({
        moduleRfNodes: layout.nodes,
        moduleRfEdges: layout.edges,
        moduleEffectiveFocus: layout.effectiveFocus,
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

    // ⌘P palette NAVIGATE: reveal a picked symbol in the current map lens. The Map goes to its real
    // definition (revealModule: refocus + expand its file/unit chain + select it). The Service lens has
    // no focus, so it pins the symbol's owning card onto the canvas and selects it. Inert elsewhere —
    // the palette opens a logic flow in logic/ui itself.
    revealInView(rawId) {
      const viewMode = get().viewMode;
      if (viewMode === "modules") {
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
    // map lens. Both lenses share `mapExtra`, so the same pin surfaces in either.
    addToView(rawId) {
      const viewMode = get().viewMode;
      if (viewMode !== "call" && viewMode !== "modules") {
        return;
      }
      const card = resolveCard(rawId);
      if (!get().mapExtra.has(card)) {
        set({ mapExtra: new Set(get().mapExtra).add(card) });
        void get().moduleRelayout();
      }
    },

    // Expand one containment level under the target. `null` means the current view frontier; a
    // frame id means that expanded frame's visible package/file/unit/block child containers. The
    // active module surface decides whether that frontier is the folder Map or the Service lens.
    expandModuleChildren(containerId) {
      const { index, moduleFocus, artifact, viewMode } = get();
      const graph = (moduleGraph ??= buildModuleGraph(index));
      const deps = (blockDeps ??= buildBlockDeps(index));
      const flows = (artifact.extensions?.logicFlow ?? {}) as unknown as LogicFlows;
      const expanded = new Set(get().moduleExpanded);
      const tree =
        viewMode === "call"
          ? deriveServiceTree(index, expanded, graph, deps, flows)
          : deriveModuleTree(index, moduleFocus, expanded, graph, deps, flows);
      moduleChildContainerIds(tree, containerId).forEach((id) => expanded.add(id));
      set({ moduleExpanded: expanded });
      void relayoutActiveModuleSurface(get);
    },

    // Collapse only direct child package/file/unit/block frames; deeper expansion ids deliberately
    // remain, so re-opening a parent restores the reader's deeper manual state.
    collapseModuleChildren(containerId) {
      const { index, moduleFocus, artifact, viewMode } = get();
      const graph = (moduleGraph ??= buildModuleGraph(index));
      const deps = (blockDeps ??= buildBlockDeps(index));
      const flows = (artifact.extensions?.logicFlow ?? {}) as unknown as LogicFlows;
      const expanded = new Set(get().moduleExpanded);
      const tree =
        viewMode === "call"
          ? deriveServiceTree(index, expanded, graph, deps, flows)
          : deriveModuleTree(index, moduleFocus, expanded, graph, deps, flows);
      moduleChildContainerIds(tree, containerId).forEach((id) => expanded.delete(id));
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
      const origin = [...get().moduleSelected];
      if (origin.length === 0) {
        return;
      }
      // Snapshot the map's current on-screen card positions ONCE, at build — the overlay mirrors them,
      // and re-capturing on curation would let already-placed cards jump. A selection-built graph is not
      // a PR review, so drop any stale prReviewed marker (else the PR-review card would show it).
      set({ minimalSeedIds: origin, minimalMemberIds: origin, minimalBasePositions: captureMapPositions(get().moduleRfNodes), minimalArrange: false, prReviewed: null });
      void get().minimalRelayout();
    },

    // Close the overlay back to the Module-map level canvas. The selection is kept, so the reader
    // can adjust it and rebuild without re-picking every card. Bumping the seq discards any ELK
    // pass still in flight, so a slow layout can't repopulate the arrays after the close.
    closeMinimalGraph() {
      minimalLayoutSeq += 1;
      set({ minimalSeedIds: [], minimalMemberIds: [], minimalBasePositions: {}, minimalArrange: false, minimalRfNodes: [], minimalRfEdges: [], minimalLayoutStatus: "idle" });
    },

    // Promote a GHOST into the working member set (the ghost "+" click). The ghost ring is then
    // recomputed from the larger member set, so promoting reaches one hop further. A no-op when the id
    // is already a member.
    promoteMinimalGhost(id) {
      const { minimalMemberIds } = get();
      if (minimalMemberIds.includes(id)) {
        return;
      }
      set({ minimalMemberIds: [...minimalMemberIds, id] });
      void get().minimalRelayout();
    },

    // Remove a MEMBER (the members-panel ✕); it reappears as a ghost iff still 1-hop of a remaining
    // member. Refuses to empty the set — the last member must stay so the overlay never goes blank.
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

    // Lay out the overlay's curated subgraph (members + their on-map ghost ring) through the shared
    // minimal-graph pass, behind its own stale-seq guard. `minimalArrange` picks the fresh ELK layout
    // over the map-mirror.
    async minimalRelayout() {
      const { index, minimalSeedIds, minimalMemberIds, minimalBasePositions, minimalArrange, moduleExpanded, artifact } = get();
      if (minimalMemberIds.length === 0) {
        return;
      }
      moduleGraph ??= buildModuleGraph(index);
      const deps = (blockDeps ??= buildBlockDeps(index));
      const flows = (artifact.extensions?.logicFlow ?? {}) as unknown as LogicFlows;
      const sequence = ++minimalLayoutSeq;
      set({ minimalLayoutStatus: "laying-out" });
      const layout = await deriveMinimalGraphLayout(index, moduleGraph, new Set(minimalMemberIds), new Set(minimalSeedIds), minimalBasePositions, {
        moduleExpanded,
        blockDeps: deps,
        flows,
      }, minimalArrange);
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

    // Paint-only: light a set of graph node ids (from a panel hover); null clears back to full strength.
    setReviewLit(ids) {
      set({ reviewLitNodeIds: ids });
    },

    // Select a review block (from the graph or the panel); also lights it so the coupling reads as one.
    selectReviewNode(id) {
      set({ reviewSelectedId: id, reviewLitNodeIds: id === null ? null : new Set([id]) });
    },

    // Toggle a flow's reviewed tick and persist the whole record under the reviewKey.
    toggleReviewTick(flowId) {
      const { review, reviewTicks } = get();
      const row = review?.rows.find((candidate) => candidate.flow.flowId === flowId);
      if (!review || !row) {
        return;
      }
      const next = applyTick(reviewTicks, row, "toggle", new Date().toISOString());
      set({ reviewTicks: next });
      writeReviewProgress(review.context.reviewKey, { version: 1, ticks: next });
    },

    resetReviewTicks() {
      const { review } = get();
      if (!review) {
        return;
      }
      clearReviewProgress(review.context.reviewKey);
      set({ reviewTicks: {} });
    },

    // Switching mode re-derives + relayouts like a dive. Entering UI mode dives to the render
    // subtree; leaving it returns to call-flow at the focus you had before (home if none). The
    // logic view is a standalone render (no rfNodes/ELK), so it neither dives nor relayouts, and
    // it leaves the graph focus untouched so returning to call/ui resumes where you were.
    setViewMode(mode) {
      const previous = get().viewMode;
      if (previous === mode) {
        return;
      }
      // The minimal-graph overlay is a Map-only surface; leaving the lens closes it so it never
      // lingers hidden behind another tab (and the URL's `mgraph` clears with the switch).
      if (get().minimalSeedIds.length > 0) {
        minimalLayoutSeq += 1;
        set({ minimalSeedIds: [], minimalMemberIds: [], minimalBasePositions: {}, minimalArrange: false, minimalRfNodes: [], minimalRfEdges: [], minimalLayoutStatus: "idle" });
      }
      if (mode === "logic") {
        set({ viewMode: mode });
        return;
      }
      if (mode === "prs") {
        // Returning to the PRs lens ends the review session: the boot artifact comes back so the
        // list is browsed against the graph the session booted with. No relayout here — the PRs
        // page has no canvas, and re-entering a graph lens always lays out afresh.
        restorePrReviewBaseline(get, set, invalidateArtifactCaches);
        set({ viewMode: mode });
        if (get().prsList[get().prsTab] === null) {
          void get().loadPrs(1);
        }
        return;
      }
      // The Map ("modules") and Service-composition ("call") lenses SHARE the module slice — same
      // view, same layout, different tree. Clicking INTO either always opens at its own top level,
      // never a focus inherited from a prior visit. A shared/reloaded deep link is unaffected: it
      // restores via setState on boot (not this click path), so an explicit ?mfocus=… still opens.
      if (mode === "modules" || mode === "call") {
        set({ viewMode: mode, moduleFocus: null, moduleExpanded: new Set<string>(), moduleSelected: new Set<string>(), mapExtra: new Set<string>() });
        void get().moduleRelayout();
        return;
      }
      if (mode === "ui") {
        focusBeforeUi = get().focusId;
        set({ viewMode: mode, focusId: uiFocusTarget(get().index) });
      } else if (previous === "ui") {
        set({ viewMode: mode, focusId: focusBeforeUi });
        focusBeforeUi = null;
      } else {
        // Leaving logic back to call: the graph focus was preserved, so just flip the mode.
        set({ viewMode: mode });
      }
      void get().relayout();
    },

    // Hiding tests while dived into (or having selected) test code would strand the view on
    // nodes that no longer exist, so focus/selection — on every surface, including the
    // composition graph's own selection/root — retreat home first.
    toggleShowTests() {
      const showTests = !get().showTests;
      const { focusId, selectedId, compSelectedId, compRoot, moduleSelected, viewMode, index } = get();
      const strandedById = (id: string | null) => !showTests && id !== null && index.testIds.has(id);
      const nextCompRoot = strandedById(compRoot) ? null : compRoot;
      set({
        showTests,
        focusId: strandedById(focusId) ? null : focusId,
        selectedId: strandedById(selectedId) ? null : selectedId,
        compSelectedId: strandedById(compSelectedId) ? null : compSelectedId,
        compRoot: nextCompRoot,
        moduleSelected: showTests ? moduleSelected : new Set([...moduleSelected].filter((id) => !index.testIds.has(id))),
      });
      // The composition AND module-map views hide test cards in place (the surface filters the rendered
      // set), so they must NOT re-lay-out — that would reshuffle production cards. The module map's focus
      // is a package/dir node (never test-stranded the way a file root was), so it's purely paint-only
      // here. Composition still relayouts when its OWN root was stranded inside now-hidden test code.
      const paintOnlyMode = viewMode === "call" || viewMode === "modules";
      const compRootChanged = nextCompRoot !== compRoot;
      if (!paintOnlyMode || compRootChanged) {
        void get().relayout();
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
      if (!sourceUrl || !node.location) {
        return;
      }
      // Whole-file view (the diff `</>`) shows the entire file scrolled to the first change; a node
      // slice shows just the span. baseLine is the code's first line — 1 for a whole file.
      const wholeFile = opts?.wholeFile ?? false;
      const baseLine = wholeFile ? 1 : node.location.startLine;
      set({ codeView: { node, code: null, loading: true, error: null, mode: "inline", baseLine, wholeFile } });
      try {
        const url = new URL(sourceUrl, window.location.origin);
        url.searchParams.set("file", node.location.file);
        // Omitting start/end makes the server return the whole file (it defaults missing bounds to
        // 1..EOF); a node slice sends the span explicitly.
        if (!wholeFile) {
          url.searchParams.set("start", String(node.location.startLine));
          url.searchParams.set("end", String(node.location.endLine ?? node.location.startLine));
        }
        const res = await fetch(url, { credentials: "same-origin" });
        if (get().codeView?.node.id !== node.id) {
          return;
        }
        const mode = get().codeView?.mode ?? "inline";
        if (!res.ok) {
          set({ codeView: { node, code: null, loading: false, error: "Could not load source.", mode, baseLine, wholeFile } });
          return;
        }
        const data = await res.json();
        if (get().codeView?.node.id !== node.id) {
          return;
        }
        set({
          codeView: {
            node,
            code: data.code,
            loading: false,
            error: null,
            truncated: data.truncated,
            mode: get().codeView?.mode ?? "inline",
            baseLine: data.startLine ?? baseLine,
            wholeFile,
          },
        });
      } catch {
        if (get().codeView?.node.id !== node.id) {
          return;
        }
        const mode = get().codeView?.mode ?? "inline";
        set({ codeView: { node, code: null, loading: false, error: "Could not load source.", mode, baseLine, wholeFile } });
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
      // The "call" lens IS the Map surface fed a service-cluster tree now (not the old scorecard
      // composition graph), so it routes to the SAME moduleRelayout as "modules" — the branch by
      // viewMode lives inside moduleRelayout itself. "ui" still derives below.
      if (get().viewMode === "prs") {
        set({ layoutStatus: "idle" });
        return;
      }
      if (get().viewMode === "call" || get().viewMode === "modules") {
        await get().moduleRelayout();
        return;
      }
      const sequence = get().layoutSeq + 1;
      set({ layoutSeq: sequence, layoutStatus: "laying-out" });
      const { index, expanded, focusId, viewMode, flowRootId, flowDepth, showTests } = get();
      const hidden = showTests ? new Set<string>() : index.testIds;
      const flow = flowRootId ? { rootId: flowRootId, depth: flowDepth } : null;
      const graph = await deriveLayout(index, expanded, focusId, viewMode, hidden, flow);
      if (get().layoutSeq !== sequence) {
        return; // a newer toggle superseded this layout; discard the stale result.
      }
      set({ rfNodes: graph.nodes, rfEdges: graph.edges, layoutStatus: "ready" });
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
  const summary = [...(prsList.open ?? []), ...(prsList.closed ?? [])].find((pr) => pr.number === prSelected);
  const context = reviewContextFromPrFiles({
    prNumber: prSelected,
    headRef: summary?.headRef ?? null,
    scopeId: prFilesUrl,
    files: prFiles ?? [],
  });
  const review = deriveReviewDataFromContext(context, artifact, index);
  // The modified code blocks (hunks ∩ node ranges); repaint main's changed-node channel to THIS PR
  // so the Map + minimal overlay ring the edited blocks amber (reused `--changed-since` highlight).
  const affected = computeAffectedNodes(artifact.nodes, context.changedFiles);
  applyChangedIds(index, affected.map((node) => node.nodeId));
  // Seed the minimal graph from the changed FILES (seeds must be module ids).
  const matchedFiles = matchAffectedFiles(index, context.changedFiles.map((file) => file.path)).matched;
  const seeds = [...new Set(matchedFiles.map((match) => match.moduleId))].sort();
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
  set({
    artifact: reviewedArtifact,
    review,
    prReviewed: prSelected,
    reviewTicks: readReviewProgress(context.reviewKey).ticks,
    reviewAffectedIds: new Set(affected.map((node) => node.nodeId)),
    reviewUnmapped: unmappedChangedFiles(affected, context.changedFiles),
    reviewLitNodeIds: null,
    reviewSelectedId: null,
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

/** Order-independent equality of two id lists — the minimal overlay's "members === origin" test. */
function sameMembers(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  const set = new Set(a);
  return b.every((id) => set.has(id));
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
 * Map + UI graph, an XOR toggle on the Logic graph (its set is default-relative, so forcing a node
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
  if (state.viewMode === "modules" || state.viewMode === "call") {
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
  } else if (state.viewMode === "ui") {
    const scope = state.selectedId !== null ? [state.selectedId] : [null];
    const ids = pick(uiVisibleNodes(state), scope);
    if (ids.length === 0) {
      return;
    }
    set({ expanded: foldIds(state.expanded, ids, mode) });
    void get().relayout();
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

/** The Map surface's visible frontier as `ExpandableNode`s (the folder Map or service-cluster tree). */
function moduleTreeNodes(state: BlueprintState, graph: ModuleGraph, deps: BlockDeps): ExpandableNode[] {
  const flows = (state.artifact.extensions?.logicFlow ?? {}) as unknown as LogicFlows;
  const tree =
    state.viewMode === "call"
      ? deriveServiceTree(state.index, state.moduleExpanded, graph, deps, flows)
      : deriveModuleTree(state.index, state.moduleFocus, state.moduleExpanded, graph, deps, flows);
  return tree.nodes;
}

/** The UI call-flow graph's visible frontier as `ExpandableNode`s. */
function uiVisibleNodes(state: BlueprintState): ExpandableNode[] {
  const hidden = state.showTests ? new Set<string>() : state.index.testIds;
  return computeVisible(state.index, state.expanded, state.focusId, hidden).map((visible) => ({
    id: visible.id,
    parentId: visible.node.parentId ?? null,
    isContainer: visible.isContainer,
    isExpanded: visible.isExpanded,
  }));
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
