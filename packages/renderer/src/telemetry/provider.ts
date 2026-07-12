/**
 * The telemetry provider slot: mock now, Tempo later, swapped with zero schema change.
 *
 * Every provider `requiresEnvironment` — there is no "default" environment and prod is never
 * implicit. The renderer holds the join contract (metrics are keyed by `node.id`); the
 * provider only answers "given this environment, what are the metrics?".
 */

import type { NodeId, NodeMetrics, TelemetrySourceDescriptor, TraceBundle } from "@meridian/core";

export type { TelemetrySourceDescriptor } from "@meridian/core";

export interface TelemetryProvider {
  id: string;
  requiresEnvironment: true;
  listEnvironments(): string[];
  fetchMetrics(environment: string): Promise<Record<NodeId, NodeMetrics>>;
  /** Fetch request executions for the same explicitly selected environment. */
  fetchTraces(environment: string): Promise<TraceBundle>;
}

/** One selectable source plus its runtime transport. Store state exposes only the descriptor; the
 * provider stays in the internal registration catalog so source choices never serialize functions. */
export type TelemetrySourceRegistration = TelemetrySourceDescriptor & { provider: TelemetryProvider };
