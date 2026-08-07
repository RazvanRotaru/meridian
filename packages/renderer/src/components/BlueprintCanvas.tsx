/**
 * The canvas shell. It hosts the always-mounted Toolbar (tab toggle + sidebar), source side-sheet,
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

// The Logic-flow view is a plain nested-div render, not a React Flow surface, so it swaps in for
// the module surface whole. Toolbar (the tab toggle + sidebar) and the source side-sheet stay
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
  const sourceDockOpen = useBlueprint((state) => state.codeView?.mode === "modal"
    && state.codeView.edgeEvidence === undefined);
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
      <div style={SHELL_STYLE}>
        {/* The dock is a modal side-sheet over the whole workspace. Keep every underlying pane in
            one ownership boundary so pointer, keyboard, and accessibility navigation cannot reach
            controls hidden by the sheet. Palette and dock remain shell siblings outside it. */}
        <div
          style={WORKSPACE_UNDERLAY_STYLE}
          data-source-workspace-underlay="true"
          inert={sourceDockOpen || undefined}
          aria-hidden={sourceDockOpen || undefined}
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
        {/* The global palette must stay outside the inert workspace so source lookup can layer over
            the side-sheet and remain available when an underlying splitter minimizes a pane. */}
        <CommandPalette
          lookupRequest={lookupRequest}
          onLookupRequestHandled={acknowledgeLookupRequest}
        />
        {/* Source is opened from both split panes. Its shell-level host covers every workspace
            sidebar without being clipped by, or inheriting inertness from, their splitters. */}
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
