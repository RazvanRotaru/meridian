/**
 * Pure HTTP server factory for one immutable `meridian view` session.
 *
 * The complete graph is never part of this server's configuration or closures. Setup writes it
 * and its projection shards to a private session directory, then this long-lived process retains
 * only paths, a bounded summary/capability sidecar, and one 8 MiB-charged projection reader.
 */

import { existsSync, readFileSync } from "node:fs";
import { Server } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { performance } from "node:perf_hooks";
import { join } from "node:path";
import type { SyntheticScenarioDescriptor } from "@meridian/core";
import { CliError, EXIT } from "../errors";
import { injectBootScript } from "./boot-script";
import {
  defaultGraphProjectionRequest,
  GraphProjectionBundle,
  GraphSymbolSearchRequestError,
  type GraphSymbolSearchRequest,
} from "./graph-projection-bundle";
import {
  createGraphProjectionAdmission,
  handleGraphProjectionRequest,
} from "./graph-projection-response";
import type { OverlaySource } from "./overlay-source";
import { sendMeta, sendOverlay, sendTraces } from "./api";
import { sendJson } from "./http-response";
import { sendSource } from "./source-serve";
import type { StandaloneViewSession } from "./standalone-view-session";
import { readSyntheticCapabilitySidecar } from "./synthetic-capability-sidecar";
import { serveStatic } from "./static-files";
import type { StaticAssets } from "./static-files";
import {
  runSyntheticScenarioFromArtifactFile,
  SyntheticExecutionError,
  syntheticExecutionRuntimeSupported,
} from "./synthetic-execution";
import { WebError } from "./web-error";
import { createSourceTextAdmission, type SourceTextAdmission } from "./source-text-admission";
import { cancelWhenClientLeaves } from "./web-cancellation";
import { assertJsonContentType, assertLoopbackHost, assertSameOrigin } from "./web-guards";
import { parseSyntheticExecutionRequest, readJsonBody } from "./web-request";

const PROJECTION_CACHE_BYTES = 8 * 1024 * 1024;
const PROJECTION_CACHE_ENTRIES = 32;

class ShutdownOwnedServer extends Server {
  constructor(
    private readonly shutdown: AbortController,
    requestListener: (request: IncomingMessage, response: ServerResponse) => void,
  ) {
    super(requestListener);
  }

  override close(callback?: (error?: Error) => void): this {
    if (!this.shutdown.signal.aborted) this.shutdown.abort(standaloneServerClosingError());
    return super.close(callback) as this;
  }
}

export interface ServerConfig {
  session: StandaloneViewSession;
  overlay: OverlaySource;
  preselectedEnv: string | null;
  rendererRoot: string;
  /** Explicit code-execution opt-in. Source/runtime/fingerprint gates still apply. */
  allowSyntheticExecution?: boolean;
  /** Deterministic test seam; production always uses the short-lived artifact-file worker. */
  runSyntheticScenarioFromArtifactFile?: typeof runSyntheticScenarioFromArtifactFile;
}

interface SyntheticCapability {
  readonly sourceRoot: string;
  readonly scenarios: readonly SyntheticScenarioDescriptor[];
  readonly sourceFingerprint: string;
}

interface ServerState {
  readonly shutdownSignal: AbortSignal;
  readonly session: StandaloneViewSession;
  readonly overlay: OverlaySource;
  readonly preselectedEnv: string | null;
  readonly projection: GraphProjectionBundle;
  readonly graphProjectionAdmission: ReturnType<typeof createGraphProjectionAdmission>;
  readonly sourceTextAdmission: SourceTextAdmission;
  readonly graphId: string;
  readonly synthetic: SyntheticCapability | null;
  readonly runSyntheticScenarioFromArtifactFile: typeof runSyntheticScenarioFromArtifactFile;
}

export function createBlueprintServer(config: ServerConfig): Server {
  const shutdown = new AbortController();
  const projection = new GraphProjectionBundle(config.session.projectionDirectory, {
    maxCacheBytes: PROJECTION_CACHE_BYTES,
    maxCacheEntries: PROJECTION_CACHE_ENTRIES,
  });
  const state: ServerState = {
    shutdownSignal: shutdown.signal,
    session: config.session,
    overlay: config.overlay,
    preselectedEnv: config.preselectedEnv,
    projection,
    graphProjectionAdmission: createGraphProjectionAdmission(),
    sourceTextAdmission: createSourceTextAdmission(),
    graphId: `standalone-${projection.manifest.contentId}`,
    synthetic: syntheticCapability(config),
    runSyntheticScenarioFromArtifactFile:
      config.runSyntheticScenarioFromArtifactFile ?? runSyntheticScenarioFromArtifactFile,
  };
  const assets = loadAssets(config, state.graphId, state.synthetic?.scenarios ?? null);
  const server = new ShutdownOwnedServer(shutdown, (request, response) => {
    void route(state, assets, request, response).catch((error) => sendRouteError(response, error));
  });
  server.once("close", () => {
    projection.clearMemoryCache();
    config.session.cleanup();
  });
  return server;
}

function standaloneServerClosingError(): Error {
  const error = new Error("The standalone view server is closing");
  error.name = "AbortError";
  return error;
}

function syntheticCapability(config: ServerConfig): SyntheticCapability | null {
  if (config.allowSyntheticExecution !== true
    || config.session.sourceRoot === null
    || !syntheticExecutionRuntimeSupported()) return null;
  const sidecar = readSyntheticCapabilitySidecar(config.session.syntheticCapabilityPath);
  if (sidecar?.state !== "ready" || sidecar.sourceFingerprint === null) return null;
  return {
    sourceRoot: config.session.sourceRoot,
    scenarios: sidecar.scenarios,
    sourceFingerprint: sidecar.sourceFingerprint,
  };
}

function loadAssets(
  config: ServerConfig,
  projectionGraphId: string,
  syntheticScenarios: readonly SyntheticScenarioDescriptor[] | null,
): StaticAssets {
  const indexPath = join(config.rendererRoot, "index.html");
  if (!existsSync(indexPath)) {
    throw new CliError(
      EXIT.io,
      `renderer bundle not found at ${config.rendererRoot} — run \`pnpm --filter @meridian/cli copy-renderer\``,
    );
  }
  const rawHtml = readFileSync(indexPath, "utf8");
  const indexHtml = injectBootScript(
    rawHtml,
    projectionGraphId,
    config.overlay,
    config.preselectedEnv,
    config.session.sourceRoot,
    syntheticScenarios === null ? null : [...syntheticScenarios],
  );
  return { rendererRoot: config.rendererRoot, indexHtml };
}

async function route(
  state: ServerState,
  assets: StaticAssets,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost");
  const method = request.method ?? "GET";

  if (url.pathname === "/api/graph/manifest") {
    if (!requireMethod(response, method, "GET")) return;
    rejectQuery(url, "graph manifest");
    sendProjectionManifest(state, response);
    return;
  }
  if (url.pathname === "/api/graph/projection") {
    if (!requireMethod(response, method, "POST")) return;
    rejectQuery(url, "graph projection");
    assertSameOrigin(request);
    assertJsonContentType(request);
    await sendProjection(state, request, response);
    return;
  }
  if (url.pathname === "/api/graph/search") {
    if (!requireMethod(response, method, "POST")) return;
    rejectQuery(url, "graph symbol search");
    assertSameOrigin(request);
    assertJsonContentType(request);
    await sendSymbolSearch(state, request, response);
    return;
  }
  if (url.pathname === "/api/meta") {
    if (!requireMethod(response, method, "GET")) return;
    sendMeta(
      response,
      state.session.graphSummary,
      state.overlay,
      state.preselectedEnv,
      state.session.warnings,
    );
    return;
  }
  if (url.pathname === "/api/overlay" || url.pathname === "/api/traces") {
    if (!requireMethod(response, method, "GET")) return;
    const cancellation = cancelWhenClientLeaves(request, response);
    try {
      const mock = {
        artifactPath: state.session.artifactPath,
        scratchRoot: state.session.scratchRoot,
        signal: cancellation.signal,
      };
      if (url.pathname === "/api/overlay") {
        await sendOverlay(
          response,
          state.overlay,
          url.searchParams.get("env"),
          url.searchParams.get("source"),
          mock,
          state.preselectedEnv,
        );
      } else {
        await sendTraces(
          response,
          state.overlay,
          url.searchParams.get("env"),
          url.searchParams.get("source"),
          mock,
          state.preselectedEnv,
        );
      }
    } finally {
      cancellation.dispose();
    }
    return;
  }
  if (url.pathname === "/api/source") {
    if (!requireMethod(response, method, "GET")) return;
    const cancellation = cancelWhenClientLeaves(request, response);
    try {
      await sendSource(response, state.session.sourceRoot, url.searchParams, {
        admission: state.sourceTextAdmission,
        signal: cancellation.signal,
      });
    } finally {
      cancellation.dispose();
    }
    return;
  }
  if (url.pathname === "/api/synthetic-executions") {
    await handleSyntheticExecution(state, request, response);
    return;
  }
  if (url.pathname.startsWith("/api/")) {
    sendJson(response, 404, { error: "unknown endpoint" });
    return;
  }
  serveStatic(assets, url.pathname, response);
}

function sendProjectionManifest(state: ServerState, response: ServerResponse): void {
  const manifest = state.projection.manifest;
  sendJson(response, 200, {
    version: manifest.formatVersion,
    graphId: state.graphId,
    contentId: manifest.contentId,
    graphSummary: manifest.graphSummary,
    repositorySummary: manifest.repositorySummary,
    defaultView: defaultGraphProjectionRequest(),
  });
}

async function sendProjection(
  state: ServerState,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  await handleGraphProjectionRequest({
    admission: state.graphProjectionAdmission,
    bundle: state.projection,
    request,
    response,
    lifecycleSignal: state.shutdownSignal,
  });
}

async function sendSymbolSearch(
  state: ServerState,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const body = await readJsonBody({ request, signal: state.shutdownSignal });
  const cancellation = cancelWhenClientLeaves(request, response);
  const operationSignal = AbortSignal.any([cancellation.signal, state.shutdownSignal]);
  try {
    const queryStarted = performance.now();
    const result = await state.projection.search(body as GraphSymbolSearchRequest, operationSignal);
    operationSignal.throwIfAborted();
    const queryMs = performance.now() - queryStarted;
    const serializationStarted = performance.now();
    const serialized = JSON.stringify({ ...result, graphId: state.graphId });
    const serializationMs = performance.now() - serializationStarted;
    response.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "content-length": Buffer.byteLength(serialized),
      "server-timing": `symbol_search;dur=${queryMs.toFixed(2)}, symbol_serialize;dur=${serializationMs.toFixed(2)}`,
    });
    response.end(serialized);
  } catch (error) {
    if (error instanceof GraphSymbolSearchRequestError) throw new WebError(error.status, error.message);
    throw error;
  } finally {
    cancellation.dispose();
  }
}

async function handleSyntheticExecution(
  state: ServerState,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  assertLoopbackHost(request);
  assertSameOrigin(request);
  if (!requireMethod(response, request.method ?? "GET", "POST")) return;
  assertJsonContentType(request);
  if (state.synthetic === null) {
    sendJson(response, 404, { error: "synthetic execution is not enabled for this local view" });
    return;
  }
  const body = parseSyntheticExecutionRequest(await readJsonBody({ request, signal: state.shutdownSignal }));
  const scenario = state.synthetic.scenarios.find((candidate) => candidate.id === body.scenarioId);
  if (scenario === undefined) {
    throw new WebError(404, "synthetic scenario not found");
  }
  if (scenario.rootId !== body.rootNodeId) {
    throw new WebError(409, "selected flow no longer matches the synthetic scenario");
  }
  const cancellation = cancelWhenClientLeaves(request, response);
  const operationSignal = AbortSignal.any([cancellation.signal, state.shutdownSignal]);
  const execution = await state.runSyntheticScenarioFromArtifactFile({
    sourceRoot: state.synthetic.sourceRoot,
    artifactPath: state.session.artifactPath,
    scenarioId: body.scenarioId,
    expectedRootId: body.rootNodeId,
    expectedSourceFingerprint: state.synthetic.sourceFingerprint,
    input: body.input,
    inputOverrides: body.inputOverrides,
    watchers: body.watchers,
    signal: operationSignal,
  }).finally(() => cancellation.dispose());
  sendJson(response, 200, execution);
}

function requireMethod(response: ServerResponse, actual: string, expected: "GET" | "POST"): boolean {
  if (actual === expected) return true;
  sendJson(response, 405, { error: `${expected} required` }, { allow: expected });
  return false;
}

function rejectQuery(url: URL, label: string): void {
  if (url.search.length > 0) throw new WebError(400, `${label} endpoint does not accept query parameters`);
}

function sendRouteError(response: ServerResponse, error: unknown): void {
  if (response.headersSent || response.writableEnded || response.destroyed) {
    response.end();
    return;
  }
  if (error instanceof SyntheticExecutionError || error instanceof WebError) {
    sendJson(response, error.status, { error: error.message });
    return;
  }
  sendJson(response, 500, { error: "request failed" });
}
