/**
 * The minimal-graph OVERLAY: the Module-map's "Build minimal graph" result as its own read-only
 * React Flow surface, replacing the level canvas while open. It reuses the Module-map's OWN card
 * components (`moduleNodeTypes`) plus a directional [+n] stub, and grows in three tiers: SEED cards
 * (the picked files, keeping their green ring), the always-shown PERSISTENT 1-hop ring, and GHOST
 * cards revealed by clicking a stub. Drilling through a ghost commits it; "Reset" drops all growth
 * back to the seed base. A floating panel names the seed count, resets, and closes (Escape too —
 * closing returns to the level with the selection kept, so the reader can adjust and rebuild).
 * Wires are painted by the Map's OWN chain (`paintMinimal`) and keyed by the Map's OWN `MapLegend`,
 * so the overlay's colour vocabulary is the Map's by construction.
 *
 * Gestures ARE the Module map's own, via the shared `useModuleNodeInteractions` hook — so they're
 * identical to the Map by construction: single-click selects (DEBOUNCED, so a double-click wins),
 * ctrl/cmd toggles the selection, a pane-click clears it, and a double-click NAVIGATES into the node
 * exactly like the Map (the overlay just closes first, since it covers the Map, so the navigation
 * surfaces). The only page-specific gestures are the directional [+n] stub single-click (expand ONE
 * direction, never debounced) and Escape/Close (back to the level with the selection kept).
 */

import { useEffect, useMemo, useRef } from "react";
import { ReactFlow, type Edge, type Node, type ReactFlowInstance } from "@xyflow/react";
import { useBlueprint, useBlueprintActions } from "../state/StoreContext";
import { moduleNodeTypes } from "./nodes/modulemap/ModuleCardNode";
import { MinimalStubNode } from "./nodes/modulemap/MinimalStubNode";
import { paintMinimalLevel } from "./paintMinimal";
import { MapLegend } from "./MapLegend";
import { CanvasChrome, READONLY_CANVAS_PROPS } from "./canvas/flowCanvasProps";
import { useClearOnEscape } from "./canvas/useClearOnEscape";
import { useModuleNodeInteractions } from "./canvas/useModuleNodeInteractions";
import { MINIMAL_STUB_NODE } from "../layout/minimalSubgraphLayout";
import type { MinimalStubData } from "../derive/minimalSubgraph";
import { minimalMiniMapColor, SURFACE_STYLE, PANEL_STYLE, buttonStyle } from "./minimalGraphStyles";

// The Map's own card components plus the overlay-only [+n] expander (a stable module-level reference).
const overlayNodeTypes = { ...moduleNodeTypes, [MINIMAL_STUB_NODE]: MinimalStubNode };

export function MinimalGraphView() {
  const nodes = useBlueprint((state) => state.minimalRfNodes);
  const edges = useBlueprint((state) => state.minimalRfEdges);
  const selected = useBlueprint((state) => state.moduleSelected);
  const radius = useBlueprint((state) => state.moduleRadius);
  const highlightMode = useBlueprint((state) => state.highlightMode);
  const hiddenRelKinds = useBlueprint((state) => state.hiddenRelKinds);
  const seedCount = useBlueprint((state) => state.minimalSeedIds.length);
  const grown = useBlueprint((state) => state.minimalKeptIds.length > 0 || state.minimalExpanded.length > 0);
  const { closeMinimalGraph, expandMinimal, resetMinimalGraph } = useBlueprintActions();

  useClearOnEscape(closeMinimalGraph, true);

  // Interactions ARE the Module map's own (shared hook), so selection/toggle/navigate stay identical.
  // The overlay only injects its page-specific bits: the [+n] stub single-click expands one direction
  // (fully handled, skips select), and a double-click closes the overlay first so the Map's navigate
  // surfaces. Stubs have no navigate meaning, so their double-click is fully handled (a no-op).
  const { onNodeClick, onNodeDoubleClick, onPaneClick } = useModuleNodeInteractions({
    onBeforeClick: (_event, node) => {
      if (node.type === MINIMAL_STUB_NODE) {
        const stub = node.data as MinimalStubData;
        expandMinimal(stub.sourceId, stub.direction);
        return true;
      }
      return false;
    },
    onBeforeDoubleClick: (_event, node) => {
      if (node.type === MINIMAL_STUB_NODE) {
        return true;
      }
      closeMinimalGraph();
      return false;
    },
  });

  // The Map's OWN paint chain (suppress redundant imports → relationship-kind filter → emphasize →
  // ghost-tier dim), extracted pure into `paintMinimal` so the overlay's colour parity with the Map
  // is unit-tested. The Map's Relationships pills float over this overlay, so they filter it too.
  // Only the baked [+n] stub tethers stay out of the paint.
  const { nodes: paintedNodes, edges: paintedEdges } = useMemo(
    () => paintMinimalLevel(nodes, edges, selected, radius, highlightMode, hiddenRelKinds),
    [nodes, edges, selected, radius, highlightMode, hiddenRelKinds],
  );

  // Fit once per LAYOUT (build / expand / reset) — the same guard idiom as the sibling surfaces.
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
        onNodeClick={onNodeClick}
        onNodeDoubleClick={onNodeDoubleClick}
        onPaneClick={onPaneClick}
        onInit={(instance) => {
          rfRef.current = instance;
        }}
        {...READONLY_CANVAS_PROPS}
      >
        <CanvasChrome nodeColor={minimalMiniMapColor} />
      </ReactFlow>
      {/* The Map's own legend, in the Map's own corner (bottom-left, clear of the zoom controls) —
          the overlay shares the Map's colour vocabulary, so it shares the Map's key to it. The
          overlay can never draw package/directory cards or IPC wires (it mints only file/stub cards
          and import/dep wires), so those two rows opt out — the legend never advertises a glyph
          this surface cannot show. */}
      <MapLegend hasSteps={nodes.some((node) => node.type === "step")} hasSelection={selected.size > 0} showPackages={false} showIpc={false} />
      <div style={MINIMAL_PANEL_STYLE}>
        <span style={TITLE_STYLE}>
          Minimal graph — {seedCount} seed {seedCount === 1 ? "file" : "files"}
        </span>
        <button type="button" style={buttonStyle(false, !grown)} onClick={resetMinimalGraph} disabled={!grown} title="Drop all expansions, back to the seed base">
          Reset
        </button>
        <button type="button" style={buttonStyle(false, false)} onClick={closeMinimalGraph} title="Back to the Module map (Esc)">
          ✕ Close
        </button>
      </div>
    </div>
  );
}

// Top-RIGHT, because the Module map keeps its main Toolbar floating top-left over this overlay.
const MINIMAL_PANEL_STYLE: React.CSSProperties = { ...PANEL_STYLE, left: "auto", right: 16 };
const TITLE_STYLE: React.CSSProperties = { fontSize: 12, fontWeight: 700, color: "#E6EDF3" };
