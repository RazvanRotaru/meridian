/**
 * The telemetry overlay contract: per-node runtime metrics joined by `node.id`.
 *
 * A mock overlay and a future real Tempo overlay emit this identical shape (only `kind`
 * differs), so the renderer's provider swaps with zero schema change.
 */

import { z } from "zod";
import type { NodeId } from "./types";
import { telemetryEnvironmentSchema } from "./telemetry-source";

export const OVERLAY_VERSION = "1.0.0" as const;

export interface LatencyMs {
  p50: number;
  p95: number;
  p99: number;
}

export interface NodeMetrics {
  callCount: number;
  errorRate: number;
  latencyMs: LatencyMs;
  sampleCount: number;
}

export interface Overlay {
  overlayVersion: string;
  kind: "mock" | "tempo";
  env: string;
  generatedAt: string;
  deterministic?: { algorithm: string; seed: string };
  graphRef: { schemaVersion: string; generatedAt: string; nodeCount: number };
  metricsByNodeId: Record<NodeId, NodeMetrics>;
}

const latencySchema = z.object({
  p50: z.number().int().min(0),
  p95: z.number().int().min(0),
  p99: z.number().int().min(0),
});

const nodeMetricsSchema = z.object({
  callCount: z.number().int().min(0),
  errorRate: z.number().min(0).max(1),
  latencyMs: latencySchema,
  sampleCount: z.number().int().min(0),
});

export const overlaySchema = z.object({
  overlayVersion: z.string().regex(/^1\.\d+\.\d+$/),
  kind: z.enum(["mock", "tempo"]),
  env: telemetryEnvironmentSchema,
  generatedAt: z.string(),
  deterministic: z.object({ algorithm: z.string(), seed: z.string() }).optional(),
  graphRef: z.object({
    schemaVersion: z.string(),
    generatedAt: z.string(),
    nodeCount: z.number().int().min(0),
  }),
  metricsByNodeId: z.record(z.string(), nodeMetricsSchema),
});
