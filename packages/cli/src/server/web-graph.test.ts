import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SCHEMA_VERSION } from "@meridian/core";
import type { GraphArtifact } from "@meridian/core";
import type { ExtractionWorkerResult } from "./extraction-worker";
import { handleGenerate, sendMeta, sendProjectionManifest, sendView } from "./web-graph";
import { InspectionScheduler } from "./inspection-scheduler";
import { SessionStore } from "./session";
import type { Context } from "./web-server";
import { cachedRemoteGraph } from "./web-cache";
import type { CachedGraph } from "./web-cache";
import { graphSummaryFor, InspectionSnapshotStore } from "./inspection-snapshot-store";
import { GRAPH_PROJECTION_DIRECTORY, writeGraphProjectionBundle } from "./graph-projection-bundle";

vi.mock("./web-cache", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./web-cache")>();
  return { ...actual, cachedRemoteGraph: vi.fn() };
});

const testCacheRoots: string[] = [];

afterEach(() => {
  vi.mocked(cachedRemoteGraph).mockReset();
  for (const root of testCacheRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("/api/generate lifecycle admission", () => {
  it("rejects overload before committing a streaming 200 response", async () => {
    const gate = deferred<unknown>();
    const ctx = generationContext();
    ctx.generationScheduler = new InspectionScheduler({
      concurrency: 1,
      maxQueued: 0,
      execute: ({ input, signal, reportProgress }) => input.run(signal, reportProgress),
    });
    const busy = ctx.generationScheduler.schedule("busy", { run: () => gate.promise });
    await flushMicrotasks();
    const request = generateRequest({ accept: "application/x-ndjson" });
    const response = capturedResponse();

    await expect(handleGenerate(ctx, request, response.value)).rejects.toMatchObject({ status: 429 });
    expect(response.writeHead).not.toHaveBeenCalled();
    expect(response.setHeader).toHaveBeenCalledWith("retry-after", "5");
    expect(ctx.runExtraction).not.toHaveBeenCalled();

    gate.resolve(undefined);
    await busy;
  });

  it("propagates the last subscriber disconnect into the local extraction worker", async () => {
    const ctx = generationContext();
    let workerSignal: AbortSignal | undefined;
    ctx.runExtraction = vi.fn((_request, options) => {
      workerSignal = options?.signal;
      return new Promise<ExtractionWorkerResult>((_resolve, reject) => {
        workerSignal?.addEventListener("abort", () => reject(workerSignal?.reason), { once: true });
      });
    });
    const request = generateRequest();
    const response = capturedResponse();
    const pending = handleGenerate(ctx, request, response.value);
    await vi.waitFor(() => expect(workerSignal).toBeDefined());

    request.emit("aborted");
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(workerSignal?.aborted).toBe(true);
    expect(response.writeHead).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(ctx.generationScheduler.counts).toEqual({ queued: 0, running: 0 }));
  });

  it("rejects retired local language selectors before scheduling extraction", async () => {
    const ctx = generationContext(2);
    ctx.runExtraction = vi.fn();
    const typescriptResponse = capturedResponse();
    const pythonResponse = capturedResponse();

    await expect(handleGenerate(
      ctx,
      generateRequest({}, { kind: "path", value: ".", lang: "typescript" }),
      typescriptResponse.value,
    )).rejects.toMatchObject({ status: 400 });
    await expect(handleGenerate(
      ctx,
      generateRequest({}, { kind: "path", value: ".", lang: "python" }),
      pythonResponse.value,
    )).rejects.toMatchObject({ status: 400 });
    expect(ctx.runExtraction).not.toHaveBeenCalled();
  });

  it("observes a rejected progress write and cancels its streaming subscription", async () => {
    const ctx = generationContext();
    let workerSignal: AbortSignal | undefined;
    ctx.runExtraction = vi.fn((_request, options) => {
      workerSignal = options?.signal;
      return new Promise<ExtractionWorkerResult>((_resolve, reject) => {
        if (workerSignal?.aborted) {
          reject(workerSignal.reason);
          return;
        }
        workerSignal?.addEventListener("abort", () => reject(workerSignal?.reason), { once: true });
      });
    });
    const request = generateRequest({ accept: "application/x-ndjson" });
    const response = capturedResponse({ writeError: new Error("socket closed") });

    await expect(handleGenerate(ctx, request, response.value)).resolves.toBeUndefined();

    expect(workerSignal?.aborted).toBe(true);
    expect(response.write).toHaveBeenCalled();
    expect(response.end).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(ctx.generationScheduler.counts).toEqual({ queued: 0, running: 0 }));
  });

  it("normalizes server refresh identity so one subscriber can leave shared remote work safely", async () => {
    const ctx = generationContext(2);
    ctx.refreshCache = true;
    ctx.cacheRoot = "/tmp/meridian-generation-test";
    ctx.inspectionSnapshots = { publish: vi.fn() } as unknown as Context["inspectionSnapshots"];
    const cached = deferred<CachedGraph>();
    let executorSignal: AbortSignal | undefined;
    vi.mocked(cachedRemoteGraph).mockImplementation((options) => {
      executorSignal = options.signal;
      return cached.promise;
    });
    const schedule = vi.spyOn(ctx.generationScheduler, "schedule");
    const firstRequest = generateRequest({}, { kind: "github", value: "owner/repo" });
    const secondRequest = generateRequest({}, { kind: "github", value: "owner/repo", refresh: true });
    const firstResponse = capturedResponse();
    const secondResponse = capturedResponse();

    const firstPending = handleGenerate(ctx, firstRequest, firstResponse.value);
    const secondPending = handleGenerate(ctx, secondRequest, secondResponse.value);
    await vi.waitFor(() => expect(schedule).toHaveBeenCalledTimes(2));

    expect(schedule.mock.calls[0]?.[0]).toBe(schedule.mock.calls[1]?.[0]);
    expect(cachedRemoteGraph).toHaveBeenCalledTimes(1);
    firstRequest.emit("aborted");
    await expect(firstPending).rejects.toMatchObject({ name: "AbortError" });
    expect(executorSignal?.aborted).toBe(false);

    cached.resolve(cachedGraph());
    await expect(secondPending).resolves.toBeUndefined();
    expect(responseJson<{ id: string }>(secondResponse).id).toHaveLength(24);
    expect(cachedRemoteGraph).toHaveBeenCalledTimes(1);
  });
});

describe("immutable graph transport", () => {
  it("serves meta/view from descriptors and projections without rehydrating the complete artifact", async () => {
    const cacheRoot = mkdtempSync(join(tmpdir(), "meridian-web-graph-stream-"));
    try {
      const generation = join(cacheRoot, "generations", "one");
      const sourceRoot = join(generation, "repo");
      const artifactPath = join(generation, "artifact.json");
      mkdirSync(sourceRoot, { recursive: true });
      const raw = "{ intentionally-not-parsed-by-the-web-parent }\n";
      writeFileSync(artifactPath, raw, "utf8");
      writeGraphProjectionBundle(join(generation, GRAPH_PROJECTION_DIRECTORY), artifactFor("typescript"));
      const store = new InspectionSnapshotStore({ cacheRoot });
      const summary = graphSummaryFor(artifactFor("typescript"));
      store.publish({
        id: "immutable-one",
        artifactPath,
        graphSummary: summary,
        sourceRoot,
        source: { kind: "other" },
      });
      store.clearMemoryCache();
      const forbiddenLoad = vi.fn(() => { throw new Error("full graph rehydration is forbidden"); });
      Object.assign(store, { loadArtifact: forbiddenLoad });
      const ctx = generationContext();
      ctx.inspectionSnapshots = store;
      ctx.rendererIndex = "<!doctype html><head></head><body></body>";

      const metaResponse = writableResponse();
      sendMeta(ctx, metaResponse.value, "immutable-one");
      await once(metaResponse.value, "finish");
      expect(JSON.parse(metaResponse.body())).toMatchObject({
        schemaVersion: summary.schemaVersion,
        generatedAt: summary.generatedAt,
        nodeCount: summary.nodeCount,
        hasOverlay: false,
      });

      const viewResponse = writableResponse();
      sendView(ctx, viewResponse.value, "immutable-one");
      await once(viewResponse.value, "finish");
      expect(viewResponse.body()).toContain("/api/graph/manifest?id=immutable-one");
      expect(viewResponse.body()).toContain("/api/graph/projection?id=immutable-one");
      expect(viewResponse.body()).not.toContain('"graphUrl"');

      const manifestResponse = writableResponse();
      sendProjectionManifest(ctx, manifestResponse.value, "immutable-one");
      await once(manifestResponse.value, "finish");
      expect(JSON.parse(manifestResponse.body()).defaultView).toEqual({
        view: "modules",
        filePaths: [],
        focusIds: [],
        expandedIds: [],
        extraIds: [],
        depth: 1,
        radius: 0,
        includeTests: false,
      });
      expect(forbiddenLoad).not.toHaveBeenCalled();
      expect(store.cacheStats().artifactEntries).toBe(0);
    } finally {
      rmSync(cacheRoot, { recursive: true, force: true });
    }
  });
});

function generationContext(concurrency = 1): Context {
  const generationScheduler = new InspectionScheduler<string, {
    run(signal: AbortSignal, reportProgress: (stage: string) => void): Promise<unknown>;
  }, unknown, string>({
    concurrency,
    maxQueued: concurrency,
    execute: ({ input, signal, reportProgress }) => input.run(signal, reportProgress),
  });
  return {
    localGraphFiles: new Map(),
    sourceRoots: new Map(),
    sources: new Map(),
    prFilesCache: new Map(),
    tempCleanups: new Set(),
    generationScheduler,
    runExtraction: vi.fn(),
    cacheRoot: testCacheRoot(),
    cwd: process.cwd(),
    sessions: new SessionStore(),
    refreshCache: false,
  } as unknown as Context;
}

function generateRequest(
  headers: Record<string, string> = {},
  body: Record<string, unknown> = { kind: "path", value: "." },
): IncomingMessage {
  return Object.assign(
    Readable.from([Buffer.from(JSON.stringify(body))]),
    { headers },
  ) as unknown as IncomingMessage;
}

function capturedResponse(options: { writeError?: Error } = {}): {
  value: ServerResponse;
  writeHead: ReturnType<typeof vi.fn>;
  setHeader: ReturnType<typeof vi.fn>;
  write: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
} {
  const emitter = new EventEmitter();
  const writeHead = vi.fn();
  const setHeader = vi.fn();
  const write = vi.fn((_chunk: unknown, callback?: (error?: Error | null) => void) => {
    callback?.(options.writeError ?? null);
    return options.writeError === undefined;
  });
  const end = vi.fn();
  const value = Object.assign(emitter, {
    writableEnded: false,
    writeHead,
    setHeader,
    write,
    end,
  }) as unknown as ServerResponse;
  return { value, writeHead, setHeader, write, end };
}

function writableResponse(): {
  value: ServerResponse;
  status(): number;
  headers(): Record<string, string | number>;
  body(): string;
} {
  const chunks: Buffer[] = [];
  let status = 0;
  let headers: Record<string, string | number> = {};
  const value = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      callback();
    },
  }) as Writable & { writeHead(code: number, values?: Record<string, string | number>): Writable };
  value.writeHead = (code, values = {}) => {
    status = code;
    headers = values;
    return value;
  };
  return {
    value: value as unknown as ServerResponse,
    status: () => status,
    headers: () => headers,
    body: () => Buffer.concat(chunks).toString("utf8"),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function responseJson<T>(response: ReturnType<typeof capturedResponse>): T {
  const body = response.end.mock.calls.find((call) => typeof call[0] === "string")?.[0];
  if (typeof body !== "string") throw new Error("response did not contain a JSON body");
  return JSON.parse(body) as T;
}

function artifactFor(language: string): GraphArtifact {
  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: "2026-07-14T00:00:00.000Z",
    generator: { name: "meridian-test", version: "0.0.0" },
    target: { name: "test", root: ".", language },
    nodes: [],
    edges: [],
  };
}

function testCacheRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "meridian-web-graph-test-"));
  testCacheRoots.push(root);
  return root;
}

function cachedGraph(): CachedGraph {
  const artifact = artifactFor("typescript");
  return {
    analysisKey: "analysis-key",
    artifactPath: "/tmp/meridian-generation-test/artifact.json",
    projectionDirectory: "/tmp/meridian-generation-test/graph-projections",
    graphSummary: graphSummaryFor(artifact),
    cache: "miss",
    checkout: {
      branch: "main",
      cache: "hit",
      commit: "a".repeat(40),
      repoDir: "/tmp/meridian-generation-test/repo",
      repositoryKey: "repository-key",
      remoteUrl: "https://github.com/owner/repo.git",
    },
    sourceDir: "/tmp/meridian-generation-test/repo",
    generationId: "generation-id",
    target: "owner/repo",
    warnings: [],
  };
}
