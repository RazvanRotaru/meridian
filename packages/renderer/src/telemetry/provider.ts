/**
 * The telemetry provider slot: mock now, Tempo later, swapped with zero schema change.
 *
 * Every provider `requiresEnvironment` — there is no "default" environment and prod is never
 * implicit. The renderer holds the join contract (metrics are keyed by `node.id`); the
 * provider only answers "given this environment, what are the metrics?".
 */

import type { NodeId, NodeMetrics } from "@meridian/core";

export interface TelemetryProvider {
  id: "mock" | "tempo";
  requiresEnvironment: true;
  listEnvironments(): string[];
  fetchMetrics(environment: string): Promise<Record<NodeId, NodeMetrics>>;
}
