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
import { CanvasChrome, MINIMAP_NODE_CAP, READONLY_CANVAS_PROPS } from "./flowCanvasProps";
import { MapLod } from "./MapLod";
import type { ModuleNodeHandlers } from "./useModuleNodeInteractions";
import { useWireHover } from "./useWireHover";
import type { HighwayFlags } from "./surfaceSpec";
import { BUNDLE_EDGE_TYPE } from "../../layout/edgeBundling";
import { BundledEdge } from "../edges/BundledEdge";
import { ROUTED_EDGE_TYPE } from "../../layout/edgeRouting";
import { RoutedEdge } from "../edges/RoutedEdge";
import { SPOOL_EDGE_TYPE } from "../../layout/edgeSpooling";
import { SpoolEdge } from "../edges/SpoolEdge";
import { RIBBON_EDGE_TYPE } from "../../layout/parallelWires";
import { RibbonEdge } from "../edges/RibbonEdge";
import { CYCLE_EDGE_TYPE } from "../../layout/cycleFusion";
import { CycleEdge } from "../edges/CycleEdge";
import { WireEdge, WIRE_EDGE_TYPE } from "../edges/WireEdge";
import { withReactFlowDimensions } from "./reactFlowDimensions";
import { useNodeDiffPreview } from "../review/useNodeDiffPreview";
import { GhostHierarchyEdge, GHOST_HIERARCHY_EDGE_TYPE } from "../edges/GhostHierarchyEdge";
import { prepareCanvasEdges } from "./presentationEdgePipeline";

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
  [GHOST_HIERARCHY_EDGE_TYPE]: GhostHierarchyEdge,
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
  /** PR review only: show a scrollable source diff after dwelling over a directly changed node. */
  nodeDiffPreview?: boolean;
  /** Extras that must render INSIDE the flow (beacon arrows, the overlay's ghost "+" ring). */
  flowExtras?: (view: SurfaceFlowView) => ReactNode;
  /** Floating chrome (breadcrumb, legends, panels, action strips), absolutely positioned over the canvas. */
  children?: ReactNode;
}

export function GraphSurface(props: GraphSurfaceProps) {
  const selected = useBlueprint((state) => state.moduleSelected);
  const index = useBlueprint((state) => state.index);
  const radius = useBlueprint((state) => state.moduleRadius);
  const highlightMode = useBlueprint((state) => state.highlightMode);
  const hiddenRelKinds = useBlueprint((state) => state.hiddenRelKinds);
  const showHighways = useBlueprint((state) => state.showHighways);
  const groupGhostsByParent = useBlueprint((state) => state.groupGhostsByParent);

  // The ONE paint chain: suppress redundant imports → drop toggled-off relationship kinds →
  // emphasize (dim at rest, light the selection's N-hop reach). A pure repaint — positions hold.
  const { nodes: paintedNodes, edges: paintedEdges, beacons } = useMemo(
    () => paintMinimalLevel(props.nodes, props.edges, selected, radius, highlightMode, hiddenRelKinds, {
      index,
      groupByParent: groupGhostsByParent,
      expandedGroupIds: props.interactions.expandedGhostGroupIds,
    }),
    [props.nodes, props.edges, selected, radius, highlightMode, hiddenRelKinds, index, groupGhostsByParent, props.interactions.expandedGhostGroupIds],
  );
  // Ghost inspection is deliberately downstream of the shared paint chain. It clones only the
  // matching card's data, preserving every id, coordinate, parent and edge/layout input.
  const displayedNodes = useMemo(
    () => decorateInspectedGhost(paintedNodes, props.interactions.inspectedGhostId),
    [paintedNodes, props.interactions.inspectedGhostId],
  );
  // The module-family layouts keep their canonical geometry in `style.width/height`, which all
  // routing and overlay passes below intentionally continue to read. React Flow's MiniMap checks
  // only top-level dimensions on the controlled user node, so expose the same numbers at the final
  // library boundary after the paint-only inspection decoration.
  const reactFlowNodes = useMemo(() => withReactFlowDimensions(displayedNodes), [displayedNodes]);
  // Presentation-only parent→member spokes split off before every semantic edge pass. The helper
  // runs salience, cycle, ribbon and enabled highway transforms only over actual relationships.
  const preparedEdges = useMemo(
    () => prepareCanvasEdges(paintedEdges, paintedNodes, selected, showHighways, props.highways),
    [paintedEdges, paintedNodes, selected, showHighways, props.highways],
  );
  const wire = useWireHover(preparedEdges.semanticEdges, paintedNodes, props.wireHover === true);
  // Append hierarchy spokes AFTER interaction dressing too: their exact objects never acquire a
  // pulse, label, hit width, tooltip, inspector subject, or semantic z-order.
  const renderedEdges = useMemo(
    () => [...wire.edges, ...preparedEdges.hierarchyEdges],
    [wire.edges, preparedEdges.hierarchyEdges],
  );
  const nodeDiffEnabled = props.nodeDiffPreview === true;
  const nodeDiff = useNodeDiffPreview(nodeDiffEnabled);

  return (
    <div style={SURFACE_STYLE}>
      <ReactFlow<Node, Edge>
        nodes={reactFlowNodes}
        edges={renderedEdges}
        nodeTypes={moduleNodeTypes}
        edgeTypes={moduleEdgeTypes}
        onInit={props.onInit}
        onNodeClick={props.interactions.onNodeClick}
        onNodeDoubleClick={props.interactions.onNodeDoubleClick}
        onNodeMouseEnter={nodeDiffEnabled ? nodeDiff.onNodeMouseEnter : undefined}
        onNodeMouseMove={nodeDiffEnabled ? nodeDiff.onNodeMouseMove : undefined}
        onNodeMouseLeave={nodeDiffEnabled ? nodeDiff.onNodeMouseLeave : undefined}
        onPaneMouseMove={nodeDiffEnabled ? nodeDiff.onPaneMouseMove : undefined}
        onPaneClick={() => {
          // A pane click unpins the inspector AND clears the selection (the mount's handler).
          wire.clearInspected();
          props.interactions.onPaneClick();
        }}
        onEdgeMouseEnter={wire.onEdgeMouseEnter}
        onEdgeMouseLeave={wire.onEdgeMouseLeave}
        onEdgeClick={wire.onEdgeClick}
        // A fully disclosed high-degree ghost neighbourhood may contain hundreds of off-viewport
        // cards. Keep them canonical in state while asking React Flow to mount only visible DOM.
        onlyRenderVisibleElements
        // Manual z: basic mode ADDS a nested endpoint's node-z to the edge — see useWireHover's z rule.
        zIndexMode="manual"
        {...READONLY_CANVAS_PROPS}
      >
        <CanvasChrome nodeColor={props.miniMapColor} minimap={reactFlowNodes.length <= MINIMAP_NODE_CAP} />
        <MapLod />
        {props.flowExtras?.({ nodes: displayedNodes, beacons })}
      </ReactFlow>
      {wire.hover ? <WireTooltip hover={wire.hover} /> : null}
      {wire.inspectedPair ? (
        <WireInspector pair={wire.inspectedPair} labelOf={wire.labelOf} onClose={wire.clearInspected} onDrill={wire.inspect} />
      ) : null}
      {nodeDiff.layer}
      {props.children}
    </div>
  );
}

/** Add the transient inspection flag without feeding it back into layout or graph selection. */
export function decorateInspectedGhost(nodes: Node[], inspectedGhostId: string | null): Node[] {
  if (inspectedGhostId === null) {
    return nodes;
  }
  const index = nodes.findIndex((node) => node.type === "ghost" && node.id === inspectedGhostId);
  if (index < 0) {
    return nodes;
  }
  const node = nodes[index];
  const decorated = [...nodes];
  decorated[index] = { ...node, data: { ...node.data, inspected: true } };
  return decorated;
}

/** The shared canvas root — exported so a mount's own replacement branches (the overlay split)
 * keep the identical backdrop. */
export const SURFACE_STYLE: React.CSSProperties = { position: "absolute", inset: 0, background: "#0E1116" };
