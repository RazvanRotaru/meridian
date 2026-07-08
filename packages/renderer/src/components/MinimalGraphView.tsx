/**
 * The minimal-graph OVERLAY: the Module-map's "Build minimal graph" result as its own read-only
 * React Flow surface, replacing the level canvas while open. It reuses the Module-map's OWN card
 * components (`moduleNodeTypes`) plus a directional [+n] stub, and grows in three tiers: SEED cards
 * (the picked files, keeping their green ring), the always-shown PERSISTENT 1-hop ring, and GHOST
 * cards revealed by clicking a stub. Drilling through a ghost commits it; "Reset" drops all growth
 * back to the seed base. A floating panel names the seed count, resets, and closes (Escape too —
 * closing returns to the level with the selection kept, so the reader can adjust and rebuild).
 */

import { useEffect, useRef } from "react";
import { ReactFlow, type Edge, type Node, type NodeMouseHandler, type ReactFlowInstance } from "@xyflow/react";
import { useBlueprint, useBlueprintActions } from "../state/StoreContext";
import { moduleNodeTypes } from "./nodes/modulemap/ModuleCardNode";
import { MinimalStubNode } from "./nodes/modulemap/MinimalStubNode";
import { CanvasChrome, READONLY_CANVAS_PROPS } from "./canvas/flowCanvasProps";
import { useClearOnEscape } from "./canvas/useClearOnEscape";
import { MINIMAL_STUB_NODE } from "../layout/minimalSubgraphLayout";
import type { MinimalStubData } from "../derive/minimalSubgraph";
import { minimalMiniMapColor, SURFACE_STYLE, PANEL_STYLE, buttonStyle } from "./minimalGraphStyles";

// The Map's own card components plus the overlay-only [+n] expander (a stable module-level reference).
const overlayNodeTypes = { ...moduleNodeTypes, [MINIMAL_STUB_NODE]: MinimalStubNode };

export function MinimalGraphView() {
  const nodes = useBlueprint((state) => state.minimalRfNodes);
  const edges = useBlueprint((state) => state.minimalRfEdges);
  const seedCount = useBlueprint((state) => state.minimalSeedIds.length);
  const grown = useBlueprint((state) => state.minimalKeptIds.length > 0 || state.minimalExpanded.length > 0);
  const { closeMinimalGraph, expandMinimal, resetMinimalGraph } = useBlueprintActions();

  useClearOnEscape(closeMinimalGraph, true);

  // Clicking a [+n] stub reveals that node's hidden neighbours in that direction (and, when the stub
  // sits on a ghost, commits the ghost). Every other node is inert on this read-only surface.
  const onNodeClick: NodeMouseHandler<Node> = (_event, node) => {
    if (node.type === MINIMAL_STUB_NODE) {
      const stub = node.data as MinimalStubData;
      expandMinimal(stub.sourceId, stub.direction);
    }
  };

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
        nodes={nodes}
        edges={edges}
        nodeTypes={overlayNodeTypes}
        onNodeClick={onNodeClick}
        onInit={(instance) => {
          rfRef.current = instance;
        }}
        {...READONLY_CANVAS_PROPS}
      >
        <CanvasChrome nodeColor={minimalMiniMapColor} />
      </ReactFlow>
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
