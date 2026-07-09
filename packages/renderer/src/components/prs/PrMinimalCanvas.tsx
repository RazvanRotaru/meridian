/**
 * The embedded, read-only React Flow surface that draws the analyzed PR's minimal graph — the
 * changed source files (ringed) plus their 1-hop import neighbours. It renders inside its OWN
 * <ReactFlowProvider> so it never shares React Flow state with the primary canvas, and it hands
 * React Flow the store-free PR node components (PR_NODE_TYPES) so it needs no StoreContext index.
 * The minimap is off: PR nodes carry the minimal-graph data shape, not the primary node data a
 * kind-coloured minimap would read.
 */

import { ReactFlow, ReactFlowProvider, type Edge, type Node } from "@xyflow/react";
import { CanvasChrome, READONLY_CANVAS_PROPS } from "../canvas/flowCanvasProps";
import { PR_NODE_TYPES } from "../prreview/nodeTypes";

export function PrMinimalCanvas(props: { nodes: Node[]; edges: Edge[] }) {
  return (
    <ReactFlowProvider>
      <ReactFlow nodes={props.nodes} edges={props.edges} nodeTypes={PR_NODE_TYPES} {...READONLY_CANVAS_PROPS}>
        <CanvasChrome nodeColor={() => NEUTRAL_NODE_COLOR} minimap={false} />
      </ReactFlow>
    </ReactFlowProvider>
  );
}

const NEUTRAL_NODE_COLOR = "#3B4452";
