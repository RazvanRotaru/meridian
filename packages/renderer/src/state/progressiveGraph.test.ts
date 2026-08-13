import { describe, expect, it, vi } from "vitest";
import {
  GRAPH_PROJECTION_VERSION,
  GRAPH_SYMBOL_SEARCH_VERSION,
  SCHEMA_VERSION,
  type GraphEdge,
  type GraphNode,
  type GraphProjectionV1,
} from "@meridian/core";
import {
  areProjectionFilesReady,
  assertProgressiveResidentCounts,
  changedFileProjectionRequest,
  comparisonContextPathsMissingFromHead,
  fetchGraphProjection,
  fetchGraphSymbols,
  filePathProjectionRequest,
  filePathProjectionRequests,
  fileProjectionRequest,
  fileProjectionRequests,
  hydrateHeadProjectionForComparisonContext,
  isProjectionReadyForCanvas,
  MAX_GRAPH_PROJECTION_ROOTS,
  MAX_PROGRESSIVE_RESIDENT_EDGES,
  MAX_PROGRESSIVE_RESIDENT_FILES,
  MAX_PROGRESSIVE_RESIDENT_NODES,
  mergeGraphProjections,
  parseGraphProjection,
  parseGraphSymbolSearchResponse,
  parseGraphSymbolSearchResult,
  progressiveGraphUrlsFromGraphUrl,
  projectionFrontierToPrefetch,
  projectionToArtifact,
  warmGraphProjection,
} from "./progressiveGraph";

const FILE_A = node("ts:src/a.ts", "module", "a.ts");
const FN_A = node("ts:src/a.ts#run", "function", "run", FILE_A.id);
const FILE_B = node("ts:src/b.ts", "module", "b.ts");
const FN_B = node("ts:src/b.ts#help", "function", "help", FILE_B.id);
const PY_PACKAGE: GraphNode = {
  id: "py:pkg",
  kind: "package",
  qualifiedName: "pkg",
  displayName: "pkg",
  parentId: null,
  location: { file: "pkg/__init__.py", startLine: 1 },
};
const PY_INIT_FN: GraphNode = {
  id: "py:pkg#initialize",
  kind: "function",
  qualifiedName: "pkg.initialize",
  displayName: "initialize",
  parentId: PY_PACKAGE.id,
  location: { file: "pkg/__init__.py", startLine: 2 },
};
const PY_NAMESPACE: GraphNode = {
  ...PY_PACKAGE,
  id: "py:namespace",
  qualifiedName: "namespace",
  displayName: "namespace",
  location: { file: "namespace", startLine: 1 },
};
const FN_ZETA = node("ts:src/a.ts#zeta", "function", "zeta", FILE_A.id);
const FN_ALPHA = node("ts:src/a.ts#alpha", "function", "alpha", FILE_A.id);
const EDGE_ZETA: GraphEdge = {
  id: `zetaLink@${FILE_A.id}|${FN_ZETA.id}`,
  kind: "zetaLink",
  source: FILE_A.id,
  target: FN_ZETA.id,
};
const EDGE_ALPHA: GraphEdge = {
  id: `alphaLink@${FN_ZETA.id}|${FN_ALPHA.id}`,
  kind: "alphaLink",
  source: FN_ZETA.id,
  target: FN_ALPHA.id,
};
const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const PORT_A = {
  nodeId: FN_A.id,
  direction: "out",
  protocol: "electron",
  channel: "load",
  label: "load",
  callSite: { file: "src/a.ts", line: 3 },
};
const PORT_B = {
  protocol: "electron",
  direction: "in",
  nodeId: FN_B.id,
  label: "load",
  channel: "load",
  callSite: { line: 7, file: "src/b.ts" },
};

function coverage(files: Record<string, number>) {
  const span = {
    start: { line: 1, column: 0 },
    end: { line: 1, column: 3 },
  };
  return {
    version: "1.0.0",
    aggregate: true,
    producer: { inputFormat: "istanbul-coverage-map" },
    files: Object.fromEntries(Object.entries(files).map(([file, hits]) => [file, {
      functions: [{ name: "run", hits, decl: span, location: span }],
      branches: [],
    }])),
  };
}

function node(id: string, kind: GraphNode["kind"], displayName: string, parentId?: string): GraphNode {
  return {
    id,
    kind,
    qualifiedName: id,
    displayName,
    ...(parentId === undefined ? {} : { parentId }),
    location: { file: id.includes("b.ts") ? "src/b.ts" : "src/a.ts", startLine: 1 },
  };
}

function isCanonicalTestFile(candidate: GraphNode): boolean {
  return candidate.kind === "module"
    || (candidate.kind === "package" && candidate.location.file.replaceAll("\\", "/").endsWith(".py"));
}

function projection(overrides: Partial<GraphProjectionV1> = {}): GraphProjectionV1 {
  const nodes = overrides.nodes ?? [FILE_A, FN_A];
  const edges = overrides.edges ?? [];
  const loadedFileIds = overrides.loadedFileIds ?? [FILE_A.id];
  return {
    version: GRAPH_PROJECTION_VERSION,
    graphId: "graph-head",
    seedGraphId: "graph-head",
    generation: "sha256:immutable-head",
    requestedDepth: 1,
    prefetchDepth: 3,
    loadedDepth: 1,
    schemaVersion: SCHEMA_VERSION,
    generatedAt: "2026-07-31T08:00:00.000Z",
    generator: { name: "meridian", version: "0.1.0" },
    target: { name: "fixture", root: ".", language: "typescript" },
    extensions: { logicFlow: { [FN_A.id]: [] }, stable: true },
    nodes,
    edges,
    rootFileIds: [FILE_A.id],
    readyFileIds: [FILE_A.id],
    loadedFileIds,
    frontier: [{ fileId: FILE_A.id, hasMore: true, completeThroughDepth: 1 }],
    counts: {
      full: { nodes: 100, edges: 200, files: 25 },
      slice: {
        nodes: nodes.length,
        edges: edges.length,
        files: nodes.filter(isCanonicalTestFile).length,
      },
    },
    ...overrides,
  };
}

describe("progressive graph protocol client", () => {
  it("parses a self-contained projection and adapts it without a fake extension", () => {
    const parsed = parseGraphProjection(projection());
    const artifact = projectionToArtifact(parsed);

    expect(parsed.generation).toBe("sha256:immutable-head");
    expect(artifact.nodes).toEqual([FILE_A, FN_A]);
    expect(artifact.extensions).toEqual({ logicFlow: { [FN_A.id]: [] }, stable: true });
    expect(artifact.extensions).not.toHaveProperty("progressiveGraph");
  });

  it.each([
    ["version", { version: 2 }, "version must be 1"],
    ["depth horizon", { requestedDepth: 3, prefetchDepth: 2 }, "prefetchDepth"],
    ["slice counts", { counts: { full: { nodes: 100, edges: 200, files: 25 }, slice: { nodes: 1, edges: 0, files: 1 } } }, "slice counts"],
    ["ready subset", { readyFileIds: [FILE_B.id] }, "not a loaded canonical file node"],
    ["generation", { generation: "" }, "generation"],
  ])("rejects an invalid %s", (_label, overrides, message) => {
    expect(() => parseGraphProjection(projection(overrides as Partial<GraphProjectionV1>))).toThrow(message);
  });

  it("accepts 20,000 roots/frontiers only for merged changed-file responses", async () => {
    const rootNodes = Array.from({ length: 20_000 }, (_, index): GraphNode => {
      const file = `src/changed-${String(index).padStart(5, "0")}.ts`;
      return {
        id: `ts:${file}`,
        kind: "module",
        qualifiedName: file,
        displayName: file,
        location: { file, startLine: 1 },
      };
    });
    const rootFileIds = rootNodes.map((candidate) => candidate.id);
    const frontier = rootFileIds.map((fileId) => ({
      fileId,
      hasMore: false,
      completeThroughDepth: 1,
    }));

    const boundaryProjection = projection({
      nodes: rootNodes,
      edges: [],
      extensions: {},
      rootFileIds,
      readyFileIds: rootFileIds,
      loadedFileIds: rootFileIds,
      frontier,
      counts: {
        full: { nodes: 20_000, edges: 0, files: 20_000 },
        slice: { nodes: 20_000, edges: 0, files: 20_000 },
      },
    });
    const changedFilesRequest = changedFileProjectionRequest("graph-head", "graph-head", 1, 3);
    const responseFetch = (value: GraphProjectionV1) => vi.fn<typeof fetch>().mockResolvedValue(
      Response.json(value),
    );

    expect(MAX_GRAPH_PROJECTION_ROOTS).toBe(20_000);
    const accepted = await fetchGraphProjection("/api/graph/project", changedFilesRequest, {
      fetchImpl: responseFetch(boundaryProjection),
    });
    expect(accepted.rootFileIds).toHaveLength(20_000);
    expect(accepted.frontier).toHaveLength(20_000);

    await expect(fetchGraphProjection(
      "/api/graph/project",
      fileProjectionRequest("graph-head", [FILE_A.id], 1, 3),
      { fetchImpl: responseFetch(boundaryProjection) },
    )).rejects.toThrow("rootFileIds exceeds 10000 entries");
    await expect(fetchGraphProjection("/api/graph/project", changedFilesRequest, {
      fetchImpl: responseFetch(projection({
        rootFileIds: [...rootFileIds, "ts:src/changed-20000.ts"],
      })),
    })).rejects.toThrow("rootFileIds exceeds 20000 entries");
    await expect(fetchGraphProjection("/api/graph/project", changedFilesRequest, {
      fetchImpl: responseFetch(projection({
        frontier: [...frontier, {
          fileId: "ts:src/changed-20000.ts",
          hasMore: false,
          completeThroughDepth: 1,
        }],
      })),
    })).rejects.toThrow("frontier exceeds 20000 entries");
  });

  it("accepts a Python package initializer as a canonical projection file, but not a namespace package", () => {
    const parsed = parseGraphProjection(projection({
      target: { name: "fixture", root: ".", language: "python" },
      extensions: { logicFlow: { [PY_INIT_FN.id]: [] }, stable: true },
      nodes: [PY_PACKAGE, PY_INIT_FN],
      rootFileIds: [PY_PACKAGE.id],
      readyFileIds: [PY_PACKAGE.id],
      loadedFileIds: [PY_PACKAGE.id],
      frontier: [{ fileId: PY_PACKAGE.id, hasMore: false, completeThroughDepth: 1 }],
      counts: { full: { nodes: 2, edges: 0, files: 1 }, slice: { nodes: 2, edges: 0, files: 1 } },
    }));

    expect(parsed.rootFileIds).toEqual([PY_PACKAGE.id]);
    expect(parsed.counts.slice.files).toBe(1);
    expect(() => parseGraphProjection(projection({
      target: { name: "fixture", root: ".", language: "python" },
      extensions: { logicFlow: {}, stable: true },
      nodes: [PY_NAMESPACE],
      rootFileIds: [PY_NAMESPACE.id],
      readyFileIds: [PY_NAMESPACE.id],
      loadedFileIds: [PY_NAMESPACE.id],
      frontier: [{ fileId: PY_NAMESPACE.id, hasMore: false, completeThroughDepth: 1 }],
      counts: { full: { nodes: 1, edges: 0, files: 0 }, slice: { nodes: 1, edges: 0, files: 0 } },
    }))).toThrow("not a loaded canonical file node");
  });

  it("builds fixed project/symbol endpoints without leaking graph query parameters", () => {
    expect(progressiveGraphUrlsFromGraphUrl("/api/graph?id=head%2F1&token=nope")).toEqual({
      graphId: "head/1",
      projectUrl: "/api/graph/project",
      symbolsUrl: "/api/graph/symbols?id=head%2F1",
    });
    expect(progressiveGraphUrlsFromGraphUrl("https://example.test/api/graph?id=g")).toEqual({
      graphId: "g",
      projectUrl: "https://example.test/api/graph/project",
      symbolsUrl: "https://example.test/api/graph/symbols?id=g",
    });
  });

  it("builds bounded changed-file, explicit-file, and exact-path requests", () => {
    expect(changedFileProjectionRequest("base", "head", 1, 3)).toEqual({
      version: 1,
      graphId: "base",
      roots: { kind: "changed-files", seedGraphId: "head" },
      requestedDepth: 1,
      prefetchDepth: 3,
    });
    expect(fileProjectionRequest("head", [FILE_A.id], 1, 1).roots).toEqual({
      kind: "files",
      fileIds: [FILE_A.id],
    });
    expect(() => fileProjectionRequest("head", [], 1, 1)).toThrow("must not be empty");
    const multibyteIds = Array.from(
      { length: 24 },
      (_, index) => `ts:src/${String(index).padStart(2, "0")}-${"界".repeat(900)}.ts`,
    );
    const fileRequests = fileProjectionRequests("head", multibyteIds, 1, 3);
    expect(fileRequests.length).toBeGreaterThan(1);
    expect(fileRequests.flatMap((request) => request.roots.kind === "files" ? request.roots.fileIds : []))
      .toEqual(multibyteIds);
    expect(fileRequests.every((request) => new TextEncoder().encode(JSON.stringify(request)).byteLength <= 60_000))
      .toBe(true);
    const manyIds = Array.from({ length: 513 }, (_, index) => `ts:src/${index}.ts`);
    expect(() => fileProjectionRequest("head", manyIds, 1, 3)).toThrow("exceeds 512 entries");
    expect(fileProjectionRequests("head", manyIds, 1, 3).map((request) => (
      request.roots.kind === "files" ? request.roots.fileIds.length : 0
    ))).toEqual([512, 1]);
    expect(() => fileProjectionRequests(
      "head",
      Array.from({ length: 10_001 }, (_, index) => `ts:src/${index}.ts`),
      1,
      3,
    )).toThrow("exceeds 10000 entries");
    expect(() => fileProjectionRequest("head", [`ts:${"界".repeat(1_365)}`], 1, 3))
      .toThrow("exceeds 4096 UTF-8 bytes");
    expect(() => fileProjectionRequests("head", [...multibyteIds, multibyteIds[0]!], 1, 3))
      .toThrow("must not contain duplicates");
    expect(filePathProjectionRequest("head", ["src/live.ts"], 1, 3).roots).toEqual({
      kind: "file-paths",
      paths: ["src/live.ts"],
    });
    expect(() => filePathProjectionRequest("head", ["src/live.ts", "src/live.ts"], 1, 3))
      .toThrow("must not contain duplicates");
    const longPaths = Array.from(
      { length: 40 },
      (_, index) => `src/${String(index).padStart(2, "0")}-${"x".repeat(1_900)}.ts`,
    );
    const requests = filePathProjectionRequests("head", longPaths, 0, 0);
    expect(requests.length).toBeGreaterThan(1);
    expect(requests.flatMap((request) => request.roots.kind === "file-paths" ? request.roots.paths : []))
      .toEqual(longPaths);
    expect(requests.every((request) => new TextEncoder().encode(JSON.stringify(request)).byteLength <= 60_000))
      .toBe(true);
    expect(() => filePathProjectionRequests("head", [...longPaths, longPaths[0]!], 0, 0))
      .toThrow("must not contain duplicates");
    expect(() => filePathProjectionRequest("head", [`src/${"界".repeat(1_365)}.ts`], 0, 0))
      .toThrow("exceeds 4096 UTF-8 bytes");
  });

  it("rejects oversized projection JSON before either critical or warm transport", async () => {
    const roots = Array.from(
      { length: 24 },
      (_, index) => `ts:src/${String(index).padStart(2, "0")}-${"界".repeat(900)}.ts`,
    );
    const request = {
      version: GRAPH_PROJECTION_VERSION,
      graphId: "graph-head",
      roots: { kind: "files" as const, fileIds: roots },
      requestedDepth: 1,
      prefetchDepth: 3,
    };
    const fetchImpl = vi.fn<typeof fetch>();

    await expect(fetchGraphProjection("/api/graph/project", request, { fetchImpl }))
      .rejects.toThrow("graph projection request exceeds 60000 UTF-8 bytes");
    await expect(warmGraphProjection("/api/graph/project", request, { fetchImpl }))
      .rejects.toThrow("graph projection request exceeds 60000 UTF-8 bytes");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("hydrates deletion-only and mixed comparison context without admitting stale comparison nodes", async () => {
    const removedFile = {
      ...node("base:src/removed.ts", "module", "removed.ts"),
      location: { file: "src/removed.ts", startLine: 1 },
    };
    const removedFn = {
      ...node("base:src/removed.ts#run", "function", "run", removedFile.id),
      location: { file: "src/removed.ts", startLine: 1 },
    };
    const emptyHead = projection({
      nodes: [],
      edges: [],
      rootFileIds: [],
      readyFileIds: [],
      loadedFileIds: [],
      frontier: [],
      counts: { full: { nodes: 100, edges: 200, files: 25 }, slice: { nodes: 0, edges: 0, files: 0 } },
    });
    const comparison = projection({
      graphId: "graph-base",
      seedGraphId: "graph-head",
      generation: "sha256:immutable-base",
      nodes: [removedFile, removedFn, FILE_B, FN_B],
      edges: [{
        id: `calls@${FN_B.id}|${removedFn.id}`,
        kind: "calls",
        source: FN_B.id,
        target: removedFn.id,
      }],
      rootFileIds: [removedFile.id],
      readyFileIds: [removedFile.id],
      loadedFileIds: [removedFile.id, FILE_B.id],
      frontier: [
        { fileId: removedFile.id, hasMore: true, completeThroughDepth: 1 },
        { fileId: FILE_B.id, hasMore: true, completeThroughDepth: 0 },
      ],
      counts: { full: { nodes: 100, edges: 200, files: 25 }, slice: { nodes: 4, edges: 1, files: 2 } },
    });
    const targetFragment = projection({
      nodes: [FILE_B, FN_B],
      rootFileIds: [FILE_B.id],
      readyFileIds: [],
      loadedFileIds: [FILE_B.id],
      requestedDepth: 0,
      prefetchDepth: 0,
      loadedDepth: 0,
      frontier: [{ fileId: FILE_B.id, hasMore: false, completeThroughDepth: 0 }],
      counts: { full: { nodes: 100, edges: 200, files: 25 }, slice: { nodes: 2, edges: 0, files: 1 } },
    });
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as { roots: unknown };
      expect(request.roots).toEqual({ kind: "file-paths", paths: ["src/b.ts"] });
      return Response.json(targetFragment);
    });

    const hydrated = await hydrateHeadProjectionForComparisonContext(
      "/api/graph/project",
      emptyHead,
      comparison,
      { fetchImpl },
    );

    expect(hydrated.nodes.map(({ id }) => id)).toEqual([FILE_B.id, FN_B.id]);
    expect(hydrated.nodes.some(({ id }) => id === removedFile.id || id === removedFn.id)).toBe(false);
    expect(hydrated.readyFileIds).toEqual([]);

    const boundaryOnly = node("ts:src/b.ts#other", "function", "other", FILE_B.id);
    const partialMixedHead = projection({
      nodes: [FILE_A, FN_A, FILE_B, boundaryOnly],
      rootFileIds: [FILE_A.id],
      readyFileIds: [FILE_A.id],
      loadedFileIds: [FILE_A.id, FILE_B.id],
      // FILE_B is represented only as incident edge evidence. Its absence from frontier means the
      // old comparison endpoint FN_B has not yet been proven absent from the complete HEAD file.
      frontier: [{ fileId: FILE_A.id, hasMore: true, completeThroughDepth: 1 }],
      counts: { full: { nodes: 100, edges: 200, files: 25 }, slice: { nodes: 4, edges: 0, files: 2 } },
    });
    const mixed = await hydrateHeadProjectionForComparisonContext(
      "/api/graph/project",
      partialMixedHead,
      comparison,
      { fetchImpl },
    );
    expect(mixed.rootFileIds).toEqual([FILE_A.id]);
    expect(mixed.readyFileIds).toEqual([FILE_A.id]);
    expect(mixed.nodes.map(({ id }) => id)).toEqual(expect.arrayContaining([
      FILE_A.id,
      FN_A.id,
      FILE_B.id,
      FN_B.id,
      boundaryOnly.id,
    ]));
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it.each(["calls", "references"])("finds surviving comparison %s context across a changed Python package initializer", (kind) => {
    const callerFile = {
      ...node("py:consumer", "module", "consumer.py"),
      location: { file: "consumer.py", startLine: 1 },
    };
    const caller = {
      ...node("py:consumer#call", "function", "call", callerFile.id),
      location: { file: "consumer.py", startLine: 2 },
    };
    const emptyHead = projection({
      nodes: [],
      edges: [],
      rootFileIds: [],
      readyFileIds: [],
      loadedFileIds: [],
      frontier: [],
      counts: { full: { nodes: 100, edges: 200, files: 25 }, slice: { nodes: 0, edges: 0, files: 0 } },
    });
    const comparison = projection({
      graphId: "graph-base",
      seedGraphId: "graph-head",
      generation: "sha256:immutable-base",
      target: { name: "fixture", root: ".", language: "python" },
      nodes: [PY_PACKAGE, PY_INIT_FN, callerFile, caller],
      edges: [{
        id: `${kind}@${caller.id}|${PY_INIT_FN.id}`,
        kind,
        source: caller.id,
        target: PY_INIT_FN.id,
      }],
      rootFileIds: [PY_PACKAGE.id],
      readyFileIds: [PY_PACKAGE.id],
      loadedFileIds: [PY_PACKAGE.id, callerFile.id],
      frontier: [
        { fileId: PY_PACKAGE.id, hasMore: true, completeThroughDepth: 1 },
        { fileId: callerFile.id, hasMore: true, completeThroughDepth: 0 },
      ],
      counts: { full: { nodes: 100, edges: 200, files: 25 }, slice: { nodes: 4, edges: 1, files: 2 } },
    });

    expect(comparisonContextPathsMissingFromHead(emptyHead, comparison)).toEqual(["consumer.py"]);
  });

  it("does not hydrate outgoing references or unrelated historical edge kinds", () => {
    const consumerFile = {
      ...node("py:consumer", "module", "consumer.py"),
      location: { file: "consumer.py", startLine: 1 },
    };
    const consumer = {
      ...node("py:consumer#use", "function", "use", consumerFile.id),
      location: { file: "consumer.py", startLine: 2 },
    };
    const head = projection({
      nodes: [],
      edges: [],
      rootFileIds: [],
      readyFileIds: [],
      loadedFileIds: [],
      frontier: [],
      counts: { full: { nodes: 100, edges: 200, files: 25 }, slice: { nodes: 0, edges: 0, files: 0 } },
    });
    const comparison = projection({
      target: { name: "fixture", root: ".", language: "python" },
      nodes: [PY_PACKAGE, PY_INIT_FN, consumerFile, consumer],
      edges: [
        {
          id: `references@${PY_INIT_FN.id}|${consumer.id}`,
          kind: "references",
          source: PY_INIT_FN.id,
          target: consumer.id,
        },
        {
          id: `instantiates@${consumer.id}|${PY_INIT_FN.id}`,
          kind: "instantiates",
          source: consumer.id,
          target: PY_INIT_FN.id,
        },
      ],
      rootFileIds: [PY_PACKAGE.id],
      readyFileIds: [PY_PACKAGE.id],
      loadedFileIds: [PY_PACKAGE.id, consumerFile.id],
      frontier: [
        { fileId: PY_PACKAGE.id, hasMore: true, completeThroughDepth: 1 },
        { fileId: consumerFile.id, hasMore: true, completeThroughDepth: 0 },
      ],
      counts: { full: { nodes: 100, edges: 200, files: 25 }, slice: { nodes: 4, edges: 2, files: 2 } },
    });

    expect(comparisonContextPathsMissingFromHead(head, comparison)).toEqual([]);
  });

  it("does not hydrate dependents of a historical reference target already present in HEAD", () => {
    const consumerFile = {
      ...node("py:consumer", "module", "consumer.py"),
      location: { file: "consumer.py", startLine: 1 },
    };
    const consumer = {
      ...node("py:consumer#use", "function", "use", consumerFile.id),
      location: { file: "consumer.py", startLine: 2 },
    };
    const head = projection({
      target: { name: "fixture", root: ".", language: "python" },
      nodes: [PY_PACKAGE, PY_INIT_FN],
      edges: [],
      rootFileIds: [PY_PACKAGE.id],
      readyFileIds: [PY_PACKAGE.id],
      loadedFileIds: [PY_PACKAGE.id],
      frontier: [{ fileId: PY_PACKAGE.id, hasMore: false, completeThroughDepth: 1 }],
      counts: { full: { nodes: 100, edges: 200, files: 25 }, slice: { nodes: 2, edges: 0, files: 1 } },
    });
    const comparison = projection({
      target: { name: "fixture", root: ".", language: "python" },
      nodes: [PY_PACKAGE, PY_INIT_FN, consumerFile, consumer],
      edges: [{
        id: `references@${consumer.id}|${PY_INIT_FN.id}`,
        kind: "references",
        source: consumer.id,
        target: PY_INIT_FN.id,
      }],
      rootFileIds: [PY_PACKAGE.id],
      readyFileIds: [PY_PACKAGE.id],
      loadedFileIds: [PY_PACKAGE.id, consumerFile.id],
      frontier: [
        { fileId: PY_PACKAGE.id, hasMore: true, completeThroughDepth: 1 },
        { fileId: consumerFile.id, hasMore: true, completeThroughDepth: 0 },
      ],
      counts: { full: { nodes: 100, edges: 200, files: 25 }, slice: { nodes: 4, edges: 1, files: 2 } },
    });

    expect(comparisonContextPathsMissingFromHead(head, comparison)).toEqual([]);
  });

  it("merges disconnected/cumulative slices idempotently and merges logic flows by id", () => {
    const first = parseGraphProjection(projection());
    const second = parseGraphProjection(projection({
      nodes: [FILE_B, FN_B],
      rootFileIds: [FILE_B.id],
      readyFileIds: [FILE_B.id],
      loadedFileIds: [FILE_B.id],
      frontier: [{ fileId: FILE_B.id, hasMore: false, completeThroughDepth: 1 }],
      extensions: { logicFlow: { [FN_B.id]: [] }, stable: true },
    }));
    const merged = mergeGraphProjections(first, second);
    const replayed = mergeGraphProjections(merged, second);

    expect(merged.nodes.map((candidate) => candidate.id)).toEqual([
      FILE_A.id,
      FN_A.id,
      FILE_B.id,
      FN_B.id,
    ]);
    expect(merged.rootFileIds).toEqual([FILE_A.id, FILE_B.id]);
    expect(merged.counts.slice).toEqual({ nodes: 4, edges: 0, files: 2 });
    expect(merged.extensions?.logicFlow).toEqual({ [FN_A.id]: [], [FN_B.id]: [] });
    expect(replayed).toEqual(merged);
  });

  it("counts a Python package initializer as one file when independently extracted slices merge", () => {
    const first = parseGraphProjection(projection({
      target: { name: "fixture", root: ".", language: "python" },
    }));
    const python = parseGraphProjection(projection({
      target: { name: "fixture", root: ".", language: "python" },
      extensions: { logicFlow: { [PY_INIT_FN.id]: [] }, stable: true },
      nodes: [PY_PACKAGE, PY_INIT_FN],
      rootFileIds: [PY_PACKAGE.id],
      readyFileIds: [PY_PACKAGE.id],
      loadedFileIds: [PY_PACKAGE.id],
      frontier: [{ fileId: PY_PACKAGE.id, hasMore: false, completeThroughDepth: 1 }],
      counts: { full: { nodes: 100, edges: 200, files: 25 }, slice: { nodes: 2, edges: 0, files: 1 } },
    }));

    expect(mergeGraphProjections(first, python).counts.slice).toEqual({ nodes: 4, edges: 0, files: 2 });
  });

  it("merges independently extracted slices by stable partial lineage", () => {
    const lineage = {
      version: 1 as const,
      graphId: "graph-head",
      generation: "sha256:immutable-head",
    };
    const landing = parseGraphProjection(projection({
      generatedAt: "2026-07-31T08:00:00.000Z",
      extensions: {
        logicFlow: { [FN_A.id]: [] },
        entryModules: [FILE_A.id],
        prPartialGraph: lineage,
      },
      counts: { full: { nodes: 2, edges: 0, files: 1 }, slice: { nodes: 2, edges: 0, files: 1 } },
    }));
    const disconnected = parseGraphProjection(projection({
      generatedAt: "2026-07-31T08:00:02.000Z",
      nodes: [FILE_B, FN_B],
      rootFileIds: [FILE_B.id],
      readyFileIds: [FILE_B.id],
      loadedFileIds: [FILE_B.id],
      frontier: [{ fileId: FILE_B.id, hasMore: false, completeThroughDepth: 1 }],
      extensions: {
        logicFlow: { [FN_B.id]: [] },
        entryModules: [FILE_B.id],
        prPartialGraph: lineage,
      },
      counts: { full: { nodes: 3, edges: 0, files: 1 }, slice: { nodes: 2, edges: 0, files: 1 } },
    }));

    const merged = mergeGraphProjections(landing, disconnected);
    const reversed = mergeGraphProjections(disconnected, landing);

    expect(merged.generatedAt).toBe(landing.generatedAt);
    expect(merged.counts).toEqual({
      full: { nodes: 4, edges: 0, files: 2 },
      slice: { nodes: 4, edges: 0, files: 2 },
    });
    expect(merged.extensions?.prPartialGraph).toEqual(lineage);
    expect(merged.extensions?.entryModules).toEqual([FILE_A.id, FILE_B.id].sort());
    expect(reversed.generatedAt).toBe(merged.generatedAt);
    expect(reversed.counts).toEqual(merged.counts);
    expect(reversed.extensions?.entryModules).toEqual(merged.extensions?.entryModules);
    expect(mergeGraphProjections(merged, disconnected)).toEqual(merged);
  });

  it("monotonically enriches partial-slice logic-flow targets and optional call evidence", () => {
    const lineage = {
      version: 1 as const,
      graphId: "graph-head",
      generation: "sha256:immutable-head",
    };
    const source = { file: "src/a.ts", line: 3, col: 4, endLine: 3, endCol: 10 };
    const external = parseGraphProjection(projection({
      extensions: {
        logicFlow: {
          [FN_A.id]: [{
            kind: "call",
            label: "help",
            target: "ext:npm/./b#help",
            resolution: "external",
            source,
          }],
        },
        stable: true,
        prPartialGraph: lineage,
      },
    }));
    const resolved = parseGraphProjection(projection({
      generatedAt: "2026-07-31T08:00:02.000Z",
      extensions: {
        logicFlow: {
          [FN_A.id]: [{
            kind: "call",
            label: "help",
            target: FN_B.id,
            resolution: "resolved",
            detached: true,
            async: { kind: "launch", taskId: "task:help" },
            source,
          }],
        },
        stable: true,
        prPartialGraph: lineage,
      },
    }));

    const merged = mergeGraphProjections(external, resolved);
    const reversed = mergeGraphProjections(resolved, external);
    expect(merged.extensions?.logicFlow).toEqual(resolved.extensions?.logicFlow);
    expect(reversed.extensions?.logicFlow).toEqual(merged.extensions?.logicFlow);
    expect(mergeGraphProjections(merged, external)).toEqual(merged);

    const resolvedWithoutOptionalEvidence = parseGraphProjection(projection({
      generatedAt: "2026-07-31T08:00:02.500Z",
      extensions: {
        logicFlow: {
          [FN_A.id]: [{
            kind: "call",
            label: "help",
            target: FN_B.id,
            resolution: "resolved",
            source,
          }],
        },
        stable: true,
        prPartialGraph: lineage,
      },
    }));
    expect(mergeGraphProjections(resolvedWithoutOptionalEvidence, resolved).extensions?.logicFlow)
      .toEqual(resolved.extensions?.logicFlow);

    const conflictingResolved = parseGraphProjection(projection({
      generatedAt: "2026-07-31T08:00:03.000Z",
      extensions: {
        logicFlow: {
          [FN_A.id]: [{
            kind: "call",
            label: "help",
            target: "ts:src/c.ts#help",
            resolution: "resolved",
            source,
          }],
        },
        stable: true,
        prPartialGraph: lineage,
      },
    }));
    expect(() => mergeGraphProjections(resolved, conflictingResolved))
      .toThrow(`conflicting logicFlow payload for ${FN_A.id}`);
  });

  it("conservatively merges independently materialized IPC channel confidence", () => {
    const lineage = {
      version: 1 as const,
      graphId: "graph-head",
      generation: "sha256:immutable-head",
    };
    const id = "ipc:rpc/lane=service-method/channel=delegateService%2FregisterHook";
    const exact: GraphNode = {
      id,
      kind: "channel",
      qualifiedName: "delegateService/registerHook",
      displayName: "delegateService/registerHook",
      summary: "rpc channel (service-method) — joined by exact static evidence",
      parentId: null,
      location: { file: "(rpc)", startLine: 1 },
      tags: ["rpc", "service-method"],
    };
    const candidate: GraphNode = {
      ...exact,
      summary: "rpc selector (service-method) — candidate IPC correlation (75% confidence)",
      tags: ["rpc", "service-method", "candidate"],
    };
    const slice = (node: GraphNode, generatedAt: string) => parseGraphProjection(projection({
      generatedAt,
      nodes: [FILE_A, FN_A, node],
      extensions: { logicFlow: { [FN_A.id]: [] }, prPartialGraph: lineage },
      counts: { full: { nodes: 3, edges: 0, files: 1 }, slice: { nodes: 3, edges: 0, files: 1 } },
    }));
    const shallow = slice(exact, "2026-07-31T08:00:00.000Z");
    const deep = slice(candidate, "2026-07-31T08:00:02.000Z");

    const merged = mergeGraphProjections(shallow, deep);
    const reversed = mergeGraphProjections(deep, shallow);
    expect(merged.nodes.find((node) => node.id === id)).toEqual(candidate);
    expect(reversed.nodes.find((node) => node.id === id)).toEqual(candidate);
    expect(mergeGraphProjections(merged, shallow)).toEqual(merged);

    const roundedCandidate: GraphNode = {
      ...candidate,
      summary: "rpc selector (service-method) — candidate IPC correlation (100% confidence)",
    };
    const rounded = slice(roundedCandidate, "2026-07-31T08:00:02.500Z");
    expect(mergeGraphProjections(shallow, rounded).nodes.find((node) => node.id === id))
      .toEqual(roundedCandidate);
    expect(mergeGraphProjections(rounded, shallow).nodes.find((node) => node.id === id))
      .toEqual(roundedCandidate);

    const openVocabularyId = "ipc:candidate/lane=candidate/channel=review";
    const openVocabularyExact: GraphNode = {
      ...exact,
      id: openVocabularyId,
      summary: "candidate channel (candidate) — joined by exact static evidence",
      tags: ["candidate", "candidate"],
    };
    const openVocabularyCandidate: GraphNode = {
      ...openVocabularyExact,
      summary: "candidate selector (candidate) — candidate IPC correlation (100% confidence)",
      tags: ["candidate", "candidate", "candidate"],
    };
    const openShallow = slice(openVocabularyExact, "2026-07-31T08:00:02.600Z");
    const openDeep = slice(openVocabularyCandidate, "2026-07-31T08:00:02.700Z");
    expect(mergeGraphProjections(openShallow, openDeep).nodes.find((node) => node.id === openVocabularyId))
      .toEqual(openVocabularyCandidate);
    expect(mergeGraphProjections(openDeep, openShallow).nodes.find((node) => node.id === openVocabularyId))
      .toEqual(openVocabularyCandidate);

    const conflictingIdentity = slice(
      { ...candidate, location: { file: "(other)", startLine: 1 } },
      "2026-07-31T08:00:03.000Z",
    );
    expect(() => mergeGraphProjections(deep, conflictingIdentity))
      .toThrow(`conflicting node payload for ${id}`);
    const conflictingTags = slice(
      { ...candidate, tags: ["rpc", "service-method", "unrelated", "candidate"] },
      "2026-07-31T08:00:04.000Z",
    );
    expect(() => mergeGraphProjections(shallow, conflictingTags))
      .toThrow(`conflicting node payload for ${id}`);
    const conflictingSummary = slice(
      { ...candidate, summary: "other selector (service-method) — candidate IPC correlation (75% confidence)" },
      "2026-07-31T08:00:05.000Z",
    );
    expect(() => mergeGraphProjections(shallow, conflictingSummary))
      .toThrow(`conflicting node payload for ${id}`);
    const misplacedCandidateTag = slice(
      { ...candidate, tags: ["rpc", "candidate", "service-method"] },
      "2026-07-31T08:00:06.000Z",
    );
    expect(() => mergeGraphProjections(shallow, misplacedCandidateTag))
      .toThrow(`conflicting node payload for ${id}`);
  });

  it("monotonically enriches call-site evidence on partial-slice edges", () => {
    const lineage = {
      version: 1 as const,
      graphId: "graph-head",
      generation: "sha256:immutable-head",
    };
    const edgeId = `calls@${FN_A.id}|${FN_B.id}`;
    const shallowEdge: GraphEdge = {
      id: edgeId,
      source: FN_A.id,
      target: FN_B.id,
      kind: "calls",
      resolution: "resolved",
      weight: 1,
      callSites: [{ file: "src/a.ts", line: 11 }],
    };
    const deepEdge: GraphEdge = {
      ...shallowEdge,
      weight: 3,
      callSites: [
        { file: "src/a.ts", line: 3 },
        { file: "src/a.ts", line: 7 },
        { file: "src/a.ts", line: 11 },
      ],
    };
    const shallow = parseGraphProjection(projection({
      nodes: [FILE_A, FN_A, FILE_B, FN_B],
      edges: [shallowEdge],
      loadedFileIds: [FILE_A.id, FILE_B.id],
      extensions: { logicFlow: { [FN_A.id]: [] }, prPartialGraph: lineage },
      counts: { full: { nodes: 4, edges: 1, files: 2 }, slice: { nodes: 4, edges: 1, files: 2 } },
    }));
    const deep = parseGraphProjection(projection({
      generatedAt: "2026-07-31T08:00:02.000Z",
      nodes: [FILE_A, FN_A, FILE_B, FN_B],
      edges: [deepEdge],
      loadedFileIds: [FILE_A.id, FILE_B.id],
      extensions: { logicFlow: { [FN_A.id]: [] }, prPartialGraph: lineage },
      counts: { full: { nodes: 4, edges: 1, files: 2 }, slice: { nodes: 4, edges: 1, files: 2 } },
    }));

    const merged = mergeGraphProjections(shallow, deep);
    expect(merged.edges).toEqual([deepEdge]);
    expect(mergeGraphProjections(deep, shallow).edges).toEqual(merged.edges);
    expect(mergeGraphProjections(merged, shallow)).toEqual(merged);

    const conflict = parseGraphProjection(projection({
      nodes: [FILE_A, FN_A, FILE_B, FN_B],
      edges: [{ ...deepEdge, resolution: "external" }],
      loadedFileIds: [FILE_A.id, FILE_B.id],
      extensions: { logicFlow: { [FN_A.id]: [] }, prPartialGraph: lineage },
      counts: { full: { nodes: 4, edges: 1, files: 2 }, slice: { nodes: 4, edges: 1, files: 2 } },
    }));
    expect(() => mergeGraphProjections(deep, conflict)).toThrow(`conflicting edge payload for ${edgeId}`);
  });

  it("bounds cumulative partial graph residency independently of one response", () => {
    expect(() => assertProgressiveResidentCounts({
      nodes: MAX_PROGRESSIVE_RESIDENT_NODES,
      edges: MAX_PROGRESSIVE_RESIDENT_EDGES,
      files: MAX_PROGRESSIVE_RESIDENT_FILES,
    })).not.toThrow();
    expect(() => assertProgressiveResidentCounts({
      nodes: MAX_PROGRESSIVE_RESIDENT_NODES + 1,
      edges: 0,
      files: 0,
    })).toThrow("partial graph resident limit exceeded");
    expect(() => assertProgressiveResidentCounts({
      nodes: 0,
      edges: MAX_PROGRESSIVE_RESIDENT_EDGES + 1,
      files: 0,
    })).toThrow("partial graph resident limit exceeded");
    expect(() => assertProgressiveResidentCounts({
      nodes: 0,
      edges: 0,
      files: MAX_PROGRESSIVE_RESIDENT_FILES + 1,
    })).toThrow("partial graph resident limit exceeded");
  });

  it("keeps rendered order as a stable prefix and appends incoming source order without ID sorting", () => {
    const current = parseGraphProjection(projection({
      nodes: [FILE_A, FN_ZETA],
      edges: [EDGE_ZETA],
      extensions: { logicFlow: {}, stable: true },
      counts: { full: { nodes: 100, edges: 200, files: 25 }, slice: { nodes: 2, edges: 1, files: 1 } },
    }));
    const incoming = parseGraphProjection(projection({
      nodes: [FILE_A, FN_ZETA, FN_ALPHA, FILE_B, FN_B],
      edges: [EDGE_ZETA, EDGE_ALPHA],
      rootFileIds: [FILE_B.id, FILE_A.id],
      readyFileIds: [FILE_B.id, FILE_A.id],
      loadedFileIds: [FILE_B.id, FILE_A.id],
      frontier: [
        { fileId: FILE_B.id, hasMore: false, completeThroughDepth: 1 },
        { fileId: FILE_A.id, hasMore: false, completeThroughDepth: 1 },
      ],
      extensions: { logicFlow: {}, stable: true },
      counts: { full: { nodes: 100, edges: 200, files: 25 }, slice: { nodes: 5, edges: 2, files: 2 } },
    }));

    const merged = mergeGraphProjections(current, incoming);

    expect(merged.nodes.map(({ id }) => id)).toEqual([
      FILE_A.id,
      FN_ZETA.id,
      FN_ALPHA.id,
      FILE_B.id,
      FN_B.id,
    ]);
    expect(merged.nodes.slice(0, current.nodes.length)).toEqual(current.nodes);
    expect(merged.edges.map(({ id }) => id)).toEqual([EDGE_ZETA.id, EDGE_ALPHA.id]);
    expect(merged.rootFileIds).toEqual([FILE_A.id, FILE_B.id]);
    expect(merged.readyFileIds).toEqual([FILE_A.id, FILE_B.id]);
    expect(merged.loadedFileIds).toEqual([FILE_A.id, FILE_B.id]);
    expect(merged.frontier.map(({ fileId }) => fileId)).toEqual([FILE_A.id, FILE_B.id]);
    expect(mergeGraphProjections(merged, incoming)).toEqual(merged);
  });

  it("unions filtered fingerprints and ports deterministically without losing duplicate ports", () => {
    const first = parseGraphProjection(projection({
      extensions: {
        logicFlow: { [FN_A.id]: [] },
        reviewFingerprints: fingerprints(
          { [FN_A.id]: fingerprint("unit:a", DIGEST_A) },
          { "src/a.ts": fingerprint("file:a", DIGEST_A) },
        ),
        ports: [PORT_A, PORT_A],
      },
    }));
    const second = parseGraphProjection(projection({
      nodes: [FILE_B, FN_B],
      rootFileIds: [FILE_B.id],
      readyFileIds: [FILE_B.id],
      loadedFileIds: [FILE_B.id],
      frontier: [{ fileId: FILE_B.id, hasMore: false, completeThroughDepth: 1 }],
      extensions: {
        logicFlow: { [FN_B.id]: [] },
        reviewFingerprints: fingerprints(
          { [FN_B.id]: fingerprint("unit:b", DIGEST_B) },
          { "src/b.ts": fingerprint("file:b", DIGEST_B) },
        ),
        ports: [PORT_B, { ...PORT_A, callSite: { line: 3, file: "src/a.ts" } }],
      },
    }));

    const merged = mergeGraphProjections(first, second);
    const reversed = mergeGraphProjections(second, first);
    const replayed = mergeGraphProjections(merged, second);

    expect(merged.extensions?.reviewFingerprints).toEqual(fingerprints(
      {
        [FN_A.id]: fingerprint("unit:a", DIGEST_A),
        [FN_B.id]: fingerprint("unit:b", DIGEST_B),
      },
      {
        "src/a.ts": fingerprint("file:a", DIGEST_A),
        "src/b.ts": fingerprint("file:b", DIGEST_B),
      },
    ));
    expect(merged.extensions?.ports).toHaveLength(3);
    expect((merged.extensions?.ports as unknown[]).filter((port) => (
      (port as { nodeId: string }).nodeId === FN_A.id
    ))).toHaveLength(2);
    expect(reversed.extensions).toEqual(merged.extensions);
    expect(replayed.extensions).toEqual(merged.extensions);
  });

  it("preserves ordered entries and unions filtered timeline/coverage state for depth and disconnected slices", () => {
    const initial = parseGraphProjection(projection({
      extensions: {
        entryModules: [FILE_A.id, FILE_B.id],
        sequenceTimeline: { [FN_A.id]: { marker: "a" } },
        testExecutionCoverage: coverage({ "src/a.ts": 1 }),
      },
    }));
    const depthExpanded = parseGraphProjection(projection({
      nodes: [FILE_A, FN_A, FILE_B, FN_B],
      loadedFileIds: [FILE_A.id, FILE_B.id],
      frontier: [
        { fileId: FILE_A.id, hasMore: false, completeThroughDepth: 3 },
        { fileId: FILE_B.id, hasMore: false, completeThroughDepth: 3 },
      ],
      requestedDepth: 3,
      loadedDepth: 3,
      extensions: {
        entryModules: [FILE_A.id, FILE_B.id],
        sequenceTimeline: {
          [FN_A.id]: { marker: "a" },
          [FN_B.id]: { marker: "b" },
        },
        testExecutionCoverage: coverage({ "src/a.ts": 1, "src/b.ts": 2 }),
      },
    }));
    const disconnected = parseGraphProjection(projection({
      nodes: [FILE_B, FN_B],
      rootFileIds: [FILE_B.id],
      readyFileIds: [FILE_B.id],
      loadedFileIds: [FILE_B.id],
      frontier: [{ fileId: FILE_B.id, hasMore: false, completeThroughDepth: 1 }],
      extensions: {
        entryModules: [FILE_A.id, FILE_B.id],
        sequenceTimeline: { [FN_B.id]: { marker: "b" } },
        testExecutionCoverage: coverage({ "src/b.ts": 2 }),
      },
    }));

    const expanded = mergeGraphProjections(initial, depthExpanded);
    const union = mergeGraphProjections(initial, disconnected);
    expect(expanded.extensions).toEqual(depthExpanded.extensions);
    expect(union.extensions?.entryModules).toEqual([FILE_A.id, FILE_B.id]);
    expect(union.extensions?.sequenceTimeline).toEqual({
      [FN_A.id]: { marker: "a" },
      [FN_B.id]: { marker: "b" },
    });
    expect((union.extensions?.testExecutionCoverage as { files: Record<string, unknown> }).files)
      .toEqual(expect.objectContaining({ "src/a.ts": expect.anything(), "src/b.ts": expect.anything() }));
    expect(mergeGraphProjections(disconnected, initial).extensions).toEqual(union.extensions);
  });

  it("rejects conflicts in ordered entries, timeline roots, and coverage files", () => {
    const current = parseGraphProjection(projection({
      extensions: {
        entryModules: [FILE_A.id, FILE_B.id],
        sequenceTimeline: { [FN_A.id]: { marker: "a" } },
        testExecutionCoverage: coverage({ "src/a.ts": 1 }),
      },
    }));
    const conflictingEntries = parseGraphProjection(projection({
      extensions: {
        entryModules: [FILE_B.id, FILE_A.id],
        sequenceTimeline: { [FN_A.id]: { marker: "a" } },
        testExecutionCoverage: coverage({ "src/a.ts": 1 }),
      },
    }));
    const conflictingTimeline = parseGraphProjection(projection({
      extensions: {
        entryModules: [FILE_A.id, FILE_B.id],
        sequenceTimeline: { [FN_A.id]: { marker: "different" } },
        testExecutionCoverage: coverage({ "src/a.ts": 1 }),
      },
    }));
    const conflictingCoverage = parseGraphProjection(projection({
      extensions: {
        entryModules: [FILE_A.id, FILE_B.id],
        sequenceTimeline: { [FN_A.id]: { marker: "a" } },
        testExecutionCoverage: coverage({ "src/a.ts": 9 }),
      },
    }));

    expect(() => mergeGraphProjections(current, conflictingEntries))
      .toThrow("conflicting extension payload for entryModules");
    expect(() => mergeGraphProjections(current, conflictingTimeline))
      .toThrow(`conflicting sequenceTimeline entries payload for ${FN_A.id}`);
    expect(() => mergeGraphProjections(current, conflictingCoverage))
      .toThrow("conflicting testExecutionCoverage files payload for src/a.ts");
  });

  it.each([
    ["version", { version: 2 }],
    ["algorithm", { algorithm: "sha512" }],
    ["complete", { complete: false }],
  ])("rejects conflicting review fingerprint %s headers", (field, header) => {
    const current = parseGraphProjection(projection({
      extensions: {
        reviewFingerprints: fingerprints(
          { [FN_A.id]: fingerprint("unit:a", DIGEST_A) },
          {},
        ),
      },
    }));
    const incomingExtension = {
      ...fingerprints(
        { [FN_B.id]: fingerprint("unit:b", DIGEST_B) },
        {},
      ),
      ...header,
    };
    const incoming = parseGraphProjection(projection({
      extensions: { reviewFingerprints: incomingExtension as never },
    }));

    expect(() => mergeGraphProjections(current, incoming))
      .toThrow(`conflicting reviewFingerprints ${field}`);
  });

  it("conservatively merges fingerprint completeness across partial slices", () => {
    const lineage = {
      version: 1 as const,
      graphId: "graph-head",
      generation: "sha256:immutable-head",
    };
    const complete = parseGraphProjection(projection({
      extensions: {
        prPartialGraph: lineage,
        reviewFingerprints: fingerprints(
          { [FN_A.id]: fingerprint("unit:a", DIGEST_A) },
          { "src/a.ts": fingerprint("file:a", DIGEST_A) },
        ),
      },
    }));
    const incomplete = parseGraphProjection(projection({
      generatedAt: "2026-07-31T08:00:02.000Z",
      extensions: {
        prPartialGraph: lineage,
        reviewFingerprints: {
          ...fingerprints(
            { [FN_B.id]: fingerprint("unit:b", DIGEST_B) },
            { "src/b.ts": fingerprint("file:b", DIGEST_B) },
          ),
          complete: false,
        },
      },
      counts: { full: { nodes: 3, edges: 0, files: 2 }, slice: { nodes: 2, edges: 0, files: 1 } },
    }));

    const merged = mergeGraphProjections(complete, incomplete);
    expect((merged.extensions?.reviewFingerprints as { complete: boolean }).complete).toBe(false);
    expect(mergeGraphProjections(incomplete, complete).extensions).toEqual(merged.extensions);
    expect(mergeGraphProjections(merged, complete)).toEqual(merged);
  });

  it("rejects conflicting fingerprint entries and invalid cross-fragment address reuse", () => {
    const current = parseGraphProjection(projection({
      extensions: {
        reviewFingerprints: fingerprints(
          { [FN_A.id]: fingerprint("unit:shared", DIGEST_A) },
          { "src/a.ts": fingerprint("file:a", DIGEST_A) },
        ),
      },
    }));
    const conflicting = parseGraphProjection(projection({
      extensions: {
        reviewFingerprints: fingerprints(
          { [FN_A.id]: fingerprint("unit:shared", DIGEST_B) },
          { "src/a.ts": fingerprint("file:a", DIGEST_A) },
        ),
      },
    }));
    const duplicateAddress = parseGraphProjection(projection({
      extensions: {
        reviewFingerprints: fingerprints(
          { [FN_B.id]: fingerprint("unit:shared", DIGEST_B) },
          {},
        ),
      },
    }));

    expect(() => mergeGraphProjections(current, conflicting))
      .toThrow(`conflicting reviewFingerprints units payload for ${FN_A.id}`);
    expect(() => mergeGraphProjections(current, duplicateAddress))
      .toThrow("must be a valid fingerprint extension");
  });

  it("fails closed on generation, canonical record, full-count, and logic-flow conflicts", () => {
    const current = parseGraphProjection(projection());
    expect(() => mergeGraphProjections(current, parseGraphProjection(projection({ generation: "other" }))))
      .toThrow("conflicting generation");
    expect(() => mergeGraphProjections(current, parseGraphProjection(projection({
      nodes: [FILE_A, { ...FN_A, displayName: "changed" }],
    })))).toThrow(`conflicting node payload for ${FN_A.id}`);
    expect(() => mergeGraphProjections(current, parseGraphProjection(projection({
      counts: { full: { nodes: 101, edges: 200, files: 25 }, slice: { nodes: 2, edges: 0, files: 1 } },
    })))).toThrow("conflicting counts.full");
    expect(() => mergeGraphProjections(current, parseGraphProjection(projection({
      extensions: { logicFlow: { [FN_A.id]: [{ kind: "exit", variant: "return", label: null }] }, stable: true },
    })))).toThrow(`conflicting logicFlow payload for ${FN_A.id}`);
  });

  it("uses explicit root readiness and keeps lookahead outside the canvas gate", () => {
    const ready = parseGraphProjection(projection());
    const partial = parseGraphProjection(projection({ readyFileIds: [], loadedDepth: 0 }));

    expect(isProjectionReadyForCanvas(ready)).toBe(true);
    expect(isProjectionReadyForCanvas(partial)).toBe(false);
    expect(areProjectionFilesReady(ready, [FILE_A.id])).toBe(true);
    expect(projectionFrontierToPrefetch(ready, 3)).toEqual(ready.frontier);
    expect(projectionFrontierToPrefetch(ready, 1)).toEqual([]);
  });

  it("posts a correlated projection request and rejects a mismatched response", async () => {
    const request = changedFileProjectionRequest("graph-head", "graph-head", 1, 3);
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json(projection()));

    await expect(fetchGraphProjection("/api/graph/project", request, { fetchImpl }))
      .resolves.toMatchObject({ graphId: "graph-head", loadedDepth: 1 });
    expect(fetchImpl).toHaveBeenCalledWith(
      new URL("http://meridian.local/api/graph/project"),
      expect.objectContaining({ method: "POST", body: JSON.stringify(request) }),
    );

    const mismatch = vi.fn<typeof fetch>().mockResolvedValue(Response.json(projection({ seedGraphId: "other" })));
    await expect(fetchGraphProjection("/api/graph/project", request, { fetchImpl: mismatch }))
      .rejects.toThrow("does not match its request");
  });

  it("streams projection bytes through split UTF-8 code points at the exact limit", async () => {
    const unicodeFile = { ...FILE_A, displayName: "a-界-🚀.ts" };
    const payload = JSON.stringify(projection({ nodes: [unicodeFile, FN_A] }));
    const bytes = new TextEncoder().encode(payload);
    const splitAt = utf8Offset(payload, "界") + 1;
    const response = chunkedResponse([
      bytes.slice(0, splitAt),
      bytes.slice(splitAt, splitAt + 1),
      bytes.slice(splitAt + 1),
    ]);
    const request = changedFileProjectionRequest("graph-head", "graph-head", 1, 3);

    await expect(fetchGraphProjection("/api/graph/project", request, {
      maxBytes: bytes.byteLength,
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(response),
    })).resolves.toMatchObject({ nodes: [expect.objectContaining({ displayName: "a-界-🚀.ts" }), FN_A] });
  });

  it("cancels a chunked projection response on the first byte beyond the limit", async () => {
    const payload = new TextEncoder().encode(JSON.stringify(projection()));
    let cancelled = false;
    const response = chunkedResponse(
      [payload, new Uint8Array([0x20])],
      { leaveOpen: true, onCancel: () => { cancelled = true; } },
    );
    const request = changedFileProjectionRequest("graph-head", "graph-head", 1, 3);

    await expect(fetchGraphProjection("/api/graph/project", request, {
      maxBytes: payload.byteLength,
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(response),
    })).rejects.toThrow(`graph projection response exceeds ${payload.byteLength} bytes`);
    expect(cancelled).toBe(true);
  });

  it("requests cache-only lookahead from the dedicated post-actionable route", async () => {
    const request = changedFileProjectionRequest("graph-head", "graph-head", 2, 4);
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json(
      { accepted: true },
      { status: 202 },
    ));

    await warmGraphProjection("https://example.test/not-a-capability?ignored=yes", request, { fetchImpl });

    expect(fetchImpl).toHaveBeenCalledWith(
      new URL("https://example.test/api/graph/project/warm"),
      expect.objectContaining({
        method: "POST",
        credentials: "same-origin",
        body: JSON.stringify(request),
      }),
    );

    const unavailable = vi.fn<typeof fetch>().mockResolvedValue(Response.json(
      { error: "projection capacity is full" },
      { status: 503 },
    ));
    await expect(warmGraphProjection("/api/graph/project", request, { fetchImpl: unavailable }))
      .rejects.toThrow("graph projection warm failed (503) from /api/graph/project/warm");
  });
});

function fingerprint(address: string, digest: string) {
  return { address, digest };
}

function fingerprints(
  units: Record<string, ReturnType<typeof fingerprint>>,
  files: Record<string, ReturnType<typeof fingerprint>>,
) {
  return {
    version: 1,
    algorithm: "sha256-source-bytes",
    complete: true,
    units,
    files,
  };
}

describe("background graph symbols", () => {
  const result = {
    version: GRAPH_SYMBOL_SEARCH_VERSION,
    graphId: "graph-head",
    generation: "sha256:immutable-head",
    complete: false,
    indexedSymbolCount: 10,
    totalSymbolCount: 20,
    symbols: [{
      id: FN_A.id,
      fileId: FILE_A.id,
      displayName: "run",
      qualifiedName: "src/a.ts.run",
      kind: "function",
      file: "src/a.ts",
      isPrivateMethod: false,
      stepCount: 3,
    }],
  };

  it("parses bounded partial results while preserving immutable generation", () => {
    expect(parseGraphSymbolSearchResult(result)).toEqual(result);
    expect(() => parseGraphSymbolSearchResult({ ...result, complete: true })).toThrow("indexedSymbolCount equal");
    expect(() => parseGraphSymbolSearchResult({ ...result, symbols: [result.symbols[0], result.symbols[0]] }))
      .toThrow("symbol ids must not contain duplicates");
  });

  it("bounds actual and declared response bytes before exposing symbols", async () => {
    const text = JSON.stringify(result);
    expect(() => parseGraphSymbolSearchResponse(text, 4)).toThrow("exceeds 4 bytes");

    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(text, {
      status: 200,
      headers: { "content-length": String(text.length + 100) },
    }));
    await expect(fetchGraphSymbols("/api/graph/symbols?id=graph-head", {
      fetchImpl,
      maxBytes: text.length,
    })).rejects.toThrow(`exceeds ${text.length} bytes`);
  });

  it("streams symbol bytes through split UTF-8 code points at the exact limit", async () => {
    const unicodeResult = {
      ...result,
      symbols: [{
        ...result.symbols[0],
        displayName: "rún-界-🚀",
        qualifiedName: "src/a.ts.rún-界-🚀",
      }],
    };
    const payload = JSON.stringify(unicodeResult);
    const bytes = new TextEncoder().encode(payload);
    const splitAt = utf8Offset(payload, "🚀") + 2;
    const response = chunkedResponse([
      bytes.slice(0, splitAt),
      bytes.slice(splitAt, splitAt + 1),
      bytes.slice(splitAt + 1),
    ]);

    await expect(fetchGraphSymbols("/api/graph/symbols?id=graph-head", {
      maxBytes: bytes.byteLength,
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(response),
    })).resolves.toEqual(unicodeResult);
  });

  it("cancels a chunked symbol response on the first byte beyond the limit", async () => {
    const payload = new TextEncoder().encode(JSON.stringify(result));
    let cancelled = false;
    const response = chunkedResponse(
      [payload, new Uint8Array([0x20])],
      { leaveOpen: true, onCancel: () => { cancelled = true; } },
    );

    await expect(fetchGraphSymbols("/api/graph/symbols?id=graph-head", {
      maxBytes: payload.byteLength,
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(response),
    })).rejects.toThrow(`graph symbol response exceeds ${payload.byteLength} bytes`);
    expect(cancelled).toBe(true);
  });

  it("delegates fetch, text decoding, and parsing to an abortable module Worker", async () => {
    let posted: unknown = null;
    let terminated = false;
    const worker = {
      onmessage: null as ((event: MessageEvent) => void) | null,
      onerror: null as ((event: ErrorEvent) => void) | null,
      postMessage(message: unknown) {
        posted = message;
        queueMicrotask(() => this.onmessage?.({ data: { ok: true, result } } as MessageEvent));
      },
      terminate() {
        terminated = true;
      },
    };

    await expect(fetchGraphSymbols("/api/graph/symbols?id=graph-head", {
      workerFactory: () => worker as unknown as Worker,
    })).resolves.toEqual(result);
    expect(posted).toMatchObject({
      url: "http://meridian.local/api/graph/symbols?id=graph-head",
    });
    expect(terminated).toBe(true);

    const controller = new AbortController();
    const stalledWorker = {
      onmessage: null,
      onerror: null,
      postMessage: vi.fn(),
      terminate: vi.fn(),
    };
    const pending = fetchGraphSymbols("/api/graph/symbols?id=graph-head", {
      signal: controller.signal,
      workerFactory: () => stalledWorker as unknown as Worker,
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(stalledWorker.terminate).toHaveBeenCalledOnce();
  });
});

function utf8Offset(text: string, needle: string): number {
  const characterOffset = text.indexOf(needle);
  if (characterOffset < 0) throw new Error(`missing UTF-8 split marker ${needle}`);
  return new TextEncoder().encode(text.slice(0, characterOffset)).byteLength;
}

function chunkedResponse(
  chunks: readonly Uint8Array[],
  options: { leaveOpen?: boolean; onCancel?: () => void } = {},
): Response {
  let index = 0;
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index];
      if (chunk !== undefined) {
        index += 1;
        controller.enqueue(chunk);
        return;
      }
      if (!options.leaveOpen) controller.close();
    },
    cancel() {
      options.onCancel?.();
    },
  }), { status: 200 });
}
