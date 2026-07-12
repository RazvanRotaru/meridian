/** Shared request selector with explicit position and deterministic wrap-around navigation. */

import type { RequestTrace } from "@meridian/core";
import { TOKENS } from "./controlpanel/panelKit";

const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";

export interface RequestNavigatorProps {
  traces: readonly RequestTrace[];
  activeTraceId: string;
  selectAriaLabel: string;
  variant: "timeline" | "panel";
  onChange(traceId: string): void;
}

export function RequestNavigator(props: RequestNavigatorProps) {
  const index = Math.max(0, props.traces.findIndex((trace) => trace.traceId === props.activeTraceId));
  const count = props.traces.length;
  const disabled = count < 2;
  const navigate = (direction: -1 | 1) => {
    const traceId = cyclicRequestId(props.traces, props.activeTraceId, direction);
    if (traceId !== null && traceId !== props.activeTraceId) props.onChange(traceId);
  };
  return (
    <div style={{ ...ROOT, width: props.variant === "timeline" ? 360 : "100%" }}>
      <div style={LABEL}>Request</div>
      <div style={ROW}>
        <button
          type="button"
          style={navButtonStyle(disabled)}
          disabled={disabled}
          onClick={() => navigate(-1)}
          aria-label="Previous request"
          title="Previous request · wraps to end"
        >
          ‹
        </button>
        <select
          style={SELECT}
          value={props.activeTraceId}
          onChange={(event) => props.onChange(event.target.value)}
          aria-label={props.selectAriaLabel}
        >
          {props.traces.map((trace) => (
            <option key={trace.traceId} value={trace.traceId}>{requestOption(trace)}</option>
          ))}
        </select>
        <span style={POSITION} aria-label={`Request ${index + 1} of ${count}`}>{index + 1} of {count}</span>
        <button
          type="button"
          style={navButtonStyle(disabled)}
          disabled={disabled}
          onClick={() => navigate(1)}
          aria-label="Next request"
          title="Next request · wraps to start"
        >
          ›
        </button>
      </div>
    </div>
  );
}

/** Return the adjacent trace id in the caller-provided display order, wrapping at both ends. */
export function cyclicRequestId(
  traces: readonly Pick<RequestTrace, "traceId">[],
  activeTraceId: string,
  direction: -1 | 1,
): string | null {
  if (traces.length === 0) return null;
  const activeIndex = traces.findIndex((trace) => trace.traceId === activeTraceId);
  const start = activeIndex < 0 ? 0 : activeIndex;
  const next = (start + direction + traces.length) % traces.length;
  return traces[next]!.traceId;
}

function requestOption(trace: RequestTrace): string {
  return `${trace.name} · ${trace.status} · ${shortTraceId(trace.traceId)}`;
}

function shortTraceId(traceId: string): string {
  return traceId.length <= 16 ? traceId : `${traceId.slice(0, 8)}…${traceId.slice(-6)}`;
}

const ROOT: React.CSSProperties = { display: "flex", minWidth: 0, flexDirection: "column", gap: 4 };
const LABEL: React.CSSProperties = { color: TOKENS.label, fontSize: 8.5, letterSpacing: "0.08em", textTransform: "uppercase" };
const ROW: React.CSSProperties = { display: "grid", gridTemplateColumns: "25px minmax(0, 1fr) auto 25px", alignItems: "center", gap: 5 };
const SELECT: React.CSSProperties = { minWidth: 0, width: "100%", border: `1px solid ${TOKENS.surfaceBorder}`, borderRadius: 6, background: TOKENS.pillBg, color: TOKENS.text, padding: "6px 8px", fontFamily: MONO, fontSize: 10.5 };
const POSITION: React.CSSProperties = { minWidth: 36, color: TOKENS.textMuted, fontFamily: MONO, fontSize: 9, fontVariantNumeric: "tabular-nums", textAlign: "center", whiteSpace: "nowrap" };

function navButtonStyle(disabled: boolean): React.CSSProperties {
  return {
    width: 25,
    height: 27,
    padding: 0,
    border: `1px solid ${TOKENS.surfaceBorder}`,
    borderRadius: 6,
    background: TOKENS.pillBg,
    color: disabled ? TOKENS.textDim : TOKENS.textMuted,
    fontFamily: MONO,
    fontSize: 17,
    lineHeight: "23px",
    cursor: disabled ? "default" : "pointer",
  };
}
