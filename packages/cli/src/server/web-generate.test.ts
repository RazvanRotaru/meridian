/**
 * `/api/generate` content negotiation: existing callers keep the one-shot JSON response while the
 * landing page can opt into an NDJSON stream whose stages bracket the real source/extract work.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createWebServer } from "./web-server";

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const WEB_UI = fileURLToPath(new URL("../../web-ui/index.html", import.meta.url));
const SOURCE = join(REPO_ROOT, "examples", "checkout-web");

interface GenerateLine {
  stage: "source" | "extract" | "done" | "error";
  id?: string;
  message?: string;
  counts?: { nodes: number; edges: number };
}

let rendererRoot: string;
let server: Server;
let base: string;

beforeAll(async () => {
  rendererRoot = writeFakeRenderer();
  server = createWebServer({ rendererRoot, webUiPath: WEB_UI, cwd: REPO_ROOT });
  base = await listenEphemeral(server);
});

afterAll(() => {
  server.close();
  rmSync(rendererRoot, { recursive: true, force: true });
});

describe("POST /api/generate response formats", () => {
  it("streams source -> extract -> done when NDJSON is requested", async () => {
    const response = await postGenerate({ kind: "path", value: SOURCE }, "application/x-ndjson");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/x-ndjson");
    const lines = parseLines(await response.text());
    expect(lines.map((line) => line.stage)).toEqual(["source", "extract", "done"]);

    const done = lines.at(-1)!;
    expect(done.id).toBeTypeOf("string");
    expect(done.counts?.nodes).toBeGreaterThan(0);
    expect((await fetch(`${base}/api/graph?id=${done.id}`)).status).toBe(200);
  }, 60_000);

  it("streams an error after the last stage that actually started", async () => {
    const missing = join(REPO_ROOT, "examples", "not-a-real-source");
    const response = await postGenerate({ kind: "path", value: missing }, "application/x-ndjson");
    const lines = parseLines(await response.text());

    expect(lines.map((line) => line.stage)).toEqual(["source", "error"]);
    expect(lines.at(-1)?.message).toContain("local path is not a directory");
  });

  it("preserves the original one-shot JSON response without the NDJSON Accept header", async () => {
    const response = await postGenerate({ kind: "path", value: SOURCE });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    const result = (await response.json()) as { id?: string; stage?: string; counts?: { nodes: number } };
    expect(result.stage).toBeUndefined();
    expect(result.id).toBeTypeOf("string");
    expect(result.counts?.nodes).toBeGreaterThan(0);
  }, 60_000);
});

function postGenerate(body: unknown, accept?: string): Promise<Response> {
  return fetch(`${base}/api/generate`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(accept ? { accept } : {}) },
    body: JSON.stringify(body),
  });
}

function parseLines(body: string): GenerateLine[] {
  return body
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as GenerateLine);
}

function writeFakeRenderer(): string {
  const dir = mkdtempSync(join(tmpdir(), "blueprint-web-generate-"));
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
