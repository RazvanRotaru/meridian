/**
 * Route behaviour of the pure `createBlueprintServer` factory — exercised over a real socket
 * on an ephemeral port, but never a browser. A throwaway renderer dir keeps the test
 * independent of `copy-renderer` ever having run.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { traceBundleSchema } from "@meridian/core";
import { buildMockOverlay } from "@meridian/core/mock";
import type { GraphArtifact, TraceBundle } from "@meridian/core";
import { createBlueprintServer } from "./server";

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

let rendererRoot: string;
let server: Server;
let base: string;

beforeAll(async () => {
  rendererRoot = writeFakeRenderer();
  server = createBlueprintServer({ artifact, overlay: { kind: "mock" }, preselectedEnv: "staging", rendererRoot });
  base = await listenEphemeral(server);
});

afterAll(() => {
  server.close();
  rmSync(rendererRoot, { recursive: true, force: true });
});

describe("createBlueprintServer", () => {
  it("serves graph and meta as JSON", async () => {
    const graphResponse = await fetch(`${base}/api/graph`);
    const graph = (await graphResponse.json()) as { nodes: unknown[] };
    expect(graphResponse.headers.get("cache-control")).toBe("no-store");
    expect(graph.nodes).toHaveLength(1);

    const metaResponse = await fetch(`${base}/api/meta`);
    expect(metaResponse.headers.get("cache-control")).toBe("no-store");
    expect(await metaResponse.json()).toMatchObject({
      nodeCount: 1,
      hasOverlay: true,
      envs: "*",
      environments: ["demo", "dev", "staging", "prod"],
      telemetrySources: [{
        id: "demo",
        kind: "mock",
        label: "Synthetic demo",
        provenance: "synthetic",
        environments: ["demo", "dev", "staging", "prod"],
        supportsMetrics: true,
        supportsTraces: true,
      }],
    });
  });

  it("serves source-aware and legacy mock overlays for arbitrary explicit environments", async () => {
    expect(await getJson(`${base}/api/overlay?source=demo&env=demo`)).toMatchObject({ kind: "mock", env: "demo" });
    expect(await getJson(`${base}/api/overlay?env=staging`)).toMatchObject({ kind: "mock", env: "staging" });
    expect(await getJson(`${base}/api/overlay?source=demo&env=qa`)).toMatchObject({ kind: "mock", env: "qa" });
    expect(await getJson(`${base}/api/overlay?env=qa`)).toMatchObject({ kind: "mock", env: "qa" });
    expect((await fetch(`${base}/api/overlay`)).status).toBe(400);
    expect((await fetch(`${base}/api/overlay?source=missing&env=demo`)).status).toBe(404);

    const normalized = await getJson(`${base}/api/overlay?source=demo&env=${encodeURIComponent("  qa-west  ")}`);
    expect(normalized).toMatchObject({ kind: "mock", env: "qa-west" });
    const oversized = "x".repeat(257);
    expect((await fetch(`${base}/api/overlay?source=demo&env=${oversized}`)).status).toBe(400);
  });

  it("synthesizes mock request traces for the explicit demo env but 400s a missing env", async () => {
    const response = await fetch(`${base}/api/traces?source=demo&env=demo`);
    const bundle = (await response.json()) as TraceBundle;
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(bundle).toMatchObject({
      traceVersion: "1.0.0",
      source: "mock",
      env: "demo",
      traces: expect.any(Array),
    });
    expect(traceBundleSchema.safeParse(bundle).success).toBe(true);
    expect(bundle.traces.length).toBeGreaterThanOrEqual(12);
    expect(await getJson(`${base}/api/traces?source=demo&env=${encodeURIComponent("  qa-west  ")}`))
      .toMatchObject({ source: "mock", env: "qa-west" });
    expect((await fetch(`${base}/api/traces?source=demo&env=${"x".repeat(257)}`)).status).toBe(400);
    const missing = await fetch(`${base}/api/traces`);
    expect(missing.status).toBe(400);
    expect(missing.headers.get("cache-control")).toBe("no-store");
  });

  it("keeps source-less no-overlay requests disabled while advertising the explicit built-in demo", async () => {
    const emptyServer = createBlueprintServer({
      artifact,
      overlay: { kind: "none" },
      preselectedEnv: null,
      rendererRoot,
    });
    const emptyBase = await listenEphemeral(emptyServer);
    try {
      const response = await fetch(`${emptyBase}/api/traces?env=qa`);
      expect(response.status).toBe(404);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toMatchObject({ error: expect.stringContaining("qa") });

      const meta = await getJson<{ hasOverlay: boolean; environments: string[]; telemetrySources: Array<{ id: string; environments: string[] }> }>(`${emptyBase}/api/meta`);
      expect(meta).toMatchObject({
        hasOverlay: false,
        environments: [],
        telemetrySources: [{ id: "demo", environments: ["demo"] }],
      });
      const demo = await fetch(`${emptyBase}/api/traces?source=demo&env=demo`);
      expect(demo.status).toBe(200);
      expect(await demo.json()).toMatchObject({ source: "mock", env: "demo", traces: expect.any(Array) });
    } finally {
      await closeServer(emptyServer);
    }
  });

  it("capability-gates request traces for a metrics-only file source", async () => {
    const fileServer = createBlueprintServer({
      artifact,
      overlay: { kind: "file", overlay: buildMockOverlay(artifact, "staging") },
      preselectedEnv: "staging",
      rendererRoot,
    });
    const fileBase = await listenEphemeral(fileServer);
    try {
      const wrongEnv = await fetch(`${fileBase}/api/traces?env=prod`);
      expect(wrongEnv.status).toBe(404);
      expect(wrongEnv.headers.get("cache-control")).toBe("no-store");

      const meta = await getJson<{ telemetrySources: Array<{ id: string; kind: string; environments: string[] }> }>(`${fileBase}/api/meta`);
      expect(meta.telemetrySources).toMatchObject([
        { id: "demo", kind: "mock", environments: ["demo"] },
        { id: "configured", kind: "file", environments: ["staging"] },
      ]);

      const response = await fetch(`${fileBase}/api/traces?source=configured&env=staging`);
      expect(response.status).toBe(404);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toMatchObject({ error: expect.stringContaining("no request traces") });
      expect((await fetch(`${fileBase}/api/traces?env=staging`)).status).toBe(404);
      const demo = await fetch(`${fileBase}/api/traces?source=demo&env=demo`);
      expect(demo.status).toBe(200);
      expect(await demo.json()).toMatchObject({ source: "mock", env: "demo", traces: expect.any(Array) });
      expect((await fetch(`${fileBase}/api/traces?source=demo&env=staging`)).status).toBe(404);
      const html = await (await fetch(`${fileBase}/`)).text();
      expect(html).toContain('"preselectedTelemetrySourceId":"configured"');
      expect(html).toContain('"id":"configured","kind":"file"');
    } finally {
      await closeServer(fileServer);
    }
  });

  it("injects the boot contract into index.html and never defaults env", async () => {
    const html = await (await fetch(`${base}/`)).text();
    expect(html).toContain('window.__MERIDIAN__=');
    expect(html).toContain('"traceUrl":"/api/traces"');
    expect(html).toContain('"telemetrySources":[{"id":"demo"');
    expect(html).toContain('"preselectedTelemetrySourceId":"demo"');
    expect(html).toContain('"preselectedEnv":"staging"');
    expect(html).toContain('"defaultEnv":null');
    expect(html).toContain('"githubSource":false');
  });

  it("serves real assets and falls back to index for unknown routes", async () => {
    const asset = await fetch(`${base}/assets/app.js`);
    expect(asset.headers.get("content-type")).toContain("javascript");
    const fallback = await fetch(`${base}/some/spa/route`);
    expect(fallback.headers.get("content-type")).toContain("html");
  });

  it("survives malformed percent-encoding instead of crashing the process", async () => {
    const malformed = await fetch(`${base}/%E0%A4`);
    expect(malformed.status).toBe(200); // falls back to index, not an unhandled URIError
    expect((await fetch(`${base}/api/meta`)).status).toBe(200); // server is still alive
  });
});

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
  return new Promise((resolve, reject) => {
    target.close((error) => error ? reject(error) : resolve());
  });
}
