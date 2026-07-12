import { useEffect, useMemo, useRef } from "react";
import { ReactFlow, ReactFlowProvider, type Edge, type Node, type ReactFlowInstance } from "@xyflow/react";
import type { LogicFlows, RequestTrace } from "@meridian/core";
import { useBlueprint, useBlueprintActions } from "../../state/StoreContext";
import { logicNodeTypes } from "../nodes/logic/logicNodeTypes";
import { logicEdgeTypes } from "../edges/AsyncRailEdge";
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
  const origin = useBlueprint((state) => state.flowPaneOrigin);
  const requestFlowTraceId = useBlueprint((state) => state.requestFlowTraceId);
  const nodesById = useBlueprint((state) => state.index.nodesById);
  const reviewActive = useBlueprint((state) => state.flowSelection !== null && state.reviewFlowBaseline !== null);
  const reviewFlowSplitView = useBlueprint((state) => state.reviewFlowSplitView);
  const reviewOpenFlowSplitOnSelect = useBlueprint((state) => state.reviewOpenFlowSplitOnSelect);
  const flows = useLogicFlows();
  const environment = useBlueprint((state) => state.environment);
  const requestTrace = useBlueprint((state) => origin !== "request" || requestFlowTraceId === null
    ? null
    : state.requestTraces.find((trace) => trace.traceId === requestFlowTraceId) ?? null);
  const { selectFlowEntry, openLogicFlow } = useBlueprintActions();
  const requestOpen = origin === "request" && requestTrace !== null;
  if (!requestOpen && (selection === null || !flowPaneShouldRender(reviewActive, reviewOpenFlowSplitOnSelect))) {
    return null;
  }
  const rootLabel = requestOpen
    ? "Request execution"
    : nodesById.get(selection!.rootId)?.displayName ?? selection!.rootId;
  const crumbs = requestOpen ? [] : blockBreadcrumbs(flows, selection!);
  const requestContext = requestOpen ? requestFlowContext(requestTrace, environment) : null;
  const presentation = requestOpen ? "graph" : flowPanePresentation(reviewActive, reviewFlowSplitView);
  const viewKey = requestOpen
    ? `request:${requestTrace!.traceId}`
    : `${presentation}:${selectionKey(selection!)}`;
  return (
    <aside
      id={reviewActive ? REVIEW_FLOW_SPLIT_ID : undefined}
      style={DRAWER}
      aria-label={reviewActive ? "Logic flow review" : requestOpen ? "Selected request logic flow" : "Code flow"}
    >
      <header style={HEADER}>
        <div style={TITLE_ROW}>
          <span style={GLYPH}>ƒ</span>
          <span style={TITLE} title={requestOpen ? requestTrace!.name : selection!.rootId}>{rootLabel}</span>
          {requestOpen ? null : (
            <button type="button" style={OPEN_BUTTON} onClick={() => openLogicFlow(selection!.rootId)}>
              Open in Logic flow
            </button>
          )}
          <button type="button" style={CLOSE} title="Close flow pane" onClick={() => selectFlowEntry(null)}>
            ✕
          </button>
        </div>
        {requestContext ? <RequestContext context={requestContext} /> : (
          <nav style={BREADCRUMBS} aria-label="Selected flow block">
            <button type="button" style={CRUMB} onClick={() => selectFlowEntry(ancestorSelection(selection!, 0))}>
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
        )}
      </header>
      <div style={BODY}>
        {presentation === "graph" ? (
          <ReactFlowProvider key={viewKey}>
            <FlowPaneSurface />
          </ReactFlowProvider>
        ) : (
          <FlowPaneProjection key={viewKey} mode={presentation} selection={selection!} flows={flows} />
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

export interface RequestFlowContext {
  requestName: string;
  environment: string | null;
  status: RequestTrace["status"];
  spanCount: number;
  eventCount: number;
  durationMs: number;
  complete: boolean;
}

export function requestFlowContext(
  trace: RequestTrace | null,
  environment: string | null,
): RequestFlowContext | null {
  if (trace === null) return null;
  return {
    requestName: trace.name,
    environment,
    status: trace.status,
    spanCount: trace.spans.length,
    eventCount: trace.spans.reduce((count, span) => count + span.events.length, 0),
    durationMs: Number(BigInt(trace.endedAtUnixNano) - BigInt(trace.startedAtUnixNano)) / 1_000_000,
    complete: trace.completeness.complete,
  };
}

function RequestContext({ context }: { context: RequestFlowContext }) {
  return (
    <div style={REQUEST_CONTEXT} aria-label="Selected request context">
      <span style={REQUEST_EYEBROW}>REQUEST</span>
      <span style={REQUEST_NAME} title={context.requestName}>{context.requestName}</span>
      {context.environment ? <span style={REQUEST_CHIP}>{context.environment}</span> : null}
      <span style={REQUEST_CHIP}>{context.status}</span>
      <span style={REQUEST_CHIP}>{formatRequestDuration(context.durationMs)}</span>
      <span style={REQUEST_CHIP}>{context.spanCount} span{context.spanCount === 1 ? "" : "s"}</span>
      <span style={REQUEST_CHIP}>{context.eventCount} event{context.eventCount === 1 ? "" : "s"}</span>
      <span style={REQUEST_CHIP}>{context.complete ? "complete" : "partial"}</span>
      <span style={REQUEST_EDGE_LEGEND} aria-label="Request flow edge legend">
        <span style={REQUEST_EDGE_KEY} title="Captured telemetry causality">
          <span style={REQUEST_EDGE_OBSERVED_SWATCH} /> telemetry path
        </span>
        <span style={REQUEST_EDGE_KEY} title="Static code edge without an exact telemetry join">
          <span style={REQUEST_EDGE_CONTEXT_SWATCH} /> code context
        </span>
      </span>
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

function formatRequestDuration(durationMs: number): string {
  if (durationMs >= 1000) return `${(durationMs / 1000).toFixed(2)}s`;
  if (durationMs >= 10) return `${durationMs.toFixed(1)}ms`;
  return `${durationMs.toFixed(2)}ms`;
}

function FlowPaneSurface() {
  const nodes = useBlueprint((state) => state.flowPaneRfNodes);
  const edges = useBlueprint((state) => state.flowPaneRfEdges);
  const status = useBlueprint((state) => state.flowPaneLayoutStatus);
  const logicSelected = useBlueprint((state) => state.logicSelected);
  const requestOpen = useBlueprint((state) => state.flowPaneOrigin === "request");
  const { selectFlowPaneTarget } = useBlueprintActions();
  const rfRef = useRef<ReactFlowInstance<Node, Edge> | null>(null);
  const fittedNodes = useRef<readonly Node[] | null>(null);
  // A request trace is mounted under its own ReactFlowProvider key, so this ref naturally resets
  // when the selected request changes. Expansion relayouts keep the same mount and must preserve
  // the viewport the reader panned to instead of jumping back to the opening moments.
  const requestInitialFitDone = useRef(false);

  const fitReadyNodes = (instance: ReactFlowInstance<Node, Edge>) => {
    if (status !== "ready" || nodes.length === 0 || fittedNodes.current === nodes) {
      return;
    }
    fittedNodes.current = nodes;
    if (!shouldAutoFitFlowPane(requestOpen, requestInitialFitDone.current)) {
      return;
    }
    if (requestOpen) {
      requestInitialFitDone.current = true;
    }
    requestAnimationFrame(() => {
      // A whole request can contain dozens of runtime moments. Fitting every card turns the split
      // into an unreadable miniature timeline, so request mode opens on the entry + first four
      // moments at reading scale; the canvas and minimap retain the rest of the horizontal chain.
      // Nested static Exec bodies are emitted immediately after their runtime parent. Fit the first
      // five TOP-LEVEL request moments, not the first five raw RF nodes, so an expanded callable is
      // treated as one readable unit and the opening camera still advances along the request.
      const requestMoments = requestOpen ? nodes.filter((node) => node.parentId === undefined) : nodes;
      const openingNodes = requestOpen ? requestMoments.slice(0, Math.min(requestMoments.length, 5)) : nodes;
      // #182's explicit joins and async rails make the opening request bounds taller. Let fitView
      // zoom out far enough to keep title controls inside the usable canvas below the pane header.
      void instance.fitView({ nodes: openingNodes, padding: 0.16, minZoom: requestOpen ? 0.42 : undefined, maxZoom: 1.25 });
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
    return (
      <GraphSurface>
        <PaneMessage mark="∅" text={requestOpen ? "No execution steps were captured for this request." : "This block has no charted call flow."} />
      </GraphSurface>
    );
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
        edgeTypes={logicEdgeTypes}
        onInit={(instance) => {
          rfRef.current = instance;
          fittedNodes.current = null;
          fitReadyNodes(instance);
        }}
        onNodeClick={(_event, node) => {
          const target = artifactTargetOf(node);
          if (target !== null) {
            // Request occurrences always reveal their exact mapped artifact node. Static/review flows
            // retain their historical toggle-by-target behavior through `logicSelected`.
            selectFlowPaneTarget(requestOpen ? target : target === logicSelected ? null : target);
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

/** Request panes fit their opening moments once per trace mount, then preserve the reader's camera
 * across expand/collapse relayouts. Static explorer/review panes retain their existing fit-on-layout
 * behavior. Exported only as a pure policy seam for the focused regression test. */
export function shouldAutoFitFlowPane(requestOpen: boolean, requestInitialFitDone: boolean): boolean {
  return !requestOpen || !requestInitialFitDone;
}

/** Static call blocks and request runtime moments map directly to their artifact target. Structural
 * controls plus entry/exit caps have no standalone graph node and intentionally do nothing. */
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
  if (data.runtime?.status === "error") return "#D75B64";
  if (data.runtime?.kind === "span") return "#58C9A3";
  if (data.runtime?.kind === "branch") return "#E6B84D";
  if (data.runtime?.kind === "loop") return "#61C4D8";
  if (data.runtime?.kind === "exception") return "#D98A5B";
  if (data.runtime?.kind === "async") return "#9B7BD8";
  if (data.logicKind === "loop") return "#E6B84D";
  if (data.logicKind === "try") return "#D98A5B";
  if (data.logicKind === "if" || data.logicKind === "switch") return "#61DAFB";
  return data.greyed ? "#3A414C" : "#3B7AC0";
}

const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";

const DRAWER: React.CSSProperties = {
  width: "100%",
  height: "100%",
  minWidth: 0,
  minHeight: 0,
  boxSizing: "border-box",
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
  background: "#0B0E13",
  color: "#D6DEE9",
};

const HEADER: React.CSSProperties = {
  flexShrink: 0,
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
const REQUEST_CONTEXT: React.CSSProperties = { display: "flex", alignItems: "center", gap: 6, minWidth: 0, fontFamily: MONO, fontSize: 10.5 };
const REQUEST_EYEBROW: React.CSSProperties = { color: "#58C9A3", fontSize: 9, fontWeight: 750, letterSpacing: "0.09em" };
const REQUEST_NAME: React.CSSProperties = { minWidth: 0, maxWidth: 300, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "#AAB6C5" };
const REQUEST_CHIP: React.CSSProperties = { flexShrink: 0, border: "1px solid #2A3742", borderRadius: 999, padding: "1px 6px", color: "#8FA0B2" };
const REQUEST_EDGE_LEGEND: React.CSSProperties = { marginLeft: "auto", display: "flex", alignItems: "center", gap: 8, flexShrink: 0, color: "#788898", fontSize: 9 };
const REQUEST_EDGE_KEY: React.CSSProperties = { display: "inline-flex", alignItems: "center", gap: 4, whiteSpace: "nowrap" };
const REQUEST_EDGE_OBSERVED_SWATCH: React.CSSProperties = { width: 18, height: 0, borderTop: "3px solid #C8D3E0", borderRadius: 999, filter: "drop-shadow(0 0 3px rgba(88, 201, 163, 0.95))" };
const REQUEST_EDGE_CONTEXT_SWATCH: React.CSSProperties = { width: 18, height: 0, borderTop: "1px solid rgba(200, 211, 224, 0.32)" };
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
