/**
 * The React Flow surface. Nodes/edges are fully derived in the store, so the canvas is a
 * controlled, read-only view: not draggable, not connectable, selectable (selection is driven
 * into the store via onNodeClick). Dark color mode, dotted background, kind-coloured MiniMap.
 */

import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  type Node,
  type NodeMouseHandler,
} from "@xyflow/react";
import { accentForKind } from "../theme/kindColors";
import { useBlueprint, useBlueprintActions } from "../state/StoreContext";
import type { BlueprintNode, BlueprintEdge, BlueprintNodeData } from "../layout/rfTypes";
import { nodeTypes } from "./nodes/nodeTypes";
import { edgeTypes } from "./edges/edgeTypes";
import { Toolbar } from "./Toolbar";

export function BlueprintCanvas(props: { preselectedEnv: string | null }) {
  const nodes = useBlueprint((state) => state.rfNodes);
  const edges = useBlueprint((state) => state.rfEdges);
  const { select, diveInto } = useBlueprintActions();
  const onNodeClick: NodeMouseHandler<BlueprintNode> = (_event, node) => select(node.id);
  // Double-clicking a container's frame dives INTO it (Unreal-Blueprints black-box drill-down);
  // a leaf does nothing. Header double-clicks stop propagation, so they never reach here.
  const onNodeDoubleClick: NodeMouseHandler<BlueprintNode> = (_event, node) => {
    if (node.data.isContainer) {
      diveInto(node.id);
    }
  };
  return (
    <ReactFlow<BlueprintNode, BlueprintEdge>
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      onNodeClick={onNodeClick}
      onNodeDoubleClick={onNodeDoubleClick}
      onPaneClick={() => select(null)}
      colorMode="dark"
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable
      // Click-drag pans the canvas; it must never rubber-band select or text-highlight node labels.
      panOnDrag
      selectionOnDrag={false}
      style={{ userSelect: "none" }}
      fitView
      fitViewOptions={{ padding: 0.2, minZoom: 0.01 }}
      // A big isolated flow can be hundreds of nodes; let the canvas zoom far out to see it all
      // (React Flow's default minZoom of 0.5 clips large graphs) while keeping a sane zoom-in cap.
      minZoom={0.01}
      maxZoom={4}
      // Double-click is repurposed for diving, so the pane must not also zoom on it.
      zoomOnDoubleClick={false}
      proOptions={{ hideAttribution: true }}
    >
      <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="#222732" />
      <Controls showInteractive={false} />
      <MiniMap pannable zoomable nodeColor={miniMapColor} maskColor="rgba(8,10,14,0.7)" />
      <Toolbar preselectedEnv={props.preselectedEnv} />
    </ReactFlow>
  );
}

// MiniMap is generic over the default `Node`, so we narrow its untyped data to ours here.
function miniMapColor(node: Node): string {
  return accentForKind((node.data as BlueprintNodeData).node.kind);
}
