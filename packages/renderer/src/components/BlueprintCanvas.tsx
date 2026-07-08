/**
 * The canvas shell. It hosts the always-mounted Toolbar (tab toggle + sidebar), the modal
 * CodePanel, and the global Cmd/Ctrl+P CommandPalette, and swaps its main surface by view mode:
 * "call" is the Service-composition lens — the Map surface (ModuleMapView) fed a service-cluster
 * tree; "ui" is the React composition call graph (FlowCanvas); "logic" is the intra-procedural
 * LogicFlowView; "modules" is the folder Module-map. All are read-only React Flow surfaces — not
 * draggable/connectable, selectable (selection driven into the store via onNodeClick), dark color
 * mode, dotted background, coloured MiniMap.
 */

import { useEffect, useMemo, useRef } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  useNodesInitialized,
  type Node,
  type NodeMouseHandler,
  type ReactFlowInstance,
} from "@xyflow/react";
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
import { CommandPalette } from "./CommandPalette";
import { LogicFlowView } from "./LogicFlowView";
import { ModuleMapView } from "./ModuleMapView";
import { FlowExplorerPanel } from "./flowexplorer/FlowExplorerPanel";
import { FlowPane } from "./flowexplorer/FlowPane";
import { emphasizeFlow, renderedIdsForFlowEmphasis } from "./flowEmphasisPaint";
import { selectionKey } from "./flowexplorer/flowSelection";

const FLOW_CANVAS_PROPS = { ...READONLY_CANVAS_PROPS, fitView: false } as const;

// The Logic-flow view is a plain nested-div render, not a React Flow surface, so it swaps in for
// <ReactFlow> whole. Toolbar (the tab toggle + sidebar) and the modal CodePanel stay mounted in
// both modes — the toolbar overlays either view, and the code modal serves the empty-flow "Show
// code". Both anchor to this relatively-positioned wrapper.
export function BlueprintCanvas(props: { preselectedEnv: string | null }) {
  const viewMode = useBlueprint((state) => state.viewMode);
  return (
    <div style={SHELL_STYLE}>
      <FlowExplorerPanel />
      <div style={CANVAS_REGION_STYLE}>
        <div style={MAIN_STYLE}>
          {/* Each view is its OWN ReactFlow surface; keying a fresh provider per mode gives each its own
              React Flow store, so a tab switch can never bleed the previous surface's nodes into the next
              one's first render (which crashed its MiniMap nodeColor on foreign-shaped data). The
              always-mounted Toolbar's <Panel> keeps using the outer App-level provider. */}
          <ReactFlowProvider key={viewMode}>
            {viewMode === "call" ? (
              <ModuleMapView />
            ) : viewMode === "logic" ? (
              <LogicFlowView />
            ) : viewMode === "modules" ? (
              <ModuleMapView />
            ) : (
              <FlowCanvas />
            )}
          </ReactFlowProvider>
          <Toolbar preselectedEnv={props.preselectedEnv} />
          <CodePanel />
          {/* Global Cmd/Ctrl+P quick-open — mounted here so the shortcut works in every view mode. */}
          <CommandPalette />
        </div>
        <FlowPane />
      </div>
    </div>
  );
}

// The call/UI graph surface: a controlled, read-only React Flow canvas driven by the store.
function FlowCanvas() {
  const rawNodes = useBlueprint((state) => state.rfNodes);
  const rawEdges = useBlueprint((state) => state.rfEdges);
  const flowEmphasis = useBlueprint((state) => state.flowEmphasis);
  const flowSelection = useBlueprint((state) => state.flowSelection);
  const layoutStatus = useBlueprint((state) => state.layoutStatus);
  const parentOf = useBlueprint((state) => state.index.parentOf);
  const coverage = useBlueprint((state) => (state.coverageMode ? state.coverage : null));
  const { select, diveInto, openLogicFlow } = useBlueprintActions();
  const { nodes, edges } = useMemo(
    () => emphasizeFlow(rawNodes, rawEdges, flowEmphasis),
    [rawNodes, rawEdges, flowEmphasis],
  );
  const nodesInitialized = useNodesInitialized();
  const rfRef = useRef<ReactFlowInstance<BlueprintNode, BlueprintEdge> | null>(null);
  const initialFitDone = useRef(false);
  const fitKey = selectionKey(flowSelection);
  const latestFitKey = useRef(fitKey);
  const pendingFit = useRef<{ key: string; requestedOnNodes: readonly BlueprintNode[] } | null>(null);
  useEffect(() => {
    latestFitKey.current = fitKey;
  }, [fitKey]);
  useEffect(() => {
    pendingFit.current = flowSelection === null ? null : { key: fitKey, requestedOnNodes: rawNodes };
  }, [fitKey, flowSelection]);
  useEffect(() => {
    const request = pendingFit.current;
    if (
      !rfRef.current ||
      !nodesInitialized ||
      !request ||
      request.key !== fitKey ||
      layoutStatus !== "ready" ||
      request.requestedOnNodes === rawNodes
    ) {
      return;
    }
    const targetIds = renderedIdsForFlowEmphasis(rawNodes, flowEmphasis, parentOf);
    pendingFit.current = null;
    if (targetIds.length === 0) {
      return;
    }
    const targetNodes = targetIds.map((id) => ({ id }));
    const requestKey = request.key;
    requestAnimationFrame(() => {
      if (latestFitKey.current !== requestKey) {
        return;
      }
      void rfRef.current?.fitView({ nodes: targetNodes, padding: 0.2, maxZoom: 1, duration: 400 });
    });
  }, [fitKey, layoutStatus, nodesInitialized, rawNodes]);
  useEffect(() => {
    if (!rfRef.current || !nodesInitialized || initialFitDone.current || flowSelection !== null || rawNodes.length === 0) {
      return;
    }
    initialFitDone.current = true;
    requestAnimationFrame(() => {
      if (latestFitKey.current !== "none") {
        return;
      }
      void rfRef.current?.fitView({ padding: 0.2, minZoom: 0.01 });
    });
  }, [flowSelection, nodesInitialized, rawNodes]);
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
      onInit={(instance) => {
        rfRef.current = instance;
      }}
      onNodeClick={onNodeClick}
      onNodeDoubleClick={onNodeDoubleClick}
      onPaneClick={() => select(null)}
      {...FLOW_CANVAS_PROPS}
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

const SHELL_STYLE: React.CSSProperties = {
  position: "relative",
  width: "100%",
  height: "100%",
  display: "flex",
  minWidth: 0,
  overflow: "hidden",
};

const CANVAS_REGION_STYLE: React.CSSProperties = { flex: 1, minWidth: 0, height: "100%", display: "flex", flexDirection: "column" };

const MAIN_STYLE: React.CSSProperties = { position: "relative", flex: 1, minWidth: 0, minHeight: 0 };
