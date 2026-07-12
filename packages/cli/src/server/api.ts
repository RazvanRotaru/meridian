/**
 * The `/api/*` JSON endpoints `view` serves.
 *
 * `/api/overlay` and `/api/traces` mirror the never-default rule server-side: a missing `env`
 * is a 400, never a silent prod. An explicit source id resolves through the advertised catalog;
 * omitting it preserves the configured startup source for older renderers. Both paths enforce the
 * source's environment policy and advertised capabilities.
 */

import type { ServerResponse } from "node:http";
import { buildMockOverlay, buildMockTraceBundle } from "@meridian/core/mock";
import { telemetryEnvironmentSchema, telemetrySourceAllowsEnvironment } from "@meridian/core";
import type { GraphArtifact } from "@meridian/core";
import { sendJson } from "./http-response";
import { hasOverlay, resolveTelemetrySource, telemetrySourceDescriptors } from "./overlay-source";
import type { OverlaySource, TelemetrySourceEntry } from "./overlay-source";

export function sendMeta(
  response: ServerResponse,
  graph: GraphArtifact,
  overlay: OverlaySource,
  explicitEnvironment: string | null = null,
): void {
  sendJson(response, 200, {
    schemaVersion: graph.schemaVersion,
    generatedAt: graph.generatedAt,
    nodeCount: graph.nodes.length,
    hasOverlay: hasOverlay(overlay),
    envs: envsOf(overlay),
    environments: environmentsOf(overlay, explicitEnvironment),
    telemetrySources: telemetrySourceDescriptors(overlay, explicitEnvironment),
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

export function sendGraph(response: ServerResponse, graph: GraphArtifact): void {
  sendJson(response, 200, graph);
}

export function sendOverlay(
  response: ServerResponse,
  graph: GraphArtifact,
  overlay: OverlaySource,
  env: string | null,
  sourceId: string | null = null,
  explicitEnvironment: string | null = null,
): void {
  const environment = requestEnvironment(response, env);
  if (environment === null) {
    return;
  }
  const selected = allowedSource(response, overlay, sourceId, environment, "overlay", "supportsMetrics", explicitEnvironment);
  if (selected === null) return;
  if (selected.source.kind === "mock") {
    sendJson(response, 200, buildMockOverlay(graph, environment));
    return;
  }
  sendJson(response, 200, selected.source.overlay);
}

export function sendTraces(
  response: ServerResponse,
  graph: GraphArtifact,
  overlay: OverlaySource,
  env: string | null,
  sourceId: string | null = null,
  explicitEnvironment: string | null = null,
): void {
  const environment = requestEnvironment(response, env);
  if (environment === null) {
    return;
  }
  const selected = allowedSource(response, overlay, sourceId, environment, "request traces", "supportsTraces", explicitEnvironment);
  if (selected === null) return;
  if (selected.source.kind === "mock") {
    sendJson(response, 200, buildMockTraceBundle(graph, environment));
    return;
  }
  sendJson(response, 404, { error: `telemetry source '${selected.descriptor.id}' has no request traces` });
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
  const selected = resolveTelemetrySource(overlay, sourceId, explicitEnvironment);
  if (selected === null) {
    sendJson(response, 404, {
      error: sourceId === null
        ? `no ${unavailable} for env '${env}'`
        : `unknown telemetry source '${sourceId}'`,
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
