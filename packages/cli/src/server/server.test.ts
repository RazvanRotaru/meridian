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
import type { GraphArtifact } from "@meridian/core";
import { createBlueprintServer } from "./server";

const artifact: GraphArtifact = {
  schemaVersion: "1.0.0",
  generatedAt: "2026-01-01T00:00:00.000Z",
  generator: { name: "blueprint", version: "test" },
  target: { name: "fixture", root: ".", language: "typescript" },
  telemetry: { joinKey: "node.id", requiredRuntimeAttributes: ["service.name"], serviceDefaulting: "forbidden" },
  nodes: [{ id: "ts:src/a.ts", kind: "module", qualifiedName: "a", displayName: "a", location: { file: "src/a.ts", startLine: 1 } }],
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
    const graph = await getJson<{ nodes: unknown[] }>(`${base}/api/graph`);
    expect(graph.nodes).toHaveLength(1);
    expect(await getJson(`${base}/api/meta`)).toMatchObject({ nodeCount: 1, hasOverlay: true, envs: "*" });
  });

  it("synthesizes a mock overlay for any requested env but 400s a missing env", async () => {
    expect(await getJson(`${base}/api/overlay?env=qa`)).toMatchObject({ kind: "mock", env: "qa" });
    expect((await fetch(`${base}/api/overlay`)).status).toBe(400);
  });

  it("injects the boot contract into index.html and never defaults env", async () => {
    const html = await (await fetch(`${base}/`)).text();
    expect(html).toContain('window.__MERIDIAN__=');
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
