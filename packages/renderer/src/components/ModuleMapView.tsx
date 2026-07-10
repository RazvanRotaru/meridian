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

import { useEffect, useMemo, useRef, useState } from "react";
import { ReactFlow, type Edge, type EdgeTypes, type Node, type ReactFlowInstance } from "@xyflow/react";
import { useBlueprint, useBlueprintActions } from "../state/StoreContext";
import { moduleNodeTypes } from "./nodes/modulemap/ModuleCardNode";
import { filterVisible, filterRelKinds, suppressRedundantImports, emphasize } from "./moduleMapPaint";
import { crumbsFor, EmptyModuleMapCard, LevelBreadcrumb } from "./ModuleMapChrome";
import { CoveragePanel } from "./CoveragePanel";
import { BeaconArrows } from "./BeaconArrows";
import { MapLegend } from "./MapLegend";
import { CanvasChrome, READONLY_CANVAS_PROPS } from "./canvas/flowCanvasProps";
import { useRecenter } from "./canvas/useRecenter";
import { useModuleNodeInteractions } from "./canvas/useModuleNodeInteractions";
import { MinimalGraphView } from "./MinimalGraphView";
import { ReviewPanel } from "./review/ReviewPanel";
import { accentForKind } from "../theme/kindColors";
import { bundleEdges, BUNDLE_EDGE_TYPE } from "../layout/edgeBundling";
import { BundledEdge } from "./edges/BundledEdge";
import { routeFrameEdges, ROUTED_EDGE_TYPE } from "../layout/edgeRouting";
import { RoutedEdge } from "./edges/RoutedEdge";
import { spoolFanEdges, SPOOL_EDGE_TYPE } from "../layout/edgeSpooling";
import { SpoolEdge } from "./edges/SpoolEdge";
import { WireTooltip, type WireHover } from "./WireTooltip";
import type { BlockData, UnitCardData } from "../derive/moduleLevel";

const PACKAGE_KIND = "package";

/** Custom edge types: "bundle" renders container-pair highways; "routed" rides a frame's gutter
 * rail (the bus) into member cards; "spool" gathers the remaining open-canvas fan-hub wires. */
const moduleEdgeTypes: EdgeTypes = { [BUNDLE_EDGE_TYPE]: BundledEdge, [ROUTED_EDGE_TYPE]: RoutedEdge, [SPOOL_EDGE_TYPE]: SpoolEdge };

export function ModuleMapView() {
  const nodes = useBlueprint((state) => state.moduleRfNodes);
  const edges = useBlueprint((state) => state.moduleRfEdges);
  const selected = useBlueprint((state) => state.moduleSelected);
  const layoutStatus = useBlueprint((state) => state.moduleLayoutStatus);
  const effectiveFocus = useBlueprint((state) => state.moduleEffectiveFocus);
  const radius = useBlueprint((state) => state.moduleRadius);
  const highlightMode = useBlueprint((state) => state.highlightMode);
  const index = useBlueprint((state) => state.index);
  const hiddenCategories = useBlueprint((state) => state.hiddenCategories);
  const hiddenRelKinds = useBlueprint((state) => state.hiddenRelKinds);
  const showTests = useBlueprint((state) => state.showTests);
  const showPrivate = useBlueprint((state) => state.showPrivate);
  const showHighways = useBlueprint((state) => state.showHighways);
  const minimalOpen = useBlueprint((state) => state.minimalSeedIds.length > 0);
  const { buildMinimalGraph, setModuleFocus } = useBlueprintActions();
  const { onNodeClick, onNodeDoubleClick, onPaneClick } = useModuleNodeInteractions();
  // Muted while the minimal overlay covers this canvas — the overlay's own recenter must win.
  useRecenter(useMemo(() => [...selected], [selected]), { enabled: !minimalOpen });

  // Category/test hiding is a pure VISIBILITY filter over the laid-out graph; positions are untouched.
  const { nodes: shownNodes, edges: visibleEdges } = useMemo(
    () => filterVisible(nodes, edges, { hiddenCategories, showTests, testIds: index.testIds, showPrivate, privateIds: index.privateIds }),
    [nodes, edges, hiddenCategories, showTests, showPrivate, index.testIds, index.privateIds],
  );
  // A second pure paint filter: suppress redundant imports (covered by dep edges) then drop toggled-off kinds.
  const shownEdges = useMemo(() => filterRelKinds(suppressRedundantImports(visibleEdges), hiddenRelKinds), [visibleEdges, hiddenRelKinds]);
  // Emphasis is a second pure repaint: dim by default, light the selection's N-hop import reach.
  const { nodes: styledNodes, edges: styledEdges, beacons } = useMemo(
    () => emphasize(shownNodes, shownEdges, selected, radius, highlightMode),
    [shownNodes, shownEdges, selected, radius, highlightMode],
  );
  // Visual Highways, three passes in precedence order: (1) container-pair BUNDLES merge parallel
  // cross-container edges; (2) frame-crossing wires ROUTE through the frame's gutter rail (the bus)
  // so no wire ever travels behind a member card; (3) the remaining open-canvas fan-hub wires SPOOL
  // into shared trunks. Off draws every edge as a plain curve; a selected node's own wires always
  // escape the container bundles so its links read out of the highway they'd otherwise join.
  const bundledEdges = useMemo(
    () => (showHighways ? spoolFanEdges(routeFrameEdges(bundleEdges(styledEdges, styledNodes, selected), styledNodes)) : styledEdges),
    [showHighways, styledEdges, styledNodes, selected],
  );

  // Wire HOVER: pointing at one strand names it (kind × weight, source → target) and lights it
  // alone — the disambiguator for strands sharing a bus/trunk. A cheap overlay pass: hover never
  // recomputes bundling/routing geometry, it only boosts one edge's paint. Bundle highways keep
  // their own breakdown tooltip, so they opt out of this one.
  const [wireHover, setWireHover] = useState<WireHover | null>(null);
  const labelById = useMemo(() => {
    const labels = new Map<string, string>();
    for (const node of styledNodes) {
      labels.set(node.id, ((node.data as { label?: string }).label ?? node.id.split("/").pop()) as string);
    }
    return labels;
  }, [styledNodes]);
  const hoverableEdges = useMemo(
    () =>
      bundledEdges.map((edge) => {
        if (edge.type === BUNDLE_EDGE_TYPE) {
          return edge;
        }
        const hovered = edge.id === wireHover?.id;
        return {
          ...edge,
          interactionWidth: 14,
          style: hovered ? { ...edge.style, opacity: 1, strokeWidth: ((edge.style?.strokeWidth as number) ?? 1.5) + 1.2 } : edge.style,
        };
      }),
    [bundledEdges, wireHover?.id],
  );
  const onEdgeMouseEnter = (event: React.MouseEvent, edge: Edge) => {
    if (edge.type === BUNDLE_EDGE_TYPE) {
      return;
    }
    const data = edge.data as { depKind?: string; category?: string; weight?: number } | undefined;
    setWireHover({
      id: edge.id,
      x: event.clientX,
      y: event.clientY,
      kind: data?.depKind ?? data?.category ?? "wire",
      weight: data?.weight ?? 1,
      source: labelById.get(edge.source) ?? edge.source,
      target: labelById.get(edge.target) ?? edge.target,
    });
  };
  const onEdgeMouseLeave = () => setWireHover(null);

  // Fit once per RELAYOUT: `moduleRfNodes` only changes when the level does, so clearing the guard
  // on `effectiveFocus` (a focus change) OR `showTests` (the Tests toggle relayouts + re-coords the
  // level) re-fits the fresh level to the viewport. Category/Private toggles and radius are
  // paint-only (they never change `nodes`), so they correctly do NOT trigger a refit.
  const rfRef = useRef<ReactFlowInstance<Node, Edge> | null>(null);
  const fitted = useRef(false);
  useEffect(() => {
    fitted.current = false;
  }, [effectiveFocus, showTests]);
  useEffect(() => {
    if (!rfRef.current || nodes.length === 0 || fitted.current) {
      return;
    }
    fitted.current = true;
    requestAnimationFrame(() => rfRef.current?.fitView({ padding: 0.2, duration: 400, minZoom: 0.01 }));
  }, [nodes]);

  const isEmpty = nodes.length === 0 && layoutStatus === "ready";

  // The built minimal graph REPLACES the level canvas while open (after every hook above, so the
  // hook order is stable across open/close). Closing returns here with the selection intact. When a
  // PR review seeded the graph, ReviewPanel rides on the right (it self-hides when review is null —
  // a hand-built minimal graph — or when the reader hid it; MinimalGraphView then offers "Review").
  if (minimalOpen) {
    return (
      <div style={SURFACE_STYLE}>
        <div style={REVIEW_SPLIT_STYLE}>
          <div style={REVIEW_GRAPH_STYLE}>
            <MinimalGraphView />
          </div>
          <ReviewPanel />
        </div>
      </div>
    );
  }

  return (
    <div style={SURFACE_STYLE}>
      <ReactFlow<Node, Edge>
        nodes={styledNodes}
        edges={hoverableEdges}
        nodeTypes={moduleNodeTypes}
        edgeTypes={moduleEdgeTypes}
        onInit={(instance) => {
          rfRef.current = instance;
        }}
        onNodeClick={onNodeClick}
        onNodeDoubleClick={onNodeDoubleClick}
        onPaneClick={onPaneClick}
        onEdgeMouseEnter={onEdgeMouseEnter}
        onEdgeMouseLeave={onEdgeMouseLeave}
        {...READONLY_CANVAS_PROPS}
      >
        <CanvasChrome nodeColor={miniMapColor} />
        <BeaconArrows targets={beacons} />
      </ReactFlow>
      {wireHover ? <WireTooltip hover={wireHover} /> : null}
      <LevelBreadcrumb
        focus={effectiveFocus}
        packageCount={effectiveFocus === null ? nodes.filter((node) => !node.parentId).length : 0}
        crumbs={crumbsFor(effectiveFocus, index)}
        onFocus={setModuleFocus}
      />
      {selected.size >= 1 ? <BuildMinimalGraphButton count={selected.size} onBuild={buildMinimalGraph} /> : null}
      {isEmpty ? <EmptyModuleMapCard focus={effectiveFocus} /> : null}
      <MapLegend hasSteps={shownNodes.some((node) => node.type === "step")} hasSelection={selected.size > 0} />
      <CoveragePanel />
    </div>
  );
}

/** The floating action a selection (one card or more) reveals: extract it into the minimal-graph overlay. */
function BuildMinimalGraphButton(props: { count: number; onBuild: () => void }) {
  return (
    <button type="button" style={BUILD_BUTTON_STYLE} onClick={props.onBuild}>
      Extract selection ({props.count})
    </button>
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
  // File dots wear the neutral file-family accent (category lives on the card's text chip, not a hue).
  return accentForKind("module");
}

const SURFACE_STYLE: React.CSSProperties = { position: "absolute", inset: 0, background: "#0E1116" };
// PR-review split: the minimal-graph overlay flexes to fill, the flow panel takes its fixed rail on the right.
const REVIEW_SPLIT_STYLE: React.CSSProperties = { position: "absolute", inset: 0, display: "flex" };
const REVIEW_GRAPH_STYLE: React.CSSProperties = { position: "relative", flex: 1, minWidth: 0 };
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
