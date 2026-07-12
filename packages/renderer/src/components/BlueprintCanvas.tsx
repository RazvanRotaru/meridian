/**
 * The canvas shell. It hosts the always-mounted Toolbar (tab toggle + sidebar), the modal
 * CodePanel, and the global Cmd/Ctrl+P CommandPalette, and swaps its main surface by view mode:
 * "modules" (folder Map), "call" (Service clusters), and "ui" (the renders-rooted composition —
 * unified in phase C) all mount the SAME module surface (ModuleMapView) — each lens differs only
 * by its SurfaceSpec; "logic" is the intra-procedural LogicFlowView; "prs" the PR browser. All
 * are read-only React Flow surfaces — not draggable/connectable, selectable (selection driven
 * into the store via onNodeClick), dark color mode, dotted background, coloured MiniMap.
 */

import { ReactFlowProvider } from "@xyflow/react";
import { useBlueprint } from "../state/StoreContext";
import { Toolbar } from "./Toolbar";
import { CodePanel } from "./CodePanel";
import { CommandPalette } from "./CommandPalette";
import { LogicFlowView } from "./LogicFlowView";
import { ModuleMapView } from "./ModuleMapView";
import { FlowExplorerPanel } from "./flowexplorer/FlowExplorerPanel";
import { FlowPane, flowPaneShouldRender } from "./flowexplorer/FlowPane";
import { FlowSplitView } from "./flowexplorer/FlowSplitView";
import { PrsView } from "./prs/PrsView";

// The Logic-flow view is a plain nested-div render, not a React Flow surface, so it swaps in for
// the module surface whole. Toolbar (the tab toggle + sidebar) and the modal CodePanel stay mounted
// in every mode — the toolbar overlays either view, and the code modal serves the empty-flow "Show
// code". Both anchor to this relatively-positioned wrapper.
export function BlueprintCanvas(props: { preselectedEnv: string | null }) {
  const viewMode = useBlueprint((state) => state.viewMode);
  const flowPaneOpen = useBlueprint((state) => state.flowPaneOrigin === "request"
    ? state.telemetryMode && state.requestFlowTraceId !== null
    : state.flowSelection !== null
      && flowPaneShouldRender(state.reviewFlowBaseline !== null, state.reviewOpenFlowSplitOnSelect));
  const reviewFlowOpen = useBlueprint((state) => state.flowPaneOrigin !== "request"
    && state.flowSelection !== null
    && state.reviewFlowBaseline !== null
    && state.reviewOpenFlowSplitOnSelect);
  return (
    <div style={SHELL_STYLE}>
      <FlowExplorerPanel />
      <FlowSplitView
        open={flowPaneOpen}
        review={reviewFlowOpen}
        graph={(
          <div style={MAIN_STYLE}>
            {/* Each view is its OWN ReactFlow surface; keying a fresh provider per mode gives each its own
                React Flow store, so a tab switch can never bleed the previous surface's nodes into the next
                one's first render (which crashed its MiniMap nodeColor on foreign-shaped data). The
                always-mounted Toolbar's <Panel> keeps using the outer App-level provider. */}
            <ReactFlowProvider key={viewMode}>
              {viewMode === "logic" ? <LogicFlowView /> : viewMode === "prs" ? <PrsView /> : <ModuleMapView />}
            </ReactFlowProvider>
            <Toolbar preselectedEnv={props.preselectedEnv} />
            <CodePanel />
            {/* Global Cmd/Ctrl+P quick-open — mounted here so the shortcut works in every view mode. */}
            <CommandPalette />
          </div>
        )}
        flow={<FlowPane />}
      />
    </div>
  );
}

const SHELL_STYLE: React.CSSProperties = {
  position: "relative",
  width: "100%",
  height: "100%",
  display: "flex",
  minWidth: 0,
  overflow: "hidden",
};

const MAIN_STYLE: React.CSSProperties = {
  position: "relative",
  width: "100%",
  height: "100%",
  minWidth: 0,
  minHeight: 0,
  overflow: "hidden",
};
