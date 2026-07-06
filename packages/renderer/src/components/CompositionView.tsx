/**
 * The Service-composition view: the graph's composition units as SOLID health scorecards wired by
 * coupling edges. Nodes/edges are laid out by ELK in the store (`compRfNodes`/`compRfEdges`); this
 * component only mounts the read-only <ReactFlow> surface and the selection highlight.
 *
 * Single-click is repaint-only: it fixes the selection in the store (`compSelectedId`) and a useMemo
 * keyed on that selection emphasizes the unit's directly-connected wires while fading everything
 * unrelated — no relayout, positions untouched, the viewport NEVER moves. Double-click focuses the
 * view (`setCompRoot` → re-root + re-fit), the deliberate travel gesture, mirroring the call graph's
 * double-click-to-dive.
 */

import { useEffect, useMemo, useRef } from "react";
import { ReactFlow, type Edge, type Node, type NodeMouseHandler, type ReactFlowInstance } from "@xyflow/react";
import type { CoverageReport } from "@meridian/core";
import { useBlueprint, useBlueprintActions } from "../state/StoreContext";
import { compNodeTypes } from "./nodes/composition/CompositionNode";
import { CanvasChrome, READONLY_CANVAS_PROPS } from "./canvas/flowCanvasProps";
import { CompMethodDrawer } from "./composition/CompMethodDrawer";
import { CoveragePanel } from "./CoveragePanel";
import { coverageAccent } from "../theme/coverageColors";
import type { CompRfEdge, CompRfNode } from "../layout/compositionElk";
import { colorForDistance, type CompNodeData } from "../derive/compositionGraph";

export function CompositionView() {
  const nodes = useBlueprint((state) => state.compRfNodes);
  const edges = useBlueprint((state) => state.compRfEdges);
  const selectedId = useBlueprint((state) => state.compSelectedId);
  const layoutStatus = useBlueprint((state) => state.compLayoutStatus);
  const compRoot = useBlueprint((state) => state.compRoot);
  const nodesById = useBlueprint((state) => state.index.nodesById);
  const coverage = useBlueprint((state) => (state.coverageMode ? state.coverage : null));
  const showTests = useBlueprint((state) => state.showTests);
  const testIds = useBlueprint((state) => state.index.testIds);
  const { selectCompUnit, setCompRoot } = useBlueprintActions();

  // Hiding tests is a pure VISIBILITY filter over the already-laid-out graph: test cards (and any
  // cluster frame left empty by their removal, and any wire touching them) drop out, but every
  // production card keeps its exact position — the layout is computed once with tests included, so
  // the structure never reshuffles when the toggle flips.
  const { nodes: shownNodes, edges: shownEdges } = useMemo(
    () => (showTests ? { nodes, edges } : withoutTests(nodes, edges, testIds)),
    [nodes, edges, showTests, testIds],
  );

  // The highlight is a pure repaint over the (filtered) laid-out graph — recomputed only when the
  // layout, filter, or selection changes, never mutating the store arrays.
  const { styledNodes, styledEdges } = useMemo(
    () => emphasizeSelection(shownNodes, shownEdges, selectedId),
    [shownNodes, shownEdges, selectedId],
  );

  // Single-click ALWAYS just selects + highlights — it never moves the viewport. A cluster frame is a
  // passive panel, not a selectable unit, so clicking one clears the selection like clicking empty
  // canvas; any other node (unit OR boundary card) fixes the selection highlight. Focusing/re-rooting
  // is the double-click gesture below.
  const onNodeClick: NodeMouseHandler<Node> = (_event, node) => {
    if (node.type === "cluster") {
      selectCompUnit(null);
      return;
    }
    selectCompUnit(node.id);
  };

  // Double-click focuses the view HERE — re-rooting at the node (a cluster frame's id IS its package
  // node, so it roots at that package; a unit or boundary card roots there). Re-rooting re-fits the
  // viewport (the fit effect below), which is exactly why it's a deliberate double-click, not a click.
  const onNodeDoubleClick: NodeMouseHandler<Node> = (_event, node) => {
    setCompRoot(node.id);
  };

  // A handle on the surface so the first laid-out graph fits once (the `fitView` prop only fits on
  // mount, before the async ELK layout has produced any nodes). Guarded so later relayouts don't
  // yank the viewport back.
  const rfRef = useRef<ReactFlowInstance<Node, Edge> | null>(null);
  const fitted = useRef(false);
  // A new root is a fresh graph, so clear the one-shot guard FIRST: when the rooted layout lands, the
  // fit effect below re-fits the viewport to it exactly as it did on first load.
  useEffect(() => {
    fitted.current = false;
  }, [compRoot]);
  useEffect(() => {
    if (!rfRef.current || nodes.length === 0 || fitted.current) {
      return;
    }
    fitted.current = true;
    requestAnimationFrame(() => rfRef.current?.fitView({ padding: 0.2, duration: 400, minZoom: 0.01 }));
  }, [nodes]);

  const isEmpty = nodes.length === 0 && layoutStatus === "ready";
  const rootLabel = compRoot ? nodesById.get(compRoot)?.displayName ?? compRoot : null;

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
        onNodeDoubleClick={onNodeDoubleClick}
        onPaneClick={() => selectCompUnit(null)}
        {...READONLY_CANVAS_PROPS}
      >
        <CanvasChrome nodeColor={(node) => miniMapColor(node, coverage)} />
        <CoveragePanel />
      </ReactFlow>
      <CompositionBreadcrumb rootId={compRoot} rootLabel={rootLabel} onHome={() => setCompRoot(null)} />
      {isEmpty ? <EmptyCompositionCard /> : null}
      {/* EXPERIMENT: a member click previews that method's logic flow here, docked over the map. */}
      <CompMethodDrawer />
    </div>
  );
}

/**
 * The composition root trail, mirroring the Logic-flow breadcrumb: "Whole system" alone when rootless,
 * else "Whole system ▸ <root>" where "Whole system" is a button back to the full graph. Floated
 * top-left, inset to clear the Toolbar panel.
 */
function CompositionBreadcrumb(props: { rootId: string | null; rootLabel: string | null; onHome: () => void }) {
  return (
    <nav style={BREADCRUMB_STYLE} aria-label="Composition root">
      {props.rootLabel === null ? (
        <span style={CRUMB_CURRENT_STYLE} aria-current="page">Whole system</span>
      ) : (
        <>
          <button type="button" style={CRUMB_STYLE} onClick={props.onHome}>Whole system</button>
          <span style={CRUMB_SEP_STYLE} aria-hidden>›</span>
          <span style={CRUMB_CURRENT_STYLE} aria-current="page" title={props.rootId ?? undefined}>{props.rootLabel}</span>
        </>
      )}
    </nav>
  );
}

/**
 * Drop test-code unit cards, the wires touching them, and any cluster frame left with no visible
 * unit — WITHOUT touching positions, so the surviving production cards stay exactly where ELK put
 * them (the layout was computed with tests included). A cluster frame is kept as long as one of its
 * unit children survives, so a production card never references a removed parent frame.
 */
function withoutTests(
  nodes: CompRfNode[],
  edges: CompRfEdge[],
  testIds: ReadonlySet<string>,
): { nodes: CompRfNode[]; edges: CompRfEdge[] } {
  const liveClusters = new Set<string>();
  for (const node of nodes) {
    if (node.type !== "cluster" && !testIds.has(node.id) && node.parentId) {
      liveClusters.add(node.parentId);
    }
  }
  const keptNodes = nodes.filter((node) =>
    node.type === "cluster" ? liveClusters.has(node.id) : !testIds.has(node.id),
  );
  const keptEdges = edges.filter((edge) => !testIds.has(edge.source) && !testIds.has(edge.target));
  return { nodes: keptNodes, edges: keptEdges };
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
  // Only UNIT scorecards dim/emphasize — cluster frames stay at full opacity so their lit children
  // read normally over them. The selected unit is seeded into `connected`, so it (and its
  // neighbours) never dim; the node's own green ring is drawn by CompositionNode reading the store.
  const styledNodes = nodes.map((node) =>
    node.type === "cluster" || connected.has(node.id) ? node : dimNode(node),
  );
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

// The MiniMap gets untyped `Node`s and, for ONE frame during a cross-view switch, may be handed the
// PREVIOUS view's nodes — the ReactFlow store is shared app-wide via a single ReactFlowProvider in
// App.tsx. A cluster frame, and any logic node leaking in mid-switch, carries no `metrics`, so treat
// anything that isn't a metrics-bearing unit as the neutral panel tone rather than dereferencing a
// missing `metrics` (which blanked the app on the logic→composition link). A unit dot tints by its
// health colour — the same green→amber→red story as the cards. In coverage mode the dots echo the
// coverage verdict instead, matching the recoloured rails.
function miniMapColor(node: Node, coverage: CoverageReport | null): string {
  const metrics = (node.data as Partial<CompNodeData>)?.metrics;
  if (node.type !== "unit" || !metrics) {
    return "#2A313D";
  }
  if (coverage) {
    return coverageAccent(node.id, coverage);
  }
  return colorForDistance(metrics.distance);
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
// Floats top-left, inset past the Toolbar panel (matches the Logic view's overlay clearance); a
// compact dark pill so the trail reads over the canvas without stealing pans outside itself.
const BREADCRUMB_STYLE: React.CSSProperties = {
  position: "absolute",
  top: 16,
  left: 340,
  zIndex: 5,
  display: "flex",
  alignItems: "center",
  gap: 4,
  border: "1px solid #2A2F37",
  borderRadius: 8,
  background: "rgba(18,23,30,0.92)",
  padding: "4px 8px",
};
// Mirrors LogicFlowView's crumb styling so the two breadcrumbs read as one control language.
const CRUMB_STYLE: React.CSSProperties = {
  background: "transparent",
  border: "none",
  padding: "2px 4px",
  borderRadius: 4,
  cursor: "pointer",
  font: "inherit",
  fontSize: 13,
  color: "#9AA4B2",
};
const CRUMB_CURRENT_STYLE: React.CSSProperties = { ...CRUMB_STYLE, color: "#E6EDF3", fontWeight: 600, cursor: "default" };
const CRUMB_SEP_STYLE: React.CSSProperties = { color: "#4B535F", fontSize: 13 };
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
