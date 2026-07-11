/**
 * The ONE base canvas every module-family surface mounts (unified-canvas phase A), extracted from
 * ModuleMapView so Map, Service, UI, and the minimal overlay share it by construction. It owns:
 *
 *   - the Map's card/edge component vocabulary (`moduleNodeTypes` + bundle/routed/ribbon/cycle/
 *     spool/wire edges);
 *   - the paint chain (`suppressRedundantImports` → `filterRelKinds` → `emphasize`, via
 *     `paintMinimalLevel` so the overlay's colour-parity unit tests pin exactly what runs here) —
 *     pure over the laid-out arrays, so a repaint never moves a card;
 *   - the wire SALIENCE passes, canvas-wide by construction: dense levels FADE weight-1 strands
 *     (`fadeFaintWires` — the pills filter by kind, this by strength) and A⇄B mutual pairs FUSE
 *     into one double-headed tension wire (`fuseCycles` — typed, so every later pass leaves it
 *     alone);
 *   - the Visual Highways passes in precedence order (bundle → ribbon → route → spool), bundling/
 *     routing/spooling gated by the surface's `HighwayFlags`. The RIBBON fold always runs — even
 *     with Highways off — because overlapping same-pair strands are illegible in either mode; it
 *     PRECEDES routing so a multi-kind pair rides a frame's rail as ONE striped cable. Ghost cards
 *     were already banded OUTSIDE ELK by the layout (`placeGhostBands`); `emphasize` re-bands the
 *     lit ones selection-relative;
 *   - WIRES BEHIND CARDS on every surface: `zIndexMode="manual"` + the per-wire z the interaction
 *     hook assigns (cross-canvas under everything; intra-frame at its nesting depth);
 *   - wire hover naming (WireTooltip) and the click-pinned Wire INSPECTOR (evidence down to
 *     file:line), opt-in via `wireHover` — the overlay historically has neither;
 *   - the semantic-zoom ORIENTATION tier (`MapLod`) — pure CSS level-of-detail over the shared
 *     cards' lod-* class tags, so every surface reads as a map at overview zoom.
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
import { WireInspector } from "../WireInspector";
import { CanvasChrome, READONLY_CANVAS_PROPS } from "./flowCanvasProps";
import { MapLod } from "./MapLod";
import type { ModuleNodeHandlers } from "./useModuleNodeInteractions";
import { useWireHover } from "./useWireHover";
import type { HighwayFlags } from "./surfaceSpec";
import { bundleEdges, BUNDLE_EDGE_TYPE } from "../../layout/edgeBundling";
import { BundledEdge } from "../edges/BundledEdge";
import { routeFrameEdges, ROUTED_EDGE_TYPE } from "../../layout/edgeRouting";
import { RoutedEdge } from "../edges/RoutedEdge";
import { spoolFanEdges, SPOOL_EDGE_TYPE } from "../../layout/edgeSpooling";
import { SpoolEdge } from "../edges/SpoolEdge";
import { foldPairRibbons, RIBBON_EDGE_TYPE } from "../../layout/parallelWires";
import { RibbonEdge } from "../edges/RibbonEdge";
import { CYCLE_EDGE_TYPE, fuseCycles } from "../../layout/cycleFusion";
import { CycleEdge } from "../edges/CycleEdge";
import { fadeFaintWires } from "../../layout/wireSalience";
import { WireEdge, WIRE_EDGE_TYPE } from "../edges/WireEdge";
import { withReactFlowDimensions } from "./reactFlowDimensions";

/** Custom edge types: "bundle" renders container-pair highways; "routed" rides a frame's gutter
 * rail (the bus) into member cards; "ribbon" is the striped multi-kind pair cable; "cycle" the
 * double-headed mutual-coupling wire; "spool" gathers the remaining open-canvas fan-hub wires;
 * "wire" is the plain curve every remaining edge retypes to on hover-enabled surfaces (it carries
 * the lit direction pulse). One shared map — a surface whose flags never mint a type simply has no
 * edges wearing it. */
const moduleEdgeTypes: EdgeTypes = {
  [BUNDLE_EDGE_TYPE]: BundledEdge,
  [ROUTED_EDGE_TYPE]: RoutedEdge,
  [RIBBON_EDGE_TYPE]: RibbonEdge,
  [CYCLE_EDGE_TYPE]: CycleEdge,
  [SPOOL_EDGE_TYPE]: SpoolEdge,
  [WIRE_EDGE_TYPE]: WireEdge,
};

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
  /** Wire chrome — hover naming (WireTooltip), the click-pinned Wire Inspector, direction pulses —
   * on for the module lenses, historically off on the minimal overlay (mostly lit at rest). */
  wireHover?: boolean;
  /** The Map's orientation LOD hides card bodies at low zoom. The review overlay opts out because
   * its group summaries contain the explicit changed-files expansion action. */
  orientationLod?: boolean;
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
  // The module-family layouts keep their canonical geometry in `style.width/height`, which all
  // routing and overlay passes below intentionally continue to read. React Flow's MiniMap checks
  // only top-level dimensions on the controlled user node, so expose the same numbers at the final
  // library boundary without changing the stored/layout/paint node shapes.
  const reactFlowNodes = useMemo(() => withReactFlowDimensions(paintedNodes), [paintedNodes]);
  // Two salience passes precede the highways (see the header): fade weight-1 strands on dense
  // levels, fuse A⇄B mutual pairs into one typed tension wire.
  const preppedEdges = useMemo(() => fuseCycles(fadeFaintWires(paintedEdges)), [paintedEdges]);
  // Visual Highways per the surface's flags; the ribbon fold runs in EITHER mode (overlapping
  // same-pair strands are illegible with Highways off too). A selected node's own wires always
  // escape the container bundles so its links read out of the highway they'd join.
  const highwayEdges = useMemo(
    () => (showHighways ? applyHighways(preppedEdges, paintedNodes, selected, props.highways) : foldPairRibbons(preppedEdges)),
    [showHighways, preppedEdges, paintedNodes, selected, props.highways],
  );
  const wire = useWireHover(highwayEdges, paintedNodes, props.wireHover === true);

  return (
    <div style={SURFACE_STYLE}>
      <ReactFlow<Node, Edge>
        nodes={reactFlowNodes}
        edges={wire.edges}
        nodeTypes={moduleNodeTypes}
        edgeTypes={moduleEdgeTypes}
        onInit={props.onInit}
        onNodeClick={props.interactions.onNodeClick}
        onNodeDoubleClick={props.interactions.onNodeDoubleClick}
        onPaneClick={() => {
          // A pane click unpins the inspector AND clears the selection (the mount's handler).
          wire.clearInspected();
          props.interactions.onPaneClick();
        }}
        onEdgeMouseEnter={wire.onEdgeMouseEnter}
        onEdgeMouseLeave={wire.onEdgeMouseLeave}
        onEdgeClick={wire.onEdgeClick}
        // Manual z: basic mode ADDS a nested endpoint's node-z to the edge — see useWireHover's z rule.
        zIndexMode="manual"
        {...READONLY_CANVAS_PROPS}
      >
        <CanvasChrome nodeColor={props.miniMapColor} />
        <MapLod enabled={props.orientationLod !== false} />
        {props.flowExtras?.({ nodes: paintedNodes, beacons })}
      </ReactFlow>
      {wire.hover ? <WireTooltip hover={wire.hover} /> : null}
      {wire.inspectedPair ? (
        <WireInspector pair={wire.inspectedPair} labelOf={wire.labelOf} onClose={wire.clearInspected} onDrill={wire.inspect} />
      ) : null}
      {props.children}
    </div>
  );
}

/** The highway passes over the salience-prepped edges, in precedence order — bundling, routing and
 * spooling each opt-in per the surface's flags; the ribbon fold is unconditional (and must sit
 * between bundling and routing so a multi-kind pair rides a frame's rail as ONE striped cable). */
function applyHighways(edges: Edge[], nodes: Node[], selected: ReadonlySet<string>, flags: HighwayFlags): Edge[] {
  let out = edges;
  if (flags.bundling) {
    out = bundleEdges(out, nodes, selected);
  }
  out = foldPairRibbons(out);
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
