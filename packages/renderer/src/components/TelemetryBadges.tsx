/**
 * Header badges for a node that HAS metrics. Absent metrics render nothing (never a zero) —
 * the caller passes `undefined` and we return null, so a node with no telemetry stays clean.
 */

import type { NodeMetrics } from "@meridian/core";
import { errorColor, latencyColor } from "../theme/telemetryColor";

const TEAL = "#2FB7A4";

export function TelemetryBadges(props: { metrics: NodeMetrics | undefined }) {
  const metrics = props.metrics;
  if (!metrics) {
    return null;
  }
  return (
    <div style={ROW_STYLE}>
      <Badge label={`${formatCount(metrics.callCount)} calls`} color={TEAL} />
      <Badge label={`p95 ${metrics.latencyMs.p95}ms`} color={latencyColor(metrics.latencyMs.p95)} />
      <Badge label={`${formatPercent(metrics.errorRate)} err`} color={errorColor(metrics.errorRate)} />
    </div>
  );
}

function Badge(props: { label: string; color: string }) {
  return <span style={{ ...BADGE_STYLE, color: props.color, borderColor: props.color }}>{props.label}</span>;
}

function formatCount(callCount: number): string {
  if (callCount >= 1000) {
    return `${(callCount / 1000).toFixed(1)}k`;
  }
  return String(callCount);
}

function formatPercent(rate: number): string {
  return `${(rate * 100).toFixed(rate >= 0.1 ? 0 : 1)}%`;
}

const ROW_STYLE: React.CSSProperties = {
  display: "flex",
  gap: 6,
  marginTop: 6,
  flexWrap: "wrap",
};

const BADGE_STYLE: React.CSSProperties = {
  fontSize: 10,
  lineHeight: "14px",
  padding: "1px 6px",
  borderRadius: 6,
  border: "1px solid",
  background: "rgba(255,255,255,0.04)",
  fontVariantNumeric: "tabular-nums",
};
