/**
 * The single zustand store. `expanded` starts EMPTY so only roots show (progressive
 * disclosure begins at the package/system level), and `environment` starts null and is NEVER
 * auto-set or defaulted to prod. Every structural mutation bumps `layoutSeq` and re-runs the
 * derive pipeline behind a stale guard so a slow ELK pass can never overwrite a newer one.
 */

import { createStore, type StoreApi } from "zustand/vanilla";
import { MarkerType } from "@xyflow/react";
import type { ChangeOverlay, GraphArtifact, NodeChange, NodeMetrics } from "@meridian/core";
import type { GraphIndex } from "../graph/graphIndex";
import type { BlueprintEdge, BlueprintNode, EdgeHighlight } from "../layout/rfTypes";
import type { TelemetryProvider } from "../telemetry/provider";
import type { ViewMode } from "../derive/edgeSelection";
import { uiFocusTarget } from "../derive/uiFocus";
import { EMPTY_HIGHLIGHT, tracePath, traceEdge, type PathHighlight } from "../derive/pathTrace";
import { PATH_DOWNSTREAM, PATH_UPSTREAM, wireColorForKind } from "../theme/edgeColors";
import { deriveLayout } from "./deriveLayout";

/** A node's slice of the change lens: its own diff stats, or a container's roll-up. */
export interface ChangeEntry extends NodeChange {
  /** Number of changed modules (files) at-or-below this node; 0 for a spanned symbol. */
  changedCount: number;
}

export type LayoutStatus = "idle" | "laying-out" | "ready" | "error";

export interface BlueprintState {
  artifact: GraphArtifact;
  index: GraphIndex;
  expanded: Set<string>;
  selectedId: string | null;
  /** Every node on the active path trace; empty == nothing is dimmed. */
  pathNodeIds: ReadonlySet<string>;
  /** How far a click traces: direct neighbours (calm default) or the full transitive impact. */
  traceDepth: "direct" | "full";
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
  /** The change lens (null == structure-only view). */
  change: ChangeOverlay | null;
  /** node.id -> own change or container roll-up; empty when no change lens. */
  changeRollup: ReadonlyMap<string, ChangeEntry>;
  fileDiffUrl: string | null;
  /** The node whose diff the drawer is showing; null == drawer closed. */
  diffNodeId: string | null;
  openDiff(nodeId: string): void;
  closeDiff(): void;
  /** Step the drawer to the previous/next changed node in reading (layout) order. */
  stepDiff(delta: 1 | -1): void;
  toggleExpand(nodeId: string): void;
  expandPath(nodeId: string): void;
  collapseAll(): void;
  select(nodeId: string | null): void;
  selectEdge(edgeId: string): void;
  setTraceDepth(depth: "direct" | "full"): void;
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
  change?: ChangeOverlay | null;
  fileDiffUrl?: string | null;
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
    pathNodeIds: EMPTY_HIGHLIGHT.nodeIds,
    traceDepth: "direct",
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
    change: dependencies.change ?? null,
    changeRollup: buildChangeRollup(dependencies.change ?? null, dependencies.index),
    fileDiffUrl: dependencies.fileDiffUrl ?? null,
    diffNodeId: null,

    openDiff(nodeId) {
      set({ diffNodeId: nodeId });
    },

    closeDiff() {
      set({ diffNodeId: null });
    },

    // Walk EVERY changed stop in the range (deepest symbols first, file order), revealing
    // hidden ones as it goes — the drawer turns review into a lap across the whole map.
    stepDiff(delta) {
      const { diffNodeId, change, index } = get();
      if (!diffNodeId || !change) {
        return;
      }
      const stops = changeStops(change, index);
      if (stops.length === 0) {
        return;
      }
      const at = stops.indexOf(diffNodeId);
      const next = stops[(at === -1 ? 0 : at + delta + stops.length) % stops.length];
      get().expandPath(next);
      set({ diffNodeId: next, selectedId: next });
    },

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

    // Selecting a node traces its up/downstream path (at the chosen depth) over the visible
    // wires and repaints the edge set with direction colours; null clears back to rest.
    select(nodeId) {
      const highlight = nodeId ? tracePath(get().rfEdges, nodeId, hopsFor(get().traceDepth)) : EMPTY_HIGHLIGHT;
      set({
        selectedId: nodeId,
        pathNodeIds: withAncestors(highlight.nodeIds, get().index),
        rfEdges: withHighlight(get().rfEdges, highlight),
      });
    },

    // Changing depth re-traces the current selection in place.
    setTraceDepth(depth) {
      set({ traceDepth: depth });
      const selectedId = get().selectedId;
      if (selectedId) {
        get().select(selectedId);
      }
    },

    // Selecting a wire highlights just that hop and its two endpoints.
    selectEdge(edgeId) {
      const edge = get().rfEdges.find((candidate) => candidate.id === edgeId);
      if (!edge) {
        return;
      }
      const highlight = traceEdge(edge);
      set({
        selectedId: null,
        pathNodeIds: withAncestors(highlight.nodeIds, get().index),
        rfEdges: withHighlight(get().rfEdges, highlight),
      });
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
      let graph: Awaited<ReturnType<typeof deriveLayout>>;
      try {
        graph = await deriveLayout(get().index, get().expanded, get().focusId, get().viewMode);
      } catch (error) {
        // A layout failure must never freeze the canvas on "laying-out" — keep the previous
        // graph on screen and surface the failure where a dev can see it.
        console.error("relayout failed", error);
        if (get().layoutSeq === sequence) {
          set({ layoutStatus: "error" });
        }
        return;
      }
      if (get().layoutSeq !== sequence) {
        return; // a newer toggle superseded this layout; discard the stale result.
      }
      // The visible set changed under the selection: re-trace it when the node survived the
      // change (e.g. a sibling expanded mid-trace), clear it when it vanished (dive/collapse).
      const selectedId = get().selectedId;
      const stillVisible = selectedId !== null && graph.nodes.some((node) => node.id === selectedId);
      const highlight =
        stillVisible && selectedId
          ? tracePath(graph.edges, selectedId, hopsFor(get().traceDepth))
          : EMPTY_HIGHLIGHT;
      set({
        rfNodes: graph.nodes,
        rfEdges: withHighlight(graph.edges, highlight),
        layoutStatus: "ready",
        selectedId: stillVisible ? selectedId : null,
        pathNodeIds: withAncestors(highlight.nodeIds, get().index),
      });
    },
  }));
}

function hopsFor(depth: "direct" | "full"): number {
  return depth === "direct" ? 1 : Number.POSITIVE_INFINITY;
}

/**
 * Fold the flat change overlay onto the containment tree, once per boot. Every changed node
 * keeps its own stats; containers accumulate ONLY their descendant modules' whole-file totals
 * (module ± already contains the file's function-level lines — summing both would double-count).
 */
function buildChangeRollup(
  change: ChangeOverlay | null,
  index: GraphIndex,
): ReadonlyMap<string, ChangeEntry> {
  const rollup = new Map<string, ChangeEntry>();
  if (!change) {
    return rollup;
  }
  for (const [nodeId, nodeChange] of Object.entries(change.nodes)) {
    const own = rollup.get(nodeId);
    rollup.set(nodeId, {
      ...nodeChange,
      changedCount: own?.changedCount ?? 0,
    });
    if (index.nodesById.get(nodeId)?.kind !== "module") {
      continue;
    }
    for (const ancestor of index.ancestorsOf(nodeId)) {
      if (ancestor.id === nodeId) {
        continue;
      }
      const aggregate = rollup.get(ancestor.id);
      if (aggregate) {
        aggregate.additions += nodeChange.additions;
        aggregate.deletions += nodeChange.deletions;
        aggregate.changedCount += 1;
      } else {
        rollup.set(ancestor.id, {
          status: "modified",
          additions: nodeChange.additions,
          deletions: nodeChange.deletions,
          changedCount: 1,
        });
      }
    }
  }
  return rollup;
}

/**
 * The review walk's stops: every changed node with NO changed descendant (a method beats its
 * class, a function beats its module; a test module with no symbol entries stands by itself),
 * ordered by file then source line — the same order a reviewer reads a diff in.
 */
export function changeStops(change: ChangeOverlay, index: GraphIndex): string[] {
  const ids = Object.keys(change.nodes);
  const deepest = ids.filter(
    (id) => !ids.some((other) => other !== id && (other.startsWith(`${id}.`) || other.startsWith(`${id}#`))),
  );
  return deepest
    .map((id) => {
      const node = index.nodesById.get(id);
      return { id, file: node?.location?.file ?? "", line: node?.location?.startLine ?? 0 };
    })
    .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line))
    .map((stop) => stop.id);
}

/**
 * Expanded container frames never receive lifted edges (wires lift to their visible children),
 * so without their ancestors a traced path would sit inside dimmed boxes. Lighting the whole
 * containment chain keeps the frames around the path readable.
 */
function withAncestors(nodeIds: ReadonlySet<string>, index: GraphIndex): ReadonlySet<string> {
  if (nodeIds.size === 0) {
    return nodeIds;
  }
  const expanded = new Set(nodeIds);
  for (const nodeId of nodeIds) {
    for (const ancestor of index.ancestorsOf(nodeId)) {
      expanded.add(ancestor.id);
    }
  }
  return expanded;
}

/**
 * Stamp a path trace onto the edge set: every edge gets its highlight state in `data` and a
 * marker recoloured to match (markers are static per edge object, so a repaint means new edge
 * objects — cheap at lifted-edge counts, and React Flow diffs by id).
 */
function withHighlight(edges: BlueprintEdge[], highlight: PathHighlight): BlueprintEdge[] {
  const active = highlight.nodeIds.size > 0;
  return edges.map((edge) => {
    const direction = highlight.edgeDirections.get(edge.id);
    const state: EdgeHighlight = !active ? "rest" : (direction ?? "off");
    if (edge.data?.highlight === state) {
      return edge;
    }
    const color =
      state === "down" ? PATH_DOWNSTREAM
      : state === "up" ? PATH_UPSTREAM
      : wireColorForKind(edge.data?.kind ?? "");
    return {
      ...edge,
      markerEnd: { type: MarkerType.ArrowClosed, color, width: 15, height: 15 },
      data: { ...edge.data, highlight: state } as BlueprintEdge["data"],
    };
  });
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
