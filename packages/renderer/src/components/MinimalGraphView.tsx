/**
 * The minimal-graph OVERLAY: the Module-map's "Extract selection" result as its own React Flow surface,
 * replacing the level canvas while open. It EXTRACTS the selection verbatim (any kind — a selected
 * package stays ONE card) as MEMBERS, in three tiers: SEED cards (the origin selection, keeping their
 * green ring), PERSISTENT cards (ghosts the reader promoted), and dimmed GHOST cards (the members' on-map
 * 1-hop import ring). Clicking a ghost promotes it; the members panel removes a member back to a ghost;
 * "Reset" restores the working set to the origin. A floating panel names the state and closes (Escape
 * too — closing returns to the level with the selection kept, so the reader can adjust and rebuild).
 *
 * Gestures ARE the Module map's own, via the shared `useModuleNodeInteractions` hook — so they're
 * identical to the Map by construction: single-click selects (DEBOUNCED, so a double-click wins),
 * ctrl/cmd toggles the selection, a pane-click clears it, and a double-click NAVIGATES into the node
 * exactly like the Map (the overlay just closes first, since it covers the Map, so the navigation
 * surfaces). The only page-specific gestures are the GHOST single-click (promote it into the members)
 * and Escape/Close (back to the level with the selection kept).
 */

import { useEffect, useMemo, useRef } from "react";
import { ReactFlow, type Edge, type Node, type ReactFlowInstance } from "@xyflow/react";
import { useBlueprint, useBlueprintActions } from "../state/StoreContext";
import { moduleNodeTypes } from "./nodes/modulemap/ModuleCardNode";
import { emphasize } from "./moduleMapPaint";
import { CanvasChrome, READONLY_CANVAS_PROPS } from "./canvas/flowCanvasProps";
import { useClearOnEscape } from "./canvas/useClearOnEscape";
import { useModuleNodeInteractions } from "./canvas/useModuleNodeInteractions";
import { MinimalMembersPanel } from "./MinimalMembersPanel";
import { minimalMiniMapColor, SURFACE_STYLE, PANEL_STYLE, buttonStyle } from "./minimalGraphStyles";

// The Map's own card components (files + package cards), reused as-is (a stable module-level reference).
const overlayNodeTypes = moduleNodeTypes;

// The card types the Map's `emphasize` understands (the import graph); everything else passes through.
const MAP_CARD_TYPES: ReadonlySet<string> = new Set(["file", "package"]);
// The nested-declaration node types an expanded file frame holds (drawn by the Map's own components).
const CHILD_NODE_TYPES: ReadonlySet<string> = new Set(["unit", "block", "step"]);

// A ghost-tier file dims to this at rest. Layered UNDER `emphasize`: an emphasize-dimmed ghost keeps
// the smaller dim (min wins), a LIT ghost still recedes to this opacity — the ghost read is preserved.
const GHOST_OPACITY = 0.62;

/**
 * Reuse the overlay to frame a DIFFERENT graph full-screen (the PR diff). When `override` is passed
 * the surface renders those nodes/edges, the panel names `title` (e.g. the current PR) with a single
 * Close, and Escape/Close route to `onClose` — the Module-map store path is bypassed and its
 * click/navigate/expand gestures are detached (a read-only diff view). Absent, everything below is the
 * Module map's own store-driven overlay, unchanged.
 */
export interface MinimalGraphOverride {
  nodes: Node[];
  edges: Edge[];
  title: string;
  onClose: () => void;
}

export function MinimalGraphView({ override }: { override?: MinimalGraphOverride } = {}) {
  const storeNodes = useBlueprint((state) => state.minimalRfNodes);
  const storeEdges = useBlueprint((state) => state.minimalRfEdges);
  const selected = useBlueprint((state) => state.moduleSelected);
  const radius = useBlueprint((state) => state.moduleRadius);
  const highlightMode = useBlueprint((state) => state.highlightMode);
  const grown = useBlueprint((state) => !sameIds(state.minimalMemberIds, state.minimalSeedIds));
  const { closeMinimalGraph, promoteMinimalGhost, resetMinimalGraph } = useBlueprintActions();

  // In override (PR) mode the diff owns the graph, title, and close; the Module map's store fields
  // are read (hook order stays stable) but do not drive the surface.
  const nodes = override?.nodes ?? storeNodes;
  const edges = override?.edges ?? storeEdges;
  const interactive = override === undefined;
  const close = override?.onClose ?? closeMinimalGraph;

  useClearOnEscape(close, true);

  // Interactions ARE the Module map's own (shared hook), so selection/toggle/navigate stay identical.
  // The overlay only injects its page-specific bits: a GHOST single-click promotes it into the members
  // (fully handled, skips select), and a double-click closes the overlay first so the Map's navigate
  // surfaces. A ghost double-click is suppressed (return true) so curating never navigates away.
  const { onNodeClick, onNodeDoubleClick, onPaneClick } = useModuleNodeInteractions({
    onBeforeClick: (_event, node) => {
      if (isGhost(node)) {
        promoteMinimalGhost(node.id);
        return true;
      }
      return false;
    },
    onBeforeDoubleClick: (_event, node) => {
      if (isGhost(node)) {
        return true;
      }
      closeMinimalGraph();
      return false;
    },
  });

  // Reuse the Module map's shared `emphasize` for edge + selection paint. It understands the file/
  // package import graph, so run it over the map cards + import wires; an expanded file's nested
  // declarations pass through untouched (after their parent frames). The page's ghost dim is layered
  // UNDER emphasize's selection dim (min wins, so a lit ghost still recedes to GHOST_OPACITY).
  const { nodes: paintedNodes, edges: paintedEdges } = useMemo(() => {
    const cardNodes = nodes.filter((node) => MAP_CARD_TYPES.has(node.type ?? ""));
    const childNodes = nodes.filter((node) => CHILD_NODE_TYPES.has(node.type ?? ""));
    const emphasized = emphasize(cardNodes, edges, selected, radius, highlightMode);
    const ghostLayered = emphasized.nodes.map((node) => (isGhost(node) ? dimGhost(node) : node));
    return { nodes: [...ghostLayered, ...childNodes], edges: emphasized.edges };
  }, [nodes, edges, selected, radius, highlightMode]);

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
        onNodeClick={interactive ? onNodeClick : undefined}
        onNodeDoubleClick={interactive ? onNodeDoubleClick : undefined}
        onPaneClick={interactive ? onPaneClick : undefined}
        onInit={(instance) => {
          rfRef.current = instance;
        }}
        {...READONLY_CANVAS_PROPS}
      >
        <CanvasChrome nodeColor={minimalMiniMapColor} />
      </ReactFlow>
      <div style={MINIMAL_PANEL_STYLE}>
        <span style={TITLE_STYLE}>
          {override ? override.title : "Extracted selection"}
        </span>
        {interactive ? (
          <button type="button" style={buttonStyle(false, !grown)} onClick={resetMinimalGraph} disabled={!grown} title="Restore the working set to the original selection">
            Reset
          </button>
        ) : null}
        <button type="button" style={buttonStyle(false, false)} onClick={close} title={override ? "Back to the PR list (Esc)" : "Back to the Module map (Esc)"}>
          ✕ Close
        </button>
      </div>
      {interactive ? <MinimalMembersPanel /> : null}
    </div>
  );
}

const isGhost = (node: Node): boolean => (node.data as { tier?: string } | undefined)?.tier === "ghost";

// Order-independent equality of two id lists — Reset is disabled while members still equal the origin.
function sameIds(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  const set = new Set(a);
  return b.every((id) => set.has(id));
}

// Dim a ghost card, keeping whatever smaller opacity emphasize already applied (a dimmed non-neighbour
// stays dim; a lit ghost drops to GHOST_OPACITY so the ghost tier still reads).
function dimGhost(node: Node): Node {
  const existing = (node.style?.opacity as number | undefined) ?? 1;
  return { ...node, style: { ...node.style, opacity: Math.min(existing, GHOST_OPACITY) } };
}

// Top-RIGHT, because the Module map keeps its main Toolbar floating top-left over this overlay.
const MINIMAL_PANEL_STYLE: React.CSSProperties = { ...PANEL_STYLE, left: "auto", right: 16 };
const TITLE_STYLE: React.CSSProperties = { fontSize: 12, fontWeight: 700, color: "#E6EDF3" };
