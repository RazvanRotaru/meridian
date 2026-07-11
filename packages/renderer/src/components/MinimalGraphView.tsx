/**
 * The minimal-graph OVERLAY — a THIN MOUNT of the shared GraphSurface with spool-only highways
 * (`MINIMAL_OVERLAY_HIGHWAYS`): the Module-map's "Extract selection" result as its own read-only React Flow
 * surface, replacing the level canvas while open. It EXTRACTS the selection verbatim (any kind — a
 * selected package stays ONE card) as MEMBERS — SEED cards (the origin selection, keeping their
 * green ring) and PERSISTENT cards (ghosts the reader promoted) — ringed by the Map's OWN ghost
 * SATELLITES: every code coupling that leaves the member set charts its off-overlay symbol as a
 * dashed `GhostNode` card banded outside the core (callers left, dependencies right), per-kind
 * wired. Like the Map, satellites are ON-DEMAND context: selecting a member reveals only that
 * member's off-view callers/dependencies. Each satellite wears a subtle round "+" that promotes its
 * home file/folder into the members and opens the path until the original symbol is visible. The
 * floating members panel removes a member (it returns as a satellite iff still coupled); "Reset"
 * restores the working set
 * (and the map-mirror layout) to the origin; "Re-arrange" lays the members out compactly, ignoring
 * their (possibly far-apart) map spots. A floating panel names the state and closes (Escape too —
 * closing returns to the level with the selection kept). Wires are painted by the Map's OWN chain
 * (GraphSurface's, pinned by `paintMinimal`'s parity tests) and keyed by the Map's OWN `MapLegend`,
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
 * click NEVER promotes a ghost — promotion is the explicit "+" button, so curation is deliberate.
 * The only page-specific gestures are that "+" (promote) and Escape/Close.
 */

import { useEffect, useMemo, useRef } from "react";
import type { Edge, Node, ReactFlowInstance } from "@xyflow/react";
import { useBlueprint, useBlueprintActions } from "../state/StoreContext";
import { MapLegend } from "./MapLegend";
import { useClearOnEscape } from "./canvas/useClearOnEscape";
import { GraphSurface } from "./canvas/GraphSurface";
import { GhostPromoteRing } from "./canvas/GhostPromoteRing";
import { MINIMAL_OVERLAY_HIGHWAYS } from "./canvas/surfaceSpec";
import { useModuleNodeInteractions } from "./canvas/useModuleNodeInteractions";
import { useRecenter } from "./canvas/useRecenter";
import { MinimalMembersPanel } from "./MinimalMembersPanel";
import { CanvasActionBar } from "./controlpanel/CanvasActionBar";
import { minimalMiniMapColor, PANEL_STYLE, buttonStyle } from "./minimalGraphStyles";

// A review-panel click centers on a single (possibly tiny) method card, so cap how far the fit zooms in.
const RECENTER_OPTIONS = { maxZoom: 1 } as const;

export function MinimalGraphView() {
  const nodes = useBlueprint((state) => state.minimalRfNodes);
  const edges = useBlueprint((state) => state.minimalRfEdges);
  const selected = useBlueprint((state) => state.moduleSelected);
  // "Grown" (Reset enabled) once the working set diverges from the origin OR the layout was re-arranged
  // — Reset restores both, so it must light up for either.
  const grown = useBlueprint((state) => !sameMembers(state.minimalMemberIds, state.minimalSeedIds) || state.minimalArrange);
  const reviewSelectedId = useBlueprint((state) => state.reviewSelectedId);
  const reviewActive = useBlueprint((state) => state.review !== null);
  const { closeMinimalGraph, promoteGhost, resetMinimalGraph, rearrangeMinimalGraph } = useBlueprintActions();

  // A review-panel click centers the viewport on the clicked node itself (recenterSeq bump); else
  // the selection is the recenter target, like every module surface.
  const recenterIds = useMemo(
    () => (reviewSelectedId !== null ? [reviewSelectedId] : [...selected]),
    [reviewSelectedId, selected],
  );
  useRecenter(recenterIds, RECENTER_OPTIONS);

  // Interactions ARE the Module map's own (the shared hook — called HERE so the debounce dies with
  // the overlay); a double-click closes the overlay first so the Map's navigate surfaces. No
  // `onBeforeClick`: a plain click never promotes a ghost — that's the explicit "+" button, so
  // curation is deliberate.
  const interactions = useModuleNodeInteractions({
    onBeforeDoubleClick: () => {
      closeMinimalGraph();
      return false;
    },
  });

  useClearOnEscape(closeMinimalGraph, true);

  // Fit once per LAYOUT (build / promote / demote / reset / re-arrange) — unlike the Map's
  // per-LEVEL guard, so it stays in this mount rather than the shared surface.
  const rfRef = useRef<ReactFlowInstance<Node, Edge> | null>(null);
  const laidRef = useRef<Node[] | null>(null);
  useEffect(() => {
    const rf = rfRef.current;
    if (!rf || nodes.length === 0 || laidRef.current === nodes) {
      return;
    }
    laidRef.current = nodes;
    requestAnimationFrame(() => rf.fitView({ padding: 0.2, duration: 400, minZoom: 0.01 }));
  }, [nodes]);

  return (
    <GraphSurface
      nodes={nodes}
      edges={edges}
      highways={MINIMAL_OVERLAY_HIGHWAYS}
      miniMapColor={minimalMiniMapColor}
      interactions={interactions}
      nodeDiffPreview={reviewActive}
      onInit={(instance) => {
        rfRef.current = instance;
      }}
      flowExtras={(view) => <GhostPromoteRing nodes={view.nodes} title="Add to the graph" onPromote={promoteGhost} />}
    >
      {/* The Map's own legend, in the Map's own corner (bottom-left, clear of the zoom controls) — the
          overlay shares the Map's colour vocabulary, so it shares the Map's key to it. The package row
          shows only when a group member/ghost card is actually present; IPC opts out always — the
          overlay mints only file/package cards and import/dep wires, never IPC. */}
      <MapLegend
        hasSteps={nodes.some((node) => node.type === "step")}
        showPackages={nodes.some((node) => node.type === "package")}
        showIpc={false}
      />
      <CanvasActionBar />
      <div style={MINIMAL_PANEL_STYLE}>
        <span style={TITLE_STYLE}>Extracted selection</span>
        <button type="button" style={buttonStyle(false, false)} onClick={rearrangeMinimalGraph} title="Lay the current nodes out compactly, ignoring their map positions">
          Re-arrange
        </button>
        <button type="button" style={buttonStyle(false, !grown)} onClick={resetMinimalGraph} disabled={!grown} title="Restore the working set to the original selection">
          Reset
        </button>
        <button type="button" style={buttonStyle(false, false)} onClick={closeMinimalGraph} title="Back to the Module map (Esc)">
          ✕ Close
        </button>
      </div>
      <MinimalMembersPanel />
    </GraphSurface>
  );
}

// Order-independent equality of two id lists — the "grown" check compares members against the origin.
function sameMembers(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  const set = new Set(a);
  return b.every((id) => set.has(id));
}

// Top-RIGHT, because the Module map keeps its main Toolbar floating top-left over this overlay.
const MINIMAL_PANEL_STYLE: React.CSSProperties = { ...PANEL_STYLE, left: "auto", right: 16 };
const TITLE_STYLE: React.CSSProperties = { fontSize: 12, fontWeight: 700, color: "#E6EDF3" };
