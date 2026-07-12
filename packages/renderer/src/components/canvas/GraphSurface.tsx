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

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, type ReactNode } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
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
import { WireTooltip } from "../WireTooltip";
import { EdgeInspectionDock } from "../EdgeInspectionDock";
import { CanvasChrome, MINIMAP_NODE_CAP, READONLY_CANVAS_PROPS } from "./flowCanvasProps";
import { MapLod } from "./MapLod";
import { ghostGroupInteractionOf, type ModuleNodeHandlers } from "./useModuleNodeInteractions";
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
  normalizedSemanticDepths,
  semanticCommitDepthForZoomChange,
  type SemanticLodLayer,
} from "./mapLodGeometry";
import type { SurfaceEmphasisMode } from "../moduleMapHighlight";
import type { LensRelationPolicy } from "../../graph/lensRelationPolicy";
import { SurfaceInteractionScope } from "./SurfaceInteractionContext";
import {
  createPaintFrameRetentionState,
  resolvePaintFrameRetention,
  type PaintedScene,
  type PaintFrameRetentionState,
} from "./paintFrameRetention";

/** Custom edge types: "bundle" renders container-pair highways; "routed" rides a frame's gutter
 * rail (the bus) into member cards; "ribbon" is the striped multi-kind pair cable; "cycle" the
 * double-headed mutual-coupling wire; "spool" gathers the remaining open-canvas fan-hub wires;
 * "wire" is the plain curve every remaining edge retypes to on hover-enabled surfaces (it carries
 * the lit direction pulse). One shared map — a surface whose flags never mint a type simply has no
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
      highwaySeeds: surfacePaintOverride,
    };
  }
  const reviewOwnsPaint = reviewEmphasis && reviewLit !== null;
  const paintSeeds = reviewOwnsPaint
    ? reviewLit
    : ghostPaintOverride ?? selected;
  const focusSeeds = !reviewOwnsPaint && ghostPaintOverride !== null
    ? selected
    : null;
  const highwaySeeds = !reviewOwnsPaint && ghostPaintOverride !== null
    ? selected
    : paintSeeds;
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
  /** Wire chrome — hover naming, click-pinned inspector/source evidence, and direction pulses. */
  wireHover?: boolean;
  /** PR review only: show a scrollable source diff after dwelling over a directly changed node. */
  nodeDiffPreview?: boolean;
  /** Every shared-canvas mount declares its semantic scene explicitly. Empty means this particular
   * scene is already at its root; omission is forbidden so a new mount cannot silently lose zoom
   * navigation while still appearing to share GraphSurface. */
  semanticLayers: readonly SemanticLodLayer[];
  /** Absolute depths from the unfiltered canonical scene. */
  semanticDepths: readonly number[];
  /** Previous root depth held until the post-commit camera reset reaches normal reading zoom. */
  semanticBandOriginDepth: number | undefined;
  /** First preview threshold; both paint and commit detection must read this exact value. */
  semanticFirstPreviewMax: number;
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
  /** Extras that must render INSIDE the flow (beacon arrows, the overlay's ghost "+" ring). */
  flowExtras?: (view: SurfaceFlowView) => ReactNode;
  /** Floating chrome (breadcrumb, legends, panels, action strips), absolutely positioned over the canvas. */
  children?: ReactNode;
  /** Retain the last committed graph underneath a blocking status overlay while its replacement is derived. */
  busy?: GraphLayoutIndicatorProps;
  /** Frozen overview mode: pan/zoom and source inspection remain, graph selection/navigation do not. */
  readOnly?: boolean;
  /** Surface-local highlight set which does not mutate the Map/minimal graph's real selection. */
  selectionOverride?: ReadonlySet<string>;
  /** Separate paint owners when node rings and relationship emphasis intentionally differ. */
  paintSelectionOverride?: ReadonlySet<string>;
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
  const index = useBlueprint((state) => state.index);
  const radius = useBlueprint((state) => state.moduleRadius);
  const highlightMode = useBlueprint((state) => state.highlightMode);
  const relationVisibilityOverrides = useBlueprint((state) => state.relationVisibilityOverrides);
  const showHighways = useBlueprint((state) => state.showHighways);
  const groupGhostsByParent = useBlueprint((state) => state.groupGhostsByParent);
  const edgeEvidenceOpen = useBlueprint((state) => state.codeView?.edgeEvidence !== undefined);
  const { showEdgeEvidence, closeEdgeEvidence } = useBlueprintActions();
  const emphasisMode = props.emphasisMode ?? highlightMode;
  const groupGhosts = props.groupGhosts ?? groupGhostsByParent;
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
  const programmaticUserZoomArmed = useRef(false);
  // Local wire state and global source state still need one owner boundary. This ref distinguishes
  // a source-backed inspection (whose source disappearing ends the whole dock) from an intentional
  // metadata-only wire, which remains useful without a source pane.
  const inspectionOwnsSource = useRef(false);
  const onMoveStart = useCallback<OnMoveStart>((event, viewport) => {
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
    if (!semanticCommitEnabled) {
      previousUserZoom.current = null;
      return;
    }
    if (event == null && !programmaticUserZoomArmed.current) {
      // A semantic handoff's setCenter can run inside an active wheel gesture. Ignore its null-event
      // camera callbacks without erasing the user's preceding sample, so outward movement can keep
      // crossing farther levels continuously.
      return;
    }
    const previousZoom = previousUserZoom.current;
    // Advance the sample before the synchronous owner callback filters the mounted graph. If that
    // causes an immediate rerender, another move sample starts from the camera position just seen.
    previousUserZoom.current = viewport.zoom;
    if (previousZoom === null) {
      return;
    }
    const targetDepth = semanticCommitDepthForZoomChange(
      previousZoom,
      viewport.zoom,
      semanticDepths,
      props.semanticBandOriginDepth,
      props.semanticFirstPreviewMax,
    );
    const target = props.semanticLayers.find((layer) => layer.depth === targetDepth);
    if (target !== undefined) {
      props.onSemanticCommit(target);
    }
  }, [props.onSemanticCommit, props.semanticLayers, props.semanticBandOriginDepth, props.semanticFirstPreviewMax, semanticCommitEnabled, semanticDepths]);
  const onMoveEnd = useCallback<OnMoveEnd>((event) => {
    if (event != null || programmaticUserZoomArmed.current) {
      previousUserZoom.current = null;
      programmaticUserZoomArmed.current = false;
    }
  }, []);
  useEffect(() => {
    if (!semanticCommitEnabled) {
      previousUserZoom.current = null;
      programmaticUserZoomArmed.current = false;
    }
  }, [semanticCommitEnabled]);

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
      const painted = paintSemanticLayers(props.nodes, props.edges, paintOwnership.protectedSelection, radius, emphasisMode, {
        policy: props.relations,
        overrides: relationVisibilityOverrides,
      }, {
        index,
        groupByParent: groupGhosts,
        expandedGroupIds: props.interactions.expandedGhostGroupIds,
      }, paintOwnership.paintSeeds, paintOwnership.focusSeeds);
      return { ...painted, highwaySeeds: paintOwnership.highwaySeeds };
    },
    [props.nodes, props.edges, paintOwnership, radius, emphasisMode, props.relations, relationVisibilityOverrides, index, groupGhosts, props.interactions.expandedGhostGroupIds],
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
  // Group disclosure is deliberately downstream of the shared paint chain. It injects the
  // mount-local explicit-chevron callback without feeding a function back into derive/layout.
  const displayedNodes = useMemo(
    () => decorateGhostGroupToggles(retainedPaintedNodes, props.interactions.toggleGhostGroup),
    [retainedPaintedNodes, props.interactions.toggleGhostGroup],
  );
  // The module-family layouts keep their canonical geometry in `style.width/height`, which all
  // routing and overlay passes below intentionally continue to read. React Flow's MiniMap checks
  // only top-level dimensions on the controlled user node, so expose the same numbers at the final
  // library boundary after the paint-only inspection decoration.
  const reactFlowNodes = useMemo(() => withReactFlowDimensions(displayedNodes), [displayedNodes]);
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
  const openWireEvidence = useCallback((pair: Edge[]) => {
    const contexts = edgeEvidenceForPair(pair, index.edgesById);
    inspectionOwnsSource.current = contexts.length > 0;
    // The action also clears prior source when the new wire has no attributable site, while the
    // inspector itself remains useful as relationship metadata.
    void showEdgeEvidence(contexts);
  }, [index.edgesById, showEdgeEvidence]);
  const wire = useWireHover(
    preparedEdges.semanticEdges,
    retainedPaintedNodes,
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
  const nodeDiff = useNodeDiffPreview(nodeDiffEnabled);

  return (
    <SurfaceInteractionScope
      readOnly={props.readOnly === true}
      selectionOverride={props.selectionOverride ?? null}
    >
    <div
      style={SURFACE_STYLE}
      aria-busy={props.busy ? "true" : undefined}
      onClickCapture={(event) => {
        const target = event.target;
        if (target instanceof Element && target.closest(".react-flow__controls-zoomout") !== null) {
          // Controls uses the viewport API, whose move event is null just like fitView. Arm it before
          // the button's target handler runs so this explicit user zoom follows semantic navigation.
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
      <ReactFlow<Node, Edge>
        className={hasSemanticComposite ? "semantic-composite" : undefined}
        nodes={reactFlowNodes}
        edges={renderedEdges}
        nodeTypes={moduleNodeTypes}
        edgeTypes={moduleEdgeTypes}
        onInit={props.onInit}
        onNodeClick={props.readOnly ? undefined : props.interactions.onNodeClick}
        onNodeDoubleClick={props.readOnly ? undefined : props.interactions.onNodeDoubleClick}
        onNodeMouseEnter={nodeDiffEnabled ? nodeDiff.onNodeMouseEnter : undefined}
        onNodeMouseMove={nodeDiffEnabled ? nodeDiff.onNodeMouseMove : undefined}
        onNodeMouseLeave={nodeDiffEnabled ? nodeDiff.onNodeMouseLeave : undefined}
        onPaneMouseMove={nodeDiffEnabled ? nodeDiff.onPaneMouseMove : undefined}
        onPaneClick={() => {
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
        {...READONLY_CANVAS_PROPS}
        elementsSelectable={!props.readOnly}
        nodesFocusable={!props.readOnly}
        edgesFocusable={!props.readOnly}
        fitView={props.autoFitView ?? !hasSemanticComposite}
      >
        <CanvasChrome nodeColor={props.miniMapColor} minimap={!virtualizeCanvas} />
        <MapLod
          nodes={reactFlowNodes}
          semanticLayers={props.semanticLayers}
          semanticDepths={semanticDepths}
          semanticBandOriginDepth={props.semanticBandOriginDepth}
          semanticFirstPreviewMax={props.semanticFirstPreviewMax}
          semanticLodEnabled={props.semanticLodEnabled}
        />
        {props.flowExtras?.({ nodes: displayedNodes, beacons })}
      </ReactFlow>
      {wire.hover ? <WireTooltip hover={wire.hover} /> : null}
      {wire.inspectedPair ? (
        <EdgeInspectionDock pair={wire.inspectedPair} labelOf={wire.labelOf} onClose={wire.clearInspected} onDrill={wire.inspect} />
      ) : null}
      {nodeDiff.layer}
      {props.children}
      {props.busy ? <GraphLayoutIndicator {...props.busy} /> : null}
    </div>
    </SurfaceInteractionScope>
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

/** Attach the explicit disclosure action only to grouped ghost parents. Exact ghosts and every
 * geometry/layout field retain object identity; only the matching parents' paint data is cloned. */
export function decorateGhostGroupToggles(
  nodes: Node[],
  toggleGhostGroup: (groupId: string) => void,
): Node[] {
  let decorated: Node[] | null = null;
  nodes.forEach((node, index) => {
    if (ghostGroupInteractionOf(node) === null) {
      return;
    }
    decorated ??= [...nodes];
    decorated[index] = { ...node, data: { ...node.data, toggleGhostGroup } };
  });
  return decorated ?? nodes;
}

/** MiniMap and viewport virtualization switch at the same boundary: below it every canonical
 * node has both a canvas card and a MiniMap mark; above it both expensive representations go. */
export function shouldVirtualizeCanvasNodes(nodeCount: number): boolean {
  return nodeCount > MINIMAP_NODE_CAP;
}

/** The shared canvas root — exported so a mount's own replacement branches (the overlay split)
 * keep the identical backdrop. */
export const SURFACE_STYLE: React.CSSProperties = { position: "absolute", inset: 0, background: "#0E1116" };
