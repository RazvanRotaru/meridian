import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { GraphArtifact } from "@meridian/core";
import { sendJson } from "./http-response";
import { WebError } from "./web-error";
import {
  materializeValidatedArtifact,
  WebGraphStore,
  WebGraphStoreCapacityError,
  type WebGraphRegistration,
} from "./web-graph-store";
import type { GraphRetentionOptions } from "./web-graph-retention";
import {
  handleGraphViewCreate,
  handleGraphViewDelete,
  handleGraphViewPut,
} from "./web-graph-views";
import { assertJsonContentType, assertSameOrigin } from "./web-guards";

const ARTIFACT: GraphArtifact = {
  schemaVersion: "1.1.0",
  generatedAt: "2026-07-23T00:00:00.000Z",
  generator: { name: "meridian-test", version: "1" },
  target: { name: "lease-contract", root: ".", language: "typescript" },
  nodes: [],
  edges: [],
};

const servers: Server[] = [];
const stores: WebGraphStore[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    if (server.listening) await closeServer(server);
  }
  for (const store of stores.splice(0)) store.dispose();
});

describe("graph-view lease v1 HTTP contract", () => {
  it("rejects non-JSON media types, non-v1 payloads, and non-exact object shapes", async () => {
    const harness = await startHarness({}, ["base"]);

    const wrongType = await request(harness.base, "POST", "/api/graph-views", {
      version: 1,
      baseGraphId: "base",
      graphIds: ["base"],
    }, "text/plain");
    expect(wrongType.status).toBe(415);
    expect(await wrongType.json()).toEqual({ error: "expected content-type: application/json" });

    const wrongVersion = await post(harness.base, "/api/graph-views", {
      version: 2,
      baseGraphId: "base",
      graphIds: ["base"],
    });
    expect(wrongVersion.status).toBe(400);
    expect(await wrongVersion.json()).toEqual({ error: "unsupported graph view protocol version" });

    const extraCreateKey = await post(harness.base, "/api/graph-views", {
      version: 1,
      baseGraphId: "base",
      graphIds: ["base"],
      compatibilityGraphId: "legacy",
    });
    expect(extraCreateKey.status).toBe(400);
    expect(await extraCreateKey.json()).toEqual({
      error: "graph view body must contain only version, baseGraphId, and graphIds",
    });

    const created = await createLease(harness.base, "base", ["base"]);
    const missingPutKey = await post(harness.base, created.url, { version: 1 }, "PUT");
    expect(missingPutKey.status).toBe(400);
    expect(await missingPutKey.json()).toEqual({
      error: "graph view body must contain only version and graphIds",
    });

    const wrongPutVersion = await put(harness.base, created.url, {
      version: 2,
      graphIds: ["base"],
    });
    expect(wrongPutVersion.status).toBe(400);
    expect(await wrongPutVersion.json()).toEqual({
      error: "unsupported graph view protocol version",
    });

    const extraPutKey = await put(harness.base, created.url, {
      version: 1,
      graphIds: ["base"],
      baseGraphId: "base",
    });
    expect(extraPutKey.status).toBe(400);
    expect(await extraPutKey.json()).toEqual({
      error: "graph view body must contain only version and graphIds",
    });
    expect(harness.store.stats().viewLeases).toBe(1);
  });

  it.each([
    { label: "empty", graphIds: [] },
    { label: "duplicate", graphIds: ["base", "base"] },
    { label: "non-string", graphIds: ["base", 42] },
    { label: "untrimmed", graphIds: ["base", " head"] },
    { label: "too large", graphIds: ["base", "head", "comparison"] },
  ])("rejects an invalid $label selection", async ({ graphIds }) => {
    const harness = await startHarness({ maxIdsPerView: 2 }, ["base", "head", "comparison"]);

    const response = await post(harness.base, "/api/graph-views", {
      version: 1,
      baseGraphId: "base",
      graphIds,
    });

    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ code: "invalid_selection" });
    expect(harness.store.stats().viewLeases).toBe(0);
  });

  it("requires the boot graph in every selection and maps an unavailable base to 410", async () => {
    const harness = await startHarness({}, ["base", "head"]);

    const omitted = await post(harness.base, "/api/graph-views", {
      version: 1,
      baseGraphId: "base",
      graphIds: ["head"],
    });
    expect(omitted.status).toBe(400);
    expect(await omitted.json()).toMatchObject({ code: "invalid_selection" });

    const unavailable = await post(harness.base, "/api/graph-views", {
      version: 1,
      baseGraphId: "missing",
      graphIds: ["missing"],
    });
    expect(unavailable.status).toBe(410);
    expect(await unavailable.json()).toEqual({
      error: "a graph needed by this view is no longer available",
      code: "expired_graph",
    });
  });

  it("maps unknown and expired leases to 410 without creating replacement state", async () => {
    let now = 100;
    const harness = await startHarness({
      now: () => now,
      viewLeaseTtlMs: 10,
      maxIdleMs: 1_000,
    }, ["base"]);

    const unknown = await put(harness.base, `/api/graph-views/${"x".repeat(32)}`, {
      version: 1,
      graphIds: ["base"],
    });
    expect(unknown.status).toBe(410);
    expect(await unknown.json()).toMatchObject({ code: "unknown_lease" });

    const created = await createLease(harness.base, "base", ["base"]);
    now = 110;
    const expired = await put(harness.base, created.url, {
      version: 1,
      graphIds: ["base"],
    });
    expect(expired.status).toBe(410);
    expect(await expired.json()).toEqual({
      error: "the graph view lease has expired",
      code: "unknown_lease",
    });
    expect(harness.store.stats().viewLeases).toBe(0);
  });

  it("returns a retryable 503 when the bounded view registry is full", async () => {
    const harness = await startHarness({ maxViewLeases: 1 }, ["base"]);
    await createLease(harness.base, "base", ["base"]);

    const response = await post(harness.base, "/api/graph-views", {
      version: 1,
      baseGraphId: "base",
      graphIds: ["base"],
    });

    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("5");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      error: "too many active graph views",
      code: "capacity",
    });
    expect(harness.store.stats().viewLeases).toBe(1);
  });

  it("makes DELETE idempotent for an already released well-formed lease", async () => {
    const harness = await startHarness({}, ["base"]);
    const created = await createLease(harness.base, "base", ["base"]);

    const first = await fetch(`${harness.base}${created.url}`, { method: "DELETE" });
    const second = await fetch(`${harness.base}${created.url}`, { method: "DELETE" });

    expect(first.status).toBe(204);
    expect(first.headers.get("cache-control")).toBe("no-store");
    expect(second.status).toBe(204);
    expect(harness.store.stats().viewLeases).toBe(0);
  });

  it("preserves the old pins atomically when PUT cannot resolve the replacement set", async () => {
    let now = 100;
    const harness = await startHarness({
      now: () => now,
      maxIdleMs: 1,
      publicationHandoffTtlMs: 0,
      viewLeaseTtlMs: 1_000,
    }, ["base", "head"]);
    const created = await createLease(harness.base, "base", ["base", "head"]);

    now = 102;
    const failed = await put(harness.base, created.url, {
      version: 1,
      graphIds: ["base", "missing"],
    });
    expect(failed.status).toBe(410);
    expect(await failed.json()).toMatchObject({ code: "expired_graph" });

    harness.store.sweep();
    expect(hasRegistration(harness.store, "base")).toBe(true);
    expect(hasRegistration(harness.store, "head")).toBe(true);
    expect(harness.store.stats().viewLeases).toBe(1);

    const retained = await put(harness.base, created.url, {
      version: 1,
      graphIds: ["base", "head"],
    });
    expect(retained.status).toBe(200);
    expect(await retained.json()).toMatchObject({ version: 1 });
  });
});

interface Harness {
  readonly base: string;
  readonly store: WebGraphStore;
}

async function startHarness(
  options: Partial<GraphRetentionOptions>,
  graphIds: readonly string[],
): Promise<Harness> {
  const store = new WebGraphStore(options);
  stores.push(store);
  for (const graphId of graphIds) store.publish(registration(graphId));
  const server = createServer((request, response) => {
    route(store, request, response).catch((error: unknown) => sendTestError(response, error));
  });
  servers.push(server);
  const base = await listen(server);
  return { base, store };
}

async function route(
  store: WebGraphStore,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  assertSameOrigin(request);
  const path = new URL(request.url ?? "/", "http://localhost").pathname;
  if (request.method === "POST" && path === "/api/graph-views") {
    assertJsonContentType(request);
    await handleGraphViewCreate(store, request, response);
    return;
  }
  const match = /^\/api\/graph-views\/([^/]+)$/.exec(path);
  if (request.method === "PUT" && match !== null) {
    assertJsonContentType(request);
    await handleGraphViewPut(store, request, response, match[1]);
    return;
  }
  if (request.method === "DELETE" && match !== null) {
    handleGraphViewDelete(store, response, match[1]);
    return;
  }
  sendJson(response, 404, { error: "unknown endpoint" });
}

function sendTestError(response: ServerResponse, error: unknown): void {
  if (error instanceof WebError) {
    sendJson(response, error.status, { error: error.message });
    return;
  }
  if (error instanceof WebGraphStoreCapacityError) {
    sendJson(response, 503, { error: error.message }, { "retry-after": "5" });
    return;
  }
  sendJson(response, 500, { error: "internal error" });
}

function registration(id: string): WebGraphRegistration {
  return {
    id,
    material: materializeValidatedArtifact(ARTIFACT),
    metadata: {
      sourceRoot: "/workspace/lease-contract",
      source: { kind: "path" },
      synthetic: { scenarios: [], sourceFingerprint: null, trust: null },
    },
  };
}

function hasRegistration(store: WebGraphStore, id: string): boolean {
  const registration = store.acquire(id);
  registration?.release();
  return registration !== undefined;
}

async function createLease(
  base: string,
  baseGraphId: string,
  graphIds: readonly string[],
): Promise<{ leaseId: string; url: string }> {
  const response = await post(base, "/api/graph-views", {
    version: 1,
    baseGraphId,
    graphIds,
  });
  expect(response.status).toBe(201);
  return await response.json() as { leaseId: string; url: string };
}

function post(
  base: string,
  path: string,
  body: unknown,
  method: "POST" | "PUT" = "POST",
): Promise<Response> {
  return request(base, method, path, body, "application/json");
}

function put(base: string, path: string, body: unknown): Promise<Response> {
  return post(base, path, body, "PUT");
}

function request(
  base: string,
  method: "POST" | "PUT",
  path: string,
  body: unknown,
  contentType: string,
): Promise<Response> {
  return fetch(`${base}${path}`, {
    method,
    headers: { "content-type": contentType },
    body: JSON.stringify(body),
  });
}

function listen(server: Server): Promise<string> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  });
}
