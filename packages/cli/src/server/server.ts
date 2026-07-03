/**
 * The pure HTTP server factory for `view`.
 *
 * It returns a configured-but-unbound `http.Server` so route behaviour is unit-testable
 * without opening a browser or claiming a port. Binding, the OS opener, and signal handling
 * live in the command; everything request-shaped lives here.
 */

import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { GraphArtifact } from "@meridian/core";
import { CliError, EXIT } from "../errors";
import { injectBootScript } from "./boot-script";
import type { OverlaySource } from "./overlay-source";
import { sendGraph, sendMeta, sendOverlay } from "./api";
import { sendSource } from "./source-serve";
import { serveStatic } from "./static-files";
import type { StaticAssets } from "./static-files";

export interface ServerConfig {
  artifact: GraphArtifact;
  overlay: OverlaySource;
  preselectedEnv: string | null;
  rendererRoot: string;
  /** Directory the `/api/source` code view reads from; absent → source view disabled. */
  sourceRoot?: string;
}

export function createBlueprintServer(config: ServerConfig): Server {
  const assets = loadAssets(config);
  return createServer((request, response) => route(config, assets, request, response));
}

function loadAssets(config: ServerConfig): StaticAssets {
  const indexPath = join(config.rendererRoot, "index.html");
  if (!existsSync(indexPath)) {
    throw new CliError(EXIT.io, `renderer bundle not found at ${config.rendererRoot} — run \`pnpm --filter @meridian/cli copy-renderer\``);
  }
  const rawHtml = readFileSync(indexPath, "utf8");
  const indexHtml = injectBootScript(rawHtml, config.overlay, config.preselectedEnv, config.sourceRoot ?? null);
  return { rendererRoot: config.rendererRoot, indexHtml };
}

function route(config: ServerConfig, assets: StaticAssets, request: IncomingMessage, response: ServerResponse): void {
  const url = new URL(request.url ?? "/", "http://localhost");
  if (url.pathname === "/api/meta") {
    sendMeta(response, config.artifact, config.overlay);
    return;
  }
  if (url.pathname === "/api/graph") {
    sendGraph(response, config.artifact);
    return;
  }
  if (url.pathname === "/api/overlay") {
    sendOverlay(response, config.artifact, config.overlay, url.searchParams.get("env"));
    return;
  }
  if (url.pathname === "/api/source") {
    sendSource(response, config.sourceRoot ?? null, url.searchParams);
    return;
  }
  serveStatic(assets, url.pathname, response);
}
