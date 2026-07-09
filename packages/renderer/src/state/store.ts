/**
 * The single zustand store. `expanded` starts EMPTY so only roots show (progressive
 * disclosure begins at the package/system level), and `environment` starts null and is NEVER
 * auto-set or defaulted to prod. Every structural mutation bumps `layoutSeq` and re-runs the
 * derive pipeline behind a stale guard so a slow ELK pass can never overwrite a newer one.
 */

import { createStore, type StoreApi } from "zustand/vanilla";
import type { Edge, Node } from "@xyflow/react";
import { computeCoverage } from "@meridian/core";
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
import type { GraphIndex } from "../graph/graphIndex";
import type { BlueprintEdge, BlueprintNode } from "../layout/rfTypes";
import type { TelemetryProvider } from "../telemetry/provider";
import type { ViewMode } from "../derive/edgeSelection";
import type { LogicViewMode } from "../derive/flowViewModel";
import { uiFocusTarget } from "../derive/uiFocus";
import { deriveLayout } from "./deriveLayout";
import { deriveLogicLayout } from "./deriveLogicLayout";
import { deriveCompositionLayout } from "./deriveCompositionLayout";
import { deriveModuleLevelLayout } from "./deriveModuleMapLayout";
import { buildModuleGraph, type ModuleGraph } from "../derive/moduleGraph";
import type { ModuleCategory } from "../derive/moduleCategory";
import { readSolidMetricsPref, writeSolidMetricsPref } from "./solidMetricsPref";
import type { LogicRfNode, LogicRfEdge } from "../layout/logicElk";
import type { CompRfNode, CompRfEdge } from "../layout/compositionElk";
import { deriveReviewData, applyTick, type ReviewData } from "../derive/reviewData";
import { deriveReviewNodeLayout } from "./deriveReviewNodeLayout";
import { readReviewProgress, writeReviewProgress, clearReviewProgress, type ReviewTick } from "./reviewTicksPref";

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
  /** Module categories painted OUT of the map (a render-time filter — never a re-derive). */
  hiddenCategories: Set<ModuleCategory>;
  /** The selected node ids in the Module map (ctrl/cmd+click accumulates several); empty == none.
   * A repaint-only highlight — no relayout. */
  moduleSelected: Set<string>;
  /** Legacy URL-restored Module-map expansion ids. The flat map ignores these, but keeping the field
   * lets old links round-trip without throwing away unrelated navigation state. */
  moduleExpanded: Set<string>;
  /** The parsed PR-review data (checklist rows + flow trees); null hides the "PR review" tab entirely. */
  review: ReviewData | null;
  /** The laid-out minimal review graph (code-block nodes + file/class frames), recomputed via ELK. */
  reviewRfNodes: Node[];
  reviewRfEdges: Edge[];
  reviewLayoutStatus: LayoutStatus;
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
  telemetry: Record<string, NodeMetrics>;
  environment: string | null;
  provider: TelemetryProvider | null;
  hasOverlay: boolean;
  /** Base URL for on-demand source fetches; null when the server ships no source access. Node
   * components read it to decide whether to offer a "show source" control. */
  sourceUrl: string | null;
  /** The open source view (inline panel or modal); null when nothing is being shown. */
  codeView: CodeView | null;
  toggleExpand(nodeId: string): void;
  expandPath(nodeId: string): void;
  collapseAll(): void;
  select(nodeId: string | null): void;
  diveInto(nodeId: string): void;
  diveTo(nodeId: string): void;
  diveHome(): void;
  isolateFlow(nodeId: string): void;
  clearFlow(): void;
  setFlowDepth(depth: number | null): void;
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
  setModuleRadius(radius: number): void;
  toggleCategory(category: ModuleCategory): void;
  selectModule(id: string | null): void;
  toggleModuleSelect(id: string): void;
  reviewRelayout(): Promise<void>;
  setReviewLit(ids: Set<string> | null): void;
  selectReviewNode(id: string | null): void;
  toggleReviewTick(flowId: string): void;
  resetReviewTicks(): void;
  setViewMode(mode: ViewMode): void;
  toggleShowTests(): void;
  toggleCoverageMode(): void;
  setEnvironment(environment: string): void;
  refreshTelemetry(): Promise<void>;
  showCode(node: GraphNode): Promise<void>;
  expandCode(): void;
  closeCode(): void;
  relayout(): Promise<void>;
}

export interface StoreDependencies {
  artifact: GraphArtifact;
  index: GraphIndex;
  provider: TelemetryProvider | null;
  hasOverlay: boolean;
  sourceUrl: string | null;
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
  // The file import graph, built once on first module-map relayout (the artifact never changes after
  // boot) and reused for every level — never rebuilt per relayout.
  let moduleGraph: ModuleGraph | null = null;
  // And for the composition-tab method-preview drawer's logic layout (the EXPERIMENT surface).
  let compMethodLayoutSeq = 0;
  // And for the PR-review code-block graph, so a stale ELK pass never overwrites a newer one.
  let reviewLayoutSeq = 0;
  // The parsed review payload (null when the artifact carries no valid `review` extension). Computed
  // once — the artifact never changes after boot — and it gates the whole "PR review" tab on/off.
  const review = deriveReviewData(dependencies.artifact, dependencies.index);
  // Null when the server didn't ship source access — the code drawer is then inert.
  const sourceUrl = dependencies.sourceUrl;
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
    // An artifact stamped by `meridian review` opens straight on the review graph; everything else
    // opens on the Module map as before.
    viewMode: review ? "review" : "modules",
    showTests: true,
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
    hiddenCategories: new Set<ModuleCategory>(),
    moduleSelected: new Set<string>(),
    moduleExpanded: new Set<string>(),
    review,
    reviewRfNodes: [],
    reviewRfEdges: [],
    reviewLayoutStatus: "idle",
    reviewAffectedIds: new Set<string>(),
    reviewUnmapped: [],
    reviewTicks: review ? readReviewProgress(review.context.reviewKey).ticks : {},
    reviewLitNodeIds: null,
    reviewSelectedId: null,
    rfNodes: [],
    rfEdges: [],
    layoutStatus: "idle",
    layoutSeq: 0,
    telemetry: {},
    environment: null,
    provider: dependencies.provider,
    hasOverlay: dependencies.hasOverlay,
    sourceUrl,
    codeView: null,

    toggleExpand(nodeId) {
      set({ expanded: withToggled(get().expanded, nodeId) });
      void get().relayout();
    },

    expandPath(nodeId) {
      set({ expanded: withAncestorsOf(nodeId, get().index, get().expanded) });
      void get().relayout();
    },

    collapseAll() {
      set({ expanded: new Set<string>() });
      void get().relayout();
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
    // selection AND the method-preview drawer (both mean nothing in a new rooted view) and re-lays
    // out. A no-op when already there, matching the store's other navigation guards.
    setCompRoot(id) {
      if (get().compRoot === id) {
        return;
      }
      set({ compRoot: id, compExpanded: new Set<string>(), compSelectedId: null, compMethodId: null, compMethodRfNodes: [], compMethodRfEdges: [], compMethodLayoutStatus: "idle" });
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

    // Re-derive the Module-map LEVEL for the current focus through ELK, behind the same stale-seq
    // guard. The import graph is built once (cached) and reused for every level. A null focus is the
    // whole-repo package overview; a package focus is its children with imports folded to them.
    async moduleRelayout() {
      const { index, moduleFocus, moduleExpanded } = get();
      moduleGraph ??= buildModuleGraph(index);
      const sequence = ++moduleLayoutSeq;
      set({ moduleLayoutStatus: "laying-out" });
      const layout = await deriveModuleLevelLayout(index, moduleFocus, moduleExpanded, moduleGraph);
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
      set({ moduleFocus: id, moduleSelected: new Set<string>(), moduleExpanded: new Set<string>() });
      void get().moduleRelayout();
    },

    // Legacy no-op path for older URLs/widgets that still try to flip Module-map expansion state.
    // The flat map ignores this set, but relayout keeps callers from observing stale derived nodes.
    toggleModuleExpand(nodeId) {
      set({ moduleExpanded: withToggled(get().moduleExpanded, nodeId) });
      void get().moduleRelayout();
    },

    // Set the selection's highlight radius (clamped 1..GHOST_DEPTH_ALL). PAINT-ONLY: the surface
    // recomputes the lit neighbourhood in a useMemo, so this deliberately does NOT relayout.
    setModuleRadius(radius) {
      set({ moduleRadius: Math.max(1, Math.min(GHOST_DEPTH_ALL, Math.trunc(radius))) });
    },

    // Show/hide a module category. PAINT-ONLY: the surface filters the category's file cards out in
    // place, so this deliberately does NOT relayout — positions stay stable.
    toggleCategory(category) {
      set({ hiddenCategories: withToggledCategory(get().hiddenCategories, category) });
    },

    // Select a Module-map node, REPLACING the whole selection (pass null to clear) — the plain-click
    // gesture. A repaint-only highlight — no relayout.
    selectModule(id) {
      set({ moduleSelected: id === null ? new Set<string>() : new Set([id]) });
    },

    // Flip one Module-map node in/out of the selection WITHOUT touching the rest — the ctrl/cmd+click
    // gesture that accumulates a multi-selection. Repaint-only, like selectModule.
    toggleModuleSelect(id) {
      set({ moduleSelected: withToggled(get().moduleSelected, id) });
    },

    // Lay the minimal code-block review graph out via ELK, behind the stale guard. A no-op when the
    // artifact carries no review data (the tab is hidden anyway).
    async reviewRelayout() {
      const { index, review } = get();
      if (!review) {
        return;
      }
      const sequence = ++reviewLayoutSeq;
      set({ reviewLayoutStatus: "laying-out" });
      const layout = await deriveReviewNodeLayout(index, review.context.changedFiles);
      if (reviewLayoutSeq !== sequence) {
        return; // a newer relayout superseded this one.
      }
      set({
        reviewRfNodes: layout.nodes,
        reviewRfEdges: layout.edges,
        reviewAffectedIds: layout.affectedIds,
        reviewUnmapped: layout.unmapped,
        reviewLayoutStatus: "ready",
      });
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
      if (mode === "logic") {
        set({ viewMode: mode });
        return;
      }
      // The Module map is a standalone surface (its own ELK level layout), so — like logic — it neither
      // dives nor touches the graph focus; it just flips the mode and lays its own graph out. Clicking
      // INTO the lens always opens at the whole-repo package overview (level 0), never a focus inherited
      // from a prior visit. A shared/reloaded deep link is unaffected: it restores via setState on boot
      // (not this click path), so an explicit ?mfocus=… still opens at that level.
      if (mode === "modules") {
        set({ viewMode: mode, moduleFocus: null, moduleExpanded: new Set<string>() });
        void get().moduleRelayout();
        return;
      }
      // The review graph is a standalone ELK surface like the module map; flip the mode and lay it out
      // once (re-entry keeps the graph as left, so a relayout only runs when the canvas is empty).
      if (mode === "review") {
        set({ viewMode: mode });
        if (get().reviewRfNodes.length === 0) {
          void get().reviewRelayout();
        }
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
    async showCode(node) {
      if (!sourceUrl || !node.location) {
        return;
      }
      set({ codeView: { node, code: null, loading: true, error: null, mode: "inline" } });
      try {
        const url = new URL(sourceUrl, window.location.origin);
        url.searchParams.set("file", node.location.file);
        url.searchParams.set("start", String(node.location.startLine));
        url.searchParams.set("end", String(node.location.endLine ?? node.location.startLine));
        const res = await fetch(url, { credentials: "same-origin" });
        if (get().codeView?.node.id !== node.id) {
          return;
        }
        const mode = get().codeView?.mode ?? "inline";
        if (!res.ok) {
          set({ codeView: { node, code: null, loading: false, error: "Could not load source.", mode } });
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
          },
        });
      } catch {
        if (get().codeView?.node.id !== node.id) {
          return;
        }
        const mode = get().codeView?.mode ?? "inline";
        set({ codeView: { node, code: null, loading: false, error: "Could not load source.", mode } });
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

    async relayout() {
      // The "call" lens IS the Service-composition graph now (not the old call graph), so route its
      // layout to compRelayout and skip the deriveLayout path entirely. This runs on the boot relayout
      // (viewMode starts "call") and whenever setViewMode re-enters "call", so composition populates
      // on first load and on every tab-switch back with no separate trigger. "ui" still derives below.
      if (get().viewMode === "call") {
        await get().compRelayout();
        return;
      }
      // The Module map is its own surface with a synchronous ring layout; route it to moduleRelayout
      // (this also runs on a boot/back-forward restore into the "modules" lens). "ui" derives below.
      if (get().viewMode === "modules") {
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

function withToggled(expanded: Set<string>, nodeId: string): Set<string> {
  const next = new Set(expanded);
  if (next.has(nodeId)) {
    next.delete(nodeId);
  } else {
    next.add(nodeId);
  }
  return next;
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

/** Expand every container on the path to `nodeId` so a deep target becomes visible at once. */
function withAncestorsOf(nodeId: string, index: GraphIndex, expanded: Set<string>): Set<string> {
  const next = new Set(expanded);
  const visited = new Set<string>();
  let current: string | null | undefined = index.isContainer(nodeId) ? nodeId : index.parentOf.get(nodeId);
  // A separate visited set (not `next`, which is pre-seeded) terminates on a parentId cycle.
  while (current && !visited.has(current)) {
    visited.add(current);
    next.add(current);
    current = index.parentOf.get(current);
  }
  return next;
}
