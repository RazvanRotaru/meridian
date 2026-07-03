/**
 * The canvas shell. It hosts the always-mounted Toolbar (tab toggle + sidebar) and modal
 * CodePanel, and swaps its main surface by view mode: the call/UI graph is the controlled,
 * read-only React Flow surface (FlowCanvas); "logic" swaps in the plain nested-div LogicFlowView.
 * The React Flow surface is not draggable/connectable, selectable (selection driven into the
 * store via onNodeClick), dark color mode, dotted background, kind-coloured MiniMap.
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
import { isCallable } from "../layout/nodeSize";
import type { BlueprintNode, BlueprintEdge, BlueprintNodeData } from "../layout/rfTypes";
import { nodeTypes } from "./nodes/nodeTypes";
import { edgeTypes } from "./edges/edgeTypes";
import { Toolbar } from "./Toolbar";
import { CodePanel } from "./CodePanel";
import { LogicFlowView } from "./LogicFlowView";

// The Logic-flow view is a plain nested-div render, not a React Flow surface, so it swaps in for
// <ReactFlow> whole. Toolbar (the tab toggle + sidebar) and the modal CodePanel stay mounted in
// both modes — the toolbar overlays either view, and the code modal serves the empty-flow "Show
// code". Both anchor to this relatively-positioned wrapper.
export function BlueprintCanvas(props: { preselectedEnv: string | null }) {
  const viewMode = useBlueprint((state) => state.viewMode);
  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      {viewMode === "logic" ? <LogicFlowView /> : <FlowCanvas />}
      <Toolbar preselectedEnv={props.preselectedEnv} />
      <CodePanel />
    </div>
  );
}

// The call/UI graph surface: a controlled, read-only React Flow canvas driven by the store.
function FlowCanvas() {
  const nodes = useBlueprint((state) => state.rfNodes);
  const edges = useBlueprint((state) => state.rfEdges);
  const { select, diveInto, openLogicFlow } = useBlueprintActions();
  const onNodeClick: NodeMouseHandler<BlueprintNode> = (_event, node) => select(node.id);
  // Double-clicking a container's frame dives INTO it (Unreal-Blueprints black-box drill-down).
  // Header double-clicks stop propagation, so they never reach here. A leaf callable instead
  // opens its intra-procedural logic flow (the reserved "dive into logic" gesture).
  const onNodeDoubleClick: NodeMouseHandler<BlueprintNode> = (_event, node) => {
    if (node.data.isContainer) {
      diveInto(node.id);
      return;
    }
    if (isCallable(node.data.node.kind)) {
      openLogicFlow(node.id);
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
    </ReactFlow>
  );
}

// MiniMap is generic over the default `Node`, so we narrow its untyped data to ours here.
function miniMapColor(node: Node): string {
  return accentForKind((node.data as BlueprintNodeData).node.kind);
}
