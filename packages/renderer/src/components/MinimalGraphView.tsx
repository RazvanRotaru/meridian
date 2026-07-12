/**
 * The minimal-graph OVERLAY — a THIN MOUNT of the shared GraphSurface with spool-only highways
 * (`MINIMAL_OVERLAY_HIGHWAYS`): the Module-map's "Extract selection" result as its own read-only React Flow
 * surface, covering the still-mounted source canvas while open. It EXTRACTS the selection verbatim (any kind — a
 * selected package stays ONE card) as MEMBERS — SEED cards (the origin selection, keeping their
 * green ring) and PERSISTENT cards (ghosts the reader promoted) — ringed by the Map's OWN ghost
 * SATELLITES: every code coupling that leaves the member set charts its off-overlay symbol as a
 * dashed `GhostNode` card banded outside the core (callers left, dependencies right), per-kind
 * wired. Like the Map, satellites are ON-DEMAND context: selecting a member reveals only that
 * member's off-view callers/dependencies. Each satellite wears a subtle round "+" that promotes its
 * home file/folder into the members and opens the path until the original symbol is visible. A
 * crowded sibling set folds under its persistent real parent; that parent's explicit chevron
 * discloses exact children as outward neighbours. The floating members panel removes a
 * member (it returns as a satellite iff still coupled), while the shared bottom action bar
 * rearranges, resets, and explicitly closes the extracted graph, returning to the active lens with
 * the selection kept. Wires are painted by the Map's OWN chain and keyed by its own `MapLegend`,
 * so the overlay's colour vocabulary is the Map's by construction. Highways here means SPOOLING
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

import { useMemo, useRef } from "react";
import { useBlueprint, useBlueprintActions } from "../state/StoreContext";
import { MapLegend } from "./MapLegend";
import { GraphSurface } from "./canvas/GraphSurface";
import { GhostPromoteRing } from "./canvas/GhostPromoteRing";
import { SEMANTIC_LAYER_FADE_MS } from "./canvas/MapLod";
import { adaptMinimalGraphToSemanticSource, type MinimalSourceGraphState } from "./canvas/minimalSemanticSource";
import { activeModuleSurfaceSpec, MINIMAL_OVERLAY_HIGHWAYS } from "./canvas/surfaceSpec";
import { useModuleNodeInteractions } from "./canvas/useModuleNodeInteractions";
import { useRecenter } from "./canvas/useRecenter";
import {
  SEMANTIC_READING_MIN_ZOOM,
  useSemanticSurfaceNavigation,
} from "./canvas/useSemanticSurfaceNavigation";
import { MinimalMembersPanel } from "./MinimalMembersPanel";
import { CanvasActionBar } from "./controlpanel/CanvasActionBar";
import { minimalMiniMapColor } from "./minimalGraphStyles";
import { filterExternalGhosts } from "./moduleMapPaint";

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
  const layoutStatus = useBlueprint((state) => state.minimalLayoutStatus);
  const layoutActivity = useBlueprint((state) => state.minimalLayoutActivity);
  const reviewSelectedId = useBlueprint((state) => state.reviewSelectedId);
  const reviewActive = useBlueprint((state) => state.review !== null);
  const reviewFlowOpen = useBlueprint((state) => state.flowSelection !== null && state.reviewFlowBaseline !== null);
  const index = useBlueprint((state) => state.index);
  const viewMode = useBlueprint((state) => state.viewMode);
  const moduleFocus = useBlueprint((state) => state.moduleFocus);
  const moduleEffectiveFocus = useBlueprint((state) => state.moduleEffectiveFocus);
  const serviceScope = useBlueprint((state) => state.serviceScope);
  const serviceGroupingMode = useBlueprint((state) => state.serviceGroupingMode);
  const serviceGroupingTargetSize = useBlueprint((state) => state.serviceGroupingTargetSize);
  const showExternalGhosts = useBlueprint((state) => state.showExternalGhosts);
  const { closeMinimalGraph, promoteGhost } = useBlueprintActions();
  const relations = activeModuleSurfaceSpec(viewMode).relations;

  // A review-panel click centers the viewport on the clicked node itself (recenterSeq bump); else
  // the selection is the recenter target, like every module surface.
  const recenterIds = useMemo(
    () => (reviewSelectedId !== null ? [reviewSelectedId] : [...selected]),
    [reviewSelectedId, selected],
  );
  useRecenter(recenterIds, RECENTER_OPTIONS);

  // Interactions ARE the Module map's own (the shared hook — called HERE so the debounce dies with
  // the overlay); a double-click closes the overlay first so the Map's navigate surfaces. No
  // `onBeforeClick`: every card, including exact/grouped ghosts, uses ordinary selection;
  // disclosure and promotion remain their explicit chevron / "+" controls.
  const interactions = useModuleNodeInteractions({
    onBeforeDoubleClick: () => {
      closeMinimalGraph();
    },
  });

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
  };
  const visibleGraph = useMemo(
    () => filterExternalGhosts(nodes, edges, showExternalGhosts),
    [edges, nodes, showExternalGhosts],
  );
  const semanticScene = useMemo(
    () => adaptMinimalGraphToSemanticSource(visibleGraph, sourceRef.current!),
    [visibleGraph],
  );
  const semanticNavigation = useSemanticSurfaceNavigation({
    nodes: semanticScene.nodes,
    layoutStatus,
    semanticLayers: semanticScene.semanticLayers,
    resetKeys: [nodes],
    commitAdapter: {
      mode: "exit",
      commit: () => {
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
        reviewEmphasis={reviewActive}
        emphasisMode={reviewFlowOpen ? (reviewSelectedId === null ? "subgraph" : "node") : undefined}
        groupGhosts={reviewFlowOpen && reviewSelectedId !== null ? false : undefined}
        busy={layoutStatus === "laying-out" ? layoutActivity ?? undefined : undefined}
        autoFitView={false}
        semanticLayers={semanticScene.semanticLayers}
        semanticDepths={semanticNavigation.semanticDepths}
        semanticBandOriginDepth={semanticNavigation.semanticBandOriginDepth}
        semanticFirstPreviewMax={semanticNavigation.semanticFirstPreviewMax}
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
        <CanvasActionBar onShowCodebase={onShowCodebase} codebaseButtonRef={codebaseButtonRef} />
        <MinimalMembersPanel />
      </GraphSurface>
    </div>
  );
}

const MINIMAL_SEMANTIC_SURFACE_STYLE: React.CSSProperties = {
  position: "absolute",
  inset: 0,
  transition: `opacity ${SEMANTIC_LAYER_FADE_MS}ms ease-out`,
};
