/**
 * The minimal-graph OVERLAY: the Module-map's "Build minimal graph" result as its own read-only
 * React Flow surface, replacing the level canvas while open. It reuses the PR-review pane's node
 * components and nested-ELK layout but carries no diff semantics — seed cards render plain, their
 * faded 1-hop import boundary as "ctx". A floating panel names the seed count, toggles the boundary,
 * and closes the overlay (Escape works too — closing returns to the level with the selection kept,
 * so the reader can adjust the set and rebuild).
 */

import { useEffect, useRef } from "react";
import { ReactFlow, type Edge, type Node, type ReactFlowInstance } from "@xyflow/react";
import { useBlueprint, useBlueprintActions } from "../state/StoreContext";
import { reviewNodeTypes } from "./nodes/prreview/ReviewNodeTypes";
import { CanvasChrome, READONLY_CANVAS_PROPS } from "./canvas/flowCanvasProps";
import { useClearOnEscape } from "./canvas/useClearOnEscape";
import { reviewMiniMapColor, SURFACE_STYLE, PANEL_STYLE, toggleStyle } from "./minimalGraphStyles";

export function MinimalGraphView() {
  const nodes = useBlueprint((state) => state.minimalRfNodes);
  const edges = useBlueprint((state) => state.minimalRfEdges);
  const seedCount = useBlueprint((state) => state.minimalSeedIds.length);
  const hideBoundary = useBlueprint((state) => state.minimalHideBoundary);
  const { closeMinimalGraph, toggleMinimalHideBoundary } = useBlueprintActions();

  useClearOnEscape(closeMinimalGraph, true);

  // Fit once per LAYOUT (build / boundary toggle) — the same guard idiom as the sibling surfaces.
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
        nodes={nodes}
        edges={edges}
        nodeTypes={reviewNodeTypes}
        onInit={(instance) => {
          rfRef.current = instance;
        }}
        {...READONLY_CANVAS_PROPS}
      >
        <CanvasChrome nodeColor={reviewMiniMapColor} />
      </ReactFlow>
      <div style={MINIMAL_PANEL_STYLE}>
        <span style={TITLE_STYLE}>
          Minimal graph — {seedCount} seed {seedCount === 1 ? "file" : "files"}
        </span>
        <button type="button" style={toggleStyle(hideBoundary)} aria-pressed={hideBoundary} onClick={toggleMinimalHideBoundary}>
          Hide boundary
        </button>
        <button type="button" style={CLOSE_STYLE} onClick={closeMinimalGraph} title="Back to the Module map (Esc)">
          ✕ Close
        </button>
      </div>
    </div>
  );
}

// Top-RIGHT, because the Module map keeps its main Toolbar floating top-left over this overlay —
// the PR-review pane's top-left panel spot would sit underneath it.
const MINIMAL_PANEL_STYLE: React.CSSProperties = { ...PANEL_STYLE, left: "auto", right: 16 };
const TITLE_STYLE: React.CSSProperties = { fontSize: 12, fontWeight: 700, color: "#E6EDF3" };
const CLOSE_STYLE: React.CSSProperties = {
  background: "transparent",
  border: "1px solid #2A2F37",
  borderRadius: 6,
  padding: "4px 10px",
  cursor: "pointer",
  font: "inherit",
  fontSize: 12,
  fontWeight: 600,
  color: "#9AA4B2",
};
