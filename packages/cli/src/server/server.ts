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
import type { ChangeOverlay, GraphArtifact } from "@meridian/core";
import { CliError, EXIT } from "../errors";
import { injectBootScript } from "./boot-script";
import type { OverlaySource } from "./overlay-source";
import { sendChange, sendFileDiff, sendGraph, sendMeta, sendOverlay } from "./api";
import { serveStatic } from "./static-files";
import type { StaticAssets } from "./static-files";

export interface ServerConfig {
  artifact: GraphArtifact;
  overlay: OverlaySource;
  change?: ChangeOverlay | null;
  preselectedEnv: string | null;
  rendererRoot: string;
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
  return {
    rendererRoot: config.rendererRoot,
    indexHtml: injectBootScript(rawHtml, config.overlay, config.preselectedEnv, config.change ?? null),
  };
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
  if (url.pathname === "/api/change") {
    sendChange(response, config.change ?? null);
    return;
  }
  if (url.pathname === "/api/file-diff") {
    void sendFileDiff(response, config.change ?? null, url.searchParams.get("file"));
    return;
  }
  serveStatic(assets, url.pathname, response);
}
