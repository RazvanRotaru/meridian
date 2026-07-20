/**
 * The minimal-graph OVERLAY — a THIN MOUNT of the shared GraphSurface with spool-only highways
 * (`MINIMAL_OVERLAY_HIGHWAYS`): the Module-map's "Extract selection" result as its own read-only React Flow
 * surface. Ordinary extracts cover a retained source canvas for their outward handoff; a PR review
 * is a navigation boundary and unmounts that covered source to keep large reviews within the
 * renderer budget. It EXTRACTS the selection verbatim (any kind — a selected package stays ONE
 * card) as MEMBERS — SEED cards (the origin selection, keeping their
 * green ring) and PERSISTENT cards (ghosts the reader promoted) — ringed by the Map's OWN ghost
 * SATELLITES: every code coupling that leaves the member set charts its off-overlay symbol as a
 * dashed `GhostNode` card banded outside the core (callers left, dependencies right), per-kind
 * wired. Like the Map, satellites are ON-DEMAND context: selecting a member reveals only that
 * member's off-view callers/dependencies. Each satellite wears a subtle round "+" that promotes its
 * home file/folder into the members and opens the path until the original symbol is visible. A
 * crowded sibling set folds under its persistent real parent; that parent's explicit chevron
 * discloses exact children as outward neighbours. The shared bottom action bar removes selected
 * promoted members, rearranges, resets, and explicitly closes the extracted graph, returning to the
 * active lens with the selection kept. Wires are painted by the Map's OWN chain and keyed by its
 * own `MapLegend`, so the overlay's colour vocabulary is the Map's by construction. Highways here means SPOOLING
 * only: fan hubs gather their many wires into shared trunks (no containers to pair-bundle in this
 * flat overlay); every overlay wire is a painted import/dep wire, so when Highways is on they ALL
 * spool.
 *
 * Gestures ARE the Module map's own, via the shared interaction hook inside GraphSurface — so
 * they're identical to the Map by construction: single-click selects (DEBOUNCED, so a double-click
 * wins), ctrl/cmd toggles the selection, a pane-click clears it, and a double-click NAVIGATES into
 * the node exactly like the Map (the overlay just closes first, since it covers the Map, so the
 * navigation surfaces — for a satellite that's the Map's reveal-the-definition read). A plain
 * click NEVER promotes an exact ghost — promotion is the explicit "+" button, so curation is
 * deliberate; a persistent parent group's chevron toggles its exact child neighbours. The only
 * page-specific gestures are that "+" (promote) and explicit Close.
 */

import { useCallback, useMemo, useRef } from "react";
import { useBlueprint, useBlueprintActions } from "../state/StoreContext";
import { MapLegend } from "./MapLegend";
import { GraphSurface } from "./canvas/GraphSurface";
import { GhostPromoteRing } from "./canvas/GhostPromoteRing";
import { SEMANTIC_LAYER_FADE_MS } from "./canvas/MapLod";
import {
  adaptMinimalGraphToSemanticSource,
  type MinimalSourceGraphState,
} from "./canvas/minimalSemanticSource";
import { activeModuleSurfaceSpec, MINIMAL_OVERLAY_HIGHWAYS } from "./canvas/surfaceSpec";
import { useModuleNodeInteractions } from "./canvas/useModuleNodeInteractions";
import { useRecenter } from "./canvas/useRecenter";
import {
  SEMANTIC_READING_MIN_ZOOM,
  useSemanticSurfaceNavigation,
} from "./canvas/useSemanticSurfaceNavigation";
import { CanvasActionBar } from "./controlpanel/CanvasActionBar";
import { minimalMiniMapColor } from "./minimalGraphStyles";
import { filterExternalGhosts, filterGhostNodes } from "./moduleMapPaint";
import { relationKindOf } from "../graph/relationEdge";
import { reviewSurfaceIsOpen } from "../state/store";

// A review-panel click centers on a single (possibly tiny) method card, so cap how far the fit zooms in.
const RECENTER_OPTIONS = { maxZoom: 1 } as const;
const MINIMAL_SEMANTIC_FIT = { minZoom: SEMANTIC_READING_MIN_ZOOM } as const;

export function MinimalGraphView({
  onShowCodebase,
  codebaseButtonRef,
}: {
  onShowCodebase: () => void;
  codebaseButtonRef?: React.Ref<HTMLButtonElement>;
}) {
  const nodes = useBlueprint((state) => state.minimalRfNodes);
  const edges = useBlueprint((state) => state.minimalRfEdges);
  const selected = useBlueprint((state) => state.moduleSelected);
  const seedIds = useBlueprint((state) => state.minimalSeedIds);
  const layoutStatus = useBlueprint((state) => state.minimalLayoutStatus);
  const layoutActivity = useBlueprint((state) => state.minimalLayoutActivity);
  const reviewSelectedId = useBlueprint((state) => state.reviewSelectedId);
  const reviewActive = useBlueprint(reviewSurfaceIsOpen);
  const nestedExtraction = useBlueprint((state) => state.minimalGraphHistory.length > 0);
  const reviewFlowOpen = useBlueprint((state) => state.flowSelection !== null && state.reviewFlowBaseline !== null);
  const index = useBlueprint((state) => state.index);
  const viewMode = useBlueprint((state) => state.viewMode);
  const moduleFocus = useBlueprint((state) => state.moduleFocus);
  const moduleEffectiveFocus = useBlueprint((state) => state.moduleEffectiveFocus);
  const serviceScope = useBlueprint((state) => state.serviceScope);
  const serviceGroupingMode = useBlueprint((state) => state.serviceGroupingMode);
  const serviceGroupingTargetSize = useBlueprint((state) => state.serviceGroupingTargetSize);
  const serviceGroupingLabelMode = useBlueprint((state) => state.serviceGroupingLabelMode);
  const showExternalGhosts = useBlueprint((state) => state.showExternalGhosts);
  const showGhostNodes = useBlueprint((state) => state.minimalShowGhostNodes);
  const {
    closeMinimalGraph,
    promoteGhost,
    openReviewSubgraph,
    minimalRelayout,
    selectModule,
    setMinimalShowGhostNodes,
  } = useBlueprintActions();
  const relations = activeModuleSurfaceSpec(viewMode).relations;
  const ghostIds = useMemo(
    () => new Set(nodes.filter((node) => node.type === "ghost").map((node) => node.id)),
    [nodes],
  );
  const relationKinds = useMemo(() => {
    const kinds = new Set<string>();
    edges.forEach((edge) => {
      const kind = relationKindOf(edge.data);
      if (kind !== null) kinds.add(kind);
    });
    return [...kinds];
  }, [edges]);
  const toggleGhostNodes = useCallback(() => {
    const next = !showGhostNodes;
    if (!next && [...selected].some((id) => ghostIds.has(id))) {
      // A hidden selection must not leave the surviving graph dimmed around an absent paint seed.
      selectModule(null);
    }
    setMinimalShowGhostNodes(next);
  }, [ghostIds, selectModule, selected, setMinimalShowGhostNodes, showGhostNodes]);

  // Interactions ARE the Module map's own (the shared hook — called HERE so the debounce dies with
  // the overlay). During PR review, package double-click opens an exact-file child graph and every
  // other double-click stays inside the review boundary; outside review, double-click retains the
  // ordinary close-then-navigate handoff to the source Map. Disclosure and promotion remain their
  // explicit chevron / "+" controls.
  const interactions = useModuleNodeInteractions({
    onDoubleClick: reviewActive
      ? (_event, node) => {
          if (node.type === "package") {
            openReviewSubgraph(node.id);
          }
          return true;
        }
      : undefined,
    onBeforeDoubleClick: reviewActive ? undefined : closeMinimalGraph,
  });

  // Recenter may fall back to an ordinary URL-restored graph's immutable origin, but paint never
  // does: like every other canvas, ghost context belongs only to a live drawable selection.
  const recenterIds = useMemo(
    () => {
      if (reviewSelectedId !== null) {
        return [reviewSelectedId];
      }
      if (reviewActive) {
        return [...selected];
      }
      const drawnIds = new Set(nodes.map((node) => node.id));
      const needsOrigin = selected.size === 0 || [...selected].some((id) => !drawnIds.has(id));
      return needsOrigin ? [...new Set([...seedIds, ...selected])] : [...selected];
    },
    [nodes, reviewActive, reviewSelectedId, seedIds, selected],
  );
  useRecenter(recenterIds, RECENTER_OPTIONS);

  // Capture the source graph ONCE for this overlay lifetime. Curation can change the minimal graph,
  // but its outward parent remains the exact Map/Service/UI scene from which it was extracted.
  const sourceRef = useRef<MinimalSourceGraphState | null>(null);
  sourceRef.current ??= {
    index,
    viewMode,
    moduleFocus,
    moduleEffectiveFocus,
    serviceScope,
    serviceGroupingMode,
    serviceGroupingTargetSize,
    serviceGroupingLabelMode,
  };
  const visibleGraph = useMemo(() => {
    const externalFiltered = filterExternalGhosts(nodes, edges, showExternalGhosts);
    return filterGhostNodes(externalFiltered.nodes, externalFiltered.edges, showGhostNodes);
  }, [edges, nodes, showExternalGhosts, showGhostNodes]);
  const semanticScene = useMemo(
    () => reviewActive || nestedExtraction
      ? { ...visibleGraph, semanticLayers: [] as const }
      : adaptMinimalGraphToSemanticSource(visibleGraph, sourceRef.current!),
    [nestedExtraction, reviewActive, visibleGraph],
  );
  // PR and nested overlays are navigation boundaries. A nested frame's immediate parent is a store
  // snapshot rather than the source canvas mounted underneath, so semantic zoom stays disabled
  // until toolbar Back restores that frame; otherwise the fade would preview the wrong ancestor and
  // Close would discard the whole stack. Root non-review extracts still zoom back to their source.
  const semanticLayers = semanticScene.semanticLayers;
  const semanticNavigation = useSemanticSurfaceNavigation({
    nodes: semanticScene.nodes,
    layoutStatus,
    semanticLayers,
    resetKeys: [nodes],
    commitAdapter: {
      mode: "exit",
      commit: () => {
        if (reviewActive) {
          return false;
        }
        closeMinimalGraph();
        return true;
      },
    },
    fit: MINIMAL_SEMANTIC_FIT,
  });

  return (
    <div style={{ ...MINIMAL_SEMANTIC_SURFACE_STYLE, opacity: semanticNavigation.exitPending ? 0 : 1 }}>
      <GraphSurface
        nodes={semanticScene.nodes}
        edges={semanticScene.edges}
        highways={MINIMAL_OVERLAY_HIGHWAYS}
        relations={relations}
        miniMapColor={minimalMiniMapColor}
        interactions={interactions}
        nodeDiffPreview={reviewActive}
        wireHover
        requestOverlayChrome={false}
        reviewEmphasis={reviewActive}
        emphasisMode={reviewFlowOpen ? (reviewSelectedId === null ? "subgraph" : "node") : undefined}
        groupGhosts={reviewFlowOpen && reviewSelectedId !== null ? false : undefined}
        showGhostNodes={showGhostNodes}
        busy={layoutStatus === "laying-out" ? layoutActivity ?? undefined : undefined}
        autoFitView={false}
        semanticLayers={semanticLayers}
        semanticDepths={semanticNavigation.semanticDepths}
        semanticBandOriginDepth={semanticNavigation.semanticBandOriginDepth}
        semanticLodEnabled={semanticNavigation.semanticLodEnabled}
        semanticCommitEnabled={semanticNavigation.semanticCommitEnabled}
        onSemanticCommit={semanticNavigation.onSemanticCommit}
        onInit={semanticNavigation.onInit}
        flowExtras={(view) => <GhostPromoteRing nodes={view.nodes} title="Add to the graph" onPromote={promoteGhost} />}
      >
        {/* The Map's own legend, in the Map's own corner (bottom-left, clear of the zoom controls) — the
            overlay shares the Map's colour vocabulary, so it shares the Map's key to it. The package row
            shows only when a group member/ghost card is actually present; IPC opts out always. */}
        <MapLegend
          hasSteps={visibleGraph.nodes.some((node) => node.type === "step")}
          showPackages={visibleGraph.nodes.some((node) => node.type === "package")}
          showIpc={false}
          relationPolicy={relations}
        />
        <CanvasActionBar
          onShowCodebase={onShowCodebase}
          codebaseButtonRef={codebaseButtonRef}
          ghostNodesVisible={showGhostNodes}
          hasGhostNodes={ghostIds.size > 0}
          onToggleGhostNodes={toggleGhostNodes}
          relationKinds={relationKinds}
        />
      </GraphSurface>
      {reviewActive && seedIds.length === 0 && layoutStatus !== "laying-out" && layoutStatus !== "error" ? (
        <div data-review-empty-canvas="true" role="status" style={EMPTY_REVIEW_CANVAS}>
          <strong style={EMPTY_REVIEW_TITLE}>No file graph loaded</strong>
          <span style={EMPTY_REVIEW_COPY}>Select a changed file to load its graph.</span>
        </div>
      ) : null}
      {layoutStatus === "error" && (
        <div role="alert" style={LAYOUT_ERROR}>
          <strong style={LAYOUT_ERROR_TITLE}>Couldn’t arrange this review graph</strong>
          <span style={LAYOUT_ERROR_COPY}>
            Narrow the Review scope or choose a change group, then retry. Your PR review state is still intact.
          </span>
          <div style={LAYOUT_ERROR_ACTIONS}>
            <button type="button" style={LAYOUT_ERROR_BUTTON} onClick={() => void minimalRelayout({ label: "Retrying review graph…" })}>
              Retry
            </button>
            <button type="button" style={LAYOUT_ERROR_BUTTON} onClick={closeMinimalGraph}>
              Return to map
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

const MINIMAL_SEMANTIC_SURFACE_STYLE: React.CSSProperties = {
  position: "absolute",
  inset: 0,
  transition: `opacity ${SEMANTIC_LAYER_FADE_MS}ms ease-out`,
};
const EMPTY_REVIEW_CANVAS: React.CSSProperties = {
  position: "absolute",
  left: "50%",
  top: "50%",
  zIndex: 10,
  transform: "translate(-50%, -50%)",
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: 6,
  padding: "14px 18px",
  border: "1px solid #303B48",
  borderRadius: 10,
  background: "rgba(13, 17, 23, 0.92)",
  color: "#E6EDF3",
  textAlign: "center",
  pointerEvents: "none",
};
const EMPTY_REVIEW_TITLE: React.CSSProperties = { fontSize: 13 };
const EMPTY_REVIEW_COPY: React.CSSProperties = { color: "#9AA4B2", fontSize: 12 };
const LAYOUT_ERROR: React.CSSProperties = {
  position: "absolute",
  left: "50%",
  top: "50%",
  zIndex: 20,
  width: 360,
  maxWidth: "calc(100% - 48px)",
  transform: "translate(-50%, -50%)",
  display: "flex",
  flexDirection: "column",
  gap: 10,
  padding: 18,
  border: "1px solid #4B5563",
  borderRadius: 12,
  background: "rgba(13, 17, 23, 0.96)",
  boxShadow: "0 18px 60px rgba(0, 0, 0, 0.45)",
  color: "#E6EDF3",
};
const LAYOUT_ERROR_TITLE: React.CSSProperties = { fontSize: 14 };
const LAYOUT_ERROR_COPY: React.CSSProperties = { color: "#9AA4B2", fontSize: 12, lineHeight: 1.45 };
const LAYOUT_ERROR_ACTIONS: React.CSSProperties = { display: "flex", gap: 8 };
const LAYOUT_ERROR_BUTTON: React.CSSProperties = {
  border: "1px solid #394451",
  borderRadius: 7,
  background: "#161B22",
  color: "#E6EDF3",
  padding: "6px 10px",
  cursor: "pointer",
};
