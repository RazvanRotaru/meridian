/**
 * The `/api/*` JSON endpoints `view` serves.
 *
 * `/api/overlay` mirrors the never-default rule server-side: a missing `env` is a 400, never
 * a silent prod. Mock overlays are synthesized per request (any env on the fly); a file
 * overlay is returned only for the one environment it was minted for.
 */

import type { ServerResponse } from "node:http";
import { buildMockOverlay } from "@meridian/core/mock";
import type { ChangeOverlay, GraphArtifact } from "@meridian/core";
import { runGit } from "../git-diff";
import { hasOverlay } from "./overlay-source";
import type { OverlaySource } from "./overlay-source";

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

export function sendChange(response: ServerResponse, change: ChangeOverlay | null): void {
  if (!change) {
    sendJson(response, 404, { error: "no change overlay loaded; pass --change to `meridian view`" });
    return;
  }
  sendJson(response, 200, change);
}

/**
 * Stream the real unified diff for ONE changed file. The `file` parameter must be a key of
 * the overlay's `files` map — an allowlist, so no request can name an arbitrary path — and
 * the git invocation is argv-only behind a `--` fence against the overlay's own repo/range.
 */
export async function sendFileDiff(
  response: ServerResponse,
  change: ChangeOverlay | null,
  file: string | null,
): Promise<void> {
  if (!change) {
    sendJson(response, 404, { error: "no change overlay loaded" });
    return;
  }
  if (!file || !Object.prototype.hasOwnProperty.call(change.files, file)) {
    sendJson(response, 404, { error: "unknown file; must be one of the overlay's changed files" });
    return;
  }
  const repoPath = change.prefix === "" ? file : `${change.prefix}/${file}`;
  try {
    const diff = await runGit(change.repoRoot, ["diff", change.range, "--", repoPath]);
    response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    response.end(diff);
  } catch (error) {
    sendJson(response, 500, { error: error instanceof Error ? error.message : "git diff failed" });
  }
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(text);
}
