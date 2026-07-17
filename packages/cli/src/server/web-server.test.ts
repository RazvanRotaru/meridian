/**
 * Route behaviour of the pure `createWebServer` factory over a real socket (never a browser).
 *
 * The generate path runs the real extractor against the bundled `examples/` trees — offline and
 * deterministic — so this doubles as the no-network smoke test: path -> id -> graph -> /view.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { request as httpRequest } from "node:http";
import { Readable } from "node:stream";
import { EventEmitter } from "node:events";
import { createWebServer, handleSyntheticExecution } from "./web-server";
import { defaultGraphProjectionRequest } from "./graph-projection-bundle";
import type { Context, WebServerHandle } from "./web-server";
import type { GraphCapabilityHandle } from "./graph-capability-store";
import { removeEntry } from "./web-cache-storage";

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

interface ProjectionEnvelope {
  artifact: {
    schemaVersion: string;
    target: { language: string };
    nodes: Array<{ id: string; kind: string; parentId?: string | null }>;
    edges: Array<{ kind: string; resolution?: string; target: string }>;
  };
}

let rendererRoot: string;
let server: WebServerHandle;
let base: string;

beforeAll(async () => {
  rendererRoot = writeFakeRenderer();
  server = createWebServer({
    rendererRoot,
    webUiPath: WEB_UI,
    cwd: REPO_ROOT,
    source: "sindresorhus/type-fest",
    allowSyntheticExecution: true,
    cacheRoot: join(rendererRoot, "cache"),
  });
  base = await listenEphemeral(server.server);
});

afterAll(async () => {
  await server.close();
  removeEntry(rendererRoot);
});

describe("createWebServer landing + errors", () => {
  it("serves the landing page with the injected CLI prefill", async () => {
    const html = await (await fetch(`${base}/`)).text();
    expect(html).toContain("Read your codebase");
    expect(html).toContain("window.__MERIDIAN_PREFILL__=");
    expect(html).toContain("sindresorhus/type-fest");
    expect(html).toContain('id="ref-trigger"');
    expect(html).toContain('id="ref-options"');
    expect(html).toContain("/api/repos/branches?repo=");
    expect(html).toContain('CUSTOM_BRANCH_VALUE = ":custom"');
    expect(html).toContain('id="custom-ref"');
    expect(html).toContain('id="intent-review"');
    expect(html).toContain('id="pr-author-trigger"');
    expect(html).toContain('id="pr-author-options"');
    expect(html).toContain('id="pr-query"');
    expect(html).toContain('role="combobox"');
    expect(html).toContain('aria-controls="pr-results"');
    expect(html).toContain('id="pr-results"');
    expect(html).toContain("/api/repos/pulls?repo=");
    expect(html).toContain('"&view=modules&prn="');
    expect(html).toContain('id="repository-selection"');
    expect(html).toContain('id="selected-repository-name"');
    expect(html).toContain('id="change-repository"');
    expect(html).toContain("Change repository");
    expect(html).toContain('SELECTED_REPOSITORY_STORAGE_KEY = "meridian.selectedRepository"');
    expect(html).toContain("window.localStorage.getItem(SELECTED_REPOSITORY_STORAGE_KEY)");
    expect(html).toContain("window.localStorage.setItem(SELECTED_REPOSITORY_STORAGE_KEY, repository)");
    expect(html).not.toContain("<select");
    expect(html).not.toContain('id="pr-number"');
    expect(html).not.toContain('id="subdir"');
    expect(html).not.toContain("Source subfolder");
    expect(html).not.toContain('$("repo").addEventListener("change"');
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

  it("routes branch discovery and rejects a non-exact repository before touching GitHub", async () => {
    const response = await fetch(`${base}/api/repos/branches?repo=${encodeURIComponent("search words")}`);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "repository must be owner/repo or a github.com URL" });
  });

  it("routes repository PR discovery and validates its exact query before touching GitHub", async () => {
    const response = await fetch(`${base}/api/repos/pulls?repo=org%2Frepo&state=all&page=1`);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "state must be 'open' or 'closed'" });
  });

  it("404s an unknown graph id", async () => {
    expect((await fetch(`${base}/api/graph/manifest?id=nope`)).status).toBe(404);
    expect((await fetch(`${base}/view?id=nope`)).status).toBe(404);
  });

  it("wires only strict POST /api/pr/prepare and removes the legacy analyze route", async () => {
    const badRef = await post("/api/pr/prepare", {
      owner: "org", repo: "repo", prNumber: 1, baseRef: "--evil", headRef: "x",
    });
    expect(badRef.status).toBe(400);
    const legacyField = await post("/api/pr/prepare", {
      id: "nope", owner: "org", repo: "repo", prNumber: 1, baseRef: "main", headRef: "x",
    });
    expect(legacyField.status).toBe(400);
    expect((await post("/api/pr/analyze", {})).status).toBe(404);
  });
});

describe("createWebServer generate -> view (offline path source)", () => {
  it("extracts a TypeScript tree and serves a per-id boot contract", async () => {
    const result = (await (await post("/api/generate", { kind: "path", value: TS_EXAMPLE })).json()) as GenerateResult;
    expect(result.counts.nodes).toBeGreaterThanOrEqual(25);
    expect(result.target).toBe(TS_EXAMPLE);

    const manifest = await getJson<{ graphId: string; graphSummary: { nodeCount: number } }>(
      `${base}/api/graph/manifest?id=${result.id}`,
    );
    expect(manifest).toMatchObject({ graphId: result.id, graphSummary: { nodeCount: result.counts.nodes } });
    const projection = await projectionFor(result.id, { depth: 1 });
    expect(projection.artifact.schemaVersion).toBeTruthy();
    expect(projection.artifact.nodes.length).toBeGreaterThan(0);
    expect(projection.artifact.nodes.length).toBeLessThanOrEqual(result.counts.nodes);

    const meta = await getJson<{
      hasOverlay: boolean;
      environments: unknown[];
      telemetrySources: Array<{ id: string }>;
      syntheticExecutionUrl: string | null;
      syntheticScenarios: Array<{ id: string }>;
      syntheticExecutionTrust: { mode: string } | null;
    }>(`${base}/api/meta?id=${result.id}`);
    expect(meta).toMatchObject({
      hasOverlay: false,
      environments: [],
      telemetrySources: [{ id: "demo" }],
      syntheticExecutionUrl: `/api/synthetic-executions?id=${result.id}`,
      syntheticExecutionTrust: { mode: "local" },
    });
    expect(meta.syntheticScenarios).toContainEqual(expect.objectContaining({ id: "place-order-happy" }));

    const view = await (await fetch(`${base}/view?id=${result.id}`)).text();
    expect(view).toContain("window.__MERIDIAN__=");
    expect(view).toContain(`"overlayUrl":"/api/overlay?id=${result.id}"`);
    expect(view).toContain(`"traceUrl":"/api/traces?id=${result.id}"`);
    expect(view).toContain(`"syntheticExecutionUrl":"/api/synthetic-executions?id=${result.id}"`);
    expect(view).toContain('"id":"place-order-happy"');
    expect(view).toContain(`"projectionGraphId":"${result.id}"`);
    expect(view).toContain(`"projectionManifestUrl":"/api/graph/manifest?id=${result.id}"`);
    expect(view).toContain(`"projectionUrl":"/api/graph/projection?id=${result.id}"`);
    expect(view).toContain(`"graphSearchUrl":"/api/graph/search?id=${result.id}"`);
    expect(view).not.toContain('"graphUrl"');
    expect(view).toContain('"hasOverlay":false');
    expect(view).toContain('"telemetrySources":[{"id":"demo"');
    expect(view).toContain('"preselectedTelemetrySourceId":null');
    expect(view).toContain('"defaultEnv":null');
    // A path-sourced session has no GitHub identity: the boot contract carries null (a GitHub
    // session carries the {repository, subdir} source object instead of the old boolean).
    expect(view).toContain('"githubSource":null');

    const missingSource = await fetch(`${base}/api/overlay?id=${result.id}&env=demo`);
    expect(missingSource.status).toBe(400);
    expect(await missingSource.json()).toEqual({ error: "source query parameter is required" });

    const missingEnvironment = await fetch(`${base}/api/overlay?id=${result.id}&source=demo`);
    expect(missingEnvironment.status).toBe(400);
    expect(await missingEnvironment.json()).toEqual({ error: "env query parameter is required; blueprint never defaults" });

    const overlay = await getJson<{ kind: string; env: string; graphRef: { nodeCount: number } }>(
      `${base}/api/overlay?id=${result.id}&source=demo&env=demo`,
    );
    expect(overlay).toMatchObject({ kind: "mock", env: "demo", graphRef: { nodeCount: result.counts.nodes } });

    const traces = await getJson<{ source: string; env: string; traces: unknown[] }>(
      `${base}/api/traces?id=${result.id}&source=demo&env=demo`,
    );
    expect(traces).toMatchObject({ source: "mock", env: "demo" });
    expect(traces.traces.length).toBeGreaterThanOrEqual(10);

    const executionResponse = await post(`/api/synthetic-executions?id=${result.id}`, {
      scenarioId: "place-order-happy",
      rootNodeId: "ts:src/services/orderService.ts#OrderService.placeOrder",
      input: {
        customerId: "cust_synthetic",
        lines: [{ sku: "kettle", quantity: 1, unitPriceCents: 10_000 }],
        discountCode: "WELCOME10",
      },
    });
    expect(executionResponse.status).toBe(200);
    expect(await executionResponse.json()).toMatchObject({
      executionVersion: "1.0.0",
      scenarioId: "place-order-happy",
      rootId: "ts:src/services/orderService.ts#OrderService.placeOrder",
      output: { customerId: "cust_synthetic", subtotalCents: 10_000, discountCents: 1_000, totalCents: 10_800 },
      trace: { spans: expect.any(Array) },
      snapshots: expect.any(Array),
    });
  }, 60_000);

  it("auto-detects Python for a pyproject tree", async () => {
    const result = (await (await post("/api/generate", { kind: "path", value: PY_EXAMPLE })).json()) as GenerateResult;
    expect(result.counts.nodes).toBeGreaterThanOrEqual(25);
    const projection = await projectionFor(result.id, { depth: 0 });
    expect(projection.artifact.target.language).toBe("python");
    const view = await (await fetch(`${base}/view?id=${result.id}`)).text();
    expect(view).toContain('"syntheticExecutionUrl":null');
    expect(view).toContain('"syntheticScenarios":[]');
    expect(view).toContain('"syntheticExecutionTrust":null');
  }, 60_000);

  it("keeps and materializes declared external imports for the rendered graph", async () => {
    const root = mkdtempSync(join(tmpdir(), "meridian-web-external-"));
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "package.json"), JSON.stringify({
      name: "web-external-fixture",
      private: true,
      dependencies: { rxjs: "^7.0.0" },
    }));
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify({
      compilerOptions: { target: "ES2022", module: "ESNext", strict: true },
      include: ["src/**/*.ts"],
    }));
    writeFileSync(join(root, "src/store.ts"), [
      "import { BehaviorSubject } from 'rxjs';",
      "export class Store {",
      "  readonly value = new BehaviorSubject(0);",
      "}",
    ].join("\n"));

    try {
      const result = (await (await post("/api/generate", { kind: "path", value: root })).json()) as GenerateResult;
      const graph = (await projectionFor(result.id, { depth: 4, includeTests: true })).artifact;

      expect(graph.nodes).toContainEqual(expect.objectContaining({
        id: "ext:__external__",
        kind: "external",
        parentId: null,
      }));
      expect(graph.nodes).toContainEqual(expect.objectContaining({
        id: "ext:npm/rxjs#BehaviorSubject",
        kind: "external",
        parentId: "ext:__external__",
      }));
      expect(graph.edges).toContainEqual(expect.objectContaining({
        kind: "imports",
        resolution: "external",
        target: "ext:npm/rxjs#BehaviorSubject",
      }));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("requires telemetry requests to identify a generated graph", async () => {
    const res = await fetch(`${base}/api/traces?source=demo&env=demo`);
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ error: "unknown graph id" });
  });

  it("keeps synthetic execution unavailable for unknown or non-local graph ids", async () => {
    const res = await post("/api/synthetic-executions?id=nope", {
      scenarioId: "place-order",
      rootNodeId: "ts:src/services/orderService.ts#OrderService.placeOrder",
      input: {},
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "synthetic execution is not enabled for this graph" });
  });
});

describe("GitHub synthetic execution admission", () => {
  const id = "pr-graph";
  const rootNodeId = "ts:src/api/cartRoutes.ts#CartRoutes.handleAddItem";

  it("denies by default even when stale capability state is present", async () => {
    const { ctx, runInOci } = githubExecutionCtx({ allow: false, runtime: true });
    const result = await invokeSynthetic(ctx, id, false);

    expect(result.status).toBe(404);
    expect(result.json).toEqual({ error: "synthetic execution is not enabled for this graph" });
    expect(runInOci).not.toHaveBeenCalled();
  });

  it("requires explicit per-request sandbox consent after flag and OCI admission", async () => {
    const { ctx, runInOci } = githubExecutionCtx({ allow: true, runtime: true });
    const result = await invokeSynthetic(ctx, id, false);

    expect(result.status).toBe(403);
    expect(result.json).toEqual({ error: "sandbox consent is required for GitHub synthetic execution" });
    expect(runInOci).not.toHaveBeenCalled();
  });

  it("routes an explicitly admitted and consented GitHub run only to the OCI executor", async () => {
    const { ctx, runInOci } = githubExecutionCtx({ allow: true, runtime: true });
    const result = await invokeSynthetic(ctx, id, true);

    expect(result.status).toBe(200);
    expect(result.json).toEqual({ executionVersion: "fixture-oci" });
    expect(runInOci).toHaveBeenCalledWith(expect.objectContaining({
      scenarioId: "add-item",
      expectedRootId: rootNodeId,
      expectedSourceFingerprint: "f".repeat(64),
      artifactPath: "/tmp/pr-artifact.json",
    }));
  });

  it("fails closed when the OCI runtime is unavailable or no scenario is authored", async () => {
    const unavailable = githubExecutionCtx({ allow: true, runtime: false });
    expect((await invokeSynthetic(unavailable.ctx, id, true)).status).toBe(404);

    const empty = githubExecutionCtx({ allow: true, runtime: true, withScenario: false });
    expect((await invokeSynthetic(empty.ctx, id, true)).status).toBe(404);
    expect(unavailable.runInOci).not.toHaveBeenCalled();
    expect(empty.runInOci).not.toHaveBeenCalled();
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

async function projectionFor(
  id: string,
  overrides: Partial<{ depth: number; includeTests: boolean }> = {},
): Promise<ProjectionEnvelope> {
  const response = await post(`/api/graph/projection?id=${id}`, {
    ...defaultGraphProjectionRequest(),
    depth: overrides.depth ?? 1,
    includeTests: overrides.includeTests ?? false,
  });
  expect(response.status).toBe(200);
  return await response.json() as ProjectionEnvelope;
}

function writeFakeRenderer(): string {
  const dir = mkdtempSync(join(tmpdir(), "blueprint-web-renderer-"));
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "index.html"), "<!doctype html><html><head></head><body></body></html>");
  writeFileSync(join(dir, "assets", "app.js"), "export const ready = true;");
  return dir;
}

function githubExecutionCtx(options: { allow: boolean; runtime: boolean; withScenario?: boolean }): {
  ctx: Context;
  runInOci: ReturnType<typeof vi.fn>;
} {
  const rootId = "ts:src/api/cartRoutes.ts#CartRoutes.handleAddItem";
  const runInOci = vi.fn().mockResolvedValue({ executionVersion: "fixture-oci" });
  const withScenario = options.withScenario !== false;
  const source = { kind: "github" as const, owner: "octo", repo: "repo" };
  const scenarios = withScenario ? [{
    id: "add-item",
    label: "Add item",
    rootId,
    defaultInput: {},
  }] : [];
  const trust = {
    mode: "sandboxed-pr" as const,
    provenance: { repository: "octo/repo", headSha: "a".repeat(40) },
  };
  const capability: GraphCapabilityHandle = {
    descriptor: {
      formatVersion: 10,
      id: "prepared-head",
      publishedAt: "2026-07-17T00:00:00.000Z",
      graphSummary: {
        schemaVersion: "1.1.0",
        generatedAt: "2026-07-17T00:00:00.000Z",
        nodeCount: 1,
        edgeCount: 0,
      },
      artifact: {
        path: "artifacts/pr/generations/head/artifact.json",
        projectionPath: "artifacts/pr/generations/head/graph-projection",
        generationPath: "artifacts/pr/generations/head",
        bytes: 1,
        sha256: "a".repeat(64),
        projectionBytes: 1,
        projectionSha256: "b".repeat(64),
        projectionContentId: "c".repeat(64),
        sealSha256: "d".repeat(64),
        revision: { kind: "git", commit: trust.provenance.headSha },
        vcsBranch: "feature/review",
      },
      source: {
        kind: "managed-cache",
        rootPath: "sources/pr",
        subdir: "",
        metadata: source,
        owner: null,
      },
      synthetic: {
        path: "artifacts/pr/generations/head/synthetic-capability.json",
        sha256: "e".repeat(64),
        executionTrust: trust,
      },
      reviewContext: null,
    },
    artifactPath: "/tmp/pr-artifact.json",
    projectionDirectory: "/tmp/pr-projection",
    generationDirectory: "/tmp/pr-generation",
    source: {
      rootDir: "/tmp/pr-source",
      sourceDir: "/tmp/pr-source",
      subdir: "",
      metadata: source,
      owner: null,
    },
    synthetic: {
      capability: {
        version: 1,
        state: scenarios.length > 0 ? "ready" : "absent",
        scenarios,
        sourceFingerprint: scenarios.length > 0 ? "f".repeat(64) : null,
        artifactCommit: trust.provenance.headSha,
        warning: null,
      },
      executionTrust: trust,
    },
    review: null,
    signal: new AbortController().signal,
    renew: async () => {},
    release: async () => {},
  };
  const ctx = {
    shutdownSignal: new AbortController().signal,
    graphCapabilities: { acquire: async () => capability },
    allowSyntheticExecution: false,
    allowSyntheticPrExecution: options.allow,
    syntheticPrSandboxRuntimeSupported: () => options.runtime,
    runSyntheticScenarioFromArtifactFile: vi.fn(),
    runSyntheticScenarioInOci: runInOci,
  } as unknown as Context;
  return { ctx, runInOci };
}

async function invokeSynthetic(ctx: Context, id: string, consent: boolean): Promise<{ status: number; json: unknown }> {
  const headers: Record<string, string> = { host: "127.0.0.1:4180" };
  if (consent) headers["x-meridian-sandbox-consent"] = "true";
  const request = Object.assign(Readable.from([Buffer.from(JSON.stringify({
    scenarioId: "add-item",
    rootNodeId: "ts:src/api/cartRoutes.ts#CartRoutes.handleAddItem",
    input: {},
  }))]), { headers }) as unknown as IncomingMessage;
  let status = 0;
  let body = "";
  const response = Object.assign(new EventEmitter(), {
    writeHead(code: number) {
      status = code;
      return response;
    },
    end(chunk?: unknown) {
      body += chunk === undefined ? "" : String(chunk);
    },
  }) as unknown as ServerResponse;

  await handleSyntheticExecution(ctx, request, response, id);
  return { status, json: JSON.parse(body) as unknown };
}

function listenEphemeral(target: Server): Promise<string> {
  return new Promise((resolveBase) => {
    target.listen(0, "127.0.0.1", () => {
      const port = (target.address() as AddressInfo).port;
      resolveBase(`http://127.0.0.1:${port}`);
    });
  });
}
