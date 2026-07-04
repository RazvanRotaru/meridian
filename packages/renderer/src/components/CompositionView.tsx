/**
 * The Service-composition view: the graph's composition units as SOLID health scorecards wired by
 * coupling edges. Nodes/edges are laid out by ELK in the store (`compRfNodes`/`compRfEdges`); this
 * component only mounts the read-only <ReactFlow> surface and the selection highlight.
 *
 * Selection is repaint-only: clicking a unit fixes it in the store (`compSelectedId`), and a useMemo
 * keyed on that selection emphasizes the unit's directly-connected wires while fading everything
 * unrelated — no relayout, positions untouched, exactly like the logic view's edge highlight.
 */

import { useEffect, useMemo, useRef } from "react";
import { ReactFlow, type Edge, type Node, type NodeMouseHandler, type ReactFlowInstance } from "@xyflow/react";
import { useBlueprint, useBlueprintActions } from "../state/StoreContext";
import { compNodeTypes } from "./nodes/composition/CompositionNode";
import { CanvasChrome, READONLY_CANVAS_PROPS } from "./canvas/flowCanvasProps";
import type { CompRfEdge, CompRfNode } from "../layout/compositionElk";
import { colorForDistance, type CompNodeData } from "../derive/compositionGraph";

export function CompositionView() {
  const nodes = useBlueprint((state) => state.compRfNodes);
  const edges = useBlueprint((state) => state.compRfEdges);
  const selectedId = useBlueprint((state) => state.compSelectedId);
  const layoutStatus = useBlueprint((state) => state.compLayoutStatus);
  const { selectCompUnit } = useBlueprintActions();

  // The highlight is a pure repaint over the store's laid-out graph — recomputed only when the
  // layout or the selection changes, never mutating the store arrays.
  const { styledNodes, styledEdges } = useMemo(
    () => emphasizeSelection(nodes, edges, selectedId),
    [nodes, edges, selectedId],
  );

  const onNodeClick: NodeMouseHandler<Node> = (_event, node) => selectCompUnit(node.id);

  // A handle on the surface so the first laid-out graph fits once (the `fitView` prop only fits on
  // mount, before the async ELK layout has produced any nodes). Guarded so later relayouts don't
  // yank the viewport back.
  const rfRef = useRef<ReactFlowInstance<Node, Edge> | null>(null);
  const fitted = useRef(false);
  useEffect(() => {
    if (!rfRef.current || nodes.length === 0 || fitted.current) {
      return;
    }
    fitted.current = true;
    requestAnimationFrame(() => rfRef.current?.fitView({ padding: 0.2, duration: 400, minZoom: 0.01 }));
  }, [nodes]);

  const isEmpty = nodes.length === 0 && layoutStatus === "ready";

  return (
    <div style={SURFACE_STYLE}>
      <ReactFlow<Node, Edge>
        nodes={styledNodes}
        edges={styledEdges}
        nodeTypes={compNodeTypes}
        onInit={(instance) => {
          rfRef.current = instance;
        }}
        onNodeClick={onNodeClick}
        onPaneClick={() => selectCompUnit(null)}
        {...READONLY_CANVAS_PROPS}
      >
        <CanvasChrome nodeColor={miniMapColor} />
      </ReactFlow>
      {isEmpty ? <EmptyCompositionCard /> : null}
    </div>
  );
}

const DIM_EDGE_OPACITY = 0.12;
const DIM_NODE_OPACITY = 0.28;
const EMPHASIS_WIDTH = 2.5;

/**
 * Style the graph for the current selection: the wires touching the selected unit (either direction)
 * thicken to full opacity while the rest fade, and every unit NOT directly connected to it fades
 * too — so one unit's dependency neighbourhood stands out. No selection → the layout arrays pass
 * through untouched (same references, no new objects, no repaint churn).
 */
function emphasizeSelection(
  nodes: CompRfNode[],
  edges: CompRfEdge[],
  selectedId: string | null,
): { styledNodes: CompRfNode[]; styledEdges: CompRfEdge[] } {
  if (selectedId === null) {
    return { styledNodes: nodes, styledEdges: edges };
  }
  const connected = connectedUnitIds(edges, selectedId);
  const styledEdges = edges.map((edge) =>
    edge.source === selectedId || edge.target === selectedId ? emphasizeEdge(edge) : dimEdge(edge),
  );
  // The selected unit is seeded into `connected`, so it (and its neighbours) never dim; the node's
  // own green ring is drawn by CompositionNode reading the store.
  const styledNodes = nodes.map((node) => (connected.has(node.id) ? node : dimNode(node)));
  return { styledNodes, styledEdges };
}

// The selected unit plus every unit one coupling hop away (in or out) — its dependency neighbourhood.
function connectedUnitIds(edges: CompRfEdge[], selectedId: string): Set<string> {
  const ids = new Set<string>([selectedId]);
  for (const edge of edges) {
    if (edge.source === selectedId) {
      ids.add(edge.target);
    } else if (edge.target === selectedId) {
      ids.add(edge.source);
    }
  }
  return ids;
}

function emphasizeEdge(edge: CompRfEdge): CompRfEdge {
  return { ...edge, style: { ...edge.style, strokeWidth: EMPHASIS_WIDTH, opacity: 1 } };
}

function dimEdge(edge: CompRfEdge): CompRfEdge {
  return { ...edge, style: { ...edge.style, opacity: DIM_EDGE_OPACITY } };
}

function dimNode(node: CompRfNode): CompRfNode {
  return { ...node, style: { ...node.style, opacity: DIM_NODE_OPACITY } };
}

// The MiniMap gets untyped `Node`s; narrow to our unit data and tint each dot by its health colour
// so the map reads the same green→amber→red story as the cards.
function miniMapColor(node: Node): string {
  return colorForDistance((node.data as CompNodeData).metrics.distance);
}

/** Shown when the artifact has no composition units to chart (no classes/modules with members or
 * couplings) — a centered note so the tab is never a silent blank canvas. */
function EmptyCompositionCard() {
  return (
    <div style={EMPTY_WRAP_STYLE}>
      <div style={EMPTY_CARD_STYLE}>
        <span style={EMPTY_MARK_STYLE}>∅</span>
        <span>No composition units to chart in this artifact.</span>
      </div>
    </div>
  );
}

const SURFACE_STYLE: React.CSSProperties = { position: "absolute", inset: 0, background: "#0E1116" };
const EMPTY_WRAP_STYLE: React.CSSProperties = {
  position: "absolute",
  inset: 0,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  pointerEvents: "none",
  padding: "0 48px",
};
const EMPTY_CARD_STYLE: React.CSSProperties = {
  pointerEvents: "auto",
  display: "flex",
  alignItems: "center",
  gap: 12,
  maxWidth: 520,
  border: "1px dashed #2A2F37",
  borderRadius: 10,
  background: "#12171E",
  padding: "16px 18px",
  fontSize: 13,
  color: "#7B8695",
};
const EMPTY_MARK_STYLE: React.CSSProperties = { fontSize: 22, opacity: 0.5 };
