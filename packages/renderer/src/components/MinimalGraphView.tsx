/**
 * The minimal-graph OVERLAY: the Module-map's "Build minimal graph" result as its own read-only
 * React Flow surface, replacing the level canvas while open. It reuses the Module-map's OWN card
 * components (`moduleNodeTypes`) plus a directional [+n] stub, and grows in three tiers: SEED cards
 * (the picked files, keeping their green ring), the always-shown PERSISTENT 1-hop ring, and GHOST
 * cards revealed by clicking a stub. Drilling through a ghost commits it; "Reset" drops all growth
 * back to the seed base. A floating panel names the seed count, resets, and closes (Escape too —
 * closing returns to the level with the selection kept, so the reader can adjust and rebuild).
 *
 * Gestures on a file card: single-click selects it (drives the Map's own selection/green ring) — but
 * that plain click is DEBOUNCED (mirroring the Module map) so a double-click wins instead of the
 * first click repainting the graph out from under it. Clicking a directional [+n] stub expands ONE
 * direction (never debounced). Double-clicking a card NAVIGATES into the node exactly like the Module
 * map: it cancels the pending select, closes the overlay (which covers the Map), and focuses the Map
 * on that node (`setModuleFocus`) — no more double-click expansion.
 */

import { useEffect, useMemo, useRef } from "react";
import { ReactFlow, type Edge, type Node, type NodeMouseHandler, type ReactFlowInstance } from "@xyflow/react";
import { useBlueprint, useBlueprintActions } from "../state/StoreContext";
import { moduleNodeTypes } from "./nodes/modulemap/ModuleCardNode";
import { MinimalStubNode } from "./nodes/modulemap/MinimalStubNode";
import { emphasize } from "./moduleMapPaint";
import { CanvasChrome, READONLY_CANVAS_PROPS } from "./canvas/flowCanvasProps";
import { useClearOnEscape } from "./canvas/useClearOnEscape";
import { MINIMAL_STUB_NODE } from "../layout/minimalSubgraphLayout";
import type { MinimalStubData } from "../derive/minimalSubgraph";
import { minimalMiniMapColor, SURFACE_STYLE, PANEL_STYLE, buttonStyle } from "./minimalGraphStyles";

// The Map's own card components plus the overlay-only [+n] expander (a stable module-level reference).
const overlayNodeTypes = { ...moduleNodeTypes, [MINIMAL_STUB_NODE]: MinimalStubNode };

// A ghost-tier file dims to this at rest. Layered UNDER `emphasize`: an emphasize-dimmed ghost keeps
// the smaller dim (min wins), a LIT ghost still recedes to this opacity — the ghost read is preserved.
const GHOST_OPACITY = 0.62;

// The same click-debounce window the Module map uses: a plain single-click waits this long before it
// selects, so a double-click cancels it and expands instead of the first click repainting the graph.
const SELECT_CLICK_DELAY_MS = 250;

export function MinimalGraphView() {
  const nodes = useBlueprint((state) => state.minimalRfNodes);
  const edges = useBlueprint((state) => state.minimalRfEdges);
  const selected = useBlueprint((state) => state.moduleSelected);
  const radius = useBlueprint((state) => state.moduleRadius);
  const highlightMode = useBlueprint((state) => state.highlightMode);
  const seedCount = useBlueprint((state) => state.minimalSeedIds.length);
  const grown = useBlueprint((state) => state.minimalKeptIds.length > 0 || state.minimalExpanded.length > 0);
  const { closeMinimalGraph, expandMinimal, resetMinimalGraph, selectModule, toggleModuleSelect, setModuleFocus } = useBlueprintActions();
  const pendingSelectTimer = useRef<ReturnType<typeof window.setTimeout> | null>(null);
  const pendingSelectId = useRef<string | null>(null);

  useClearOnEscape(closeMinimalGraph, true);

  const clearPendingSelect = () => {
    if (pendingSelectTimer.current !== null) {
      window.clearTimeout(pendingSelectTimer.current);
    }
    pendingSelectTimer.current = null;
    pendingSelectId.current = null;
  };

  // Reuse the Module map's shared `emphasize` for edge + selection paint, but it only understands the
  // file-import graph — the [+n] stubs and their tethers must pass through untouched. So split those
  // out, run emphasize on files + import wires only, then re-append the stubs. The page's ghost dim is
  // layered UNDER emphasize's selection dim (min wins, so a lit ghost still recedes to GHOST_OPACITY).
  const { nodes: paintedNodes, edges: paintedEdges } = useMemo(() => {
    const fileNodes = nodes.filter((node) => node.type === "file");
    const stubNodes = nodes.filter((node) => node.type === MINIMAL_STUB_NODE);
    const importEdges = edges.filter((edge) => (edge.data as { category?: string } | undefined)?.category === "import");
    const stubEdges = edges.filter((edge) => (edge.data as { category?: string } | undefined)?.category !== "import");
    const emphasized = emphasize(fileNodes, importEdges, selected, radius, highlightMode);
    const ghostLayered = emphasized.nodes.map((node) => (isGhost(node) ? dimGhost(node) : node));
    return { nodes: [...ghostLayered, ...stubNodes], edges: [...emphasized.edges, ...stubEdges] };
  }, [nodes, edges, selected, radius, highlightMode]);

  // Clicking a [+n] stub reveals that node's hidden neighbours in that direction (and, when the stub
  // sits on a ghost, commits the ghost) — immediately, since stubs have no double-click meaning.
  // Clicking a file card drives the SAME store selection the Module map does, so the green ring lights
  // up here too: ctrl/cmd toggles immediately, but a plain click is DEBOUNCED (the Map's own idiom) so
  // a double-click cancels it — its emphasize repaint won't fire before the native double-click lands.
  const onNodeClick: NodeMouseHandler<Node> = (event, node) => {
    if (node.type === MINIMAL_STUB_NODE) {
      const stub = node.data as MinimalStubData;
      expandMinimal(stub.sourceId, stub.direction);
      return;
    }
    if (event.ctrlKey || event.metaKey) {
      clearPendingSelect();
      toggleModuleSelect(node.id);
      return;
    }
    clearPendingSelect();
    pendingSelectId.current = node.id;
    pendingSelectTimer.current = window.setTimeout(() => {
      selectModule(node.id);
      pendingSelectTimer.current = null;
      pendingSelectId.current = null;
    }, SELECT_CLICK_DELAY_MS);
  };

  // Double-clicking a file card NAVIGATES into it exactly like the Module map's double-click: it drills
  // the real Map onto that node via `setModuleFocus`. Since the overlay covers the Map, close it first
  // so the navigation surfaces, and cancel the pending single-click select so it doesn't also fire.
  // Stubs have no navigate meaning (their single-click already expands one direction), so ignore them.
  // READONLY_CANVAS_PROPS disables zoom-on-double-click, so this gesture never fights the canvas.
  const onNodeDoubleClick: NodeMouseHandler<Node> = (_event, node) => {
    if (node.type === MINIMAL_STUB_NODE) {
      return;
    }
    clearPendingSelect();
    closeMinimalGraph();
    setModuleFocus(node.id);
  };

  // Clear any pending single-click select on unmount so a queued timeout can't fire after teardown.
  useEffect(
    () => () => {
      if (pendingSelectTimer.current !== null) {
        window.clearTimeout(pendingSelectTimer.current);
      }
      pendingSelectTimer.current = null;
      pendingSelectId.current = null;
    },
    [],
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
        onPaneClick={() => selectModule(null)}
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

const isGhost = (node: Node): boolean => (node.data as { tier?: string } | undefined)?.tier === "ghost";

// Dim a ghost card, keeping whatever smaller opacity emphasize already applied (a dimmed non-neighbour
// stays dim; a lit ghost drops to GHOST_OPACITY so the ghost tier still reads).
function dimGhost(node: Node): Node {
  const existing = (node.style?.opacity as number | undefined) ?? 1;
  return { ...node, style: { ...node.style, opacity: Math.min(existing, GHOST_OPACITY) } };
}

// Top-RIGHT, because the Module map keeps its main Toolbar floating top-left over this overlay.
const MINIMAL_PANEL_STYLE: React.CSSProperties = { ...PANEL_STYLE, left: "auto", right: 16 };
const TITLE_STYLE: React.CSSProperties = { fontSize: 12, fontWeight: 700, color: "#E6EDF3" };
