/**
 * The `/api/*` JSON endpoints `view` serves.
 *
 * `/api/overlay` and `/api/traces` mirror the never-default rule server-side: a missing `env`
 * is a 400, never a silent prod. A mandatory source id resolves through the advertised catalog,
 * then both paths enforce that source's environment policy and advertised capabilities.
 */

import type { ServerResponse } from "node:http";
import { telemetryEnvironmentSchema, telemetrySourceAllowsEnvironment } from "@meridian/core";
import { sendJson } from "./http-response";
import type { InspectionGraphSummary } from "./inspection-snapshot-store";
import { hasOverlay, resolveTelemetrySource, telemetrySourceDescriptors } from "./overlay-source";
import type { OverlaySource, TelemetrySourceEntry } from "./overlay-source";
import {
  runStandaloneMockTelemetry,
  streamStandaloneMockTelemetry,
  type StandaloneMockTelemetryRunner,
} from "./standalone-view-mock-worker";

export interface FileBackedMockTelemetryContext {
  artifactPath: string;
  scratchRoot: string;
  signal?: AbortSignal;
  run?: StandaloneMockTelemetryRunner;
}

export function sendMeta(
  response: ServerResponse,
  graph: InspectionGraphSummary,
  overlay: OverlaySource,
  explicitEnvironment: string | null = null,
  warnings: readonly string[] = [],
): void {
  sendJson(response, 200, {
    schemaVersion: graph.schemaVersion,
    generatedAt: graph.generatedAt,
    nodeCount: graph.nodeCount,
    edgeCount: graph.edgeCount,
    hasOverlay: hasOverlay(overlay),
    envs: envsOf(overlay),
    environments: environmentsOf(overlay, explicitEnvironment),
    telemetrySources: telemetrySourceDescriptors(overlay, explicitEnvironment),
    warnings: [...warnings],
  });
}

function envsOf(overlay: OverlaySource): "*" | string | null {
  if (overlay.kind === "mock") {
    return "*";
  }
  return overlay.kind === "file" ? overlay.overlay.env : null;
}

function environmentsOf(overlay: OverlaySource, explicitEnvironment: string | null): string[] {
  return resolveTelemetrySource(overlay, null, explicitEnvironment)?.descriptor.environments ?? [];
}

export async function sendOverlay(
  response: ServerResponse,
  overlay: OverlaySource,
  env: string | null,
  sourceId: string | null,
  mock: FileBackedMockTelemetryContext,
  explicitEnvironment: string | null = null,
): Promise<void> {
  const environment = requestEnvironment(response, env);
  if (environment === null) {
    return;
  }
  const selected = allowedSource(response, overlay, sourceId, environment, "overlay", "supportsMetrics", explicitEnvironment);
  if (selected === null) return;
  if (selected.source.kind === "mock") {
    await sendFileBackedMock(response, mock, "overlay", environment);
    return;
  }
  sendJson(response, 200, selected.source.overlay);
}

export async function sendTraces(
  response: ServerResponse,
  overlay: OverlaySource,
  env: string | null,
  sourceId: string | null,
  mock: FileBackedMockTelemetryContext,
  explicitEnvironment: string | null = null,
): Promise<void> {
  const environment = requestEnvironment(response, env);
  if (environment === null) {
    return;
  }
  const selected = allowedSource(response, overlay, sourceId, environment, "request traces", "supportsTraces", explicitEnvironment);
  if (selected === null) return;
  if (selected.source.kind === "mock") {
    await sendFileBackedMock(response, mock, "traces", environment);
    return;
  }
  sendJson(response, 404, { error: `telemetry source '${selected.descriptor.id}' has no request traces` });
}

async function sendFileBackedMock(
  response: ServerResponse,
  context: FileBackedMockTelemetryContext,
  kind: "overlay" | "traces",
  environment: string,
): Promise<void> {
  const file = await (context.run ?? runStandaloneMockTelemetry)({
    artifactPath: context.artifactPath,
    scratchRoot: context.scratchRoot,
    kind,
    environment,
    ...(context.signal ? { signal: context.signal } : {}),
  });
  await streamStandaloneMockTelemetry(response, file);
}

function requestEnvironment(response: ServerResponse, env: string | null): string | null {
  if (!env) {
    sendJson(response, 400, { error: "env query parameter is required; blueprint never defaults" });
    return null;
  }
  const parsed = telemetryEnvironmentSchema.safeParse(env);
  if (!parsed.success) {
    sendJson(response, 400, { error: "env query parameter must be at most 256 non-whitespace characters" });
    return null;
  }
  return parsed.data;
}

function allowedSource(
  response: ServerResponse,
  overlay: OverlaySource,
  sourceId: string | null,
  env: string,
  unavailable: "overlay" | "request traces",
  capability: "supportsMetrics" | "supportsTraces",
  explicitEnvironment: string | null,
): TelemetrySourceEntry | null {
  if (sourceId === null) {
    sendJson(response, 400, { error: "source query parameter is required" });
    return null;
  }
  const selected = resolveTelemetrySource(overlay, sourceId, explicitEnvironment);
  if (selected === null) {
    sendJson(response, 404, {
      error: `unknown telemetry source '${sourceId}'`,
    });
    return null;
  }
  if (!selected.descriptor[capability]) {
    sendJson(response, 404, { error: `telemetry source '${selected.descriptor.id}' has no ${unavailable}` });
    return null;
  }
  if (!telemetrySourceAllowsEnvironment(selected.descriptor, env)) {
    sendJson(response, 404, { error: `telemetry source '${selected.descriptor.id}' has no env '${env}'` });
    return null;
  }
  return selected;
}
