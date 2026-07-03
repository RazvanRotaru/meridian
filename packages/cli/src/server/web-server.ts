/**
 * The pure HTTP server factory for `meridian web`.
 *
 * Returns an unbound `http.Server` so routing is unit-testable without a port or a browser. It holds
 * an in-memory Map of generated graphs (one per submitted source) plus the sign-in session store;
 * the renderer bundle is served UNCHANGED and only the injected `window.__MERIDIAN__` differs per
 * graph. Graph creation/serving lives in `web-graph`; the sign-in flow in `web-auth`.
 */

import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { GraphArtifact } from "@meridian/core";
import { CliError, EXIT } from "../errors";
import { serveStatic } from "./static-files";
import type { StaticAssets } from "./static-files";
import { WebError } from "./web-error";
import { injectAuthConfig, injectPrefill } from "./web-boot";
import { sendHtml, sendJson } from "./http-response";
import { createGitHubClient } from "./github";
import type { GitHubClient } from "./github";
import { SessionStore } from "./session";
import { assertJsonContentType, assertSameOrigin } from "./web-guards";
import { handleAuthSession, handleAuthStatus, handleDeviceStart, handleLogout, handleRepoSearch } from "./web-auth";
import { handleGenerate, sendGraph, sendMeta, sendView } from "./web-graph";

export interface WebServerConfig {
  rendererRoot: string;
  /** Path to the hand-written landing page (`web-ui/index.html`). */
  webUiPath: string;
  /** Directory local `kind:"path"` sources resolve against. */
  cwd: string;
  /** Optional CLI positional pre-filled into the landing form. */
  source?: string;
  /** GitHub OAuth app client id enabling Device Flow sign-in; absent → sign-in disabled. */
  githubClientId?: string;
}

export interface Context {
  graphs: Map<string, GraphArtifact>;
  rendererIndex: string;
  landingHtml: string;
  staticAssets: StaticAssets;
  cwd: string;
  sessions: SessionStore;
  github: GitHubClient | null;
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
  const github = config.githubClientId ? createGitHubClient({ clientId: config.githubClientId }) : null;
  const landing = injectAuthConfig(injectPrefill(readFileSync(config.webUiPath, "utf8"), config.source), github !== null);
  return {
    graphs: new Map(),
    rendererIndex: readFileSync(indexPath, "utf8"),
    landingHtml: landing,
    // Stray routes fall back to the front door rather than the renderer shell.
    staticAssets: { rendererRoot: config.rendererRoot, indexHtml: landing },
    cwd: config.cwd,
    sessions: new SessionStore(),
    github,
  };
}

async function handle(ctx: Context, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost");
  if (url.pathname.startsWith("/api/")) {
    await handleApi(ctx, request, response, url);
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

// Every `/api/*` path is terminal (never falls through to the static SPA fallback), and the
// same-origin guard runs before any handler so a cross-site page cannot drive these routes.
async function handleApi(ctx: Context, request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
  assertSameOrigin(request);
  if (request.method === "POST") {
    assertJsonContentType(request);
    await handleApiPost(ctx, request, response, url.pathname);
    return;
  }
  await handleApiGet(ctx, request, response, url);
}

async function handleApiPost(ctx: Context, request: IncomingMessage, response: ServerResponse, pathname: string): Promise<void> {
  if (pathname === "/api/generate") {
    await handleGenerate(ctx, request, response);
    return;
  }
  if (pathname === "/api/auth/device") {
    await handleDeviceStart(ctx, response);
    return;
  }
  if (pathname === "/api/auth/logout") {
    handleLogout(ctx, request, response);
    return;
  }
  sendJson(response, 404, { error: "unknown endpoint" });
}

async function handleApiGet(ctx: Context, request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
  const pathname = url.pathname;
  if (pathname === "/api/graph") {
    sendGraph(ctx, response, url.searchParams.get("id"));
    return;
  }
  if (pathname === "/api/meta") {
    sendMeta(ctx, response, url.searchParams.get("id"));
    return;
  }
  if (pathname === "/api/overlay") {
    sendJson(response, 400, { error: "no telemetry overlay in web mode" });
    return;
  }
  if (pathname === "/api/auth/status") {
    await handleAuthStatus(ctx, request, response);
    return;
  }
  if (pathname === "/api/auth/session") {
    handleAuthSession(ctx, request, response);
    return;
  }
  if (pathname === "/api/repos/search") {
    await handleRepoSearch(ctx, request, response, url.searchParams.get("q") ?? "");
    return;
  }
  sendJson(response, 404, { error: "unknown endpoint" });
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
