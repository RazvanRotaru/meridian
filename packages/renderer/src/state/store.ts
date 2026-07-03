/**
 * The single zustand store. `expanded` starts EMPTY so only roots show (progressive
 * disclosure begins at the package/system level), and `environment` starts null and is NEVER
 * auto-set or defaulted to prod. Every structural mutation bumps `layoutSeq` and re-runs the
 * derive pipeline behind a stale guard so a slow ELK pass can never overwrite a newer one.
 */

import { createStore, type StoreApi } from "zustand/vanilla";
import type { GraphArtifact, GraphNode, NodeMetrics } from "@meridian/core";
import type { GraphIndex } from "../graph/graphIndex";
import type { BlueprintEdge, BlueprintNode } from "../layout/rfTypes";
import type { TelemetryProvider } from "../telemetry/provider";
import type { ViewMode } from "../derive/edgeSelection";
import { uiFocusTarget } from "../derive/uiFocus";
import { deriveLayout } from "./deriveLayout";

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

    // Switching mode re-derives + relayouts like a dive. Entering UI mode dives to the render
    // subtree; leaving it returns to call-flow at the focus you had before (home if none).
    setViewMode(mode) {
      if (get().viewMode === mode) {
        return;
      }
      if (mode === "ui") {
        focusBeforeUi = get().focusId;
        set({ viewMode: mode, focusId: uiFocusTarget(get().index) });
      } else {
        set({ viewMode: mode, focusId: focusBeforeUi });
        focusBeforeUi = null;
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
