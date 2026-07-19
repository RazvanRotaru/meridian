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
import { moduleGraphOverlayIsOpen, type BlueprintState } from "../state/store";
import { Toolbar } from "./Toolbar";
import { CodePanel } from "./CodePanel";
import { CommandPalette } from "./CommandPalette";
import { LogicFlowView } from "./LogicFlowView";
import { ModuleMapView } from "./ModuleMapView";
import { FlowExplorerPanel } from "./flowexplorer/FlowExplorerPanel";
import { FlowPane, flowPaneShouldRender } from "./flowexplorer/FlowPane";
import { FlowSplitView } from "./flowexplorer/FlowSplitView";
import { PrsView } from "./prs/PrsView";
import { GraphLayoutIndicator } from "./canvas/GraphLayoutIndicator";

// The Logic-flow view is a plain nested-div render, not a React Flow surface, so it swaps in for
// the module surface whole. Toolbar (the tab toggle + sidebar) and the modal CodePanel stay mounted
// in every mode — the toolbar overlays either view, and the code modal serves the empty-flow "Show
// code". Both anchor to this relatively-positioned wrapper.
export function BlueprintCanvas(props: { preselectedEnv: string | null }) {
  const viewMode = useBlueprint((state) => state.viewMode);
  const moduleSceneUnavailable = useBlueprint(moduleSceneNeedsTransition);
  const moduleLayoutStatus = useBlueprint((state) => state.moduleLayoutStatus);
  const moduleLayoutActivity = useBlueprint((state) => state.moduleLayoutActivity);
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
    <div style={SHELL_STYLE}>
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
              {viewMode === "logic"
                ? <LogicFlowView />
                : viewMode === "prs"
                  ? <PrsView />
                  : moduleSceneUnavailable
                    ? <ModuleTransitionSurface
                        failed={moduleLayoutStatus === "error"}
                        label={moduleLayoutActivity?.label ?? "Loading graph view…"}
                      />
                    : <ModuleMapView />}
            </ReactFlowProvider>
            <Toolbar preselectedEnv={props.preselectedEnv} />
            {/* Global Cmd/Ctrl+P quick-open — mounted here so the shortcut works in every view mode. */}
            <CommandPalette />
          </div>
        )}
        flow={<FlowPane />}
      />
      {/* Source is opened from both split panes. Keep its modal host outside the resizable panes so
          minimizing the graph cannot clip it or place it inside an aria-hidden/inert subtree. */}
      <CodePanel />
    </div>
  );
}

/** Decide whether the ordinary module scene still owns the surface but has not arrived. An
 * extracted/review scene deliberately parks that scene and renders through ModuleMapView itself;
 * its own minimalLayoutStatus owns readiness and failure presentation. */
export function moduleSceneNeedsTransition(
  state: Pick<BlueprintState, "viewMode" | "moduleRfNodes" | "moduleLayoutStatus" | "minimalSeedIds" | "minimalMemberIds" | "review" | "prReviewed">,
): boolean {
  const moduleLens = state.viewMode === "modules" || state.viewMode === "call" || state.viewMode === "ui";
  const overlaySceneOwnsSurface = moduleGraphOverlayIsOpen(state);
  return moduleLens
    && !overlaySceneOwnsSurface
    && state.moduleRfNodes.length === 0
    && state.moduleLayoutStatus !== "ready";
}

/** Keep the application shell and controls mounted while a destination projection/layout is being
 * prepared, but do not mount that lens's derives against the outgoing projection. */
function ModuleTransitionSurface(props: { failed: boolean; label: string }) {
  return (
    <div
      style={TRANSITION_SURFACE_STYLE}
      aria-busy={props.failed ? undefined : "true"}
      aria-label={props.failed ? "Graph view failed" : "Loading graph view"}
    >
      {props.failed
        ? <div role="alert" style={TRANSITION_ERROR_STYLE}>Could not load this graph view. Select the lens again to retry.</div>
        : <GraphLayoutIndicator label={props.label} />}
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

const TRANSITION_SURFACE_STYLE: React.CSSProperties = {
  position: "absolute",
  inset: 0,
  backgroundColor: "#090D12",
  backgroundImage: "radial-gradient(circle, #2B3440 1px, transparent 1px)",
  backgroundSize: "22px 22px",
};

const TRANSITION_ERROR_STYLE: React.CSSProperties = {
  position: "absolute",
  inset: 0,
  display: "grid",
  placeItems: "center",
  padding: 24,
  color: "#E5534B",
  fontSize: 13,
  textAlign: "center",
};
