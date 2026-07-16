import type { GraphArtifact } from "@meridian/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GraphProjectionClient,
  canonicalProjectionKey,
  canonicalizeProjectionRequest,
  type GraphProjectionRequest,
} from "./graphProjectionClient";
import { RecentAllocationBudget } from "../state/recentViewProjectionCache";
import type { GraphSymbolSearchRequest } from "./graphSymbolSearch";

const ARTIFACT: GraphArtifact = {
  schemaVersion: "1.1.0",
  generatedAt: "2026-07-14T00:00:00.000Z",
  generator: { name: "test", version: "1" },
  target: { name: "repo", root: ".", language: "typescript" },
  nodes: [{
    id: "ts:src",
    kind: "package",
    qualifiedName: "src",
    displayName: "src",
    location: { file: "src", startLine: 1 },
  }],
  edges: [],
};

const REQUEST: GraphProjectionRequest = {
  view: "modules",
  filePaths: [],
  focusIds: [],
  expandedIds: [],
  extraIds: [],
  depth: 1,
  radius: 0,
  includeTests: false,
};

afterEach(() => vi.unstubAllGlobals());

describe("GraphProjectionClient", () => {
  it("binds the browser-native fetch receiver when no transport is injected", async () => {
    const nativeLikeFetch = function (this: unknown): Promise<Response> {
      expect(this).toBe(globalThis);
      return Promise.resolve(jsonResponse(manifest("graph-1")));
    } as typeof fetch;
    vi.stubGlobal("fetch", nativeLikeFetch);

    const client = new GraphProjectionClient("/manifest", "/projection");
    await expect(client.loadManifest()).resolves.toMatchObject({ graphId: "graph-1" });
  });

  it("canonicalizes valid view keys so ordering and duplicates share one cache entry", () => {
    const left = canonicalProjectionKey("graph-1", {
      ...REQUEST,
      view: "review",
      filePaths: ["src/z.ts", "src/a.ts", "src/z.ts"],
      focusIds: ["ts:b", "ts:a", "ts:b"],
      expandedIds: ["ts:z", "ts:c"],
    });
    const right = canonicalProjectionKey("graph-1", {
      ...REQUEST,
      view: "review",
      filePaths: ["src/a.ts", "src/z.ts"],
      focusIds: ["ts:a", "ts:b"],
      expandedIds: ["ts:c", "ts:z"],
    });

    expect(left).toBe(right);
    expect(canonicalizeProjectionRequest({ ...REQUEST, focusIds: ["ts:b", "ts:a"] }).focusIds)
      .toEqual(["ts:a", "ts:b"]);
    expect(canonicalizeProjectionRequest({
      ...REQUEST,
      view: "review",
      filePaths: ["src/b.ts", "src/a.ts"],
    }).filePaths)
      .toEqual(["src/a.ts", "src/b.ts"]);
    expect(() => canonicalizeProjectionRequest({ ...REQUEST, focusIds: [""] }))
      .toThrow("contains an invalid graph id");
  });

  it("reads projections as ArrayBuffers, charges a conservative decoded weight, and reuses recent views", async () => {
    const bodies: string[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.includes("manifest")) return jsonResponse(manifest("graph-1"));
      const body = JSON.stringify(projectionEnvelope(requestFrom(init), { projectionId: "projection-a" }));
      bodies.push(body);
      return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
    });
    const client = new GraphProjectionClient("/api/graph/manifest?id=graph-1", "/api/graph/projection?id=graph-1", {
      fetch: fetchMock,
      residentExpansionFactor: 4,
      recentCache: { maxRecentEntries: 2, maxRecentBytes: 1024 * 1024 },
    });

    const overview = await client.activate(REQUEST);
    const focused = await client.activate({ ...REQUEST, focusIds: ["ts:src"] });
    const returned = await client.activate(REQUEST);

    expect(overview.serializedBytes).toBe(new TextEncoder().encode(bodies[0]!).byteLength);
    expect(overview.residentBytes).toBe(overview.serializedBytes * 4);
    expect(overview.index.nodesById.get("ts:src")?.displayName).toBe("src");
    expect(focused.key).not.toBe(overview.key);
    expect(returned).toBe(overview);
    // One manifest plus two distinct projection bodies; the return trip is an LRU hit.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("shares inactive projection eviction across independent clients", async () => {
    const budget = new RecentAllocationBudget({ maxRecentEntries: 1, maxRecentBytes: 1_000_000 });
    const calls = new Map<string, number>();
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input), "http://meridian.local");
      const graphId = url.searchParams.get("id")!;
      if (url.pathname.includes("manifest")) return jsonResponse(manifest(graphId));
      calls.set(graphId, (calls.get(graphId) ?? 0) + 1);
      return jsonResponse(projectionEnvelope(requestFrom(init), { projectionId: `${graphId}-${calls.get(graphId)}` }));
    });
    const first = new GraphProjectionClient("/manifest?id=first", "/projection?id=first", {
      fetch: fetchMock,
      recentBudget: budget,
    });
    const second = new GraphProjectionClient("/manifest?id=second", "/projection?id=second", {
      fetch: fetchMock,
      recentBudget: budget,
    });

    await first.activate(REQUEST);
    await first.activate({ ...REQUEST, focusIds: ["ts:src"] });
    expect(budget.inactiveEntryCount).toBe(1);
    await second.activate(REQUEST);
    await second.activate({ ...REQUEST, focusIds: ["ts:src"] });

    expect(budget.inactiveEntryCount).toBe(1);
    expect(calls).toEqual(new Map([["first", 2], ["second", 2]]));
    await first.activate(REQUEST);
    expect(calls.get("first")).toBe(3); // first's globally-evicted overview was fetched again.
    expect(budget.inactiveEntryCount).toBe(1);
  });

  it("charges a HEAD + merge-base review pair as one atomic shared allocation", async () => {
    const budget = new RecentAllocationBudget({ maxRecentEntries: 1, maxRecentBytes: 1_000_000 });
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input), "http://meridian.local");
      const graphId = url.searchParams.get("id") ?? "base";
      return url.pathname.includes("manifest")
        ? jsonResponse(manifest(graphId))
        : jsonResponse(projectionEnvelope(requestFrom(init), { projectionId: `p-${graphId}`, residentBytes: 10 }));
    });
    const client = new GraphProjectionClient("/manifest?id=base", "/projection?id=base", {
      fetch: fetchMock,
      recentBudget: budget,
    });
    const reviewRequest = { ...REQUEST, view: "review" as const, filePaths: ["src/a.ts"] };
    const pair = await client.activateReviewPair({
      head: { request: reviewRequest, endpoints: graphEndpoints("head") },
      mergeBase: { request: reviewRequest, endpoints: graphEndpoints("merge-base") },
    });

    await client.activate(REQUEST);
    expect(budget.inactiveEntryCount).toBe(1);
    expect(budget.inactiveResidentByteLength).toBe(pair.residentBytes);
    expect(client.activateCachedReview(pair.key)).toBe(pair);
    expect(budget.inactiveEntryCount).toBe(1); // The prior active overview replaced the pair's slot.

    // Moving away once more makes the pair inactive again; a different client's inactive view
    // evicts the complete pair, never one constituent side.
    await client.activate(REQUEST);
    const other = new GraphProjectionClient("/manifest?id=other", "/projection?id=other", {
      fetch: fetchMock,
      recentBudget: budget,
    });
    await other.activate(REQUEST);
    await other.activate({ ...REQUEST, focusIds: ["ts:src"] });

    expect(client.activateCachedReview(pair.key)).toBeUndefined();
    expect(client.activateCached(pair.head.key)).toBeUndefined();
    expect(client.activateCached(pair.mergeBase.key)).toBeUndefined();
    expect(budget.inactiveEntryCount).toBe(1);
  });

  it("honours server resident estimates when they exceed the default 3x response estimate", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => String(input).includes("manifest")
      ? jsonResponse(manifest("graph-1"))
      : jsonResponse(projectionEnvelope(requestFrom(init), { projectionId: "p", residentBytes: 99_000 })));
    const client = new GraphProjectionClient("/manifest", "/projection", { fetch: fetchMock });

    expect((await client.activate(REQUEST)).residentBytes).toBe(99_000);
  });

  it("uses direct endpoints with live shared signals independent of the subscriber signal", async () => {
    const seen: Array<{ url: string; signal: AbortSignal | null | undefined }> = [];
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      seen.push({ url: String(input), signal: init?.signal });
      return String(input).includes("manifest")
        ? jsonResponse(manifest("prepared-9"))
        : jsonResponse(projectionEnvelope(requestFrom(init), { projectionId: "review-p" }));
    });
    const client = new GraphProjectionClient(
      "http://meridian.local/api/graph/manifest?id=base",
      "http://meridian.local/api/graph/projection?id=base",
      { fetch: fetchMock },
    );
    const controller = new AbortController();

    await client.activate({ ...REQUEST, view: "review" }, {
      endpoints: {
        manifestUrl: "http://meridian.local/api/graph/manifest?id=prepared-9",
        projectionUrl: "http://meridian.local/api/graph/projection?id=prepared-9",
      },
      signal: controller.signal,
    });

    expect(seen.map(({ url }) => new URL(url).searchParams.get("id"))).toEqual(["prepared-9", "prepared-9"]);
    expect(seen[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(seen[0]?.signal).not.toBe(controller.signal);
    expect(seen[0]?.signal?.aborted).toBe(false);
    expect(seen[1]?.signal).toBeInstanceOf(AbortSignal);
    expect(seen[1]?.signal).not.toBe(controller.signal);
    expect(seen[1]?.signal?.aborted).toBe(false);
  });

  it("publishes HEAD and merge-base atomically as one byte-charged review cache entry", async () => {
    const projectionCalls: string[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input), "http://meridian.local");
      const graphId = url.searchParams.get("id") ?? "base";
      if (url.pathname.includes("manifest")) return jsonResponse(manifest(graphId));
      projectionCalls.push(graphId);
      return jsonResponse(projectionEnvelope(requestFrom(init), { projectionId: `p-${graphId}` }));
    });
    const client = new GraphProjectionClient("/manifest?id=base", "/projection?id=base", {
      fetch: fetchMock,
      residentExpansionFactor: 1,
      recentCache: { maxRecentEntries: 3, maxRecentBytes: 1 },
    });
    const reviewRequest = { ...REQUEST, view: "review" as const, filePaths: ["src/a.ts"] };
    const pair = await client.activateReviewPair({
      head: { request: reviewRequest, endpoints: graphEndpoints("head") },
      mergeBase: { request: reviewRequest, endpoints: graphEndpoints("merge-base") },
    });

    expect(pair.residentBytes).toBe(pair.head.residentBytes + pair.mergeBase.residentBytes);
    expect(pair.serializedBytes).toBe(pair.head.serializedBytes + pair.mergeBase.serializedBytes);
    expect(client.activeKey).toBe(pair.key);
    expect(client.activateCachedReview(pair.key)).toBe(pair);
    expect(client.activateCached(pair.key)).toBeUndefined();
    expect(client.activeKey).toBe(pair.key);

    // The one-byte inactive budget cannot retain the composite. Returning after another view
    // therefore reloads both sides instead of hiding an uncharged comparison graph in memory.
    await client.activate(REQUEST);
    await client.activateReviewPair({
      head: { request: reviewRequest, endpoints: graphEndpoints("head") },
      mergeBase: { request: reviewRequest, endpoints: graphEndpoints("merge-base") },
    });
    expect(projectionCalls).toEqual(["head", "merge-base", "base", "head", "merge-base"]);
  });

  it("singleflights duplicate single and composite reads while aborting only one subscriber", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const projectionCalls = new Map<string, number>();
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input), "http://meridian.local");
      const graphId = url.searchParams.get("id") ?? "base";
      if (url.pathname.includes("manifest")) return jsonResponse(manifest(graphId));
      projectionCalls.set(graphId, (projectionCalls.get(graphId) ?? 0) + 1);
      await gate;
      return jsonResponse(projectionEnvelope(requestFrom(init), { projectionId: `p-${graphId}` }));
    });
    const client = new GraphProjectionClient("/manifest?id=base", "/projection?id=base", { fetch: fetchMock });
    const canceled = new AbortController();
    const abandoned = client.activate(REQUEST, { signal: canceled.signal });
    const retained = client.activate(REQUEST);
    await vi.waitFor(() => expect(projectionCalls.get("base")).toBe(1));
    canceled.abort();
    release();
    await expect(abandoned).rejects.toMatchObject({ name: "AbortError" });
    await expect(retained).resolves.toMatchObject({ graphId: "base" });

    let releasePair!: () => void;
    const pairGate = new Promise<void>((resolve) => { releasePair = resolve; });
    // A second client keeps this assertion independent from the already-cached single view.
    const pairFetch = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input), "http://meridian.local");
      const graphId = url.searchParams.get("id")!;
      if (url.pathname.includes("manifest")) return jsonResponse(manifest(graphId));
      await pairGate;
      return jsonResponse(projectionEnvelope(requestFrom(init), { projectionId: `p-${graphId}` }));
    });
    const pairClient = new GraphProjectionClient("/manifest?id=base", "/projection?id=base", { fetch: pairFetch });
    const reviewRequest = { ...REQUEST, view: "review" as const, filePaths: ["src/a.ts"] };
    const pairOptions = {
      head: { request: reviewRequest, endpoints: graphEndpoints("head") },
      mergeBase: { request: reviewRequest, endpoints: graphEndpoints("merge-base") },
    };
    const first = pairClient.activateReviewPair(pairOptions);
    const second = pairClient.activateReviewPair(pairOptions);
    const headOnly = pairClient.activate(reviewRequest, { endpoints: graphEndpoints("head") });
    await vi.waitFor(() => expect(pairFetch).toHaveBeenCalledTimes(4)); // two manifests + one POST per side
    releasePair();
    const pair = await first;
    expect(pair).toBe(await second);
    expect(await headOnly).toBe(pair.head);
    expect(pairClient.activeKey).toBe(pair.key);

    // A constituent key aliases the composite allocation. It can navigate back to HEAD without
    // retaining or activating a separately charged copy of the same decoded side.
    await pairClient.activate(REQUEST);
    expect(pairClient.activateCached(pair.head.key)).toBe(pair.head);
    expect(pairClient.activeKey).toBe(pair.key);
  });

  it("keeps a shared HEAD active when the pending merge-base side rejects", async () => {
    let rejectMergeBase!: (reason: unknown) => void;
    const mergeBaseResponse = new Promise<Response>((_resolve, reject) => { rejectMergeBase = reject; });
    const projectionCalls = new Map<string, number>();
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input), "http://meridian.local");
      const graphId = url.searchParams.get("id") ?? "base";
      if (url.pathname.includes("manifest")) return jsonResponse(manifest(graphId));
      projectionCalls.set(graphId, (projectionCalls.get(graphId) ?? 0) + 1);
      if (graphId === "merge-base") return mergeBaseResponse;
      return jsonResponse(projectionEnvelope(requestFrom(init), { projectionId: `p-${graphId}` }));
    });
    const client = new GraphProjectionClient("/manifest?id=base", "/projection?id=base", {
      fetch: fetchMock,
      recentCache: { maxRecentEntries: 1, maxRecentBytes: 1024 * 1024 },
    });
    const reviewRequest = { ...REQUEST, view: "review" as const, filePaths: ["src/a.ts"] };
    const pairRead = client.activateReviewPair({
      head: { request: reviewRequest, endpoints: graphEndpoints("head") },
      mergeBase: { request: reviewRequest, endpoints: graphEndpoints("merge-base") },
    });
    const pairOutcome = pairRead.then(
      () => new Error("expected the review pair to reject"),
      (error: unknown) => error,
    );
    const head = await client.activate(reviewRequest, { endpoints: graphEndpoints("head") });

    expect(client.activeKey).toBe(head.key);
    expect(projectionCalls.get("head")).toBe(1);
    rejectMergeBase(new Error("merge-base projection failed"));
    await expect(pairOutcome).resolves.toMatchObject({ message: "merge-base projection failed" });
    expect(client.activeKey).toBe(head.key);
    expect(client.activateCached(head.key)).toBe(head);

    // The failed pair retained no hidden composite. HEAD remains the single charged navigation
    // unit and survives one round trip through the configured one-entry inactive cache.
    await client.activate(REQUEST);
    expect(client.activateCached(head.key)).toBe(head);
    expect(client.activeKey).toBe(head.key);
    expect(projectionCalls).toEqual(new Map([["head", 1], ["merge-base", 1], ["base", 1]]));
  });

  it("aborts the shared transport after its final subscriber leaves", async () => {
    let transportSignal: AbortSignal | null = null;
    let projectionStarted!: () => void;
    const started = new Promise<void>((resolve) => { projectionStarted = resolve; });
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      if (String(input).includes("manifest")) return jsonResponse(manifest("graph-1"));
      transportSignal = init?.signal as AbortSignal;
      projectionStarted();
      return new Promise<Response>((_resolve, reject) => {
        transportSignal!.addEventListener("abort", () => reject(transportSignal!.reason), { once: true });
      });
    });
    const client = new GraphProjectionClient("/manifest", "/projection", { fetch: fetchMock });
    const first = new AbortController();
    const second = new AbortController();
    const firstRead = client.activate(REQUEST, { signal: first.signal });
    const secondRead = client.activate(REQUEST, { signal: second.signal });
    await started;

    first.abort();
    await expect(firstRead).rejects.toMatchObject({ name: "AbortError" });
    expect(transportSignal!.aborted).toBe(false);
    second.abort();
    await expect(secondRead).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(transportSignal!.aborted).toBe(true));
    expect(fetchMock.mock.calls.filter(([input]) => !String(input).includes("manifest"))).toHaveLength(1);
  });

  it("fails closed on unsupported manifests, incomplete slices, mismatched requests, and oversized bodies", async () => {
    const unsupported = new GraphProjectionClient("/manifest", "/projection", {
      fetch: async () => jsonResponse({ version: 1, graphId: "old" }),
    });
    await expect(unsupported.activate(REQUEST)).rejects.toThrow("expected version 3");

    const skeletal = new GraphProjectionClient("/manifest", "/projection", {
      fetch: async () => jsonResponse({ version: 3, graphId: "skeletal" }),
    });
    await expect(skeletal.activate(REQUEST)).rejects.toThrow("contentId must be a 64-character hex digest");

    const incomplete = new GraphProjectionClient("/manifest", "/projection", {
      fetch: async (input, init) => String(input).includes("manifest")
        ? jsonResponse(manifest("graph-1"))
        : jsonResponse(projectionEnvelope(requestFrom(init), {
            completeness: { complete: false, reasons: ["node-limit"], omittedNodes: 1, omittedEdges: 0 },
          })),
    });
    await expect(incomplete.activate(REQUEST)).rejects.toThrow("graph projection is incomplete: node-limit");

    const mismatch = new GraphProjectionClient("/manifest", "/projection", {
      fetch: async (input) => String(input).includes("manifest")
        ? jsonResponse(manifest("graph-1"))
        : jsonResponse(projectionEnvelope({ ...REQUEST, focusIds: ["wrong"] })),
    });
    await expect(mismatch.activate(REQUEST)).rejects.toThrow("request identity does not match");

    const bounded = new GraphProjectionClient("/manifest", "/projection", {
      fetch: async (input, init) => String(input).includes("manifest")
        ? jsonResponse(manifest("graph-1"))
        : new Response(JSON.stringify(projectionEnvelope(requestFrom(init))), {
            status: 200,
            headers: { "content-type": "application/json", "content-length": "65537" },
          }),
    });
    await expect(bounded.activate({ ...REQUEST, maxResponseBytes: 65_536 }))
      .rejects.toThrow("exceeds the 65536-byte view limit");
  });

  it("searches the immutable graph catalog through the projection endpoint's strict v1 sibling", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input), "http://meridian.local");
      if (url.pathname.endsWith("/manifest")) return jsonResponse(manifest("graph-1"));
      expect(url.pathname).toBe("/api/graph/search");
      expect(url.searchParams.get("id")).toBe("graph-1");
      expect(JSON.parse(String(init?.body))).toEqual({
        version: 1,
        query: "src",
        mode: "map",
        scope: "public",
      });
      return jsonResponse(symbolSearchResponse("graph-1"));
    });
    const client = new GraphProjectionClient(
      "/api/graph/manifest?id=graph-1",
      "/api/graph/projection?id=graph-1",
      { fetch: fetchMock },
    );
    const request = {
      version: 1,
      query: "src",
      mode: "map",
      scope: "public",
      legacyLimit: 500,
    } as unknown as GraphSymbolSearchRequest;

    await expect(client.searchSymbols(request)).resolves.toMatchObject({
      version: 1,
      graphId: "graph-1",
      contentId: "0".repeat(64),
      results: [{ id: "ts:src", displayName: "src" }],
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects NUL search queries before transport and unknown response fields after transport", async () => {
    const neverFetch = vi.fn<typeof fetch>();
    const client = new GraphProjectionClient("/manifest", "/projection", { fetch: neverFetch });
    await expect(client.searchSymbols({
      version: 1,
      query: "src\0hidden",
      mode: "map",
      scope: "public",
    })).rejects.toThrow("query exceeds 256 UTF-8 bytes");
    expect(neverFetch).not.toHaveBeenCalled();

    const strictClient = new GraphProjectionClient("/manifest", "/projection", {
      fetch: async (input) => String(input).includes("manifest")
        ? jsonResponse(manifest("graph-1"))
        : jsonResponse({ ...symbolSearchResponse("graph-1"), legacyGraphId: "graph-1" }),
    });
    await expect(strictClient.searchSymbols({
      version: 1,
      query: "src",
      mode: "map",
      scope: "public",
    })).rejects.toThrow("fields do not match the v1 contract");
  });

  it("never commits a projection if its navigation signal aborts while the body is decoding", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      if (String(input).includes("manifest")) return jsonResponse(manifest("graph-1"));
      controller.abort();
      return jsonResponse(projectionEnvelope(requestFrom(init), { projectionId: "late" }));
    });
    const client = new GraphProjectionClient("/manifest", "/projection", { fetch: fetchMock });

    await expect(client.activate(REQUEST, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(client.activeKey).toBeUndefined();
  });

  it("rejects a raw GraphArtifact response instead of accepting the removed compatibility shape", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => String(input).includes("manifest")
      ? jsonResponse(manifest("graph-1"))
      : jsonResponse(ARTIFACT));
    const client = new GraphProjectionClient("/manifest", "/projection", { fetch: fetchMock });

    await expect(client.activate(REQUEST)).rejects.toThrow("artifact is required");
  });

  it("bounds and promotes the per-graph manifest cache", async () => {
    const manifestCalls = new Map<string, number>();
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input), "http://meridian.local");
      const graphId = url.searchParams.get("id") ?? "base";
      if (url.pathname.includes("manifest")) {
        manifestCalls.set(graphId, (manifestCalls.get(graphId) ?? 0) + 1);
        return jsonResponse(manifest(graphId));
      }
      return jsonResponse(projectionEnvelope(requestFrom(init), { projectionId: `p-${graphId}` }));
    });
    const client = new GraphProjectionClient("/manifest?id=base", "/projection?id=base", { fetch: fetchMock });

    for (let index = 0; index < 16; index += 1) {
      await client.loadManifest({ endpoints: graphEndpoints(`graph-${index}`) });
    }
    // Promote graph-0, so graph-1 becomes the LRU victim when a seventeenth id arrives.
    await client.loadManifest({ endpoints: graphEndpoints("graph-0") });
    await client.loadManifest({ endpoints: graphEndpoints("graph-16") });
    await client.loadManifest({ endpoints: graphEndpoints("graph-0") });
    await client.loadManifest({ endpoints: graphEndpoints("graph-1") });

    expect(manifestCalls.get("graph-0")).toBe(1);
    expect(manifestCalls.get("graph-1")).toBe(2);
    expect(manifestCalls.size).toBe(17);
  });

  it("singleflights manifest reads and aborts transport only after the final subscriber leaves", async () => {
    let transportSignal: AbortSignal | undefined;
    let manifestStarted!: () => void;
    const started = new Promise<void>((resolve) => { manifestStarted = resolve; });
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      transportSignal = init?.signal as AbortSignal;
      manifestStarted();
      return new Promise<Response>((_resolve, reject) => {
        transportSignal!.addEventListener("abort", () => reject(transportSignal!.reason), { once: true });
      });
    });
    const client = new GraphProjectionClient("/manifest", "/projection", { fetch: fetchMock });
    const first = new AbortController();
    const second = new AbortController();
    const firstRead = client.loadManifest({ signal: first.signal });
    const secondRead = client.loadManifest({ signal: second.signal });
    await started;

    first.abort();
    await expect(firstRead).rejects.toMatchObject({ name: "AbortError" });
    expect(transportSignal?.aborted).toBe(false);
    second.abort();
    await expect(secondRead).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(transportSignal?.aborted).toBe(true));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("bounds canceled manifest transports and never duplicates an abandoned live key", async () => {
    const transportSignals: AbortSignal[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      transportSignals.push(init?.signal as AbortSignal);
      // Model a broken transport that ignores cancellation. Its live reads must still remain
      // bounded, and the client must not start a duplicate while the abandoned flight is pending.
      return new Promise<Response>(() => undefined);
    });
    const client = new GraphProjectionClient("/manifest", "/projection", { fetch: fetchMock });

    for (let index = 0; index < 16; index += 1) {
      const controller = new AbortController();
      const read = client.loadManifest({
        endpoints: graphEndpoints(`stalled-${index}`),
        signal: controller.signal,
      });
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(index + 1));
      controller.abort();
      await expect(read).rejects.toMatchObject({ name: "AbortError" });
    }

    expect(transportSignals).toHaveLength(16);
    expect(transportSignals.every((signal) => signal.aborted)).toBe(true);
    await expect(client.loadManifest({ endpoints: graphEndpoints("overflow") }))
      .rejects.toThrow("too many graph manifests are already in flight");
    await expect(client.loadManifest({ endpoints: graphEndpoints("stalled-0") }))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).toHaveBeenCalledTimes(16);
  });
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function requestFrom(init: RequestInit | undefined): GraphProjectionRequest {
  return canonicalizeProjectionRequest(JSON.parse(String(init?.body)) as GraphProjectionRequest);
}

function projectionEnvelope(
  request: GraphProjectionRequest,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    projectionId: "projection",
    request: canonicalizeProjectionRequest(request),
    artifact: ARTIFACT,
    childCounts: {},
    completeness: { complete: true, reasons: [], omittedNodes: 0, omittedEdges: 0 },
    residentBytes: 1,
    ...overrides,
  };
}

function graphEndpoints(graphId: string) {
  return {
    manifestUrl: `/manifest?id=${graphId}`,
    projectionUrl: `/projection?id=${graphId}`,
  };
}

function symbolSearchResponse(graphId: string) {
  return {
    version: 1,
    graphId,
    contentId: "0".repeat(64),
    mode: "map",
    scope: "public",
    scopeCounts: { public: 1, all: 1, private: 0 },
    results: [{
      id: "ts:src",
      displayName: "src",
      qualifiedName: "src",
      file: "src",
      kind: "package",
      isPrivateMethod: false,
      stepCount: null,
    }],
  };
}

function manifest(graphId: string) {
  return {
    version: 3,
    graphId,
    contentId: "0".repeat(64),
    graphSummary: {
      schemaVersion: ARTIFACT.schemaVersion,
      generatedAt: ARTIFACT.generatedAt,
      nodeCount: ARTIFACT.nodes.length,
      edgeCount: ARTIFACT.edges.length,
    },
    defaultView: canonicalizeProjectionRequest(REQUEST),
  };
}
