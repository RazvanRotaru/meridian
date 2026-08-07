/**
 * The canvas shell. It hosts the always-mounted Toolbar (tab toggle + sidebar), floating source window,
 * and global Cmd/Ctrl+P CommandPalette, and swaps its main surface by view mode:
 * "modules" (folder Map), "call" (Service clusters), and "ui" (the renders-rooted composition —
 * unified in phase C) all mount the SAME module surface (ModuleMapView) — each lens differs only
 * by its SurfaceSpec; "logic" is the intra-procedural LogicFlowView; "prs" the PR browser. All
 * are read-only React Flow surfaces — not draggable/connectable, selectable (selection driven
 * into the store via onNodeClick), dark color mode, dotted background, coloured MiniMap.
 */

import { ReactFlowProvider } from "@xyflow/react";
import { useCallback, useRef, useState } from "react";
import { useBlueprint } from "../state/StoreContext";
import { Toolbar } from "./Toolbar";
import { CodePanel } from "./CodePanel";
import { CommandPalette, type CommandPaletteLookupRequest } from "./CommandPalette";
import { LogicFlowView } from "./LogicFlowView";
import { ModuleMapView } from "./ModuleMapView";
import { FlowExplorerPanel } from "./flowexplorer/FlowExplorerPanel";
import { FlowPane, flowPaneShouldRender } from "./flowexplorer/FlowPane";
import { FlowSplitView } from "./flowexplorer/FlowSplitView";
import { PrsView } from "./prs/PrsView";
import { PaletteCanvasNodeProvider } from "./canvas/PaletteCanvasNodes";
import { FLOATING_SOURCE_WINDOW_PORTAL_HOST_ID } from "./source/FloatingSourceWindow";

// The Logic-flow view is a plain nested-div render, not a React Flow surface, so it swaps in for
// the module surface whole. Toolbar (the tab toggle + sidebar) and the full source view stay
// mounted in every mode; both anchor to this relatively-positioned shell.
export function BlueprintCanvas(props: { preselectedEnv: string | null }) {
  const lookupRequestSequence = useRef(0);
  const [lookupRequest, setLookupRequest] = useState<CommandPaletteLookupRequest | null>(null);
  const lookupSourceSymbol = useCallback((symbol: string | null) => {
    setLookupRequest({
      id: ++lookupRequestSequence.current,
      query: symbol ?? "",
      scope: "all",
    });
  }, []);
  const acknowledgeLookupRequest = useCallback((id: number) => {
    setLookupRequest((current) => current?.id === id ? null : current);
  }, []);
  const viewMode = useBlueprint((state) => state.viewMode);
  const flowPaneOpen = useBlueprint((state) => state.flowPaneOrigin === "request"
    ? state.telemetryMode && state.requestFlowTraceId !== null
    : state.flowSelection !== null
      && flowPaneShouldRender(
        state.reviewFlowBaseline !== null,
        state.reviewOpenFlowSplitOnSelect || state.reviewFlowExplicitView !== null,
      ));
  const reviewFlowOpen = useBlueprint((state) => state.flowPaneOrigin !== "request"
      && state.flowSelection !== null
      && state.reviewFlowBaseline !== null
      && (state.reviewOpenFlowSplitOnSelect || state.reviewFlowExplicitView !== null));
  const syntheticFlowOpen = useBlueprint((state) => state.flowPaneOrigin === "synthetic" && state.flowSelection !== null);
  return (
    <PaletteCanvasNodeProvider>
      <div id={FLOATING_SOURCE_WINDOW_PORTAL_HOST_ID} style={SHELL_STYLE}>
        {/* The floating source inspector is always modeless. Keep the workspace in one stable
            ownership boundary while the shell-level window moves above it. */}
        <div
          style={WORKSPACE_UNDERLAY_STYLE}
          data-source-workspace-underlay="true"
        >
          <FlowExplorerPanel />
          <FlowSplitView
            open={flowPaneOpen}
            review={reviewFlowOpen}
            synthetic={syntheticFlowOpen}
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
              </div>
            )}
            flow={<FlowPane />}
          />
        </div>
        {/* The global palette stays a shell sibling so source lookup can layer over the dock and
            remain available when an underlying splitter minimizes a pane. */}
        <CommandPalette
          lookupRequest={lookupRequest}
          onLookupRequestHandled={acknowledgeLookupRequest}
        />
        {/* Source can open from either split pane. Its shell-level floating host is never clipped by
            their splitters and leaves every uncovered workspace control interactive. */}
        <CodePanel onLookupSymbol={lookupSourceSymbol} />
      </div>
    </PaletteCanvasNodeProvider>
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

const WORKSPACE_UNDERLAY_STYLE: React.CSSProperties = {
  position: "relative",
  flex: 1,
  width: "100%",
  height: "100%",
  minWidth: 0,
  minHeight: 0,
  display: "flex",
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
