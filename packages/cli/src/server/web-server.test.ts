/**
 * Route behaviour of the pure `createWebServer` factory over a real socket (never a browser).
 *
 * The generate path runs the real extractor against the bundled `examples/` trees — offline and
 * deterministic — so this doubles as the no-network smoke test: path -> id -> graph -> /view.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { request as httpRequest } from "node:http";
import { createWebServer } from "./web-server";

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const WEB_UI = fileURLToPath(new URL("../../web-ui/index.html", import.meta.url));
const TS_EXAMPLE = join(REPO_ROOT, "examples", "orders-service");
const PY_EXAMPLE = join(REPO_ROOT, "examples", "orders-service-py");

interface GenerateResult {
  id: string;
  target: string;
  counts: { nodes: number; edges: number };
  warnings: string[];
}

let rendererRoot: string;
let server: Server;
let base: string;

beforeAll(async () => {
  rendererRoot = writeFakeRenderer();
  server = createWebServer({ rendererRoot, webUiPath: WEB_UI, cwd: REPO_ROOT, source: "sindresorhus/type-fest" });
  base = await listenEphemeral(server);
});

afterAll(() => {
  server.close();
  rmSync(rendererRoot, { recursive: true, force: true });
});

describe("createWebServer landing + errors", () => {
  it("serves the landing page with the injected CLI prefill", async () => {
    const html = await (await fetch(`${base}/`)).text();
    expect(html).toContain("Map any codebase");
    expect(html).toContain("window.__MERIDIAN_PREFILL__=");
    expect(html).toContain("sindresorhus/type-fest");
  });

  it("400s malformed generate input without touching the network", async () => {
    const bad = await post("/api/generate", { kind: "github", value: "not a repo!!" });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error?: string }).error).toBeTruthy();

    const missing = await post("/api/generate", { kind: "path" });
    expect(missing.status).toBe(400);
  });

  it("404s an unknown graph id", async () => {
    expect((await fetch(`${base}/api/graph?id=nope`)).status).toBe(404);
    expect((await fetch(`${base}/view?id=nope`)).status).toBe(404);
  });
});

describe("createWebServer generate -> view (offline path source)", () => {
  it("extracts a TypeScript tree and serves a per-id boot contract", async () => {
    const result = (await (await post("/api/generate", { kind: "path", value: TS_EXAMPLE })).json()) as GenerateResult;
    expect(result.counts.nodes).toBeGreaterThanOrEqual(25);
    expect(result.target).toBe(TS_EXAMPLE);

    const graph = await getJson<{ schemaVersion: string; nodes: unknown[] }>(`${base}/api/graph?id=${result.id}`);
    expect(graph.schemaVersion).toBeTruthy();
    expect(graph.nodes.length).toBe(result.counts.nodes);

    const meta = await getJson<{ hasOverlay: boolean; environments: unknown[] }>(`${base}/api/meta?id=${result.id}`);
    expect(meta).toMatchObject({ hasOverlay: false, environments: [] });

    const view = await (await fetch(`${base}/view?id=${result.id}`)).text();
    expect(view).toContain("window.__MERIDIAN__=");
    expect(view).toContain(`"graphUrl":"/api/graph?id=${result.id}"`);
    expect(view).toContain('"hasOverlay":false');
    expect(view).toContain('"defaultEnv":null');
  }, 60_000);

  it("auto-detects Python for a pyproject tree", async () => {
    const result = (await (await post("/api/generate", { kind: "path", value: PY_EXAMPLE })).json()) as GenerateResult;
    expect(result.counts.nodes).toBeGreaterThanOrEqual(25);
    const graph = await getJson<{ target: { language: string } }>(`${base}/api/graph?id=${result.id}`);
    expect(graph.target.language).toBe("python");
  }, 60_000);
});

describe("createWebServer auth routes (sign-in not configured)", () => {
  it("reports sign-in disabled and no session", async () => {
    const data = await getJson<{ configured: boolean; signedIn: boolean }>(`${base}/api/auth/session`);
    expect(data).toMatchObject({ configured: false, signedIn: false });
  });

  it("injects the disabled auth config into the landing page", async () => {
    const html = await (await fetch(`${base}/`)).text();
    expect(html).toContain('window.__MERIDIAN_AUTH__={"configured":false}');
  });

  it("401s auth status and repo search without a session", async () => {
    expect((await fetch(`${base}/api/auth/status`)).status).toBe(401);
    expect((await fetch(`${base}/api/repos/search?q=ky`)).status).toBe(401);
  });

  it("400s device start when no client id is configured", async () => {
    expect((await post("/api/auth/device", {})).status).toBe(400);
  });

  it("415s a POST without a JSON content type", async () => {
    const res = await fetch(`${base}/api/auth/device`, { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" });
    expect(res.status).toBe(415);
  });

  it("403s a cross-origin API request", async () => {
    expect(await statusWithOrigin("/api/auth/session", "http://evil.example")).toBe(403);
  });

  it("404s an unknown /api path as JSON, never the SPA fallback", async () => {
    const res = await fetch(`${base}/api/nope`);
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/json");
  });
});

describe("createWebServer with sign-in configured", () => {
  let configuredRoot: string;
  let configured: Server;
  let configuredBase: string;

  beforeAll(async () => {
    configuredRoot = writeFakeRenderer();
    configured = createWebServer({ rendererRoot: configuredRoot, webUiPath: WEB_UI, cwd: REPO_ROOT, githubClientId: "Iv1.test" });
    configuredBase = await listenEphemeral(configured);
  });

  afterAll(() => {
    configured.close();
    rmSync(configuredRoot, { recursive: true, force: true });
  });

  it("advertises sign-in as configured without any network call", async () => {
    const data = (await (await fetch(`${configuredBase}/api/auth/session`)).json()) as { configured: boolean };
    expect(data.configured).toBe(true);
  });

  it("injects configured:true into the landing page", async () => {
    const html = await (await fetch(`${configuredBase}/`)).text();
    expect(html).toContain('window.__MERIDIAN_AUTH__={"configured":true}');
  });
});

function statusWithOrigin(path: string, origin: string): Promise<number> {
  return new Promise((resolveStatus) => {
    const req = httpRequest(`${base}${path}`, { headers: { origin } }, (res) => {
      res.resume();
      resolveStatus(res.statusCode ?? 0);
    });
    req.end();
  });
}

async function post(path: string, body: unknown): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function getJson<T = Record<string, unknown>>(url: string): Promise<T> {
  return (await (await fetch(url)).json()) as T;
}

function writeFakeRenderer(): string {
  const dir = mkdtempSync(join(tmpdir(), "blueprint-web-renderer-"));
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
