/**
 * The single zustand store. `expanded` starts EMPTY so only roots show (progressive
 * disclosure begins at the package/system level), and `environment` starts null and is NEVER
 * auto-set or defaulted to prod. Every structural mutation bumps `layoutSeq` and re-runs the
 * derive pipeline behind a stale guard so a slow ELK pass can never overwrite a newer one.
 */

import { createStore, type StoreApi } from "zustand/vanilla";
import type { FlowPath, FlowStep, GraphArtifact, GraphNode, LogicFlows, NodeId, NodeMetrics } from "@meridian/core";
import type { GraphIndex } from "../graph/graphIndex";
import type { BlueprintEdge, BlueprintNode } from "../layout/rfTypes";
import type { TelemetryProvider } from "../telemetry/provider";
import type { ViewMode } from "../derive/edgeSelection";
import { uiFocusTarget } from "../derive/uiFocus";
import { deriveLayout } from "./deriveLayout";
import { deriveLogicLayout } from "./deriveLogicLayout";
import type { LogicRfNode, LogicRfEdge } from "../layout/logicElk";

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
  /** The entry node whose forward call-flow is isolated on screen; null == the whole graph. */
  flowRootId: string | null;
  /** Hop cap from the flow entry; null == follow the flow all the way. */
  flowDepth: number | null;
  /** The callable whose intra-procedural logic flow the Logic-flow view charts; null == none picked yet. */
  logicRoot: NodeId | null;
  /** The drill trail into logic flows, oldest first — root..current — powering the logic breadcrumb. */
  logicStack: NodeId[];
  /** The DIVE trail INTO control containers, oldest first; each entry re-charts the canvas to show
   * only that container's bodies. Empty == show the whole callable flow. It sits ON TOP of the
   * callable's `logicStack` in the breadcrumb (a container lives inside the current callable). */
  logicFocus: Array<{ id: string; label: string; bodies: FlowPath[] }>;
  /** How many levels of resolved calls the Logic-flow view inlines in place; 0 == calls are leaf
   * chips (today's behavior). Sticky across open/drill so the reader keeps their chosen depth. */
  logicInlineDepth: number;
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
  /** The laid-out Logic graph (React Flow), recomputed on open/drill/expand/toggle via ELK. */
  logicRfNodes: LogicRfNode[];
  logicRfEdges: LogicRfEdge[];
  logicLayoutStatus: LayoutStatus;
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
  drillLogicFlow(nodeId: string): void;
  logicFlowTo(nodeId: string): void;
  diveLogicContainer(id: string, label: string, bodies: FlowPath[]): void;
  logicFocusTo(index: number): void;
  setLogicInlineDepth(depth: number): void;
  setGhostDepth(depth: number): void;
  selectLogicTarget(id: NodeId | null): void;
  togglePinnedFlow(id: NodeId): void;
  toggleLogicExpand(nodeId: string): void;
  toggleHideGreyed(): void;
  logicRelayout(): Promise<void>;
  setViewMode(mode: ViewMode): void;
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
  // Null when the server didn't ship source access — the code drawer is then inert.
  const sourceUrl = dependencies.sourceUrl;

  return createStore<BlueprintState>((set, get) => ({
    artifact: dependencies.artifact,
    index: dependencies.index,
    expanded: new Set<string>(),
    selectedId: null,
    focusId: null,
    viewMode: "call",
    flowRootId: null,
    flowDepth: null,
    logicRoot: null,
    logicStack: [],
    logicFocus: [],
    logicInlineDepth: 0,
    logicSelected: null,
    ghostDepth: 1,
    pinnedFlows: [],
    expandedLogic: new Set<string>(),
    hideGreyed: false,
    logicRfNodes: [],
    logicRfEdges: [],
    logicLayoutStatus: "idle",
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

    // Re-derive the Logic graph for the current root through ELK, behind a stale-seq guard (a newer
    // open/drill/toggle discards an older in-flight layout). A null root clears the graph.
    async logicRelayout() {
      const { logicRoot, index, artifact, expandedLogic, hideGreyed, logicFocus } = get();
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
      const graph = await deriveLogicLayout(logicRoot, flows, index, expandedLogic, { hideGreyed }, focus);
      if (logicLayoutSeq !== sequence) {
        return; // a newer layout superseded this one.
      }
      set({ logicRfNodes: graph.nodes, logicRfEdges: graph.edges, logicLayoutStatus: "ready" });
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
      const sequence = get().layoutSeq + 1;
      set({ layoutSeq: sequence, layoutStatus: "laying-out" });
      const { index, expanded, focusId, viewMode, flowRootId, flowDepth } = get();
      const flow = flowRootId ? { rootId: flowRootId, depth: flowDepth } : null;
      const graph = await deriveLayout(index, expanded, focusId, viewMode, flow);
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
