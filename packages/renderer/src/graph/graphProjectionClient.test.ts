import {
  GRAPH_PROJECTION_MAX_REQUEST_BYTES,
  buildReachabilityProjection,
  deriveGraphStructure,
  graphProjectionIdentityPreimage,
  type GraphArtifact,
} from "@meridian/core";
import { deriveSerializedServiceTopology } from "@meridian/design-metrics";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GraphProjectionClient,
  canonicalProjectionKey,
  canonicalizeProjectionRequest,
  type GraphProjectionReviewPairOptions,
  type LoadedReviewProjection,
  type GraphProjectionRequest,
} from "./graphProjectionClient";
import { estimateGraphPresentationResidentBytes } from "./graphIndex";
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
  version: 6,
  view: "modules",
  filePaths: [],
  reviewCursor: null,
  focusIds: [],
  expandedIds: [],
  extraIds: [],
  causalIds: [],
  serviceExpandedLeadIds: [],
  depth: 1,
  includeTests: false,
  includeReachability: false,
  maxNodes: 5_000,
  maxEdges: 20_000,
  maxResponseBytes: 16 * 1024 * 1024,
};

async function commitReviewPair(
  client: GraphProjectionClient,
  options: GraphProjectionReviewPairOptions,
): Promise<LoadedReviewProjection> {
  const staged = await client.stageReviewPair(options);
  try {
    return staged.commit();
  } finally {
    staged.release();
  }
}

async function commitProjection(
  client: GraphProjectionClient,
  request: GraphProjectionRequest,
  options: Parameters<GraphProjectionClient["stage"]>[1],
) {
  const staged = await client.stage(request, options);
  try {
    return staged.commit();
  } finally {
    staged.release();
  }
}

function commitCachedProjection(client: GraphProjectionClient, key: string) {
  const staged = client.stageCached(key);
  if (staged === undefined) return undefined;
  try {
    return staged.commit();
  } finally {
    staged.release();
  }
}

const BASE_ENDPOINTS = {
  graphId: "graph-1",
  manifestUrl: "/manifest?id=graph-1",
  projectionUrl: "/projection?id=graph-1",
  searchUrl: "/search?id=graph-1",
};

const GRAPH_ONE_API_ENDPOINTS = {
  graphId: "graph-1",
  manifestUrl: "/api/graph/manifest?id=graph-1",
  projectionUrl: "/api/graph/projection?id=graph-1",
  searchUrl: "/api/graph/search?id=graph-1",
};

afterEach(() => vi.unstubAllGlobals());

describe("GraphProjectionClient", () => {
  it("binds the browser-native fetch receiver when no transport is injected", async () => {
    const nativeLikeFetch = function (this: unknown): Promise<Response> {
      expect(this).toBe(globalThis);
      return Promise.resolve(jsonResponse(manifest("graph-1")));
    } as typeof fetch;
    vi.stubGlobal("fetch", nativeLikeFetch);

    const client = new GraphProjectionClient();
    await expect(client.loadManifest({ endpoints: BASE_ENDPOINTS }))
      .resolves.toMatchObject({ graphId: "graph-1" });
  });

  it("rejects a manifest outside the endpoint capability before projection or cache publication", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse(manifest("graph-2")));
    const client = new GraphProjectionClient({ fetch: fetchMock });

    await expect(commitProjection(client, REQUEST, { endpoints: GRAPH_ONE_API_ENDPOINTS }))
      .rejects.toThrow("manifest identity mismatch: expected 'graph-1', received 'graph-2'");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(client.activeKey).toBeUndefined();

    await expect(client.loadManifest({
      endpoints: { ...GRAPH_ONE_API_ENDPOINTS, graphId: "graph-2" },
    })).resolves.toMatchObject({ graphId: "graph-2" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
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
    expect(() => canonicalizeProjectionRequest({
      ...REQUEST,
      causalIds: Array.from({ length: 2_000 }, (_, index) => `${index}:${"x".repeat(140)}`),
    })).toThrow("causalIds exceeds its byte limit");
  });

  it("accepts the exact canonical request byte ceiling and rejects the next byte before any flight", async () => {
    const exact = projectionRequestWithExactBytes(GRAPH_PROJECTION_MAX_REQUEST_BYTES);
    const oversized = projectionRequestWithExactBytes(GRAPH_PROJECTION_MAX_REQUEST_BYTES + 1);
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      if (String(input).includes("manifest")) return jsonResponse(manifest("graph-1"));
      expect(new TextEncoder().encode(String(init?.body)).byteLength)
        .toBe(GRAPH_PROJECTION_MAX_REQUEST_BYTES);
      return new Response("busy", { status: 503 });
    });
    const client = new GraphProjectionClient({ fetch: fetchMock });

    expect(new TextEncoder().encode(JSON.stringify(canonicalizeProjectionRequest(exact))).byteLength)
      .toBe(GRAPH_PROJECTION_MAX_REQUEST_BYTES);
    expect(JSON.stringify(exact)).toContain("é");
    expect(JSON.stringify(exact).length).toBeLessThan(GRAPH_PROJECTION_MAX_REQUEST_BYTES);
    await expect(client.stage(exact, { endpoints: BASE_ENDPOINTS }))
      .rejects.toThrow("graph projection fetch failed (503)");
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await expect(client.stage(oversized, { endpoints: graphEndpoints("oversized") }))
      .rejects.toThrow(`exceeds the ${GRAPH_PROJECTION_MAX_REQUEST_BYTES}-byte UTF-8 limit`);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reads projections as ArrayBuffers, charges a conservative decoded weight, and reuses recent views", async () => {
    const bodies: string[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.includes("manifest")) return jsonResponse(manifest("graph-1"));
      const envelope = await projectionEnvelope(requestFrom(init));
      const body = JSON.stringify(envelope);
      bodies.push(body);
      return jsonResponse(envelope);
    });
    const client = new GraphProjectionClient({
      fetch: fetchMock,
      residentExpansionFactor: 4,
      recentCache: { maxRecentEntries: 2, maxRecentBytes: 1024 * 1024 },
    });

    const overview = await commitProjection(client, REQUEST, { endpoints: GRAPH_ONE_API_ENDPOINTS });
    const focused = await commitProjection(client,
      { ...REQUEST, focusIds: ["ts:src"] },
      { endpoints: GRAPH_ONE_API_ENDPOINTS },
    );
    const returned = await commitProjection(client, REQUEST, { endpoints: GRAPH_ONE_API_ENDPOINTS });

    expect(overview.serializedBytes).toBe(new TextEncoder().encode(bodies[0]!).byteLength);
    expect(overview.residentBytes).toBe(overview.serializedBytes * 4);
    expect(overview.index.nodesById.get("ts:src")?.displayName).toBe("src");
    expect(focused.key).not.toBe(overview.key);
    expect(returned).toBe(overview);
    // One manifest plus two distinct projection bodies; the return trip is an LRU hit.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("preserves authoritative hierarchy and revision summaries without hydrating omitted descendants", async () => {
    const fullArtifact: GraphArtifact = {
      ...ARTIFACT,
      nodes: [
        { ...ARTIFACT.nodes[0]! },
        {
          id: "ts:src/services",
          kind: "package",
          qualifiedName: "src.services",
          displayName: "services",
          parentId: "ts:src",
          location: { file: "src/services", startLine: 1 },
        },
        {
          id: "ts:src/services/orders.ts",
          kind: "module",
          qualifiedName: "src.services.orders",
          displayName: "orders.ts",
          parentId: "ts:src/services",
          location: { file: "src/services/orders.ts", startLine: 1 },
        },
      ],
    };
    const structure = deriveGraphStructure(fullArtifact.nodes, fullArtifact.edges);
    const projectedArtifact = { ...fullArtifact, nodes: fullArtifact.nodes.slice(0, 2) };
    const projectedHierarchy = new Map(projectedArtifact.nodes.map((node) => [
      node.id,
      structure.hierarchyById.get(node.id)!,
    ]));
    const manifestValue = {
      ...manifest("graph-1"),
      graphSummary: {
        schemaVersion: fullArtifact.schemaVersion,
        generatedAt: fullArtifact.generatedAt,
        nodeCount: fullArtifact.nodes.length,
        edgeCount: fullArtifact.edges.length,
      },
      repositorySummary: structure.repositorySummary,
    };
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => String(input).includes("manifest")
      ? jsonResponse(manifestValue)
      : projectionResponse(requestFrom(init), {
          artifact: projectedArtifact,
          hierarchy: {
            moduleOverviewRootIds: ["ts:src"],
            nodes: Object.fromEntries(projectedHierarchy),
          },
          viewFacts: { moduleOverview: structure.moduleOverview, service: null, review: null },
        }));
    const client = new GraphProjectionClient({ fetch: fetchMock });

    const projection = await commitProjection(client, REQUEST, { endpoints: BASE_ENDPOINTS });

    expect(projection.index.nodesById.has("ts:src/services/orders.ts")).toBe(false);
    expect(projection.index.structure.hierarchyById.get("ts:src/services")).toMatchObject({
      descendantSourceFileCount: 1,
      childKindCounts: { module: 1 },
    });
    expect(projection.index.structure.repositorySummary).toEqual({
      overviewPackageCount: 1,
      sourceFileCount: 1,
      testSourceFileCount: 0,
    });
    expect(projection.index.graphSummary.nodeCount).toBe(3);
  });

  it("hydrates strict Service facts and view-scoped reachability without marking a projection complete", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => String(input).includes("manifest")
      ? jsonResponse(manifest("graph-1"))
      : projectionResponse(requestFrom(init)));
    const client = new GraphProjectionClient({ fetch: fetchMock });

    const service = await commitProjection(client,
      { ...REQUEST, view: "service" },
      { endpoints: BASE_ENDPOINTS },
    );
    const reachability = await commitProjection(client,
      { ...REQUEST, includeReachability: true },
      { endpoints: BASE_ENDPOINTS },
    );

    expect(service.index.serviceTopology).not.toBeNull();
    expect(service.index.artifactComplete).toBe(false);
    expect(service.reachability).toBeNull();
    expect(reachability.reachability).not.toBeNull();
    expect(reachability.index.serviceTopology).toBeNull();
  });

  it("rejects view facts on the wrong lens and reachability paint for omitted nodes", async () => {
    const wrongView = new GraphProjectionClient({
      fetch: async (input, init) => String(input).includes("manifest")
        ? jsonResponse(manifest("graph-1"))
        : projectionResponse(requestFrom(init), {
            viewFacts: {
              moduleOverview: deriveGraphStructure(ARTIFACT.nodes, ARTIFACT.edges).moduleOverview,
              service: deriveSerializedServiceTopology(ARTIFACT.nodes, ARTIFACT.edges),
              review: null,
            },
          }),
    });
    await expect(commitProjection(wrongView, REQUEST, { endpoints: BASE_ENDPOINTS })).rejects.toThrow(
      "service topology does not match the requested view",
    );

    const badPaint = new GraphProjectionClient({
      fetch: async (input, init) => String(input).includes("manifest")
        ? jsonResponse(manifest("graph-1"))
        : projectionResponse(requestFrom(init), {
            analysis: {
              reachability: {
                summary: {
                  callables: 0,
                  covered: 0,
                  indirect: 0,
                  uncovered: 0,
                  percent: 0,
                  testNodes: 0,
                  unresolvedFromTests: 0,
                },
                worstRows: [],
                leaves: {
                  omitted: {
                    status: "uncovered",
                    distance: null,
                    directTestCallers: [],
                    reason: { kind: "never-called", callers: [] },
                  },
                },
                containers: {},
              },
            },
          }),
    });
    await expect(commitProjection(badPaint,
      { ...REQUEST, includeReachability: true },
      { endpoints: BASE_ENDPOINTS },
    ))
      .rejects.toThrow("reachability paint references an omitted node");
  });

  it("hydrates a zero-node review overview and one exact file beyond the first bounded page", async () => {
    const files = Array.from({ length: 65 }, (_value, index) => ({
      index,
      path: `src/${String(index).padStart(3, "0")}.ts`,
      status: "modified" as const,
    }));
    const statusCounts = { added: 0, modified: files.length, deleted: 0, renamed: 0 };
    const overviewRequest = {
      ...REQUEST,
      view: "review" as const,
      filePaths: [],
      reviewCursor: null,
    };
    const emptyArtifact: GraphArtifact = { ...ARTIFACT, nodes: [], edges: [] };
    const overview = new GraphProjectionClient({
      fetch: async (input, init) => String(input).includes("manifest")
        ? jsonResponse(manifest("review-overview"))
        : projectionResponse(requestFrom(init), {
            artifact: emptyArtifact,
            viewFacts: {
              moduleOverview: null,
              service: null,
              review: {
                contextId: "c".repeat(64),
                side: "head",
                totalFiles: files.length,
                statusCounts,
                pageCount: 2,
                page: {
                  index: 0,
                  entries: files.slice(0, 64),
                  statusCounts: { added: 0, modified: 64, deleted: 0, renamed: 0 },
                  previousCursor: null,
                  nextCursor: "page:1",
                },
                selection: null,
              },
            },
          }),
    });
    const loadedOverview = await commitProjection(overview, overviewRequest, {
      endpoints: graphEndpoints("review-overview"),
    });
    expect(loadedOverview.artifact.nodes).toEqual([]);
    expect(loadedOverview.review?.page?.entries).toHaveLength(64);
    expect(loadedOverview.review?.page?.nextCursor).toBe("page:1");

    const selectedEntry = files[64]!;
    const selectedArtifact: GraphArtifact = {
      ...ARTIFACT,
      nodes: [{ ...ARTIFACT.nodes[0]!, id: "ts:selected", location: { file: selectedEntry.path, startLine: 1 } }],
      edges: [],
    };
    const fileRequest = { ...overviewRequest, reviewCursor: "file:64" };
    const selected = new GraphProjectionClient({
      fetch: async (input, init) => String(input).includes("manifest")
        ? jsonResponse(manifest("review-file"))
        : projectionResponse(requestFrom(init), {
            artifact: selectedArtifact,
            viewFacts: {
              moduleOverview: null,
              service: null,
              review: {
                contextId: "c".repeat(64),
                side: "head",
                totalFiles: files.length,
                statusCounts,
                pageCount: 2,
                page: null,
                selection: {
                  index: 64,
                  entry: selectedEntry,
                  graphPath: selectedEntry.path,
                  graphMatched: true,
                },
              },
            },
          }),
    });
    const loadedFile = await commitProjection(selected, fileRequest, {
      endpoints: graphEndpoints("review-file"),
    });
    expect(loadedFile.review?.selection).toMatchObject({ index: 64, graphMatched: true });
    expect(loadedFile.artifact.nodes.map((node) => node.location?.file)).toEqual([selectedEntry.path]);
  });

  it("binds review graphMatched and renamed paths to the decoded artifact and comparison side", async () => {
    const request = {
      ...REQUEST,
      view: "review" as const,
      filePaths: [],
      reviewCursor: "file:0",
    };
    const renamedEntry = {
      index: 0,
      path: "src/new.ts",
      status: "renamed" as const,
      previousPath: "src/old.ts",
    };
    const baseArtifact: GraphArtifact = {
      ...ARTIFACT,
      nodes: [{ ...ARTIFACT.nodes[0]!, location: { file: "src/old.ts", startLine: 1 } }],
      edges: [],
    };
    const facts = (graphMatched: boolean, graphPath: string | null = "src/old.ts") => ({
      moduleOverview: null,
      service: null,
      review: {
        contextId: "d".repeat(64),
        side: "mergeBase",
        totalFiles: 1,
        statusCounts: { added: 0, modified: 0, deleted: 0, renamed: 1 },
        pageCount: 1,
        page: null,
        selection: { index: 0, entry: renamedEntry, graphPath, graphMatched },
      },
    });
    const valid = new GraphProjectionClient({
      fetch: async (input, init) => String(input).includes("manifest")
        ? jsonResponse(manifest("renamed-base"))
        : projectionResponse(requestFrom(init), { artifact: baseArtifact, viewFacts: facts(true) }),
    });
    await expect(commitProjection(valid, request, { endpoints: graphEndpoints("renamed-base") }))
      .resolves.toMatchObject({ review: { selection: { graphPath: "src/old.ts", graphMatched: true } } });

    const falseAgainstArtifact = new GraphProjectionClient({
      fetch: async (input, init) => String(input).includes("manifest")
        ? jsonResponse(manifest("renamed-false"))
        : projectionResponse(requestFrom(init), { artifact: baseArtifact, viewFacts: facts(false) }),
    });
    await expect(commitProjection(falseAgainstArtifact, request, { endpoints: graphEndpoints("renamed-false") }))
      .rejects.toThrow("graphMatched contradicts the decoded artifact");

    const trueAgainstEmpty = new GraphProjectionClient({
      fetch: async (input, init) => String(input).includes("manifest")
        ? jsonResponse(manifest("renamed-empty"))
        : projectionResponse(requestFrom(init), {
            artifact: { ...baseArtifact, nodes: [] },
            viewFacts: facts(true),
          }),
    });
    await expect(commitProjection(trueAgainstEmpty, request, { endpoints: graphEndpoints("renamed-empty") }))
      .rejects.toThrow("graphMatched contradicts the decoded artifact");

    const wrongSidePath = new GraphProjectionClient({
      fetch: async (input, init) => String(input).includes("manifest")
        ? jsonResponse(manifest("renamed-path"))
        : projectionResponse(requestFrom(init), {
            artifact: baseArtifact,
            viewFacts: facts(true, "src/new.ts"),
          }),
    });
    await expect(commitProjection(wrongSidePath, request, { endpoints: graphEndpoints("renamed-path") }))
      .rejects.toThrow("review selection path does not match its side");
  });

  it("shares inactive projection eviction across independent clients", async () => {
    const budget = new RecentAllocationBudget({ maxRecentEntries: 1, maxRecentBytes: 1_000_000 });
    const calls = new Map<string, number>();
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input), "http://meridian.local");
      const graphId = url.searchParams.get("id")!;
      if (url.pathname.includes("manifest")) return jsonResponse(manifest(graphId));
      calls.set(graphId, (calls.get(graphId) ?? 0) + 1);
      return projectionResponse(requestFrom(init));
    });
    const first = new GraphProjectionClient({
      fetch: fetchMock,
      recentBudget: budget,
    });
    const second = new GraphProjectionClient({
      fetch: fetchMock,
      recentBudget: budget,
    });

    await commitProjection(first, REQUEST, { endpoints: graphEndpoints("first") });
    await commitProjection(first,
      { ...REQUEST, focusIds: ["ts:src"] },
      { endpoints: graphEndpoints("first") },
    );
    expect(budget.inactiveEntryCount).toBe(1);
    await commitProjection(second, REQUEST, { endpoints: graphEndpoints("second") });
    await commitProjection(second,
      { ...REQUEST, focusIds: ["ts:src"] },
      { endpoints: graphEndpoints("second") },
    );

    expect(budget.inactiveEntryCount).toBe(1);
    expect(calls).toEqual(new Map([["first", 2], ["second", 2]]));
    await commitProjection(first, REQUEST, { endpoints: graphEndpoints("first") });
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
        : projectionResponse(requestFrom(init), { residentBytes: 10 });
    });
    const client = new GraphProjectionClient({
      fetch: fetchMock,
      recentBudget: budget,
    });
    const reviewRequest = { ...REQUEST, view: "review" as const, filePaths: ["src/a.ts"] };
    const pairOptions = {
      head: { request: reviewRequest, endpoints: graphEndpoints("head") },
      mergeBase: { request: reviewRequest, endpoints: graphEndpoints("merge-base") },
    };
    const pair = await commitReviewPair(client, pairOptions);

    await commitProjection(client, REQUEST, { endpoints: BASE_ENDPOINTS });
    expect(budget.inactiveEntryCount).toBe(1);
    expect(budget.inactiveResidentByteLength).toBe(pair.residentBytes);
    expect((await client.stageReviewPair(pairOptions)).commit()).toBe(pair);
    expect(budget.inactiveEntryCount).toBe(1); // The prior active overview replaced the pair's slot.

    // Moving away once more makes the pair inactive again; a different client's inactive view
    // evicts the complete pair, never one constituent side.
    await commitProjection(client, REQUEST, { endpoints: BASE_ENDPOINTS });
    const other = new GraphProjectionClient({
      fetch: fetchMock,
      recentBudget: budget,
    });
    await commitProjection(other, REQUEST, { endpoints: graphEndpoints("other") });
    await commitProjection(other,
      { ...REQUEST, focusIds: ["ts:src"] },
      { endpoints: graphEndpoints("other") },
    );

    expect(commitCachedProjection(client, pair.head.key)).toBeUndefined();
    expect(commitCachedProjection(client, pair.mergeBase.key)).toBeUndefined();
    expect(budget.inactiveEntryCount).toBe(1);
  });

  it("honours server resident estimates when they exceed the default 3x response estimate", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => String(input).includes("manifest")
      ? jsonResponse(manifest("graph-1"))
      : projectionResponse(requestFrom(init), { residentBytes: 99_000 }));
    const client = new GraphProjectionClient({ fetch: fetchMock });

    expect((await commitProjection(client, REQUEST, { endpoints: BASE_ENDPOINTS })).residentBytes).toBe(99_000);
  });

  it("uses direct endpoints with live shared signals independent of the subscriber signal", async () => {
    const seen: Array<{ url: string; signal: AbortSignal | null | undefined }> = [];
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      seen.push({ url: String(input), signal: init?.signal });
      return String(input).includes("manifest")
        ? jsonResponse(manifest("prepared-9"))
        : projectionResponse(requestFrom(init));
    });
    const client = new GraphProjectionClient({ fetch: fetchMock });
    const controller = new AbortController();

    await commitProjection(client, { ...REQUEST, view: "review" }, {
      endpoints: {
        graphId: "prepared-9",
        manifestUrl: "http://meridian.local/api/graph/manifest?id=prepared-9",
        projectionUrl: "http://meridian.local/api/graph/projection?id=prepared-9",
        searchUrl: "http://meridian.local/api/graph/search?id=prepared-9",
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

  it("stages HEAD and merge-base without changing active ownership, then commits atomically", async () => {
    const recentBudget = new RecentAllocationBudget({ maxRecentEntries: 3, maxRecentBytes: 1_000_000 });
    const pendingBudget = new RecentAllocationBudget({ maxRecentEntries: 4, maxRecentBytes: 4_000_000 });
    const projectionCalls: string[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input), "http://meridian.local");
      const graphId = url.searchParams.get("id") ?? "base";
      if (url.pathname.includes("manifest")) return jsonResponse(manifest(graphId));
      projectionCalls.push(graphId);
      return projectionResponse(requestFrom(init));
    });
    const client = new GraphProjectionClient({
      fetch: fetchMock,
      residentExpansionFactor: 1,
      recentCache: { maxRecentEntries: 3, maxRecentBytes: 1_000_000 },
      recentBudget,
      pendingBudget,
    });
    const reviewRequest = { ...REQUEST, view: "review" as const, filePaths: ["src/a.ts"] };
    const base = await commitProjection(client, REQUEST, { endpoints: BASE_ENDPOINTS });
    const pairOptions = {
      head: { request: reviewRequest, endpoints: graphEndpoints("head") },
      mergeBase: { request: reviewRequest, endpoints: graphEndpoints("merge-base") },
    };
    const staged = await client.stageReviewPair(pairOptions);
    const pair = staged.projection;

    expect(pair.residentBytes).toBe(
      pair.head.residentBytes
      + pair.mergeBase.residentBytes
      + estimateGraphPresentationResidentBytes(2, 0),
    );
    expect(pair.serializedBytes).toBe(pair.head.serializedBytes + pair.mergeBase.serializedBytes);
    expect(client.activeKey).toBe(base.key);
    expect(pendingBudget.inactiveEntryCount).toBe(1);
    expect(recentBudget.inactiveEntryCount).toBe(0);
    staged.commit();
    expect(client.activeKey).toBe(pair.key);
    expect(pendingBudget.inactiveEntryCount).toBe(0);
    expect(recentBudget.inactiveEntryCount).toBe(1); // The former active base is now recent.
    expect(commitCachedProjection(client, pair.key)).toBeUndefined();
    expect(client.activeKey).toBe(pair.key);

    // Returning through the staged contract reuses the composite and changes ownership only when
    // the caller explicitly commits it.
    await commitProjection(client, REQUEST, { endpoints: BASE_ENDPOINTS });
    const restaged = await client.stageReviewPair(pairOptions);
    expect(client.activeKey).not.toBe(pair.key);
    restaged.commit();
    expect(projectionCalls).toEqual(["graph-1", "head", "merge-base"]);
  });

  it("atomically discards an unreachable transition coordinate while retaining the saved baseline", async () => {
    const recentBudget = new RecentAllocationBudget({ maxRecentEntries: 3, maxRecentBytes: 1_000_000 });
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input), "http://meridian.local");
      const graphId = url.searchParams.get("id") ?? "graph-1";
      return url.pathname.includes("manifest")
        ? jsonResponse(manifest(graphId))
        : projectionResponse(requestFrom(init));
    });
    const client = new GraphProjectionClient({
      fetch: fetchMock,
      residentExpansionFactor: 1,
      recentCache: { maxRecentEntries: 3, maxRecentBytes: 1_000_000 },
      recentBudget,
    });
    const baseline = await commitProjection(client, REQUEST, { endpoints: BASE_ENDPOINTS });
    const transient = await commitProjection(
      client,
      { ...REQUEST, expandedIds: ["ts:src"] },
      { endpoints: BASE_ENDPOINTS },
    );
    expect(recentBudget.inactiveEntryCount).toBe(1);

    const reviewRequest = { ...REQUEST, view: "review" as const, filePaths: ["src/a.ts"] };
    const staged = await client.stageReviewPair({
      head: { request: reviewRequest, endpoints: graphEndpoints("head") },
      mergeBase: { request: reviewRequest, endpoints: graphEndpoints("merge-base") },
    });
    staged.commit({ supersededKeys: [transient.key] });

    expect(recentBudget.inactiveEntryCount).toBe(1);
    expect(client.stageCached(transient.key)).toBeUndefined();
    const cachedBaseline = client.stageCached(baseline.key);
    expect(cachedBaseline?.projection).toBe(baseline);
    cachedBaseline?.release();
  });

  it("keeps fresh and cached single stages charged and ownership-neutral until commit", async () => {
    const recentBudget = new RecentAllocationBudget({ maxRecentEntries: 3, maxRecentBytes: 1_000_000 });
    const pendingBudget = new RecentAllocationBudget({ maxRecentEntries: 4, maxRecentBytes: 4_000_000 });
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => String(input).includes("manifest")
      ? jsonResponse(manifest("graph-1"))
      : projectionResponse(requestFrom(init), { residentBytes: 10 }));
    const client = new GraphProjectionClient({
      fetch: fetchMock,
      recentBudget,
      pendingBudget,
      recentCache: { maxRecentEntries: 3, maxRecentBytes: 1_000_000 },
    });
    const base = await commitProjection(client, REQUEST, { endpoints: BASE_ENDPOINTS });
    const focusedRequest = { ...REQUEST, focusIds: ["ts:src"] };

    const staleFresh = await client.stage(focusedRequest, { endpoints: BASE_ENDPOINTS });
    expect(client.activeKey).toBe(base.key);
    expect(pendingBudget.inactiveEntryCount).toBe(1);
    expect(recentBudget.inactiveEntryCount).toBe(0);
    staleFresh.release();
    expect(client.activeKey).toBe(base.key);
    expect(pendingBudget.inactiveEntryCount).toBe(0);
    expect(recentBudget.inactiveEntryCount).toBe(0);

    const focused = await commitProjection(client, focusedRequest, { endpoints: BASE_ENDPOINTS });
    await commitProjection(client, REQUEST, { endpoints: BASE_ENDPOINTS });
    expect(recentBudget.inactiveEntryCount).toBe(1); // Focused is retained by the decoded-view LRU.
    const staleCached = client.stageCached(focused.key);
    expect(staleCached?.projection).toBe(focused);
    expect(client.activeKey).toBe(base.key);
    expect(recentBudget.inactiveEntryCount).toBe(1);
    expect(pendingBudget.inactiveEntryCount).toBe(1);
    staleCached?.release();
    expect(client.activeKey).toBe(base.key);
    expect(recentBudget.inactiveEntryCount).toBe(1);
    expect(pendingBudget.inactiveEntryCount).toBe(0);
  });

  it("stages and commits a valid review pair larger than the 48 MiB recent-view cache", async () => {
    const recentBudget = new RecentAllocationBudget({
      maxRecentEntries: 3,
      maxRecentBytes: 48 * 1024 * 1024,
    });
    const pendingBudget = new RecentAllocationBudget({
      maxRecentEntries: 4,
      maxRecentBytes: 192 * 1024 * 1024,
    });
    const sideBytes = 49 * 1024 * 1024;
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input), "http://meridian.local");
      const graphId = url.searchParams.get("id")!;
      return url.pathname.includes("manifest")
        ? jsonResponse(manifest(graphId))
        : projectionResponse(requestFrom(init), { residentBytes: sideBytes });
    });
    const client = new GraphProjectionClient({
      fetch: fetchMock,
      recentBudget,
      pendingBudget,
    });
    const reviewRequest = { ...REQUEST, view: "review" as const, filePaths: ["src/a.ts"] };

    const staged = await client.stageReviewPair({
      head: { request: reviewRequest, endpoints: graphEndpoints("large-head") },
      mergeBase: { request: reviewRequest, endpoints: graphEndpoints("large-base") },
    });

    expect(staged.projection.residentBytes).toBe(
      sideBytes * 2 + estimateGraphPresentationResidentBytes(2, 0),
    );
    expect(pendingBudget.inactiveResidentByteLength).toBe(staged.projection.residentBytes);
    expect(recentBudget.inactiveEntryCount).toBe(0);
    const pair = staged.commit();
    staged.release();
    expect(client.activeKey).toBe(pair.key);
    expect(pendingBudget.inactiveEntryCount).toBe(0);

    await commitProjection(client, REQUEST, { endpoints: BASE_ENDPOINTS });
    expect(recentBudget.inactiveEntryCount).toBe(0); // Oversized pair is dropped, not half-retained.
    expect(client.stageCachedReview(pair.key)).toBeUndefined();
  });

  it("evicts and cancels pending candidates without touching recent navigation ownership", async () => {
    const recentBudget = new RecentAllocationBudget({ maxRecentEntries: 3, maxRecentBytes: 1_000_000 });
    const pendingBudget = new RecentAllocationBudget({ maxRecentEntries: 2, maxRecentBytes: 1_000_000 });
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input), "http://meridian.local");
      const graphId = url.searchParams.get("id")!;
      return url.pathname.includes("manifest")
        ? jsonResponse(manifest(graphId))
        : projectionResponse(requestFrom(init), { residentBytes: 10 });
    });
    const client = new GraphProjectionClient({
      fetch: fetchMock,
      recentBudget,
      pendingBudget,
    });

    const first = await client.stage(REQUEST, { endpoints: graphEndpoints("pending-1") });
    const second = await client.stage(REQUEST, { endpoints: graphEndpoints("pending-2") });
    const third = await client.stage(REQUEST, { endpoints: graphEndpoints("pending-3") });

    expect(() => first.projection).toThrow("released or evicted");
    expect(pendingBudget.inactiveEntryCount).toBe(2);
    expect(recentBudget.inactiveEntryCount).toBe(0);
    second.release();
    expect(pendingBudget.inactiveEntryCount).toBe(1);
    const committed = third.commit();
    third.release();
    expect(client.activeKey).toBe(committed.key);
    expect(pendingBudget.inactiveEntryCount).toBe(0);
    expect(recentBudget.inactiveEntryCount).toBe(0);
  });

  it("transfers a decoded single into pending ownership without an uncharged microtask", async () => {
    const request = { ...REQUEST, maxResponseBytes: 64 * 1024 };
    const decodedBytes = request.maxResponseBytes * 3;
    let client!: GraphProjectionClient;
    const transferBytesAtRegistration: number[] = [];
    const pendingBudget = new class extends RecentAllocationBudget {
      override register(residentBytes: number, evict: () => void): object | undefined {
        transferBytesAtRegistration.push(client.decodeAdmissionResidentByteLength);
        return super.register(residentBytes, evict);
      }
    }({ maxRecentEntries: 4, maxRecentBytes: 4 * decodedBytes });
    client = new GraphProjectionClient({
      pendingBudget,
      fetch: async (input, init) => String(input).includes("manifest")
        ? jsonResponse(manifest("graph-1"))
        : projectionResponse(requestFrom(init), { residentBytes: decodedBytes }),
    });

    const staged = await client.stage(request, { endpoints: BASE_ENDPOINTS });

    expect(transferBytesAtRegistration).toEqual([
      request.maxResponseBytes * 6,
    ]);
    expect(client.decodeAdmissionResidentByteLength).toBe(0);
    expect(client.decodedTransferOwnerCount).toBe(0);
    expect(pendingBudget.inactiveResidentByteLength).toBe(decodedBytes);
    staged.release();
    expect(pendingBudget.inactiveResidentByteLength).toBe(0);
  });

  it("keeps fast decoded sides charged while slow siblings and other review pairs contend", async () => {
    const sideReservation = 48 * 1024 * 1024;
    const pendingBudget = new RecentAllocationBudget({
      maxRecentEntries: 4,
      maxRecentBytes: 192 * 1024 * 1024,
    });
    const reviewRequest = { ...REQUEST, view: "review" as const, filePaths: ["src/a.ts"] };
    const envelope = await projectionEnvelope(reviewRequest, { residentBytes: sideReservation });
    const slowA = deferredResponse();
    const slowB = deferredResponse();
    const projectionStarts: string[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input), "http://meridian.local");
      const graphId = url.searchParams.get("id")!;
      if (url.pathname.includes("manifest")) return jsonResponse(manifest(graphId));
      projectionStarts.push(graphId);
      if (graphId === "a-base") return slowA.promise;
      if (graphId === "b-base") return slowB.promise;
      return jsonResponse(envelope);
    });
    const client = new GraphProjectionClient({ fetch: fetchMock, pendingBudget });
    const pair = (name: string) => client.stageReviewPair({
      head: { request: reviewRequest, endpoints: graphEndpoints(`${name}-head`) },
      mergeBase: { request: reviewRequest, endpoints: graphEndpoints(`${name}-base`) },
    });

    const pendingA = pair("a");
    const pendingB = pair("b");
    const pendingC = pair("c");
    await vi.waitFor(() => expect(projectionStarts).toEqual(["a-head", "a-base"]));
    await vi.waitFor(() => expect(client.decodedTransferOwnerCount).toBe(1));
    expect(client.decodeAdmissionResidentByteLength).toBe(4 * sideReservation);
    await vi.waitFor(() => expect(client.queuedDecodeCount).toBe(4));
    expect(projectionStarts).not.toContain("c-head");
    expect(projectionStarts).not.toContain("c-base");
    expect(pendingBudget.inactiveEntryCount).toBe(0);

    slowA.resolve(jsonResponse(envelope));
    const stagedA = await pendingA;
    // A's two decode leases transfer synchronously into one pending pair before B takes the freed
    // physical slots. There is no point where the decoded pair is retained by neither owner.
    expect(pendingBudget.inactiveResidentByteLength).toBe(stagedA.projection.residentBytes);
    await vi.waitFor(() => expect(projectionStarts).toEqual(["a-head", "a-base", "b-head", "b-base"]));
    stagedA.release();

    slowB.resolve(jsonResponse(envelope));
    const stagedB = await pendingB;
    await vi.waitFor(() => expect(projectionStarts).toEqual([
      "a-head", "a-base", "b-head", "b-base", "c-head", "c-base",
    ]));
    stagedB.release();
    const stagedC = await pendingC;
    stagedC.release();
    expect(client.decodeAdmissionResidentByteLength).toBe(0);
    expect(client.decodedTransferOwnerCount).toBe(0);
    expect(client.queuedDecodeCount).toBe(0);
    expect(pendingBudget.inactiveEntryCount).toBe(0);
  });

  it("retains an abort-ignorant sibling reservation until its physical decode flight settles", async () => {
    const reviewRequest = { ...REQUEST, view: "review" as const, filePaths: ["src/a.ts"] };
    const ignoredSibling = deferredResponse();
    const projectionStarts: string[] = [];
    const client = new GraphProjectionClient({
      fetch: async (input, init) => {
        const url = new URL(String(input), "http://meridian.local");
        const graphId = url.searchParams.get("id")!;
        if (url.pathname.includes("manifest")) return jsonResponse(manifest(graphId));
        projectionStarts.push(graphId);
        if (graphId === "failure-head") {
          return new Response("failed", { status: 500, headers: { "content-type": "text/plain" } });
        }
        // Deliberately ignore init.signal: the physical transport owns its reservation until this
        // promise settles even though pair-level structured cancellation has already returned.
        void init?.signal;
        return ignoredSibling.promise;
      },
    });

    const failed = client.stageReviewPair({
      head: { request: reviewRequest, endpoints: graphEndpoints("failure-head") },
      mergeBase: { request: reviewRequest, endpoints: graphEndpoints("ignored-base") },
    });
    const failedOutcome = failed.then(
      () => new Error("review unexpectedly succeeded"),
      (error: unknown) => error,
    );
    await vi.waitFor(() => expect(projectionStarts).toEqual(["failure-head", "ignored-base"]));
    expect(await failedOutcome).toMatchObject({ message: expect.stringContaining("graph projection fetch failed (500)") });
    expect(client.decodeAdmissionResidentByteLength).toBe(96 * 1024 * 1024);
    expect(client.decodedTransferOwnerCount).toBe(0);

    ignoredSibling.resolve(await projectionResponse(reviewRequest));
    await vi.waitFor(() => expect(client.decodeAdmissionResidentByteLength).toBe(0));
    expect(client.decodedTransferOwnerCount).toBe(0);
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
      return projectionResponse(requestFrom(init));
    });
    const client = new GraphProjectionClient({ fetch: fetchMock });
    const canceled = new AbortController();
    const abandoned = commitProjection(client, REQUEST, {
      endpoints: BASE_ENDPOINTS,
      signal: canceled.signal,
    });
    const retained = commitProjection(client, REQUEST, { endpoints: BASE_ENDPOINTS });
    await vi.waitFor(() => expect(projectionCalls.get("graph-1")).toBe(1));
    expect(client.decodeAdmissionResidentByteLength).toBe(96 * 1024 * 1024);
    canceled.abort();
    expect(client.decodeAdmissionResidentByteLength).toBe(96 * 1024 * 1024);
    release();
    await expect(abandoned).rejects.toMatchObject({ name: "AbortError" });
    await expect(retained).resolves.toMatchObject({ graphId: "graph-1" });
    expect(client.decodeAdmissionResidentByteLength).toBe(0);

    let releasePair!: () => void;
    const pairGate = new Promise<void>((resolve) => { releasePair = resolve; });
    // A second client keeps this assertion independent from the already-cached single view.
    const pairFetch = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input), "http://meridian.local");
      const graphId = url.searchParams.get("id")!;
      if (url.pathname.includes("manifest")) return jsonResponse(manifest(graphId));
      await pairGate;
      return projectionResponse(requestFrom(init));
    });
    const pairClient = new GraphProjectionClient({ fetch: pairFetch });
    const reviewRequest = { ...REQUEST, view: "review" as const, filePaths: ["src/a.ts"] };
    const pairOptions = {
      head: { request: reviewRequest, endpoints: graphEndpoints("head") },
      mergeBase: { request: reviewRequest, endpoints: graphEndpoints("merge-base") },
    };
    const first = pairClient.stageReviewPair(pairOptions);
    const second = pairClient.stageReviewPair(pairOptions);
    const headOnly = commitProjection(pairClient, reviewRequest, { endpoints: graphEndpoints("head") });
    await vi.waitFor(() => expect(pairFetch).toHaveBeenCalledTimes(4)); // two manifests + one POST per side
    releasePair();
    const firstStage = await first;
    const secondStage = await second;
    const pair = firstStage.projection;
    expect(secondStage.projection).toBe(pair);
    expect(await headOnly).toBe(pair.head);
    expect(pairClient.activeKey).toBe(pair.head.key);
    firstStage.commit();
    secondStage.release();
    expect(pairClient.activeKey).toBe(pair.key);

    // A constituent key aliases the composite allocation. It can navigate back to HEAD without
    // retaining or activating a separately charged copy of the same decoded side. Both exact side
    // aliases exist, and no third alias is manufactured for the committed pair.
    const overview = await commitProjection(pairClient, REQUEST, { endpoints: BASE_ENDPOINTS });
    const stagedHead = pairClient.stageCached(pair.head.key);
    const stagedMergeBase = pairClient.stageCached(pair.mergeBase.key);
    expect(stagedHead?.projection).toBe(pair.head);
    expect(stagedMergeBase?.projection).toBe(pair.mergeBase);
    expect(pairClient.stageCached("unrelated-side-key")).toBeUndefined();
    expect(pairClient.activeKey).toBe(overview.key);

    // Explicitly committing a single side leaves review mode and transfers ownership to that exact
    // single projection; the composite and its other alias are then released atomically.
    expect(stagedHead?.commit()).toBe(pair.head);
    stagedHead?.release();
    stagedMergeBase?.release();
    expect(pairClient.activeKey).toBe(pair.head.key);
    expect(pairClient.stageCached(pair.mergeBase.key)).toBeUndefined();
  });

  it("admits both max-sized review sides to transfer and decode concurrently", async () => {
    const pending = new Map<string, {
      init: RequestInit | undefined;
      resolve: (response: Response) => void;
    }>();
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input), "http://meridian.local");
      const graphId = url.searchParams.get("id")!;
      if (url.pathname.includes("manifest")) return jsonResponse(manifest(graphId));
      return new Promise<Response>((resolve) => {
        pending.set(graphId, { init, resolve });
      });
    });
    const client = new GraphProjectionClient({ fetch: fetchMock });
    const reviewRequest = { ...REQUEST, view: "review" as const, filePaths: ["src/a.ts"] };
    const pairRead = client.stageReviewPair({
      head: { request: reviewRequest, endpoints: graphEndpoints("head") },
      mergeBase: { request: reviewRequest, endpoints: graphEndpoints("merge-base") },
    });

    await vi.waitFor(() => expect([...pending.keys()].sort()).toEqual(["head", "merge-base"]));
    for (const gate of pending.values()) {
      gate.resolve(await projectionResponse(requestFrom(gate.init)));
    }
    const staged = await pairRead;
    expect(staged.projection.head.graphId).toBe("head");
    expect(staged.projection.mergeBase.graphId).toBe("merge-base");
    staged.release();
  });

  it("bounds aggregate decode admission at the protocol multiplier even with a low client factor", async () => {
    const budget = new RecentAllocationBudget({ maxRecentEntries: 8, maxRecentBytes: 8_000_000 });
    const pending = new Map<string, {
      init: RequestInit | undefined;
      resolve: (response: Response) => void;
      reject: (reason: unknown) => void;
    }>();
    const started: string[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input), "http://meridian.local");
      const graphId = url.searchParams.get("id")!;
      if (url.pathname.includes("manifest")) return jsonResponse(manifest(graphId));
      started.push(graphId);
      return new Promise<Response>((resolve, reject) => {
        pending.set(graphId, { init, resolve, reject });
      });
    });
    const client = new GraphProjectionClient({
      fetch: fetchMock,
      residentExpansionFactor: 0.25,
      pendingBudget: budget,
      recentCache: { maxRecentEntries: 8, maxRecentBytes: 8_000_000 },
    });
    const reads = Array.from({ length: 5 }, (_, index) => client.stage(
      REQUEST,
      { endpoints: graphEndpoints(`graph-${index}`) },
    ));
    const outcomes = reads.map((read) => read.then(
      (staged) => ({ staged }),
      (error: unknown) => ({ error }),
    ));

    await vi.waitFor(() => expect(started).toHaveLength(2));
    expect([...started].sort()).toEqual(["graph-0", "graph-1"]);

    const queuedController = new AbortController();
    const canceled = client.stage(REQUEST, {
      endpoints: graphEndpoints("graph-canceled"),
      signal: queuedController.signal,
    });
    await vi.waitFor(() => expect(fetchMock.mock.calls.some(([input]) => (
      String(input).includes("manifest?id=graph-canceled")
    ))).toBe(true));
    expect(started).toHaveLength(2);
    queuedController.abort();
    await expect(canceled).rejects.toMatchObject({ name: "AbortError" });

    pending.get("graph-0")!.reject(new Error("decode failed"));
    await vi.waitFor(() => expect(started).toContain("graph-2"));
    const first = await outcomes[0]!;
    expect(first).toMatchObject({ error: { message: "decode failed" } });

    for (const graphId of ["graph-1", "graph-2"]) {
      const gate = pending.get(graphId)!;
      gate.resolve(await projectionResponse(requestFrom(gate.init)));
    }
    await vi.waitFor(() => expect(started).toEqual(["graph-0", "graph-1", "graph-2", "graph-3", "graph-4"]));
    for (const graphId of ["graph-3", "graph-4"]) {
      const gate = pending.get(graphId)!;
      gate.resolve(await projectionResponse(requestFrom(gate.init)));
    }
    const settled = await Promise.all(outcomes.slice(1));
    const stages = settled.map((outcome) => {
      if (!("staged" in outcome)) throw outcome.error;
      return outcome.staged;
    });
    expect(budget.inactiveEntryCount).toBe(4);
    for (const staged of stages) staged.release();
    expect(budget.inactiveEntryCount).toBe(0);
    expect(started).not.toContain("graph-canceled");
  });

  it("bounds weighted-admission waiters with the physical side-flight limit", async () => {
    const manifestGraphs = new Set<string>();
    const projectionSignals: AbortSignal[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input), "http://meridian.local");
      const graphId = url.searchParams.get("id")!;
      if (url.pathname.includes("manifest")) {
        manifestGraphs.add(graphId);
        return jsonResponse(manifest(graphId));
      }
      const signal = init?.signal as AbortSignal;
      projectionSignals.push(signal);
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    });
    const client = new GraphProjectionClient({ fetch: fetchMock });
    const controllers: AbortController[] = [];
    const outcomes: Array<Promise<unknown>> = [];

    for (let index = 0; index < 32; index += 1) {
      const controller = new AbortController();
      controllers.push(controller);
      const graphId = `queued-${index}`;
      outcomes.push(client.stage(REQUEST, {
        endpoints: graphEndpoints(graphId),
        signal: controller.signal,
      }).then(
        (staged) => staged,
        (error: unknown) => error,
      ));
      await vi.waitFor(() => expect(manifestGraphs.has(graphId)).toBe(true));
      // Let this manifest continuation register its side flight before adding the next waiter.
      await Promise.resolve();
      await Promise.resolve();
    }

    expect(projectionSignals).toHaveLength(2);
    await expect(client.stage(REQUEST, {
      endpoints: graphEndpoints("queued-overflow"),
    })).rejects.toThrow("too many graph projections are already in flight");

    for (const controller of controllers) controller.abort();
    const settled = await Promise.all(outcomes);
    expect(settled.every((value) => value instanceof DOMException && value.name === "AbortError")).toBe(true);
    expect(projectionSignals.every((signal) => signal.aborted)).toBe(true);
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
      return projectionResponse(requestFrom(init));
    });
    const client = new GraphProjectionClient({
      fetch: fetchMock,
      recentCache: { maxRecentEntries: 1, maxRecentBytes: 1024 * 1024 },
    });
    const reviewRequest = { ...REQUEST, view: "review" as const, filePaths: ["src/a.ts"] };
    const pairRead = client.stageReviewPair({
      head: { request: reviewRequest, endpoints: graphEndpoints("head") },
      mergeBase: { request: reviewRequest, endpoints: graphEndpoints("merge-base") },
    });
    const pairOutcome = pairRead.then(
      () => new Error("expected the review pair to reject"),
      (error: unknown) => error,
    );
    const head = await commitProjection(client, reviewRequest, { endpoints: graphEndpoints("head") });

    expect(client.activeKey).toBe(head.key);
    expect(projectionCalls.get("head")).toBe(1);
    rejectMergeBase(new Error("merge-base projection failed"));
    await expect(pairOutcome).resolves.toMatchObject({ message: "merge-base projection failed" });
    expect(client.activeKey).toBe(head.key);
    expect(commitCachedProjection(client, head.key)).toBe(head);

    // The failed pair retained no hidden composite. HEAD remains the single charged navigation
    // unit and survives one round trip through the configured one-entry inactive cache.
    await commitProjection(client, REQUEST, { endpoints: BASE_ENDPOINTS });
    expect(commitCachedProjection(client, head.key)).toBe(head);
    expect(client.activeKey).toBe(head.key);
    expect(projectionCalls).toEqual(new Map([["head", 1], ["merge-base", 1], ["graph-1", 1]]));
  });

  it("aborts and drains the sibling manifest subscription when one review manifest fails", async () => {
    const failure = new Error("HEAD manifest failed");
    let announceMergeBase!: () => void;
    const mergeBaseStarted = new Promise<void>((resolve) => { announceMergeBase = resolve; });
    let mergeBaseSignal: AbortSignal | undefined;
    let mergeBaseDrained = false;
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input), "http://meridian.local");
      const graphId = url.searchParams.get("id")!;
      if (!url.pathname.includes("manifest")) {
        throw new Error("projection transport must not start after a manifest failure");
      }
      if (graphId === "head") {
        await mergeBaseStarted;
        throw failure;
      }
      mergeBaseSignal = init?.signal as AbortSignal;
      announceMergeBase();
      return new Promise<Response>((_resolve, reject) => {
        const onAbort = () => {
          mergeBaseDrained = true;
          reject(mergeBaseSignal!.reason);
        };
        if (mergeBaseSignal!.aborted) onAbort();
        else mergeBaseSignal!.addEventListener("abort", onAbort, { once: true });
      });
    });
    const client = new GraphProjectionClient({ fetch: fetchMock });
    const reviewRequest = { ...REQUEST, view: "review" as const, filePaths: ["src/a.ts"] };

    await expect(client.stageReviewPair({
      head: { request: reviewRequest, endpoints: graphEndpoints("head") },
      mergeBase: { request: reviewRequest, endpoints: graphEndpoints("merge-base") },
    })).rejects.toBe(failure);

    expect(mergeBaseSignal?.aborted).toBe(true);
    expect(mergeBaseDrained).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(client.activeKey).toBeUndefined();
  });

  it("aborts and drains the sibling subscription when one review side fails", async () => {
    const failure = new Error("HEAD projection failed");
    let announceMergeBase!: () => void;
    const mergeBaseStarted = new Promise<void>((resolve) => { announceMergeBase = resolve; });
    let mergeBaseSignal: AbortSignal | undefined;
    let mergeBaseDrained = false;
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input), "http://meridian.local");
      const graphId = url.searchParams.get("id")!;
      if (url.pathname.includes("manifest")) return jsonResponse(manifest(graphId));
      if (graphId === "head") {
        await mergeBaseStarted;
        throw failure;
      }
      mergeBaseSignal = init?.signal as AbortSignal;
      announceMergeBase();
      return new Promise<Response>((_resolve, reject) => {
        const onAbort = () => {
          mergeBaseDrained = true;
          reject(mergeBaseSignal!.reason);
        };
        if (mergeBaseSignal!.aborted) onAbort();
        else mergeBaseSignal!.addEventListener("abort", onAbort, { once: true });
      });
    });
    const client = new GraphProjectionClient({ fetch: fetchMock });
    const reviewRequest = { ...REQUEST, view: "review" as const, filePaths: ["src/a.ts"] };

    await expect(client.stageReviewPair({
      head: { request: reviewRequest, endpoints: graphEndpoints("head") },
      mergeBase: { request: reviewRequest, endpoints: graphEndpoints("merge-base") },
    })).rejects.toBe(failure);

    expect(mergeBaseSignal?.aborted).toBe(true);
    expect(mergeBaseDrained).toBe(true);
    expect(client.activeKey).toBeUndefined();
  });

  it("preserves a sibling side transport still owned by another subscriber", async () => {
    const failure = new Error("HEAD projection failed");
    let announceMergeBase!: () => void;
    const mergeBaseStarted = new Promise<void>((resolve) => { announceMergeBase = resolve; });
    let resolveMergeBase!: (response: Response) => void;
    const mergeBaseResponse = new Promise<Response>((resolve) => { resolveMergeBase = resolve; });
    let mergeBaseSignal: AbortSignal | undefined;
    let mergeBaseInit: RequestInit | undefined;
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input), "http://meridian.local");
      const graphId = url.searchParams.get("id")!;
      if (url.pathname.includes("manifest")) return jsonResponse(manifest(graphId));
      if (graphId === "head") throw failure;
      mergeBaseSignal = init?.signal as AbortSignal;
      mergeBaseInit = init;
      announceMergeBase();
      return mergeBaseResponse;
    });
    const client = new GraphProjectionClient({ fetch: fetchMock });
    const reviewRequest = { ...REQUEST, view: "review" as const, filePaths: ["src/a.ts"] };
    const retained = commitProjection(client, reviewRequest, { endpoints: graphEndpoints("merge-base") });
    await mergeBaseStarted;

    await expect(client.stageReviewPair({
      head: { request: reviewRequest, endpoints: graphEndpoints("head") },
      mergeBase: { request: reviewRequest, endpoints: graphEndpoints("merge-base") },
    })).rejects.toBe(failure);

    expect(mergeBaseSignal?.aborted).toBe(false);
    resolveMergeBase(await projectionResponse(requestFrom(mergeBaseInit)));
    await expect(retained).resolves.toMatchObject({ graphId: "merge-base" });
    expect(mergeBaseSignal?.aborted).toBe(false);
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
    const client = new GraphProjectionClient({ fetch: fetchMock });
    const first = new AbortController();
    const second = new AbortController();
    const firstRead = commitProjection(client, REQUEST, {
      endpoints: BASE_ENDPOINTS,
      signal: first.signal,
    });
    const secondRead = commitProjection(client, REQUEST, {
      endpoints: BASE_ENDPOINTS,
      signal: second.signal,
    });
    await started;

    first.abort();
    await expect(firstRead).rejects.toMatchObject({ name: "AbortError" });
    expect(transportSignal!.aborted).toBe(false);
    second.abort();
    await expect(secondRead).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(transportSignal!.aborted).toBe(true));
    expect(fetchMock.mock.calls.filter(([input]) => !String(input).includes("manifest"))).toHaveLength(1);
  });

  it("starts one side successor only after an abandoned transport drains", async () => {
    let rejectAbandoned!: (reason: unknown) => void;
    let abandonedSignal: AbortSignal | undefined;
    let projectionCalls = 0;
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      if (String(input).includes("manifest")) return jsonResponse(manifest("graph-1"));
      projectionCalls += 1;
      if (projectionCalls === 1) {
        abandonedSignal = init?.signal as AbortSignal;
        return new Promise<Response>((_resolve, reject) => { rejectAbandoned = reject; });
      }
      return projectionResponse(requestFrom(init));
    });
    const client = new GraphProjectionClient({ fetch: fetchMock });
    const abandoned = new AbortController();
    const first = commitProjection(client, REQUEST, { endpoints: BASE_ENDPOINTS, signal: abandoned.signal });
    await vi.waitFor(() => expect(projectionCalls).toBe(1));
    abandoned.abort();
    await expect(first).rejects.toMatchObject({ name: "AbortError" });

    const successor = commitProjection(client, REQUEST, { endpoints: BASE_ENDPOINTS });
    await Promise.resolve();
    expect(projectionCalls).toBe(1);
    expect(abandonedSignal?.aborted).toBe(true);
    rejectAbandoned(abandonedSignal?.reason);

    await expect(successor).resolves.toMatchObject({ graphId: "graph-1" });
    expect(projectionCalls).toBe(2);
  });

  it("fails closed on unsupported manifests, incomplete slices, mismatched requests, and oversized bodies", async () => {
    const unsupported = new GraphProjectionClient({
      fetch: async () => jsonResponse({ version: 1, graphId: "old" }),
    });
    await expect(commitProjection(unsupported, REQUEST, { endpoints: BASE_ENDPOINTS }))
      .rejects.toThrow("expected version 6");

    const skeletal = new GraphProjectionClient({
      fetch: async () => jsonResponse({ ...manifest("skeletal"), contentId: "bad" }),
    });
    await expect(commitProjection(skeletal, REQUEST, { endpoints: BASE_ENDPOINTS }))
      .rejects.toThrow("contentId must be a 64-character hex digest");

    const incomplete = new GraphProjectionClient({
      fetch: async (input, init) => String(input).includes("manifest")
        ? jsonResponse(manifest("graph-1"))
        : projectionResponse(requestFrom(init), {
            completeness: { complete: false, reasons: ["node-limit"], omittedNodes: 1, omittedEdges: 0 },
          }),
    });
    await expect(commitProjection(incomplete, REQUEST, { endpoints: BASE_ENDPOINTS }))
      .rejects.toThrow("graph projection is incomplete: node-limit");

    const mismatch = new GraphProjectionClient({
      fetch: async (input) => String(input).includes("manifest")
        ? jsonResponse(manifest("graph-1"))
        : projectionResponse({ ...REQUEST, focusIds: ["wrong"] }),
    });
    await expect(commitProjection(mismatch, REQUEST, { endpoints: BASE_ENDPOINTS }))
      .rejects.toThrow("request identity does not match");

    const bounded = new GraphProjectionClient({
      fetch: async (input, init) => String(input).includes("manifest")
        ? jsonResponse(manifest("graph-1"))
        : new Response(JSON.stringify(await projectionEnvelope(requestFrom(init))), {
            status: 200,
            headers: { "content-type": "application/json", "content-length": "65537" },
          }),
    });
    await expect(commitProjection(bounded,
      { ...REQUEST, maxResponseBytes: 65_536 },
      { endpoints: BASE_ENDPOINTS },
    ))
      .rejects.toThrow("exceeds the 65536-byte view limit");
  });

  it("bounds manifests and rejects fields outside the exact v6 manifest shapes", async () => {
    const oversized = new GraphProjectionClient({
      fetch: async () => new Response("{}", {
        status: 200,
        headers: { "content-length": "65537", "content-type": "application/json" },
      }),
    });
    await expect(oversized.loadManifest({ endpoints: BASE_ENDPOINTS }))
      .rejects.toThrow("manifest exceeds the 65536-byte view limit");

    const unknownTopLevel = new GraphProjectionClient({
      fetch: async () => jsonResponse({ ...manifest("graph-1"), legacyGraphId: "graph-1" }),
    });
    await expect(unknownTopLevel.loadManifest({ endpoints: BASE_ENDPOINTS }))
      .rejects.toThrow("fields do not match the v6 contract");

    const base = manifest("graph-1");
    const unknownDefaultView = new GraphProjectionClient({
      fetch: async () => jsonResponse({
        ...base,
        defaultView: { ...base.defaultView, legacyDepth: 99 },
      }),
    });
    await expect(unknownDefaultView.loadManifest({ endpoints: BASE_ENDPOINTS }))
      .rejects.toThrow("defaultView: fields do not match the v6 contract");
  });

  it("rejects malformed UTF-8 at every graph JSON boundary", async () => {
    const manifestClient = new GraphProjectionClient({ fetch: async () => malformedUtf8Response() });
    await expect(manifestClient.loadManifest({ endpoints: BASE_ENDPOINTS }))
      .rejects.toThrow("invalid graph projection manifest: expected UTF-8");

    const projectionClient = new GraphProjectionClient({
      fetch: async (input) => String(input).includes("manifest")
        ? jsonResponse(manifest("graph-1"))
        : malformedUtf8Response(),
    });
    await expect(commitProjection(projectionClient, REQUEST, { endpoints: BASE_ENDPOINTS }))
      .rejects.toThrow("invalid graph projection response: expected UTF-8");

    const searchClient = new GraphProjectionClient({
      fetch: async (input) => String(input).includes("manifest")
        ? jsonResponse(manifest("graph-1"))
        : malformedUtf8Response(),
    });
    await expect(searchClient.searchSymbols({
      version: 1,
      query: "src",
      mode: "map",
      scope: "public",
    }, { endpoints: BASE_ENDPOINTS }))
      .rejects.toThrow("invalid graph symbol search response: expected UTF-8");
  });

  it("cancels an unread body when an advertised response size is invalid", async () => {
    let canceledWith: unknown;
    const body = new ReadableStream<Uint8Array>({
      cancel(reason) {
        canceledWith = reason;
      },
    });
    const client = new GraphProjectionClient({
      fetch: async () => new Response(body, {
        status: 200,
        headers: { "content-length": "65537", "content-type": "application/json" },
      }),
    });

    await expect(client.loadManifest({ endpoints: BASE_ENDPOINTS }))
      .rejects.toThrow("manifest exceeds the 65536-byte view limit");
    expect(canceledWith).toBe("graph projection manifest exceeds its bounded view limit");
  });

  it("rejects and cancels a successful response with the wrong media type", async () => {
    let canceledWith: unknown;
    const body = new ReadableStream<Uint8Array>({
      cancel(reason) {
        canceledWith = reason;
      },
    });
    const client = new GraphProjectionClient({
      fetch: async () => new Response(body, {
        status: 200,
        headers: { "content-type": "text/plain" },
      }),
    });

    await expect(client.loadManifest({ endpoints: BASE_ENDPOINTS }))
      .rejects.toThrow("graph projection manifest: expected application/json");
    expect(canceledWith).toBe("invalid graph projection manifest: expected application/json");
  });

  it("preserves the bounded-view error when stream cancellation itself fails", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(65_537));
      },
      cancel() {
        throw new Error("cleanup failed");
      },
    });
    const client = new GraphProjectionClient({
      fetch: async () => new Response(body, {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    });

    await expect(client.loadManifest({ endpoints: BASE_ENDPOINTS }))
      .rejects.toThrow("manifest exceeds the 65536-byte view limit");
  });

  it("rejects a body larger than its advertised content-length", async () => {
    const envelope = await projectionEnvelope(REQUEST);
    const body = JSON.stringify(envelope);
    const bytes = new TextEncoder().encode(body).byteLength;
    const client = new GraphProjectionClient({
      fetch: async (input) => String(input).includes("manifest")
        ? jsonResponse(manifest("graph-1"))
        : new Response(body, {
            status: 200,
            headers: {
              "content-type": "application/json",
              "content-length": String(bytes - 1),
            },
          }),
    });

    await expect(commitProjection(client, REQUEST, { endpoints: BASE_ENDPOINTS }))
      .rejects.toThrow("content-length does not match the body");
  });

  it("rejects non-canonical response requests and contradictory completeness claims", async () => {
    const unknownRequestField = new GraphProjectionClient({
      fetch: async (input, init) => String(input).includes("manifest")
        ? jsonResponse(manifest("graph-1"))
        : projectionResponse(requestFrom(init), {
            request: { ...requestFrom(init), legacyDepth: 99 },
          }),
    });
    await expect(commitProjection(unknownRequestField, REQUEST, { endpoints: BASE_ENDPOINTS }))
      .rejects.toThrow("response request: fields do not match the v6 contract");

    const contradictory = new GraphProjectionClient({
      fetch: async (input, init) => String(input).includes("manifest")
        ? jsonResponse(manifest("graph-1"))
        : projectionResponse(requestFrom(init), {
            completeness: { complete: true, reasons: ["node-limit"], omittedNodes: 1, omittedEdges: 0 },
          }),
    });
    await expect(commitProjection(contradictory, REQUEST, { endpoints: BASE_ENDPOINTS }))
      .rejects.toThrow("complete projections cannot report omissions");
  });

  it("binds projection revision and required identity headers to the response body", async () => {
    const wrongRevision = new GraphProjectionClient({
      fetch: async (input, init) => String(input).includes("manifest")
        ? jsonResponse(manifest("graph-1"))
        : projectionResponse(requestFrom(init), {
            artifact: { ...ARTIFACT, generatedAt: "2026-07-15T00:00:00.000Z" },
          }),
    });
    await expect(commitProjection(wrongRevision, REQUEST, { endpoints: BASE_ENDPOINTS }))
      .rejects.toThrow("artifact revision does not match its manifest");

    const envelope = await projectionEnvelope(canonicalizeProjectionRequest(REQUEST));
    const body = JSON.stringify(envelope);
    const missingProjectionHeader = new GraphProjectionClient({
      fetch: async (input) => String(input).includes("manifest")
        ? jsonResponse(manifest("graph-1"))
        : new Response(body, {
            status: 200,
            headers: {
              "content-type": "application/json",
              "content-length": String(new TextEncoder().encode(body).byteLength),
              "x-meridian-resident-bytes": String(envelope.residentBytes),
            },
          }),
    });
    await expect(commitProjection(missingProjectionHeader, REQUEST, { endpoints: BASE_ENDPOINTS }))
      .rejects.toThrow("projection identity header does not match the body");

    const wrongResidentHeader = new GraphProjectionClient({
      fetch: async (input) => String(input).includes("manifest")
        ? jsonResponse(manifest("graph-1"))
        : new Response(body, {
            status: 200,
            headers: {
              "content-type": "application/json",
              "content-length": String(new TextEncoder().encode(body).byteLength),
              "x-meridian-projection-id": String(envelope.projectionId),
              "x-meridian-resident-bytes": "2",
            },
          }),
    });
    await expect(commitProjection(wrongResidentHeader, REQUEST, { endpoints: BASE_ENDPOINTS }))
      .rejects.toThrow("resident byte header does not match the body");

    const forgedProjectionId = "f".repeat(64);
    const forgedEnvelope = { ...envelope, projectionId: forgedProjectionId };
    const forgedBody = JSON.stringify(forgedEnvelope);
    const selfConsistentForgery = new GraphProjectionClient({
      fetch: async (input) => String(input).includes("manifest")
        ? jsonResponse(manifest("graph-1"))
        : new Response(forgedBody, {
            status: 200,
            headers: {
              "content-type": "application/json",
              "content-length": String(new TextEncoder().encode(forgedBody).byteLength),
              "x-meridian-projection-id": forgedProjectionId,
              "x-meridian-resident-bytes": String(envelope.residentBytes),
            },
          }),
    });
    await expect(commitProjection(selfConsistentForgery, REQUEST, { endpoints: BASE_ENDPOINTS }))
      .rejects.toThrow("projection identity does not match its v6 content and request");
    expect(selfConsistentForgery.activeKey).toBeUndefined();
  });

  it("accepts a response request whose insertion order differs from the browser request", async () => {
    const canonical = canonicalizeProjectionRequest(REQUEST);
    const serverOrderedRequest: GraphProjectionRequest = {
      version: canonical.version,
      view: canonical.view,
      focusIds: canonical.focusIds,
      expandedIds: canonical.expandedIds,
      extraIds: canonical.extraIds,
      causalIds: canonical.causalIds,
      serviceExpandedLeadIds: canonical.serviceExpandedLeadIds,
      filePaths: canonical.filePaths,
      reviewCursor: canonical.reviewCursor,
      depth: canonical.depth,
      includeTests: canonical.includeTests,
      includeReachability: canonical.includeReachability,
      maxNodes: canonical.maxNodes,
      maxEdges: canonical.maxEdges,
      maxResponseBytes: canonical.maxResponseBytes,
    };
    const client = new GraphProjectionClient({
      fetch: async (input, init) => String(input).includes("manifest")
        ? jsonResponse(manifest("graph-1"))
        : projectionResponse(requestFrom(init), { request: serverOrderedRequest }),
    });

    await expect(commitProjection(client, REQUEST, { endpoints: BASE_ENDPOINTS }))
      .resolves.toMatchObject({ graphId: "graph-1" });
  });

  it("accepts overview roots only on an unfocused modules projection", async () => {
    const focusedRequest = { ...REQUEST, focusIds: ["ts:src"] };
    const client = new GraphProjectionClient({
      fetch: async (input, init) => String(input).includes("manifest")
        ? jsonResponse(manifest("graph-1"))
        : projectionResponse(requestFrom(init), {
            hierarchy: {
              moduleOverviewRootIds: ["ts:src"],
              nodes: Object.fromEntries(deriveGraphStructure(ARTIFACT.nodes, ARTIFACT.edges).hierarchyById),
            },
          }),
    });

    await expect(commitProjection(client, focusedRequest, { endpoints: BASE_ENDPOINTS }))
      .rejects.toThrow("overview roots belong only to a repository overview");
  });

  it("searches the immutable graph catalog through its explicit strict endpoint", async () => {
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
    const client = new GraphProjectionClient({ fetch: fetchMock });
    const request = {
      version: 1,
      query: "src",
      mode: "map",
      scope: "public",
    } as const;

    await expect(client.searchSymbols(request, { endpoints: GRAPH_ONE_API_ENDPOINTS })).resolves.toMatchObject({
      version: 1,
      graphId: "graph-1",
      contentId: "0".repeat(64),
      results: [{ id: "ts:src", displayName: "src" }],
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects NUL search queries before transport and unknown response fields after transport", async () => {
    const neverFetch = vi.fn<typeof fetch>();
    const client = new GraphProjectionClient({ fetch: neverFetch });
    await expect(client.searchSymbols({
      version: 1,
      query: "src",
      mode: "map",
      scope: "public",
      legacyLimit: 500,
    } as unknown as GraphSymbolSearchRequest, { endpoints: BASE_ENDPOINTS }))
      .rejects.toThrow("request: fields do not match the v1 contract");
    await expect(client.searchSymbols({
      version: 1,
      query: "src\0hidden",
      mode: "map",
      scope: "public",
    }, { endpoints: BASE_ENDPOINTS })).rejects.toThrow("query exceeds 256 UTF-8 bytes");
    expect(neverFetch).not.toHaveBeenCalled();

    const strictClient = new GraphProjectionClient({
      fetch: async (input) => String(input).includes("manifest")
        ? jsonResponse(manifest("graph-1"))
        : jsonResponse({ ...symbolSearchResponse("graph-1"), legacyGraphId: "graph-1" }),
    });
    await expect(strictClient.searchSymbols({
      version: 1,
      query: "src",
      mode: "map",
      scope: "public",
    }, { endpoints: BASE_ENDPOINTS })).rejects.toThrow("fields do not match the v1 contract");
  });

  it("never commits a projection if its navigation signal aborts while the body is decoding", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      if (String(input).includes("manifest")) return jsonResponse(manifest("graph-1"));
      controller.abort();
      return projectionResponse(requestFrom(init));
    });
    const client = new GraphProjectionClient({ fetch: fetchMock });

    await expect(commitProjection(client, REQUEST, {
      endpoints: BASE_ENDPOINTS,
      signal: controller.signal,
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(client.activeKey).toBeUndefined();
  });

  it("rejects a raw GraphArtifact response instead of accepting the removed compatibility shape", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => String(input).includes("manifest")
      ? jsonResponse(manifest("graph-1"))
      : jsonResponse(ARTIFACT));
    const client = new GraphProjectionClient({ fetch: fetchMock });

    await expect(commitProjection(client, REQUEST, { endpoints: BASE_ENDPOINTS }))
      .rejects.toThrow("fields do not match the v6 contract");
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
      return projectionResponse(requestFrom(init));
    });
    const client = new GraphProjectionClient({ fetch: fetchMock });

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
    const client = new GraphProjectionClient({ fetch: fetchMock });
    const first = new AbortController();
    const second = new AbortController();
    const firstRead = client.loadManifest({ endpoints: BASE_ENDPOINTS, signal: first.signal });
    const secondRead = client.loadManifest({ endpoints: BASE_ENDPOINTS, signal: second.signal });
    await started;

    first.abort();
    await expect(firstRead).rejects.toMatchObject({ name: "AbortError" });
    expect(transportSignal?.aborted).toBe(false);
    second.abort();
    await expect(secondRead).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(transportSignal?.aborted).toBe(true));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("starts one manifest successor only after an abandoned transport drains", async () => {
    let rejectAbandoned!: (reason: unknown) => void;
    let abandonedSignal: AbortSignal | undefined;
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      if (fetchMock.mock.calls.length === 1) {
        abandonedSignal = init?.signal as AbortSignal;
        return new Promise<Response>((_resolve, reject) => { rejectAbandoned = reject; });
      }
      return jsonResponse(manifest("graph-1"));
    });
    const client = new GraphProjectionClient({ fetch: fetchMock });
    const abandoned = new AbortController();
    const first = client.loadManifest({ endpoints: BASE_ENDPOINTS, signal: abandoned.signal });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    abandoned.abort();
    await expect(first).rejects.toMatchObject({ name: "AbortError" });

    const successor = client.loadManifest({ endpoints: BASE_ENDPOINTS });
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    rejectAbandoned(abandonedSignal?.reason);

    await expect(successor).resolves.toMatchObject({ graphId: "graph-1" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("bounds canceled manifest transports and never duplicates an abandoned live key", async () => {
    const transportSignals: AbortSignal[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      transportSignals.push(init?.signal as AbortSignal);
      // Model a broken transport that ignores cancellation. Its live reads must still remain
      // bounded, and the client must not start a duplicate while the abandoned flight is pending.
      return new Promise<Response>(() => undefined);
    });
    const client = new GraphProjectionClient({ fetch: fetchMock });

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
    const successorController = new AbortController();
    const successor = client.loadManifest({
      endpoints: graphEndpoints("stalled-0"),
      signal: successorController.signal,
    });
    successorController.abort();
    await expect(successor).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).toHaveBeenCalledTimes(16);
  });
});

function deferredResponse(): {
  promise: Promise<Response>;
  resolve(value: Response): void;
} {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

function projectionRequestWithExactBytes(targetBytes: number): GraphProjectionRequest {
  const empty: GraphProjectionRequest = { ...REQUEST, causalIds: [] };
  const encoder = new TextEncoder();
  const emptyBytes = encoder.encode(JSON.stringify(empty)).byteLength;
  for (let count = 1; count <= 2_000; count += 1) {
    const prefixes = Array.from(
      { length: count },
      (_, index) => `${index.toString().padStart(4, "0")}:`,
    );
    const idBytes = targetBytes - emptyBytes - (3 * count - 1);
    const minimum = prefixes.reduce((sum, prefix) => sum + prefix.length, 0);
    if (idBytes < minimum || idBytes > count * 2_048) continue;

    let remaining = idBytes;
    const causalIds = prefixes.map((prefix, index) => {
      const remainingMinimum = prefixes
        .slice(index + 1)
        .reduce((sum, candidate) => sum + candidate.length, 0);
      const length = Math.min(2_048, remaining - remainingMinimum);
      remaining -= length;
      return `${prefix}${"x".repeat(length - prefix.length)}`;
    });
    const lastIndex = causalIds.length - 1;
    const lastId = causalIds[lastIndex]!;
    if (!lastId.endsWith("xx")) continue;
    // Preserve the exact byte count while proving the boundary is UTF-8 bytes, not JS code units.
    causalIds[lastIndex] = `${lastId.slice(0, -2)}é`;
    const request = { ...empty, causalIds };
    if (encoder.encode(JSON.stringify(request)).byteLength === targetBytes) return request;
  }
  throw new Error(`could not construct a ${targetBytes}-byte projection request`);
}

function jsonResponse(value: unknown): Response {
  const body = JSON.stringify(value);
  const record = typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "content-length": String(new TextEncoder().encode(body).byteLength),
  };
  if (typeof record?.projectionId === "string" && Number.isSafeInteger(record.residentBytes)) {
    headers["x-meridian-projection-id"] = record.projectionId;
    headers["x-meridian-resident-bytes"] = String(record.residentBytes);
  }
  return new Response(body, {
    status: 200,
    headers,
  });
}

function malformedUtf8Response(): Response {
  return new Response(new Uint8Array([0x7b, 0x22, 0xc3, 0x28, 0x22, 0x3a, 0x31, 0x7d]), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function requestFrom(init: RequestInit | undefined): GraphProjectionRequest {
  return canonicalizeProjectionRequest(JSON.parse(String(init?.body)) as GraphProjectionRequest);
}

async function projectionEnvelope(
  request: GraphProjectionRequest,
  overrides: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const rest = { ...overrides };
  delete rest.projectionId;
  const artifact = isGraphArtifactFixture(rest.artifact) ? rest.artifact : ARTIFACT;
  delete rest.artifact;
  const canonical = canonicalizeProjectionRequest(request);
  const structure = deriveGraphStructure(artifact.nodes, artifact.edges);
  const moduleOverview = canonical.focusIds.length === 0
    && (canonical.view === "modules" || canonical.view === "ui")
    ? structure.moduleOverview
    : null;
  const service = canonical.view === "service"
    ? deriveSerializedServiceTopology(artifact.nodes, artifact.edges)
    : null;
  const envelope: Record<string, unknown> = {
    version: 6,
    contentId: "0".repeat(64),
    request: canonical,
    artifact,
    hierarchy: {
      moduleOverviewRootIds: canonical.view === "modules" && canonical.focusIds.length === 0
        ? structure.moduleOverviewRootIds
        : [],
      nodes: Object.fromEntries(structure.hierarchyById),
    },
    viewFacts: { moduleOverview, service, review: null },
    analysis: {
      reachability: canonical.includeReachability
        ? buildReachabilityProjection(artifact.nodes, artifact.edges)
        : null,
    },
    completeness: { complete: true, reasons: [], omittedNodes: 0, omittedEdges: 0 },
    residentBytes: 1,
    ...rest,
  };
  envelope.projectionId = await projectionIdForTest(
    String(envelope.contentId),
    envelope.request,
  );
  return envelope;
}

function isGraphArtifactFixture(value: unknown): value is GraphArtifact {
  return typeof value === "object" && value !== null
    && Array.isArray((value as GraphArtifact).nodes)
    && Array.isArray((value as GraphArtifact).edges);
}

async function projectionResponse(
  request: GraphProjectionRequest,
  overrides: Record<string, unknown> = {},
): Promise<Response> {
  return jsonResponse(await projectionEnvelope(request, overrides));
}

async function projectionIdForTest(contentId: string, request: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(
    graphProjectionIdentityPreimage(contentId, request as GraphProjectionRequest),
  );
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function graphEndpoints(graphId: string) {
  return {
    graphId,
    manifestUrl: `/manifest?id=${graphId}`,
    projectionUrl: `/projection?id=${graphId}`,
    searchUrl: `/search?id=${graphId}`,
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
  const structure = deriveGraphStructure(ARTIFACT.nodes, ARTIFACT.edges);
  return {
    version: 6,
    graphId,
    contentId: "0".repeat(64),
    graphSummary: {
      schemaVersion: ARTIFACT.schemaVersion,
      generatedAt: ARTIFACT.generatedAt,
      nodeCount: ARTIFACT.nodes.length,
      edgeCount: ARTIFACT.edges.length,
    },
    repositorySummary: structure.repositorySummary,
    defaultView: canonicalizeProjectionRequest(REQUEST),
  };
}
