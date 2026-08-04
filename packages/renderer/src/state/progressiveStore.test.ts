import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  GraphArtifact,
  GraphNode,
  GraphProjectionV1,
  GraphSymbolSearchResultV1,
} from "@meridian/core";
import { GRAPH_PROJECTION_VERSION, GRAPH_SYMBOL_SEARCH_VERSION } from "@meridian/core";
import { buildGraphIndex } from "../graph/graphIndex";
import { swapToPreparedArtifact } from "./prReviewSession";
import { fetchGraphSymbols, projectionToArtifact } from "./progressiveGraph";
import {
  createBlueprintStore,
  isProgressiveProjectionPairReady,
  mergeProjectionIntoDisplayedArtifact,
} from "./store";

const PACKAGE = "ts:src";
const FILE_A = "ts:src/a.ts";
const METHOD_A = `${FILE_A}#run`;
const FILE_B = "ts:src/b.ts";
const METHOD_B = `${FILE_B}#searchTarget`;
const FILE_C = "ts:src/c.ts";
const METHOD_C = `${FILE_C}#caller`;
const TEST_FILE_B = "ts:src/b.test.ts";
const TEST_METHOD_B = `${TEST_FILE_B}#searchTarget`;
const OTHER_TEST_FILE = "ts:src/other.test.ts";
const OTHER_TEST_METHOD = `${OTHER_TEST_FILE}#unrelatedTest`;
const DELETED = "ts:src/deleted.ts";
const DELETED_METHOD = `${DELETED}#removed`;
const PY_NAMESPACE = "py:src";
const PY_INIT = "py:src/acme";
const PY_FUNCTION = `${PY_INIT}#bootstrap`;

function node(id: string, kind: GraphNode["kind"], file: string, parentId?: string): GraphNode {
  return {
    id,
    kind,
    displayName: id.split(/[#/]/).at(-1) ?? id,
    qualifiedName: id,
    ...(parentId === undefined ? {} : { parentId }),
    location: { file, startLine: 1, endLine: 2 },
  };
}

const packageNode = node(PACKAGE, "package", "src");
const fileA = node(FILE_A, "module", "src/a.ts", PACKAGE);
const methodA = node(METHOD_A, "method", "src/a.ts", FILE_A);
const fileB = node(FILE_B, "module", "src/b.ts", PACKAGE);
const methodB = node(METHOD_B, "function", "src/b.ts", FILE_B);
const fileC = node(FILE_C, "module", "src/c.ts", PACKAGE);
const methodC = node(METHOD_C, "function", "src/c.ts", FILE_C);
const testFileB = node(TEST_FILE_B, "module", "src/b.test.ts", PACKAGE);
const testMethodB = node(TEST_METHOD_B, "function", "src/b.test.ts", TEST_FILE_B);
const otherTestFile = node(OTHER_TEST_FILE, "module", "src/other.test.ts", PACKAGE);
const otherTestMethod = node(OTHER_TEST_METHOD, "function", "src/other.test.ts", OTHER_TEST_FILE);
const pythonNamespace = node(PY_NAMESPACE, "package", "src/acme");
const pythonInit = node(PY_INIT, "package", "src/acme/__init__.py", PY_NAMESPACE);
const pythonFunction = node(PY_FUNCTION, "function", "src/acme/__init__.py", PY_INIT);

function projection(options: {
  nodes: GraphNode[];
  roots: string[];
  loadedFiles: string[];
  ready?: string[];
  frontierFiles?: string[];
  requestedDepth?: number;
  prefetchDepth?: number;
}): GraphProjectionV1 {
  const requestedDepth = options.requestedDepth ?? 1;
  return {
    version: GRAPH_PROJECTION_VERSION,
    graphId: "head-graph",
    seedGraphId: "head-graph",
    generation: "immutable-head-generation",
    requestedDepth,
    prefetchDepth: options.prefetchDepth ?? 3,
    loadedDepth: requestedDepth,
    schemaVersion: "1.0.0",
    generatedAt: "2026-07-31T00:00:00.000Z",
    generator: { name: "test", version: "1" },
    target: { name: "fixture", root: ".", language: "typescript" },
    nodes: options.nodes,
    edges: [],
    rootFileIds: options.roots,
    readyFileIds: options.ready ?? options.roots,
    loadedFileIds: options.loadedFiles,
    frontier: (options.frontierFiles ?? options.loadedFiles).map((fileId) => ({
      fileId,
      hasMore: false,
      completeThroughDepth: requestedDepth,
    })),
    counts: {
      full: { nodes: 100, edges: 100, files: 50 },
      slice: {
        nodes: options.nodes.length,
        edges: 0,
        files: options.nodes.filter((candidate) => candidate.kind === "module"
          || (candidate.kind === "package" && candidate.location.file.endsWith(".py"))).length,
      },
    },
  };
}

const INITIAL = projection({
  nodes: [packageNode, fileA, methodA],
  roots: [FILE_A],
  loadedFiles: [FILE_A],
});

function storeWithInitialProjection(
  artifact = projectionToArtifact(INITIAL),
  loadCanonicalBootArtifact?: (signal: AbortSignal) => Promise<GraphArtifact>,
  inlineSymbolLoader: typeof fetchGraphSymbols | null = fetchGraphSymbols,
  initialGraphProvisional = false,
) {
  return createBlueprintStore({
    artifact,
    index: buildGraphIndex(artifact),
    provider: null,
    hasOverlay: false,
    sourceUrl: null,
    prsUrl: "/api/prs?id=head-graph",
    prOneUrl: "/api/prs/one?id=head-graph",
    prFilesUrl: "/api/prs/files?id=head-graph",
    prRelatedUrl: "/api/prs/related?id=head-graph",
    prCommentsUrl: "/api/prs/comments?id=head-graph",
    prChecksUrl: "/api/prs/checks?id=head-graph",
    prReviewUrl: "/api/prs/review?id=head-graph",
    graphUrl: "/api/graph?id=head-graph",
    graphProjectUrl: "/api/graph/project",
    graphSymbolsUrl: "/api/graph/symbols",
    ...(inlineSymbolLoader === null ? {} : { loadGraphSymbolsInlineForTest: inlineSymbolLoader }),
    initialGraphProjection: INITIAL,
    initialGraphProvisional,
    loadCanonicalBootArtifact,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("progressive graph store", () => {
  it("degrades to loaded-graph search without fetching a repository index on a Worker-less UI", async () => {
    vi.stubGlobal("Worker", undefined);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const store = storeWithInitialProjection(projectionToArtifact(INITIAL), undefined, null);

    await store.getState().startProgressiveSymbolIndex();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(store.getState().progressiveSymbols).toMatchObject({
      status: "error",
      workerBacked: false,
      symbols: [],
    });
    await expect(store.getState().ensureNodeReady(METHOD_A)).resolves.toBe(true);
  });

  it("does not snapshot a bounded direct-boot projection as the canonical review baseline", () => {
    const partialArtifact = projectionToArtifact(INITIAL);
    const store = storeWithInitialProjection(partialArtifact);

    swapToPreparedArtifact(
      store.getState,
      store.setState,
      partialArtifact,
      () => undefined,
      undefined,
      null,
      undefined,
      null,
    );

    expect(store.getState().prPreparedArtifactCurrent).toBe(true);
    expect(store.getState().prReviewBaseline).toBeNull();
  });

  it("indexes in the background and admits a disconnected search result only after depth 1 is ready", async () => {
    const performanceMark = vi.fn();
    vi.stubGlobal("performance", { now: () => 123.5, mark: performanceMark });
    vi.stubGlobal("Worker", undefined);
    const deleted = node(DELETED, "module", "src/deleted.ts", PACKAGE);
    const displayed = { ...projectionToArtifact(INITIAL), nodes: [...INITIAL.nodes, deleted] } as GraphArtifact;
    const store = storeWithInitialProjection(displayed);
    store.setState({ viewMode: "prs" });

    const symbols: GraphSymbolSearchResultV1 = {
      version: GRAPH_SYMBOL_SEARCH_VERSION,
      graphId: "head-graph",
      generation: "immutable-head-generation",
      complete: true,
      indexedSymbolCount: 1,
      totalSymbolCount: 1,
      symbols: [{
        id: METHOD_B,
        fileId: FILE_B,
        displayName: "searchTarget",
        qualifiedName: METHOD_B,
        kind: "function",
        file: "src/b.ts",
        isPrivateMethod: false,
        stepCount: null,
      }],
    };
    const fragment = projection({
      nodes: [packageNode, fileB, methodB],
      roots: [FILE_B],
      loadedFiles: [FILE_B],
      prefetchDepth: 1,
    });
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => new Response(
      JSON.stringify(init?.method === "POST" ? fragment : symbols),
      { status: 200, headers: { "content-type": "application/json" } },
    ));
    vi.stubGlobal("fetch", fetchMock);

    await store.getState().startProgressiveSymbolIndex();
    expect(store.getState().progressiveSymbols.status).toBe("ready");
    expect(store.getState().index.nodesById.has(METHOD_B)).toBe(false);
    expect(performanceMark).toHaveBeenCalledWith("meridian:progressive-symbol-index-ready", {
      detail: {
        symbols: 1,
        graphId: "head-graph",
        generation: "immutable-head-generation",
        requestStartedAtMs: 123.5,
        workerBacked: 0,
        source: "renderer-inline-index-accepted",
      },
    });

    await expect(store.getState().ensureNodeReady(METHOD_B)).resolves.toBe(true);
    const admissionRequest = JSON.parse(String(fetchMock.mock.calls.find(([, init]) => init?.method === "POST")?.[1]?.body));
    expect(admissionRequest).toMatchObject({ requestedDepth: 1, prefetchDepth: 1 });
    expect(store.getState().index.nodesById.has(METHOD_B)).toBe(true);
    expect(store.getState().index.nodesById.has(DELETED)).toBe(true);
    expect(store.getState().progressivePendingNodeIds.size).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps a disconnected symbol nonready after a 503 and admits it only after an explicit retry", async () => {
    const store = storeWithInitialProjection();
    const fragment = projection({
      nodes: [packageNode, fileB, methodB],
      roots: [FILE_B],
      loadedFiles: [FILE_B],
      prefetchDepth: 1,
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("projection unavailable", { status: 503 }))
      .mockResolvedValueOnce(Response.json(fragment));
    vi.stubGlobal("fetch", fetchMock);

    await expect(store.getState().ensureNodeReady(METHOD_B, FILE_B)).resolves.toBe(false);
    expect(store.getState().index.nodesById.has(METHOD_B)).toBe(false);
    expect(store.getState().progressiveGraph?.head.readyFileIds).not.toContain(FILE_B);
    expect(store.getState().progressivePendingNodeIds).toEqual(new Set());
    expect(store.getState().progressiveGraph).toMatchObject({ status: "error" });

    await expect(store.getState().ensureNodeReady(METHOD_B, FILE_B)).resolves.toBe(true);
    expect(store.getState().index.nodesById.has(METHOD_B)).toBe(true);
    expect(store.getState().progressiveGraph?.head.readyFileIds).toContain(FILE_B);
    expect(store.getState().progressivePendingNodeIds).toEqual(new Set());
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("ignores a file hint for a resident structural package instead of posting an invalid HEAD root", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const store = storeWithInitialProjection();

    await expect(store.getState().ensureNodeReady(PACKAGE, FILE_B)).resolves.toBe(true);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(store.getState().index.nodesById.has(PACKAGE)).toBe(true);
  });

  it("keeps a disconnected search root visible when it is added to an active Diff-only review", async () => {
    const store = storeWithInitialProjection();
    const fragment = projection({
      nodes: [packageNode, fileB, methodB],
      roots: [FILE_B],
      loadedFiles: [FILE_B],
      prefetchDepth: 1,
    });
    store.setState({
      viewMode: "modules",
      review: {
        context: {
          changedFiles: [],
          baseRef: null,
          baseSha: null,
          headRef: "feature",
          reviewKey: "diff-only-search-root",
          warnings: [],
        },
        rows: [],
        flows: {},
      },
      reviewAffectedIds: new Set([METHOD_A]),
      reviewDiffOnly: true,
      minimalSeedIds: [FILE_A],
      minimalMemberIds: [FILE_A],
      moduleExpanded: new Set([PACKAGE, FILE_A]),
      progressiveSymbols: {
        status: "ready",
        graphId: "head-graph",
        generation: "immutable-head-generation",
        symbols: [{
          id: METHOD_B,
          fileId: FILE_B,
          displayName: "searchTarget",
          qualifiedName: METHOD_B,
          kind: "function",
          file: "src/b.ts",
          isPrivateMethod: false,
          stepCount: null,
        }],
        indexed: 1,
        total: 1,
        error: null,
      },
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => String(input).includes("/warm")
      ? Response.json({ warmed: true })
      : Response.json(fragment));
    vi.stubGlobal("fetch", fetchMock);

    await expect(store.getState().ensureNodeReady(METHOD_B)).resolves.toBe(true);
    expect(store.getState().progressiveGraph?.explicitFileIds).toContain(FILE_B);
    store.getState().addToView(METHOD_B);
    await vi.waitFor(() => expect(store.getState().minimalLayoutStatus).toBe("ready"));

    expect(store.getState().minimalMemberIds).toEqual([FILE_A, FILE_B]);
    expect(store.getState().minimalRfNodes).toContainEqual(expect.objectContaining({ id: FILE_B }));
    expect(store.getState().minimalRfNodes).toContainEqual(expect.objectContaining({ id: METHOD_B }));
  });

  it("shows only an explicitly added repository test root while the Tests preference stays off", async () => {
    const store = storeWithInitialProjection();
    const fragment = projection({
      nodes: [packageNode, testFileB, testMethodB, otherTestFile, otherTestMethod],
      roots: [TEST_FILE_B],
      loadedFiles: [TEST_FILE_B, OTHER_TEST_FILE],
      prefetchDepth: 1,
    });
    store.setState({
      viewMode: "modules",
      review: {
        context: {
          changedFiles: [],
          baseRef: null,
          baseSha: null,
          headRef: "feature",
          reviewKey: "hidden-test-search-root",
          warnings: [],
        },
        rows: [],
        flows: {},
      },
      reviewAffectedIds: new Set([METHOD_A]),
      reviewDiffOnly: true,
      minimalSeedIds: [FILE_A],
      minimalMemberIds: [FILE_A],
      moduleExpanded: new Set([PACKAGE, FILE_A]),
      progressiveSymbols: {
        status: "ready",
        graphId: "head-graph",
        generation: "immutable-head-generation",
        symbols: [{
          id: TEST_METHOD_B,
          fileId: TEST_FILE_B,
          displayName: "searchTarget",
          qualifiedName: TEST_METHOD_B,
          kind: "function",
          file: "src/b.test.ts",
          isPrivateMethod: false,
          stepCount: null,
        }],
        indexed: 1,
        total: 1,
        error: null,
      },
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => String(input).includes("/warm")
      ? Response.json({ warmed: true })
      : Response.json(fragment));
    vi.stubGlobal("fetch", fetchMock);

    await expect(store.getState().ensureNodeReady(TEST_METHOD_B)).resolves.toBe(true);
    expect([...store.getState().index.testIds]).toEqual(expect.arrayContaining([
      TEST_FILE_B, TEST_METHOD_B, OTHER_TEST_FILE, OTHER_TEST_METHOD,
    ]));
    store.getState().addToView(TEST_METHOD_B);
    await vi.waitFor(() => expect(store.getState().minimalLayoutStatus).toBe("ready"));

    expect(store.getState().showTests).toBe(false);
    expect(store.getState().minimalRfNodes).toContainEqual(expect.objectContaining({ id: TEST_FILE_B }));
    expect(store.getState().minimalRfNodes).toContainEqual(expect.objectContaining({ id: TEST_METHOD_B }));
    expect(store.getState().minimalRfNodes.some(({ id }) => id === OTHER_TEST_FILE || id === OTHER_TEST_METHOD)).toBe(false);
  });

  it("applies the same picked-test exception on the ordinary Map without enabling all tests", async () => {
    const store = storeWithInitialProjection();
    const fragment = projection({
      nodes: [packageNode, testFileB, testMethodB, otherTestFile, otherTestMethod],
      roots: [TEST_FILE_B],
      loadedFiles: [TEST_FILE_B, OTHER_TEST_FILE],
      prefetchDepth: 1,
    });
    store.setState({
      viewMode: "modules",
      progressiveSymbols: {
        status: "ready",
        graphId: "head-graph",
        generation: "immutable-head-generation",
        symbols: [{
          id: TEST_METHOD_B,
          fileId: TEST_FILE_B,
          displayName: "searchTarget",
          qualifiedName: TEST_METHOD_B,
          kind: "function",
          file: "src/b.test.ts",
          isPrivateMethod: false,
          stepCount: null,
        }],
        indexed: 1,
        total: 1,
        error: null,
      },
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => String(input).includes("/warm")
      ? Response.json({ warmed: true })
      : Response.json(fragment));
    vi.stubGlobal("fetch", fetchMock);

    await expect(store.getState().ensureNodeReady(TEST_METHOD_B)).resolves.toBe(true);
    store.getState().addToView(TEST_METHOD_B);
    await vi.waitFor(() => expect(store.getState().moduleLayoutStatus).toBe("ready"));

    expect(store.getState().showTests).toBe(false);
    expect(store.getState().mapExtra).toContain(TEST_FILE_B);
    expect(store.getState().moduleRfNodes).toContainEqual(expect.objectContaining({ id: TEST_FILE_B }));
    expect(store.getState().moduleRfNodes.some(({ id }) => id === OTHER_TEST_FILE || id === OTHER_TEST_METHOD)).toBe(false);
  });

  it("retries symbol indexing after interactive graph work preempts the background request", async () => {
    const store = storeWithInitialProjection();
    const symbols: GraphSymbolSearchResultV1 = {
      version: GRAPH_SYMBOL_SEARCH_VERSION,
      graphId: "head-graph",
      generation: "immutable-head-generation",
      complete: true,
      indexedSymbolCount: 1,
      totalSymbolCount: 1,
      symbols: [{
        id: METHOD_B,
        fileId: FILE_B,
        displayName: "searchTarget",
        qualifiedName: METHOD_B,
        kind: "function",
        file: "src/b.ts",
        isPrivateMethod: false,
        stepCount: null,
      }],
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(
        "background graph work yielded to an interactive projection; retry shortly",
        { status: 503 },
      ))
      .mockResolvedValueOnce(Response.json(symbols));
    vi.stubGlobal("fetch", fetchMock);

    await store.getState().startProgressiveSymbolIndex();
    expect(store.getState().progressiveSymbols).toMatchObject({ status: "error" });

    // Opening Cmd+P invokes this action again. An interrupted idle-time attempt must therefore be
    // retryable instead of leaving search permanently unavailable for the progressive session.
    await store.getState().startProgressiveSymbolIndex();
    expect(store.getState().progressiveSymbols).toMatchObject({
      status: "ready",
      symbols: [{ id: METHOD_B }],
      error: null,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("hydrates a represented boundary search result from its exact file root", async () => {
    const boundary = projection({
      nodes: [packageNode, fileA, methodA, fileB, methodB],
      roots: [FILE_A],
      loadedFiles: [FILE_A, FILE_B],
      ready: [FILE_A],
    });
    const store = storeWithInitialProjection(projectionToArtifact(boundary));
    store.setState({
      progressiveGraph: {
        head: boundary,
        comparison: null,
        explicitFileIds: [],
        affectedDepth: 1,
        requestedDepth: 1,
        status: "ready",
        error: null,
      },
    });
    const hydrated = projection({
      nodes: [packageNode, fileB, methodB],
      roots: [FILE_B],
      loadedFiles: [FILE_B],
      ready: [FILE_B],
      requestedDepth: 1,
      prefetchDepth: 1,
    });
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as {
        roots: { kind: string };
        requestedDepth: number;
        prefetchDepth: number;
      };
      expect(request.roots).toEqual({ kind: "files", fileIds: [FILE_B] });
      expect(request.requestedDepth).toBe(1);
      expect(request.prefetchDepth).toBe(1);
      return Response.json(hydrated);
    });
    vi.stubGlobal("fetch", fetchMock);

    expect(store.getState().index.nodesById.has(METHOD_B)).toBe(true);
    await expect(store.getState().ensureNodeReady(METHOD_B)).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(store.getState().progressiveGraph?.head.readyFileIds).toContain(FILE_B);
    expect(store.getState().progressiveGraph?.affectedDepth).toBe(1);
    expect(store.getState().progressiveGraph?.explicitFileIds).toEqual([FILE_B]);
  });

  it("still consumes the next affected-file ring for an actionable traversal ghost", async () => {
    const boundary = projection({
      nodes: [packageNode, fileA, methodA, fileB, methodB],
      roots: [FILE_A],
      loadedFiles: [FILE_A, FILE_B],
      ready: [FILE_A],
    });
    const store = storeWithInitialProjection(projectionToArtifact(boundary));
    const minimalRelayout = vi.fn(async () => {});
    store.setState({
      progressiveGraph: {
        head: boundary,
        comparison: null,
        explicitFileIds: [],
        affectedDepth: 1,
        requestedDepth: 1,
        status: "ready",
        error: null,
      },
      minimalSeedIds: [FILE_A],
      minimalMemberIds: [FILE_A],
      minimalRelayout,
    });
    const hydrated = projection({
      nodes: [packageNode, fileA, methodA, fileB, methodB],
      roots: [FILE_A],
      loadedFiles: [FILE_A, FILE_B],
      ready: [FILE_A, FILE_B],
      requestedDepth: 2,
      prefetchDepth: 2,
    });
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as {
        roots: unknown;
        requestedDepth: number;
        prefetchDepth: number;
      };
      expect(request.roots).toEqual({ kind: "changed-files", seedGraphId: "head-graph" });
      expect(request.requestedDepth).toBe(2);
      expect(request.prefetchDepth).toBe(2);
      return Response.json(hydrated);
    });
    vi.stubGlobal("fetch", fetchMock);

    store.getState().promoteGhost(METHOD_B, { x: 20, y: 30 });
    await vi.waitFor(() => expect(store.getState().minimalMemberIds).toContain(FILE_B));

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(store.getState().progressiveGraph?.head.readyFileIds).toContain(FILE_B);
    expect(store.getState().progressiveGraph?.affectedDepth).toBe(2);
    expect(store.getState().progressiveGraph?.explicitFileIds).toEqual([]);
    expect(store.getState().progressivePendingNodeIds).toEqual(new Set());
  });

  it("hydrates a resident Python initializer symbol through its package-backed file root", async () => {
    const boundary = projection({
      nodes: [packageNode, fileA, methodA, pythonNamespace, pythonInit, pythonFunction],
      roots: [FILE_A],
      loadedFiles: [FILE_A, PY_INIT],
      frontierFiles: [FILE_A],
      ready: [FILE_A],
    });
    const store = storeWithInitialProjection(projectionToArtifact(boundary));
    store.setState({
      progressiveGraph: {
        head: boundary,
        comparison: null,
        explicitFileIds: [],
        affectedDepth: 1,
        requestedDepth: 1,
        status: "ready",
        error: null,
      },
    });
    const hydrated = projection({
      nodes: [pythonNamespace, pythonInit, pythonFunction],
      roots: [PY_INIT],
      loadedFiles: [PY_INIT],
      ready: [PY_INIT],
      prefetchDepth: 1,
    });
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as {
        roots: unknown;
        requestedDepth: number;
        prefetchDepth: number;
      };
      expect(request.roots).toEqual({ kind: "files", fileIds: [PY_INIT] });
      expect(request).toMatchObject({ requestedDepth: 1, prefetchDepth: 1 });
      return Response.json(hydrated);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(store.getState().ensureNodeReady(PY_FUNCTION)).resolves.toBe(true);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(store.getState().progressiveGraph?.head.readyFileIds).toContain(PY_INIT);
    expect(store.getState().progressivePendingNodeIds).toEqual(new Set());
  });

  it("hydrates a Python initializer ghost before admitting its file root to the minimal canvas", async () => {
    const boundary = projection({
      nodes: [packageNode, fileA, methodA, pythonNamespace, pythonInit, pythonFunction],
      roots: [FILE_A],
      loadedFiles: [FILE_A, PY_INIT],
      frontierFiles: [FILE_A],
      ready: [FILE_A],
    });
    const store = storeWithInitialProjection(projectionToArtifact(boundary));
    const minimalRelayout = vi.fn(async () => {});
    store.setState({
      progressiveGraph: {
        head: boundary,
        comparison: null,
        explicitFileIds: [],
        affectedDepth: 1,
        requestedDepth: 1,
        status: "ready",
        error: null,
      },
      minimalSeedIds: [FILE_A],
      minimalMemberIds: [FILE_A],
      minimalRelayout,
    });
    const hydrated = projection({
      nodes: [pythonNamespace, pythonInit, pythonFunction],
      roots: [PY_INIT],
      loadedFiles: [PY_INIT],
      ready: [PY_INIT],
      prefetchDepth: 1,
    });
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as {
        roots: unknown;
        requestedDepth: number;
        prefetchDepth: number;
      };
      expect(request.roots).toEqual({ kind: "files", fileIds: [PY_INIT] });
      expect(request).toMatchObject({ requestedDepth: 1, prefetchDepth: 1 });
      return Response.json(hydrated);
    });
    vi.stubGlobal("fetch", fetchMock);

    store.getState().promoteGhost(PY_FUNCTION, { x: 20, y: 30 });
    expect(store.getState().minimalMemberIds).not.toContain(PY_INIT);
    await vi.waitFor(() => expect(store.getState().minimalMemberIds).toContain(PY_INIT));

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(store.getState().progressiveGraph?.head.readyFileIds).toContain(PY_INIT);
    expect(store.getState().progressivePendingNodeIds).toEqual(new Set());
    expect(store.getState().minimalBasePositions[PY_INIT]).toEqual(expect.objectContaining({ x: 20, y: 30 }));
    expect(minimalRelayout).toHaveBeenCalledOnce();
  });

  it("hydrates a presentation-only coupling ghost directly without expanding changed roots first", async () => {
    const presentationGhost = projection({
      nodes: [packageNode, fileA, methodA, fileB, methodB],
      roots: [FILE_A],
      loadedFiles: [FILE_A, FILE_B],
      frontierFiles: [FILE_A],
      ready: [FILE_A],
    });
    const store = storeWithInitialProjection(projectionToArtifact(presentationGhost));
    store.setState({
      progressiveGraph: {
        head: presentationGhost,
        comparison: null,
        explicitFileIds: [],
        affectedDepth: 1,
        requestedDepth: 1,
        status: "ready",
        error: null,
      },
    });
    const explicit = projection({
      nodes: [packageNode, fileB, methodB],
      roots: [FILE_B],
      loadedFiles: [FILE_B],
      frontierFiles: [FILE_B],
      ready: [FILE_B],
      requestedDepth: 1,
      prefetchDepth: 1,
    });
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as {
        roots: { kind: string; fileIds?: string[] };
        requestedDepth: number;
        prefetchDepth: number;
      };
      expect(request.roots).toEqual({ kind: "files", fileIds: [FILE_B] });
      expect(request.requestedDepth).toBe(1);
      expect(request.prefetchDepth).toBe(1);
      return Response.json(explicit);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(store.getState().ensureNodeReady(METHOD_B)).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(store.getState().progressiveGraph?.affectedDepth).toBe(1);
    expect(store.getState().progressiveGraph?.explicitFileIds).toEqual([FILE_B]);
  });

  it("reuses the exact depth-2 warm request for the critical expansion and never auto-warms depth 3", async () => {
    const store = storeWithInitialProjection();
    const depthTwo = projection({
      nodes: [packageNode, fileA, methodA, fileB, methodB],
      roots: [FILE_A],
      loadedFiles: [FILE_A, FILE_B],
      requestedDepth: 2,
      prefetchDepth: 2,
    });
    store.setState({
      viewMode: "prs",
      review: {
        context: {
          changedFiles: [],
          baseRef: null,
          baseSha: null,
          headRef: "feature",
          reviewKey: "bounded-progressive-warm",
          warnings: [],
        },
        rows: [],
        flows: {},
      },
      progressiveSymbols: {
        status: "ready",
        graphId: "head-graph",
        generation: "immutable-head-generation",
        symbols: [],
        indexed: 0,
        total: 0,
        error: null,
      },
    });
    const requests: Array<{ warm: boolean; rawBody: string; body: Record<string, unknown> }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const warm = String(input).includes("/warm");
      const rawBody = String(init?.body);
      requests.push({ warm, rawBody, body: JSON.parse(rawBody) as Record<string, unknown> });
      return warm ? Response.json({ warmed: true }) : Response.json(depthTwo);
    });
    vi.stubGlobal("fetch", fetchMock);

    await store.getState().minimalRelayout();
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]).toMatchObject({
      warm: true,
      body: { requestedDepth: 2, prefetchDepth: 2 },
    });

    await expect(store.getState().setProgressiveGraphDepth(2)).resolves.toBe(true);
    expect(requests[1]).toEqual({
      warm: false,
      rawBody: requests[0].rawBody,
      body: requests[0].body,
    });

    store.setState((current) => ({
      progressiveGraph: {
        ...current.progressiveGraph!,
        explicitFileIds: [FILE_B],
      },
    }));
    await store.getState().minimalRelayout();
    await Promise.resolve();
    expect(requests).toHaveLength(2);
    expect(requests.filter(({ warm }) => warm).every(({ body }) => (
      Number(body.requestedDepth) <= 2 && Number(body.prefetchDepth) <= 2
    ))).toBe(true);
  });

  it("loads a user-selected deeper horizon with an exact depth request", async () => {
    const store = storeWithInitialProjection();
    store.setState({ viewMode: "prs" });
    const depthThree = projection({
      nodes: [packageNode, fileA, methodA, fileB, methodB],
      roots: [FILE_A],
      loadedFiles: [FILE_A, FILE_B],
      requestedDepth: 3,
      prefetchDepth: 3,
    });
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({
        requestedDepth: 3,
        prefetchDepth: 3,
      });
      return Response.json(depthThree);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(store.getState().setProgressiveGraphDepth(3)).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(store.getState().progressiveGraph).toMatchObject({
      requestedDepth: 3,
      affectedDepth: 3,
      status: "ready",
    });
  });

  it("treats a proven comparison tombstone as locally ready without posting its base-only id to HEAD", async () => {
    const deletedFile = node(DELETED, "module", "src/deleted.ts", PACKAGE);
    const deletedMethod = node(DELETED_METHOD, "method", "src/deleted.ts", DELETED);
    const displayed = {
      ...projectionToArtifact(INITIAL),
      nodes: [...INITIAL.nodes, deletedFile, deletedMethod],
    } as GraphArtifact;
    const store = storeWithInitialProjection(displayed);
    store.setState({ reviewBaseNodeIds: new Set([DELETED, DELETED_METHOD]) });
    const fetchMock = vi.fn(async () => {
      throw new Error("a base-only node must never be requested from HEAD");
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(store.getState().ensureNodeReady(DELETED_METHOD)).resolves.toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("admits a comparison-only file ghost without posting its tombstone id to HEAD", async () => {
    const deletedFile = node(DELETED, "module", "src/deleted.ts", PACKAGE);
    const deletedMethod = node(DELETED_METHOD, "method", "src/deleted.ts", DELETED);
    const displayed = {
      ...projectionToArtifact(INITIAL),
      nodes: [...INITIAL.nodes, deletedFile, deletedMethod],
    } as GraphArtifact;
    const store = storeWithInitialProjection(displayed);
    const minimalRelayout = vi.fn(async () => {});
    store.setState({
      reviewBaseNodeIds: new Set([DELETED, DELETED_METHOD]),
      minimalSeedIds: [FILE_A],
      minimalMemberIds: [FILE_A],
      minimalRelayout,
    });
    const fetchMock = vi.fn(async () => {
      throw new Error("a base-only node must never be requested from HEAD");
    });
    vi.stubGlobal("fetch", fetchMock);

    store.getState().promoteGhost(DELETED, { x: 20, y: 30 });
    await vi.waitFor(() => expect(store.getState().minimalMemberIds).toContain(DELETED));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(store.getState().minimalSeedIds).toEqual([FILE_A]);
    expect(store.getState().minimalBasePositions[DELETED]).toEqual(expect.objectContaining({ x: 20, y: 30 }));
    expect(store.getState().progressivePendingNodeIds).toEqual(new Set());
    expect(minimalRelayout).toHaveBeenCalledOnce();
  });

  it("marks fetched and resident depths ready only after their canvas relayout settles", async () => {
    const store = storeWithInitialProjection();
    let releaseFetchedRelayout!: () => void;
    const fetchedRelayout = new Promise<void>((resolve) => { releaseFetchedRelayout = resolve; });
    let releaseFlowRelayout!: () => void;
    const flowRelayout = new Promise<void>((resolve) => { releaseFlowRelayout = resolve; });
    let releaseResidentRelayout!: () => void;
    const residentRelayout = new Promise<void>((resolve) => { releaseResidentRelayout = resolve; });
    const minimalRelayout = vi.fn().mockReturnValueOnce(fetchedRelayout);
    const flowPaneRelayout = vi.fn().mockReturnValueOnce(flowRelayout);
    const moduleRelayout = vi.fn().mockReturnValueOnce(residentRelayout);
    const mark = vi.fn();
    vi.stubGlobal("performance", { mark });
    store.setState({
      viewMode: "prs",
      minimalSeedIds: [FILE_A],
      minimalRelayout,
      flowSelection: { rootId: METHOD_A, blockPath: [] },
      flowPaneOrigin: "synthetic",
      flowPaneRelayout,
    });
    const depthTwo = projection({
      nodes: [packageNode, fileA, methodA, fileB, methodB],
      roots: [FILE_A],
      loadedFiles: [FILE_A, FILE_B],
      requestedDepth: 2,
      prefetchDepth: 2,
    });
    let projectionSignal: AbortSignal | undefined;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      projectionSignal = init?.signal ?? undefined;
      return new Response(JSON.stringify(depthTwo), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const fetched = store.getState().setProgressiveGraphDepth(2);
    await vi.waitFor(() => expect(minimalRelayout).toHaveBeenCalledTimes(1));
    expect(mark).not.toHaveBeenCalledWith("meridian:progressive-depth-ready", expect.anything());
    releaseFetchedRelayout();
    await vi.waitFor(() => expect(flowPaneRelayout).toHaveBeenCalledOnce());
    expect(mark).not.toHaveBeenCalledWith("meridian:progressive-depth-ready", expect.anything());
    releaseFlowRelayout();
    await expect(fetched).resolves.toBe(true);
    expect(mark).toHaveBeenCalledWith("meridian:progressive-depth-ready", {
      detail: { depth: 2 },
    });
    expect(store.getState().progressiveGraph?.requestedDepth).toBe(2);
    expect(store.getState().index.nodesById.has(FILE_B)).toBe(true);
    expect(projectionSignal?.aborted).toBe(false);

    mark.mockClear();
    store.setState({
      viewMode: "modules",
      minimalSeedIds: [],
      flowSelection: null,
      moduleRelayout,
    });
    const resident = store.getState().setProgressiveGraphDepth(1);
    await vi.waitFor(() => expect(moduleRelayout).toHaveBeenCalledOnce());
    expect(mark).not.toHaveBeenCalledWith("meridian:progressive-depth-ready", expect.anything());
    releaseResidentRelayout();
    await expect(resident).resolves.toBe(true);
    expect(mark).toHaveBeenCalledWith("meridian:progressive-depth-ready", {
      detail: { depth: 1 },
    });
    expect(store.getState().progressiveGraph?.requestedDepth).toBe(1);
    expect(store.getState().index.nodesById.has(FILE_B)).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(projectionSignal?.aborted).toBe(false);
  });

  it("does not mark a fetched depth ready when it is superseded during relayout", async () => {
    const store = storeWithInitialProjection();
    let releaseStaleRelayout!: () => void;
    const staleRelayout = new Promise<void>((resolve) => { releaseStaleRelayout = resolve; });
    const minimalRelayout = vi.fn()
      .mockReturnValueOnce(staleRelayout)
      .mockResolvedValueOnce(undefined);
    const mark = vi.fn();
    vi.stubGlobal("performance", { mark });
    store.setState({
      viewMode: "prs",
      minimalSeedIds: [FILE_A],
      minimalRelayout,
    });
    const depthTwo = projection({
      nodes: [packageNode, fileA, methodA, fileB, methodB],
      roots: [FILE_A],
      loadedFiles: [FILE_A, FILE_B],
      requestedDepth: 2,
      prefetchDepth: 2,
    });
    let projectionSignal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      projectionSignal = init?.signal ?? undefined;
      return Response.json(depthTwo);
    }));

    const staleExpansion = store.getState().setProgressiveGraphDepth(2);
    await vi.waitFor(() => expect(minimalRelayout).toHaveBeenCalledTimes(1));
    await expect(store.getState().setProgressiveGraphDepth(1)).resolves.toBe(true);
    expect(projectionSignal?.aborted).toBe(false);
    expect(mark).toHaveBeenCalledTimes(1);
    expect(mark).toHaveBeenCalledWith("meridian:progressive-depth-ready", {
      detail: { depth: 1 },
    });

    releaseStaleRelayout();
    await expect(staleExpansion).resolves.toBe(false);
    expect(projectionSignal?.aborted).toBe(false);
    expect(mark).toHaveBeenCalledTimes(1);
  });

  it("aborts a superseded depth fetch and cannot repaint a later resident-depth choice", async () => {
    const store = storeWithInitialProjection();
    store.setState({ viewMode: "prs" });
    let requestSignal: AbortSignal | undefined;
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      requestSignal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        requestSignal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        }, { once: true });
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const staleExpansion = store.getState().setProgressiveGraphDepth(2);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    await expect(store.getState().setProgressiveGraphDepth(1)).resolves.toBe(true);
    await expect(staleExpansion).resolves.toBe(false);

    expect(requestSignal?.aborted).toBe(true);
    expect(store.getState().progressiveGraph).toMatchObject({
      requestedDepth: 1,
      status: "ready",
      error: null,
    });
  });

  it("aborts a surviving comparison fetch when its sibling depth request fails", async () => {
    const store = storeWithInitialProjection();
    const comparison: GraphProjectionV1 = {
      ...INITIAL,
      graphId: "base-graph",
      generation: "immutable-base-generation",
    };
    store.setState({
      viewMode: "prs",
      progressiveGraph: {
        ...store.getState().progressiveGraph!,
        comparison,
      },
    });
    let comparisonSignal: AbortSignal | undefined;
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { graphId: string };
      if (request.graphId === "head-graph") {
        return Promise.resolve(new Response("head projector failed", { status: 503 }));
      }
      comparisonSignal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        const abort = () => reject(new DOMException("aborted", "AbortError"));
        comparisonSignal?.addEventListener("abort", abort, { once: true });
        if (comparisonSignal?.aborted) abort();
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(store.getState().setProgressiveGraphDepth(2)).resolves.toBe(false);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(comparisonSignal?.aborted).toBe(true);
    expect(store.getState().progressiveGraph).toMatchObject({ status: "error" });
  });

  it("defers direct-review close until the canonical full boot graph is available", async () => {
    const fullArtifact = {
      ...projectionToArtifact(INITIAL),
      nodes: [packageNode, fileA, methodA, fileB, methodB],
    } as GraphArtifact;
    let resolveBaseline!: (artifact: GraphArtifact) => void;
    const loadBaseline = vi.fn((_signal: AbortSignal) => new Promise<GraphArtifact>((resolve) => {
      resolveBaseline = resolve;
    }));
    const store = storeWithInitialProjection(projectionToArtifact(INITIAL), loadBaseline);
    store.setState({
      prReviewed: 7,
      prPreparedArtifactCurrent: true,
      prPreparedGraphId: "head-graph",
      prReviewBaseline: null,
      minimalSeedIds: [FILE_A],
      minimalMemberIds: [FILE_A],
    });

    expect(store.getState().closeMinimalGraph()).toBe(false);
    expect(store.getState().artifact.nodes).toHaveLength(INITIAL.nodes.length);
    expect(store.getState().prReviewBaseline).toBeNull();
    expect(store.getState().minimalSeedIds).toEqual([FILE_A]);

    resolveBaseline(fullArtifact);
    await vi.waitFor(() => expect(store.getState().minimalSeedIds).toEqual([]));

    expect(loadBaseline).toHaveBeenCalledOnce();
    expect(store.getState().artifact).toBe(fullArtifact);
    expect(store.getState().prReviewBaseline?.artifact).toBe(fullArtifact);
    expect(store.getState().progressiveGraph).toBeNull();
  });

  it("restores a provisional boot to its expandable bounded baseline without loading a full graph", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("unavailable", { status: 503 })));
    const partialArtifact = projectionToArtifact(INITIAL);
    const fullLoader = vi.fn(async () => {
      throw new Error("a partial-only review must not request a full graph");
    });
    const store = storeWithInitialProjection(partialArtifact, fullLoader, fetchGraphSymbols, true);
    store.setState({
      prReviewed: 7,
      prPreparedArtifactCurrent: true,
      prPreparedGraphId: "head-graph",
      prReviewBaseline: null,
      minimalSeedIds: [FILE_A],
      minimalMemberIds: [FILE_A],
    });

    expect(store.getState().closeMinimalGraph()).toBe(false);
    await vi.waitFor(() => expect(store.getState().minimalSeedIds).toEqual([]));

    expect(fullLoader).not.toHaveBeenCalled();
    expect(store.getState().artifact).toBe(partialArtifact);
    expect(store.getState().prReviewBaseline?.artifact).toBe(partialArtifact);
    expect(store.getState().progressiveGraph).not.toBeNull();
  });

  it("replays only the latest lens intent after a deferred canonical restore", async () => {
    const fullArtifact = {
      ...projectionToArtifact(INITIAL),
      nodes: [packageNode, fileA, methodA, fileB, methodB],
    } as GraphArtifact;
    let resolveBaseline!: (artifact: GraphArtifact) => void;
    const store = storeWithInitialProjection(
      projectionToArtifact(INITIAL),
      () => new Promise<GraphArtifact>((resolve) => { resolveBaseline = resolve; }),
    );
    store.setState({
      viewMode: "modules",
      prReviewed: 7,
      prPreparedArtifactCurrent: true,
      prPreparedGraphId: "head-graph",
      prReviewBaseline: null,
      minimalSeedIds: [FILE_A],
      minimalMemberIds: [FILE_A],
    });

    store.getState().setViewMode("logic");
    store.getState().setViewMode("call");
    expect(store.getState().viewMode).toBe("modules");

    resolveBaseline(fullArtifact);
    await vi.waitFor(() => expect(store.getState().viewMode).toBe("call"));
    expect(store.getState().artifact).toBe(fullArtifact);
    expect(store.getState().minimalSeedIds).toEqual([]);
  });

  it("awaits the canonical graph before browser-history teardown leaves a direct review", async () => {
    const fullArtifact = {
      ...projectionToArtifact(INITIAL),
      nodes: [packageNode, fileA, methodA, fileB, methodB],
    } as GraphArtifact;
    let resolveBaseline!: (artifact: GraphArtifact) => void;
    const store = storeWithInitialProjection(
      projectionToArtifact(INITIAL),
      () => new Promise<GraphArtifact>((resolve) => { resolveBaseline = resolve; }),
    );
    store.setState({
      prSelected: 7,
      prReviewed: 7,
      prPreparedArtifactCurrent: true,
      prPreparedGraphId: "head-graph",
      prReviewBaseline: null,
      minimalSeedIds: [FILE_A],
      minimalMemberIds: [FILE_A],
    });

    const teardown = store.getState().selectPr(null, { endReviewSession: true });
    await Promise.resolve();
    expect(store.getState().prReviewed).toBe(7);
    expect(store.getState().artifact.nodes).toHaveLength(INITIAL.nodes.length);

    resolveBaseline(fullArtifact);
    await teardown;
    expect(store.getState().prReviewed).toBeNull();
    expect(store.getState().artifact).toBe(fullArtifact);
    expect(store.getState().progressiveGraph).toBeNull();
  });

  it("keeps the review projection visible when the canonical restore fails and allows retry", async () => {
    const fullArtifact = {
      ...projectionToArtifact(INITIAL),
      nodes: [packageNode, fileA, methodA, fileB, methodB],
    } as GraphArtifact;
    const loadBaseline = vi.fn<(signal: AbortSignal) => Promise<GraphArtifact>>()
      .mockRejectedValueOnce(new Error("full graph unavailable"))
      .mockResolvedValueOnce(fullArtifact);
    const partialArtifact = projectionToArtifact(INITIAL);
    const store = storeWithInitialProjection(partialArtifact, loadBaseline);
    store.setState({
      prReviewed: 7,
      prPreparedArtifactCurrent: true,
      prPreparedGraphId: "head-graph",
      prReviewBaseline: null,
      minimalSeedIds: [FILE_A],
      minimalMemberIds: [FILE_A],
    });

    expect(store.getState().closeMinimalGraph()).toBe(false);
    await vi.waitFor(() => expect(store.getState().progressiveGraph?.status).toBe("error"));
    expect(store.getState().artifact).toBe(partialArtifact);
    expect(store.getState().prReviewBaseline).toBeNull();
    expect(store.getState().minimalSeedIds).toEqual([FILE_A]);

    expect(store.getState().closeMinimalGraph()).toBe(false);
    await vi.waitFor(() => expect(store.getState().minimalSeedIds).toEqual([]));
    expect(store.getState().artifact).toBe(fullArtifact);
    expect(loadBaseline).toHaveBeenCalledTimes(2);
  });

  it("aborts background symbol transport when the progressive review session is restored", async () => {
    const fullArtifact = {
      ...projectionToArtifact(INITIAL),
      nodes: [packageNode, fileA, methodA, fileB, methodB],
    } as GraphArtifact;
    let symbolSignal: AbortSignal | undefined;
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      symbolSignal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        symbolSignal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        }, { once: true });
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const store = storeWithInitialProjection(projectionToArtifact(INITIAL), async () => fullArtifact);
    store.setState({
      prReviewed: 7,
      prPreparedArtifactCurrent: true,
      prPreparedGraphId: "head-graph",
      prReviewBaseline: null,
      minimalSeedIds: [FILE_A],
      minimalMemberIds: [FILE_A],
    });

    const indexing = store.getState().startProgressiveSymbolIndex();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(store.getState().closeMinimalGraph()).toBe(false);
    await vi.waitFor(() => expect(store.getState().minimalSeedIds).toEqual([]));
    await indexing;

    expect(symbolSignal?.aborted).toBe(true);
    expect(store.getState().progressiveSymbols.status).toBe("idle");
  });

  it("aborts disconnected-node hydration when the progressive review session is restored", async () => {
    const fullArtifact = {
      ...projectionToArtifact(INITIAL),
      nodes: [packageNode, fileA, methodA, fileB, methodB],
    } as GraphArtifact;
    let nodeSignal: AbortSignal | undefined;
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      nodeSignal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        nodeSignal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        }, { once: true });
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const store = storeWithInitialProjection(projectionToArtifact(INITIAL), async () => fullArtifact);
    store.setState({
      prReviewed: 7,
      prPreparedArtifactCurrent: true,
      prPreparedGraphId: "head-graph",
      prReviewBaseline: null,
      minimalSeedIds: [FILE_A],
      minimalMemberIds: [FILE_A],
      progressiveSymbols: {
        status: "ready",
        graphId: "head-graph",
        generation: "immutable-head-generation",
        symbols: [{
          id: METHOD_B,
          fileId: FILE_B,
          displayName: "searchTarget",
          qualifiedName: METHOD_B,
          kind: "function",
          file: "src/b.ts",
          isPrivateMethod: false,
          stepCount: null,
        }],
        indexed: 1,
        total: 1,
        error: null,
      },
    });

    const hydration = store.getState().ensureNodeReady(METHOD_B);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(store.getState().closeMinimalGraph()).toBe(false);
    await vi.waitFor(() => expect(store.getState().minimalSeedIds).toEqual([]));

    await expect(hydration).resolves.toBe(false);
    expect(nodeSignal?.aborted).toBe(true);
    expect(store.getState().progressivePendingNodeIds).toEqual(new Set());
  });

  it("restores the prior selected depth after a failed expansion so the same choice can retry", async () => {
    const store = storeWithInitialProjection();
    store.setState({ viewMode: "prs" });
    const depthTwo = projection({
      nodes: [packageNode, fileA, methodA, fileB, methodB],
      roots: [FILE_A],
      loadedFiles: [FILE_A, FILE_B],
      requestedDepth: 2,
      prefetchDepth: 2,
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("projection unavailable", { status: 503 }))
      .mockResolvedValueOnce(Response.json(depthTwo));
    vi.stubGlobal("fetch", fetchMock);

    await expect(store.getState().setProgressiveGraphDepth(2)).resolves.toBe(false);
    expect(store.getState().progressiveGraph).toMatchObject({
      requestedDepth: 1,
      status: "error",
    });

    await expect(store.getState().setProgressiveGraphDepth(2)).resolves.toBe(true);
    expect(store.getState().progressiveGraph).toMatchObject({
      requestedDepth: 2,
      status: "ready",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retains a command-palette root admitted while comparison support hydration is in flight", async () => {
    const deletedFile = node(DELETED, "module", "src/deleted.ts", PACKAGE);
    const deletedMethod = node(DELETED_METHOD, "method", "src/deleted.ts", DELETED);
    const comparison = {
      ...projection({
        nodes: [packageNode, deletedFile, deletedMethod, fileC, methodC],
        roots: [DELETED],
        loadedFiles: [DELETED, FILE_C],
      }),
      graphId: "base-graph",
      seedGraphId: "head-graph",
      generation: "immutable-base-generation",
      edges: [{
        id: `calls@${METHOD_C}|${DELETED_METHOD}`,
        kind: "calls" as const,
        source: METHOD_C,
        target: DELETED_METHOD,
      }],
      counts: {
        full: { nodes: 5, edges: 1, files: 2 },
        slice: { nodes: 5, edges: 1, files: 2 },
      },
    } satisfies GraphProjectionV1;
    const comparisonDepthTwo = {
      ...comparison,
      requestedDepth: 2,
      prefetchDepth: 2,
      loadedDepth: 2,
      frontier: [
        { fileId: DELETED, hasMore: false, completeThroughDepth: 2 },
        { fileId: FILE_C, hasMore: false, completeThroughDepth: 2 },
      ],
      readyFileIds: [DELETED, FILE_C],
    } satisfies GraphProjectionV1;
    const headDepthTwo = projection({
      nodes: [packageNode, fileA, methodA],
      roots: [FILE_A],
      loadedFiles: [FILE_A],
      requestedDepth: 2,
      prefetchDepth: 2,
    });
    const explicitB = projection({
      nodes: [packageNode, fileB, methodB],
      roots: [FILE_B],
      loadedFiles: [FILE_B],
      prefetchDepth: 1,
    });
    const explicitBDepthTwo = projection({
      nodes: [packageNode, fileB, methodB],
      roots: [FILE_B],
      loadedFiles: [FILE_B],
      requestedDepth: 2,
      prefetchDepth: 2,
    });
    const supportC = projection({
      nodes: [packageNode, fileC, methodC],
      roots: [FILE_C],
      loadedFiles: [FILE_C],
      ready: [],
      requestedDepth: 0,
      prefetchDepth: 0,
    });
    supportC.loadedDepth = 0;
    supportC.frontier = [{ fileId: FILE_C, hasMore: false, completeThroughDepth: 0 }];

    const store = storeWithInitialProjection();
    const initialSession = store.getState().progressiveGraph!;
    store.setState({
      viewMode: "prs",
      progressiveGraph: { ...initialSession, comparison },
      progressiveSymbols: {
        status: "ready",
        graphId: "head-graph",
        generation: "immutable-head-generation",
        symbols: [{
          id: METHOD_B,
          fileId: FILE_B,
          displayName: "searchTarget",
          qualifiedName: METHOD_B,
          kind: "function",
          file: "src/b.ts",
          isPrivateMethod: false,
          stepCount: null,
        }],
        indexed: 1,
        total: 1,
        error: null,
      },
    });
    let markSupportStarted!: () => void;
    const supportStarted = new Promise<void>((resolve) => { markSupportStarted = resolve; });
    let releaseSupport!: () => void;
    const supportGate = new Promise<void>((resolve) => { releaseSupport = resolve; });
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as {
        graphId: string;
        requestedDepth: number;
        roots: { kind: string; fileIds?: string[]; paths?: string[] };
      };
      if (request.roots.kind === "file-paths") {
        expect(request.roots.paths).toEqual(["src/c.ts"]);
        markSupportStarted();
        await supportGate;
        return Response.json(supportC);
      }
      if (request.roots.kind === "files") {
        expect(request.roots.fileIds).toEqual([FILE_B]);
        return Response.json(request.requestedDepth === 2 ? explicitBDepthTwo : explicitB);
      }
      return Response.json(request.graphId === "base-graph" ? comparisonDepthTwo : headDepthTwo);
    });
    vi.stubGlobal("fetch", fetchMock);

    const depthExpansion = store.getState().setProgressiveGraphDepth(2);
    await supportStarted;
    await expect(store.getState().ensureNodeReady(METHOD_B)).resolves.toBe(true);
    expect(store.getState().progressiveGraph?.explicitFileIds).toContain(FILE_B);
    releaseSupport();
    const expanded = await depthExpansion;
    expect({ expanded, error: store.getState().progressiveGraph?.error }).toEqual({ expanded: true, error: null });

    expect(store.getState().progressiveGraph?.explicitFileIds).toContain(FILE_B);
    expect(store.getState().progressiveGraph?.head.nodes.map(({ id }) => id)).toEqual(
      expect.arrayContaining([FILE_A, FILE_B, METHOD_B, FILE_C, METHOD_C]),
    );
    expect(store.getState().progressiveGraph).toMatchObject({ status: "ready", requestedDepth: 2 });
    expect(store.getState().progressiveGraph?.head.frontier.find(({ fileId }) => fileId === FILE_B))
      .toMatchObject({ completeThroughDepth: 2 });
    expect(store.getState().index.nodesById.has(METHOD_B)).toBe(true);
  });
});

describe("mergeProjectionIntoDisplayedArtifact", () => {
  it("rejects cross-generation hydration", () => {
    const other = { ...INITIAL, generation: "different" };
    expect(() => mergeProjectionIntoDisplayedArtifact(projectionToArtifact(INITIAL), INITIAL, other))
      .toThrow("different immutable generation");
  });

  it("admits a deletion-only pair when HEAD is empty and the merge-base roots are ready", () => {
    const emptyHead = projection({ nodes: [], roots: [], loadedFiles: [] });
    const base = {
      ...projection({ nodes: [packageNode, fileA, methodA], roots: [FILE_A], loadedFiles: [FILE_A] }),
      graphId: "base-graph",
      generation: "immutable-base-generation",
      seedGraphId: "head-graph",
    };

    expect(isProgressiveProjectionPairReady(emptyHead, base)).toBe(true);
    expect(isProgressiveProjectionPairReady(emptyHead, null)).toBe(false);
  });
});
