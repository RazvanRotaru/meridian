/**
 * The ONE base canvas every module-family surface mounts (unified-canvas phase A), extracted from
 * ModuleMapView so Map, Service, UI, and the minimal overlay share it by construction. It owns:
 *
 *   - the Map's card/edge component vocabulary (`moduleNodeTypes` + bundle/routed/ribbon/cycle/
 *     spool/wire edges);
 *   - the paint chain (`suppressRedundantImports` → `filterRelKinds` → `emphasize`, via
 *     `paintMinimalLevel` so the overlay's colour-parity unit tests pin exactly what runs here).
 *     Ordinary repaints preserve layout geometry; a ghost-inspection session additionally locks
 *     every already-presented card while its additive frontier grows;
 *   - the wire SALIENCE passes, canvas-wide by construction: dense levels FADE weight-1 strands
 *     (`fadeFaintWires` — the pills filter by kind, this by strength) and A⇄B mutual pairs FUSE
 *     into one double-headed tension wire (`fuseCycles` — typed, so every later pass leaves it
 *     alone);
 *   - the Visual Highways passes in precedence order (bundle → ribbon → route → spool), bundling/
 *     routing/spooling gated by the surface's `HighwayFlags`. The RIBBON fold always runs — even
 *     with Highways off — because overlapping same-pair strands are illegible in either mode; it
 *     PRECEDES routing so a multi-kind pair rides a frame's rail as ONE striped cable. Ghost cards
 *     were already banded OUTSIDE ELK by the layout (`placeGhostBands`); `emphasize` re-bands the
 *     lit ones selection-relative;
 *   - WIRES BEHIND CARDS on every surface: `zIndexMode="manual"` + the per-wire z the interaction
 *     hook assigns (cross-canvas under everything; intra-frame at its nesting depth);
 *   - wire hover naming (WireTooltip), plus the click-pinned EdgeInspectionDock with relationship
 *     metadata and contextual source highlighting, opt-in via `wireHover` on every active mount;
 *   - repeated semantic-zoom bands (`MapLod`, its legacy component name) — pure CSS visibility over
 *     pre-mounted, independently laid parent graphs on every SurfaceSpec that supplies them.
 *
 * LIFECYCLE-bound behaviors deliberately stay in each provider-owned MOUNT: the fit-once policy
 * (the source fits per level; the overlay per layout), the Toolbar recenter reaction (`useRecenter`
 * — the source remains subscribed but muted while covered), and the shared interaction hook
 * (`useModuleNodeInteractions` — its pending select must outlive canvas paint changes). A mount passes
 * `onInit` + its `interactions` and keeps its own guards. Floating chrome (breadcrumb, legends,
 * panels, the extract strip) rides in the `children` slot; flow-anchored extras (beacon arrows,
 * the ghost "+" ring) in `flowExtras`, which receives the PAINTED view.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ReactFlowProvider,
  useStore,
  useStoreApi,
  type Edge,
  type EdgeTypes,
  type Node,
  type OnMove,
  type OnMoveEnd,
  type OnMoveStart,
  type ReactFlowInstance,
} from "@xyflow/react";
import { useBlueprint, useBlueprintActions } from "../../state/StoreContext";
import { edgeEvidenceForPair } from "../../graph/edgeEvidence";
import { moduleNodeTypes } from "../nodes/modulemap/ModuleCardNode";
import { paintMinimalLevel } from "../paintMinimal";
import { filterGhostNodes } from "../moduleMapPaint";
import { WireTooltip } from "../WireTooltip";
import { EdgeInspectionDock } from "../EdgeInspectionDock";
import { MINIMAP_NODE_CAP } from "./flowCanvasProps";
import { ReadonlyGraphCanvas } from "./ReadonlyGraphCanvas";
import { MapLod } from "./MapLod";
import type { ModuleNodeHandlers } from "./useModuleNodeInteractions";
import { useWireHover } from "./useWireHover";
import type { HighwayFlags } from "./surfaceSpec";
import { BUNDLE_EDGE_TYPE } from "../../layout/edgeBundling";
import { BundledEdge } from "../edges/BundledEdge";
import { ROUTED_EDGE_TYPE } from "../../layout/edgeRouting";
import { RoutedEdge } from "../edges/RoutedEdge";
import { SPOOL_EDGE_TYPE } from "../../layout/edgeSpooling";
import { SpoolEdge } from "../edges/SpoolEdge";
import { RIBBON_EDGE_TYPE } from "../../layout/parallelWires";
import { RibbonEdge } from "../edges/RibbonEdge";
import { CYCLE_EDGE_TYPE } from "../../layout/cycleFusion";
import { CycleEdge } from "../edges/CycleEdge";
import { WireEdge, WIRE_EDGE_TYPE } from "../edges/WireEdge";
import { withReactFlowDimensions } from "./reactFlowDimensions";
import { useNodeDiffPreview } from "../review/useNodeDiffPreview";
import { GhostHierarchyEdge, GHOST_HIERARCHY_EDGE_TYPE } from "../edges/GhostHierarchyEdge";
import { prepareCanvasEdges } from "./presentationEdgePipeline";
import { GraphLayoutIndicator, type GraphLayoutIndicatorProps } from "./GraphLayoutIndicator";
import {
  appendClass,
  semanticLayerClass,
  SEMANTIC_LAYER_CLASS,
} from "../../derive/moduleSemanticComposite";
import {
  advanceSemanticFirstPreviewMaxInward,
  graphBounds,
  normalizedSemanticDepths,
  rebaseSemanticFirstPreviewMax,
  renderedNodesAtSemanticDepth,
  reachableSemanticFirstPreviewMax,
  SEMANTIC_FIRST_PREVIEW_MAX,
  semanticFirstPreviewMaxForViewport,
  semanticCommitDepthForZoomChange,
  type SemanticLodLayer,
} from "./mapLodGeometry";
import type { SurfaceEmphasisMode } from "../moduleMapHighlight";
import type { LensRelationPolicy } from "../../graph/lensRelationPolicy";
import { SurfaceInteractionScope } from "./SurfaceInteractionContext";
import { BaseNodeActionScope, type BaseNodeModel } from "../nodes/BaseNode";
import {
  createPaintFrameRetentionState,
  resolvePaintFrameRetention,
  type PaintedScene,
  type PaintFrameRetentionState,
} from "./paintFrameRetention";
import {
  deriveRequestGraphOverlay,
  projectRequestGraphOverlay,
} from "../../derive/requestGraphOverlay";
import { traceGraphRefMismatches } from "../../derive/requestTimelineModel";
import {
  decorateRequestEdges,
  decorateRequestNodes,
} from "../requestGraphPaint";
import {
  RequestGraphNodeBadges,
  RequestGraphOverlayPanel,
} from "../RequestGraphOverlayChrome";
import { ReviewCommentNodeIndicators } from "../review/ReviewCommentNodeIndicators";
import { REVIEW_NODE_VIEWED_CSS } from "../review/ReviewFileNodeViewedControls";

/** Custom edge types: "bundle" renders container-pair highways; "routed" rides a frame's gutter
 * rail (the bus) into member cards; "ribbon" is the striped multi-kind pair cable; "cycle" the
 * double-headed mutual-coupling wire; "spool" gathers the remaining open-canvas fan-hub wires;
 * "wire" is the plain curve every remaining edge retypes to on hover-enabled surfaces. One shared
 * map — a surface whose flags never mint a type simply has no
 * edges wearing it. */
const moduleEdgeTypes: EdgeTypes = {
  [BUNDLE_EDGE_TYPE]: BundledEdge,
  [ROUTED_EDGE_TYPE]: RoutedEdge,
  [RIBBON_EDGE_TYPE]: RibbonEdge,
  [CYCLE_EDGE_TYPE]: CycleEdge,
  [SPOOL_EDGE_TYPE]: SpoolEdge,
  [WIRE_EDGE_TYPE]: WireEdge,
  [GHOST_HIERARCHY_EDGE_TYPE]: GhostHierarchyEdge,
};

// React Flow gives a node wrapper `pointer-events: none` when it is neither selectable/draggable nor
// subscribed to mouse handlers. A read-only context with local chevrons needs pointer delivery to
// those nested buttons, while the wrapper click itself must remain inert.
const LOCAL_DISCLOSURE_NODE_CLICK = () => undefined;

/** Provider boundary for one isolated shared-canvas instance. Mounts import it from this module so
 * React Flow runtime ownership stays behind the same seam as GraphSurface itself. */
export { ReactFlowProvider as GraphSurfaceProvider };

/** The painted view handed to `flowExtras`: emphasis-styled nodes + the selected-step beacons. */
export interface SurfaceFlowView {
  nodes: Node[];
  beacons: ReadonlySet<string>;
}

export interface SurfacePaintOwnership {
  /** Literal store selection: it owns rings/extraction and must survive ghost pruning. */
  protectedSelection: ReadonlySet<string>;
  /** Semantic ids that own emphasis traversal for this paint. */
  paintSeeds: ReadonlySet<string>;
  /** Literal selection repainted over a retained ghost frontier for direct-node adjacency. */
  focusSeeds: ReadonlySet<string> | null;
  /** Literal selection handed to highway extraction; provenance must not unbundle unrelated wires. */
  highwaySeeds: ReadonlySet<string>;
}

/** Highway extraction follows every literal selection even while another surface owner paints the
 * graph (notably a PR checklist hover). Reuse the paint set when it already covers selection so the
 * common path retains stable references and avoids an otherwise needless presentation rebuild. */
function mergeHighwaySeeds(
  selected: ReadonlySet<string>,
  paintSeeds: ReadonlySet<string>,
): ReadonlySet<string> {
  if (selected.size === 0 || selected === paintSeeds) {
    return paintSeeds;
  }
  const merged = new Set(paintSeeds);
  selected.forEach((id) => merged.add(id));
  return merged.size === paintSeeds.size ? paintSeeds : merged;
}

/** Resolve the deliberately distinct paint identities used by every GraphSurface mount.
 * A surface-owned override (the frozen codebase context) is authoritative. Otherwise a PR row
 * hover/click outranks stale ghost provenance, which resumes when review paint clears. Literal
 * selection is always protected independently and owns local focus/highway extraction without
 * replacing provenance, so clicking a ghost keeps the frontier while drawing only its strands. */
export function resolveSurfacePaintOwnership(
  selected: ReadonlySet<string>,
  reviewLit: ReadonlySet<string> | null,
  reviewEmphasis: boolean,
  ghostPaintOverride: ReadonlySet<string> | null,
  surfacePaintOverride: ReadonlySet<string> | null = null,
): SurfacePaintOwnership {
  if (surfacePaintOverride !== null) {
    return {
      protectedSelection: selected,
      paintSeeds: surfacePaintOverride,
      focusSeeds: null,
      highwaySeeds: mergeHighwaySeeds(selected, surfacePaintOverride),
    };
  }
  const reviewOwnsPaint = reviewEmphasis && reviewLit !== null;
  const paintSeeds = reviewOwnsPaint
    ? reviewLit
    : ghostPaintOverride ?? selected;
  const focusSeeds = !reviewOwnsPaint && ghostPaintOverride !== null
    ? selected
    : null;
  // Ghost provenance must not unbundle every owner strand, while PR paint must keep both the
  // hovered/clicked review subject and the literal canvas selection directly traceable.
  const highwaySeeds = !reviewOwnsPaint && ghostPaintOverride !== null
    ? selected
    : mergeHighwaySeeds(selected, paintSeeds);
  return { protectedSelection: selected, paintSeeds, focusSeeds, highwaySeeds };
}

export interface GraphSurfaceProps {
  /** Laid-out (and per-surface visibility-filtered) nodes/edges. Only an opted-in additive
   * inspection session can replace candidate positions with geometry already shown to the reader. */
  nodes: Node[];
  edges: Edge[];
  /** Which Highways passes this surface's shape supports (from its SurfaceSpec). */
  highways: HighwayFlags;
  /** Lens-owned semantic relation story consumed by shared paint, layout, and highway machinery. */
  relations: LensRelationPolicy;
  miniMapColor: (node: Node) => string;
  /** The mount's `useModuleNodeInteractions(...)` handlers — called in the MOUNT, not here, so the
   * click-debounce lifetime tracks the lens rather than this (overlay-swappable) canvas. */
  interactions: ModuleNodeHandlers;
  /** The mount keeps the fit-once guard and instance ref, so the init callback threads out to it. */
  onInit?: (instance: ReactFlowInstance<Node, Edge>) => void;
  /** Override React Flow's mount-time fit when the mount manages its own detail-only viewport. */
  autoFitView?: boolean;
  /** Wire chrome — hover naming, click-pinned inspector/source evidence, and static labels. */
  wireHover?: boolean;
  /** PR review only: show a scrollable code preview from the reader's chosen node gesture. */
  nodeDiffPreview?: boolean;
  /** Every shared-canvas mount declares its semantic scene explicitly. Empty means this particular
   * scene is already at its root; omission is forbidden so a new mount cannot silently lose zoom
   * navigation while still appearing to share GraphSurface. */
  semanticLayers: readonly SemanticLodLayer[];
  /** Absolute depths from the unfiltered canonical scene. */
  semanticDepths: readonly number[];
  /** Previous root depth held until the post-commit camera reset reaches normal reading zoom. */
  semanticBandOriginDepth: number | undefined;
  /** False while the mount establishes a programmatic reading viewport. */
  semanticLodEnabled: boolean;
  /** False while the semantic parent handoff owns the camera animation. */
  semanticCommitEnabled: boolean;
  /** Commit one parent when a user-driven outward move crosses its threshold. */
  onSemanticCommit: (layer: SemanticLodLayer) => void;
  /** PR review overlay only: let its checklist/flow rows temporarily override graph selection. */
  reviewEmphasis?: boolean;
  /** Optional surface-specific emphasis semantics. PR flow review uses the selected-flow subgraph
   * at rest, then node mode so one selected target reveals its incident on-demand ghost cards. */
  emphasisMode?: SurfaceEmphasisMode;
  /** Optional override for exact-detail surfaces. A selected PR-flow node disables sibling ghost
   * grouping so every incident ghost and edge remains individually reviewable. */
  groupGhosts?: boolean;
  /** Paint-only ghost visibility for a mount-local declutter control. Layout geometry is retained. */
  showGhostNodes?: boolean;
  /** Extras that must render INSIDE the flow (beacon arrows, the overlay's ghost "+" ring). */
  flowExtras?: (view: SurfaceFlowView) => ReactNode;
  /** Floating chrome (breadcrumb, legends, panels, action strips), absolutely positioned over the canvas. */
  children?: ReactNode;
  /** Mount the shared request controller only on the surface that owns top-right chrome. Covered
   * source and minimal-context surfaces still receive request node/edge paint without duplicating
   * controls underneath their own panels. */
  requestOverlayChrome?: boolean;
  /** Retain the last committed graph underneath a blocking status overlay while its replacement is derived. */
  busy?: GraphLayoutIndicatorProps;
  /** Frozen overview mode: pan/zoom and source inspection remain, graph selection/navigation do not. */
  readOnly?: boolean;
  /** Surface-local highlight set which does not mutate the Map/minimal graph's real selection. */
  selectionOverride?: ReadonlySet<string>;
  /** Separate paint owners when node rings and relationship emphasis intentionally differ. */
  paintSelectionOverride?: ReadonlySet<string>;
  /** Presentation-local containment disclosure. This remains available on a read-only surface
   * without re-enabling selection/navigation or mutating the shared module expansion state. */
  onToggleExpand?: (nodeId: string) => void;
  /** Non-null while an additive exploration path owns the scene. Existing painted positions are
   * retained for one key; changing/clearing the key starts or ends that presentation session. */
  positionRetentionKey?: string | null;
  /** True only after the source layout has published a settled graph. A laying-out or failed
   * candidate must stay behind the admission barrier instead of contaminating position history. */
  positionAdmissionReady?: boolean;
}

export function GraphSurface(props: GraphSurfaceProps) {
  const storeSelected = useBlueprint((state) => state.moduleSelected);
  const selected = props.selectionOverride ?? storeSelected;
  const reviewLit = useBlueprint((state) => state.reviewLitNodeIds);
  const reviewCodePreviewTrigger = useBlueprint((state) => state.reviewCodePreviewTrigger);
  const index = useBlueprint((state) => state.index);
  const artifact = useBlueprint((state) => state.artifact);
  const telemetryMode = useBlueprint((state) => state.telemetryMode);
  const requestTraces = useBlueprint((state) => state.requestTraces);
  const selectedTraceId = useBlueprint((state) => state.selectedTraceId);
  const traceGraphRef = useBlueprint((state) => state.traceGraphRef);
  const serviceGroupingMode = useBlueprint((state) => state.serviceGroupingMode);
  const serviceGroupingTargetSize = useBlueprint((state) => state.serviceGroupingTargetSize);
  const radius = useBlueprint((state) => state.moduleRadius);
  const highlightMode = useBlueprint((state) => state.highlightMode);
  const relationVisibilityOverrides = useBlueprint((state) => state.relationVisibilityOverrides);
  const showHighways = useBlueprint((state) => state.showHighways);
  const groupGhostsByParent = useBlueprint((state) => state.groupGhostsByParent);
  const edgeEvidenceOpen = useBlueprint((state) => state.codeView?.edgeEvidence !== undefined);
  const { showEdgeEvidence, closeEdgeEvidence, toggleModuleExpand } = useBlueprintActions();
  const emphasisMode = props.emphasisMode ?? highlightMode;
  const groupGhosts = props.groupGhosts ?? groupGhostsByParent;
  const activeTrace = useMemo(
    () => !telemetryMode || selectedTraceId === null
      ? null
      : requestTraces.find((trace) => trace.traceId === selectedTraceId) ?? null,
    [telemetryMode, requestTraces, selectedTraceId],
  );
  const requestGraphMismatches = useMemo(
    () => activeTrace === null ? [] : traceGraphRefMismatches(traceGraphRef, artifact),
    [activeTrace, traceGraphRef, artifact],
  );
  // A graph mismatch keeps the request inspectable in Logic but disables all paint here. Exact
  // derivation stays independent of the visible lens; projection below rolls it into that lens's
  // currently mounted semantic populations without copying evidence into store state.
  const requestGraphOverlay = useMemo(
    () => activeTrace !== null && requestGraphMismatches.length === 0
      ? deriveRequestGraphOverlay(activeTrace, index)
      : null,
    [activeTrace, index, requestGraphMismatches],
  );
  // Keep the semantic controller mounted through the final parent handoff too: its ancestor list can
  // already be empty while the retained root population is still fading in and resetting camera.
  const hasSemanticComposite =
    props.semanticLayers.length > 0 || props.semanticBandOriginDepth !== undefined;
  const semanticCommitEnabled = props.semanticCommitEnabled;
  const semanticDepths = useMemo(
    () => normalizedSemanticDepths(props.semanticDepths),
    [props.semanticDepths],
  );
  const previousUserZoom = useRef<number | null>(null);
  const previousCameraZoom = useRef<number | null>(null);
  const programmaticUserZoomArmed = useRef(false);
  // Local wire state and global source state still need one owner boundary. This ref distinguishes
  // a source-backed inspection (whose source disappearing ends the whole dock) from an intentional
  // metadata-only wire, which remains useful without a source pane.
  const inspectionOwnsSource = useRef(false);

  // The ONE paint chain, isolated per semantic population. Main's ghost grouping can mint parent
  // cards and hierarchy spokes at paint time; stamping those outputs back onto their source depth
  // keeps them in the same cross-fade instead of leaking across hidden ancestor graphs.
  const paintOwnership = useMemo(
    () => resolveSurfacePaintOwnership(
      selected,
      reviewLit,
      props.reviewEmphasis === true,
      props.interactions.paintSelectionOverride,
      props.paintSelectionOverride ?? null,
    ),
    [selected, reviewLit, props.reviewEmphasis, props.interactions.paintSelectionOverride, props.paintSelectionOverride],
  );
  const candidatePaintedScene = useMemo<PaintedScene>(
    () => {
      // Filter before emphasis/grouping so hidden exact ghosts cannot be reminted as synthetic parent
      // anchors, and semantic ancestor populations obey the same mount-local visibility choice.
      const ghostFiltered = filterGhostNodes(props.nodes, props.edges, props.showGhostNodes ?? true);
      const painted = paintSemanticLayers(ghostFiltered.nodes, ghostFiltered.edges, paintOwnership.protectedSelection, radius, emphasisMode, {
        policy: props.relations,
        overrides: relationVisibilityOverrides,
      }, {
        index,
        groupByParent: groupGhosts,
        expandedGroupIds: props.interactions.expandedGhostGroupIds,
      }, paintOwnership.paintSeeds, paintOwnership.focusSeeds);
      return { ...painted, highwaySeeds: paintOwnership.highwaySeeds };
    },
    [props.nodes, props.edges, props.showGhostNodes, paintOwnership, radius, emphasisMode, props.relations, relationVisibilityOverrides, index, groupGhosts, props.interactions.expandedGhostGroupIds],
  );
  // Inspection is an append-only read of the graph. Its intentional pre-layout busy paint still
  // carries the old raw graph with the new selection; keep that provisional population out of both
  // React Flow and the position ledger, then admit the final nodes/wires/paint metadata atomically.
  const {
    nodes: retainedPaintedNodes,
    edges: paintedEdges,
    beacons,
    highwaySeeds,
  } = useRetainedPaintedScene(
    candidatePaintedScene,
    props.positionRetentionKey ?? null,
    props.positionAdmissionReady ?? (props.busy === undefined),
  );
  // The shared BaseNode action scope routes grouped ghosts through the mount-local interaction
  // adapter, so paint data remains serializable and no callback is injected into derived nodes.
  const displayedNodes = retainedPaintedNodes;
  const projectedRequestNodes = useMemo(
    () => requestGraphOverlay === null
      ? null
      : projectRequestGraphOverlay(requestGraphOverlay, displayedNodes, index, {
          serviceGroupingMode,
          serviceGroupingTargetSize,
        }),
    [requestGraphOverlay, displayedNodes, index, serviceGroupingMode, serviceGroupingTargetSize],
  );
  const requestPaintOverlay = useMemo(
    () => requestGraphOverlay === null || projectedRequestNodes === null
      ? null
      : {
          traceId: requestGraphOverlay.traceId,
          nodesById: projectedRequestNodes,
          observedEdgesById: requestGraphOverlay.edgesById,
        },
    [requestGraphOverlay, projectedRequestNodes],
  );
  const requestPaintedNodes = useMemo(
    () => requestPaintOverlay === null
      ? displayedNodes
      : decorateRequestNodes(displayedNodes, requestPaintOverlay, selected),
    [displayedNodes, requestPaintOverlay, selected],
  );
  // The module-family layouts keep their canonical geometry in `style.width/height`, which all
  // routing and overlay passes below intentionally continue to read. React Flow's MiniMap checks
  // only top-level dimensions on the controlled user node, so expose the same numbers at the final
  // library boundary after the paint-only inspection decoration.
  const reactFlowNodes = useMemo(() => withReactFlowDimensions(requestPaintedNodes), [requestPaintedNodes]);
  const viewportWidth = useStore((state) => state.width);
  const viewportHeight = useStore((state) => state.height);
  const flowStore = useStoreApi<Node, Edge>();
  const occupancyNodes = useMemo(() => {
    const currentDepth = semanticDepths[0];
    return renderedNodesAtSemanticDepth(reactFlowNodes, currentDepth);
  }, [reactFlowNodes, semanticDepths]);
  const occupancyBounds = useMemo(
    () => graphBounds(reactFlowNodes, occupancyNodes),
    [occupancyNodes, reactFlowNodes],
  );
  const occupancyFirstPreviewMax = useMemo(
    () => semanticFirstPreviewMaxForViewport(occupancyBounds, viewportWidth, viewportHeight),
    [occupancyBounds, viewportHeight, viewportWidth],
  );
  const occupancyFirstPreviewMaxRef = useRef(occupancyFirstPreviewMax);
  occupancyFirstPreviewMaxRef.current = occupancyFirstPreviewMax;
  const semanticFirstPreviewMaxRef = useRef(SEMANTIC_FIRST_PREVIEW_MAX);
  const [semanticFirstPreviewMax, setSemanticFirstPreviewMax] = useState(SEMANTIC_FIRST_PREVIEW_MAX);
  const publishSemanticFirstPreviewMax = useCallback((next: number) => {
    semanticFirstPreviewMaxRef.current = next;
    setSemanticFirstPreviewMax((current) => current === next ? current : next);
  }, []);
  const previousSemanticLifecycle = useRef({
    commitEnabled: false,
    lodEnabled: false,
    originDepth: undefined as number | undefined,
  });
  useLayoutEffect(() => {
    const previous = previousSemanticLifecycle.current;
    const enteredReadingLifecycle = props.semanticLodEnabled && (
      !previous.lodEnabled ||
      (!previous.commitEnabled && semanticCommitEnabled) ||
      (previous.originDepth !== undefined && props.semanticBandOriginDepth === undefined)
    );
    previousSemanticLifecycle.current = {
      commitEnabled: semanticCommitEnabled,
      lodEnabled: props.semanticLodEnabled,
      originDepth: props.semanticBandOriginDepth,
    };
    if (
      !props.semanticLodEnabled ||
      !semanticCommitEnabled ||
      props.semanticBandOriginDepth !== undefined
    ) {
      return;
    }
    const zoom = flowStore.getState().transform[2];
    const next = enteredReadingLifecycle
      ? reachableSemanticFirstPreviewMax(occupancyFirstPreviewMax, zoom)
      : rebaseSemanticFirstPreviewMax(
          semanticFirstPreviewMaxRef.current,
          occupancyFirstPreviewMax,
          zoom,
          semanticDepths,
        );
    publishSemanticFirstPreviewMax(next);
  }, [
    flowStore,
    occupancyFirstPreviewMax,
    props.semanticBandOriginDepth,
    props.semanticLodEnabled,
    publishSemanticFirstPreviewMax,
    semanticCommitEnabled,
    semanticDepths,
  ]);

  const onMoveStart = useCallback<OnMoveStart>((event, viewport) => {
    previousCameraZoom.current = viewport.zoom;
    if (!semanticCommitEnabled) {
      previousUserZoom.current = null;
      return;
    }
    // React Flow passes null for fitView/setCenter. Those camera moves must never become semantic
    // navigation. Explicit zoom controls are the exception, armed by capture on their user event.
    if (event != null || programmaticUserZoomArmed.current) {
      previousUserZoom.current = viewport.zoom;
    }
  }, [semanticCommitEnabled]);
  const onMove = useCallback<OnMove>((event, viewport) => {
    const previousCamera = previousCameraZoom.current;
    previousCameraZoom.current = viewport.zoom;
    if (!semanticCommitEnabled) {
      previousUserZoom.current = null;
      return;
    }
    if (event == null && !programmaticUserZoomArmed.current) {
      // Recenter/fitView camera changes are not navigation, but they must not leave a tiny graph's
      // reading clamp stranded at an older zoom or move an already-previewing camera into a parent
      // band. Re-establish reading at the new zoom while preserving the user's preceding wheel
      // sample; a handoff's same-zoom setCenter therefore remains inert.
      if (previousCamera !== null && viewport.zoom !== previousCamera) {
        publishSemanticFirstPreviewMax(
          reachableSemanticFirstPreviewMax(occupancyFirstPreviewMaxRef.current, viewport.zoom),
        );
      }
      return;
    }
    const previousZoom = previousUserZoom.current;
    // Advance the sample before the synchronous owner callback filters the mounted graph. If that
    // causes an immediate rerender, another move sample starts from the camera position just seen.
    previousUserZoom.current = viewport.zoom;
    if (previousZoom === null) {
      return;
    }
    if (viewport.zoom === previousZoom) {
      return;
    }
    if (viewport.zoom > previousZoom) {
      const next = advanceSemanticFirstPreviewMaxInward(
        semanticFirstPreviewMaxRef.current,
        occupancyFirstPreviewMaxRef.current,
        viewport.zoom,
        semanticDepths,
        props.semanticBandOriginDepth,
      );
      publishSemanticFirstPreviewMax(next);
      return;
    }
    const targetDepth = semanticCommitDepthForZoomChange(
      previousZoom,
      viewport.zoom,
      semanticDepths,
      props.semanticBandOriginDepth,
      semanticFirstPreviewMaxRef.current,
    );
    const target = props.semanticLayers.find((layer) => layer.depth === targetDepth);
    if (target !== undefined) {
      props.onSemanticCommit(target);
    }
  }, [
    props.onSemanticCommit,
    props.semanticLayers,
    props.semanticBandOriginDepth,
    publishSemanticFirstPreviewMax,
    semanticCommitEnabled,
    semanticDepths,
  ]);
  const onMoveEnd = useCallback<OnMoveEnd>((event) => {
    previousCameraZoom.current = null;
    if (event != null || programmaticUserZoomArmed.current) {
      previousUserZoom.current = null;
      programmaticUserZoomArmed.current = false;
    }
  }, []);
  useEffect(() => {
    if (!semanticCommitEnabled) {
      previousUserZoom.current = null;
      previousCameraZoom.current = null;
      programmaticUserZoomArmed.current = false;
    }
  }, [semanticCommitEnabled]);

  const virtualizeCanvas = shouldVirtualizeCanvasNodes(reactFlowNodes.length);
  // Every semantic depth is an independent paint population. Process it through main's shared
  // presentation pipeline separately so hidden ancestors cannot affect salience/highways, while
  // parent→member hierarchy spokes remain outside semantic transforms and interaction dressing.
  const preparedEdges = useMemo(() => {
    const layers = new Map<number | undefined, Edge[]>();
    for (const edge of paintedEdges) {
      const depth = semanticDepthOf(edge);
      const peers = layers.get(depth);
      if (peers) {
        peers.push(edge);
      } else {
        layers.set(depth, [edge]);
      }
    }
    const semanticEdges: Edge[] = [];
    const hierarchyEdges: Edge[] = [];
    for (const [depth, edges] of layers) {
      const prepared = prepareCanvasEdges(
        edges,
        retainedPaintedNodes,
        highwaySeeds,
        showHighways,
        props.highways,
        props.relations,
      );
      semanticEdges.push(...prepared.semanticEdges.map((edge) =>
        depth === undefined ? edge : withSemanticDepth(edge, depth),
      ));
      hierarchyEdges.push(...prepared.hierarchyEdges);
    }
    return { semanticEdges, hierarchyEdges };
  }, [paintedEdges, retainedPaintedNodes, props.highways, props.relations, highwaySeeds, showHighways]);
  const requestPaintedEdges = useMemo(
    () => requestPaintOverlay === null
      ? preparedEdges.semanticEdges
      : decorateRequestEdges(preparedEdges.semanticEdges, requestPaintOverlay, selected),
    [preparedEdges.semanticEdges, requestPaintOverlay, selected],
  );
  const openWireEvidence = useCallback((pair: Edge[]) => {
    const contexts = edgeEvidenceForPair(pair, index.edgesById);
    inspectionOwnsSource.current = contexts.length > 0;
    // The action also clears prior source when the new wire has no attributable site, while the
    // inspector itself remains useful as relationship metadata.
    void showEdgeEvidence(contexts);
  }, [index.edgesById, showEdgeEvidence]);
  const wire = useWireHover(
    requestPaintedEdges,
    requestPaintedNodes,
    props.wireHover === true,
    openWireEvidence,
    closeEdgeEvidence,
  );
  useEffect(() => {
    if (edgeEvidenceOpen || !inspectionOwnsSource.current) return;
    // Another source gesture/state reset replaced a source-backed edge inspection. End its local
    // pin too; the guarded close callback cannot disturb the replacement node/PR source view.
    inspectionOwnsSource.current = false;
    wire.clearInspected();
  }, [edgeEvidenceOpen, wire.clearInspected]);
  // Append hierarchy spokes AFTER interaction dressing too: their exact objects never acquire a
  // pulse, label, hit width, tooltip, inspector subject, or semantic z-order.
  const renderedEdges = useMemo(
    () => [...wire.edges, ...preparedEdges.hierarchyEdges],
    [wire.edges, preparedEdges.hierarchyEdges],
  );
  const nodeDiffEnabled = props.nodeDiffPreview === true;
  const nodeDiff = useNodeDiffPreview(nodeDiffEnabled, reviewCodePreviewTrigger);
  const surfaceNodeClick = props.readOnly
    ? (props.onToggleExpand === undefined ? undefined : LOCAL_DISCLOSURE_NODE_CLICK)
    : props.interactions.onNodeClick;
  const baseToggleExpand = useCallback((model: BaseNodeModel) => {
    const ghostGroupId = model.nodeType === "ghost" && typeof model.data.ghostGroupId === "string"
      ? model.data.ghostGroupId
      : null;
    if (ghostGroupId !== null) {
      props.interactions.toggleGhostGroup(ghostGroupId);
      return;
    }
    const action = props.onToggleExpand ?? (props.readOnly ? null : toggleModuleExpand);
    action?.(model.instanceId);
  }, [props.interactions.toggleGhostGroup, props.onToggleExpand, props.readOnly, toggleModuleExpand]);
  const baseCanExpand = props.onToggleExpand !== undefined || !props.readOnly;

  return (
    <BaseNodeActionScope
      toggleExpand={baseCanExpand ? baseToggleExpand : null}
      navigateInto={props.readOnly ? null : props.interactions.navigateBaseNode ?? null}
    >
    <SurfaceInteractionScope
      readOnly={props.readOnly === true}
      selectionOverride={props.selectionOverride ?? null}
      reviewProgressEnabled={nodeDiffEnabled}
    >
    <div
      style={SURFACE_STYLE}
      aria-busy={props.busy ? "true" : undefined}
      onClickCapture={(event) => {
        const target = event.target;
        if (
          target instanceof Element &&
          target.closest(".react-flow__controls-zoomin, .react-flow__controls-zoomout") !== null
        ) {
          // Controls uses the viewport API, whose move event is null just like fitView. Arm it before
          // the button's target handler runs so explicit user zoom follows semantic navigation.
          programmaticUserZoomArmed.current = true;
        }
      }}
      onWheelCapture={(event) => {
        const target = event.target;
        if (target instanceof Element && target.closest(".react-flow__minimap") !== null) {
          // MiniMap wheel zoom also drives the main viewport through the API. The direction check in
          // semanticCommitDepthForZoomChange keeps inward movement inert after this user-only arm.
          programmaticUserZoomArmed.current = true;
        }
      }}
    >
      {/* A semantic composite contains hidden ancestor graphs at reading zoom. The mount performs a
          depth-zero fit after layout; React Flow's whole-stack fit would pull the camera outward. */}
      <ReadonlyGraphCanvas<Node, Edge>
        className={hasSemanticComposite ? "semantic-composite" : undefined}
        nodes={reactFlowNodes}
        edges={renderedEdges}
        nodeTypes={moduleNodeTypes}
        edgeTypes={moduleEdgeTypes}
        onInit={props.onInit}
        onNodeClick={nodeDiffEnabled
          ? (event, node) => {
              nodeDiff.onNodeClick(event, node);
              surfaceNodeClick?.(event, node);
            }
          : surfaceNodeClick}
        onNodeDoubleClick={props.readOnly ? undefined : props.interactions.onNodeDoubleClick}
        onNodeMouseEnter={nodeDiffEnabled ? nodeDiff.onNodeMouseEnter : undefined}
        onNodeMouseMove={nodeDiffEnabled ? nodeDiff.onNodeMouseMove : undefined}
        onNodeMouseLeave={nodeDiffEnabled ? nodeDiff.onNodeMouseLeave : undefined}
        onPaneMouseMove={nodeDiffEnabled ? nodeDiff.onPaneMouseMove : undefined}
        onPaneClick={() => {
          if (nodeDiffEnabled) {
            nodeDiff.onPaneClick();
          }
          // A pane click always unpins the inspector. Frozen context views keep their fixed target set.
          wire.clearInspected();
          if (!props.readOnly) {
            props.interactions.onPaneClick();
          }
        }}
        onEdgeMouseEnter={wire.onEdgeMouseEnter}
        onEdgeMouseLeave={wire.onEdgeMouseLeave}
        onEdgeClick={wire.onEdgeClick}
        // Keep the rendered canvas in 1:1 parity with the MiniMap while that navigation aid is
        // present. Once the graph is too dense for a useful MiniMap, mount only visible cards so a
        // fully disclosed high-degree ghost neighbourhood can still contain hundreds of nodes.
        onlyRenderVisibleElements={virtualizeCanvas}
        onMoveStart={onMoveStart}
        onMove={onMove}
        onMoveEnd={onMoveEnd}
        // Manual z: basic mode ADDS a nested endpoint's node-z to the edge — see useWireHover's z rule.
        zIndexMode="manual"
        elementsSelectable={!props.readOnly}
        nodesFocusable={!props.readOnly}
        edgesFocusable={!props.readOnly}
        fitView={props.autoFitView ?? !hasSemanticComposite}
        miniMapColor={props.miniMapColor}
        minimap={!virtualizeCanvas}
      >
        <style>{REVIEW_NODE_VIEWED_CSS}</style>
        <MapLod
          nodes={reactFlowNodes}
          semanticLayers={props.semanticLayers}
          semanticDepths={semanticDepths}
          semanticBandOriginDepth={props.semanticBandOriginDepth}
          semanticFirstPreviewMax={semanticFirstPreviewMax}
          semanticLodEnabled={props.semanticLodEnabled}
        />
        {nodeDiffEnabled ? <ReviewCommentNodeIndicators visibleNodes={requestPaintedNodes} /> : null}
        {projectedRequestNodes === null ? null : (
          <RequestGraphNodeBadges visibleNodes={requestPaintedNodes} evidenceByNodeId={projectedRequestNodes} />
        )}
        {!telemetryMode || props.requestOverlayChrome === false ? null : (
          <RequestGraphOverlayPanel
            graphMismatches={requestGraphMismatches}
            observedNodeCount={requestGraphOverlay?.nodesById.size ?? 0}
          />
        )}
        {props.flowExtras?.({ nodes: requestPaintedNodes, beacons })}
      </ReadonlyGraphCanvas>
      {wire.hover ? <WireTooltip hover={wire.hover} /> : null}
      {wire.inspectedPair ? (
        <EdgeInspectionDock pair={wire.inspectedPair} labelOf={wire.labelOf} onClose={wire.clearInspected} onDrill={wire.inspect} />
      ) : null}
      {nodeDiff.layer}
      {props.children}
      {props.busy ? <GraphLayoutIndicator {...props.busy} /> : null}
    </div>
    </SurfaceInteractionScope>
    </BaseNodeActionScope>
  );
}

/** Commit presentation geometry only after React commits it. This keeps render pure while still
 * letting the first inspection render seed from the exact scene visible immediately before click. */
function useRetainedPaintedScene(
  candidate: PaintedScene,
  sessionKey: string | null,
  ready: boolean,
): PaintedScene {
  const state = useRef<PaintFrameRetentionState>(
    createPaintFrameRetentionState(ready ? candidate : null),
  );
  const retained = useMemo(
    () => resolvePaintFrameRetention(candidate, state.current, sessionKey, !ready),
    [candidate, sessionKey, ready],
  );

  useLayoutEffect(() => {
    state.current = retained.state;
  }, [retained.state]);

  return retained.scene;
}

/** Run paint-time transforms independently for each mounted graph. Besides preventing selection
 * salience from crossing levels, this assigns main's dynamically-created ghost groups/spokes to
 * the same semantic layer as the exact ghosts they replaced. */
function paintSemanticLayers(
  nodes: Parameters<typeof paintMinimalLevel>[0],
  edges: Parameters<typeof paintMinimalLevel>[1],
  selected: Parameters<typeof paintMinimalLevel>[2],
  radius: Parameters<typeof paintMinimalLevel>[3],
  mode: Parameters<typeof paintMinimalLevel>[4],
  relations: Parameters<typeof paintMinimalLevel>[5],
  ghostPresentation: Parameters<typeof paintMinimalLevel>[6],
  paintSeedIds: Parameters<typeof paintMinimalLevel>[7],
  focusSeedIds: Parameters<typeof paintMinimalLevel>[8],
): ReturnType<typeof paintMinimalLevel> {
  const nodesByDepth = new Map<number | undefined, Node[]>();
  const edgesByDepth = new Map<number | undefined, Edge[]>();
  const depths = new Set<number | undefined>();
  for (const node of nodes) {
    const depth = semanticDepthOf(node);
    depths.add(depth);
    const peers = nodesByDepth.get(depth);
    if (peers) peers.push(node);
    else nodesByDepth.set(depth, [node]);
  }
  for (const edge of edges) {
    const depth = semanticDepthOf(edge);
    depths.add(depth);
    const peers = edgesByDepth.get(depth);
    if (peers) peers.push(edge);
    else edgesByDepth.set(depth, [edge]);
  }

  const paintedNodes: Node[] = [];
  const paintedEdges: Edge[] = [];
  const beacons = new Set<string>();
  for (const depth of depths) {
    const painted = paintMinimalLevel(
      nodesByDepth.get(depth) ?? [],
      edgesByDepth.get(depth) ?? [],
      selected,
      radius,
      mode,
      relations,
      ghostPresentation,
      paintSeedIds,
      focusSeedIds,
    );
    paintedNodes.push(...(depth === undefined
      ? painted.nodes
      : painted.nodes.map((node) => withSemanticDepth(node, depth))));
    paintedEdges.push(...(depth === undefined
      ? painted.edges
      : painted.edges.map((edge) => withSemanticDepth(edge, depth))));
    painted.beacons.forEach((id) => beacons.add(id));
  }
  return { nodes: paintedNodes, edges: paintedEdges, beacons };
}

function semanticDepthOf(entry: Node | Edge): number | undefined {
  const depth = (entry.data as { semanticDepth?: unknown } | undefined)?.semanticDepth;
  return typeof depth === "number" && Number.isInteger(depth) && depth >= 0 ? depth : undefined;
}

function withSemanticDepth<T extends Node | Edge>(entry: T, depth: number): T {
  return {
    ...entry,
    data: { ...(entry.data ?? {}), semanticDepth: depth },
    className: appendClass(appendClass(entry.className, SEMANTIC_LAYER_CLASS), semanticLayerClass(depth)),
  } as T;
}

/** MiniMap and viewport virtualization switch at the same boundary: below it every canonical
 * node has both a canvas card and a MiniMap mark; above it both expensive representations go. */
export function shouldVirtualizeCanvasNodes(nodeCount: number): boolean {
  return nodeCount > MINIMAP_NODE_CAP;
}

/** The shared canvas root — exported so a mount's own replacement branches (the overlay split)
 * keep the identical backdrop. */
export const SURFACE_STYLE: React.CSSProperties = { position: "absolute", inset: 0, background: "#0E1116" };
