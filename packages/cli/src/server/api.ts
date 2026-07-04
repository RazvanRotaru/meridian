/**
 * The `/api/*` JSON endpoints `view` serves.
 *
 * `/api/overlay` mirrors the never-default rule server-side: a missing `env` is a 400, never
 * a silent prod. Mock overlays are synthesized per request (any env on the fly); a file
 * overlay is returned only for the one environment it was minted for.
 */

import type { ServerResponse } from "node:http";
import { buildMockOverlay } from "@meridian/core/mock";
import type { GraphArtifact } from "@meridian/core";
import { hasOverlay } from "./overlay-source";
import type { OverlaySource } from "./overlay-source";
import type { BehaviorReport } from "./behavior";

export function sendMeta(response: ServerResponse, graph: GraphArtifact, overlay: OverlaySource): void {
  sendJson(response, 200, {
    schemaVersion: graph.schemaVersion,
    generatedAt: graph.generatedAt,
    nodeCount: graph.nodes.length,
    hasOverlay: hasOverlay(overlay),
    envs: envsOf(overlay),
    environments: environmentsOf(overlay),
  });
}

function envsOf(overlay: OverlaySource): "*" | string | null {
  if (overlay.kind === "mock") {
    return "*";
  }
  return overlay.kind === "file" ? overlay.overlay.env : null;
}

// A mock overlay can synthesize any environment; offer a standard trio so the mandatory
// selector has real options to choose between (the user can still pass any --env).
const MOCK_ENVIRONMENTS = ["dev", "staging", "prod"];

function environmentsOf(overlay: OverlaySource): string[] {
  if (overlay.kind === "file") {
    return [overlay.overlay.env];
  }
  return overlay.kind === "mock" ? MOCK_ENVIRONMENTS : [];
}

export function sendGraph(response: ServerResponse, graph: GraphArtifact): void {
  sendJson(response, 200, graph);
}

export function sendOverlay(
  response: ServerResponse,
  graph: GraphArtifact,
  overlay: OverlaySource,
  env: string | null,
): void {
  if (!env) {
    sendJson(response, 400, { error: "env query parameter is required; blueprint never defaults" });
    return;
  }
  if (overlay.kind === "mock") {
    sendJson(response, 200, buildMockOverlay(graph, env));
    return;
  }
  if (overlay.kind === "file" && overlay.overlay.env === env) {
    sendJson(response, 200, overlay.overlay);
    return;
  }
  sendJson(response, 404, { error: `no overlay for env '${env}'` });
}

/**
 * Disabled behavior (`--behavior` not passed) is a hard 404, not an `{available:false}`
 * soft-success: the boot script already advertises `behaviorUrl: null`, so a well-behaved
 * renderer never calls this, and a stray caller gets an unambiguous error. The report is
 * computed once at startup and served from memory; it takes no request input to echo.
 */
export function sendBehavior(response: ServerResponse, behavior: BehaviorReport | null): void {
  if (!behavior) {
    sendJson(response, 404, { error: "behavior analysis not enabled; run view with --behavior" });
    return;
  }
  sendJson(response, 200, behavior);
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(text);
}
