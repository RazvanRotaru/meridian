/**
 * The Module-map view — a THIN MOUNT of the shared GraphSurface (unified-canvas phase A): one
 * zoomable containment scene for the folder Map, Service, or renders-rooted UI lens. Nodes and
 * edges are laid out in the store; this mount supplies lens chrome, visibility filtering,
 * interactions, recentering, and the shared semantic-navigation lifecycle.
 *
 * Double-click and breadcrumbs dive explicitly. Wheel/pinch previews an already-mounted parent,
 * then commits it as outward navigation after crossing the threshold. The retained anchor stays
 * centred while the camera returns to reading zoom, and the same transition can continue through
 * every available level. An ordinary Minimal Graph uses an isolated React Flow provider above the
 * still-mounted source so its outward handoff can reveal the exact source viewport in place. A PR
 * review is an explicit navigation boundary, so its covered source surface is unmounted instead of
 * paying for two complete React Flow scenes while a large review is open.
 *
 *   1. `filterVisible` drops file cards a category/Tests toggle hides (group cards always stay) —
 *      a pure VISIBILITY filter over the laid-out graph, so positions are untouched;
 *   2. the LENS-lifetime hooks: the fit-once-per-LEVEL guard, the interaction hook (its pending
 *      single-click select), and the (muted-while-covered) recenter reaction — all of which must
 *      survive the minimal overlay replacing the canvas beneath it;
 *   3. the containment/scope breadcrumb, extract strip, empty-level card, legend, and coverage chrome.
 *
 * Navigation is one gesture set: double-click a navigable card to enter it; the breadcrumb (the
 * containment trail) navigates back out. Recenter/focus is a separate explicit canvas action.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { Node } from "@xyflow/react";
import { useBlueprint, useBlueprintActions } from "../state/StoreContext";
import { EmptyModuleMapCard, ServiceScopeBreadcrumb } from "./ModuleMapChrome";
import { LevelBreadcrumb } from "./LevelBreadcrumb";
import { filterExternalGhosts, filterVisible } from "./moduleMapPaint";
import { CoveragePanel } from "./CoveragePanel";
import { BeaconArrows } from "./BeaconArrows";
import { MapLegend } from "./MapLegend";
import { CanvasActionBar } from "./controlpanel/CanvasActionBar";
import {
  GraphSurface,
  GraphSurfaceProvider,
  SURFACE_STYLE,
  type SurfaceFlowView,
} from "./canvas/GraphSurface";
import { GhostPromoteRing } from "./canvas/GhostPromoteRing";
import { activeModuleSurfaceSpec } from "./canvas/surfaceSpec";
import { useModuleNodeInteractions } from "./canvas/useModuleNodeInteractions";
import { useRecenter } from "./canvas/useRecenter";
import { useSemanticSurfaceNavigation } from "./canvas/useSemanticSurfaceNavigation";
import { MinimalGraphView } from "./MinimalGraphView";
import { MinimalCodebaseView } from "./MinimalCodebaseView";
import { ReviewPanel } from "./review/ReviewPanel";
import { accentForKind } from "../theme/kindColors";
import type { BlockData, UnitCardData } from "../derive/moduleLevel";
import { clusteringFor } from "../derive/serviceClusteringCache";
import { serviceClusterCount } from "../derive/serviceComposition";

const PACKAGE_KIND = "package";
const SERVICE_DOMAIN_KIND = "serviceDomain";

export function ModuleMapView() {
  const minimalOpen = useBlueprint((state) => state.minimalSeedIds.length > 0);
  const reviewActive = useBlueprint((state) => state.review !== null);
  const sourceMounted = !minimalOpen || !reviewActive;
  const [minimalView, setMinimalView] = useState<"graph" | "codebase">("graph");
  const codebaseButtonRef = useRef<HTMLButtonElement>(null);
  const backButtonRef = useRef<HTMLButtonElement>(null);
  const focusTransfer = useRef<"graph" | "codebase" | null>(null);
  useEffect(() => {
    if (!minimalOpen) {
      focusTransfer.current = null;
      setMinimalView("graph");
      return;
    }
    if (focusTransfer.current !== minimalView) return;
    focusTransfer.current = null;
    const frame = window.requestAnimationFrame(() => {
      (minimalView === "codebase" ? backButtonRef : codebaseButtonRef).current?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [minimalOpen, minimalView]);
  const showCodebase = () => {
    focusTransfer.current = "codebase";
    setMinimalView("codebase");
  };
  const showExtractedGraph = () => {
    focusTransfer.current = "graph";
    setMinimalView("graph");
  };
  return (
    <div style={SURFACE_STYLE}>
      {/* Ordinary Minimal Graphs retain the source for their fade/zoom handoff. PR review disables
          that handoff, so keeping the repo-scale React Flow mounted underneath only doubles the
          DOM/paint workload and can exhaust the renderer on large changes. */}
      {sourceMounted ? (
        <div
          data-graph-surface="source"
          style={SOURCE_SURFACE_LAYER_STYLE}
          inert={minimalOpen}
          aria-hidden={minimalOpen || undefined}
        >
          <GraphSurfaceProvider>
            <ModuleSourceSurface covered={minimalOpen} />
          </GraphSurfaceProvider>
        </div>
      ) : null}
      {minimalOpen ? (
        <div data-graph-surface="minimal" style={MINIMAL_OVERLAY_STYLE}>
          <div style={REVIEW_SPLIT_STYLE}>
            <div
              style={REVIEW_GRAPH_STYLE}
              role="region"
              aria-label={minimalView === "codebase" ? "Codebase context graph" : "Extracted graph"}
            >
              <GraphSurfaceProvider>
                {minimalView === "codebase" ? (
                  <MinimalCodebaseView onBackToGraph={showExtractedGraph} backButtonRef={backButtonRef} />
                ) : (
                  <MinimalGraphView onShowCodebase={showCodebase} codebaseButtonRef={codebaseButtonRef} />
                )}
              </GraphSurfaceProvider>
            </div>
            <ReviewPanel />
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ModuleSourceSurface({ covered }: { covered: boolean }) {
  const nodes = useBlueprint((state) => state.moduleRfNodes);
  const edges = useBlueprint((state) => state.moduleRfEdges);
  const selected = useBlueprint((state) => state.moduleSelected);
  const ghostInspection = useBlueprint((state) => state.moduleGhostInspection);
  const layoutStatus = useBlueprint((state) => state.moduleLayoutStatus);
  const layoutActivity = useBlueprint((state) => state.moduleLayoutActivity);
  const rawFocus = useBlueprint((state) => state.moduleFocus);
  const effectiveFocus = useBlueprint((state) => state.moduleEffectiveFocus);
  const semanticLayers = useBlueprint((state) => state.moduleSemanticLayers);
  const index = useBlueprint((state) => state.index);
  const hiddenCategories = useBlueprint((state) => state.hiddenCategories);
  const showTests = useBlueprint((state) => state.showTests);
  const showPrivate = useBlueprint((state) => state.showPrivate);
  const showExternalGhosts = useBlueprint((state) => state.showExternalGhosts);
  const showCommons = useBlueprint((state) => state.showCommons);
  const viewMode = useBlueprint((state) => state.viewMode);
  const requestFlowOpen = useBlueprint((state) => state.flowPaneOrigin === "request");
  const serviceScope = useBlueprint((state) => state.serviceScope);
  const serviceGroupingMode = useBlueprint((state) => state.serviceGroupingMode);
  const serviceGroupingTargetSize = useBlueprint((state) => state.serviceGroupingTargetSize);
  const serviceGroupingLabelMode = useBlueprint((state) => state.serviceGroupingLabelMode);
  const { setModuleFocus, commitModuleSemanticParent, clearServiceScope, promoteGhost, folderChildrenFor } = useBlueprintActions();
  const spec = activeModuleSurfaceSpec(viewMode);

  // The source remains mounted while covered. Its recenter subscription is muted so a toolbar
  // signal cannot disturb the viewport which Minimal Graph will reveal on outward navigation.
  const interactions = useModuleNodeInteractions({ enableGhostInspection: true });
  // Runtime-card clicks often target one small method. Cap that fit below 1:1 so the highlighted
  // node stays prominent without losing its owning file/unit and immediate execution context.
  useRecenter(useMemo(() => [...selected], [selected]), {
    enabled: !covered,
    maxZoom: requestFlowOpen ? 0.9 : undefined,
  });

  // Category/test/external hiding is a pure visibility filter over already-laid geometry. External
  // ghosts are removed before GraphSurface groups crowds, so the synthetic External card vanishes too.
  const { nodes: shownNodes, edges: shownEdges } = useMemo(
    () => {
      const visible = filterVisible(nodes, edges, {
        hiddenCategories,
        showTests,
        testIds: index.testIds,
        showPrivate,
        privateIds: index.privateIds,
      });
      return filterExternalGhosts(visible.nodes, visible.edges, showExternalGhosts);
    },
    [nodes, edges, hiddenCategories, showTests, showPrivate, showExternalGhosts, index.testIds, index.privateIds],
  );

  // All module-family surfaces use this controller. The mount contributes only its store commit
  // and the structural inputs which identify a newly derived level—including Service grouping.
  const semanticNavigation = useSemanticSurfaceNavigation({
    nodes,
    fitNodes: shownNodes,
    layoutStatus,
    semanticLayers,
    resetKeys: [
      rawFocus,
      effectiveFocus,
      showTests,
      serviceScope,
      showCommons,
      serviceGroupingMode,
      serviceGroupingTargetSize,
      serviceGroupingLabelMode,
    ],
    commitAdapter: {
      mode: "retained-anchor",
      commit: (layer) => commitModuleSemanticParent(layer.depth),
    },
  });

  const isEmpty = semanticNavigation.currentNodes.length === 0 && layoutStatus === "ready";
  const busy = layoutStatus === "laying-out" ? layoutActivity ?? undefined : undefined;
  const inspectionPositionKey = ghostInspection === null
    ? null
    : JSON.stringify([
        [...ghostInspection.anchorIds].sort(),
        ghostInspection.visitedIds.values().next().value ?? null,
      ]);

  return (
    <GraphSurface
      nodes={shownNodes}
      edges={shownEdges}
      highways={spec.highways}
      relations={spec.relations}
      miniMapColor={miniMapColor}
      interactions={interactions}
      positionRetentionKey={inspectionPositionKey}
      positionAdmissionReady={layoutStatus === "ready"}
      busy={busy}
      autoFitView={false}
      semanticLayers={semanticLayers}
      semanticDepths={semanticNavigation.semanticDepths}
      semanticBandOriginDepth={semanticNavigation.semanticBandOriginDepth}
      semanticLodEnabled={semanticNavigation.semanticLodEnabled}
      semanticCommitEnabled={semanticNavigation.semanticCommitEnabled}
      onSemanticCommit={semanticNavigation.onSemanticCommit}
      onInit={semanticNavigation.onInit}
      wireHover={!covered}
      requestOverlayChrome={!covered}
      flowExtras={(view) => (
        <>
          {renderBeacons(view)}
          {/* Canonical real-id ghosts remain promotable while persistent parent anchors disclose
              their children; temporary real previews share the same explicit commit ring. */}
          <GhostPromoteRing nodes={view.nodes} title="Pin to canvas" onPromote={promoteGhost} />
        </>
      )}
    >
      {viewMode === "call" && serviceScope !== null ? (
        // The scoped Service sub-view's trail: "All services › <scope> ✕ [› <cluster>]" — the
        // cluster navigation trail composes onto the scope segment.
        // "All services" exits everything; ✕ drops the scope filter; the scope label (a button
        // only while zoomed) steps back out of the dive.
        <ServiceScopeBreadcrumb
          label={serviceScope.label}
          crumbs={spec.navigation.crumbs(
            effectiveFocus,
            index,
            serviceGroupingMode,
            serviceGroupingTargetSize,
            serviceGroupingLabelMode,
          )}
          onClear={() => {
            clearServiceScope();
            setModuleFocus(null);
          }}
          onExitScope={clearServiceScope}
          onFocus={setModuleFocus}
        />
      ) : (
        <LevelBreadcrumb
          focus={effectiveFocus}
          packageCount={effectiveFocus === null
            ? viewMode === "call"
              ? serviceClusterCount(clusteringFor(index))
              : semanticNavigation.currentNodes.filter((node) => !node.parentId && node.type !== "ghost").length
            : 0}
          crumbs={spec.navigation.crumbs(
            effectiveFocus,
            index,
            serviceGroupingMode,
            serviceGroupingTargetSize,
            serviceGroupingLabelMode,
          )}
          onFocus={setModuleFocus}
          rootLabel={spec.navigation.rootLabel}
          rootNoun={spec.navigation.rootNoun}
          childrenOf={spec.id === "map" ? folderChildrenFor : undefined}
        />
      )}
      <CanvasActionBar />
      {isEmpty ? <EmptyModuleMapCard focus={effectiveFocus} /> : null}
      <MapLegend hasSteps={shownNodes.some((node) => node.type === "step")} relationPolicy={spec.relations} />
      <CoveragePanel />
    </GraphSurface>
  );
}

const renderBeacons = (view: SurfaceFlowView) => <BeaconArrows targets={view.beacons} />;

function miniMapColor(node: Node): string {
  if (node.type === PACKAGE_KIND || node.type === SERVICE_DOMAIN_KIND) {
    return "#5B9BE3";
  }
  if (node.type === "unit") {
    return accentForKind((node.data as UnitCardData).unitKind);
  }
  if (node.type === "block") {
    return accentForKind((node.data as BlockData).blockKind);
  }
  if (node.type === "step" || node.type === "ghost") {
    return "#565E68";
  }
  if (node.type === "commonsDock") {
    return "#5C4A2F";
  }
  return accentForKind("module");
}

const REVIEW_SPLIT_STYLE: React.CSSProperties = { position: "absolute", inset: 0, display: "flex" };
const REVIEW_GRAPH_STYLE: React.CSSProperties = { position: "relative", flex: 1, minWidth: 0 };
const SOURCE_SURFACE_LAYER_STYLE: React.CSSProperties = { position: "absolute", inset: 0 };
const MINIMAL_OVERLAY_STYLE: React.CSSProperties = { position: "absolute", inset: 0, zIndex: 10 };
