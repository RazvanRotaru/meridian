/**
 * The canvas shell. It hosts the always-mounted Toolbar (tab toggle + sidebar), the modal
 * CodePanel, and the global Cmd/Ctrl+P CommandPalette, and swaps its main surface by view mode:
 * "call" is the Service-composition lens — the Map surface (ModuleMapView) fed a service-cluster
 * tree; "ui" is the React composition call graph (FlowCanvas); "logic" is the intra-procedural
 * LogicFlowView; "modules" is the folder Module-map. All are read-only React Flow surfaces — not
 * draggable/connectable, selectable (selection driven into the store via onNodeClick), dark color
 * mode, dotted background, coloured MiniMap.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
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
import { useRecenter } from "./canvas/useRecenter";
import { Toolbar } from "./Toolbar";
import { CoveragePanel } from "./CoveragePanel";
import { CodePanel } from "./CodePanel";
import { CommandPalette } from "./CommandPalette";
import { LogicFlowView } from "./LogicFlowView";
import { ModuleMapView } from "./ModuleMapView";
import { FlowExplorerPanel } from "./flowexplorer/FlowExplorerPanel";
import { FlowPane } from "./flowexplorer/FlowPane";
import { emphasizeFlow, renderedIdsForFlowEmphasis } from "./flowEmphasisPaint";
import { PrsView } from "./prs/PrsView";
import { ReviewView } from "./ReviewView";

const FLOW_CANVAS_PROPS = { ...READONLY_CANVAS_PROPS, fitView: false } as const;
const EMPTY_FLOW_EMPHASIS_KEY = "none";

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
            {viewMode === "review" ? (
              <ReviewView />
            ) : viewMode === "call" ? (
              <ModuleMapView />
            ) : viewMode === "logic" ? (
              <LogicFlowView />
            ) : viewMode === "modules" ? (
              <ModuleMapView />
            ) : viewMode === "prs" ? (
              <PrsView />
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
  const selectedId = useBlueprint((state) => state.selectedId);
  const { select, diveInto, openLogicFlow } = useBlueprintActions();
  useRecenter(selectedId ? [selectedId] : []);
  const { nodes, edges } = useMemo(
    () => emphasizeFlow(rawNodes, rawEdges, flowEmphasis),
    [rawNodes, rawEdges, flowEmphasis],
  );
  const [rfInstance, setRfInstance] = useState<ReactFlowInstance<BlueprintNode, BlueprintEdge> | null>(null);
  const initialFitDone = useRef(false);
  const fitKey = useMemo(
    () => (flowEmphasis.size === 0 ? EMPTY_FLOW_EMPHASIS_KEY : JSON.stringify([...flowEmphasis].sort())),
    [flowEmphasis],
  );
  const appliedFitKey = useRef(EMPTY_FLOW_EMPHASIS_KEY);
  useEffect(() => {
    if (fitKey === EMPTY_FLOW_EMPHASIS_KEY) {
      appliedFitKey.current = EMPTY_FLOW_EMPHASIS_KEY;
      return;
    }
    if (
      !rfInstance ||
      layoutStatus !== "ready" ||
      rawNodes.length === 0 ||
      appliedFitKey.current === fitKey
    ) {
      return;
    }
    const targetIds = renderedIdsForFlowEmphasis(rawNodes, flowEmphasis, parentOf);
    if (targetIds.length === 0) {
      return;
    }
    appliedFitKey.current = fitKey;
    void rfInstance.fitView({ nodes: targetIds.map((id) => ({ id })), padding: 0.2, minZoom: 0.35, maxZoom: 1, duration: 400 });
  }, [fitKey, flowEmphasis, layoutStatus, parentOf, rawNodes, rfInstance]);
  useEffect(() => {
    if (
      !rfInstance ||
      layoutStatus !== "ready" ||
      initialFitDone.current ||
      flowSelection !== null ||
      fitKey !== EMPTY_FLOW_EMPHASIS_KEY ||
      rawNodes.length === 0
    ) {
      return;
    }
    initialFitDone.current = true;
    void rfInstance.fitView({ padding: 0.2, minZoom: 0.01 });
  }, [fitKey, flowSelection, layoutStatus, rawNodes, rfInstance]);
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
        setRfInstance(instance);
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
