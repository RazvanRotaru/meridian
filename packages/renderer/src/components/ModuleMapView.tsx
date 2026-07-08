/**
 * The Module-map view: ONE zoomable containment level. The whole-repo package overview at the top,
 * or — once you double-click a group card — that package/directory's children (sub-dirs as group
 * cards, files as file cards) wired by the import graph folded to this level. Nodes/edges are laid
 * out in the store (`moduleRfNodes`/`moduleRfEdges`); this component mounts the read-only <ReactFlow>
 * surface and two pure PAINT steps over the placed graph — never a relayout, so positions hold still:
 *   1. `filterVisible` drops file cards a category/Tests toggle hides (group cards always stay);
 *   2. `emphasize` dims every wire until a node is selected, then lights its N-hop import neighbourhood.
 *
 * Navigation is one gesture set: double-click a GROUP card to zoom IN (setModuleFocus); the breadcrumb
 * (the containment trail) zooms OUT. Double-clicking a FILE only selects it (files have no children).
 */

import { useEffect, useMemo, useRef } from "react";
import { ReactFlow, type Edge, type Node, type NodeMouseHandler, type ReactFlowInstance } from "@xyflow/react";
import { useBlueprint, useBlueprintActions } from "../state/StoreContext";
import { moduleNodeTypes, CATEGORY_COLOR } from "./nodes/modulemap/ModuleCardNode";
import { filterVisible, emphasize } from "./moduleMapPaint";
import { crumbsFor, EmptyModuleMapCard, LevelBreadcrumb } from "./ModuleMapChrome";
import { CoveragePanel } from "./CoveragePanel";
import { BeaconArrows } from "./BeaconArrows";
import { MapLegend } from "./MapLegend";
import { CanvasChrome, READONLY_CANVAS_PROPS } from "./canvas/flowCanvasProps";
import { accentForKind } from "../theme/kindColors";
import type { BlockData, ModuleCardData, UnitCardData } from "../derive/moduleLevel";

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
  const showPrivate = useBlueprint((state) => state.showPrivate);
  const { selectModule, toggleModuleSelect, setModuleFocus, openLogicFlow, revealModule, expandModuleChildren, collapseModuleChildren } = useBlueprintActions();

  // Category/test hiding is a pure VISIBILITY filter over the laid-out graph; positions are untouched.
  const { nodes: shownNodes, edges: shownEdges } = useMemo(
    () => filterVisible(nodes, edges, { hiddenCategories, showTests, testIds: index.testIds, showPrivate, privateIds: index.privateIds }),
    [nodes, edges, hiddenCategories, showTests, showPrivate, index.testIds, index.privateIds],
  );
  const hasExpansions = useMemo(() => shownNodes.some(isExpandedPackageOrFile), [shownNodes]);
  // Emphasis is a second pure repaint: dim by default, light the selection's N-hop import reach.
  const { nodes: styledNodes, edges: styledEdges, beacons } = useMemo(
    () => emphasize(shownNodes, shownEdges, selected, radius),
    [shownNodes, shownEdges, selected, radius],
  );

  // Plain click REPLACES the selection; ctrl/cmd+click toggles the node in/out of it, accumulating
  // a multi-selection whose combined reach lights up.
  const onNodeClick: NodeMouseHandler<Node> = (event, node) =>
    event.ctrlKey || event.metaKey ? toggleModuleSelect(node.id) : selectModule(node.id);
  // Double-click a GROUP card (a package/directory) zooms into it; a callable BLOCK opens its logic
  // flow (the map→logic link); a GHOST reveals its off-screen definition (the Map refocuses where it
  // lives); everything else only selects. The breadcrumb is the way back up.
  const onNodeDoubleClick: NodeMouseHandler<Node> = (_event, node) => {
    if (node.type === PACKAGE_KIND) {
      setModuleFocus(node.id);
    } else if (node.type === "ghost") {
      revealModule(node.id);
    } else if (node.type === "block" && (node.data as BlockData).callable) {
      openLogicFlow(node.id);
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
        <BeaconArrows targets={beacons} />
      </ReactFlow>
      <LevelBreadcrumb
        focus={effectiveFocus}
        packageCount={effectiveFocus === null ? nodes.filter((node) => !node.parentId).length : 0}
        crumbs={crumbsFor(effectiveFocus, index)}
        hasExpansions={hasExpansions}
        onFocus={setModuleFocus}
        onExpandAll={() => expandModuleChildren(null)}
        onCollapseAll={() => collapseModuleChildren(null)}
      />
      {isEmpty ? <EmptyModuleMapCard focus={effectiveFocus} /> : null}
      <MapLegend />
      <CoveragePanel />
    </div>
  );
}

// The MiniMap gets untyped `Node`s: a group card reads as a blue package tone, unit/block dots tint
// by their kind, each file dot by its category (the same palette as the cards) so a level stays
// legible at overview zoom.
function miniMapColor(node: Node): string {
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
  return CATEGORY_COLOR[(node.data as ModuleCardData).category];
}

function isExpandedPackageOrFile(node: Node): boolean {
  return (node.type === "package" || node.type === "file") && (node.data as { isExpanded?: boolean }).isExpanded === true;
}

const SURFACE_STYLE: React.CSSProperties = { position: "absolute", inset: 0, background: "#0E1116" };
