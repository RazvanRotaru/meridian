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
import type { GraphArtifact, SyntheticScenarioDescriptor } from "@meridian/core";
import { CliError, EXIT } from "../errors";
import { injectBootScript } from "./boot-script";
import type { OverlaySource } from "./overlay-source";
import { sendGraph, sendMeta, sendOverlay, sendTraces } from "./api";
import { sendSource } from "./source-serve";
import { serveStatic } from "./static-files";
import type { StaticAssets } from "./static-files";
import { sendJson } from "./http-response";
import { assertJsonContentType, assertLoopbackHost, assertSameOrigin } from "./web-guards";
import { parseSyntheticExecutionRequest, readJsonBody } from "./web-request";
import { WebError } from "./web-error";
import {
  loadSyntheticScenarios,
  runSyntheticScenario,
  SyntheticExecutionError,
  syntheticExecutionRuntimeSupported,
  syntheticSourceFingerprint,
} from "./synthetic-execution";

export interface ServerConfig {
  artifact: GraphArtifact;
  overlay: OverlaySource;
  preselectedEnv: string | null;
  rendererRoot: string;
  /** Directory the `/api/source` code view reads from; absent → source view disabled. */
  sourceRoot?: string;
  /** Explicit code-execution opt-in. It is still unavailable without a local source root. */
  allowSyntheticExecution?: boolean;
}

export function createBlueprintServer(config: ServerConfig): Server {
  const synthetic = syntheticCapability(config);
  const assets = loadAssets(config, synthetic?.scenarios ?? null);
  return createServer((request, response) => {
    void route(config, assets, synthetic, request, response).catch((error) => sendRouteError(response, error));
  });
}

interface SyntheticCapability {
  sourceRoot: string;
  scenarios: SyntheticScenarioDescriptor[];
  /** Bound to the exact manifest/config/source snapshot advertised in the boot contract. */
  sourceFingerprint: string;
}

function syntheticCapability(config: ServerConfig): SyntheticCapability | null {
  if (
    config.allowSyntheticExecution !== true
    || config.sourceRoot === undefined
    || !syntheticExecutionRuntimeSupported()
  ) {
    return null;
  }
  const scenarios = loadSyntheticScenarios(config.sourceRoot);
  return scenarios.length === 0
    ? null
    : {
        sourceRoot: config.sourceRoot,
        scenarios,
        sourceFingerprint: syntheticSourceFingerprint(config.sourceRoot, config.artifact),
      };
}

function loadAssets(config: ServerConfig, syntheticScenarios: SyntheticScenarioDescriptor[] | null): StaticAssets {
  const indexPath = join(config.rendererRoot, "index.html");
  if (!existsSync(indexPath)) {
    throw new CliError(EXIT.io, `renderer bundle not found at ${config.rendererRoot} — run \`pnpm --filter @meridian/cli copy-renderer\``);
  }
  const rawHtml = readFileSync(indexPath, "utf8");
  const indexHtml = injectBootScript(
    rawHtml,
    config.overlay,
    config.preselectedEnv,
    config.sourceRoot ?? null,
    syntheticScenarios,
  );
  return { rendererRoot: config.rendererRoot, indexHtml };
}

async function route(
  config: ServerConfig,
  assets: StaticAssets,
  synthetic: SyntheticCapability | null,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost");
  if (url.pathname === "/api/synthetic-executions") {
    await handleSyntheticExecution(config, synthetic, request, response);
    return;
  }
  if (url.pathname === "/api/meta") {
    sendMeta(response, config.artifact, config.overlay, config.preselectedEnv);
    return;
  }
  if (url.pathname === "/api/graph") {
    sendGraph(response, config.artifact);
    return;
  }
  if (url.pathname === "/api/overlay") {
    sendOverlay(
      response,
      config.artifact,
      config.overlay,
      url.searchParams.get("env"),
      url.searchParams.get("source"),
      config.preselectedEnv,
    );
    return;
  }
  if (url.pathname === "/api/traces") {
    sendTraces(
      response,
      config.artifact,
      config.overlay,
      url.searchParams.get("env"),
      url.searchParams.get("source"),
      config.preselectedEnv,
    );
    return;
  }
  if (url.pathname === "/api/source") {
    sendSource(response, config.sourceRoot ?? null, url.searchParams);
    return;
  }
  serveStatic(assets, url.pathname, response);
}

async function handleSyntheticExecution(
  config: ServerConfig,
  synthetic: SyntheticCapability | null,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  assertLoopbackHost(request);
  assertSameOrigin(request);
  if (request.method !== "POST") {
    sendJson(response, 405, { error: "synthetic execution requires POST" });
    return;
  }
  assertJsonContentType(request);
  if (synthetic === null) {
    sendJson(response, 404, { error: "synthetic execution is not enabled for this local view" });
    return;
  }
  const body = parseSyntheticExecutionRequest(await readJsonBody(request));
  const scenario = synthetic.scenarios.find((candidate) => candidate.id === body.scenarioId);
  if (scenario !== undefined && scenario.rootId !== body.rootNodeId) {
    throw new WebError(409, "selected flow no longer matches the synthetic scenario");
  }
  const execution = await runSyntheticScenario({
    sourceRoot: synthetic.sourceRoot,
    artifact: config.artifact,
    scenarioId: body.scenarioId,
    expectedRootId: body.rootNodeId,
    expectedSourceFingerprint: synthetic.sourceFingerprint,
    input: body.input,
    inputOverrides: body.inputOverrides,
    watchers: body.watchers,
  });
  sendJson(response, 200, execution);
}

function sendRouteError(response: ServerResponse, error: unknown): void {
  if (response.headersSent) {
    response.end();
    return;
  }
  if (error instanceof SyntheticExecutionError || error instanceof WebError) {
    sendJson(response, error.status, { error: error.message });
    return;
  }
  sendJson(response, 500, { error: "synthetic execution failed" });
}
