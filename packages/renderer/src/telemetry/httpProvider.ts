/**
 * The v1 provider: a thin HTTP client over the CLI's overlay endpoint.
 *
 * The CLI computes the deterministic mock overlay SERVER-SIDE (the same algorithm a future
 * Tempo overlay would replace), so the browser must NOT recompute it and must NOT import
 * `node:crypto`. We fetch `overlayUrl?env=<env>` and read `metricsByNodeId` verbatim.
 */

import type { NodeId, NodeMetrics, Overlay } from "@meridian/core";
import type { TelemetryProvider } from "./provider";

export function createHttpTelemetryProvider(
  overlayUrl: string,
  environments: string[],
  kind: "mock" | "tempo",
): TelemetryProvider {
  return {
    id: kind,
    requiresEnvironment: true,
    listEnvironments: () => environments,
    fetchMetrics: (environment) => fetchOverlayMetrics(overlayUrl, environment),
  };
}

async function fetchOverlayMetrics(
  overlayUrl: string,
  environment: string,
): Promise<Record<NodeId, NodeMetrics>> {
  const response = await fetch(`${overlayUrl}?env=${encodeURIComponent(environment)}`);
  if (!response.ok) {
    throw new Error(`overlay fetch failed (${response.status}) for env '${environment}'`);
  }
  const overlay = (await response.json()) as Overlay;
  return overlay.metricsByNodeId;
}
