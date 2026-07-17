/** Route and retention boundary for the immutable standalone-view server. */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import type { IncomingMessage, Server } from "node:http";
import { createConnection } from "node:net";
import type { AddressInfo, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { GraphArtifact, TraceBundle } from "@meridian/core";
import { traceBundleSchema } from "@meridian/core";
import { buildMockOverlay } from "@meridian/core/mock";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { SyntheticExecutionError } from "./synthetic-execution";
import {
  defaultGraphProjectionRequest,
  GRAPH_PROJECTION_FORMAT_VERSION,
} from "./graph-projection-bundle";
import { createBlueprintServer } from "./server";
import type { StandaloneViewSession } from "./standalone-view-session";
import { createStandaloneViewSession } from "./standalone-view-session";

const artifact: GraphArtifact = {
  schemaVersion: "1.0.0",
  generatedAt: "2026-01-01T00:00:00.000Z",
  generator: { name: "blueprint", version: "test" },
  target: { name: "fixture", root: ".", language: "typescript" },
  telemetry: { joinKey: "node.id", requiredRuntimeAttributes: ["service.name"], serviceDefaulting: "forbidden" },
  nodes: [{
    id: "ts:src/api/orderRoutes.ts#OrderRoutes.handleCreateOrder",
    kind: "method",
    qualifiedName: "OrderRoutes.handleCreateOrder",
    displayName: "handleCreateOrder",
    location: { file: "src/api/orderRoutes.ts", startLine: 16, endLine: 23 },
  }],
  edges: [],
};
const ORDERS_SOURCE = fileURLToPath(new URL("../../../../examples/orders-service/", import.meta.url));
const PLACE_ORDER_ROOT = "ts:src/services/orderService.ts#OrderService.placeOrder";
const syntheticArtifact: GraphArtifact = {
  ...artifact,
  nodes: [
    ...artifact.nodes,
    {
      id: PLACE_ORDER_ROOT,
      kind: "method",
      qualifiedName: "OrderService.placeOrder",
      displayName: "placeOrder",
      location: { file: "src/services/orderService.ts", startLine: 18, endLine: 32 },
    },
  ],
};

const inputRoots: string[] = [];
const sessions: StandaloneViewSession[] = [];
let rendererRoot: string;
let session: StandaloneViewSession;
let server: Server;
let base: string;

beforeAll(async () => {
  rendererRoot = writeFakeRenderer();
  session = sessionFor(artifact);
  server = createBlueprintServer({
    session,
    overlay: { kind: "mock" },
    preselectedEnv: "staging",
    rendererRoot,
  });
  base = await listenEphemeral(server);
});

afterAll(async () => {
  await closeServer(server);
  for (const candidate of sessions) candidate.cleanup();
  for (const root of inputRoots.splice(0)) rmSync(root, { recursive: true, force: true });
  rmSync(rendererRoot, { recursive: true, force: true });
});

describe("createBlueprintServer", () => {
  it.each([
    ["graph projection", "/api/graph/projection", false],
    ["graph search", "/api/graph/search", false],
    ["synthetic execution", "/api/synthetic-executions", true],
  ])("closes with a partial %s JSON body", { timeout: 15_000 }, async (_label, path, synthetic) => {
    const target = createBlueprintServer({
      session: sessionFor(artifact, synthetic ? ORDERS_SOURCE : undefined),
      overlay: { kind: "none" },
      preselectedEnv: null,
      rendererRoot,
      allowSyntheticExecution: synthetic,
    });
    const targetBase = await listenEphemeral(target);
    const socket = await openPartialJsonPost(target, targetBase, path);
    const socketClosed = new Promise<void>((resolveClose) => socket.once("close", () => resolveClose()));

    const close = closeServerWithoutForcingConnections(target);
    const closedPromptly = await settlesWithin(close, 5_000, () => socket.destroy());
    await socketClosed;

    expect(closedPromptly).toBe(true);
    expect(socket.destroyed).toBe(true);
  });

  it("serves only strict projection transport and bounded metadata", async () => {
    const manifestResponse = await fetch(`${base}/api/graph/manifest`);
    expect(manifestResponse.headers.get("cache-control")).toBe("no-store");
    expect(await manifestResponse.json()).toMatchObject({
      version: GRAPH_PROJECTION_FORMAT_VERSION,
      graphId: expect.stringMatching(/^standalone-[0-9a-f]{64}$/),
      contentId: expect.stringMatching(/^[0-9a-f]{64}$/),
      graphSummary: { nodeCount: 1, edgeCount: 0 },
      repositorySummary: { overviewPackageCount: 0, sourceFileCount: 0, testSourceFileCount: 0 },
      defaultView: defaultGraphProjectionRequest(),
    });

    const projectionResponse = await fetch(`${base}/api/graph/projection`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...defaultGraphProjectionRequest(),
        focusIds: [artifact.nodes[0]!.id],
        depth: 0,
      }),
    });
    expect(projectionResponse.headers.get("server-timing")).toMatch(/^projection_query;dur=/);
    expect(projectionResponse.headers.has("content-length")).toBe(false);
    const projectionText = await projectionResponse.text();
    const projection = JSON.parse(projectionText) as Record<string, unknown> & {
      projectionId: string;
      residentBytes: number;
    };
    expect(projectionResponse.headers.get("x-meridian-projection-id")).toBe(projection.projectionId);
    expect(projectionResponse.headers.get("x-meridian-resident-bytes")).toBe(String(projection.residentBytes));
    expect(projection).toMatchObject({
      version: GRAPH_PROJECTION_FORMAT_VERSION,
      contentId: expect.stringMatching(/^[0-9a-f]{64}$/),
      request: { view: "modules", depth: 0 },
      completeness: { complete: true },
      artifact: { nodes: [{ id: artifact.nodes[0]!.id }], edges: [] },
      hierarchy: {
        moduleOverviewRootIds: [],
        nodes: {
          [artifact.nodes[0]!.id]: {
            isTest: false,
            childKindCounts: {},
            descendantSourceFileCount: 0,
            ownedSourceFileCount: 0,
          },
        },
      },
    });

    const searchResponse = await fetch(`${base}/api/graph/search`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: 1, query: "CREATE", mode: "map", scope: "public" }),
    });
    expect(searchResponse.headers.get("server-timing")).toMatch(/symbol_search.*symbol_serialize/);
    expect(await searchResponse.json()).toMatchObject({
      version: 1,
      graphId: expect.stringMatching(/^standalone-[0-9a-f]{64}$/),
      contentId: expect.stringMatching(/^[0-9a-f]{64}$/),
      mode: "map",
      scope: "public",
      scopeCounts: { public: 1, all: 1, private: 0 },
      results: [{
        id: artifact.nodes[0]!.id,
        displayName: "handleCreateOrder",
        qualifiedName: "OrderRoutes.handleCreateOrder",
        file: "src/api/orderRoutes.ts",
        kind: "method",
        isPrivateMethod: false,
        stepCount: null,
      }],
    });

    expect((await fetch(`${base}/api/graph`)).status).toBe(404);
    expect((await fetch(`${base}/api/graph/projection`)).status).toBe(405);
    expect((await fetch(`${base}/api/graph/search`)).status).toBe(405);
    expect((await fetch(`${base}/api/graph/manifest`, { method: "POST" })).status).toBe(405);
    expect((await fetch(`${base}/api/graph/manifest?legacy=1`)).status).toBe(400);
    expect((await fetch(`${base}/api/graph/search?legacy=1`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: 1, query: "", mode: "map", scope: "public" }),
    })).status).toBe(400);
  });

  it("rejects malformed, cross-origin, and non-JSON projection requests", async () => {
    const nonJson = await fetch(`${base}/api/graph/projection`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "{}",
    });
    expect(nonJson.status).toBe(415);

    const crossOrigin = await fetch(`${base}/api/graph/projection`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      body: "{}",
    });
    expect(crossOrigin.status).toBe(403);

    const unknownField = await fetch(`${base}/api/graph/projection`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ view: "modules", legacyGraph: true }),
    });
    expect(unknownField.status).toBe(400);
    expect(await unknownField.json()).toMatchObject({
      error: expect.stringContaining(`v${GRAPH_PROJECTION_FORMAT_VERSION} contract`),
    });

    const malformedSearch = await fetch(`${base}/api/graph/search`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: 0, query: "", mode: "map", scope: "public", legacyGraph: true }),
    });
    expect(malformedSearch.status).toBe(400);
    expect(await malformedSearch.json()).toMatchObject({ error: expect.stringContaining("unknown") });
  });

  it("serves explicit-source mock overlays without a source-less compatibility path", { timeout: 15_000 }, async () => {
    expect(await getJson(`${base}/api/overlay?source=demo&env=demo`)).toMatchObject({ kind: "mock", env: "demo" });
    expect(await getJson(`${base}/api/overlay?source=demo&env=staging`)).toMatchObject({ kind: "mock", env: "staging" });
    expect(await getJson(`${base}/api/overlay?source=demo&env=qa`)).toMatchObject({ kind: "mock", env: "qa" });
    expect((await fetch(`${base}/api/overlay?env=staging`)).status).toBe(400);
    expect((await fetch(`${base}/api/overlay`)).status).toBe(400);
    expect((await fetch(`${base}/api/overlay?source=missing&env=demo`)).status).toBe(404);

    const normalized = await getJson(`${base}/api/overlay?source=demo&env=${encodeURIComponent("  qa-west  ")}`);
    expect(normalized).toMatchObject({ kind: "mock", env: "qa-west" });
    expect((await fetch(`${base}/api/overlay?source=demo&env=${"x".repeat(257)}`)).status).toBe(400);
  });

  it("derives mock traces in the short-lived file worker", { timeout: 15_000 }, async () => {
    const response = await fetch(`${base}/api/traces?source=demo&env=demo`);
    const bundle = (await response.json()) as TraceBundle;
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(bundle).toMatchObject({ traceVersion: "1.0.0", source: "mock", env: "demo", traces: expect.any(Array) });
    expect(traceBundleSchema.safeParse(bundle).success).toBe(true);
    expect(bundle.traces.length).toBeGreaterThanOrEqual(12);
    expect((await fetch(`${base}/api/traces?env=demo`)).status).toBe(400);
    expect((await fetch(`${base}/api/traces`)).status).toBe(400);
  });

  it("keeps a no-overlay session unselected while exposing only the narrow demo source", async () => {
    const target = createBlueprintServer({
      session: sessionFor(artifact),
      overlay: { kind: "none" },
      preselectedEnv: null,
      rendererRoot,
    });
    const targetBase = await listenEphemeral(target);
    try {
      expect((await fetch(`${targetBase}/api/traces?source=demo&env=qa`)).status).toBe(404);
      expect(await getJson(`${targetBase}/api/meta`)).toMatchObject({
        hasOverlay: false,
        environments: [],
        telemetrySources: [{ id: "demo", environments: ["demo"] }],
      });
      expect((await fetch(`${targetBase}/api/traces?source=demo&env=demo`)).status).toBe(200);
    } finally {
      await closeServer(target);
    }
  });

  it("capability-gates traces for a metrics-only saved source", { timeout: 15_000 }, async () => {
    const target = createBlueprintServer({
      session: sessionFor(artifact),
      overlay: { kind: "file", overlay: buildMockOverlay(artifact, "staging") },
      preselectedEnv: "staging",
      rendererRoot,
    });
    const targetBase = await listenEphemeral(target);
    try {
      expect((await fetch(`${targetBase}/api/traces?source=configured&env=prod`)).status).toBe(404);
      expect(await getJson(`${targetBase}/api/meta`)).toMatchObject({
        telemetrySources: [
          { id: "demo", kind: "mock", environments: ["demo"] },
          { id: "configured", kind: "file", environments: ["staging"] },
        ],
      });
      expect((await fetch(`${targetBase}/api/traces?source=configured&env=staging`)).status).toBe(404);
      expect((await fetch(`${targetBase}/api/traces?env=staging`)).status).toBe(400);
      expect((await fetch(`${targetBase}/api/traces?source=demo&env=demo`)).status).toBe(200);
      const html = await (await fetch(`${targetBase}/`)).text();
      expect(html).toContain('"preselectedTelemetrySourceId":"configured"');
    } finally {
      await closeServer(target);
    }
  });

  it("injects projection-only boot fields and never defaults an environment", async () => {
    const html = await (await fetch(`${base}/`)).text();
    expect(html).toContain("window.__MERIDIAN__=");
    expect(html).toContain('"projectionGraphId":"standalone-');
    expect(html).toContain('"projectionManifestUrl":"/api/graph/manifest"');
    expect(html).toContain('"projectionUrl":"/api/graph/projection"');
    expect(html).toContain('"graphSearchUrl":"/api/graph/search"');
    expect(html).not.toContain('"graphUrl"');
    expect(html).toContain('"traceUrl":"/api/traces"');
    expect(html).toContain('"syntheticExecutionUrl":null');
    expect(html).toContain('"syntheticExecutionTrust":null');
    expect(html).toContain('"preselectedTelemetrySourceId":"demo"');
    expect(html).toContain('"preselectedEnv":"staging"');
    expect(html).toContain('"defaultEnv":null');
    expect(html).toContain('"githubSource":null');
  });

  it("keeps synthetic execution unavailable without the exact local capability", async () => {
    const response = await fetch(`${base}/api/synthetic-executions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scenarioId: "place-order", rootNodeId: artifact.nodes[0]!.id, input: {} }),
    });
    expect(response.status).toBe(404);

    const wrongType = await fetch(`${base}/api/synthetic-executions`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "{}",
    });
    expect(wrongType.status).toBe(415);

    const crossOrigin = await fetch(`${base}/api/synthetic-executions`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://evil.example" },
      body: "{}",
    });
    expect(crossOrigin.status).toBe(403);
  });

  it("advertises only the opted-in sidecar catalog and rejects invalid scenario identity", async () => {
    const target = createBlueprintServer({
      session: sessionFor(artifact, ORDERS_SOURCE),
      overlay: { kind: "none" },
      preselectedEnv: null,
      rendererRoot,
      allowSyntheticExecution: true,
    });
    const targetBase = await listenEphemeral(target);
    try {
      const html = await (await fetch(`${targetBase}/`)).text();
      expect(html).toContain('"syntheticExecutionUrl":"/api/synthetic-executions"');
      expect(html).toContain('"syntheticExecutionTrust":{"mode":"local"}');
      expect(html).toContain('"id":"place-order-happy"');

      const stale = await fetch(`${targetBase}/api/synthetic-executions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scenarioId: "place-order-happy", rootNodeId: artifact.nodes[0]!.id, input: {} }),
      });
      expect(stale.status).toBe(409);

      const missingRoot = await fetch(`${targetBase}/api/synthetic-executions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scenarioId: "place-order-happy", input: {} }),
      });
      expect(missingRoot.status).toBe(400);

      const unknown = await fetch(`${targetBase}/api/synthetic-executions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scenarioId: "missing", rootNodeId: PLACE_ORDER_ROOT, input: {} }),
      });
      expect(unknown.status).toBe(404);
    } finally {
      await closeServer(target);
    }
  });

  it("delegates execution by artifact path and exact sidecar fingerprint", async () => {
    const exactSession = sessionFor(syntheticArtifact, ORDERS_SOURCE);
    const runner = vi.fn(async (request: Parameters<NonNullable<
      Parameters<typeof createBlueprintServer>[0]["runSyntheticScenarioFromArtifactFile"]
    >>[0]) => {
      expect(request.artifactPath).toBe(exactSession.artifactPath);
      expect(request.sourceRoot).toBe(ORDERS_SOURCE);
      expect(request.expectedSourceFingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(request.signal?.aborted).toBe(false);
      throw new SyntheticExecutionError("invalid-request", 409, "source changed after advertisement; reload the graph");
    });
    const target = createBlueprintServer({
      session: exactSession,
      overlay: { kind: "none" },
      preselectedEnv: null,
      rendererRoot,
      allowSyntheticExecution: true,
      runSyntheticScenarioFromArtifactFile: runner,
    });
    const targetBase = await listenEphemeral(target);
    try {
      const response = await fetch(`${targetBase}/api/synthetic-executions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scenarioId: "place-order-happy", rootNodeId: PLACE_ORDER_ROOT, input: {} }),
      });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: expect.stringMatching(/source changed.*reload/i) });
      expect(runner).toHaveBeenCalledOnce();
      expect(runner.mock.calls[0]![0]).not.toHaveProperty("artifact");
    } finally {
      await closeServer(target);
    }
  });

  it("clears the projection reader and private session when the server closes", async () => {
    const disposable = sessionFor(artifact);
    const target = createBlueprintServer({
      session: disposable,
      overlay: { kind: "none" },
      preselectedEnv: null,
      rendererRoot,
    });
    await listenEphemeral(target);
    expect(existsSync(disposable.root)).toBe(true);
    await closeServer(target);
    expect(existsSync(disposable.root)).toBe(false);
  });

  it("serves assets, falls back for SPA routes, and never turns unknown API paths into HTML", async () => {
    expect((await fetch(`${base}/assets/app.js`)).headers.get("content-type")).toContain("javascript");
    expect((await fetch(`${base}/some/spa/route`)).headers.get("content-type")).toContain("html");
    const unknownApi = await fetch(`${base}/api/removed-legacy-route`);
    expect(unknownApi.status).toBe(404);
    expect(unknownApi.headers.get("content-type")).toContain("json");
  });

  it("survives malformed percent-encoding", async () => {
    expect((await fetch(`${base}/%E0%A4`)).status).toBe(200);
    expect((await fetch(`${base}/api/meta`)).status).toBe(200);
  });
});

function sessionFor(input: GraphArtifact, sourceRoot: string | null = null): StandaloneViewSession {
  const cwd = mkdtempSync(join(tmpdir(), "meridian-view-input-"));
  inputRoots.push(cwd);
  const graphPath = join(cwd, "graph.json");
  writeFileSync(graphPath, JSON.stringify(input));
  const created = createStandaloneViewSession({ graphPath, cwd, sourceRoot });
  sessions.push(created);
  return created;
}

async function getJson<T = Record<string, unknown>>(url: string): Promise<T> {
  return (await (await fetch(url)).json()) as T;
}

function writeFakeRenderer(): string {
  const dir = mkdtempSync(join(tmpdir(), "blueprint-renderer-"));
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "index.html"), "<!doctype html><html><head></head><body></body></html>");
  writeFileSync(join(dir, "assets", "app.js"), "export const ready = true;");
  return dir;
}

function listenEphemeral(target: Server): Promise<string> {
  return new Promise((resolveBase) => {
    target.listen(0, "127.0.0.1", () => {
      const port = (target.address() as AddressInfo).port;
      resolveBase(`http://127.0.0.1:${port}`);
    });
  });
}

function closeServer(target: Server): Promise<void> {
  return new Promise((resolveClose, rejectClose) => {
    target.closeAllConnections();
    target.close((error) => error ? rejectClose(error) : resolveClose());
  });
}

function closeServerWithoutForcingConnections(target: Server): Promise<void> {
  return new Promise((resolveClose, rejectClose) => {
    target.close((error) => error ? rejectClose(error) : resolveClose());
  });
}

async function openPartialJsonPost(target: Server, baseUrl: string, path: string): Promise<Socket> {
  let resolveRequest!: (request: IncomingMessage) => void;
  const seen = new Promise<IncomingMessage>((resolveSeen) => { resolveRequest = resolveSeen; });
  const onRequest = (request: IncomingMessage) => {
    if (request.url === path) resolveRequest(request);
  };
  target.on("request", onRequest);
  const baseUrlValue = new URL(baseUrl);
  const socket = createConnection({ host: baseUrlValue.hostname, port: Number(baseUrlValue.port) });
  socket.on("error", () => undefined);
  await new Promise<void>((resolveConnect) => socket.once("connect", resolveConnect));
  socket.write([
    `POST ${path} HTTP/1.1`,
    `Host: ${baseUrlValue.host}`,
    "Content-Type: application/json",
    "Content-Length: 1024",
    "Connection: keep-alive",
    "",
    "{",
  ].join("\r\n"));
  const incoming = await seen;
  target.off("request", onRequest);
  const deadline = Date.now() + 5_000;
  while (incoming.listenerCount("data") === 0) {
    if (Date.now() >= deadline) throw new Error("request body reader did not start");
    await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
  }
  return socket;
}

async function settlesWithin(
  promise: Promise<void>,
  milliseconds: number,
  onTimeout: () => void,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const settled = await Promise.race([
    promise.then(() => true),
    new Promise<false>((resolveTimeout) => {
      timer = setTimeout(() => resolveTimeout(false), milliseconds);
    }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
  if (!settled) {
    onTimeout();
    await promise;
  }
  return settled;
}
