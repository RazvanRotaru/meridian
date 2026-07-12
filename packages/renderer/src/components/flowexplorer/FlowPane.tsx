import { useEffect, useMemo, useRef } from "react";
import { ReactFlow, ReactFlowProvider, type Edge, type Node, type ReactFlowInstance } from "@xyflow/react";
import type { LogicFlows } from "@meridian/core";
import { useBlueprint, useBlueprintActions } from "../../state/StoreContext";
import { logicNodeTypes } from "../nodes/logic/logicNodeTypes";
import { CanvasChrome, READONLY_CANVAS_PROPS } from "../canvas/flowCanvasProps";
import type { LogicNodeData } from "../../derive/logicGraph";
import { stepsAt, type FlowSelectionRef } from "../../derive/flowBlocks";
import { blockBreadcrumbs } from "./flowBlockLabels";
import { ancestorSelection, REVIEW_FLOW_SPLIT_ID, selectionKey } from "./flowSelection";
import { useLogicFlows } from "./useFlowTree";
import { TimelineView } from "../logicviews/TimelineView";
import { METRO_COMPACT_TOP_PADDING, MetroView } from "../logicviews/MetroView";
import { BlocksView } from "../logicviews/BlocksView";
import { FLOW_COLORS, type FlowViewProps } from "../../derive/flowViewModel";
import { BASE_Y as METRO_MAIN_LINE_Y } from "../../derive/metroSpec";
import type { ReviewFlowSplitView } from "../../state/reviewPreferences";

export function FlowPane() {
  const selection = useBlueprint((state) => state.flowSelection);
  const nodesById = useBlueprint((state) => state.index.nodesById);
  const reviewActive = useBlueprint((state) => state.flowSelection !== null && state.reviewFlowBaseline !== null);
  const reviewFlowSplitView = useBlueprint((state) => state.reviewFlowSplitView);
  const reviewOpenFlowSplitOnSelect = useBlueprint((state) => state.reviewOpenFlowSplitOnSelect);
  const flows = useLogicFlows();
  const { selectFlowEntry, openLogicFlow } = useBlueprintActions();
  if (selection === null || !flowPaneShouldRender(reviewActive, reviewOpenFlowSplitOnSelect)) {
    return null;
  }
  const rootLabel = nodesById.get(selection.rootId)?.displayName ?? selection.rootId;
  const crumbs = blockBreadcrumbs(flows, selection);
  const presentation = flowPanePresentation(reviewActive, reviewFlowSplitView);
  const viewKey = `${presentation}:${selectionKey(selection)}`;
  return (
    <aside
      id={reviewActive ? REVIEW_FLOW_SPLIT_ID : undefined}
      style={reviewActive ? REVIEW_DRAWER : DRAWER}
      aria-label={reviewActive ? "Logic flow review" : "Code flow"}
    >
      <header style={HEADER}>
        <div style={TITLE_ROW}>
          <span style={GLYPH}>ƒ</span>
          <span style={TITLE} title={selection.rootId}>{rootLabel}</span>
          <button type="button" style={OPEN_BUTTON} onClick={() => openLogicFlow(selection.rootId)}>
            Open in Logic flow
          </button>
          <button type="button" style={CLOSE} title="Close flow pane" onClick={() => selectFlowEntry(null)}>
            ✕
          </button>
        </div>
        <nav style={BREADCRUMBS} aria-label="Selected flow block">
          <button type="button" style={CRUMB} onClick={() => selectFlowEntry(ancestorSelection(selection, 0))}>
            {rootLabel}
          </button>
          {crumbs.map((crumb) => (
            <span key={selectionKey(crumb.ref)} style={CRUMB_GROUP}>
              <span style={CRUMB_SEP}>›</span>
              <button type="button" style={CRUMB} onClick={() => selectFlowEntry(crumb.ref)}>
                {crumb.label}
              </button>
            </span>
          ))}
        </nav>
      </header>
      <div style={BODY}>
        {presentation === "graph" ? (
          <ReactFlowProvider key={viewKey}>
            <FlowPaneSurface />
          </ReactFlowProvider>
        ) : (
          <FlowPaneProjection key={viewKey} mode={presentation} selection={selection} flows={flows} />
        )}
      </div>
    </aside>
  );
}

/** The persisted preference affects PR review only; the general Code flows explorer deliberately
 * retains its established execution graph even when the same user prefers another projection. */
export function flowPanePresentation(
  reviewActive: boolean,
  reviewFlowSplitView: ReviewFlowSplitView,
): ReviewFlowSplitView {
  return reviewActive ? reviewFlowSplitView : "graph";
}

/** Hiding the PR split is presentation-only: the selection still drives the upper graph. The
 * ordinary Code-flow explorer ignores this review preference and always keeps its pane. */
export function flowPaneShouldRender(reviewActive: boolean, openFlowSplitOnSelect: boolean): boolean {
  return !reviewActive || openFlowSplitOnSelect;
}

type AlternateFlowPaneMode = Exclude<ReviewFlowSplitView, "graph">;

function FlowPaneProjection(props: {
  mode: AlternateFlowPaneMode;
  selection: FlowSelectionRef;
  flows: LogicFlows;
}) {
  const index = useBlueprint((state) => state.index);
  const logicSelected = useBlueprint((state) => state.logicSelected);
  const { selectFlowPaneTarget } = useBlueprintActions();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const steps = useMemo(
    () => stepsAt(props.flows, props.selection) ?? [],
    [props.flows, props.selection],
  );

  // Metro's main line sits midway down its full transit-map canvas. On the short review drawer,
  // center that line initially while leaving upper and lower branch lanes reachable by scrolling.
  useEffect(() => {
    if (props.mode !== "metro") {
      return;
    }
    const frame = requestAnimationFrame(() => {
      const surface = scrollRef.current;
      if (surface !== null) {
        surface.scrollTop = Math.max(0, METRO_COMPACT_TOP_PADDING + METRO_MAIN_LINE_Y - surface.clientHeight / 2);
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [props.mode, steps]);

  if (steps.length === 0) {
    return (
      <div style={SURFACE_FILL} data-flow-pane-view={props.mode}>
        <PaneMessage mark="∅" text="This block has no charted call flow." />
      </div>
    );
  }

  const viewProps: FlowViewProps = {
    rootId: props.selection.rootId,
    steps,
    flows: props.flows,
    index,
    selected: logicSelected,
    onSelect: (target) => selectFlowPaneTarget(target === logicSelected ? null : target),
    // The execution-graph split has no drill gesture. Keep parity across review projections; the
    // explicit "Open in Logic flow" action above owns navigation out of the review experience.
    onDrill: () => undefined,
  };

  return (
    <div
      ref={scrollRef}
      style={ALTERNATE_SURFACE}
      data-flow-pane-view={props.mode}
      onClick={() => selectFlowPaneTarget(null)}
    >
      <AlternateProjection mode={props.mode} viewProps={viewProps} />
    </div>
  );
}

/** Exhaustive alternate-view dispatch: adding a Logic mode fails type-checking until it has a real
 * split renderer, so a preference can never silently fall back to the execution graph. */
function AlternateProjection(props: { mode: AlternateFlowPaneMode; viewProps: FlowViewProps }) {
  switch (props.mode) {
    case "timeline":
      return <TimelineView {...props.viewProps} density="compact" drillEnabled={false} />;
    case "metro":
      return <MetroView {...props.viewProps} density="compact" drillEnabled={false} />;
    case "blocks":
      return <BlocksView {...props.viewProps} density="compact" drillEnabled={false} />;
    default:
      return assertNever(props.mode);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unsupported flow-pane projection: ${String(value)}`);
}

function FlowPaneSurface() {
  const nodes = useBlueprint((state) => state.flowPaneRfNodes);
  const edges = useBlueprint((state) => state.flowPaneRfEdges);
  const status = useBlueprint((state) => state.flowPaneLayoutStatus);
  const logicSelected = useBlueprint((state) => state.logicSelected);
  const { selectFlowPaneTarget } = useBlueprintActions();
  const rfRef = useRef<ReactFlowInstance<Node, Edge> | null>(null);
  const fittedNodes = useRef<readonly Node[] | null>(null);

  const fitReadyNodes = (instance: ReactFlowInstance<Node, Edge>) => {
    if (status !== "ready" || nodes.length === 0 || fittedNodes.current === nodes) {
      return;
    }
    fittedNodes.current = nodes;
    requestAnimationFrame(() => {
      void instance.fitView({ padding: 0.15, maxZoom: 1.25 });
    });
  };

  useEffect(() => {
    if (!rfRef.current) {
      return;
    }
    fitReadyNodes(rfRef.current);
  }, [nodes, status]);

  if (nodes.length === 0 && status === "laying-out") {
    return <GraphSurface><PaneMessage mark="…" text="Laying out flow." /></GraphSurface>;
  }
  if (nodes.length === 0 && status === "ready") {
    return <GraphSurface><PaneMessage mark="∅" text="This block has no charted call flow." /></GraphSurface>;
  }
  if (status === "error") {
    return <GraphSurface><PaneMessage mark="!" text="Could not lay out this flow." /></GraphSurface>;
  }
  return (
    <GraphSurface>
      <ReactFlow<Node, Edge>
        nodes={nodes}
        edges={edges}
        nodeTypes={logicNodeTypes}
        onInit={(instance) => {
          rfRef.current = instance;
          fittedNodes.current = null;
          fitReadyNodes(instance);
        }}
        onNodeClick={(_event, node) => {
          const target = artifactTargetOf(node);
          if (target !== null) {
            selectFlowPaneTarget(target === logicSelected ? null : target);
          }
        }}
        onPaneClick={() => selectFlowPaneTarget(null)}
        {...READONLY_CANVAS_PROPS}
      >
        <CanvasChrome nodeColor={miniMapColor} />
      </ReactFlow>
    </GraphSurface>
  );
}

function GraphSurface(props: { children: React.ReactNode }) {
  return <div style={SURFACE_FILL} data-flow-pane-view="graph">{props.children}</div>;
}

/** Call blocks map directly to their artifact target. Structural controls and entry/exit caps have
 * no selectable standalone target in the flow pane and intentionally do nothing. */
function artifactTargetOf(node: Node): string | null {
  const data = node.data as { targetId?: unknown };
  if (typeof data.targetId === "string") {
    return data.targetId;
  }
  return null;
}

function PaneMessage(props: { mark: string; text: string }) {
  return (
    <div style={EMPTY}>
      <span style={EMPTY_MARK}>{props.mark}</span>
      <span>{props.text}</span>
    </div>
  );
}

function miniMapColor(node: Node): string {
  const data = node.data as LogicNodeData;
  if (data.logicKind === "loop") return "#E6B84D";
  if (data.logicKind === "try") return "#D98A5B";
  if (data.logicKind === "if" || data.logicKind === "switch") return "#61DAFB";
  return data.greyed ? "#3A414C" : "#3B7AC0";
}

const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";

const DRAWER: React.CSSProperties = {
  width: "100%",
  minWidth: 0,
  flex: "0 0 40%",
  minHeight: 240,
  maxHeight: "55%",
  boxSizing: "border-box",
  display: "flex",
  flexDirection: "column",
  background: "#0B0E13",
  borderTop: "1px solid #222732",
  boxShadow: "0 -12px 32px rgba(0,0,0,0.35)",
  color: "#D6DEE9",
};

// PR logic review is an exact horizontal split: the graph keeps the upper 70% of the full canvas
// and this flow surface owns the lower 30%. Remove the generic pane's minimum/maximum constraints,
// which would otherwise break the ratio on shorter windows.
const REVIEW_DRAWER: React.CSSProperties = {
  ...DRAWER,
  flex: "0 0 30%",
  minHeight: 0,
  maxHeight: "30%",
};

const HEADER: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 8,
  padding: "10px 12px",
  borderBottom: "1px solid #1B2028",
  background: "#0E1116",
};

const TITLE_ROW: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8 };
const GLYPH: React.CSSProperties = { color: "#56C271", fontSize: 13, flexShrink: 0 };
const TITLE: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  fontFamily: MONO,
  fontSize: 12.5,
  color: "#E6EDF3",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};
const OPEN_BUTTON: React.CSSProperties = {
  border: "1px solid #2A313D",
  borderRadius: 5,
  background: "#151B24",
  color: "#C9D3E0",
  padding: "4px 8px",
  fontSize: 12,
  cursor: "pointer",
};
const CLOSE: React.CSSProperties = { width: 22, height: 22, border: "1px solid #2A313D", borderRadius: 5, background: "transparent", color: "#9AA4B2", cursor: "pointer", fontSize: 11, lineHeight: 1 };
const BREADCRUMBS: React.CSSProperties = { display: "flex", alignItems: "center", gap: 4, minWidth: 0 };
const CRUMB_GROUP: React.CSSProperties = { display: "flex", alignItems: "center", gap: 4, minWidth: 0 };
const CRUMB_SEP: React.CSSProperties = { color: "#4E5867", fontSize: 12 };
const CRUMB: React.CSSProperties = {
  border: "none",
  background: "transparent",
  color: "#98A3B3",
  padding: 0,
  fontSize: 11.5,
  cursor: "pointer",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};
const BODY: React.CSSProperties = { position: "relative", flex: 1, minHeight: 0 };
const SURFACE_FILL: React.CSSProperties = { position: "relative", width: "100%", height: "100%" };
const ALTERNATE_SURFACE: React.CSSProperties = {
  ...SURFACE_FILL,
  overflow: "auto",
  overscrollBehavior: "contain",
  backgroundColor: FLOW_COLORS.canvas,
  backgroundImage: "radial-gradient(#1B2230 1px, transparent 1px)",
  backgroundSize: "22px 22px",
};
const EMPTY: React.CSSProperties = {
  position: "absolute",
  inset: 0,
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  gap: 8,
  color: "#6B7482",
  fontSize: 12.5,
};
const EMPTY_MARK: React.CSSProperties = { fontSize: 26, color: "#3A414C" };
