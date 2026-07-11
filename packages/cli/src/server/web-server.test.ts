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
    expect(html).toContain("Read your codebase");
    expect(html).toContain("window.__MERIDIAN_PREFILL__=");
    expect(html).toContain("sindresorhus/type-fest");
  });

  it("ships the staged, accessible blueprint preparation indicator", async () => {
    const html = await (await fetch(`${base}/`)).text();
    expect(html).toContain('id="prepare-progress"');
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain("Fetch repository");
    expect(html).toContain("Generate code graph");
    expect(html).toContain("Open blueprint");
    expect(html).not.toContain("Cloning + analyzing…");
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

  it("wires POST /api/pr/analyze: validates refs, then 404s an unknown session id, before any git", async () => {
    const badRef = await post("/api/pr/analyze", { id: "nope", prNumber: 1, baseRef: "--evil", headRef: "x" });
    expect(badRef.status).toBe(400);
    const unknownId = await post("/api/pr/analyze", { id: "nope", prNumber: 1, baseRef: "main", headRef: "x" });
    expect(unknownId.status).toBe(404);
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
    // A path-sourced session has no GitHub identity: the boot contract carries null (a GitHub
    // session carries the {repository, subdir} source object instead of the old boolean).
    expect(view).toContain('"githubSource":null');
  }, 60_000);

  it("auto-detects Python for a pyproject tree", async () => {
    const result = (await (await post("/api/generate", { kind: "path", value: PY_EXAMPLE })).json()) as GenerateResult;
    expect(result.counts.nodes).toBeGreaterThanOrEqual(25);
    const graph = await getJson<{ target: { language: string } }>(`${base}/api/graph?id=${result.id}`);
    expect(graph.target.language).toBe("python");
  }, 60_000);
});

describe("createWebServer auth routes (sign-in always available)", () => {
  it("reports signed-out identity state without a configuration flag", async () => {
    const data = await getJson<{ signedIn: boolean; user: unknown }>(`${base}/api/auth/session`);
    expect(data).toEqual({ signedIn: false, user: null });
  });

  it("always ships sign-in and no disabled/configured branch", async () => {
    const html = await (await fetch(`${base}/`)).text();
    expect(html).toContain('class="github" id="signin">');
    expect(html).not.toContain("Sign-in is off");
    expect(html).not.toContain("auth-disabled");
    expect(html).not.toContain("__MERIDIAN_AUTH__");
  });

  it("401s auth status and repo listing without a session", async () => {
    expect((await fetch(`${base}/api/auth/status`)).status).toBe(401);
    expect((await fetch(`${base}/api/repos/search?q=ky`)).status).toBe(401);
    expect((await fetch(`${base}/api/repos/mine`)).status).toBe(401);
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
