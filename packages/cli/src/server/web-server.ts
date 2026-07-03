/**
 * The pure HTTP server factory for `blueprint web`.
 *
 * Like `createBlueprintServer` it returns an unbound `http.Server` so routing is unit-testable
 * without a port or a browser. It holds an in-memory Map of generated graphs (one per submitted
 * source) so a single running server can render many repos; the renderer bundle is served
 * UNCHANGED and only the injected `window.__MERIDIAN__` differs per graph.
 */

import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { GraphArtifact } from "@meridian/core";
import { CliError, EXIT } from "../errors";
import { extractToArtifact } from "../extract-pipeline";
import { serveStatic } from "./static-files";
import type { StaticAssets } from "./static-files";
import { resolveSource } from "./clone";
import { WebError } from "./web-error";
import { injectPrefill, injectViewBoot } from "./web-boot";
import { artifactId, parseGenerateRequest, readJsonBody } from "./web-request";

export interface WebServerConfig {
  rendererRoot: string;
  /** Path to the hand-written landing page (`web-ui/index.html`). */
  webUiPath: string;
  /** Directory local `kind:"path"` sources resolve against. */
  cwd: string;
  /** Optional CLI positional pre-filled into the landing form. */
  source?: string;
}

interface Context {
  graphs: Map<string, GraphArtifact>;
  rendererIndex: string;
  landingHtml: string;
  staticAssets: StaticAssets;
  cwd: string;
}

export function createWebServer(config: WebServerConfig): Server {
  const ctx = buildContext(config);
  return createServer((request, response) => {
    handle(ctx, request, response).catch((error) => sendError(response, error));
  });
}

function buildContext(config: WebServerConfig): Context {
  const indexPath = join(config.rendererRoot, "index.html");
  if (!existsSync(indexPath)) {
    throw new CliError(EXIT.io, `renderer bundle not found at ${config.rendererRoot} — run \`pnpm --filter @meridian/cli copy-renderer\``);
  }
  const landing = injectPrefill(readFileSync(config.webUiPath, "utf8"), config.source);
  return {
    graphs: new Map(),
    rendererIndex: readFileSync(indexPath, "utf8"),
    landingHtml: landing,
    // Stray routes fall back to the front door rather than the renderer shell.
    staticAssets: { rendererRoot: config.rendererRoot, indexHtml: landing },
    cwd: config.cwd,
  };
}

async function handle(ctx: Context, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost");
  if (request.method === "POST" && url.pathname === "/api/generate") {
    await handleGenerate(ctx, request, response);
    return;
  }
  if (url.pathname === "/api/graph") {
    sendGraph(ctx, response, url.searchParams.get("id"));
    return;
  }
  if (url.pathname === "/api/meta") {
    sendMeta(ctx, response, url.searchParams.get("id"));
    return;
  }
  if (url.pathname === "/api/overlay") {
    sendJson(response, 400, { error: "no telemetry overlay in web mode" });
    return;
  }
  if (url.pathname === "/view") {
    sendView(ctx, response, url.searchParams.get("id"));
    return;
  }
  if (url.pathname === "/") {
    sendHtml(response, ctx.landingHtml);
    return;
  }
  serveStatic(ctx.staticAssets, url.pathname, response);
}

async function handleGenerate(ctx: Context, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const parsed = parseGenerateRequest(await readJsonBody(request));
  // Prefer an env token (never in the browser); a per-request token overrides it.
  const token = parsed.token ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  const source = await resolveSource({ kind: parsed.kind, value: parsed.value, ref: parsed.ref, subdir: parsed.subdir }, ctx.cwd, token);
  try {
    const { artifact, warnings } = await extractToArtifact({
      absoluteRoot: source.dir,
      cwd: source.dir, // records target.root as "." — never leaks the temp clone path
      language: parsed.lang,
      depth: "function",
      materializeBoundary: false,
      targetName: source.target, // the repo label (e.g. "sindresorhus/ky"), not the temp dir
    });
    const id = artifactId(parsed);
    ctx.graphs.set(id, artifact);
    sendJson(response, 200, {
      id,
      target: source.target,
      counts: { nodes: artifact.nodes.length, edges: artifact.edges.length },
      warnings,
    });
  } finally {
    source.cleanup();
  }
}

function sendGraph(ctx: Context, response: ServerResponse, id: string | null): void {
  const artifact = lookup(ctx, id);
  if (!artifact) {
    sendJson(response, 404, { error: "unknown graph id" });
    return;
  }
  sendJson(response, 200, artifact);
}

function sendMeta(ctx: Context, response: ServerResponse, id: string | null): void {
  const artifact = lookup(ctx, id);
  if (!artifact) {
    sendJson(response, 404, { error: "unknown graph id" });
    return;
  }
  sendJson(response, 200, {
    schemaVersion: artifact.schemaVersion,
    generatedAt: artifact.generatedAt,
    nodeCount: artifact.nodes.length,
    hasOverlay: false,
    environments: [],
  });
}

function sendView(ctx: Context, response: ServerResponse, id: string | null): void {
  if (!lookup(ctx, id)) {
    sendHtml(response, "<!doctype html><meta charset=utf-8><title>Meridian</title><p>Unknown graph id.</p>", 404);
    return;
  }
  sendHtml(response, injectViewBoot(ctx.rendererIndex, id as string));
}

function lookup(ctx: Context, id: string | null): GraphArtifact | undefined {
  return id ? ctx.graphs.get(id) : undefined;
}

function sendError(response: ServerResponse, error: unknown): void {
  if (response.headersSent) {
    response.end();
    return;
  }
  if (error instanceof WebError) {
    sendJson(response, error.status, { error: error.message });
    return;
  }
  if (error instanceof CliError) {
    sendJson(response, 422, { error: error.message });
    return;
  }
  // Never echo an unknown error's text — it could carry a path or secret we did not vet.
  sendJson(response, 500, { error: "internal error while generating the blueprint" });
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function sendHtml(response: ServerResponse, html: string, status = 200): void {
  response.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  response.end(html);
}
