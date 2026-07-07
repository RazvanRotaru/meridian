/**
 * The read-only React Flow shell shared by both graph surfaces (the call/UI graph and the
 * Logic-flow graph). The two views differ only in their nodes/edges, node/edge types, and click
 * handlers; the canvas behaviour (dark, non-editable, pan-to-drag, zoom range, fit-on-mount) and
 * the chrome children (dotted background, controls, kind-coloured minimap) are byte-identical, so
 * they live here once. Each view spreads `READONLY_CANVAS_PROPS` onto its <ReactFlow> and renders
 * <CanvasChrome> with its own minimap colour fn.
 */

import { Background, BackgroundVariant, Controls, MiniMap, type Node } from "@xyflow/react";

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
  // Only mount DOM for nodes in the viewport. A big system graph has thousands of cards; without
  // this, React Flow builds a DOM node for every one up front, which alone can lock up a slower
  // engine (Safari/WebKit). Culling keeps the mounted set to what's actually on screen.
  onlyRenderVisibleElements: true,
  proOptions: { hideAttribution: true },
} as const;

// The MiniMap draws one SVG element PER NODE and redraws them on every pan/zoom frame — at ~800
// nodes that alone freezes interaction. Above this count the minimap is dropped (the graph is too
// dense to navigate by minimap anyway; pan/zoom + ⌘P are the tools).
export const MINIMAP_NODE_CAP = 250;

// The three chrome children every read-only surface renders: a dotted background, the zoom/fit
// controls (interactive toggle hidden — the graph is read-only), and a pannable minimap tinted per
// node by the view's own colour fn.
export function CanvasChrome({ nodeColor, minimap = true }: { nodeColor: (node: Node) => string; minimap?: boolean }) {
  return (
    <>
      <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="#222732" />
      <Controls showInteractive={false} />
      {minimap ? <MiniMap pannable zoomable nodeColor={nodeColor} maskColor="rgba(8,10,14,0.7)" /> : null}
    </>
  );
}
