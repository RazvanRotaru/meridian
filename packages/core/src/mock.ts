/**
 * The single deterministic mock-overlay generator (node-only subpath `@meridian/core/mock`).
 *
 * Both `blueprint mock-telemetry` (persist) and `blueprint view --overlay mock` (serve) use
 * this one implementation, so a previewed overlay is byte-identical to a persisted one. It
 * is sha256-based and never touches the clock or a random source: the same
 * `(env, nodeId, seed)` always yields the same metrics, and `env` is mixed into every hash
 * so each environment has a different-but-fixed profile.
 */

import { createHash } from "node:crypto";
import { OVERLAY_VERSION } from "./overlay";
import type { NodeMetrics, Overlay } from "./overlay";
import type { GraphArtifact, NodeId } from "./types";

const FROZEN_TIMESTAMP = "1970-01-01T00:00:00.000Z";
const ALGORITHM = "sha256-channels-v1";

const CHANNEL = {
  callCount: "1",
  p50: "2",
  spread95: "3",
  spread99: "4",
  errorRate: "5",
} as const;

type Channel = (typeof CHANNEL)[keyof typeof CHANNEL];

function unitInterval(env: string, nodeId: string, seed: string, channel: Channel): number {
  const digest = createHash("sha256").update(`${env} ${nodeId} ${seed} ${channel}`).digest();
  return digest.readUInt32BE(0) / 0xffffffff;
}

function logUniform(unit: number, min: number, max: number): number {
  return Math.exp(Math.log(min) + unit * (Math.log(max) - Math.log(min)));
}

export function mockMetricsForNode(env: string, nodeId: NodeId, seed = ""): NodeMetrics {
  const callCount = Math.round(logUniform(unitInterval(env, nodeId, seed, CHANNEL.callCount), 1, 100_000));
  const latencyMs = mockLatency(env, nodeId, seed);
  const errorUnit = unitInterval(env, nodeId, seed, CHANNEL.errorRate);
  const errorRate = Math.round(errorUnit ** 3 * 0.25 * 1e4) / 1e4;
  return { callCount, errorRate, latencyMs, sampleCount: callCount };
}

function mockLatency(env: string, nodeId: string, seed: string): NodeMetrics["latencyMs"] {
  const p50 = Math.round(logUniform(unitInterval(env, nodeId, seed, CHANNEL.p50), 1, 250));
  const p95 = p50 + Math.max(1, Math.round(unitInterval(env, nodeId, seed, CHANNEL.spread95) * p50 * 4));
  const p99 = p95 + Math.max(1, Math.round(unitInterval(env, nodeId, seed, CHANNEL.spread99) * p95 * 2));
  return { p50, p95, p99 };
}

export interface MockOverlayOptions {
  seed?: string;
  generatedAt?: string;
}

export function buildMockOverlay(graph: GraphArtifact, env: string, options: MockOverlayOptions = {}): Overlay {
  const seed = options.seed ?? "";
  const metricsByNodeId: Record<NodeId, NodeMetrics> = {};
  for (const node of graph.nodes) {
    metricsByNodeId[node.id] = mockMetricsForNode(env, node.id, seed);
  }
  return {
    overlayVersion: OVERLAY_VERSION,
    kind: "mock",
    env,
    generatedAt: options.generatedAt ?? FROZEN_TIMESTAMP,
    deterministic: { algorithm: ALGORITHM, seed },
    graphRef: {
      schemaVersion: graph.schemaVersion,
      generatedAt: graph.generatedAt,
      nodeCount: graph.nodes.length,
    },
    metricsByNodeId,
  };
}
