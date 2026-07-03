/**
 * The React Flow surface. Nodes/edges are fully derived in the store, so the canvas is a
 * controlled, read-only view: not draggable, not connectable, selectable (selection is driven
 * into the store via onNodeClick). Dark color mode, dotted background, kind-coloured MiniMap.
 */

import { useEffect } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  Panel,
  ReactFlow,
  useReactFlow,
  type Node,
  type NodeMouseHandler,
} from "@xyflow/react";
import { accentForKind } from "../theme/kindColors";
import { useBlueprint, useBlueprintActions } from "../state/StoreContext";
import type { BlueprintNode, BlueprintEdge, BlueprintNodeData } from "../layout/rfTypes";
import { nodeTypes } from "./nodes/nodeTypes";
import { edgeTypes } from "./edges/edgeTypes";
import { Toolbar } from "./Toolbar";
import { DetailPanel } from "./DetailPanel";

export function BlueprintCanvas(props: { preselectedEnv: string | null }) {
  const nodes = useBlueprint((state) => state.rfNodes);
  const edges = useBlueprint((state) => state.rfEdges);
  const { select, selectEdge, diveInto } = useBlueprintActions();
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
      onEdgeClick={(_event, edge) => selectEdge(edge.id)}
      onPaneClick={() => select(null)}
      colorMode="dark"
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable
      fitView
      // Double-click is repurposed for diving, so the pane must not also zoom on it.
      zoomOnDoubleClick={false}
      proOptions={{ hideAttribution: true }}
    >
      <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="#222732" />
      <Controls showInteractive={false} />
      <MiniMap pannable zoomable nodeColor={miniMapColor} maskColor="rgba(8,10,14,0.7)" />
      <Toolbar preselectedEnv={props.preselectedEnv} />
      <Panel position="top-right">
        <DetailPanel />
      </Panel>
      <FitOnRelayout />
    </ReactFlow>
  );
}

/**
 * Re-frame the camera after every structural relayout (expand/dive/mode switch) — without
 * this, a dive lands on an empty viewport because the new layout has different bounds.
 * Selection does not bump layoutSeq, so clicking never yanks the camera.
 */
function FitOnRelayout() {
  const layoutSeq = useBlueprint((state) => state.layoutSeq);
  const layoutStatus = useBlueprint((state) => state.layoutStatus);
  const { fitView } = useReactFlow();
  useEffect(() => {
    if (layoutStatus !== "ready") {
      return undefined;
    }
    // Two frames: one for React to commit the new nodes, one for React Flow to measure them —
    // fitting earlier computes bounds from stale/unmeasured boxes and crops the graph.
    let inner: number | undefined;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => {
        void fitView({ padding: 0.08, duration: 420, maxZoom: 1.1 });
      });
    });
    return () => {
      cancelAnimationFrame(outer);
      if (inner !== undefined) {
        cancelAnimationFrame(inner);
      }
    };
  }, [layoutSeq, layoutStatus, fitView]);
  return null;
}

// MiniMap is generic over the default `Node`, so we narrow its untyped data to ours here.
function miniMapColor(node: Node): string {
  return accentForKind((node.data as BlueprintNodeData).node.kind);
}
