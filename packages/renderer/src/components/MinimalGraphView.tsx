/**
 * The minimal-graph OVERLAY: the Module-map's "Extract selection" result as its own read-only React
 * Flow surface, replacing the level canvas while open. It EXTRACTS the selection verbatim (any kind —
 * a selected package stays ONE card) as MEMBERS, in three tiers: SEED cards (the origin selection,
 * keeping their green ring), PERSISTENT cards (ghosts the reader promoted), and dimmed GHOST cards (the
 * members' on-map 1-hop import ring). Each ghost wears a subtle round "+" that promotes it into the
 * members; the floating members panel removes a member back to a ghost; "Reset" restores the working
 * set (and the map-mirror layout) to the origin; "Re-arrange" lays the current cards out compactly,
 * ignoring their (possibly far-apart) map spots. A floating panel names the state and closes (Escape
 * too — closing returns to the level with the selection kept, so the reader can adjust and rebuild).
 * Wires are painted by the Map's OWN chain (`paintMinimal`) and keyed by the Map's OWN `MapLegend`,
 * so the overlay's colour vocabulary is the Map's by construction.
 *
 * Gestures ARE the Module map's own, via the shared `useModuleNodeInteractions` hook — so they're
 * identical to the Map by construction: single-click selects (DEBOUNCED, so a double-click wins),
 * ctrl/cmd toggles the selection, a pane-click clears it, and a double-click NAVIGATES into the node
 * exactly like the Map (the overlay just closes first, since it covers the Map, so the navigation
 * surfaces). A plain click NEVER promotes a ghost — promotion is the explicit "+" button, so curation
 * is deliberate. The only page-specific gestures are that "+" (promote) and Escape/Close.
 */

import { useEffect, useMemo, useRef } from "react";
import { ReactFlow, ViewportPortal, type Edge, type EdgeTypes, type Node, type ReactFlowInstance } from "@xyflow/react";
import { useBlueprint, useBlueprintActions } from "../state/StoreContext";
import { moduleNodeTypes } from "./nodes/modulemap/ModuleCardNode";
import { paintMinimalLevel } from "./paintMinimal";
import { MapLegend } from "./MapLegend";
import { CanvasChrome, READONLY_CANVAS_PROPS } from "./canvas/flowCanvasProps";
import { useClearOnEscape } from "./canvas/useClearOnEscape";
import { useModuleNodeInteractions } from "./canvas/useModuleNodeInteractions";
import { MinimalMembersPanel } from "./MinimalMembersPanel";
import { spoolFanEdges, SPOOL_EDGE_TYPE } from "../layout/edgeSpooling";
import { SpoolEdge } from "./edges/SpoolEdge";
import { minimalMiniMapColor, SURFACE_STYLE, PANEL_STYLE, buttonStyle } from "./minimalGraphStyles";

// The Map's own card components (files + package cards), reused as-is (a stable module-level reference).
const overlayNodeTypes = moduleNodeTypes;

/** Fan hubs gather their wires into trunks (the Highways treatment for this overlay's flat graph). */
const overlayEdgeTypes: EdgeTypes = { [SPOOL_EDGE_TYPE]: SpoolEdge };

export function MinimalGraphView() {
  const nodes = useBlueprint((state) => state.minimalRfNodes);
  const edges = useBlueprint((state) => state.minimalRfEdges);
  const selected = useBlueprint((state) => state.moduleSelected);
  const radius = useBlueprint((state) => state.moduleRadius);
  const highlightMode = useBlueprint((state) => state.highlightMode);
  const hiddenRelKinds = useBlueprint((state) => state.hiddenRelKinds);
  // "Grown" (Reset enabled) once the working set diverges from the origin OR the layout was re-arranged
  // — Reset restores both, so it must light up for either.
  const grown = useBlueprint((state) => !sameMembers(state.minimalMemberIds, state.minimalSeedIds) || state.minimalArrange);
  const showHighways = useBlueprint((state) => state.showHighways);
  const { closeMinimalGraph, promoteMinimalGhost, resetMinimalGraph, rearrangeMinimalGraph } = useBlueprintActions();

  useClearOnEscape(closeMinimalGraph, true);

  // Interactions ARE the Module map's own (shared hook), so selection/toggle/navigate stay identical.
  // A double-click closes the overlay first so the Map's navigate surfaces. No `onBeforeClick`: a plain
  // click never promotes a ghost — that's the explicit "+" button below, so curation is deliberate.
  const { onNodeClick, onNodeDoubleClick, onPaneClick } = useModuleNodeInteractions({
    onBeforeDoubleClick: () => {
      closeMinimalGraph();
      return false;
    },
  });

  // Each ghost carries an explicit "+" add affordance, drawn in CANVAS coordinates (via ViewportPortal)
  // so it scales with zoom exactly like the node it sits on. Read from the raw (pre-paint) nodes — the
  // paint only tweaks style/opacity, so positions and the `tier` the ghost read depends on are intact.
  const ghostRects = useMemo(() => nodes.filter(isGhost).map(ghostRect), [nodes]);

  // The Map's OWN paint chain (suppress redundant imports → relationship-kind filter → emphasize →
  // ghost-tier dim), extracted pure into `paintMinimal` so the overlay's colour parity with the Map
  // is unit-tested. The Map's Relationships pills float over this overlay, so they filter it too.
  // Highways here means SPOOLING: fan hubs gather their many wires into shared trunks (no containers
  // to pair-bundle in this flat overlay). Every overlay wire is a painted import/dep wire — ghosts hang
  // on real wires, not tethers — so when Highways is on they ALL spool.
  const { nodes: paintedNodes, edges: paintedEdges } = useMemo(() => {
    const painted = paintMinimalLevel(nodes, edges, selected, radius, highlightMode, hiddenRelKinds);
    return showHighways ? { nodes: painted.nodes, edges: spoolFanEdges(painted.edges) } : painted;
  }, [nodes, edges, selected, radius, highlightMode, hiddenRelKinds, showHighways]);

  // Fit once per LAYOUT (build / promote / demote / reset / re-arrange) — the same guard idiom as the
  // sibling surfaces.
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
    <div style={SURFACE_STYLE}>
      <ReactFlow<Node, Edge>
        nodes={paintedNodes}
        edges={paintedEdges}
        nodeTypes={overlayNodeTypes}
        edgeTypes={overlayEdgeTypes}
        onNodeClick={onNodeClick}
        onNodeDoubleClick={onNodeDoubleClick}
        onPaneClick={onPaneClick}
        onInit={(instance) => {
          rfRef.current = instance;
        }}
        {...READONLY_CANVAS_PROPS}
      >
        <CanvasChrome nodeColor={minimalMiniMapColor} />
        <ViewportPortal>
          {ghostRects.map((rect) => (
            <div key={rect.id} style={ghostAddWrap(rect)}>
              <button type="button" style={ADD_GHOST_STYLE} onClick={() => promoteMinimalGhost(rect.id)} title="Add to the graph" aria-label="Add to the graph">
                +
              </button>
            </div>
          ))}
        </ViewportPortal>
      </ReactFlow>
      {/* The Map's own legend, in the Map's own corner (bottom-left, clear of the zoom controls) — the
          overlay shares the Map's colour vocabulary, so it shares the Map's key to it. The package row
          shows only when a group member/ghost card is actually present; IPC opts out always — the
          overlay mints only file/package cards and import/dep wires, never IPC. */}
      <MapLegend
        hasSteps={nodes.some((node) => node.type === "step")}
        hasSelection={selected.size > 0}
        showPackages={nodes.some((node) => node.type === "package")}
        showIpc={false}
      />
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
    </div>
  );
}

const isGhost = (node: Node): boolean => (node.data as { tier?: string } | undefined)?.tier === "ghost";

// The "+" add button's size in FLOW units — so ViewportPortal scales it with the node at every zoom.
const ADD_SIZE = 20;
type GhostCorner = { id: string; x: number; y: number };

// A ghost's top-right corner in absolute flow coords (overlay cards are flat, so position IS absolute).
function ghostRect(node: Node): GhostCorner {
  const width = ((node.style ?? {}) as { width?: number }).width ?? 0;
  return { id: node.id, x: node.position.x + width, y: node.position.y };
}

// Centre the "+" on that corner (half in / half out). left/top:0 + translate is the ViewportPortal idiom;
// it applies the canvas zoom/pan transform, so a flow-unit-sized child scales with the graph.
function ghostAddWrap(corner: GhostCorner): React.CSSProperties {
  return { position: "absolute", left: 0, top: 0, transform: `translate(${corner.x - ADD_SIZE / 2}px, ${corner.y - ADD_SIZE / 2}px)`, pointerEvents: "all" };
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

// The subtle "add this ghost" affordance: a small round + straddling the ghost card's top-right corner
// (half in, half out), not a loud button. Neutral until hovered so it stays quiet among many ghosts.
const ADD_GHOST_STYLE: React.CSSProperties = {
  width: 20,
  height: 20,
  borderRadius: "50%",
  display: "grid",
  placeItems: "center",
  border: "1px solid #3A4452",
  background: "#1B222C",
  color: "#AEB8C4",
  fontSize: 15,
  fontWeight: 700,
  lineHeight: 1,
  cursor: "pointer",
  boxShadow: "0 1px 3px rgba(0,0,0,0.45)",
};
