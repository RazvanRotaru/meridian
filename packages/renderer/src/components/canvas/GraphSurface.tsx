/**
 * The ONE base canvas every module-family surface mounts (unified-canvas phase A), extracted from
 * ModuleMapView so Map, Service, and the minimal overlay share it by construction. It owns:
 *
 *   - the Map's card/edge component vocabulary (`moduleNodeTypes` + bundle/routed/spool edges);
 *   - the paint chain (`suppressRedundantImports` → `filterRelKinds` → `emphasize`, via
 *     `paintMinimalLevel` so the overlay's colour-parity unit tests pin exactly what runs here) —
 *     pure over the laid-out arrays, so a repaint never moves a card;
 *   - the Visual Highways passes in precedence order (bundle → route → spool), each gated by the
 *     surface's `HighwayFlags`. Ghost cards were already banded OUTSIDE ELK by the layout
 *     (`placeGhostBands`); `emphasize` re-bands the lit ones selection-relative;
 *   - wire hover naming (WireTooltip), opt-in — the overlay historically has none.
 *
 * LIFECYCLE-bound behaviors deliberately stay in each MOUNT, because this component unmounts while
 * the minimal overlay replaces the Map's canvas and the Map lens must live on underneath: the
 * fit-once policy (the Map refits per LEVEL, its guard surviving the overlay; the overlay refits
 * per layout), the Toolbar recenter reaction (`useRecenter` — the Map's stays subscribed, muted,
 * so closing the overlay re-fits the kept selection), and the shared interaction hook
 * (`useModuleNodeInteractions` — its pending select must outlive the canvas swap). A mount passes
 * `onInit` + its `interactions` and keeps its own guards. Floating chrome (breadcrumb, legends,
 * panels, the extract strip) rides in the `children` slot; flow-anchored extras (beacon arrows,
 * the ghost "+" ring) in `flowExtras`, which receives the PAINTED view.
 */

import { useMemo, type ReactNode } from "react";
import { ReactFlow, type Edge, type EdgeTypes, type Node, type ReactFlowInstance } from "@xyflow/react";
import { useBlueprint } from "../../state/StoreContext";
import { moduleNodeTypes } from "../nodes/modulemap/ModuleCardNode";
import { paintMinimalLevel } from "../paintMinimal";
import { WireTooltip } from "../WireTooltip";
import { CanvasChrome, READONLY_CANVAS_PROPS } from "./flowCanvasProps";
import type { ModuleNodeHandlers } from "./useModuleNodeInteractions";
import { useWireHover } from "./useWireHover";
import type { HighwayFlags } from "./surfaceSpec";
import { bundleEdges, BUNDLE_EDGE_TYPE } from "../../layout/edgeBundling";
import { BundledEdge } from "../edges/BundledEdge";
import { routeFrameEdges, ROUTED_EDGE_TYPE } from "../../layout/edgeRouting";
import { RoutedEdge } from "../edges/RoutedEdge";
import { spoolFanEdges, SPOOL_EDGE_TYPE } from "../../layout/edgeSpooling";
import { SpoolEdge } from "../edges/SpoolEdge";

/** Custom edge types: "bundle" renders container-pair highways; "routed" rides a frame's gutter
 * rail (the bus) into member cards; "spool" gathers the remaining open-canvas fan-hub wires. One
 * shared map — a surface whose flags never mint a type simply has no edges wearing it. */
const moduleEdgeTypes: EdgeTypes = { [BUNDLE_EDGE_TYPE]: BundledEdge, [ROUTED_EDGE_TYPE]: RoutedEdge, [SPOOL_EDGE_TYPE]: SpoolEdge };

/** The painted view handed to `flowExtras`: emphasis-styled nodes + the selected-step beacons. */
export interface SurfaceFlowView {
  nodes: Node[];
  beacons: ReadonlySet<string>;
}

export interface GraphSurfaceProps {
  /** Laid-out (and per-surface visibility-filtered) nodes/edges — positions are never touched here. */
  nodes: Node[];
  edges: Edge[];
  /** Which Highways passes this surface's shape supports (from its SurfaceSpec). */
  highways: HighwayFlags;
  miniMapColor: (node: Node) => string;
  /** The mount's `useModuleNodeInteractions(...)` handlers — called in the MOUNT, not here, so the
   * click-debounce lifetime tracks the lens rather than this (overlay-swappable) canvas. */
  interactions: ModuleNodeHandlers;
  /** The mount keeps the fit-once guard and instance ref, so the init callback threads out to it. */
  onInit?: (instance: ReactFlowInstance<Node, Edge>) => void;
  /** Wire hover naming (WireTooltip) — on for the Map/Service canvas, historically off on the overlay. */
  wireHover?: boolean;
  /** Extras that must render INSIDE the flow (beacon arrows, the overlay's ghost "+" ring). */
  flowExtras?: (view: SurfaceFlowView) => ReactNode;
  /** Floating chrome (breadcrumb, legends, panels, action strips), absolutely positioned over the canvas. */
  children?: ReactNode;
}

export function GraphSurface(props: GraphSurfaceProps) {
  const selected = useBlueprint((state) => state.moduleSelected);
  const radius = useBlueprint((state) => state.moduleRadius);
  const highlightMode = useBlueprint((state) => state.highlightMode);
  const hiddenRelKinds = useBlueprint((state) => state.hiddenRelKinds);
  const showHighways = useBlueprint((state) => state.showHighways);

  // The ONE paint chain: suppress redundant imports → drop toggled-off relationship kinds →
  // emphasize (dim at rest, light the selection's N-hop reach). A pure repaint — positions hold.
  const { nodes: paintedNodes, edges: paintedEdges, beacons } = useMemo(
    () => paintMinimalLevel(props.nodes, props.edges, selected, radius, highlightMode, hiddenRelKinds),
    [props.nodes, props.edges, selected, radius, highlightMode, hiddenRelKinds],
  );
  // Visual Highways, per-surface passes in precedence order: (1) container-pair BUNDLES merge
  // parallel cross-container edges; (2) frame-crossing wires ROUTE through the frame's gutter rail
  // (the bus) so no wire ever travels behind a member card; (3) the remaining open-canvas fan-hub
  // wires SPOOL into shared trunks. Off draws every edge as a plain curve; a selected node's own
  // wires always escape the container bundles so its links read out of the highway they'd join.
  const highwayEdges = useMemo(
    () => (showHighways ? applyHighways(paintedEdges, paintedNodes, selected, props.highways) : paintedEdges),
    [showHighways, paintedEdges, paintedNodes, selected, props.highways],
  );
  const wire = useWireHover(highwayEdges, paintedNodes, props.wireHover === true);

  return (
    <div style={SURFACE_STYLE}>
      <ReactFlow<Node, Edge>
        nodes={paintedNodes}
        edges={wire.edges}
        nodeTypes={moduleNodeTypes}
        edgeTypes={moduleEdgeTypes}
        onInit={props.onInit}
        onNodeClick={props.interactions.onNodeClick}
        onNodeDoubleClick={props.interactions.onNodeDoubleClick}
        onPaneClick={props.interactions.onPaneClick}
        onEdgeMouseEnter={wire.onEdgeMouseEnter}
        onEdgeMouseLeave={wire.onEdgeMouseLeave}
        {...READONLY_CANVAS_PROPS}
      >
        <CanvasChrome nodeColor={props.miniMapColor} />
        {props.flowExtras?.({ nodes: paintedNodes, beacons })}
      </ReactFlow>
      {wire.hover ? <WireTooltip hover={wire.hover} /> : null}
      {props.children}
    </div>
  );
}

/** The three highway passes over the painted edges, each opt-in per the surface's flags. */
function applyHighways(edges: Edge[], nodes: Node[], selected: ReadonlySet<string>, flags: HighwayFlags): Edge[] {
  let out = edges;
  if (flags.bundling) {
    out = bundleEdges(out, nodes, selected);
  }
  if (flags.routing) {
    out = routeFrameEdges(out, nodes);
  }
  if (flags.spooling) {
    out = spoolFanEdges(out);
  }
  return out;
}

/** The shared canvas root — exported so a mount's own replacement branches (the overlay split)
 * keep the identical backdrop. */
export const SURFACE_STYLE: React.CSSProperties = { position: "absolute", inset: 0, background: "#0E1116" };
