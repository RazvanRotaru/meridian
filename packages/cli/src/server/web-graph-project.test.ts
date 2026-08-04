import { createHash } from "node:crypto";
import { PassThrough, Writable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { existsSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildNodeId, SCHEMA_VERSION, type GraphArtifact, type GraphProjectionV1 } from "@meridian/core";
import { AnalysisCoordinator } from "./web-analysis-coordinator";
import { OperationCancelledError } from "./web-cancellation";
import {
  beginForegroundGraphWork,
  boundedProvisionalGraphWorkerHeapMb,
  GRAPH_PROJECTION_CACHE_HEADER,
  GRAPH_PROJECTION_KEY_HEADER,
  GRAPH_PROJECTION_READY_HEADER,
  ensureProvisionalSourceIndex,
  handleGraphProject,
  handleGraphProjectWarm,
  handleGraphProjectWarmStatus,
  handleGraphSymbols,
  graphProjectionRootChunks,
  parseGraphProjectionRequest,
  prepareInitialGraphProjectionCache,
} from "./web-graph-project";
import { WebGraphProjectCache, type WebGraphProjectCacheOptions } from "./web-graph-project-cache";
import { runGraphProjectChild } from "./web-graph-project-child";
import {
  artifactSummary,
  materializeValidatedArtifact,
  verifiedArtifactFile,
  WebGraphStore,
  type WebGraphDescriptor,
} from "./web-graph-store";
import type { Context } from "./web-server";
import {
  MAX_GRAPH_PROJECT_OUTPUT_BYTES,
  type GraphProjectWorkerRequest,
  type GraphProjectWorkerResult,
} from "./web-graph-project-worker-job";

const PROVISIONAL_GRAPH_ID = `pr-partial-${"a".repeat(20)}-${"b".repeat(40)}`;
const PROVISIONAL_FILE_ID = buildNodeId({ lang: "ts", modulePath: "a.ts" });

const disposals: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  for (const dispose of disposals.splice(0).reverse()) await dispose();
});

describe("web graph projection route", () => {
  it("validates the canonical discriminated request without accepting client paths", () => {
    expect(parseGraphProjectionRequest(body())).toEqual(body());
    expect(() => parseGraphProjectionRequest({
      ...body(),
      roots: { kind: "changed-files", seedGraphId: "graph", paths: ["src/a.ts"] },
    })).toThrow(/graph projection must be version/);
    expect(() => parseGraphProjectionRequest({ ...body(), requestedDepth: 2, prefetchDepth: 6 }))
      .toThrow(/graph projection must be version/);
    expect(parseGraphProjectionRequest({
      ...body(),
      roots: { kind: "file-paths", paths: ["src/z.ts", "src/a.ts"] },
    })).toEqual({
      ...body(),
      roots: { kind: "file-paths", paths: ["src/a.ts", "src/z.ts"] },
    });
  });

  it("singleflights equal misses, keeps graph pins through work, and serves the immutable cache", async () => {
    let releaseWorker!: () => void;
    const gate = new Promise<void>((resolve) => { releaseWorker = resolve; });
    let projectCalls = 0;
    const harness = createHarness(async (request) => {
      if (request.type === "project") {
        projectCalls += 1;
        await gate;
      }
      return writeWorkerResult(request);
    });
    const first = invoke(harness.ctx, body());
    const second = invoke(harness.ctx, body());
    await vi.waitFor(() => expect(projectCalls).toBe(1));

    // Retention cannot discard the artifact while either waiter owns its request pin.
    harness.graphStore.publish(registration("other", { ...ARTIFACT, generatedAt: "2026-07-31T00:00:01.000Z" }));
    const stillPinned = harness.graphStore.acquire("graph");
    expect(stillPinned).toBeDefined();
    stillPinned?.release();

    releaseWorker();
    const [one, two] = await Promise.all([first, second]);
    expect(one.status).toBe(200);
    expect(two.status).toBe(200);
    expect(one.json).toMatchObject({ graphId: "graph", loadedDepth: 0, rootFileIds: ["m:a"] });
    expect(two.json).toEqual(one.json);
    expect(new Set([
      one.headers[GRAPH_PROJECTION_CACHE_HEADER],
      two.headers[GRAPH_PROJECTION_CACHE_HEADER],
    ])).toEqual(new Set(["miss", "coalesced"]));
    expect(one.headers[GRAPH_PROJECTION_KEY_HEADER]).toMatch(/^[a-f0-9]{64}$/);
    expect(two.headers[GRAPH_PROJECTION_KEY_HEADER]).toBe(one.headers[GRAPH_PROJECTION_KEY_HEADER]);
    expect(one.headers[GRAPH_PROJECTION_READY_HEADER]).toBe("true");
    expect(two.headers[GRAPH_PROJECTION_READY_HEADER]).toBe("true");

    const cached = await invoke(harness.ctx, body());
    expect(cached.status).toBe(200);
    expect(cached.headers[GRAPH_PROJECTION_CACHE_HEADER]).toBe("hit");
    expect(cached.headers[GRAPH_PROJECTION_KEY_HEADER]).toBe(one.headers[GRAPH_PROJECTION_KEY_HEADER]);
    expect(projectCalls).toBe(1);
  });

  it("cancels the shared child when its final HTTP waiter leaves and releases graph ownership", async () => {
    let entered = false;
    let aborted = false;
    const harness = createHarness((request, signal) => {
      if (request.type !== "project") return Promise.resolve(writeWorkerResult(request));
      entered = true;
      return new Promise<GraphProjectWorkerResult>((_resolve, reject) => {
        const onAbort = () => {
          aborted = true;
          reject(signal.reason);
        };
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
      });
    });
    const request = requestFor(body());
    const response = new TestResponse();
    const running = handleGraphProject(harness.ctx, request, response as unknown as ServerResponse);
    await vi.waitFor(() => expect(entered).toBe(true));
    request.emit("aborted");
    await expect(running).rejects.toBeInstanceOf(OperationCancelledError);
    await vi.waitFor(() => expect(aborted).toBe(true));
    expect(harness.cache.stats().pins).toBe(0);
  });

  it("keeps symbol indexes distinct when two graph ids register identical artifact bytes", async () => {
    let symbolCalls = 0;
    const harness = createHarness(async (request) => {
      if (request.type === "symbols") symbolCalls += 1;
      return writeWorkerResult(request);
    }, 2);
    harness.graphStore.publish(registration("copy", ARTIFACT));

    const first = await invokeSymbols(harness.ctx, "graph");
    const copy = await invokeSymbols(harness.ctx, "copy");

    expect(first.json.graphId).toBe("graph");
    expect(copy.json.graphId).toBe("copy");
    expect(symbolCalls).toBe(2);
  });

  it("starts predicted work only after the renderer's explicit post-actionable warm", async () => {
    const calls: GraphProjectWorkerRequest[] = [];
    const harness = createHarness(async (request) => {
      calls.push(request);
      return writeWorkerResult(request);
    });

    const result = await invoke(harness.ctx, {
      ...body(),
      requestedDepth: 1,
      prefetchDepth: 3,
    });
    expect(result.status).toBe(200);
    expect(calls).toHaveLength(1);
    const warmed = await invokeWarm(harness.ctx, {
      ...body(),
      requestedDepth: 2,
      prefetchDepth: 4,
    });
    expect(warmed.status).toBe(202);
    expect(warmed.json).toMatchObject({
      version: 1,
      accepted: true,
      completed: false,
      cache: "miss",
    });
    expect(warmed.json.key).toMatch(/^[a-f0-9]{64}$/);
    await vi.waitFor(() => expect(calls).toHaveLength(2));

    expect(calls.filter(({ type }) => type === "project").map(({ projection }) => projection)).toEqual([
      { ...body(), requestedDepth: 1, prefetchDepth: 3 },
      { ...body(), requestedDepth: 2, prefetchDepth: 4 },
    ]);
    expect(calls.filter(({ type }) => type === "symbols")).toHaveLength(0);
  });

  it("serializes projection lookahead and symbol indexing under one speculative worker budget", async () => {
    const releases = [deferred<void>(), deferred<void>(), deferred<void>()];
    const calls: string[] = [];
    let active = 0;
    let maxActive = 0;
    const harness = createHarness(async (request) => {
      const label = request.type === "symbols"
        ? "symbols"
        : `projection:${request.projection?.requestedDepth ?? -1}`;
      const index = calls.length;
      calls.push(label);
      active += 1;
      maxActive = Math.max(maxActive, active);
      await releases[index]!.promise;
      active -= 1;
      return writeWorkerResult(request);
    }, 1, {}, 3);

    const first = await invokeWarm(harness.ctx, {
      ...body(),
      requestedDepth: 0,
      prefetchDepth: 0,
    });
    const second = await invokeWarm(harness.ctx, {
      ...body(),
      requestedDepth: 1,
      prefetchDepth: 1,
    });
    const symbols = invokeSymbols(harness.ctx, "graph");

    await vi.waitFor(() => expect(calls).toEqual(["projection:0"]));
    expect(first).toMatchObject({ status: 202, json: { accepted: true } });
    expect(second).toMatchObject({ status: 202, json: { accepted: true } });
    expect(maxActive).toBe(1);

    releases[0]!.resolve();
    await vi.waitFor(() => expect(calls).toEqual(["projection:0", "projection:1"]));
    expect(maxActive).toBe(1);

    releases[1]!.resolve();
    await vi.waitFor(() => expect(calls).toEqual(["projection:0", "projection:1", "symbols"]));
    expect(maxActive).toBe(1);

    releases[2]!.resolve();
    await expect(symbols).resolves.toMatchObject({ status: 200 });
    expect(maxActive).toBe(1);
  });

  it("keeps a bounded provisional source index behind normal capacity-one analysis admission", async () => {
    const calls: Array<{ request: GraphProjectWorkerRequest; heapMb: number | undefined }> = [];
    const harness = createHarness(async (request, _signal, options) => {
      calls.push({ request, heapMb: options?.workerHeapMb });
      return writeWorkerResult(request);
    }, 2, {}, 1);
    harness.graphStore.publish(githubRegistration(PROVISIONAL_GRAPH_ID, PROVISIONAL_ARTIFACT));

    const blockerStarted = deferred<void>();
    const releaseBlocker = deferred<void>();
    const blocker = harness.ctx.analysisCoordinator.run(
      "canonical-extractor",
      ({ runAnalysis }) => runAnalysis(async () => {
        blockerStarted.resolve();
        await releaseBlocker.promise;
      }),
    );
    await blockerStarted.promise;

    const symbols = invokeSymbols(harness.ctx, PROVISIONAL_GRAPH_ID);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(calls).toEqual([]);

    releaseBlocker.resolve();
    await blocker;
    await expect(symbols).resolves.toMatchObject({ status: 200 });
    expect(calls).toEqual([
      expect.objectContaining({
        request: expect.objectContaining({ type: "symbols" }),
        heapMb: 1_024,
      }),
    ]);
  });

  it("promotes and joins an in-flight background source index without restarting its worker", async () => {
    const releaseWorker = deferred<void>();
    const calls: GraphProjectWorkerRequest[] = [];
    const harness = createHarness(async (request) => {
      calls.push(request);
      await releaseWorker.promise;
      return writeWorkerResult(request);
    }, 2, {}, 1);
    harness.graphStore.publish(githubRegistration(PROVISIONAL_GRAPH_ID, PROVISIONAL_ARTIFACT));

    const background = invokeSymbols(harness.ctx, PROVISIONAL_GRAPH_ID);
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const graph = harness.graphStore.acquire(PROVISIONAL_GRAPH_ID)!;
    const interactive = ensureProvisionalSourceIndex(
      harness.ctx,
      PROVISIONAL_GRAPH_ID,
      graph,
      new AbortController().signal,
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(calls).toHaveLength(1);

    releaseWorker.resolve();
    const [response, handles] = await Promise.all([background, interactive]);
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    handles.symbols.release();
    handles.topology.release();
    graph.release();
    expect(harness.cache.stats().pins).toBe(0);
  });

  it("keeps canonical symbol work behind heavy analysis admission", async () => {
    const calls: GraphProjectWorkerRequest[] = [];
    const harness = createHarness(async (request) => {
      calls.push(request);
      return writeWorkerResult(request);
    }, 1, {}, 1);
    const blockerStarted = deferred<void>();
    const releaseBlocker = deferred<void>();
    const blocker = harness.ctx.analysisCoordinator.run(
      "canonical-extractor",
      ({ runAnalysis }) => runAnalysis(async () => {
        blockerStarted.resolve();
        await releaseBlocker.promise;
      }),
    );
    await blockerStarted.promise;

    const symbols = invokeSymbols(harness.ctx, "graph");
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(calls).toEqual([]);

    releaseBlocker.resolve();
    await blocker;
    await expect(symbols).resolves.toMatchObject({ status: 200 });
    expect(calls).toEqual([expect.objectContaining({ type: "symbols" })]);
  });

  it("retains a shared provisional source scan when a warm expansion outlives its HTTP waiter", async () => {
    const calls: string[] = [];
    const heaps: Array<number | undefined> = [];
    const releaseSymbols = deferred<void>();
    const releaseProjection = deferred<void>();
    const harness = createHarness((request, _signal, options) => {
      calls.push(request.type);
      heaps.push(options?.workerHeapMb);
      if (request.type === "project") {
        return releaseProjection.promise.then(() => writeWorkerResult(request));
      }
      return releaseSymbols.promise.then(() => writeWorkerResult(request));
    }, 2, {}, 1);
    harness.graphStore.publish(githubRegistration(PROVISIONAL_GRAPH_ID, PROVISIONAL_ARTIFACT));

    const symbolRequest = new PassThrough() as PassThrough & IncomingMessage;
    symbolRequest.end();
    const symbolResponse = new TestResponse();
    const symbols = handleGraphSymbols(
      harness.ctx,
      symbolRequest,
      symbolResponse as unknown as ServerResponse,
      PROVISIONAL_GRAPH_ID,
    );
    await vi.waitFor(() => expect(calls).toEqual(["symbols"]));

    const warmed = await invokeWarm(harness.ctx, {
      ...body(),
      graphId: PROVISIONAL_GRAPH_ID,
      roots: { kind: "files", fileIds: [PROVISIONAL_FILE_ID] },
    });
    expect(warmed).toMatchObject({ status: 202, json: { accepted: true } });
    expect(calls).toEqual(["symbols"]);

    symbolRequest.emit("aborted");
    await expect(symbols).rejects.toBeInstanceOf(OperationCancelledError);
    expect(calls).toEqual(["symbols"]);

    releaseSymbols.resolve();
    await vi.waitFor(() => expect(calls).toEqual(["symbols", "project"]));
    expect(heaps).toEqual([1_024, 1_024]);

    releaseProjection.resolve();
    await vi.waitFor(() => expect(
      invokeWarmStatus(harness.ctx, String(warmed.json.key)).status,
    ).toBe(200));
  });

  it("singleflights source discovery and admits critical partial extractions through normal capacity", async () => {
    const releaseSource = deferred<void>();
    const releaseExtractions = deferred<void>();
    const workerCalls: string[] = [];
    let activeExtractions = 0;
    let maxActiveExtractions = 0;
    const extractionHeaps: Array<number | undefined> = [];
    const harness = createHarness(async (request) => {
      workerCalls.push(request.type);
      if (request.type === "symbols") await releaseSource.promise;
      return writeWorkerResult(request);
    }, 1, {}, 4, async (request, options) => {
      activeExtractions += 1;
      maxActiveExtractions = Math.max(maxActiveExtractions, activeExtractions);
      extractionHeaps.push(options?.workerHeapMb);
      await releaseExtractions.promise;
      try {
        return writeRepositoryAnalysisResult(request, options);
      } finally {
        activeExtractions -= 1;
      }
    });
    harness.graphStore.publish(githubRegistration(PROVISIONAL_GRAPH_ID, PROVISIONAL_ARTIFACT));
    const variants = [
      [0, 0], [0, 1], [1, 2],
    ] as const;
    const request = ([requestedDepth, prefetchDepth]: readonly [number, number]) => ({
      ...body(),
      graphId: PROVISIONAL_GRAPH_ID,
      roots: { kind: "files", fileIds: [PROVISIONAL_FILE_ID] },
      requestedDepth,
      prefetchDepth,
    });

    const requests = variants.map((variant) => invoke(harness.ctx, request(variant)));
    await vi.waitFor(() => expect(workerCalls).toEqual(["symbols"]));
    releaseSource.resolve();
    await vi.waitFor(() => expect(activeExtractions).toBe(1));
    expect(maxActiveExtractions).toBe(1);
    expect(workerCalls).toEqual(["symbols"]);

    releaseExtractions.resolve();
    await expect(Promise.all(requests)).resolves.toHaveLength(3);
    expect(workerCalls).toEqual(["symbols", "project", "project", "project"]);
    expect(maxActiveExtractions).toBe(1);
    expect(extractionHeaps).toEqual([4_096, 4_096, 4_096]);
    expect(harness.cache.stats().pins).toBe(0);
  });

  it("projects an exact empty provisional side at later depth without source extraction", async () => {
    const calls: string[] = [];
    const repositoryAnalysis = vi.fn(async () => {
      throw new Error("empty side must not start source extraction");
    });
    const harness = createHarness(async (request) => {
      calls.push(request.type);
      return writeWorkerResult(request);
    }, 2, {}, 1, repositoryAnalysis as Context["repositoryAnalysis"]);
    const emptyId = `pr-partial-base-${"d".repeat(20)}-${"e".repeat(40)}`;
    harness.graphStore.publish(githubRegistration(emptyId, {
      ...PROVISIONAL_ARTIFACT,
      nodes: [],
      edges: [],
      extensions: {
        prInitialGraph: {
          version: 1,
          complete: false,
          depth: 2,
          seedFiles: [],
          selectedFiles: [],
          frontierFiles: [],
        },
      },
    }));

    await expect(invoke(harness.ctx, {
      version: 1,
      graphId: emptyId,
      roots: { kind: "changed-files", seedGraphId: emptyId },
      requestedDepth: 3,
      prefetchDepth: 3,
    })).resolves.toMatchObject({ status: 200 });
    expect(calls).toEqual(["project"]);
    expect(repositoryAnalysis).not.toHaveBeenCalled();
  });

  it("admits only strict server-generated GitHub provisional metadata to the lightweight lane", () => {
    const descriptor = provisionalDescriptor();
    const input = {
      graphId: descriptor.id,
      path: "/tmp/artifact.json",
      bytes: 64 * 1024 * 1024,
      sha256: descriptor.byteDigest,
    };
    expect(boundedProvisionalGraphWorkerHeapMb(descriptor, input)).toBe(1_024);
    expect(boundedProvisionalGraphWorkerHeapMb(
      { ...descriptor, id: `pr-${"a".repeat(20)}-${"b".repeat(40)}` },
      input,
    )).toBeNull();
    expect(boundedProvisionalGraphWorkerHeapMb(
      { ...descriptor, source: { kind: "path" } },
      input,
    )).toBeNull();
    expect(boundedProvisionalGraphWorkerHeapMb(descriptor, {
      ...input,
      bytes: 64 * 1024 * 1024 + 1,
    })).toBeNull();
    expect(boundedProvisionalGraphWorkerHeapMb({
      ...descriptor,
      summary: { ...descriptor.summary, nodeCount: 20_001 },
    }, input)).toBeNull();
    expect(boundedProvisionalGraphWorkerHeapMb({
      ...descriptor,
      summary: { ...descriptor.summary, edgeCount: 100_001 },
    }, input)).toBeNull();
  });

  it("queues a second warm before global admission so foreground analysis keeps capacity two", async () => {
    const calls: number[] = [];
    const aborted: number[] = [];
    const harness = createHarness((request, signal) => {
      const depth = request.projection?.requestedDepth ?? -1;
      calls.push(depth);
      return new Promise<GraphProjectWorkerResult>((_resolve, reject) => {
        const onAbort = () => {
          aborted.push(depth);
          reject(signal.reason);
        };
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
      });
    }, 1, {}, 2);

    const first = await invokeWarm(harness.ctx, {
      ...body(),
      requestedDepth: 0,
      prefetchDepth: 0,
    });
    await vi.waitFor(() => expect(calls).toEqual([0]));
    const second = await invokeWarm(harness.ctx, {
      ...body(),
      requestedDepth: 1,
      prefetchDepth: 1,
    });

    let foregroundAdmitted = false;
    const foreground = harness.ctx.analysisCoordinator.run(
      "foreground-capacity-probe",
      ({ runAnalysis }) => runAnalysis(async () => {
        foregroundAdmitted = true;
        return "admitted";
      }),
    );
    await vi.waitFor(() => expect(foregroundAdmitted).toBe(true));
    await expect(foreground).resolves.toBe("admitted");
    expect(calls).toEqual([0]);

    // The foreground hook aborts both the active and locally queued warm. Their graph pins and
    // staging entries must drain without publishing a partial cache result.
    const releaseForeground = beginForegroundGraphWork(harness.ctx);
    releaseForeground();
    await vi.waitFor(() => expect(aborted).toEqual([0]));
    await vi.waitFor(() => {
      expect(invokeWarmStatus(harness.ctx, String(first.json.key)).status).toBe(202);
      expect(invokeWarmStatus(harness.ctx, String(second.json.key)).status).toBe(202);
      expect(harness.cache.stats()).toEqual({ entries: 0, bytes: 0, pins: 0 });
    });
    // Worker rejection precedes the detached warm promise's final pin-release continuation.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    harness.graphStore.publish(registration("replacement", {
      ...ARTIFACT,
      generatedAt: "2026-07-31T00:00:01.000Z",
    }));
    await vi.waitFor(() => expect(harness.graphStore.stats().registrations).toBe(1));
    expect(harness.graphStore.acquire("graph")).toBeUndefined();
  });

  it("transfers graph pins to accepted warm work and singleflights a following critical request", async () => {
    let releaseWorker!: () => void;
    const gate = new Promise<void>((resolve) => { releaseWorker = resolve; });
    let projectCalls = 0;
    const harness = createHarness(async (request) => {
      if (request.type === "project") {
        projectCalls += 1;
        await gate;
      }
      return writeWorkerResult(request);
    });

    const warmed = await invokeWarm(harness.ctx, body());
    expect(warmed.status).toBe(202);
    expect(warmed.json).toMatchObject({
      version: 1,
      accepted: true,
      completed: false,
      cache: "miss",
    });
    const key = String(warmed.json.key);
    expect(key).toMatch(/^[a-f0-9]{64}$/);
    expect(invokeWarmStatus(harness.ctx, key)).toMatchObject({
      status: 202,
      json: { version: 1, key, completed: false },
    });
    await vi.waitFor(() => expect(projectCalls).toBe(1));

    // An accepted cache fill owns the exact registration it validated. Retention cannot evict it
    // before the worker publishes, and a critical waiter joins the same service-owned job.
    harness.graphStore.publish(registration("other", {
      ...ARTIFACT,
      generatedAt: "2026-07-31T00:00:01.000Z",
    }));
    const stillPinned = harness.graphStore.acquire("graph");
    expect(stillPinned).toBeDefined();
    stillPinned?.release();

    const critical = invoke(harness.ctx, body());
    releaseWorker();
    const joined = await critical;
    expect(joined.status).toBe(200);
    // Depending on whether the request body is drained before the worker publishes, this waiter
    // either joins the active producer or observes the just-published immutable entry.
    expect(["coalesced", "hit"]).toContain(joined.headers[GRAPH_PROJECTION_CACHE_HEADER]);
    expect(joined.headers[GRAPH_PROJECTION_KEY_HEADER]).toBe(key);
    expect(invokeWarmStatus(harness.ctx, key)).toMatchObject({
      status: 200,
      json: { version: 1, key, completed: true },
    });

    // Completion observation never computes. The following exact request therefore proves that the
    // speculative next-depth entry, rather than this critical request, populated the immutable cache.
    const repeated = await invoke(harness.ctx, body());
    expect(repeated.headers[GRAPH_PROJECTION_CACHE_HEADER]).toBe("hit");
    expect(repeated.headers[GRAPH_PROJECTION_KEY_HEADER]).toBe(key);
    expect(repeated.headers[GRAPH_PROJECTION_READY_HEADER]).toBe("true");

    const warmHit = await invokeWarm(harness.ctx, body());
    expect(warmHit).toMatchObject({
      status: 200,
      json: { version: 1, key, accepted: false, completed: true, cache: "hit" },
    });
    expect(projectCalls).toBe(1);
  });

  it("lets a critical waiter promote its exact warm while unrelated speculation is preempted", async () => {
    const calls: number[] = [];
    const aborted: number[] = [];
    const harness = createHarness((request, signal) => {
      const depth = request.projection?.requestedDepth ?? -1;
      calls.push(depth);
      if (depth === 1) return Promise.resolve(writeWorkerResult(request));
      return new Promise<GraphProjectWorkerResult>((_resolve, reject) => {
        const onAbort = () => {
          aborted.push(depth);
          reject(signal.reason);
        };
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
      });
    }, 1, {}, 3);

    const stale = await invokeWarm(harness.ctx, {
      ...body(),
      requestedDepth: 0,
      prefetchDepth: 0,
    });
    await vi.waitFor(() => expect(calls).toEqual([0]));
    const promoted = await invokeWarm(harness.ctx, {
      ...body(),
      requestedDepth: 1,
      prefetchDepth: 1,
    });

    // The exact depth-one producer is already admitted by the coordinator but remains behind the
    // shared speculative worker fence. Its critical waiter must be allowed to promote that queued
    // task; pausing every queued task here would deadlock the waiter behind itself.
    const critical = await invoke(harness.ctx, {
      ...body(),
      requestedDepth: 1,
      prefetchDepth: 1,
    });

    expect(critical).toMatchObject({
      status: 200,
      headers: {
        [GRAPH_PROJECTION_CACHE_HEADER]: "coalesced",
        [GRAPH_PROJECTION_READY_HEADER]: "true",
      },
    });
    await vi.waitFor(() => expect(aborted).toContain(0));
    expect(calls).toEqual([0, 1]);
    expect(invokeWarmStatus(harness.ctx, String(stale.json.key)).status).toBe(202);
    expect(invokeWarmStatus(harness.ctx, String(promoted.json.key)).status).toBe(200);
  });

  it("promotes an equal-key critical join through a foreground fence and preserves its cache", async () => {
    let projectCalls = 0;
    const harness = createHarness(async (request) => {
      projectCalls += 1;
      return writeWorkerResult(request);
    }, 1, {}, 1);
    const releaseForeground = beginForegroundGraphWork(harness.ctx);
    const warm = await invokeWarm(harness.ctx, body());
    expect(warm).toMatchObject({ status: 202, json: { accepted: true, completed: false } });
    expect(projectCalls).toBe(0);

    // The queued producer is background only until an exact critical request joins it. That join
    // must promote the same immutable job instead of deadlocking behind the foreground fence.
    const critical = await invoke(harness.ctx, body());
    expect(critical).toMatchObject({
      status: 200,
      headers: { [GRAPH_PROJECTION_CACHE_HEADER]: "coalesced" },
    });
    expect(projectCalls).toBe(1);

    // Foreground preemption targets only live jobs; the completed immutable cache survives.
    const cached = await invoke(harness.ctx, body());
    expect(cached.headers[GRAPH_PROJECTION_CACHE_HEADER]).toBe("hit");
    expect(projectCalls).toBe(1);
    releaseForeground();
  });

  it("bounds speculative jobs and preempts unrelated warm work for a critical projection", async () => {
    const calls: number[] = [];
    const aborted: number[] = [];
    const harness = createHarness((request, signal) => {
      const depth = request.projection?.requestedDepth ?? -1;
      calls.push(depth);
      if (depth >= 3) return Promise.resolve(writeWorkerResult(request));
      return new Promise<GraphProjectWorkerResult>((_resolve, reject) => {
        const onAbort = () => {
          aborted.push(depth);
          reject(signal.reason);
        };
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
      });
    }, 1, {}, 3);

    const first = await invokeWarm(harness.ctx, { ...body(), requestedDepth: 0, prefetchDepth: 0 });
    await vi.waitFor(() => expect(calls).toEqual([0]));
    const second = await invokeWarm(harness.ctx, { ...body(), requestedDepth: 1, prefetchDepth: 1 });
    expect(first).toMatchObject({ status: 202, json: { accepted: true, cache: "miss" } });
    expect(second).toMatchObject({ status: 202, json: { accepted: true, cache: "miss" } });

    const refused = await invokeWarm(harness.ctx, { ...body(), requestedDepth: 2, prefetchDepth: 2 });
    expect(refused).toMatchObject({
      status: 503,
      json: { accepted: false, completed: false, cache: "miss" },
    });

    const critical = await invoke(harness.ctx, { ...body(), requestedDepth: 3, prefetchDepth: 3 });
    expect(critical.status).toBe(200);
    await vi.waitFor(() => expect(aborted).toContain(0));
    expect(calls).toEqual([0, 3]);
    expect(invokeWarmStatus(harness.ctx, String(first.json.key)).status).toBe(202);
    expect(invokeWarmStatus(harness.ctx, String(second.json.key)).status).toBe(202);
  });

  it("preempts stale symbol and warm workers before admitting a fresh critical projection", async () => {
    const calls: string[] = [];
    const aborted: string[] = [];
    const harness = createHarness((request, signal) => {
      const label = request.type === "symbols"
        ? "symbols"
        : `projection:${request.projection?.requestedDepth ?? -1}`;
      calls.push(label);
      if (request.type === "project" && request.projection?.requestedDepth === 1) {
        return Promise.resolve(writeWorkerResult(request));
      }
      return new Promise<GraphProjectWorkerResult>((_resolve, reject) => {
        const onAbort = () => {
          aborted.push(label);
          reject(signal.reason);
        };
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
      });
    });

    const staleSymbols = [
      invokeSymbols(harness.ctx, "graph"),
      invokeSymbols(harness.ctx, "graph"),
    ];
    // Attach the rejection observer before the foreground request synchronously preempts it.
    const staleSymbolOutcomes = staleSymbols.map((promise) => promise.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    ));
    await vi.waitFor(() => expect(calls).toEqual(["symbols"]));
    const staleWarm = await invokeWarm(harness.ctx, {
      ...body(),
      requestedDepth: 2,
      prefetchDepth: 2,
    });
    expect(staleWarm).toMatchObject({ status: 202, json: { accepted: true, cache: "miss" } });

    // No background gate is released. The foreground miss itself must stop the running symbol
    // worker, remove the queued warm, acquire the only analysis slot, and publish successfully.
    const critical = await invoke(harness.ctx, {
      ...body(),
      requestedDepth: 1,
      prefetchDepth: 1,
    });
    expect(critical).toMatchObject({
      status: 200,
      headers: {
        [GRAPH_PROJECTION_CACHE_HEADER]: "miss",
        [GRAPH_PROJECTION_READY_HEADER]: "true",
      },
    });
    await expect(Promise.all(staleSymbolOutcomes)).resolves.toEqual([
      expect.objectContaining({
        error: expect.objectContaining({
          status: 503,
          message: "background graph work yielded to an interactive projection; retry shortly",
        }),
      }),
      expect.objectContaining({
        error: expect.objectContaining({
          status: 503,
          message: "background graph work yielded to an interactive projection; retry shortly",
        }),
      }),
    ]);
    await vi.waitFor(() => expect(aborted).toContain("symbols"));
    expect(calls).toEqual(["symbols", "projection:1"]);
    expect(invokeWarmStatus(harness.ctx, String(staleWarm.json.key)).status).toBe(202);

    // Every abandoned background and completed foreground pin has drained; ordinary retention may
    // evict this graph after another registration is published.
    harness.graphStore.publish(registration("other", {
      ...ARTIFACT,
      generatedAt: "2026-07-31T00:00:01.000Z",
    }));
    expect(harness.graphStore.acquire("graph")).toBeUndefined();
  });

  it("serves a cached critical projection after stopping joined symbols and queued warm work", async () => {
    const calls: string[] = [];
    const aborted: string[] = [];
    const harness = createHarness((request, signal) => {
      const label = request.type === "symbols"
        ? "symbols"
        : `projection:${request.projection?.requestedDepth ?? -1}`;
      calls.push(label);
      if (request.type === "project" && request.projection?.requestedDepth !== 2) {
        return Promise.resolve(writeWorkerResult(request));
      }
      return new Promise<GraphProjectWorkerResult>((_resolve, reject) => {
        const onAbort = () => {
          aborted.push(label);
          reject(signal.reason);
        };
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
      });
    });
    const criticalRequest = { ...body(), requestedDepth: 1, prefetchDepth: 1 };
    const primed = await invoke(harness.ctx, criticalRequest);
    expect(primed).toMatchObject({
      status: 200,
      headers: {
        [GRAPH_PROJECTION_CACHE_HEADER]: "miss",
        [GRAPH_PROJECTION_READY_HEADER]: "true",
      },
    });

    const staleSymbols = [
      invokeSymbols(harness.ctx, "graph"),
      invokeSymbols(harness.ctx, "graph"),
    ];
    const staleSymbolOutcomes = staleSymbols.map((promise) => promise.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    ));
    await vi.waitFor(() => expect(calls).toEqual(["projection:1", "symbols"]));
    const staleWarm = await invokeWarm(harness.ctx, {
      ...body(),
      requestedDepth: 2,
      prefetchDepth: 2,
    });
    expect(staleWarm).toMatchObject({ status: 202, json: { accepted: true, cache: "miss" } });

    // The cache hit must still establish foreground priority. No foreground worker is needed, but
    // the old symbol worker and queued lookahead must not keep consuming the shared pool afterward.
    const cached = await invoke(harness.ctx, criticalRequest);
    expect(cached).toMatchObject({
      status: 200,
      headers: {
        [GRAPH_PROJECTION_CACHE_HEADER]: "hit",
        [GRAPH_PROJECTION_READY_HEADER]: "true",
      },
    });
    await expect(Promise.all(staleSymbolOutcomes)).resolves.toEqual([
      expect.objectContaining({
        error: expect.objectContaining({
          status: 503,
          message: "background graph work yielded to an interactive projection; retry shortly",
        }),
      }),
      expect.objectContaining({
        error: expect.objectContaining({
          status: 503,
          message: "background graph work yielded to an interactive projection; retry shortly",
        }),
      }),
    ]);
    await vi.waitFor(() => expect(aborted).toContain("symbols"));
    expect(calls).toEqual(["projection:1", "symbols"]);
    expect(invokeWarmStatus(harness.ctx, String(staleWarm.json.key)).status).toBe(202);

    // A new uncached foreground request proves the aborted admission fully relinquished the only
    // coordinator slot. It would hang forever behind the test's never-released background work.
    const drained = await invoke(harness.ctx, {
      ...body(),
      requestedDepth: 0,
      prefetchDepth: 0,
    });
    expect(drained).toMatchObject({
      status: 200,
      headers: { [GRAPH_PROJECTION_CACHE_HEADER]: "miss" },
    });
    expect(calls).toEqual(["projection:1", "symbols", "projection:0"]);

    harness.graphStore.publish(registration("other", {
      ...ARTIFACT,
      generatedAt: "2026-07-31T00:00:01.000Z",
    }));
    await vi.waitFor(() => expect(harness.graphStore.stats().registrations).toBe(1));
    expect(harness.graphStore.acquire("graph")).toBeUndefined();
  });

  it("accepts a successful warm again after its immutable cache entry is evicted", async () => {
    let projectCalls = 0;
    const harness = createHarness(async (request) => {
      if (request.type === "project") projectCalls += 1;
      return writeWorkerResult(request);
    }, 1, { maxEntries: 1 });
    const warmedRequest = { ...body(), requestedDepth: 0, prefetchDepth: 0 };
    const first = await invokeWarm(harness.ctx, warmedRequest);
    const firstKey = String(first.json.key);
    await vi.waitFor(() => expect(invokeWarmStatus(harness.ctx, firstKey).status).toBe(200));

    await invoke(harness.ctx, { ...body(), requestedDepth: 1, prefetchDepth: 1 });
    expect(invokeWarmStatus(harness.ctx, firstKey).status).toBe(202);

    const retried = await invokeWarm(harness.ctx, warmedRequest);
    expect(retried).toMatchObject({
      status: 202,
      json: { key: firstKey, accepted: true, completed: false, cache: "miss" },
    });
    await vi.waitFor(() => expect(invokeWarmStatus(harness.ctx, firstKey).status).toBe(200));
    expect(projectCalls).toBe(3);
  });

  it("clears failed speculative bookkeeping so an identical warm can retry", async () => {
    let projectCalls = 0;
    const harness = createHarness(async (request) => {
      projectCalls += 1;
      if (projectCalls === 1) throw new Error("transient projection worker failure");
      return writeWorkerResult(request);
    });
    const request = { ...body(), requestedDepth: 1, prefetchDepth: 1 };
    const failed = await invokeWarm(harness.ctx, request);
    const key = String(failed.json.key);
    expect(failed).toMatchObject({ status: 202, json: { accepted: true, completed: false } });
    await vi.waitFor(() => expect(projectCalls).toBe(1));

    let retried: TestResult | undefined;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      const candidate = await invokeWarm(harness.ctx, request);
      if (candidate.json.accepted === true) {
        retried = candidate;
        break;
      }
    }
    expect(retried).toMatchObject({
      status: 202,
      json: { key, accepted: true, completed: false, cache: "miss" },
    });
    await vi.waitFor(() => expect(invokeWarmStatus(harness.ctx, key).status).toBe(200));
    expect(projectCalls).toBe(2);
  });

  it("rejects malformed opaque warm-status keys without probing the cache", () => {
    const harness = createHarness(async (request) => writeWorkerResult(request));
    expect(() => invokeWarmStatus(harness.ctx, "../../result.json"))
      .toThrow("graph projection warm status requires a valid key");
  });

  it("reserves the complete initial pair for the full bounded handoff despite unrelated exact requests", async () => {
    let now = 0;
    let projectCalls = 0;
    const harness = createHarness(async (request) => {
      if (request.type === "project") projectCalls += 1;
      return writeWorkerResult(request);
    }, 2, { maxEntries: 2, ttlMs: 10, now: () => now });
    harness.graphStore.publish(registration("comparison", {
      ...ARTIFACT,
      generatedAt: "2026-07-31T00:00:01.000Z",
    }));
    const controller = new AbortController();

    const prepared = await prepareInitialGraphProjectionCache(
      harness.ctx,
      "graph",
      "comparison",
      controller.signal,
    );
    expect(prepared).toMatchObject({
      evidence: {
        version: 1,
        depth: 1,
        prefetchDepth: 3,
        headKey: expect.stringMatching(/^[a-f0-9]{64}$/),
        comparisonKey: expect.stringMatching(/^[a-f0-9]{64}$/),
        ready: true,
      },
      warning: null,
    });
    expect(projectCalls).toBe(2);
    expect(harness.cache.stats()).toMatchObject({ entries: 2, pins: 2 });

    now = 20;
    harness.cache.sweep();
    expect(harness.cache.stats()).toMatchObject({ entries: 2, pins: 2 });
    const pressureStage = harness.cache.createStage();
    const pressure = writeOutput(pressureStage.outputPath, { pressure: true });
    harness.cache.publish("pressure", pressureStage, pressure);
    expect(harness.cache.acquire("pressure")).toBeUndefined();
    expect(harness.cache.stats()).toMatchObject({ entries: 2, pins: 2 });

    const head = await invoke(harness.ctx, initialBody("graph", "graph"));
    expect(head).toMatchObject({
      status: 200,
      headers: {
        [GRAPH_PROJECTION_CACHE_HEADER]: "hit",
        [GRAPH_PROJECTION_KEY_HEADER]: prepared.evidence.headKey,
        [GRAPH_PROJECTION_READY_HEADER]: "true",
      },
    });
    // Exact-key traffic carries no navigation identity. It must not consume the landing guarantee
    // on behalf of a different tab that happened to request the same immutable projection first.
    expect(harness.cache.stats().pins).toBe(2);
    const comparison = await invoke(harness.ctx, initialBody("comparison", "graph"));
    expect(comparison).toMatchObject({
      status: 200,
      headers: {
        [GRAPH_PROJECTION_CACHE_HEADER]: "hit",
        [GRAPH_PROJECTION_KEY_HEADER]: prepared.evidence.comparisonKey,
        [GRAPH_PROJECTION_READY_HEADER]: "true",
      },
    });
    expect(projectCalls).toBe(2);
    expect(harness.cache.stats()).toMatchObject({ entries: 2, pins: 2 });

    controller.abort();
    expect(harness.cache.stats().pins).toBe(0);
    now = 40;
    harness.cache.sweep();
    expect(harness.cache.stats()).toEqual({ entries: 0, bytes: 0, pins: 0 });
  });

  it("chunks 513 affected roots without a full fallback and publishes one exact deterministic union", async () => {
    const paths = Array.from(
      { length: 513 },
      (_, index) => `src/file-${String(index).padStart(3, "0")}.ts`,
    );
    const packageNode = {
      id: "pkg:.",
      kind: "package" as const,
      qualifiedName: ".",
      displayName: ".",
      location: { file: ".", startLine: 1 },
    };
    const largeArtifact: GraphArtifact = {
      ...ARTIFACT,
      nodes: [
        packageNode,
        ...paths.map((path) => ({
          id: buildNodeId({ lang: "ts", modulePath: path }),
          kind: "module" as const,
          qualifiedName: path,
          displayName: path,
          parentId: packageNode.id,
          location: { file: path, startLine: 1 },
        })),
      ],
    };
    const calls: GraphProjectWorkerRequest[] = [];
    const workerErrors: unknown[] = [];
    const harness = createHarness(async (request, signal, options) => {
      calls.push(request);
      try {
        return await runGraphProjectChild(request, {
          signal,
          timeoutMs: 30_000,
          ...(options?.workerHeapMb === undefined ? {} : { workerHeapMb: options.workerHeapMb }),
        });
      } catch (error) {
        workerErrors.push(error);
        throw error;
      }
    }, 3, { maxEntries: 3 }, 2);
    const rootChunks = graphProjectionRootChunks(paths);
    expect(rootChunks).toBeDefined();
    harness.graphStore.publish(registration("large-head", largeArtifact, rootChunks));
    harness.graphStore.publish(registration("large-base", {
      ...largeArtifact,
      generatedAt: "2026-07-31T00:00:01.000Z",
    }, rootChunks));
    const controller = new AbortController();

    const prepared = await prepareInitialGraphProjectionCache(
      harness.ctx,
      "large-head",
      "large-base",
      controller.signal,
    );

    expect(workerErrors).toEqual([]);
    expect(prepared).toMatchObject({ evidence: { ready: true }, warning: null });
    for (const graphId of ["large-head", "large-base"]) {
      const graphCalls = calls.filter(({ graph }) => graph.graphId === graphId);
      const projectCalls = graphCalls.filter(({ type }) => type === "project");
      const mergeCalls = graphCalls.filter(({ type }) => type === "merge");
      expect(projectCalls).toHaveLength(2);
      expect(projectCalls.map(({ projection }) => (
        projection?.roots.kind === "file-paths" ? projection.roots.paths.length : -1
      ))).toEqual([512, 1]);
      expect(projectCalls.every(({ projection }) => projection?.roots.kind !== "changed-files")).toBe(true);
      expect(projectCalls.flatMap(({ projection }) => (
        projection?.roots.kind === "file-paths" ? projection.roots.paths : []
      ))).toEqual(paths);
      expect(mergeCalls).toHaveLength(1);
      expect(mergeCalls[0]?.projectionInputs).toHaveLength(2);
    }
    expect(calls.every(({ type }) => type === "project" || type === "merge")).toBe(true);

    const response = await invoke(harness.ctx, initialBody("large-head", "large-head"));
    expect(response.headers[GRAPH_PROJECTION_CACHE_HEADER]).toBe("hit");
    expect(response.json.rootFileIds).toEqual(
      paths.map((path) => buildNodeId({ lang: "ts", modulePath: path })).sort(),
    );
    expect(response.json.readyFileIds).toEqual(response.json.rootFileIds);
    expect(response.json.nodes).toHaveLength(514);
    expect((response.json.nodes as Array<{ id: string }>).filter(({ id }) => id === packageNode.id)).toHaveLength(1);
    expect(response.json).toMatchObject({
      graphId: "large-head",
      seedGraphId: "large-head",
      counts: { slice: { nodes: 514, edges: 0, files: 513 } },
    });
    controller.abort();

    // The compact server-owned plan survives projection-cache pressure for the lifetime of this
    // process-local graph registration. A reload recomputes the same partial chunks, never a full
    // graph, even though the landing reservation has ended.
    for (let index = 0; index < 3; index += 1) {
      const stage = harness.cache.createStage();
      const output = writeOutput(stage.outputPath, { pressure: index });
      harness.cache.publish(`pressure-${index}`, stage, output);
    }
    const callsBeforeReload = calls.length;
    const reloaded = await invoke(harness.ctx, initialBody("large-head", "large-head"));
    expect(reloaded.status).toBe(200);
    expect(reloaded.json.rootFileIds).toEqual(response.json.rootFileIds);
    expect(calls.slice(callsBeforeReload).map(({ type }) => type)).toEqual([
      "project",
      "project",
      "merge",
    ]);
  }, 60_000);

  it("replays an oversized registration after more than sixteen distinct cache keys", async () => {
    const paths = Array.from(
      { length: 513 },
      (_, index) => `src/replay-${String(index).padStart(3, "0")}.ts`,
    );
    const chunks = graphProjectionRootChunks(paths);
    expect(chunks).toBeDefined();
    const calls: GraphProjectWorkerRequest[] = [];
    const harness = createHarness(async (request) => {
      calls.push(request);
      return writeWorkerResult(request);
    }, 2, { maxEntries: 1 });
    harness.graphStore.publish(registration("durable", ARTIFACT, chunks));
    const variants = Array.from({ length: 17 }, (_, index) => ({
      version: 1 as const,
      graphId: "durable",
      roots: { kind: "changed-files" as const, seedGraphId: "durable" },
      requestedDepth: Math.floor(index / 4),
      prefetchDepth: Math.floor(index / 4) + (index % 4),
    }));

    for (const request of variants) expect((await invoke(harness.ctx, request)).status).toBe(200);
    const beforeReplay = calls.length;
    expect((await invoke(harness.ctx, variants[0]!)).status).toBe(200);
    expect(calls.slice(beforeReplay).map(({ type }) => type)).toEqual([
      "project",
      "project",
      "merge",
    ]);
    expect(calls.filter(({ type }) => type === "project").every(({ projection }) => (
      projection?.roots.kind === "file-paths"
    ))).toBe(true);
  });

  it("caps the second real shard writer at the remaining aggregate and cleans every stage", async () => {
    const paths = Array.from({ length: 513 }, (_, index) => `src/big-${index}.ts`);
    const chunks = graphProjectionRootChunks(paths);
    expect(chunks).toBeDefined();
    const stagedPaths: string[] = [];
    const outputLimits: number[] = [];
    let mergeCalls = 0;
    let projectCalls = 0;
    const secondShardAllowance = 128;
    const harness = createHarness(async (request, signal, options) => {
      if (request.type === "merge") mergeCalls += 1;
      if (request.type !== "project") return writeWorkerResult(request);
      projectCalls += 1;
      stagedPaths.push(request.projectionOutputPath!);
      outputLimits.push(request.projectionOutputMaxBytes!);
      const result = await runGraphProjectChild(request, {
        signal,
        timeoutMs: 30_000,
        ...(options?.workerHeapMb === undefined ? {} : { workerHeapMb: options.workerHeapMb }),
      });
      if (projectCalls !== 1 || result.projection === null) return result;
      // Production children report the exact first-file size. This controlled boundary coordinate
      // leaves a tiny remainder so the second *real* child proves its writer-side quota before a
      // large fixture would need to allocate or stage hundreds of MiB.
      return {
        ...result,
        projection: {
          ...result.projection,
          bytes: MAX_GRAPH_PROJECT_OUTPUT_BYTES - secondShardAllowance,
        },
      };
    }, 2);
    harness.graphStore.publish(registration("aggregate", ARTIFACT, chunks));

    await expect(invoke(harness.ctx, initialBody("aggregate", "aggregate")))
      .rejects.toThrow(/output exceeded its byte limit/);
    expect(mergeCalls).toBe(0);
    expect(projectCalls).toBe(2);
    expect(outputLimits).toEqual([MAX_GRAPH_PROJECT_OUTPUT_BYTES, secondShardAllowance]);
    expect(stagedPaths).toHaveLength(2);
    expect(stagedPaths.every((path) => !existsSync(path))).toBe(true);
  });

  it("short-circuits a zero-node revision even when a stale oversized plan is present", async () => {
    const paths = Array.from({ length: 513 }, (_, index) => `docs/page-${index}.md`);
    const chunks = graphProjectionRootChunks(paths);
    expect(chunks).toBeDefined();
    const calls: GraphProjectWorkerRequest[] = [];
    const harness = createHarness(async (request) => {
      calls.push(request);
      return writeWorkerResult(request);
    }, 3);
    const emptyArtifact = { ...ARTIFACT, nodes: [] } satisfies GraphArtifact;
    harness.graphStore.publish(registration("empty-head", emptyArtifact, chunks));
    harness.graphStore.publish(registration("empty-base", {
      ...emptyArtifact,
      generatedAt: "2026-07-31T00:00:01.000Z",
    }, chunks));

    const prepared = await prepareInitialGraphProjectionCache(
      harness.ctx,
      "empty-head",
      "empty-base",
      new AbortController().signal,
    );
    expect(prepared.evidence.ready).toBe(true);
    expect(calls.map(({ type }) => type)).toEqual(["project", "project"]);
    expect(calls.every(({ projection }) => projection?.roots.kind === "changed-files")).toBe(true);
  });

  it("rejects more than twenty thousand exact roots before any worker can be constructed", () => {
    expect(() => graphProjectionRootChunks(Array.from(
      { length: 20_001 },
      (_, index) => `src/root-${String(index).padStart(5, "0")}.ts`,
    ))).toThrow(/merged worker limit/);
  });

  it("does not advertise an initial pair whose changed-file roots are incomplete", async () => {
    const harness = createHarness(async (request) => {
      const result = writeWorkerResult(request);
      return result.projection === null
        ? result
        : { ...result, projection: { ...result.projection, completeRoots: 0 } };
    });
    harness.graphStore.publish(registration("comparison", {
      ...ARTIFACT,
      generatedAt: "2026-07-31T00:00:01.000Z",
    }));

    const prepared = await prepareInitialGraphProjectionCache(
      harness.ctx,
      "graph",
      "comparison",
      new AbortController().signal,
    );

    expect(prepared).toMatchObject({
      evidence: { ready: false },
      warning: "Initial review context was not reserved; retry the partial PR review.",
    });
    expect(harness.cache.stats()).toMatchObject({ pins: 0 });
  });

  it("shares one bounded reservation across concurrent subscribers for the same exact pair", async () => {
    const releaseWorker = deferred<void>();
    let projectCalls = 0;
    const harness = createHarness(async (request) => {
      if (request.type === "project") {
        projectCalls += 1;
        await releaseWorker.promise;
      }
      return writeWorkerResult(request);
    }, 2, { maxEntries: 2 });
    harness.graphStore.publish(registration("comparison", {
      ...ARTIFACT,
      generatedAt: "2026-07-31T00:00:01.000Z",
    }));
    const firstController = new AbortController();
    const latestController = new AbortController();
    const first = prepareInitialGraphProjectionCache(
      harness.ctx,
      "graph",
      "comparison",
      firstController.signal,
    );
    await vi.waitFor(() => expect(projectCalls).toBe(1));
    const latest = prepareInitialGraphProjectionCache(
      harness.ctx,
      "graph",
      "comparison",
      latestController.signal,
    );
    releaseWorker.resolve();

    const [firstPrepared, latestPrepared] = await Promise.all([first, latest]);
    expect(firstPrepared).toMatchObject({ evidence: { ready: true }, warning: null });
    expect(latestPrepared).toMatchObject({ evidence: { ready: true }, warning: null });
    expect(firstPrepared.evidence).toEqual(latestPrepared.evidence);
    expect(projectCalls).toBe(2);
    expect(harness.cache.stats()).toMatchObject({ entries: 2, pins: 2 });
    firstController.abort();
    expect(harness.cache.stats().pins).toBe(2);
    latestController.abort();
    expect(harness.cache.stats().pins).toBe(0);
  });

  it("bounds same-pair reservation owners without disturbing the admitted cohort", async () => {
    let projectCalls = 0;
    const harness = createHarness(async (request) => {
      if (request.type === "project") projectCalls += 1;
      return writeWorkerResult(request);
    }, 2, { maxEntries: 2 }, 2);
    harness.graphStore.publish(registration("comparison", {
      ...ARTIFACT,
      generatedAt: "2026-07-31T00:00:01.000Z",
    }));
    const controllers = Array.from({ length: 65 }, () => new AbortController());
    const results = [];
    for (const controller of controllers) {
      results.push(await prepareInitialGraphProjectionCache(
        harness.ctx,
        "graph",
        "comparison",
        controller.signal,
      ));
    }

    expect(results.slice(0, 64).every(({ evidence }) => evidence.ready)).toBe(true);
    expect(results[64]).toMatchObject({
      evidence: { ready: false },
      warning: expect.stringContaining("partial PR review"),
    });
    expect(projectCalls).toBe(2);
    expect(harness.cache.stats()).toMatchObject({ entries: 2, pins: 2 });
    for (const controller of controllers) controller.abort();
    expect(harness.cache.stats().pins).toBe(0);
  });

  it("lets a newer different pair replace the preceding bounded landing reservation", async () => {
    const releaseWorker = deferred<void>();
    let projectCalls = 0;
    const harness = createHarness(async (request) => {
      if (request.type === "project") {
        projectCalls += 1;
        await releaseWorker.promise;
      }
      return writeWorkerResult(request);
    }, 4, { maxEntries: 4 }, 2);
    for (const [id, generatedAt] of [
      ["comparison", "2026-07-31T00:00:01.000Z"],
      ["next-head", "2026-07-31T00:00:02.000Z"],
      ["next-comparison", "2026-07-31T00:00:03.000Z"],
    ] as const) {
      harness.graphStore.publish(registration(id, { ...ARTIFACT, generatedAt }));
    }
    const firstController = new AbortController();
    const latestController = new AbortController();
    const first = prepareInitialGraphProjectionCache(
      harness.ctx,
      "graph",
      "comparison",
      firstController.signal,
    );
    await vi.waitFor(() => expect(projectCalls).toBe(2));
    const latest = prepareInitialGraphProjectionCache(
      harness.ctx,
      "next-head",
      "next-comparison",
      latestController.signal,
    );
    releaseWorker.resolve();

    const [stale, current] = await Promise.all([first, latest]);
    expect(stale).toMatchObject({ evidence: { ready: false } });
    expect(current).toMatchObject({ evidence: { ready: true }, warning: null });
    expect(projectCalls).toBe(4);
    expect(harness.cache.stats()).toMatchObject({ entries: 4, pins: 2 });
    firstController.abort();
    expect(harness.cache.stats().pins).toBe(2);
    latestController.abort();
    expect(harness.cache.stats().pins).toBe(0);
  });

  it("aborts and drains the surviving initial-pair worker when its sibling fails", async () => {
    const comparisonEntered = deferred<void>();
    let comparisonSignal: AbortSignal | undefined;
    let comparisonAborted = false;
    const harness = createHarness(async (request, signal) => {
      if (request.graph.graphId === "graph") {
        await comparisonEntered.promise;
        throw new Error("head projection failed");
      }
      comparisonSignal = signal;
      comparisonEntered.resolve();
      return new Promise<GraphProjectWorkerResult>((_resolve, reject) => {
        const abort = () => {
          comparisonAborted = true;
          reject(signal.reason);
        };
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      });
    }, 2, {}, 2);
    harness.graphStore.publish(registration("comparison", {
      ...ARTIFACT,
      generatedAt: "2026-07-31T00:00:01.000Z",
    }));

    const prepared = await prepareInitialGraphProjectionCache(
      harness.ctx,
      "graph",
      "comparison",
      new AbortController().signal,
    );

    expect(comparisonAborted).toBe(true);
    expect(comparisonSignal?.aborted).toBe(true);
    expect(prepared).toMatchObject({
      evidence: {
        headKey: expect.stringMatching(/^[a-f0-9]{64}$/),
        comparisonKey: expect.stringMatching(/^[a-f0-9]{64}$/),
        ready: false,
      },
      warning: expect.stringContaining("partial PR review"),
    });
    expect(harness.cache.stats().pins).toBe(0);
  });

  it("bounds initial pair reservations and releases them on timeout, cancellation, and shutdown", async () => {
    let now = 0;
    const harness = createHarness(
      async (request) => writeWorkerResult(request),
      2,
      { maxEntries: 2, ttlMs: 10, now: () => now },
    );
    harness.graphStore.publish(registration("comparison", {
      ...ARTIFACT,
      generatedAt: "2026-07-31T00:00:01.000Z",
    }));

    const timed = await prepareInitialGraphProjectionCache(
      harness.ctx,
      "graph",
      "comparison",
      new AbortController().signal,
      { reservationTtlMs: 5 },
    );
    expect(timed.evidence.ready).toBe(true);
    await vi.waitFor(() => expect(harness.cache.stats().pins).toBe(0));
    now = 20;
    harness.cache.sweep();
    expect(harness.cache.stats().entries).toBe(0);

    const cancelledController = new AbortController();
    const cancelled = await prepareInitialGraphProjectionCache(
      harness.ctx,
      "graph",
      "comparison",
      cancelledController.signal,
    );
    expect(cancelled.evidence.ready).toBe(true);
    expect(harness.cache.stats().pins).toBe(2);
    cancelledController.abort();
    expect(harness.cache.stats().pins).toBe(0);
    now = 40;
    harness.cache.sweep();
    expect(harness.cache.stats().entries).toBe(0);

    const shutdownReserved = await prepareInitialGraphProjectionCache(
      harness.ctx,
      "graph",
      "comparison",
      new AbortController().signal,
    );
    expect(shutdownReserved.evidence.ready).toBe(true);
    harness.shutdown.abort();
    expect(harness.cache.stats().pins).toBe(0);
  });

  it("releases a partially acquired graph pair when the comparison graph is unavailable", async () => {
    const harness = createHarness(async (request) => writeWorkerResult(request));
    const prepared = await prepareInitialGraphProjectionCache(
      harness.ctx,
      "graph",
      "missing-comparison",
      new AbortController().signal,
    );

    expect(prepared.evidence).toMatchObject({ ready: false, headKey: null, comparisonKey: null });
    harness.graphStore.publish(registration("replacement", {
      ...ARTIFACT,
      generatedAt: "2026-07-31T00:00:01.000Z",
    }));
    expect(harness.graphStore.acquire("graph")).toBeUndefined();
  });
});

function createHarness(
  boundary: (
    request: GraphProjectWorkerRequest,
    signal: AbortSignal,
    options?: { signal?: AbortSignal; workerHeapMb?: number },
  ) => Promise<GraphProjectWorkerResult>,
  maxEntries = 1,
  projectCacheOptions: WebGraphProjectCacheOptions = {},
  maxConcurrentAnalyses = 1,
  repositoryBoundary: (
    request: Parameters<Context["repositoryAnalysis"]>[0],
    options: Parameters<Context["repositoryAnalysis"]>[1],
  ) => ReturnType<Context["repositoryAnalysis"]> = writeRepositoryAnalysisResult,
): {
  ctx: Context;
  graphStore: WebGraphStore;
  cache: WebGraphProjectCache;
  shutdown: AbortController;
} {
  const graphStore = new WebGraphStore({
    maxEntries,
    lowWaterEntries: 0,
    publicationHandoffTtlMs: 0,
  });
  graphStore.publish(registration("graph", ARTIFACT));
  const cache = new WebGraphProjectCache({ sweepIntervalMs: 60_000, ...projectCacheOptions });
  const coordinator = new AnalysisCoordinator({ maxConcurrentAnalyses });
  const shutdown = new AbortController();
  disposals.push(
    () => graphStore.dispose(),
    () => cache.dispose(),
    () => coordinator.close(),
    () => shutdown.abort(),
  );
  const ctx = {
    shutdownSignal: shutdown.signal,
    graphStore,
    graphProjectCache: cache,
    analysisCoordinator: coordinator,
    repositoryAnalysis: repositoryBoundary,
    graphProject: (request: GraphProjectWorkerRequest, options: { signal?: AbortSignal } = {}) =>
      boundary(request, options.signal ?? new AbortController().signal, options),
  } as unknown as Context;
  return { ctx, graphStore, cache, shutdown };
}

async function invoke(ctx: Context, value: unknown): Promise<TestResult> {
  const response = new TestResponse();
  await handleGraphProject(ctx, requestFor(value), response as unknown as ServerResponse);
  return response.result();
}

async function invokeSymbols(ctx: Context, id: string): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = new TestResponse();
  const request = new PassThrough() as PassThrough & IncomingMessage;
  request.end();
  await handleGraphSymbols(ctx, request, response as unknown as ServerResponse, id);
  return { status: response.status, json: JSON.parse(response.body()) as Record<string, unknown> };
}

async function invokeWarm(ctx: Context, value: unknown): Promise<TestResult> {
  const response = new TestResponse();
  await handleGraphProjectWarm(ctx, requestFor(value), response as unknown as ServerResponse);
  return response.result();
}

function invokeWarmStatus(ctx: Context, key: string): TestResult {
  const response = new TestResponse();
  handleGraphProjectWarmStatus(ctx, response as unknown as ServerResponse, key);
  return response.result();
}

function requestFor(value: unknown): IncomingMessage {
  const request = new PassThrough() as PassThrough & IncomingMessage;
  request.end(JSON.stringify(value));
  return request;
}

class TestResponse extends Writable {
  status = 0;
  readonly headers: Record<string, string> = {};
  readonly chunks: Buffer[] = [];

  writeHead(status: number, headers: Record<string, unknown> = {}): this {
    this.status = status;
    for (const [name, value] of Object.entries(headers)) {
      if (value !== undefined) this.headers[name.toLowerCase()] = String(value);
    }
    return this;
  }

  body(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }

  result(): TestResult {
    return {
      status: this.status,
      json: JSON.parse(this.body()) as Record<string, unknown>,
      headers: { ...this.headers },
    };
  }

  override _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.chunks.push(Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(chunk));
    callback();
  }
}

interface TestResult {
  status: number;
  json: Record<string, unknown>;
  headers: Record<string, string>;
}

function writeWorkerResult(request: GraphProjectWorkerRequest): GraphProjectWorkerResult {
  if (request.type === "symbols") {
    const payload = {
      version: 1,
      graphId: request.graph.graphId,
      generation: request.generation,
      complete: true,
      indexedSymbolCount: 0,
      totalSymbolCount: 0,
      symbols: [],
    };
    const written = writeOutput(request.symbolOutputPath!, payload);
    const topology = request.topologyOutputPath === null
      ? null
      : writeOutput(request.topologyOutputPath, {
          version: 1,
          graphId: request.graph.graphId,
          generation: request.generation,
          target: ARTIFACT.target,
          changedSinceBaseRef: null,
          seeds: ["a.ts"],
          files: [{
            path: "a.ts",
            fileId: PROVISIONAL_FILE_ID,
            neighbors: [],
            uncertain: false,
          }],
        });
    return {
      id: request.id,
      operation: "symbols",
      graphId: request.graph.graphId,
      generation: request.generation,
      projection: null,
      symbols: { ...written, count: 0 },
      topology: topology === null ? null : { ...topology, files: 1, adjacencyEntries: 0 },
    };
  }
  const projection: GraphProjectionV1 = {
    version: 1,
    graphId: request.graph.graphId,
    seedGraphId: request.graph.graphId,
    generation: request.generation,
    requestedDepth: request.projection!.requestedDepth,
    prefetchDepth: request.projection!.prefetchDepth,
    loadedDepth: request.projection!.requestedDepth,
    schemaVersion: ARTIFACT.schemaVersion,
    generatedAt: ARTIFACT.generatedAt,
    generator: ARTIFACT.generator,
    target: ARTIFACT.target,
    nodes: ARTIFACT.nodes,
    edges: [],
    rootFileIds: ["m:a"],
    readyFileIds: ["m:a"],
    loadedFileIds: ["m:a"],
    frontier: [{ fileId: "m:a", hasMore: false, completeThroughDepth: request.projection!.requestedDepth }],
    counts: { full: { nodes: 1, edges: 0, files: 1 }, slice: { nodes: 1, edges: 0, files: 1 } },
  };
  const written = writeOutput(request.projectionOutputPath!, projection);
  return {
    id: request.id,
    operation: request.type,
    graphId: request.graph.graphId,
    generation: request.generation,
    projection: {
      ...written,
      nodes: 1,
      edges: 0,
      files: 1,
      roots: 1,
      completeRoots: 1,
      loadedDepth: projection.loadedDepth,
    },
    symbols: null,
    topology: null,
  };
}

async function writeRepositoryAnalysisResult(
  request: Parameters<Context["repositoryAnalysis"]>[0],
  options: Parameters<Context["repositoryAnalysis"]>[1],
): ReturnType<Context["repositoryAnalysis"]> {
  const selection = request.initialGraph;
  if (selection?.lineage === undefined) throw new TypeError("test partial extraction requires lineage");
  const artifact: GraphArtifact = {
    ...PROVISIONAL_ARTIFACT,
    generatedAt: "2026-07-31T00:00:01.000Z",
    extensions: {
      prInitialGraph: {
        version: 1,
        complete: false,
        depth: selection.depth,
        seedFiles: [...(selection.seedFiles ?? [])],
        selectedFiles: [...(selection.selectedFiles ?? [])],
        frontierFiles: [...(selection.frontierFiles ?? [])],
      },
      prPartialGraph: { version: 1, ...selection.lineage },
    },
  };
  const written = writeOutput(options.artifactOutputPath, artifact);
  return {
    material: verifiedArtifactFile(options.artifactOutputPath, written.sha256, artifactSummary(artifact)),
    byteLength: written.bytes,
    summary: artifactSummary(artifact),
    target: artifact.target,
  } as Awaited<ReturnType<Context["repositoryAnalysis"]>>;
}

function writeOutput(path: string, value: unknown): { path: string; bytes: number; sha256: string } {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
  writeFileSync(path, bytes);
  return { path, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
}

function registration(
  id: string,
  artifact: GraphArtifact,
  projectionRootChunks?: readonly (readonly string[])[],
) {
  return {
    id,
    material: materializeValidatedArtifact(artifact),
    rawGraphPayload: artifact.extensions?.prInitialGraph === undefined
      ? "complete" as const
      : "projection-only" as const,
    metadata: {
      sourceRoot: "/workspace",
      ...(projectionRootChunks === undefined ? {} : { projectionRootChunks }),
      source: { kind: "path" as const },
      synthetic: { scenarios: [], sourceFingerprint: null, trust: null },
    },
  };
}

function githubRegistration(id: string, artifact: GraphArtifact) {
  return {
    ...registration(id, artifact),
    metadata: {
      ...registration(id, artifact).metadata,
      source: { kind: "github" as const, owner: "org", repo: "repo" },
    },
  };
}

function provisionalDescriptor(): WebGraphDescriptor {
  return {
    formatVersion: 1,
    id: PROVISIONAL_GRAPH_ID,
    byteDigest: "c".repeat(64),
    rawGraphPayload: "projection-only",
    summary: {
      schemaVersion: SCHEMA_VERSION,
      generatedAt: ARTIFACT.generatedAt,
      nodeCount: 20_000,
      edgeCount: 100_000,
    },
    sourceRoot: "/workspace",
    source: { kind: "github", owner: "org", repo: "repo" },
    synthetic: { scenarios: [], sourceFingerprint: null, trust: null },
  };
}

function body() {
  return {
    version: 1 as const,
    graphId: "graph",
    roots: { kind: "files" as const, fileIds: ["m:a"] },
    requestedDepth: 0,
    prefetchDepth: 0,
  };
}

function initialBody(graphId: string, seedGraphId: string) {
  return {
    version: 1 as const,
    graphId,
    roots: { kind: "changed-files" as const, seedGraphId },
    requestedDepth: 1,
    prefetchDepth: 3,
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

const ARTIFACT: GraphArtifact = {
  schemaVersion: SCHEMA_VERSION,
  generatedAt: "2026-07-31T00:00:00.000Z",
  generator: { name: "test", version: "1" },
  target: { name: "fixture", root: ".", language: "typescript" },
  nodes: [{
    id: "m:a",
    kind: "module",
    qualifiedName: "a",
    displayName: "a",
    location: { file: "a.ts", startLine: 1 },
  }],
  edges: [],
};

const PROVISIONAL_ARTIFACT: GraphArtifact = {
  ...ARTIFACT,
  extensions: {
    prInitialGraph: {
      version: 1,
      complete: false,
      depth: 1,
      seedFiles: ["a.ts"],
      selectedFiles: ["a.ts"],
      frontierFiles: [],
    },
  },
};
