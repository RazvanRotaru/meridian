/**
 * The Module-map view: ONE zoomable containment level. The whole-repo package overview at the top,
 * or — once you double-click a group card — that package/directory's children (sub-dirs as group
 * cards, files as file cards) wired by the import graph folded to this level. Nodes/edges are laid
 * out in the store (`moduleRfNodes`/`moduleRfEdges`); this component mounts the read-only <ReactFlow>
 * surface and two pure PAINT steps over the placed graph — never a relayout, so positions hold still:
 *   1. `filterVisible` drops file cards a category/Tests toggle hides (group cards always stay);
 *   2. `emphasize` dims every wire until a node is selected, then lights its N-hop import neighbourhood.
 *
 * Navigation is one gesture set: double-click a package/file card to zoom IN (setModuleFocus); the
 * breadcrumb (the containment trail) zooms OUT.
 */

import { useEffect, useMemo, useRef } from "react";
import { ReactFlow, type Edge, type Node, type ReactFlowInstance } from "@xyflow/react";
import { useBlueprint, useBlueprintActions } from "../state/StoreContext";
import { moduleNodeTypes } from "./nodes/modulemap/ModuleCardNode";
import { useModuleSurfacePaint } from "./canvas/useModuleSurfacePaint";
import { crumbsFor, EmptyModuleMapCard, LevelBreadcrumb } from "./ModuleMapChrome";
import { CoveragePanel } from "./CoveragePanel";
import { BeaconArrows } from "./BeaconArrows";
import { MapLegend } from "./MapLegend";
import { CanvasChrome, READONLY_CANVAS_PROPS } from "./canvas/flowCanvasProps";
import { useRecenter } from "./canvas/useRecenter";
import { useModuleNodeInteractions } from "./canvas/useModuleNodeInteractions";
import { MinimalGraphView } from "./MinimalGraphView";
import { accentForKind } from "../theme/kindColors";
import type { BlockData, UnitCardData } from "../derive/moduleLevel";

const PACKAGE_KIND = "package";

export function ModuleMapView() {
  const nodes = useBlueprint((state) => state.moduleRfNodes);
  const edges = useBlueprint((state) => state.moduleRfEdges);
  const selected = useBlueprint((state) => state.moduleSelected);
  const layoutStatus = useBlueprint((state) => state.moduleLayoutStatus);
  const effectiveFocus = useBlueprint((state) => state.moduleEffectiveFocus);
  const index = useBlueprint((state) => state.index);
  const minimalOpen = useBlueprint((state) => state.minimalSeedIds.length > 0);
  const { buildMinimalGraph, setModuleFocus } = useBlueprintActions();
  const { onNodeClick, onNodeDoubleClick, onPaneClick } = useModuleNodeInteractions();
  useRecenter(useMemo(() => [...selected], [selected]));

  // The shared Map paint pipeline: category/Tests/Private visibility, relationship-kind filtering, and
  // the selection's N-hop emphasis — three pure repaints over the laid-out graph (positions untouched).
  const { nodes: styledNodes, edges: styledEdges, beacons } = useModuleSurfacePaint(nodes, edges);

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

  // The built minimal graph REPLACES the level canvas while open (after every hook above, so the
  // hook order is stable across open/close). Closing returns here with the selection intact.
  if (minimalOpen) {
    return (
      <div style={SURFACE_STYLE}>
        <MinimalGraphView />
      </div>
    );
  }

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
        onPaneClick={onPaneClick}
        {...READONLY_CANVAS_PROPS}
      >
        <CanvasChrome nodeColor={miniMapColor} />
        <BeaconArrows targets={beacons} />
      </ReactFlow>
      <LevelBreadcrumb
        focus={effectiveFocus}
        packageCount={effectiveFocus === null ? nodes.filter((node) => !node.parentId).length : 0}
        crumbs={crumbsFor(effectiveFocus, index)}
        onFocus={setModuleFocus}
      />
      {selected.size >= 1 ? <BuildMinimalGraphButton count={selected.size} onBuild={buildMinimalGraph} /> : null}
      {isEmpty ? <EmptyModuleMapCard focus={effectiveFocus} /> : null}
      <MapLegend hasSteps={styledNodes.some((node) => node.type === "step")} hasSelection={selected.size > 0} />
      <CoveragePanel />
    </div>
  );
}

/** The floating action a selection (one card or more) reveals: build its minimal graph overlay. */
function BuildMinimalGraphButton(props: { count: number; onBuild: () => void }) {
  return (
    <button type="button" style={BUILD_BUTTON_STYLE} onClick={props.onBuild}>
      Build minimal graph ({props.count})
    </button>
  );
}

// The MiniMap gets untyped `Node`s: a group card reads as a blue package tone, unit/block dots tint
// by their kind, each file dot by its category (the same palette as the cards) so a level stays
// legible at overview zoom. Exported so the minimal-graph overlay tints its MiniMap identically.
export function miniMapColor(node: Node): string {
  if (node.type === PACKAGE_KIND) {
    return "#5B9BE3";
  }
  if (node.type === "unit") {
    return accentForKind((node.data as UnitCardData).unitKind);
  }
  if (node.type === "block") {
    return accentForKind((node.data as BlockData).blockKind);
  }
  if (node.type === "step" || node.type === "ghost") {
    return "#565E68";
  }
  // File dots wear the neutral file-family accent (category lives on the card's text chip, not a hue).
  return accentForKind("module");
}

const SURFACE_STYLE: React.CSSProperties = { position: "absolute", inset: 0, background: "#0E1116" };
// Floats bottom-center over the canvas; the emphasis green ties it to the selected cards' rings.
const BUILD_BUTTON_STYLE: React.CSSProperties = {
  position: "absolute",
  bottom: 24,
  left: "50%",
  transform: "translateX(-50%)",
  zIndex: 5,
  border: "1px solid #2F5C3B",
  borderRadius: 8,
  background: "rgba(86,194,113,0.16)",
  padding: "8px 16px",
  cursor: "pointer",
  font: "inherit",
  fontSize: 13,
  fontWeight: 700,
  color: "#6BE38A",
};
