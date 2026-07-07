/**
 * The canvas shell. It hosts the always-mounted Toolbar (tab toggle + sidebar), the modal
 * CodePanel, and the global Cmd/Ctrl+P CommandPalette, and swaps its main surface by view mode:
 * "call" is the Service-composition scorecard graph (CompositionView); "ui" is the React
 * composition call graph (FlowCanvas); "logic" is the intra-procedural LogicFlowView. All three are
 * read-only React Flow surfaces — not draggable/connectable, selectable (selection driven into the
 * store via onNodeClick), dark color mode, dotted background, coloured MiniMap.
 */

import { ReactFlow, ReactFlowProvider, type Node, type NodeMouseHandler } from "@xyflow/react";
import { accentForKind } from "../theme/kindColors";
import { coverageAccent } from "../theme/coverageColors";
import type { CoverageReport } from "@meridian/core";
import { useBlueprint, useBlueprintActions } from "../state/StoreContext";
import { isCallable } from "../layout/nodeSize";
import type { BlueprintNode, BlueprintEdge, BlueprintNodeData } from "../layout/rfTypes";
import { nodeTypes } from "./nodes/nodeTypes";
import { edgeTypes } from "./edges/edgeTypes";
import { CanvasChrome, READONLY_CANVAS_PROPS } from "./canvas/flowCanvasProps";
import { Toolbar } from "./Toolbar";
import { CoveragePanel } from "./CoveragePanel";
import { CodePanel } from "./CodePanel";
import { CommentsPanel } from "./CommentsPanel";
import { CommandPalette } from "./CommandPalette";
import { LogicFlowView } from "./LogicFlowView";
import { CompositionView } from "./CompositionView";

// The Logic-flow view is a plain nested-div render, not a React Flow surface, so it swaps in for
// <ReactFlow> whole. Toolbar (the tab toggle + sidebar) and the modal CodePanel stay mounted in
// both modes — the toolbar overlays either view, and the code modal serves the empty-flow "Show
// code". Both anchor to this relatively-positioned wrapper.
export function BlueprintCanvas(props: { preselectedEnv: string | null }) {
  const viewMode = useBlueprint((state) => state.viewMode);
  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      {/* Each view is its OWN ReactFlow surface; keying a fresh provider per mode gives each its own
          React Flow store, so a tab switch can never bleed the previous surface's nodes into the next
          one's first render (which crashed its MiniMap nodeColor on foreign-shaped data). The
          always-mounted Toolbar's <Panel> keeps using the outer App-level provider. */}
      <ReactFlowProvider key={viewMode}>
        {viewMode === "call" ? <CompositionView /> : viewMode === "logic" ? <LogicFlowView /> : <FlowCanvas />}
      </ReactFlowProvider>
      <Toolbar preselectedEnv={props.preselectedEnv} />
      <CodePanel />
      <CommentsPanel />
      {/* Global Cmd/Ctrl+P quick-open — mounted here so the shortcut works in every view mode. */}
      <CommandPalette />
    </div>
  );
}

// The call/UI graph surface: a controlled, read-only React Flow canvas driven by the store.
function FlowCanvas() {
  const nodes = useBlueprint((state) => state.rfNodes);
  const edges = useBlueprint((state) => state.rfEdges);
  const coverage = useBlueprint((state) => (state.coverageMode ? state.coverage : null));
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
      {...READONLY_CANVAS_PROPS}
    >
      <CanvasChrome nodeColor={(node) => miniMapColor(node, coverage)} />
      <CoveragePanel />
    </ReactFlow>
  );
}

// MiniMap is generic over the default `Node`, so we narrow its untyped data to ours here.
// In coverage mode the MiniMap echoes the verdict colors, so gaps stand out at overview zoom.
function miniMapColor(node: Node, coverage: CoverageReport | null): string {
  if (coverage) {
    return coverageAccent(node.id, coverage);
  }
  return accentForKind((node.data as BlueprintNodeData).node.kind);
}
