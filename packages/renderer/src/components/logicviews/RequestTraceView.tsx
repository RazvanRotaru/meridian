/**
 * AppMap-style view of ONE request capture: nested spans on a shared real-time axis, with compact
 * event pins for decisions, captured data, loop summaries, async handoffs, and exceptions. It owns only
 * presentation + the selected event; bundle/environment/request state remains in the blueprint store
 * and all clock/hierarchy derivation lives in the pure `requestTimelineModel`.
 */

import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { RequestTrace, TelemetryProvenance, TimelineEvent, TimelineSpan } from "@meridian/core";
import { useBlueprint, useBlueprintActions } from "../../state/StoreContext";
import type { FlowViewProps } from "../../derive/flowViewModel";
import { FLOW_COLORS } from "../../derive/flowViewModel";
import { RequestNavigator } from "../RequestNavigator";
import {
  branchProbePreview,
  buildRequestTimeline,
  displayJson,
  requestEventKey,
  requestTraceCandidates,
  traceGraphRefMismatches,
  type RequestTimelineEvent,
  type RequestTimelineRow,
} from "../../derive/requestTimelineModel";
import { telemetryProvenance, telemetryProvenanceLabel } from "../../telemetry/provenance";

const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";
const LABEL_WIDTH = 280;

export function RequestTraceView(props: Pick<FlowViewProps, "rootId" | "index" | "selected" | "onSelect" | "onDrill">) {
  const environment = useBlueprint((state) => state.environment);
  const provider = useBlueprint((state) => state.provider);
  const telemetrySources = useBlueprint((state) => state.telemetrySources);
  const telemetrySourceId = useBlueprint((state) => state.telemetrySourceId);
  const traces = useBlueprint((state) => state.requestTraces);
  const selectedTraceId = useBlueprint((state) => state.selectedTraceId);
  const traceLoading = useBlueprint((state) => state.traceLoading);
  const traceError = useBlueprint((state) => state.traceError);
  const traceGraphRef = useBlueprint((state) => state.traceGraphRef);
  const traceSource = useBlueprint((state) => state.traceSource);
  const artifact = useBlueprint((state) => state.artifact);
  const setSelectedTrace = useBlueprintActions().setSelectedTrace;
  const [selectedEventKey, setSelectedEventKey] = useState<string | null>(null);
  const candidates = useMemo(() => requestTraceCandidates(traces, props.rootId), [traces, props.rootId]);
  const activeTrace = candidates.traces.find((trace) => trace.traceId === selectedTraceId) ?? candidates.traces[0] ?? null;
  const model = useMemo(() => activeTrace ? buildRequestTimeline(activeTrace) : null, [activeTrace]);
  const selectedEvent = model?.events.find((entry) => requestEventKey(entry.spanId, entry.event.eventId) === selectedEventKey) ?? null;
  const graphMismatches = useMemo(() => traceGraphRefMismatches(traceGraphRef, artifact), [traceGraphRef, artifact]);
  const graphMappingEnabled = graphMismatches.length === 0;
  const rootName = props.index.nodesById.get(props.rootId)?.displayName ?? props.rootId;
  const provenance = telemetryProvenance(telemetrySources, telemetrySourceId, traceSource);
  const selectedSource = telemetrySourceId === null
    ? null
    : telemetrySources.find((source) => source.id === telemetrySourceId) ?? null;

  // A root change can narrow the candidate set. Keep the store's selection truthful so another
  // request-view mount (or a later refresh) sees the same active trace the selector displays.
  useEffect(() => {
    if (activeTrace && activeTrace.traceId !== selectedTraceId) setSelectedTrace(activeTrace.traceId);
  }, [activeTrace, selectedTraceId, setSelectedTrace]);
  useEffect(() => setSelectedEventKey(null), [activeTrace?.traceId]);

  if (!provider) {
    if (telemetrySources.length === 0) {
      return (
        <Empty
          title="Request telemetry isn't available"
          detail="This session does not advertise a request telemetry source."
        />
      );
    }
    return (
      <Empty
        title="Choose request data"
        detail="Select a source and environment under Request data in the left panel, then load it to inspect request timing, branches, and captured data. Nothing loads automatically."
      />
    );
  }
  if (environment === null) {
    return (
      <Empty
        title="Load request data"
        detail="Confirm the source and environment under Request data in the left panel, then click Load. Nothing loads automatically."
      />
    );
  }
  if (selectedSource?.supportsTraces === false) {
    return (
      <Empty
        title="Request traces unavailable"
        detail={`${selectedSource.label} provides aggregate metrics only.`}
      />
    );
  }
  if (traceLoading && traces.length === 0) {
    return <Empty title="Loading request traces…" detail={`Reading request captures from ${environment}.`} busy />;
  }
  if (!activeTrace || !model) {
    return (
      <Empty
        title={traceError ? "Request traces unavailable" : "No matching request trace"}
        detail={traceError ?? `No request capture in ${environment} includes ${rootName}. Run the flow, then load telemetry again.`}
        tone={traceError ? "error" : "neutral"}
      />
    );
  }

  return (
    <section style={SURFACE} aria-label="Request trace timeline">
      <TraceHeader
        trace={activeTrace}
        modelDurationMs={model.durationMs}
        traces={candidates.traces}
        environment={environment}
        rootName={rootName}
        matchesRoot={candidates.matchesRoot}
        loading={traceLoading}
        error={traceError}
        provenance={provenance}
        graphMismatches={graphMismatches}
        onChange={setSelectedTrace}
      />
      <div style={TIMELINE_CARD}>
        <TimeAxis durationMs={model.durationMs} />
        <div role="tree" aria-label={`${activeTrace.name} span waterfall`}>
          {model.rows.map((row) => (
            <SpanRow
              key={row.span.spanId}
              row={row}
              selectedNodeId={props.selected}
              selectedEventKey={selectedEventKey}
              graphMappingEnabled={graphMappingEnabled}
              nodeExists={row.span.nodeId !== undefined && props.index.nodesById.has(row.span.nodeId)}
              onSelectNode={props.onSelect}
              onDrillNode={props.onDrill}
              onSelectEvent={setSelectedEventKey}
            />
          ))}
        </div>
        {model.rows.length === 0 ? <div style={NO_SPANS}>This request contains no spans.</div> : null}
      </div>
      {selectedEvent ? <EventDetail entry={selectedEvent} onClose={() => setSelectedEventKey(null)} /> : (
        <div style={DETAIL_HINT}>Select an event pin to inspect the branch, captured data, loop, async handoff, or exception.</div>
      )}
    </section>
  );
}

function TraceHeader(props: {
  trace: RequestTrace;
  modelDurationMs: number;
  traces: RequestTrace[];
  environment: string;
  rootName: string;
  matchesRoot: boolean;
  loading: boolean;
  error: string | null;
  provenance: TelemetryProvenance | null;
  graphMismatches: string[];
  onChange(id: string): void;
}) {
  return (
    <header style={HEADER}>
      <div style={HEADER_TOP}>
        <div style={HEADER_IDENTITY}>
          <div style={EYEBROW}>{telemetryProvenanceLabel(props.provenance)} · {props.environment.toUpperCase()}</div>
          <div style={REQUEST_NAME}>{props.trace.name}</div>
          <div style={TRACE_ID} title={props.trace.traceId}>{shortTraceId(props.trace.traceId)} · {formatStartedAt(props.trace.startedAtUnixNano)}</div>
        </div>
        <RequestNavigator
          traces={props.traces}
          activeTraceId={props.trace.traceId}
          selectAriaLabel="Request trace selection"
          variant="timeline"
          onChange={props.onChange}
        />
      </div>
      <div style={SUMMARY_ROW}>
        <StatusChip status={props.trace.status} />
        <SummaryChip label={`${formatDuration(props.modelDurationMs)} total`} />
        <SummaryChip label={`${props.trace.spans.length} span${props.trace.spans.length === 1 ? "" : "s"}`} />
        <SummaryChip label={`${props.trace.spans.reduce((count, span) => count + span.events.length, 0)} events`} />
        <SummaryChip label={props.trace.completeness.complete ? "complete capture" : "partial capture"} warning={!props.trace.completeness.complete} />
        {!props.trace.completeness.complete ? (
          <>
            <SummaryChip label={`${props.trace.completeness.droppedSpans} dropped spans`} warning />
            <SummaryChip label={`${props.trace.completeness.droppedEvents} dropped events`} warning />
            <SummaryChip label={`${props.trace.completeness.droppedValues} dropped values`} warning />
          </>
        ) : null}
        {props.loading ? <span style={LOADING}>refreshing…</span> : null}
      </div>
      {props.graphMismatches.length > 0 ? (
        <div style={MISMATCH_NOTICE} role="alert">
          Trace graph reference does not match the loaded artifact ({props.graphMismatches.join("; ")}). Span-to-graph selection and drill-down are disabled.
        </div>
      ) : null}
      {!props.matchesRoot ? (
        <div style={NOTICE}>No loaded request contains <b>{props.rootName}</b>; showing all request captures instead.</div>
      ) : null}
      {props.error ? <div style={ERROR_NOTICE}>Trace refresh failed; showing the last successful capture. {props.error}</div> : null}
    </header>
  );
}

function TimeAxis({ durationMs }: { durationMs: number }) {
  const ticks = [0, 0.25, 0.5, 0.75, 1];
  return (
    <div style={AXIS_ROW} aria-hidden="true">
      <div style={AXIS_LABEL}>CALL STACK</div>
      <div style={AXIS_TRACK}>
        {ticks.map((ratio) => (
          <div key={ratio} style={{ ...TICK, left: `${ratio * 100}%` }}>
            <span style={TICK_LABEL}>{formatDuration(durationMs * ratio)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function SpanRow(props: {
  row: RequestTimelineRow;
  selectedNodeId: string | null;
  selectedEventKey: string | null;
  graphMappingEnabled: boolean;
  nodeExists: boolean;
  onSelectNode(nodeId: string | null): void;
  onDrillNode(nodeId: string): void;
  onSelectEvent(eventId: string): void;
}) {
  const span = props.row.span;
  const clickable = props.graphMappingEnabled && props.nodeExists && span.nodeId !== undefined;
  const selected = clickable && span.nodeId === props.selectedNodeId;
  const color = spanColor(span);
  const mappingLabel = !props.graphMappingEnabled ? "MAPPING OFF" : !props.nodeExists || span.nodeId === undefined ? "UNMAPPED" : null;
  const activate = (drill: boolean) => {
    if (!clickable || span.nodeId === undefined) return;
    if (drill) props.onDrillNode(span.nodeId);
    else props.onSelectNode(span.nodeId);
  };
  return (
    <div
      role="treeitem"
      aria-level={props.row.depth + 1}
      aria-selected={selected}
      aria-disabled={!clickable}
      aria-label={`${span.name}${props.row.linkedFrom ? `, ${props.row.linkedFrom.relation} link` : ""}${mappingLabel ? `, ${mappingLabel.toLowerCase()}` : ""}`}
      tabIndex={clickable ? 0 : undefined}
      style={{ ...ROW, background: selected ? "rgba(107,227,138,0.055)" : undefined }}
      onClick={(event) => {
        event.stopPropagation();
        activate(false);
      }}
      onDoubleClick={(event) => {
        event.stopPropagation();
        activate(true);
      }}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        event.stopPropagation();
        activate(event.key === "Enter" && event.shiftKey);
      }}
    >
      <div
        style={{ ...SPAN_LABEL, paddingLeft: 12 + props.row.depth * 18, cursor: clickable ? "pointer" : "default" }}
        title={clickable ? span.nodeId : mappingLabel === "MAPPING OFF" ? "Graph mapping disabled: trace bundle does not match this artifact" : "No matching node exists in the loaded artifact"}
      >
        {props.row.depth > 0 ? <span style={TREE_ELBOW}>{props.row.linkedFrom ? "↝" : "└"}</span> : null}
        <span style={{ ...KIND_DOT, background: color }} />
        <span style={SPAN_NAME}>{span.name}</span>
        {props.row.linkedFrom ? <span style={LINK_KIND}>{props.row.linkedFrom.relation} link</span> : null}
        {mappingLabel ? <span style={UNMAPPED}>{mappingLabel}</span> : null}
        <span style={SPAN_KIND}>{span.kind}</span>
        <span style={SPAN_DURATION}>{formatDuration(props.row.durationMs)}</span>
      </div>
      <div style={TRACK}>
        <div
          style={{
            ...BAR,
            left: `${props.row.startRatio * 100}%`,
            width: `${Math.min(props.row.widthRatio, 1 - props.row.startRatio) * 100}%`,
            background: `${color}28`,
            borderColor: color,
            borderStyle: props.row.linkedFrom ? "dashed" : "solid",
            boxShadow: selected ? `0 0 0 1px ${FLOW_COLORS.select}, 0 0 14px ${FLOW_COLORS.select}35` : undefined,
          }}
          title={`${span.name} · ${formatDuration(props.row.durationMs)} · starts ${formatDuration(props.row.startMs)}`}
        >
          <span style={BAR_TEXT}>{formatDuration(props.row.durationMs)}</span>
        </div>
        {props.row.events.map((entry) => (
          <EventPin
            key={requestEventKey(entry.spanId, entry.event.eventId)}
            entry={entry}
            active={requestEventKey(entry.spanId, entry.event.eventId) === props.selectedEventKey}
            onClick={() => props.onSelectEvent(requestEventKey(entry.spanId, entry.event.eventId))}
          />
        ))}
      </div>
    </div>
  );
}

function EventPin({ entry, active, onClick }: { entry: RequestTimelineEvent; active: boolean; onClick(): void }) {
  const event = entry.event;
  const color = eventColor(event);
  return (
    <button
      type="button"
      style={{
        ...EVENT_PIN,
        left: `${entry.offsetRatio * 100}%`,
        color,
        borderColor: active ? "#E6EDF3" : color,
        background: active ? color : FLOW_COLORS.card,
        boxShadow: active ? `0 0 0 2px ${color}45` : undefined,
      }}
      title={`${eventLabel(event)} · ${formatDuration(entry.offsetMs)}`}
      aria-label={`${eventLabel(event)} at ${formatDuration(entry.offsetMs)}`}
      onKeyDown={(key) => key.stopPropagation()}
      onClick={(click) => { click.stopPropagation(); onClick(); }}
      onDoubleClick={(click) => click.stopPropagation()}
    >
      {eventGlyph(event)}
    </button>
  );
}

function EventDetail({ entry, onClose }: { entry: RequestTimelineEvent; onClose(): void }) {
  const event = entry.event;
  const preview = branchProbePreview(event, entry.nodeId);
  return (
    <aside style={DETAIL} aria-label="Selected trace event">
      <div style={DETAIL_HEADER}>
        <span style={{ ...DETAIL_GLYPH, color: eventColor(event) }}>{eventGlyph(event)}</span>
        <div style={DETAIL_TITLE_WRAP}>
          <div style={DETAIL_TITLE}>{eventLabel(event)}</div>
          <div style={DETAIL_SUBTITLE}>{event.type} · +{formatDuration(entry.offsetMs)}</div>
        </div>
        <button type="button" style={CLOSE} onClick={onClose} aria-label="Close event details">×</button>
      </div>
      <div style={DETAIL_GRID}>
        <TypedEventFields event={event} />
        {entry.nodeId ? <DetailField label="Node" value={entry.nodeId} wide /> : null}
        {Object.keys(event.attributes).length > 0 ? <DetailField label="Attributes" value={displayJson(event.attributes)} code wide /> : null}
      </div>
      {preview ? (
        <div style={PROBE_SECTION}>
          <div style={PROBE_HEADING}>GENERATED PROBE PREVIEW</div>
          <div style={PROBE_EXPLAIN}>A source-aware codemod can insert this probe from the branch’s stable site and node IDs.</div>
          <pre style={PROBE}>{preview}</pre>
        </div>
      ) : null}
    </aside>
  );
}

function TypedEventFields({ event }: { event: TimelineEvent }) {
  if (event.type === "branch.taken") {
    return (
      <>
        <DetailField label="Condition" value={event.condition} wide />
        {"valueName" in event && typeof event.valueName === "string" ? <DetailField label="Value name" value={event.valueName} /> : null}
        <DetailField label="Outcome" value={displayJson(event.outcome)} />
        <DetailField label="Path" value={event.pathId} />
        <DetailField label="Site" value={event.siteId} />
        <DetailField label="Source" value={sourceLabel(event.source)} />
        {event.value === undefined ? null : <DetailField label="Observed value" value={displayJson(event.value)} code wide />}
      </>
    );
  }
  if (event.type === "data.observe") {
    return (
      <>
        <DetailField label="Data" value={event.name} />
        <DetailField label="Value ID" value={event.valueId} />
        <DetailField label="Value" value={displayJson(event.value)} code wide />
        {event.derivedFrom?.length ? <DetailField label="Derived from" value={event.derivedFrom.join(" → ")} wide /> : null}
        {event.siteId ? <DetailField label="Site" value={event.siteId} /> : null}
        {event.source ? <DetailField label="Source" value={sourceLabel(event.source)} /> : null}
      </>
    );
  }
  if (event.type === "loop.summary") {
    return (
      <>
        <DetailField label="Loop" value={event.label} wide />
        <DetailField label="Iterations" value={String(event.iterations)} />
        <DetailField label="Emitted" value={String(event.emittedIterations)} />
        <DetailField label="Truncated" value={event.truncated ? "yes" : "no"} />
        <DetailField label="Site" value={event.siteId} />
        <DetailField label="Source" value={sourceLabel(event.source)} />
      </>
    );
  }
  if (event.type === "async.handoff") {
    return (
      <>
        <DetailField label="Handoff" value={event.mode} />
        <DetailField label="Site" value={event.siteId} />
        {event.targetSpanId ? <DetailField label="Target span" value={event.targetSpanId} wide /> : null}
        <DetailField label="Source" value={sourceLabel(event.source)} wide />
      </>
    );
  }
  return (
    <>
      <DetailField label="Exception" value={event.exceptionType} />
      <DetailField label="Handled" value={event.handled ? "yes" : "no"} />
      {event.message ? <DetailField label="Message" value={event.message} wide /> : null}
      {event.siteId ? <DetailField label="Site" value={event.siteId} /> : null}
      {event.source ? <DetailField label="Source" value={sourceLabel(event.source)} /> : null}
    </>
  );
}

function DetailField({ label, value, code, wide }: { label: string; value: string; code?: boolean; wide?: boolean }) {
  return (
    <div style={{ ...FIELD, gridColumn: wide ? "1 / -1" : undefined }}>
      <div style={FIELD_LABEL}>{label}</div>
      <div style={code ? FIELD_CODE : FIELD_VALUE}>{value}</div>
    </div>
  );
}

function Empty({ title, detail, busy, tone = "neutral", content }: {
  title: string;
  detail: string;
  busy?: boolean;
  tone?: "neutral" | "error";
  content?: ReactNode;
}) {
  return (
    <div style={EMPTY_WRAP} aria-busy={busy ? "true" : undefined}>
      <div style={{ ...EMPTY_CARD, borderColor: tone === "error" ? "#6E3438" : "#2A3140" }}>
        <div style={{ ...EMPTY_ICON, color: tone === "error" ? "#F0787C" : FLOW_COLORS.awaited }}>{busy ? "◌" : tone === "error" ? "!" : "◷"}</div>
        <div style={EMPTY_TITLE}>{title}</div>
        <div style={EMPTY_DETAIL}>{detail}</div>
        {content ? <div style={EMPTY_CONTENT}>{content}</div> : null}
      </div>
    </div>
  );
}

function StatusChip({ status }: { status: RequestTrace["status"] }) {
  const color = status === "error" ? "#F0787C" : status === "ok" ? "#56C271" : "#8A93A0";
  return <span style={{ ...CHIP, color, borderColor: `${color}80`, background: `${color}12` }}>{status.toUpperCase()}</span>;
}

function SummaryChip({ label, warning }: { label: string; warning?: boolean }) {
  return <span style={{ ...CHIP, color: warning ? "#E6B84D" : "#9AA4B2", borderColor: warning ? "#6B582D" : "#303744" }}>{label}</span>;
}

function spanColor(span: TimelineSpan): string {
  if (span.status === "error") return "#F0787C";
  return {
    server: "#5BB4E8",
    client: "#A47BD6",
    producer: "#D98A5B",
    consumer: "#5FA8A0",
    internal: "#5E74C6",
  }[span.kind];
}

function eventColor(event: TimelineEvent): string {
  if (event.type === "branch.taken") return FLOW_COLORS.branch;
  if (event.type === "data.observe") return FLOW_COLORS.select;
  if (event.type === "loop.summary") return FLOW_COLORS.loop;
  if (event.type === "async.handoff") return FLOW_COLORS.awaited;
  return FLOW_COLORS.exitCap;
}

function eventGlyph(event: TimelineEvent): string {
  if (event.type === "branch.taken") return "◆";
  if (event.type === "data.observe") return "●";
  if (event.type === "loop.summary") return "↻";
  if (event.type === "async.handoff") return "⇢";
  return "⚡";
}

function eventLabel(event: TimelineEvent): string {
  if (event.type === "branch.taken") return `${event.condition} → ${String(event.outcome)}`;
  if (event.type === "data.observe") return event.name;
  if (event.type === "loop.summary") return `${event.label} · ${event.iterations} iterations`;
  if (event.type === "async.handoff") return `${event.mode} async handoff${event.targetSpanId ? ` → ${event.targetSpanId}` : ""}`;
  return event.exceptionType;
}

function sourceLabel(source: { file: string; line: number; col?: number }): string {
  return `${source.file}:${source.line}${source.col === undefined ? "" : `:${source.col}`}`;
}

function shortTraceId(traceId: string): string {
  return traceId.length <= 16 ? traceId : `${traceId.slice(0, 8)}…${traceId.slice(-6)}`;
}

function formatStartedAt(unixNano: string): string {
  try {
    return new Date(Number(BigInt(unixNano) / 1_000_000n)).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", fractionalSecondDigits: 3 });
  } catch {
    return unixNano;
  }
}

function formatDuration(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(ms >= 10_000 ? 1 : 2)}s`;
  if (ms >= 100) return `${ms.toFixed(0)}ms`;
  if (ms >= 10) return `${ms.toFixed(1)}ms`;
  if (ms >= 1) return `${ms.toFixed(2)}ms`;
  return `${Math.max(ms * 1000, 0).toFixed(0)}µs`;
}

const SURFACE: React.CSSProperties = {
  width: "calc(100vw - 400px)",
  minWidth: 820,
  maxWidth: 1160,
  boxSizing: "border-box",
  padding: "66px 24px 90px",
  fontFamily: MONO,
  color: FLOW_COLORS.ink,
};
const HEADER: React.CSSProperties = { marginBottom: 14, border: "1px solid #2A3140", borderRadius: 10, background: "rgba(18,23,30,0.96)", padding: "15px 16px", boxShadow: "0 12px 30px rgba(0,0,0,0.22)" };
const HEADER_TOP: React.CSSProperties = { display: "flex", alignItems: "flex-start", gap: 22, justifyContent: "space-between" };
const HEADER_IDENTITY: React.CSSProperties = { minWidth: 0, flex: 1 };
const EYEBROW: React.CSSProperties = { fontSize: 9, letterSpacing: "0.12em", color: FLOW_COLORS.awaited, marginBottom: 5 };
const REQUEST_NAME: React.CSSProperties = { fontSize: 16, fontWeight: 750, color: "#E6EDF3", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
const TRACE_ID: React.CSSProperties = { marginTop: 4, fontSize: 10, color: FLOW_COLORS.dim };
const SUMMARY_ROW: React.CSSProperties = { display: "flex", alignItems: "center", gap: 7, marginTop: 12, flexWrap: "wrap" };
const CHIP: React.CSSProperties = { border: "1px solid", borderRadius: 999, padding: "2px 7px", fontSize: 9.5, lineHeight: "14px" };
const LOADING: React.CSSProperties = { marginLeft: "auto", color: FLOW_COLORS.awaited, fontSize: 10 };
const NOTICE: React.CSSProperties = { marginTop: 10, padding: "7px 9px", borderRadius: 6, border: "1px solid #5B4A2B", background: "rgba(230,184,77,0.07)", color: "#C9B77E", fontSize: 10.5 };
const MISMATCH_NOTICE: React.CSSProperties = { ...NOTICE, borderColor: "#8A642C", background: "rgba(238,166,64,0.09)", color: "#E6BE79", fontWeight: 650 };
const ERROR_NOTICE: React.CSSProperties = { ...NOTICE, borderColor: "#6E3438", background: "rgba(240,120,124,0.06)", color: "#D99A9E" };
const TIMELINE_CARD: React.CSSProperties = { overflow: "hidden", border: "1px solid #242B37", borderRadius: 10, background: "rgba(11,14,19,0.94)" };
const AXIS_ROW: React.CSSProperties = { display: "grid", gridTemplateColumns: `${LABEL_WIDTH}px minmax(440px, 1fr)`, height: 38, borderBottom: "1px solid #242B37", background: "#10151C" };
const AXIS_LABEL: React.CSSProperties = { display: "flex", alignItems: "center", paddingLeft: 12, borderRight: "1px solid #242B37", fontSize: 8.5, letterSpacing: "0.12em", color: FLOW_COLORS.dim };
const AXIS_TRACK: React.CSSProperties = { position: "relative", margin: "0 18px" };
const TICK: React.CSSProperties = { position: "absolute", top: 0, bottom: 0, borderLeft: "1px solid #303744" };
const TICK_LABEL: React.CSSProperties = { position: "absolute", top: 12, left: 5, color: "#778292", fontSize: 9, whiteSpace: "nowrap", transform: "translateX(-50%)" };
const ROW: React.CSSProperties = { display: "grid", gridTemplateColumns: `${LABEL_WIDTH}px minmax(440px, 1fr)`, minHeight: 40, borderBottom: "1px solid #1E2530" };
const SPAN_LABEL: React.CSSProperties = { display: "flex", alignItems: "center", gap: 6, minWidth: 0, borderRight: "1px solid #242B37", paddingRight: 9 };
const TREE_ELBOW: React.CSSProperties = { color: "#465160", fontSize: 11, flexShrink: 0 };
const KIND_DOT: React.CSSProperties = { width: 6, height: 6, borderRadius: 99, flexShrink: 0 };
const SPAN_NAME: React.CSSProperties = { flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 10.5, color: "#C8D3E0" };
const LINK_KIND: React.CSSProperties = { padding: "1px 4px", border: "1px dashed #5C7792", borderRadius: 3, color: "#86A9C8", fontSize: 7.5, textTransform: "uppercase", whiteSpace: "nowrap", flexShrink: 0 };
const UNMAPPED: React.CSSProperties = { padding: "1px 4px", border: "1px solid #5B4A2B", borderRadius: 3, color: "#C9B77E", fontSize: 7.5, whiteSpace: "nowrap", flexShrink: 0 };
const SPAN_KIND: React.CSSProperties = { fontSize: 8, color: "#657181", textTransform: "uppercase", flexShrink: 0 };
const SPAN_DURATION: React.CSSProperties = { width: 53, textAlign: "right", fontSize: 9, color: "#8B96A6", flexShrink: 0, fontVariantNumeric: "tabular-nums" };
const TRACK: React.CSSProperties = { position: "relative", margin: "0 18px", minHeight: 40, backgroundImage: "linear-gradient(to right, transparent calc(25% - 1px), #202733 25%, transparent calc(25% + 1px), transparent calc(50% - 1px), #202733 50%, transparent calc(50% + 1px), transparent calc(75% - 1px), #202733 75%, transparent calc(75% + 1px))" };
const BAR: React.CSSProperties = { position: "absolute", top: 8, height: 23, minWidth: 3, boxSizing: "border-box", border: "1px solid", borderRadius: 4, overflow: "hidden", display: "flex", alignItems: "center", padding: "0 5px" };
const BAR_TEXT: React.CSSProperties = { color: "#D6DFEA", fontSize: 8.5, whiteSpace: "nowrap", textShadow: "0 1px 2px #000" };
const EVENT_PIN: React.CSSProperties = { position: "absolute", zIndex: 3, top: 18, width: 16, height: 16, transform: "translate(-50%, -50%)", padding: 0, border: "1px solid", borderRadius: 99, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: MONO, fontSize: 8, lineHeight: 1, cursor: "pointer" };
const NO_SPANS: React.CSSProperties = { padding: 24, textAlign: "center", color: FLOW_COLORS.dim, fontSize: 11 };
const DETAIL: React.CSSProperties = { marginTop: 14, border: "1px solid #2A3140", borderRadius: 10, overflow: "hidden", background: "#11161D" };
const DETAIL_HEADER: React.CSSProperties = { display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", borderBottom: "1px solid #242B37", background: "#161C25" };
const DETAIL_GLYPH: React.CSSProperties = { width: 24, textAlign: "center", fontSize: 14 };
const DETAIL_TITLE_WRAP: React.CSSProperties = { flex: 1, minWidth: 0 };
const DETAIL_TITLE: React.CSSProperties = { fontSize: 12, fontWeight: 700, color: "#E6EDF3", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
const DETAIL_SUBTITLE: React.CSSProperties = { marginTop: 2, fontSize: 9, color: FLOW_COLORS.dim };
const CLOSE: React.CSSProperties = { width: 24, height: 24, border: "1px solid #303744", borderRadius: 5, background: "#1A2029", color: "#9AA4B2", cursor: "pointer" };
const DETAIL_GRID: React.CSSProperties = { display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 1, background: "#242B37" };
const FIELD: React.CSSProperties = { minWidth: 0, padding: "9px 11px", background: "#11161D" };
const FIELD_LABEL: React.CSSProperties = { marginBottom: 4, color: "#6F7A89", fontSize: 8.5, letterSpacing: "0.09em", textTransform: "uppercase" };
const FIELD_VALUE: React.CSSProperties = { color: "#C8D3E0", fontSize: 10.5, whiteSpace: "pre-wrap", overflowWrap: "anywhere" };
const FIELD_CODE: React.CSSProperties = { ...FIELD_VALUE, padding: 7, borderRadius: 5, background: "#0B0F14", color: "#A9D6E5" };
const PROBE_SECTION: React.CSSProperties = { borderTop: "1px solid #2A3140", padding: 12, background: "#0E1319" };
const PROBE_HEADING: React.CSSProperties = { color: FLOW_COLORS.awaited, fontSize: 9, letterSpacing: "0.11em", fontWeight: 700 };
const PROBE_EXPLAIN: React.CSSProperties = { marginTop: 4, color: "#778292", fontSize: 9.5 };
const PROBE: React.CSSProperties = { margin: "9px 0 0", padding: 10, border: "1px solid #253444", borderRadius: 6, background: "#090D12", color: "#A9D6E5", fontFamily: MONO, fontSize: 10.5, lineHeight: 1.55, overflow: "auto" };
const DETAIL_HINT: React.CSSProperties = { marginTop: 10, padding: "9px 12px", border: "1px dashed #2A3140", borderRadius: 7, color: FLOW_COLORS.dim, fontSize: 9.5 };
// Alternate Logic views reserve 352px of left headroom for the floating toolbar. A fixed 1060px
// empty surface centered the setup card beyond a narrow app pane, leaving the controls present in
// the DOM but completely off-screen. Size the empty surface to the remaining viewport instead;
// loaded timelines retain their wide, horizontally scrollable canvas.
const EMPTY_WRAP: React.CSSProperties = {
  width: "clamp(240px, calc(100vw - 352px), 1060px)",
  minWidth: 0,
  boxSizing: "border-box",
  padding: "140px 12px 90px",
  display: "flex",
  justifyContent: "center",
  fontFamily: MONO,
};
const EMPTY_CARD: React.CSSProperties = {
  width: "min(470px, 100%)",
  minWidth: 0,
  boxSizing: "border-box",
  padding: "28px clamp(14px, 3vw, 32px)",
  textAlign: "center",
  border: "1px solid",
  borderRadius: 12,
  background: "rgba(17,22,29,0.96)",
  boxShadow: "0 18px 50px rgba(0,0,0,0.28)",
};
const EMPTY_ICON: React.CSSProperties = { fontSize: 24, marginBottom: 10 };
const EMPTY_TITLE: React.CSSProperties = { color: "#E6EDF3", fontSize: 14, fontWeight: 700 };
const EMPTY_DETAIL: React.CSSProperties = { marginTop: 7, color: "#7B8695", fontSize: 10.5, lineHeight: 1.55 };
const EMPTY_CONTENT: React.CSSProperties = { marginTop: 20, paddingTop: 16, borderTop: "1px solid #2A3140", textAlign: "left" };
