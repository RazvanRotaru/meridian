/**
 * Request-on-map chrome, intentionally isolated from GraphSurface. The panel owns selection and
 * provenance; the toolbars paint compact evidence beside already-projected visible nodes. The
 * explicit reveal action delegates structural work to the store's shared codebase projection.
 */

import { useMemo } from "react";
import { NodeToolbar, Panel, Position, type Node } from "@xyflow/react";
import type { RequestTrace } from "@meridian/core";
import type { ProjectedRequestNodeEvidence, RequestEvidenceStatus, RequestEventCounts } from "../derive/requestGraphOverlay";
import { SEMANTIC_LAYER_CLASS, semanticLayerClass } from "../derive/moduleSemanticComposite";
import { useBlueprint, useBlueprintActions } from "../state/StoreContext";
import { TOKENS } from "./controlpanel/panelKit";
import { RequestNavigator } from "./RequestNavigator";
import { telemetryProvenance, telemetryProvenanceLabel } from "../telemetry/provenance";
import { requestPanelRightOffset } from "./canvas/panelLayout";

const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";
const OBSERVED = "#58C9A3";
const ERROR = "#F0787C";
const MIXED = "#E6B84D";
const NOT_OBSERVED = "#667180";
const EMPTY_NODE_IDS: ReadonlySet<string> = new Set<string>();

export interface RequestGraphVisibleSummary {
  /** Counts are optional because projection can mount before a surface has a visible population. */
  observedNodes?: number;
  errorNodes?: number;
  notObservedNodes?: number;
}

export interface RequestGraphOverlayPanelProps {
  graphMismatches: string[];
  observedNodeCount: number;
  visibleSummary?: RequestGraphVisibleSummary;
}

/**
 * Floating request-overlay controller. A trace remains explicitly opt-in on the map: loading a
 * bundle selects a default for the timeline, but Hide can clear the graph overlay without deleting
 * the captures. The compact restore control always chooses the newest capture deterministically.
 */
export function RequestGraphOverlayPanel(props: RequestGraphOverlayPanelProps) {
  const provider = useBlueprint((state) => state.provider);
  const coveragePanelOpen = useBlueprint((state) => state.coverageMode && state.coverage !== null);
  const telemetrySources = useBlueprint((state) => state.telemetrySources);
  const telemetrySourceId = useBlueprint((state) => state.telemetrySourceId);
  const environment = useBlueprint((state) => state.environment);
  const traces = useBlueprint((state) => state.requestTraces);
  const selectedTraceId = useBlueprint((state) => state.selectedTraceId);
  const source = useBlueprint((state) => state.traceSource);
  const loading = useBlueprint((state) => state.traceLoading);
  const error = useBlueprint((state) => state.traceError);
  const moduleLayoutStatus = useBlueprint((state) => state.moduleLayoutStatus);
  const minimalOpen = useBlueprint((state) => state.minimalSeedIds.length > 0);
  const selectedNodeIds = useBlueprint((state) => state.moduleSelected);
  const hoveredNodeIds = useBlueprint((state) => state.reviewLitNodeIds);
  const flowPaneOrigin = useBlueprint((state) => state.flowPaneOrigin);
  const requestFlowTraceId = useBlueprint((state) => state.requestFlowTraceId);
  const { openSelectedRequestFlowPane, revealSelectedTraceInCodebase, setSelectedTrace } = useBlueprintActions();
  const orderedTraces = useMemo(() => newestFirst(traces), [traces]);
  const provenance = telemetryProvenance(telemetrySources, telemetrySourceId, source);
  const panelStyle = requestPanelStyle(coveragePanelOpen);
  const selectedSource = telemetrySourceId === null
    ? null
    : telemetrySources.find((candidate) => candidate.id === telemetrySourceId) ?? null;
  const activeTrace = selectedTraceId === null
    ? null
    : orderedTraces.find((trace) => trace.traceId === selectedTraceId) ?? null;
  if (activeTrace === null && orderedTraces.length > 0) {
    const newest = orderedTraces[0]!;
    return (
      <Panel position="top-right" className="request-graph-overlay-panel nodrag nopan" style={panelStyle}>
        <div style={COMPACT_PANEL} aria-label="Request graph overlay hidden">
          <div style={COMPACT_COPY}>
            <span style={EYEBROW}>{telemetryProvenanceLabel(provenance)}</span>
            <span style={COMPACT_NAME} title={newest.name}>{newest.name}</span>
          </div>
          <button type="button" style={SHOW_BUTTON} onClick={() => setSelectedTrace(newest.traceId)}>
            Show request on map
          </button>
        </div>
      </Panel>
    );
  }

  if (activeTrace === null) {
    if (provider !== null && environment !== null) {
      const detail = selectedSource?.supportsTraces === false
        ? "This source provides aggregate metrics only."
        : loading
          ? `Loading request captures from ${environment}…`
          : error ?? `No request captures are available in ${environment}.`;
      return <RequestDataStatusPanel detail={detail} error={error !== null} panelStyle={panelStyle} />;
    }
    return provider !== null || telemetrySources.length > 0 ? <RequestDataSetupPanel panelStyle={panelStyle} /> : null;
  }

  const durationMs = requestDurationMs(activeTrace);
  const eventCount = activeTrace.spans.reduce((count, span) => count + span.events.length, 0);
  const completeness = activeTrace.completeness;
  // A bulk codebase reveal selects every observed target for fit/highlight. That set is not one
  // caller-context subject, so keep the path's deterministic deepest-chain fallback in that case.
  const callerContextIds = hoveredNodeIds ?? (selectedNodeIds.size === 1 ? selectedNodeIds : EMPTY_NODE_IDS);
  const callerContextKind = hoveredNodeIds !== null ? "Hovered" : selectedNodeIds.size === 1 ? "Selected" : null;
  const callerPath = parentSpanCallerPath(activeTrace, callerContextIds);
  const revealDisabledReason = requestRevealDisabledReason({
    graphMismatches: props.graphMismatches,
    observedNodeCount: props.observedNodeCount,
    minimalOpen,
    moduleLayoutStatus,
  });
  const flowOpen = flowPaneOrigin === "request" && requestFlowTraceId === activeTrace.traceId;
  const flowDisabledReason = requestFlowDisabledReason({
    graphMismatches: props.graphMismatches,
    spanCount: activeTrace.spans.length,
    minimalOpen,
    flowOpen,
  });
  return (
    <Panel position="top-right" className="request-graph-overlay-panel nodrag nopan" style={panelStyle}>
      <section style={PANEL} aria-label="Selected request graph overlay">
        <div style={HEADER_ROW}>
          <div style={IDENTITY}>
            <div style={EYEBROW}>{telemetryProvenanceLabel(provenance)}{environment ? ` · ${environment.toUpperCase()}` : ""}</div>
            <div style={REQUEST_NAME} title={activeTrace.name}>{activeTrace.name}</div>
            <div style={TRACE_ID} title={activeTrace.traceId}>{shortTraceId(activeTrace.traceId)}</div>
          </div>
          <button type="button" style={HIDE_BUTTON} onClick={() => setSelectedTrace(null)} aria-label="Hide request from map">
            Hide
          </button>
        </div>

        <div style={NAVIGATOR_WRAP}>
          <RequestNavigator
            traces={orderedTraces}
            activeTraceId={activeTrace.traceId}
            selectAriaLabel="Request shown on map"
            variant="panel"
            onChange={setSelectedTrace}
          />
        </div>

        <button
          type="button"
          style={revealButtonStyle(revealDisabledReason !== null)}
          disabled={revealDisabledReason !== null}
          title={revealDisabledReason ?? "Open the Map at the common ancestor and expand every observed code node"}
          aria-label={`Reveal observed nodes (${props.observedNodeCount})`}
          onClick={revealSelectedTraceInCodebase}
        >
          <span>Reveal observed nodes</span>
          <span style={REVEAL_COUNT}>{props.observedNodeCount}</span>
        </button>

        <button
          type="button"
          style={requestFlowButtonStyle(flowDisabledReason !== null, flowOpen)}
          disabled={flowDisabledReason !== null}
          title={flowDisabledReason ?? "Reconstruct this request from spans and observed decisions in the split view"}
          aria-label="Show selected request logic flow"
          onClick={openSelectedRequestFlowPane}
        >
          <span>Show request logic flow</span>
          <span style={FLOW_BADGE}>{flowOpen ? "OPEN" : `${activeTrace.spans.length} spans`}</span>
        </button>

        <RequestCallerContext path={callerPath} contextKind={callerContextKind} />

        <div style={SUMMARY_ROW} aria-label="Request capture summary">
          <SummaryChip label={activeTrace.status} color={statusColor(activeTrace.status)} />
          <SummaryChip label={`${formatDuration(durationMs)} total`} />
          <SummaryChip label={`${activeTrace.spans.length} span${activeTrace.spans.length === 1 ? "" : "s"}`} />
          <SummaryChip label={`${eventCount} event${eventCount === 1 ? "" : "s"}`} />
          <SummaryChip label={completeness.complete ? "complete capture" : "partial capture"} color={completeness.complete ? OBSERVED : MIXED} />
          {loading ? <span style={LOADING}>refreshing…</span> : null}
        </div>

        {!completeness.complete ? (
          <div style={DROPPED}>
            {completeness.droppedSpans} dropped spans · {completeness.droppedEvents} dropped events · {completeness.droppedValues} dropped values
          </div>
        ) : null}
        {props.graphMismatches.length > 0 ? (
          <div style={WARNING} role="alert">
            Map overlay disabled: trace graph reference mismatch ({props.graphMismatches.join("; ")}).
          </div>
        ) : null}
        {error ? <div style={ERROR_NOTICE}>Trace refresh failed; showing the last successful capture. {error}</div> : null}

        <RequestLegend summary={props.visibleSummary} />
      </section>
    </Panel>
  );
}

export function requestRevealDisabledReason(args: {
  graphMismatches: readonly string[];
  observedNodeCount: number;
  minimalOpen: boolean;
  moduleLayoutStatus: "idle" | "laying-out" | "ready" | "error";
}): string | null {
  if (args.graphMismatches.length > 0) return "This request belongs to a different graph.";
  if (args.observedNodeCount === 0) return "No spans in this request map to graph nodes.";
  if (args.minimalOpen) return "Close the extracted graph before revealing request nodes in the codebase.";
  if (args.moduleLayoutStatus === "laying-out") return "Wait for the graph layout to finish.";
  return null;
}

export function requestFlowDisabledReason(args: {
  graphMismatches: readonly string[];
  spanCount: number;
  minimalOpen: boolean;
  flowOpen: boolean;
}): string | null {
  if (args.flowOpen) return "This request logic flow is already open.";
  if (args.graphMismatches.length > 0) return "This request belongs to a different graph.";
  if (args.spanCount === 0) return "No spans were captured for this request.";
  if (args.minimalOpen) return "Close the extracted graph before opening the request split.";
  return null;
}

export interface ParentSpanCallerPath {
  labels: string[];
  targetLabel: string | null;
  matchedContext: boolean;
}

/**
 * Build the root-to-callee label chain using only declared parentSpanId relationships. When graph
 * context names an observed node, its earliest span is the target; otherwise the deepest observed
 * chain wins, with chronological/span-id order as the deterministic tie-break.
 */
export function parentSpanCallerPath(
  trace: RequestTrace,
  contextNodeIds: ReadonlySet<string> = new Set<string>(),
): ParentSpanCallerPath {
  const spans = [...trace.spans].sort(compareSpanChronology);
  if (spans.length === 0) return { labels: [], targetLabel: null, matchedContext: false };
  const byId = new Map(spans.map((span) => [span.spanId, span]));
  const contextTarget = spans.find((span) => span.nodeId !== undefined && contextNodeIds.has(span.nodeId));
  let target = contextTarget ?? spans[0]!;
  let targetChain = spanParentChain(target.spanId, byId);
  if (contextTarget === undefined) {
    for (const span of spans.slice(1)) {
      const chain = spanParentChain(span.spanId, byId);
      if (chain.length > targetChain.length) {
        target = span;
        targetChain = chain;
      }
    }
  }
  return {
    labels: targetChain.map((spanId) => byId.get(spanId)?.name ?? spanId),
    targetLabel: target.name,
    matchedContext: contextTarget !== undefined,
  };
}

function spanParentChain<Span extends { spanId: string; parentSpanId?: string }>(spanId: string, byId: ReadonlyMap<string, Span>): string[] {
  const reverse: string[] = [];
  const seen = new Set<string>();
  let current = byId.get(spanId);
  while (current !== undefined && !seen.has(current.spanId)) {
    seen.add(current.spanId);
    reverse.push(current.spanId);
    current = current.parentSpanId === undefined ? undefined : byId.get(current.parentSpanId);
  }
  return reverse.reverse();
}

function compareSpanChronology(left: RequestTrace["spans"][number], right: RequestTrace["spans"][number]): number {
  const a = nano(left.startedAtUnixNano);
  const b = nano(right.startedAtUnixNano);
  return a === b ? left.spanId.localeCompare(right.spanId) : a < b ? -1 : 1;
}

function RequestCallerContext(props: { path: ParentSpanCallerPath; contextKind: "Hovered" | "Selected" | null }) {
  if (props.path.labels.length === 0) return null;
  const label = props.path.labels.join(" → ");
  const context = props.path.matchedContext && props.contextKind !== null && props.path.targetLabel !== null
    ? `${props.contextKind.toUpperCase()} OBSERVED · ${props.path.targetLabel}`
    : null;
  return (
    <div style={CALL_PATH} aria-label={`Request call path: ${props.path.labels.join(" to ")}`}>
      <div style={CALL_PATH_HEADER}>
        <span>CALL PATH</span>
        {context ? <span style={CALL_CONTEXT}>{context}</span> : null}
      </div>
      <div style={CALL_PATH_VALUE} title={label}>{label}</div>
      <div style={CALL_PATH_HINT} aria-label="Request split-view hint">
        The request split reconstructs this whole execution; map clicks only inspect code.
      </div>
    </div>
  );
}

function RequestDataSetupPanel({ panelStyle }: { panelStyle?: React.CSSProperties }) {
  return (
    <Panel position="top-right" className="request-graph-overlay-panel nodrag nopan" style={panelStyle}>
      <div style={SETUP_PANEL} aria-label="Request overlay setup">
        <div style={SETUP_COPY}>
          <span style={EYEBROW}>REQUEST OVERLAY</span>
          <span style={MUTED}>Choose a source and environment under Request data in the left panel, then load it.</span>
        </div>
      </div>
    </Panel>
  );
}

function RequestDataStatusPanel(props: {
  detail: string;
  error: boolean;
  panelStyle?: React.CSSProperties;
}) {
  return (
    <Panel position="top-right" className="request-graph-overlay-panel nodrag nopan" style={props.panelStyle}>
      <div style={SETUP_PANEL} aria-label="Request overlay status">
        <div style={SETUP_COPY}>
          <span style={EYEBROW}>REQUEST OVERLAY</span>
          <span style={props.error ? ERROR_TEXT : MUTED}>{props.detail}</span>
        </div>
      </div>
    </Panel>
  );
}

function requestPanelStyle(coveragePanelOpen: boolean): React.CSSProperties | undefined {
  const right = requestPanelRightOffset(coveragePanelOpen);
  return right === undefined ? undefined : { right };
}

function RequestLegend({ summary }: { summary?: RequestGraphVisibleSummary }) {
  return (
    <div style={LEGEND} aria-label="Request graph legend">
      <LegendItem color={OBSERVED} label="Observed in selected request" count={summary?.observedNodes} />
      <LegendItem color={ERROR} label="Error in selected request" count={summary?.errorNodes} />
      <LegendItem color={NOT_OBSERVED} label="Not observed in selected request" count={summary?.notObservedNodes} />
    </div>
  );
}

function LegendItem(props: { color: string; label: string; count?: number }) {
  return (
    <span style={LEGEND_ITEM}>
      <span style={{ ...SWATCH, background: props.color }} />
      {props.label}{props.count === undefined ? "" : ` (${props.count})`}
    </span>
  );
}

function SummaryChip(props: { label: string; color?: string }) {
  const color = props.color ?? "#96A2B2";
  return <span style={{ ...CHIP, color, borderColor: `${color}66` }}>{props.label}</span>;
}

/**
 * The exact projected evidence type is accepted directly. `NodeToolbar` keeps badges out of node
 * layout, and semantic-depth classes make each badge obey the same hidden/visible LOD band as its
 * owning card.
 */
export function RequestGraphNodeBadges(props: {
  visibleNodes: readonly Node[];
  evidenceByNodeId: ReadonlyMap<string, ProjectedRequestNodeEvidence>;
}) {
  return (
    <>
      {props.visibleNodes.map((node) => {
        const evidence = props.evidenceByNodeId.get(node.id);
        if (!evidence) return null;
        const depth = semanticDepthOf(node);
        const events = totalEvents(evidence.eventCounts);
        const duration = evidence.activeWallMs;
        const color = statusColor(evidence.status);
        const label = evidenceLabel(evidence, duration, events);
        return (
          <NodeToolbar
            key={node.id}
            nodeId={node.id}
            isVisible
            position={Position.Top}
            offset={6}
            className={toolbarClass(depth)}
            style={TOOLBAR}
            data-request-node-id={node.id}
            data-request-status={evidence.status}
          >
            <div style={{ ...NODE_BADGE, color, borderColor: `${color}99` }} aria-label={label} title={label}>
              <span style={{ ...STATUS_DOT, background: color }} />
              <strong>#{evidence.firstSequence}</strong>
              <span>{formatDuration(duration)}</span>
              {evidence.occurrenceCount > 1 ? <span title={`${evidence.occurrenceCount} span occurrences`}>×{evidence.occurrenceCount}</span> : null}
              {events > 0 ? <span title={`${events} captured events`}>{events} evt</span> : null}
            </div>
          </NodeToolbar>
        );
      })}
    </>
  );
}

function semanticDepthOf(node: Node): number | undefined {
  const depth = (node.data as { semanticDepth?: unknown }).semanticDepth;
  return typeof depth === "number" && Number.isInteger(depth) && depth >= 0 ? depth : undefined;
}

function toolbarClass(depth: number | undefined): string {
  return depth === undefined
    ? "request-graph-node-toolbar"
    : `request-graph-node-toolbar ${SEMANTIC_LAYER_CLASS} ${semanticLayerClass(depth)}`;
}

function evidenceLabel(evidence: ProjectedRequestNodeEvidence, durationMs: number, events: number): string {
  const status = evidence.status === "mixed" ? "mixed status" : `${evidence.status} status`;
  return `Observed #${evidence.firstSequence}, ${formatDuration(durationMs)}, ${evidence.occurrenceCount} occurrence${evidence.occurrenceCount === 1 ? "" : "s"}, ${events} event${events === 1 ? "" : "s"}, ${status}`;
}

function totalEvents(counts: RequestEventCounts): number {
  return counts.branchTaken + counts.dataObserve + counts.loopSummary + counts.asyncHandoff + counts.exception;
}

function newestFirst(traces: readonly RequestTrace[]): RequestTrace[] {
  return [...traces].sort((left, right) => {
    const a = nano(left.startedAtUnixNano);
    const b = nano(right.startedAtUnixNano);
    return a === b ? left.traceId.localeCompare(right.traceId) : a > b ? -1 : 1;
  });
}

function requestDurationMs(trace: RequestTrace): number {
  const start = nano(trace.startedAtUnixNano);
  const end = nano(trace.endedAtUnixNano);
  return nanoToMs(end > start ? end - start : 0n);
}

function nano(value: string): bigint {
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
}

function nanoToMs(value: bigint): number {
  return Number(value) / 1_000_000;
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0µs";
  if (ms >= 1000) return `${(ms / 1000).toFixed(ms >= 10_000 ? 1 : 2)}s`;
  if (ms >= 100) return `${ms.toFixed(0)}ms`;
  if (ms >= 10) return `${ms.toFixed(1)}ms`;
  if (ms >= 1) return `${ms.toFixed(2)}ms`;
  return `${Math.max(ms * 1000, 0).toFixed(0)}µs`;
}

function shortTraceId(traceId: string): string {
  return traceId.length <= 16 ? traceId : `${traceId.slice(0, 8)}…${traceId.slice(-6)}`;
}

function statusColor(status: RequestEvidenceStatus | RequestTrace["status"]): string {
  if (status === "error") return ERROR;
  if (status === "mixed") return MIXED;
  if (status === "ok") return OBSERVED;
  return NOT_OBSERVED;
}

const PANEL: React.CSSProperties = {
  width: 360,
  boxSizing: "border-box",
  border: `1px solid ${TOKENS.surfaceBorder}`,
  borderRadius: 10,
  background: "rgba(18,22,28,0.96)",
  boxShadow: "0 14px 36px rgba(0,0,0,0.3)",
  padding: 12,
  color: TOKENS.text,
  fontFamily: MONO,
};
const COMPACT_PANEL: React.CSSProperties = {
  ...PANEL,
  width: 330,
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 12,
  padding: "9px 10px",
};
const SETUP_PANEL: React.CSSProperties = { ...PANEL, width: 330 };
const ERROR_TEXT: React.CSSProperties = { color: "#D99A9E" };
const SETUP_COPY: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 4 };
const HEADER_ROW: React.CSSProperties = { display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 };
const IDENTITY: React.CSSProperties = { minWidth: 0, flex: 1 };
const EYEBROW: React.CSSProperties = { color: "#72C7D1", fontSize: 8.5, letterSpacing: "0.11em", fontWeight: 700 };
const REQUEST_NAME: React.CSSProperties = { marginTop: 4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 13, fontWeight: 750 };
const TRACE_ID: React.CSSProperties = { marginTop: 3, color: TOKENS.textDim, fontSize: 9.5 };
const HIDE_BUTTON: React.CSSProperties = { border: "none", background: "transparent", color: TOKENS.textMuted, cursor: "pointer", padding: "1px 2px", font: "inherit", fontSize: 10.5 };
const NAVIGATOR_WRAP: React.CSSProperties = { marginTop: 10 };
const REVEAL_COUNT: React.CSSProperties = { minWidth: 19, borderRadius: 999, background: "rgba(88,201,163,0.14)", padding: "1px 5px", color: OBSERVED, fontSize: 8.5, textAlign: "center" };
const FLOW_BADGE: React.CSSProperties = { minWidth: 32, borderRadius: 999, background: "rgba(114,199,209,0.12)", padding: "1px 6px", color: "#72C7D1", fontSize: 8, textAlign: "center", textTransform: "uppercase" };
const CALL_PATH: React.CSSProperties = { marginTop: 9, border: `1px solid ${TOKENS.surfaceBorder}`, borderRadius: 6, background: "rgba(8,11,15,0.42)", padding: "6px 7px" };
const CALL_PATH_HEADER: React.CSSProperties = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6, color: TOKENS.label, fontSize: 8, letterSpacing: "0.08em" };
const CALL_CONTEXT: React.CSSProperties = { maxWidth: 190, overflow: "hidden", textOverflow: "ellipsis", color: OBSERVED, fontSize: 7.5, letterSpacing: "0.04em", whiteSpace: "nowrap" };
const CALL_PATH_VALUE: React.CSSProperties = { marginTop: 4, overflow: "hidden", textOverflow: "ellipsis", color: TOKENS.textMuted, fontSize: 9.5, lineHeight: 1.35, whiteSpace: "nowrap" };
const CALL_PATH_HINT: React.CSSProperties = { marginTop: 4, color: TOKENS.textDim, fontSize: 8.5, lineHeight: 1.35 };
const SUMMARY_ROW: React.CSSProperties = { display: "flex", alignItems: "center", flexWrap: "wrap", gap: 5, marginTop: 9 };
const CHIP: React.CSSProperties = { border: "1px solid", borderRadius: 999, padding: "1px 6px", fontSize: 8.5, lineHeight: "13px" };
const LOADING: React.CSSProperties = { marginLeft: "auto", color: "#72C7D1", fontSize: 9 };
const DROPPED: React.CSSProperties = { marginTop: 7, color: MIXED, fontSize: 9 };
const WARNING: React.CSSProperties = { marginTop: 8, border: "1px solid #795B2E", borderRadius: 6, background: "rgba(230,184,77,0.08)", color: "#D8BC7A", padding: "6px 7px", fontSize: 9.5, lineHeight: 1.4 };
const ERROR_NOTICE: React.CSSProperties = { ...WARNING, borderColor: "#6E3438", background: "rgba(240,120,124,0.06)", color: "#D99A9E" };
const LEGEND: React.CSSProperties = { display: "grid", gap: 4, marginTop: 10, paddingTop: 8, borderTop: `1px solid ${TOKENS.divider}` };
const LEGEND_ITEM: React.CSSProperties = { display: "flex", alignItems: "center", gap: 6, color: TOKENS.textMuted, fontSize: 9 };
const SWATCH: React.CSSProperties = { width: 7, height: 7, flexShrink: 0, borderRadius: 2 };
const COMPACT_COPY: React.CSSProperties = { display: "flex", minWidth: 0, flexDirection: "column", gap: 3 };
const COMPACT_NAME: React.CSSProperties = { color: TOKENS.textMuted, fontSize: 9.5, maxWidth: 150, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
const SHOW_BUTTON: React.CSSProperties = { flexShrink: 0, border: "1px solid rgba(88,201,163,0.42)", borderRadius: 6, background: "rgba(88,201,163,0.1)", color: OBSERVED, cursor: "pointer", padding: "5px 8px", fontFamily: MONO, fontSize: 9.5 };
const MUTED: React.CSSProperties = { color: TOKENS.textMuted, fontSize: 9.5, lineHeight: 1.4 };
const TOOLBAR: React.CSSProperties = { pointerEvents: "none" };
const NODE_BADGE: React.CSSProperties = { display: "inline-flex", alignItems: "center", gap: 5, border: "1px solid", borderRadius: 999, background: "rgba(10,13,18,0.94)", boxShadow: "0 4px 12px rgba(0,0,0,0.28)", padding: "2px 7px", fontFamily: MONO, fontSize: 8.5, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" };
const STATUS_DOT: React.CSSProperties = { width: 5, height: 5, borderRadius: 999, flexShrink: 0 };

function revealButtonStyle(disabled: boolean): React.CSSProperties {
  return {
    width: "100%",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    marginTop: 9,
    border: `1px solid ${disabled ? TOKENS.surfaceBorder : "rgba(88,201,163,0.42)"}`,
    borderRadius: 6,
    background: disabled ? "rgba(255,255,255,0.02)" : "rgba(88,201,163,0.08)",
    color: disabled ? TOKENS.textDim : TOKENS.textMuted,
    cursor: disabled ? "default" : "pointer",
    padding: "6px 7px",
    fontFamily: MONO,
    fontSize: 9.5,
    textAlign: "left",
  };
}

function requestFlowButtonStyle(disabled: boolean, open: boolean): React.CSSProperties {
  return {
    ...revealButtonStyle(disabled),
    marginTop: 6,
    borderColor: disabled ? TOKENS.surfaceBorder : "rgba(114,199,209,0.42)",
    background: open ? "rgba(114,199,209,0.12)" : disabled ? "rgba(255,255,255,0.02)" : "rgba(114,199,209,0.07)",
    color: open ? "#72C7D1" : disabled ? TOKENS.textDim : TOKENS.textMuted,
  };
}
