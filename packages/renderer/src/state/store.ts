/**
 * The single zustand store. `expanded` starts EMPTY so only roots show (progressive
 * disclosure begins at the package/system level), and `environment` starts null and is NEVER
 * auto-set or defaulted to prod. Every structural mutation bumps `layoutSeq` and re-runs the
 * derive pipeline behind a stale guard so a slow ELK pass can never overwrite a newer one.
 */

import { createStore, type StoreApi } from "zustand/vanilla";
import type { GraphArtifact, NodeMetrics } from "@meridian/core";
import type { GraphIndex } from "../graph/graphIndex";
import type { BlueprintEdge, BlueprintNode } from "../layout/rfTypes";
import type { TelemetryProvider } from "../telemetry/provider";
import type { ViewMode } from "../derive/edgeSelection";
import { uiFocusTarget } from "../derive/uiFocus";
import { deriveLayout } from "./deriveLayout";

export type LayoutStatus = "idle" | "laying-out" | "ready" | "error";

export interface BlueprintState {
  artifact: GraphArtifact;
  index: GraphIndex;
  expanded: Set<string>;
  selectedId: string | null;
  /** The dived-into container; null == the graph roots (top level). Never drawn — it IS the breadcrumb. */
  focusId: string | null;
  /** Which relationship story is on screen: the call graph, or the React composition tree. */
  viewMode: ViewMode;
  rfNodes: BlueprintNode[];
  rfEdges: BlueprintEdge[];
  layoutStatus: LayoutStatus;
  layoutSeq: number;
  telemetry: Record<string, NodeMetrics>;
  environment: string | null;
  provider: TelemetryProvider | null;
  hasOverlay: boolean;
  toggleExpand(nodeId: string): void;
  expandPath(nodeId: string): void;
  collapseAll(): void;
  select(nodeId: string | null): void;
  diveInto(nodeId: string): void;
  diveTo(nodeId: string): void;
  diveHome(): void;
  setViewMode(mode: ViewMode): void;
  setEnvironment(environment: string): void;
  refreshTelemetry(): Promise<void>;
  relayout(): Promise<void>;
}

export interface StoreDependencies {
  artifact: GraphArtifact;
  index: GraphIndex;
  provider: TelemetryProvider | null;
  hasOverlay: boolean;
}

export type BlueprintStore = StoreApi<BlueprintState>;

export function createBlueprintStore(dependencies: StoreDependencies): BlueprintStore {
  // The focus to restore when leaving UI mode, kept off the reactive state (nothing renders it).
  let focusBeforeUi: string | null = null;

  return createStore<BlueprintState>((set, get) => ({
    artifact: dependencies.artifact,
    index: dependencies.index,
    expanded: new Set<string>(),
    selectedId: null,
    focusId: null,
    viewMode: "call",
    rfNodes: [],
    rfEdges: [],
    layoutStatus: "idle",
    layoutSeq: 0,
    telemetry: {},
    environment: null,
    provider: dependencies.provider,
    hasOverlay: dependencies.hasOverlay,

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

    async relayout() {
      const sequence = get().layoutSeq + 1;
      set({ layoutSeq: sequence, layoutStatus: "laying-out" });
      const graph = await deriveLayout(get().index, get().expanded, get().focusId, get().viewMode);
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
