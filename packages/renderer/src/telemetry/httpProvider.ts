/**
 * The v1 provider: a thin HTTP client over the CLI's overlay endpoint.
 *
 * The CLI computes the deterministic mock overlay SERVER-SIDE (the same algorithm a future
 * Tempo overlay would replace), so the browser must NOT recompute it and must NOT import
 * `node:crypto`. We fetch `overlayUrl?env=<env>` and read `metricsByNodeId` verbatim.
 */

import { expectedTelemetryProducerKind, overlaySchema, traceBundleSchema } from "@meridian/core";
import type { NodeId, NodeMetrics, TelemetrySourceDescriptor, TraceBundle } from "@meridian/core";
import type { TelemetryProvider } from "./provider";

export function createHttpTelemetryProvider(
  overlayUrl: string,
  traceUrl: string,
  source: TelemetrySourceDescriptor,
): TelemetryProvider {
  return {
    id: source.id,
    requiresEnvironment: true,
    listEnvironments: () => [...source.environments],
    fetchMetrics: (environment) => fetchOverlayMetrics(overlayUrl, environment, source),
    fetchTraces: (environment) => fetchTraceBundle(traceUrl, environment, source),
  };
}

async function fetchTraceBundle(
  traceUrl: string,
  environment: string,
  source: TelemetrySourceDescriptor,
): Promise<TraceBundle> {
  const response = await fetch(telemetryUrl(traceUrl, environment, source.id));
  if (!response.ok) {
    throw new Error(`request trace fetch failed (${response.status}) for env '${environment}'`);
  }
  const parsed = traceBundleSchema.safeParse(await response.json());
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.length ? `${issue.path.join(".")}: ` : "";
    throw new Error(`invalid request trace payload (${path}${issue?.message ?? "schema validation failed"})`);
  }
  if (parsed.data.env !== environment) {
    throw new Error(`request trace environment mismatch: requested '${environment}', received '${parsed.data.env}'`);
  }
  assertProducerMatches(source, parsed.data.source, "request trace");
  return parsed.data;
}

async function fetchOverlayMetrics(
  overlayUrl: string,
  environment: string,
  source: TelemetrySourceDescriptor,
): Promise<Record<NodeId, NodeMetrics>> {
  const response = await fetch(telemetryUrl(overlayUrl, environment, source.id));
  if (!response.ok) {
    throw new Error(`overlay fetch failed (${response.status}) for env '${environment}'`);
  }
  const parsed = overlaySchema.safeParse(await response.json());
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.length ? `${issue.path.join(".")}: ` : "";
    throw new Error(`invalid telemetry overlay payload (${path}${issue?.message ?? "schema validation failed"})`);
  }
  if (parsed.data.env !== environment) {
    throw new Error(`overlay environment mismatch: requested '${environment}', received '${parsed.data.env}'`);
  }
  assertProducerMatches(source, parsed.data.kind, "overlay");
  return parsed.data.metricsByNodeId;
}

function assertProducerMatches(
  source: TelemetrySourceDescriptor,
  received: "mock" | "tempo",
  payload: "overlay" | "request trace",
): void {
  const expected = expectedTelemetryProducerKind(source);
  if (expected !== null && received !== expected) {
    throw new Error(
      `${payload} provenance mismatch: source '${source.id}' is ${source.provenance}/${expected}, received '${received}'`,
    );
  }
}

/** Add telemetry coordinates without discarding a graph/session id already present in the endpoint.
 * The synthetic base makes root-relative URLs safe under Node tests; the returned shape stays
 * relative when the caller supplied a relative URL, and absolute URLs remain absolute. */
function telemetryUrl(endpoint: string, environment: string, sourceId?: string): string {
  const syntheticOrigin = "http://meridian.local";
  const url = new URL(endpoint, syntheticOrigin);
  url.searchParams.set("env", environment);
  if (sourceId !== undefined) {
    url.searchParams.set("source", sourceId);
  }
  if (/^[a-z][a-z\d+.-]*:/i.test(endpoint)) {
    return url.toString();
  }
  const relative = `${url.pathname}${url.search}${url.hash}`;
  return endpoint.startsWith("/") ? relative : relative.slice(1);
}
