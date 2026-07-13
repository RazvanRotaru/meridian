/**
 * Shared lifecycle controller for a semantic GraphSurface mount. Threshold detection stays in
 * GraphSurface/MapLod; this hook owns the mount-level concerns which must survive paint changes:
 * fitting the current retained population, accepting a parent commit, and handing the camera from
 * the collapsed graph to its already-laid canonical anchor.
 *
 * Two commit adapters cover both surface shapes without forking timing:
 *
 *   - `retained-anchor` synchronously discards inner layers in the same canvas. The hook holds the
 *     old threshold origin through the camera reset, centres the retained anchor, and returns to
 *     reading zoom.
 *   - `exit` leaves the current surface mounted for the same shared fade, then invokes an adapter
 *     which may unmount it (for example, an overlay revealing its source surface underneath).
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Edge, Node, ReactFlowInstance } from "@xyflow/react";
import { absoluteRectOf } from "../../layout/ghostBandPlacement";
import { CANVAS_MIN_ZOOM } from "./flowCanvasProps";
import { SEMANTIC_LAYER_FADE_MS } from "./MapLod";
import {
  normalizedSemanticDepths,
  SEMANTIC_ZOOM_BAND_RATIO,
  type SemanticLodLayer,
} from "./mapLodGeometry";

export type SemanticSurfaceLayoutStatus = "idle" | "laying-out" | "ready" | "error";

export interface RetainedAnchorCommitAdapter {
  mode: "retained-anchor";
  /** Must synchronously retain `layer.depth` and return false when the request became stale. */
  commit(layer: SemanticLodLayer): boolean;
}

export interface ExitSemanticSurfaceCommitAdapter {
  mode: "exit";
  /** Runs after the shared layer fade. A false result re-arms the still-mounted surface. */
  commit(layer: SemanticLodLayer): boolean | void;
}

export type SemanticSurfaceCommitAdapter =
  | RetainedAnchorCommitAdapter
  | ExitSemanticSurfaceCommitAdapter;

export interface SemanticSurfaceFitOptions {
  padding?: number;
  duration?: number;
  minZoom?: number;
  maxZoom?: number;
}

export interface UseSemanticSurfaceNavigationOptions {
  /** The nodes mounted in this surface, including hidden semantic parent populations. */
  nodes: readonly Node[];
  /** Optional visibility-filtered population used only for ordinary fitting. Semantic depth and
   * retained-anchor geometry still read the canonical `nodes` array. */
  fitNodes?: readonly Node[];
  layoutStatus: SemanticSurfaceLayoutStatus;
  semanticLayers: readonly SemanticLodLayer[];
  /**
   * Values whose identity defines a newly derived level (focus, scope, structural toggles, etc.).
   * A retained commit is expected to change at least one value synchronously; that first change is
   * consumed by the handoff instead of triggering the ordinary whole-level fit.
   */
  resetKeys: readonly unknown[];
  commitAdapter: SemanticSurfaceCommitAdapter;
  /** False disables the ordinary current-population fit while retaining semantic handoffs. */
  fit?: false | SemanticSurfaceFitOptions;
}

export interface SemanticSurfaceNavigationController {
  /** Absolute semantic depths, suitable for GraphSurface.semanticDepths. */
  semanticDepths: number[];
  /** Nodes at the smallest retained depth, suitable for fit/empty-state calculations. */
  currentNodes: Node[];
  instanceRef: React.RefObject<ReactFlowInstance<Node, Edge> | null>;
  onInit(instance: ReactFlowInstance<Node, Edge>): void;
  onSemanticCommit(layer: SemanticLodLayer): void;
  /** Pass through to GraphSurface while a retained parent camera handoff is active. */
  semanticBandOriginDepth: number | undefined;
  /** False while layout or a programmatic fit establishes this surface's reading viewport. */
  semanticLodEnabled: boolean;
  /** Pass through to GraphSurface to prevent a second commit during either handoff mode. */
  semanticCommitEnabled: boolean;
  /** True during the shared exit fade, so an overlay can fade its opaque canvas and reveal the
   * already-mounted source surface underneath without owning another timer. */
  exitPending: boolean;
}

const HANDOFF_READING_ZOOM = 1;
const HANDOFF_ZOOM_DURATION_MS = 280;
const HANDOFF_END_BUFFER_MS = 24;
const DEFAULT_FIT: Required<Pick<SemanticSurfaceFitOptions, "padding" | "duration" | "minZoom">> = {
  padding: 0.2,
  duration: 400,
  minZoom: CANVAS_MIN_ZOOM,
};
const DEFAULT_FIT_REQUEST: SemanticSurfaceFitOptions = {};
/** Keep two proportional outward bands reachable above the canvas floor after a calibrated fit. */
export const SEMANTIC_READING_MIN_ZOOM =
  (CANVAS_MIN_ZOOM / (SEMANTIC_ZOOM_BAND_RATIO ** 2)) * 1.1;

interface PendingRetainedParent {
  depth: number;
  anchorId: string;
  resetConsumed: boolean;
  started: boolean;
}

export type SemanticResetDisposition = "preserve-exit" | "consume-retained" | "reset";

/** Pure lifecycle decision used by the reset effect. An armed exit owns its short fade even if a
 * layout completes underneath it; retained navigation consumes exactly its synchronous focus reset. */
export function semanticResetDisposition(
  exitPending: boolean,
  retainedPending: boolean,
  retainedResetConsumed: boolean,
): SemanticResetDisposition {
  if (exitPending) {
    return "preserve-exit";
  }
  return retainedPending && !retainedResetConsumed ? "consume-retained" : "reset";
}

/** Start the retained-parent camera reset in the current layout pass and return the delay before
 * releasing handoff ownership. Reduced motion keeps the final settling buffer but skips animation. */
export function beginSemanticRetainedCameraReset(
  setReadingCenter: (duration: number) => void,
  reducedMotion: boolean,
): number {
  const duration = reducedMotion ? 0 : HANDOFF_ZOOM_DURATION_MS;
  setReadingCenter(duration);
  return duration + HANDOFF_END_BUFFER_MS;
}

/** Pure depth collection shared by the hook and its callers' tests. Layer metadata participates so
 * an exit surface can advertise a parent depth even when that parent's nodes live underneath it. */
export function semanticSurfaceDepths(
  nodes: readonly Node[],
  semanticLayers: readonly SemanticLodLayer[],
): number[] {
  const nodeDepths = nodes
    .map((node) => semanticDepthOf(node))
    .filter((depth): depth is number => depth !== undefined);
  const layerDepths = semanticLayers.map((layer) => layer.depth);
  const fallbackCurrentDepth =
    nodeDepths.length === 0 && layerDepths.length > 0
      ? Math.max(0, Math.min(...layerDepths) - 1)
      : undefined;
  return normalizedSemanticDepths([
    ...nodeDepths,
    ...layerDepths,
    ...(fallbackCurrentDepth === undefined ? [] : [fallbackCurrentDepth]),
  ]);
}

export function nodesAtCurrentSemanticDepth(nodes: readonly Node[], depths: readonly number[]): Node[] {
  const currentDepth = normalizedSemanticDepths(depths)[0];
  if (currentDepth === undefined) {
    return [...nodes];
  }
  return nodes.filter((node) => semanticDepthOf(node) === currentDepth);
}

export function useSemanticSurfaceNavigation({
  nodes,
  fitNodes = nodes,
  layoutStatus,
  semanticLayers,
  resetKeys,
  commitAdapter,
  fit = DEFAULT_FIT_REQUEST,
}: UseSemanticSurfaceNavigationOptions): SemanticSurfaceNavigationController {
  const semanticDepths = useMemo(
    () => semanticSurfaceDepths(nodes, semanticLayers),
    [nodes, semanticLayers],
  );
  const currentNodes = useMemo(
    () => nodesAtCurrentSemanticDepth(fitNodes, semanticDepths),
    [fitNodes, semanticDepths],
  );
  const stableResetKeys = useShallowStableArray(resetKeys);
  const instanceRef = useRef<ReactFlowInstance<Node, Edge> | null>(null);
  const fittedRef = useRef(false);
  const pendingRetainedRef = useRef<PendingRetainedParent | null>(null);
  const pendingExitRef = useRef<SemanticLodLayer | null>(null);
  const handoffTimersRef = useRef<number[]>([]);
  const fitFrameRef = useRef<number | null>(null);
  const fitGenerationRef = useRef(0);
  const commitAdapterRef = useRef(commitAdapter);
  commitAdapterRef.current = commitAdapter;
  const [instanceReady, setInstanceReady] = useState(false);
  const [semanticBandOriginDepth, setSemanticBandOriginDepth] = useState<number>();
  const [semanticLodEnabled, setSemanticLodEnabled] = useState(fit === false);
  const [exitPending, setExitPending] = useState(false);

  const clearHandoffTimers = useCallback(() => {
    handoffTimersRef.current.forEach((timer) => window.clearTimeout(timer));
    handoffTimersRef.current = [];
  }, []);

  const onInit = useCallback((instance: ReactFlowInstance<Node, Edge>) => {
    instanceRef.current = instance;
    setInstanceReady(true);
  }, []);

  const onSemanticCommit = useCallback((layer: SemanticLodLayer) => {
    if (layoutStatus !== "ready" || !semanticLodEnabled) {
      return;
    }
    if (pendingRetainedRef.current !== null || pendingExitRef.current !== null) {
      return;
    }
    const target = semanticLayers.find((candidate) => candidate.depth === layer.depth);
    const originDepth = semanticDepths[0];
    if (target === undefined || originDepth === undefined || target.depth <= originDepth) {
      return;
    }

    const adapter = commitAdapterRef.current;
    if (adapter.mode === "exit") {
      pendingExitRef.current = target;
      fittedRef.current = true;
      setExitPending(true);
      return;
    }

    const instance = instanceRef.current;
    if (instance === null) {
      return;
    }
    const pending: PendingRetainedParent = {
      depth: target.depth,
      anchorId: target.anchorId,
      resetConsumed: false,
      started: false,
    };
    pendingRetainedRef.current = pending;
    if (!adapter.commit(target)) {
      pendingRetainedRef.current = null;
      return;
    }
    fittedRef.current = true;
    setSemanticBandOriginDepth(originDepth);
  }, [layoutStatus, semanticDepths, semanticLayers, semanticLodEnabled]);

  // Retained navigation changes one or more reset keys, but the already-mounted parent owns that
  // transition. A later reset is an explicit relayout/navigation and restores ordinary fit.
  useLayoutEffect(() => {
    const disposition = semanticResetDisposition(
      pendingExitRef.current !== null,
      pendingRetainedRef.current !== null,
      pendingRetainedRef.current?.resetConsumed ?? false,
    );
    // Once an exit is armed, a concurrently completing minimal relayout must not cancel it halfway
    // through the fade and leave the camera parked on its metadata-only parent depth.
    if (disposition === "preserve-exit") {
      fittedRef.current = true;
      return;
    }
    const pending = pendingRetainedRef.current;
    if (disposition === "consume-retained" && pending !== null) {
      pending.resetConsumed = true;
      fittedRef.current = true;
      return;
    }
    clearHandoffTimers();
    pendingRetainedRef.current = null;
    pendingExitRef.current = null;
    setExitPending(false);
    setSemanticBandOriginDepth(undefined);
    fittedRef.current = false;
    fitGenerationRef.current += 1;
    if (fit !== false) {
      setSemanticLodEnabled(false);
    }
  }, [clearHandoffTimers, fit, stableResetKeys]);

  // The exit surface stays mounted just long enough for the same population fade used by retained
  // parents. The adapter may synchronously unmount it; cleanup safely cancels an abandoned exit.
  useEffect(() => {
    if (!exitPending) {
      return;
    }
    const delay = prefersReducedMotion() ? 0 : SEMANTIC_LAYER_FADE_MS;
    const timer = window.setTimeout(() => {
      const layer = pendingExitRef.current;
      const adapter = commitAdapterRef.current;
      if (layer === null || adapter.mode !== "exit") {
        return;
      }
      const accepted = adapter.commit(layer);
      if (accepted === false) {
        pendingExitRef.current = null;
        fittedRef.current = false;
        fitGenerationRef.current += 1;
        setSemanticLodEnabled(false);
        setExitPending(false);
      }
    }, delay);
    return () => window.clearTimeout(timer);
  }, [exitPending]);

  // Pan and zoom to the canonical retained anchor as its population switches in, rather than
  // parking at the collapse zoom for the layer fade. The release timer lives outside this layout
  // effect so a harmless node-array identity change cannot strand the handoff halfway through.
  useLayoutEffect(() => {
    const pending = pendingRetainedRef.current;
    const instance = instanceRef.current;
    if (
      pending === null ||
      pending.started ||
      instance === null ||
      layoutStatus !== "ready"
    ) {
      return;
    }
    const anchor = nodes.find(
      (node) => node.id === pending.anchorId && semanticDepthOf(node) === pending.depth,
    );
    if (anchor === undefined) {
      pendingRetainedRef.current = null;
      setSemanticBandOriginDepth(undefined);
      fittedRef.current = false;
      return;
    }
    pending.started = true;
    const rect = absoluteRectOf(anchor, new Map(nodes.map((node) => [node.id, node])));
    const centerX = rect.x + rect.width / 2;
    const centerY = rect.y + rect.height / 2;
    const releaseDelay = beginSemanticRetainedCameraReset((duration) => {
      void instance.setCenter(centerX, centerY, {
        zoom: HANDOFF_READING_ZOOM,
        duration,
      });
    }, prefersReducedMotion());
    const releaseTimer = window.setTimeout(() => {
      void instance.setCenter(centerX, centerY, {
        zoom: HANDOFF_READING_ZOOM,
        duration: 0,
      });
      pendingRetainedRef.current = null;
      handoffTimersRef.current = [];
      setSemanticBandOriginDepth(undefined);
      setSemanticLodEnabled(true);
    }, releaseDelay);
    handoffTimersRef.current = [releaseTimer];
  }, [instanceReady, layoutStatus, nodes]);

  useEffect(() => {
    if (fit === false || layoutStatus !== "ready" || fittedRef.current) {
      return;
    }
    const instance = instanceRef.current;
    if (instance === null) {
      return;
    }
    if (fitNodes.length === 0) {
      fittedRef.current = true;
      setSemanticLodEnabled(true);
      return;
    }
    fittedRef.current = true;
    const options = { ...DEFAULT_FIT, ...fit };
    if (semanticDepths.length > 1) {
      options.minZoom = Math.max(options.minZoom, SEMANTIC_READING_MIN_ZOOM);
    }
    const generation = ++fitGenerationRef.current;
    fitFrameRef.current = window.requestAnimationFrame(() => {
      fitFrameRef.current = null;
      void Promise.resolve(instance.fitView({ nodes: currentNodes, ...options })).then(() => {
        if (fitGenerationRef.current !== generation) {
          return;
        }
        setSemanticLodEnabled(true);
      });
    });
  }, [currentNodes, exitPending, fit, fitNodes, instanceReady, layoutStatus, semanticDepths.length]);

  useEffect(() => () => {
    clearHandoffTimers();
    if (fitFrameRef.current !== null) {
      window.cancelAnimationFrame(fitFrameRef.current);
    }
    fitGenerationRef.current += 1;
    instanceRef.current = null;
  }, [clearHandoffTimers]);

  const effectiveSemanticLodEnabled = semanticLodEnabled && layoutStatus === "ready";
  return {
    semanticDepths,
    currentNodes,
    instanceRef,
    onInit,
    onSemanticCommit,
    semanticBandOriginDepth,
    semanticLodEnabled: effectiveSemanticLodEnabled,
    semanticCommitEnabled:
      effectiveSemanticLodEnabled && semanticBandOriginDepth === undefined && !exitPending,
    exitPending,
  };
}

function semanticDepthOf(node: Node): number | undefined {
  const depth = (node.data as { semanticDepth?: unknown }).semanticDepth;
  return typeof depth === "number" && Number.isInteger(depth) && depth >= 0 ? depth : undefined;
}

function useShallowStableArray(values: readonly unknown[]): readonly unknown[] {
  const stable = useRef<readonly unknown[]>(values);
  if (
    stable.current.length !== values.length ||
    stable.current.some((value, index) => !Object.is(value, values[index]))
  ) {
    stable.current = [...values];
  }
  return stable.current;
}

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
