/**
 * The Module-map view: ONE zoomable containment level. The whole-repo package overview at the top,
 * or — once you double-click a group card — that package/directory's children (sub-dirs as group
 * cards, files as file cards) wired by the import graph folded to this level. Nodes/edges are laid
 * out in the store (`moduleRfNodes`/`moduleRfEdges`); this component mounts the read-only <ReactFlow>
 * surface and two pure PAINT steps over the placed graph — never a relayout, so positions hold still:
 *   1. `filterVisible` drops file cards a category/Tests toggle hides (group cards always stay);
 *   2. `emphasize` dims every wire until nodes are selected (plain click picks one; ctrl/cmd+click
 *      accumulates several), then lights the union of their N-hop import neighbourhoods.
 *
 * Navigation is one gesture set: double-click a GROUP card to zoom IN (setModuleFocus); the breadcrumb
 * (the containment trail) zooms OUT. Double-clicking a FILE only selects it (files have no children).
 */

import { useEffect, useMemo, useRef } from "react";
import { ReactFlow, type Edge, type Node, type NodeMouseHandler, type ReactFlowInstance } from "@xyflow/react";
import { useBlueprint, useBlueprintActions } from "../state/StoreContext";
import { moduleNodeTypes, CATEGORY_COLOR } from "./nodes/modulemap/ModuleCardNode";
import { filterVisible, emphasize } from "./moduleMapPaint";
import { CanvasChrome, READONLY_CANVAS_PROPS } from "./canvas/flowCanvasProps";
import type { ModuleCardData } from "../derive/moduleLevel";
import type { GraphIndex } from "../graph/graphIndex";

const PACKAGE_KIND = "package";

export function ModuleMapView() {
  const nodes = useBlueprint((state) => state.moduleRfNodes);
  const edges = useBlueprint((state) => state.moduleRfEdges);
  const selected = useBlueprint((state) => state.moduleSelected);
  const layoutStatus = useBlueprint((state) => state.moduleLayoutStatus);
  const effectiveFocus = useBlueprint((state) => state.moduleEffectiveFocus);
  const radius = useBlueprint((state) => state.moduleRadius);
  const index = useBlueprint((state) => state.index);
  const hiddenCategories = useBlueprint((state) => state.hiddenCategories);
  const showTests = useBlueprint((state) => state.showTests);
  const { selectModule, toggleModuleSelect, setModuleFocus } = useBlueprintActions();

  // Category/test hiding is a pure VISIBILITY filter over the laid-out graph; positions are untouched.
  const { nodes: shownNodes, edges: shownEdges } = useMemo(
    () => filterVisible(nodes, edges, { hiddenCategories, showTests, testIds: index.testIds }),
    [nodes, edges, hiddenCategories, showTests, index.testIds],
  );
  // Emphasis is a second pure repaint: dim by default, light the union of every selected node's
  // N-hop import reach.
  const { nodes: styledNodes, edges: styledEdges } = useMemo(
    () => emphasize(shownNodes, shownEdges, selected, radius),
    [shownNodes, shownEdges, selected, radius],
  );

  // Plain click REPLACES the selection; ctrl/cmd+click toggles the node in/out of it, accumulating
  // a multi-selection whose combined neighbourhood lights up.
  const onNodeClick: NodeMouseHandler<Node> = (event, node) =>
    event.ctrlKey || event.metaKey ? toggleModuleSelect(node.id) : selectModule(node.id);
  // Double-click a GROUP card (a package/directory) zooms into it; a file has no children, so it only
  // selects. The breadcrumb is the way back up — a uniform gesture, no mode switch.
  const onNodeDoubleClick: NodeMouseHandler<Node> = (_event, node) => {
    if (node.type === PACKAGE_KIND) {
      setModuleFocus(node.id);
    } else {
      selectModule(node.id);
    }
  };

  // Fit once per RELAYOUT (a focus change): `moduleRfNodes` only changes when the level does, so
  // clearing the guard on `effectiveFocus` re-fits the fresh level to the viewport. Category toggles
  // and radius are paint-only (they never change `nodes`), so they correctly do NOT trigger a refit.
  const rfRef = useRef<ReactFlowInstance<Node, Edge> | null>(null);
  const fitted = useRef(false);
  useEffect(() => {
    fitted.current = false;
  }, [effectiveFocus]);
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
      <LevelBreadcrumb
        focus={effectiveFocus}
        packageCount={effectiveFocus === null ? nodes.length : 0}
        crumbs={crumbsFor(effectiveFocus, index)}
        onFocus={setModuleFocus}
      />
      {isEmpty ? <EmptyModuleMapCard focus={effectiveFocus} /> : null}
    </div>
  );
}

interface Crumb {
  id: string;
  label: string;
}

/** The containment trail from the repo down to the focus: the package-node ancestors (inclusive). */
function crumbsFor(focus: string | null, index: GraphIndex): Crumb[] {
  if (focus === null) {
    return [];
  }
  return index
    .ancestorsOf(focus)
    .filter((node) => node.kind === PACKAGE_KIND)
    .map((node) => ({ id: node.id, label: node.displayName ?? node.id }));
}

/**
 * The zoom trail: "Repository" (level 0) then each package/directory you descended into. Every
 * segment but the last is a button that zooms back to that level; the last is the current level.
 * Mirrors the call lens's Breadcrumb so the lenses read as one control language.
 */
function LevelBreadcrumb(props: { focus: string | null; packageCount: number; crumbs: Crumb[]; onFocus: (id: string | null) => void }) {
  const atRoot = props.focus === null;
  return (
    <nav style={BREADCRUMB_STYLE} aria-label="Containment level">
      {atRoot ? (
        <span style={CRUMB_CURRENT_STYLE} aria-current="page">Repository — {props.packageCount} packages</span>
      ) : (
        <button type="button" style={CRUMB_STYLE} onClick={() => props.onFocus(null)}>Repository</button>
      )}
      {props.crumbs.map((crumb, i) => {
        const isLast = i === props.crumbs.length - 1;
        return (
          <span key={crumb.id} style={SEG_WRAP}>
            <span style={CRUMB_SEP_STYLE} aria-hidden>›</span>
            {isLast ? (
              <span style={CRUMB_CURRENT_STYLE} aria-current="page" title={crumb.id}>{crumb.label}</span>
            ) : (
              <button type="button" style={CRUMB_STYLE} title={crumb.id} onClick={() => props.onFocus(crumb.id)}>{crumb.label}</button>
            )}
          </span>
        );
      })}
    </nav>
  );
}

/** Shown when a level is empty — a focus with no in-project files, so the lens is never a silent blank. */
function EmptyModuleMapCard(props: { focus: string | null }) {
  return (
    <div style={EMPTY_WRAP_STYLE}>
      <div style={EMPTY_CARD_STYLE}>
        <span style={EMPTY_MARK_STYLE}>∅</span>
        <span>
          {props.focus === null
            ? "No npm packages with resolved imports in this artifact."
            : "Nothing in-project here — this directory's files import only external packages, or it has none."}
        </span>
      </div>
    </div>
  );
}

// The MiniMap gets untyped `Node`s: a group card reads as a blue package tone, each file dot tints by
// its category (the same palette as the cards) so a level stays legible at overview zoom.
function miniMapColor(node: Node): string {
  if (node.type === PACKAGE_KIND) {
    return "#5B9BE3";
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
  gap: 2,
  border: "1px solid #2A2F37",
  borderRadius: 8,
  background: "rgba(18,23,30,0.92)",
  padding: "4px 8px",
  maxWidth: "60vw",
  overflow: "hidden",
};
const SEG_WRAP: React.CSSProperties = { display: "inline-flex", alignItems: "center", gap: 2, minWidth: 0 };
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
