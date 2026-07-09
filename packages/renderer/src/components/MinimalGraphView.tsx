/**
 * The minimal-graph OVERLAY: the Module-map's "Build minimal graph" result as its own read-only
 * React Flow surface, replacing the level canvas while open. It is the SAME Map surface — the Map's
 * own cards (`moduleNodeTypes`), the shared paint pipeline (`useModuleSurfacePaint`), the shared
 * interaction hook, the same ELK — differing ONLY in its root container: the picked seed files (plus
 * any file revealed by drilling a ghost) instead of a folder frontier. So it shows off-level code
 * GHOSTS and expandable file chevrons exactly like the Map, with no bespoke stubs or rings.
 *
 * Gestures ARE the Module map's own via `useModuleNodeInteractions`, so selection/emphasis stay
 * identical by construction. The overlay only redirects double-click, which on the Map would navigate
 * away: a GHOST reveals its owning file IN PLACE (grows the root container), a package/file card
 * expands in place, everything else falls through to the Map's handling (a callable block still opens
 * its logic flow). Escape / Close returns to the level with the selection kept, so the reader can
 * adjust and rebuild.
 */

import { useEffect, useRef } from "react";
import { ReactFlow, type Edge, type Node, type ReactFlowInstance } from "@xyflow/react";
import { useBlueprint, useBlueprintActions } from "../state/StoreContext";
import { moduleNodeTypes } from "./nodes/modulemap/ModuleCardNode";
import { miniMapColor } from "./ModuleMapView";
import { CanvasChrome, READONLY_CANVAS_PROPS } from "./canvas/flowCanvasProps";
import { useClearOnEscape } from "./canvas/useClearOnEscape";
import { useModuleNodeInteractions } from "./canvas/useModuleNodeInteractions";
import { useModuleSurfacePaint } from "./canvas/useModuleSurfacePaint";
import { BeaconArrows } from "./BeaconArrows";
import { SURFACE_STYLE, PANEL_STYLE, buttonStyle } from "./minimalGraphStyles";

const PACKAGE_KIND = "package";
const FILE_KIND = "file";

export function MinimalGraphView() {
  const nodes = useBlueprint((state) => state.minimalRfNodes);
  const edges = useBlueprint((state) => state.minimalRfEdges);
  const seedCount = useBlueprint((state) => state.minimalSeedIds.length);
  const grown = useBlueprint((state) => state.minimalRevealedIds.length > 0);
  const { closeMinimalGraph, revealMinimalNode, resetMinimalGraph, toggleModuleExpand } = useBlueprintActions();

  useClearOnEscape(closeMinimalGraph, true);

  const { nodes: paintedNodes, edges: paintedEdges, beacons } = useModuleSurfacePaint(nodes, edges);

  // Interactions ARE the Module map's own, so selection/toggle stay identical. Only double-click is
  // redirected: on the Map a ghost/file would navigate the level away, which the overlay covers — so
  // a ghost reveals its file in place, a package/file expands in place, and anything else (a callable
  // block → logic flow) falls through to the shared handler.
  const { onNodeClick, onNodeDoubleClick, onPaneClick } = useModuleNodeInteractions({
    onBeforeDoubleClick: (_event, node) => {
      if (node.type === "ghost") {
        revealMinimalNode(node.id);
        return true;
      }
      if (node.type === PACKAGE_KIND || node.type === FILE_KIND) {
        toggleModuleExpand(node.id);
        return true;
      }
      return false;
    },
  });

  // Fit once per LAYOUT (build / reveal / reset / expand) — the same guard idiom as the sibling surfaces.
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
        nodeTypes={moduleNodeTypes}
        onNodeClick={onNodeClick}
        onNodeDoubleClick={onNodeDoubleClick}
        onPaneClick={onPaneClick}
        onInit={(instance) => {
          rfRef.current = instance;
        }}
        {...READONLY_CANVAS_PROPS}
      >
        <CanvasChrome nodeColor={miniMapColor} />
        <BeaconArrows targets={beacons} />
      </ReactFlow>
      <div style={MINIMAL_PANEL_STYLE}>
        <span style={TITLE_STYLE}>
          Minimal graph — {seedCount} seed {seedCount === 1 ? "file" : "files"}
        </span>
        <button type="button" style={buttonStyle(false, !grown)} onClick={resetMinimalGraph} disabled={!grown} title="Drop all revealed files, back to the seed base">
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
