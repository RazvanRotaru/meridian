/**
 * The read-only React Flow shell shared by both graph surfaces (the call/UI graph and the
 * Logic-flow graph). The two views differ only in their nodes/edges, node/edge types, and click
 * handlers; the canvas behaviour (dark, non-editable, pan-to-drag, zoom range, fit-on-mount) and
 * the chrome children (dotted background, controls, kind-coloured minimap) are byte-identical, so
 * they live here once. Each view spreads `READONLY_CANVAS_PROPS` onto its <ReactFlow> and renders
 * <CanvasChrome> with its own minimap colour fn.
 */

import { Background, BackgroundVariant, Controls, MiniMap, type Node, useStore } from "@xyflow/react";

// The shared, generic-independent <ReactFlow> props. Read-only (not draggable/connectable) but
// selectable — selection is driven into the store via each view's onNodeClick. Click-drag pans and
// must never rubber-band select or text-highlight labels. A big flow can be hundreds of nodes, so
// minZoom drops far below React Flow's 0.5 default (which clips large graphs) while zoom-in stays
// capped; double-click is repurposed for diving, so the pane must not also zoom on it.
export const READONLY_CANVAS_PROPS = {
  colorMode: "dark",
  nodesDraggable: false,
  nodesConnectable: false,
  elementsSelectable: true,
  panOnDrag: true,
  selectionOnDrag: false,
  style: { userSelect: "none" },
  fitView: true,
  fitViewOptions: { padding: 0.2, minZoom: 0.01 },
  minZoom: 0.01,
  maxZoom: 4,
  zoomOnDoubleClick: false,
  proOptions: { hideAttribution: true },
} as const;

// The MiniMap draws one SVG element PER NODE and redraws them on every pan/zoom frame — at ~800
// nodes that alone freezes interaction. Above this count the minimap is dropped (the graph is too
// dense to navigate by minimap anyway; pan/zoom + ⌘P are the tools).
export const MINIMAP_NODE_CAP = 250;

// The bottom-right chrome cluster, shared so MapLegend can stack against it. The minimap sits in the
// corner; the Map's Legend pill sits just left of it; the zoom/fit controls stack directly ABOVE
// that Legend pill. Keeping the whole cluster on the right leaves the entire left gutter to the
// top-left control panel, which can grow to full viewport height and would otherwise cover them.
export const MINIMAP_W = 200;
export const MINIMAP_H = 150;
export const MINIMAP_MIN_SURFACE_HEIGHT = 403;
export const CHROME_EDGE = 15; // React Flow's default panel inset from the canvas edge
export const CHROME_GAP = 12;
export const LEGEND_BOTTOM = 16; // the Map Legend pill's bottom inset
export const LEGEND_PILL_H = 28; // its collapsed height (see MapLegend PILL)
const CONTROLS_COLUMN = CHROME_EDGE + MINIMAP_W + CHROME_GAP; // shared with the Legend pill, left of the minimap
const CONTROLS_BOTTOM = LEGEND_BOTTOM + LEGEND_PILL_H + CHROME_GAP; // clear of the Legend pill below

// The three chrome children every read-only surface renders: a dotted background, the zoom/fit
// controls (interactive toggle hidden — the graph is read-only), and a pannable minimap tinted per
// node by the view's own colour fn. Controls stack above the Legend pill (left of the minimap); with
// the minimap dropped (a dense graph) they fall back to the corner.
export function CanvasChrome({ nodeColor, minimap = true }: { nodeColor: (node: Node) => string; minimap?: boolean }) {
  const surfaceHeight = useStore((state) => state.height);
  // A 150px minimap stops being useful once it consumes most of a short graph pane (for example
  // above an open flow drawer). Retire it there so the primary canvas actions own the bottom lane.
  const showMinimap = minimap && surfaceHeight >= MINIMAP_MIN_SURFACE_HEIGHT;
  return (
    <>
      <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="#222732" />
      <Controls
        showInteractive={false}
        position="bottom-right"
        style={showMinimap ? { right: CONTROLS_COLUMN, bottom: CONTROLS_BOTTOM } : { right: CHROME_EDGE, bottom: CHROME_EDGE }}
      />
      {/* Lighter mask + a per-node stroke: the old 0.7 mask over near-black node fills made the
          minimap read as an empty rectangle; the stroke keeps tiny nodes visible at any density. */}
      {showMinimap ? (
        <MiniMap pannable zoomable nodeColor={nodeColor} nodeStrokeColor="#4B5563" nodeStrokeWidth={3} maskColor="rgba(8,10,14,0.55)" style={{ width: MINIMAP_W, height: MINIMAP_H, background: "#161B22" }} />
      ) : null}
    </>
  );
}
