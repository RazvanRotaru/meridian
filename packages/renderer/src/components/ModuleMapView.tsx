/**
 * The Module-map view: the import blast-radius from the app's entry module, drawn as file cards
 * grouped into directory frames on concentric depth rings. Nodes/edges are laid out synchronously in
 * the store (`moduleRfNodes`/`moduleRfEdges`); this component mounts the read-only <ReactFlow> surface
 * and two pure PAINT steps over the already-placed graph — never a relayout, so positions hold still:
 *   1. `filterVisible` drops cards a category toggle (or the Tests toggle) hides, plus emptied frames;
 *   2. `emphasize` dims every wire until a card is selected, then lights that card's import neighbourhood.
 *
 * Single-click selects a file (repaint only, viewport never moves). Double-click a file re-roots the
 * blast radius there (`setModuleRoot`) — the deliberate travel gesture, mirroring the other lenses.
 * A directory frame is a passive container: clicking it clears the selection, double-clicking is a
 * no-op (the BFS root must be a file/module node, not a package).
 */

import { useEffect, useMemo, useRef } from "react";
import { ReactFlow, type Edge, type Node, type NodeMouseHandler, type ReactFlowInstance } from "@xyflow/react";
import { useBlueprint, useBlueprintActions } from "../state/StoreContext";
import { moduleNodeTypes, CATEGORY_COLOR } from "./nodes/modulemap/ModuleCardNode";
import { filterVisible, emphasize } from "./moduleMapPaint";
import { CanvasChrome, READONLY_CANVAS_PROPS } from "./canvas/flowCanvasProps";
import type { ModuleCardData } from "../derive/moduleMap";

export function ModuleMapView() {
  const nodes = useBlueprint((state) => state.moduleRfNodes);
  const edges = useBlueprint((state) => state.moduleRfEdges);
  const selectedId = useBlueprint((state) => state.moduleSelectedId);
  const layoutStatus = useBlueprint((state) => state.moduleLayoutStatus);
  const moduleRoot = useBlueprint((state) => state.moduleRoot);
  const effectiveRoot = useBlueprint((state) => state.moduleEffectiveRoot);
  const nodesById = useBlueprint((state) => state.index.nodesById);
  const testIds = useBlueprint((state) => state.index.testIds);
  const hiddenCategories = useBlueprint((state) => state.hiddenCategories);
  const showTests = useBlueprint((state) => state.showTests);
  const { selectModule, setModuleRoot } = useBlueprintActions();

  // Category/test hiding is a pure VISIBILITY filter over the laid-out graph — hidden cards and any
  // frame they emptied drop out, but the walk (and every surviving position) is untouched, so the
  // blast radius is never truncated and cards never jump.
  const { nodes: shownNodes, edges: shownEdges } = useMemo(
    () => filterVisible(nodes, edges, { hiddenCategories, showTests, testIds }),
    [nodes, edges, hiddenCategories, showTests, testIds],
  );
  // Emphasis is a second pure repaint: dim by default, light the selection's import neighbourhood.
  const { nodes: styledNodes, edges: styledEdges } = useMemo(
    () => emphasize(shownNodes, shownEdges, selectedId),
    [shownNodes, shownEdges, selectedId],
  );

  const onNodeClick: NodeMouseHandler<Node> = (_event, node) => {
    selectModule(node.type === "frame" ? null : node.id);
  };
  // Re-root only at a file — a frame's id is a package node, which the import BFS can't walk from.
  const onNodeDoubleClick: NodeMouseHandler<Node> = (_event, node) => {
    if (node.type !== "frame") {
      setModuleRoot(node.id);
    }
  };

  // Fit once per root: the `fitView` prop only fits on mount, before the sync layout has produced
  // nodes; re-rooting clears the guard so the fresh radius re-fits, exactly like CompositionView.
  const rfRef = useRef<ReactFlowInstance<Node, Edge> | null>(null);
  const fitted = useRef(false);
  useEffect(() => {
    fitted.current = false;
  }, [moduleRoot]);
  useEffect(() => {
    if (!rfRef.current || nodes.length === 0 || fitted.current) {
      return;
    }
    fitted.current = true;
    requestAnimationFrame(() => rfRef.current?.fitView({ padding: 0.2, duration: 400, minZoom: 0.01 }));
  }, [nodes]);

  const isEmpty = nodes.length === 0 && layoutStatus === "ready";
  const rootLabel = effectiveRoot ? nodesById.get(effectiveRoot)?.displayName ?? effectiveRoot : null;

  return (
    <div style={SURFACE_STYLE}>
      <ReactFlow<Node, Edge>
        nodes={styledNodes}
        edges={styledEdges}
        nodeTypes={moduleNodeTypes}
        onInit={(instance) => {
          rfRef.current = instance;
        }}
        onNodeClick={onNodeClick}
        onNodeDoubleClick={onNodeDoubleClick}
        onPaneClick={() => selectModule(null)}
        {...READONLY_CANVAS_PROPS}
      >
        <CanvasChrome nodeColor={miniMapColor} />
      </ReactFlow>
      <ModuleMapBreadcrumb
        rootId={effectiveRoot}
        rootLabel={rootLabel}
        isCustomRoot={moduleRoot !== null}
        onHome={() => setModuleRoot(null)}
      />
      {isEmpty ? <EmptyModuleMapCard /> : null}
    </div>
  );
}

/**
 * The blast-radius root trail: the resolved entry alone ("▸ <entry>") until the reader re-roots, then
 * "Entry ▸ <root>" where "Entry" is a button back to the declared app entry. Mirrors the composition
 * breadcrumb so the two lenses read as one control language.
 */
function ModuleMapBreadcrumb(props: {
  rootId: string | null;
  rootLabel: string | null;
  isCustomRoot: boolean;
  onHome: () => void;
}) {
  if (props.rootLabel === null) {
    return null;
  }
  return (
    <nav style={BREADCRUMB_STYLE} aria-label="Blast-radius root">
      {props.isCustomRoot ? (
        <>
          <button type="button" style={CRUMB_STYLE} onClick={props.onHome}>Entry</button>
          <span style={CRUMB_SEP_STYLE} aria-hidden>›</span>
          <span style={CRUMB_CURRENT_STYLE} aria-current="page" title={props.rootId ?? undefined}>{props.rootLabel}</span>
        </>
      ) : (
        <span style={CRUMB_CURRENT_STYLE} aria-current="page" title={props.rootId ?? undefined}>Entry · {props.rootLabel}</span>
      )}
    </nav>
  );
}

/** Shown when nothing is reachable — no import edges, an entry with no in-project imports, or a depth
 * of 1 on a module that imports nothing — so the lens is never a silent blank canvas. */
function EmptyModuleMapCard() {
  return (
    <div style={EMPTY_WRAP_STYLE}>
      <div style={EMPTY_CARD_STYLE}>
        <span style={EMPTY_MARK_STYLE}>∅</span>
        <span>No imported modules at this depth — raise the depth, or this entry imports nothing in-project.</span>
      </div>
    </div>
  );
}

// The MiniMap gets untyped `Node`s: a directory frame reads as a neutral panel tone, each file dot
// tints by its category (the same palette as the cards) so clusters stay legible at overview zoom.
function miniMapColor(node: Node): string {
  if (node.type === "frame") {
    return "#2A313D";
  }
  return CATEGORY_COLOR[(node.data as ModuleCardData).category];
}

const SURFACE_STYLE: React.CSSProperties = { position: "absolute", inset: 0, background: "#0E1116" };
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
