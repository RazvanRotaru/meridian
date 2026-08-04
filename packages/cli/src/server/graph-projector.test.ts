import { describe, expect, it } from "vitest";
import {
  GRAPH_PROJECTION_VERSION,
  SCHEMA_VERSION,
  validateArtifact,
  type GraphArtifact,
  type GraphEdge,
  type GraphNode,
  type GraphProjectionRequestV1,
} from "@meridian/core";
import {
  indexCanonicalGraphSymbols,
  projectCanonicalGraph,
  recomputeProjectionFrontierReadiness,
} from "./graph-projector";

const packageNode = node("pkg:.", "package", ".");
const moduleA = node("m:a", "module", "src/a.ts", packageNode.id);
const moduleB = node("m:b", "module", "src/b.ts", packageNode.id);
const moduleC = node("m:c", "module", "src/c.ts", packageNode.id);
const moduleD = node("m:d", "module", "src/d.ts", packageNode.id);
const fnA = node("fn:a", "function", "src/a.ts", moduleA.id);
const fnB = node("fn:b", "function", "src/b.ts", moduleB.id);
const fnC = node("fn:c", "function", "src/c.ts", moduleC.id);
const fnD = node("fn:d", "method", "src/d.ts", moduleD.id, "__private");
const fnD2 = node("fn:d2", "function", "src/d.ts", moduleD.id);
const channel = node("ipc:electron/channel=load", "channel", "(electron)");
const fingerprint = (address: string) => ({ address, digest: "0".repeat(64) });

const fixture = artifact(
  [packageNode, moduleA, fnA, moduleB, fnB, moduleC, fnC, moduleD, fnD, fnD2, channel],
  [
    edge("imports", moduleA.id, moduleB.id),
    edge("imports", moduleB.id, moduleC.id),
    edge("calls", fnA.id, fnC.id),
    edge("calls", fnC.id, fnD.id),
    edge("sends", fnA.id, channel.id),
    edge("handles", channel.id, fnD.id),
  ],
  {
    changedSince: { manifest: [{ path: "src/a.ts", status: "modified" }] },
    reviewFingerprints: {
      version: 1,
      algorithm: "sha256-source-bytes",
      complete: true,
      units: {
        [fnA.id]: fingerprint("unit:a"),
        [fnB.id]: fingerprint("unit:b"),
        [fnC.id]: fingerprint("unit:c"),
        [fnD.id]: fingerprint("unit:d"),
        [fnD2.id]: fingerprint("unit:d2"),
      },
      files: {
        "src/a.ts": fingerprint("file:a"),
        "src/b.ts": fingerprint("file:b"),
        "src/c.ts": fingerprint("file:c"),
        "src/d.ts": fingerprint("file:d"),
        "src/outside.ts": fingerprint("file:outside"),
      },
    },
    ports: [
      { nodeId: fnA.id, direction: "out", protocol: "electron", channel: "load", label: "load", callSite: { file: "src/a.ts", line: 1 } },
      { nodeId: fnB.id, direction: "out", protocol: "electron", channel: "other", label: "other", callSite: { file: "src/b.ts", line: 1 } },
      { nodeId: fnD.id, direction: "in", protocol: "electron", channel: "load", label: "load", callSite: { file: "src/d.ts", line: 1 } },
      { nodeId: fnD2.id, direction: "in", protocol: "electron", channel: "other", label: "other", callSite: { file: "src/d.ts", line: 2 } },
    ],
    logicFlow: {
      [fnA.id]: [{ kind: "call", label: "c", target: fnC.id, resolution: "resolved" }],
      [fnB.id]: [{ kind: "call", label: "c", target: fnC.id, resolution: "resolved" }],
    },
  },
);

describe("graph projector", () => {
  it("loads one complete root file while retaining import, IPC, coupling and flow ghost evidence", () => {
    const projection = projectCanonicalGraph({
      artifact: fixture,
      seedArtifact: fixture,
      request: changedRequest("head", "head", 0, 2),
      generation: "a".repeat(64),
      loadedDepth: 0,
    });

    expect(projection.rootFileIds).toEqual([moduleA.id]);
    expect(projection.readyFileIds).toEqual([]);
    expect(projection.loadedFileIds).toEqual([moduleA.id, moduleB.id, moduleC.id, moduleD.id]);
    expect(projection.loadedDepth).toBe(0);
    expect(projection.prefetchDepth).toBe(2);
    expect(projection.frontier).toEqual([{ fileId: moduleA.id, hasMore: true, completeThroughDepth: 0 }]);
    expect(projection.nodes.map(({ id }) => id)).toEqual(expect.arrayContaining([
      packageNode.id,
      moduleA.id,
      fnA.id,
      moduleB.id,
      moduleC.id,
      fnC.id,
      moduleD.id,
      fnD.id,
      channel.id,
    ]));
    expect(projection.nodes.map(({ id }) => id)).not.toContain(fnD2.id);
    expect(projection.counts.slice.files).toBe(4);
    expect(projection.counts.slice.files).toBe(
      projection.nodes.filter(({ kind }) => kind === "module").length,
    );
    expect(projection.loadedFileIds).toEqual(
      projection.nodes.filter(({ kind }) => kind === "module").map(({ id }) => id),
    );
    const validation = validateArtifact({
      schemaVersion: projection.schemaVersion,
      generatedAt: projection.generatedAt,
      generator: projection.generator,
      target: projection.target,
      nodes: projection.nodes,
      edges: projection.edges,
      extensions: projection.extensions,
    });
    expect(validation.errors).toEqual([]);
    expect(projection.edges.map(({ id }) => id)).toEqual([
      "imports@m:a|m:b",
      "calls@fn:a|fn:c",
      "sends@fn:a|ipc:electron/channel=load",
      "handles@ipc:electron/channel=load|fn:d",
    ]);
    expect(projection.extensions?.changedSince).toEqual(fixture.extensions?.changedSince);
    expect(projection.extensions?.reviewFingerprints).toEqual({
      version: 1,
      algorithm: "sha256-source-bytes",
      complete: true,
      units: {
        [fnA.id]: fingerprint("unit:a"),
        [fnC.id]: fingerprint("unit:c"),
        [fnD.id]: fingerprint("unit:d"),
      },
      files: {
        "src/a.ts": fingerprint("file:a"),
        "src/b.ts": fingerprint("file:b"),
        "src/c.ts": fingerprint("file:c"),
        "src/d.ts": fingerprint("file:d"),
      },
    });
    expect(projection.extensions?.ports).toEqual([
      expect.objectContaining({ nodeId: fnA.id }),
      expect.objectContaining({ nodeId: fnD.id }),
    ]);
    expect(projection.extensions?.logicFlow).toEqual({
      [fnA.id]: [{ kind: "call", label: "c", target: fnC.id, resolution: "resolved" }],
    });
  });

  it("uses weak import and collapsed IPC adjacency without traversing ordinary calls", () => {
    const fromC = projectCanonicalGraph({
      artifact: fixture,
      seedArtifact: fixture,
      request: filesRequest("graph", [moduleC.id], 1),
      generation: "b".repeat(64),
      loadedDepth: 1,
    });
    expect(fromC.loadedFileIds).toEqual([moduleA.id, moduleB.id, moduleC.id, moduleD.id]);
    expect(fromC.readyFileIds).toEqual([moduleC.id]);
    expect(fromC.frontier).toEqual([
      { fileId: moduleB.id, hasMore: true, completeThroughDepth: 0 },
      { fileId: moduleC.id, hasMore: true, completeThroughDepth: 1 },
    ]);
    expect(fromC.nodes.map(({ id }) => id)).not.toContain(fnD2.id);

    const fromA = projectCanonicalGraph({
      artifact: fixture,
      seedArtifact: fixture,
      request: filesRequest("graph", [moduleA.id], 1),
      generation: "c".repeat(64),
      loadedDepth: 1,
    });
    expect(fromA.loadedFileIds).toEqual([moduleA.id, moduleB.id, moduleC.id, moduleD.id]);
    expect(fromA.readyFileIds).toEqual([moduleA.id, moduleD.id]);
    expect(fromA.frontier).toEqual([
      { fileId: moduleA.id, hasMore: true, completeThroughDepth: 1 },
      { fileId: moduleB.id, hasMore: true, completeThroughDepth: 0 },
      { fileId: moduleD.id, hasMore: true, completeThroughDepth: 1 },
    ]);
    expect(fromA.readyFileIds).toEqual([moduleA.id, moduleD.id]);
    expect(fromA.nodes.map(({ id }) => id)).toContain(fnD2.id);
  });

  it("proves readiness per file when only another arm of the loaded component has a frontier", () => {
    const branched = artifact(
      [packageNode, moduleA, moduleB, moduleC, moduleD],
      [
        edge("imports", moduleA.id, moduleB.id),
        edge("imports", moduleA.id, moduleC.id),
        edge("imports", moduleC.id, moduleD.id),
      ],
    );
    const projection = projectCanonicalGraph({
      artifact: branched,
      seedArtifact: branched,
      request: filesRequest("graph", [moduleA.id], 1, 3),
      generation: "7".repeat(64),
      loadedDepth: 1,
    });

    expect(projection.frontier).toEqual([
      { fileId: moduleA.id, hasMore: true, completeThroughDepth: 1 },
      { fileId: moduleB.id, hasMore: true, completeThroughDepth: 2 },
      { fileId: moduleC.id, hasMore: true, completeThroughDepth: 0 },
    ]);
    expect(projection.readyFileIds).toEqual([moduleA.id, moduleB.id]);
  });

  it("renders the lookahead ring as ghosts, then promotes the same node from an expanded slice", () => {
    const landing = artifact(
      [packageNode, moduleA, moduleB, moduleC],
      [
        edge("imports", moduleA.id, moduleB.id),
        edge("imports", moduleB.id, moduleC.id),
      ],
      {
        prInitialGraph: {
          version: 1,
          complete: false,
          depth: 2,
          seedFiles: ["src/a.ts"],
          selectedFiles: ["src/a.ts", "src/b.ts", "src/c.ts"],
          frontierFiles: ["src/c.ts"],
        },
      },
    );
    const projection = projectCanonicalGraph({
      artifact: landing,
      seedArtifact: landing,
      request: filesRequest("partial", [moduleA.id], 1, 3),
      generation: "8".repeat(64),
      loadedDepth: 1,
    });

    expect(projection.frontier).toEqual([
      { fileId: moduleA.id, hasMore: true, completeThroughDepth: 1 },
      { fileId: moduleB.id, hasMore: true, completeThroughDepth: 0 },
    ]);
    expect(projection.readyFileIds).toEqual([moduleA.id]);
    expect(projection.loadedFileIds).toEqual([moduleA.id, moduleB.id, moduleC.id]);
    expect(projection.readyFileIds).not.toContain(moduleC.id);
    expect(projection.edges.map(({ id }) => id)).toContain("imports@m:b|m:c");
    expect(projection.extensions?.prInitialGraph).toBeUndefined();
    expect(projection.extensions?.prPartialGraph).toEqual({
      version: 1,
      graphId: "partial",
      generation: "8".repeat(64),
    });
    expect(recomputeProjectionFrontierReadiness(
      landing,
      projection.frontier.map(({ fileId }) => fileId),
      projection.prefetchDepth,
    )).toEqual({
      frontier: projection.frontier,
      readyFileIds: projection.readyFileIds,
    });

    const expandedArtifact = artifact(
      [packageNode, moduleA, moduleB, moduleC, moduleD],
      [
        edge("imports", moduleA.id, moduleB.id),
        edge("imports", moduleB.id, moduleC.id),
        edge("imports", moduleC.id, moduleD.id),
      ],
      {
        prInitialGraph: {
          version: 1,
          complete: false,
          depth: 2,
          seedFiles: ["src/c.ts"],
          selectedFiles: ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"],
          frontierFiles: ["src/d.ts"],
        },
        prPartialGraph: {
          version: 1,
          graphId: "partial",
          generation: "8".repeat(64),
        },
      },
    );
    const expanded = projectCanonicalGraph({
      artifact: expandedArtifact,
      seedArtifact: expandedArtifact,
      request: filesRequest("partial", [moduleC.id], 1, 3),
      generation: "8".repeat(64),
      loadedDepth: 1,
    });

    expect(expanded.readyFileIds).toContain(moduleC.id);
    expect(expanded.loadedFileIds).toContain(moduleC.id);
    expect(expanded.nodes.find(({ id }) => id === moduleC.id))
      .toEqual(projection.nodes.find(({ id }) => id === moduleC.id));
  });

  it("keeps semantic-only HTTP or RPC visible without blocking selector-owned readiness", () => {
    for (const protocol of ["http", "rpc"]) {
      const exactChannel = node(`ipc:${protocol}/channel=load`, "channel", `(${protocol})`);
      const provisional = artifact(
        [packageNode, moduleA, fnA, moduleB, fnB, exactChannel],
        [
          edge("sends", fnA.id, exactChannel.id),
          edge("handles", exactChannel.id, fnB.id),
        ],
        {
          prInitialGraph: {
            version: 1,
            complete: false,
            depth: 3,
            seedFiles: ["src/a.ts"],
            selectedFiles: ["src/a.ts", "src/b.ts"],
            frontierFiles: [],
          },
        },
      );
      const projection = projectCanonicalGraph({
        artifact: provisional,
        seedArtifact: provisional,
        request: filesRequest("partial", [moduleA.id], 1, 3),
        generation: "9".repeat(64),
        loadedDepth: 3,
      });

      expect(projection.frontier).toEqual([
        { fileId: moduleA.id, hasMore: false, completeThroughDepth: 3 },
      ]);
      expect(projection.readyFileIds).toEqual([moduleA.id]);
      expect(projection.loadedFileIds).toEqual([moduleA.id, moduleB.id]);
      expect(projection.edges.map(({ kind }) => kind)).toEqual(["sends", "handles"]);

      const canonical = projectCanonicalGraph({
        artifact: artifact(provisional.nodes, provisional.edges),
        seedArtifact: provisional,
        request: filesRequest("canonical", [moduleA.id], 1, 3),
        generation: "0".repeat(64),
        loadedDepth: 1,
      });
      expect(canonical.frontier).toEqual([
        { fileId: moduleA.id, hasMore: false, completeThroughDepth: 3 },
        { fileId: moduleB.id, hasMore: false, completeThroughDepth: 3 },
      ]);
      expect(canonical.readyFileIds).toEqual([moduleA.id, moduleB.id]);
    }
  });

  it("continues to trust selector-proven exact Electron adjacency provisionally", () => {
    const exactChannel = node("ipc:electron/channel=load", "channel", "(electron)");
    const provisional = artifact(
      [packageNode, moduleA, fnA, moduleB, fnB, exactChannel],
      [
        edge("sends", fnA.id, exactChannel.id),
        edge("handles", exactChannel.id, fnB.id),
      ],
      {
        prInitialGraph: {
          version: 1,
          complete: false,
          depth: 3,
          seedFiles: ["src/a.ts"],
          selectedFiles: ["src/a.ts", "src/b.ts"],
          frontierFiles: [],
        },
      },
    );
    const projection = projectCanonicalGraph({
      artifact: provisional,
      seedArtifact: provisional,
      request: filesRequest("partial", [moduleA.id], 1, 3),
      generation: "a".repeat(64),
      loadedDepth: 3,
    });

    expect(projection.frontier).toEqual([
      { fileId: moduleA.id, hasMore: false, completeThroughDepth: 3 },
      { fileId: moduleB.id, hasMore: false, completeThroughDepth: 3 },
    ]);
    expect(projection.readyFileIds).toEqual([moduleA.id, moduleB.id]);
  });

  it("rejects malformed server-owned provisional boundary metadata", () => {
    const malformed = artifact(
      [packageNode, moduleA],
      [],
      {
        prInitialGraph: {
          version: 1,
          complete: false,
          depth: 1,
          seedFiles: ["src/a.ts"],
          selectedFiles: ["src/a.ts"],
          frontierFiles: ["src/outside.ts"],
        },
      },
    );

    expect(() => projectCanonicalGraph({
      artifact: malformed,
      seedArtifact: malformed,
      request: filesRequest("partial", [moduleA.id], 1),
      generation: "b".repeat(64),
      loadedDepth: 1,
    })).toThrow("provisional graph boundary metadata is invalid");
  });

  it("retains a touched Promise lifecycle as boundary evidence without traversing endpoint files", () => {
    const promise = node("promise:ready", "promise", "src/b.ts", moduleB.id);
    const unrelatedPromise = node("promise:other", "promise", "src/d.ts", moduleD.id);
    const lifecycle = artifact(
      [packageNode, moduleA, fnA, moduleB, fnB, promise, moduleC, fnC, moduleD, fnD, unrelatedPromise],
      [
        edge("createsPromise", fnB.id, promise.id),
        edge("returnsPromise", fnB.id, promise.id),
        edge("awaitsPromise", fnA.id, promise.id),
        edge("resolvesPromise", fnC.id, promise.id),
        edge("rejectsPromise", fnC.id, promise.id),
        edge("returnsPromise", fnD.id, unrelatedPromise.id),
      ],
    );
    const projection = projectCanonicalGraph({
      artifact: lifecycle,
      seedArtifact: lifecycle,
      request: filesRequest("graph", [moduleA.id], 0),
      generation: "6".repeat(64),
      loadedDepth: 0,
    });

    expect(projection.rootFileIds).toEqual([moduleA.id]);
    expect(projection.frontier).toEqual([
      { fileId: moduleA.id, hasMore: false, completeThroughDepth: 0 },
    ]);
    expect(projection.readyFileIds).toEqual([]);
    expect(projection.loadedFileIds).toEqual([moduleA.id, moduleB.id, moduleC.id]);
    expect(projection.nodes.map(({ id }) => id)).toEqual(expect.arrayContaining([
      fnA.id,
      moduleB.id,
      fnB.id,
      promise.id,
      moduleC.id,
      fnC.id,
    ]));
    expect(projection.nodes.map(({ id }) => id)).not.toEqual(expect.arrayContaining([
      moduleD.id,
      fnD.id,
      unrelatedPromise.id,
    ]));
    expect(projection.edges.map(({ id }) => id)).toEqual([
      `createsPromise@${fnB.id}|${promise.id}`,
      `returnsPromise@${fnB.id}|${promise.id}`,
      `awaitsPromise@${fnA.id}|${promise.id}`,
      `resolvesPromise@${fnC.id}|${promise.id}`,
      `rejectsPromise@${fnC.id}|${promise.id}`,
    ]);
  });

  it("projects repository-wide extensions by represented files while preserving exact review metadata", () => {
    const changedSince = {
      baseRef: "main",
      manifest: [{ path: "src/a.ts", status: "modified" }],
      files: { "src/a.ts": [{ start: 1, end: 2 }] },
    };
    const review = {
      repository: "UiPath/Autopilot",
      number: 42,
      changedFiles: [{ path: "src/a.ts", status: "modified", hunks: [{ start: 1, end: 2 }] }],
    };
    const rootTimeline = { participants: [], rows: [], frames: [], truncated: false };
    const outsideTimeline = { participants: [{ id: "outside" }], rows: [], frames: [] };
    const extended = artifact(
      [packageNode, moduleA, fnA, moduleD, fnD],
      [],
      {
        changedSince,
        review,
        unknownCompatibilityPayload: { keep: [1, 2, 3] },
        entryModules: [moduleA.id, moduleD.id],
        sequenceTimeline: { [fnA.id]: rootTimeline, [fnD.id]: outsideTimeline },
        testExecutionCoverage: {
          version: "1.0.0",
          aggregate: true,
          producer: { inputFormat: "istanbul-coverage-map" },
          files: {
            "src/a.ts": { functions: [], branches: [] },
            "src/d.ts": { functions: [], branches: [] },
            "src/outside.ts": { functions: [], branches: [] },
          },
        },
      },
    );
    const projection = projectCanonicalGraph({
      artifact: extended,
      seedArtifact: extended,
      request: changedRequest("graph", "graph", 0, 1),
      generation: "7".repeat(64),
      loadedDepth: 0,
    });

    expect(projection.extensions?.changedSince).toEqual(changedSince);
    expect(projection.extensions?.review).toEqual(review);
    expect(projection.extensions?.unknownCompatibilityPayload).toEqual({ keep: [1, 2, 3] });
    // The ordered canonical list is small and identical in every projection. Consumers ignore IDs
    // absent from the slice; retaining the whole list preserves first-entry semantics across unions.
    expect(projection.extensions?.entryModules).toEqual([moduleA.id, moduleD.id]);
    expect(projection.extensions?.sequenceTimeline).toEqual({ [fnA.id]: rootTimeline });
    expect(projection.extensions?.testExecutionCoverage).toEqual({
      version: "1.0.0",
      aggregate: true,
      producer: { inputFormat: "istanbul-coverage-map" },
      files: { "src/a.ts": { functions: [], branches: [] } },
    });
  });

  it("makes traversed boundary files actionable only after their relative depth-one context is complete", () => {
    const chain = artifact(
      [packageNode, moduleA, moduleB, moduleC, moduleD],
      [
        edge("imports", moduleA.id, moduleB.id),
        edge("imports", moduleB.id, moduleC.id),
        edge("imports", moduleC.id, moduleD.id),
      ],
    );
    const projection = projectCanonicalGraph({
      artifact: chain,
      seedArtifact: chain,
      request: {
        version: GRAPH_PROJECTION_VERSION,
        graphId: "graph",
        roots: { kind: "files", fileIds: [moduleA.id] },
        requestedDepth: 2,
        prefetchDepth: 3,
      },
      generation: "4".repeat(64),
      loadedDepth: 2,
    });

    expect(projection.frontier).toEqual([
      { fileId: moduleA.id, hasMore: true, completeThroughDepth: 2 },
      { fileId: moduleB.id, hasMore: true, completeThroughDepth: 1 },
      { fileId: moduleC.id, hasMore: true, completeThroughDepth: 0 },
    ]);
    expect(projection.readyFileIds).toEqual([moduleA.id, moduleB.id]);
  });

  it("resolves comparison paths only against canonical modules in the target graph", () => {
    const head = artifact([packageNode, moduleB, fnB], []);
    const projection = projectCanonicalGraph({
      artifact: head,
      seedArtifact: head,
      request: filePathsRequest("head", ["src/b.ts", "src/deleted.ts"], 1, 3),
      generation: "5".repeat(64),
      loadedDepth: 1,
    });

    expect(projection.rootFileIds).toEqual([moduleB.id]);
    expect(projection.readyFileIds).toEqual([moduleB.id]);
    expect(projection.nodes.map(({ id }) => id)).toEqual([packageNode.id, moduleB.id, fnB.id]);
  });

  it("keeps candidate IPC evidence visible without using it as BFS adjacency", () => {
    const candidate = artifact(
      fixture.nodes,
      fixture.edges.map((item) => item.kind === "sends" || item.kind === "handles"
        ? { ...item, resolution: "unresolved" as const, confidence: 0.65 }
        : item),
      fixture.extensions,
    );
    const projection = projectCanonicalGraph({
      artifact: candidate,
      seedArtifact: candidate,
      request: filesRequest("graph", [moduleA.id], 1),
      generation: "2".repeat(64),
      loadedDepth: 1,
    });

    expect(projection.loadedFileIds).toEqual([moduleA.id, moduleB.id, moduleC.id, moduleD.id]);
    expect(projection.nodes.map(({ id }) => id)).not.toContain(fnD2.id);
    expect(projection.edges.map(({ kind }) => kind)).toEqual(expect.arrayContaining(["sends", "handles"]));
  });

  it("maps an exact HEAD manifest onto HEAD and merge-base paths without client paths", () => {
    const seed = artifact(
      [node("head:new", "module", "src/new.ts"), node("head:added", "module", "src/added.ts")],
      [],
      { changedSince: { manifest: [
        { path: "src/new.ts", previousPath: "src/old.ts", status: "renamed" },
        { path: "src/added.ts", status: "added" },
        { path: "src/deleted.ts", status: "deleted" },
      ] } },
    );
    const base = artifact([
      node("base:old", "module", "src/old.ts"),
      node("base:deleted", "module", "src/deleted.ts"),
    ], []);

    const headProjection = projectCanonicalGraph({
      artifact: seed,
      seedArtifact: seed,
      request: changedRequest("head", "head", 0, 0),
      generation: "d".repeat(64),
      loadedDepth: 0,
    });
    expect(headProjection.rootFileIds).toEqual(["head:new", "head:added"]);

    const baseProjection = projectCanonicalGraph({
      artifact: base,
      seedArtifact: seed,
      request: changedRequest("base", "head", 0, 0),
      generation: "e".repeat(64),
      loadedDepth: 0,
    });
    expect(baseProjection.rootFileIds).toEqual(["base:old", "base:deleted"]);
    expect(baseProjection.seedGraphId).toBe("head");
  });

  it("does not advertise another already-rooted file as work beyond the returned frontier", () => {
    const twoFiles = artifact([moduleA, moduleB], [edge("imports", moduleA.id, moduleB.id)]);
    const projection = projectCanonicalGraph({
      artifact: twoFiles,
      seedArtifact: twoFiles,
      request: filesRequest("graph", [moduleA.id, moduleB.id], 0),
      generation: "3".repeat(64),
      loadedDepth: 0,
    });

    expect(projection.frontier).toEqual([
      { fileId: moduleA.id, hasMore: false, completeThroughDepth: 0 },
      { fileId: moduleB.id, hasMore: false, completeThroughDepth: 0 },
    ]);
  });

  it("rejects a non-file explicit root instead of guessing its owner", () => {
    expect(() => projectCanonicalGraph({
      artifact: fixture,
      seedArtifact: fixture,
      request: filesRequest("graph", [fnA.id], 0),
      generation: "f".repeat(64),
      loadedDepth: 0,
    })).toThrow(/not a canonical file node/);
  });

  it("treats a Python package initializer as its canonical file root", () => {
    const pythonPackage = node("py:pkg", "package", "pkg/__init__.py");
    const packageFunction = node("py:pkg#load", "function", "pkg/__init__.py", pythonPackage.id);
    const pythonModule = node("py:pkg.worker", "module", "pkg/worker.py", pythonPackage.id);
    const python = artifact(
      [pythonPackage, packageFunction, pythonModule],
      [edge("imports", pythonPackage.id, pythonModule.id)],
      { changedSince: { manifest: [{ path: "pkg/__init__.py", status: "modified" }] } },
    );
    const projection = projectCanonicalGraph({
      artifact: python,
      seedArtifact: python,
      request: changedRequest("python", "python", 1, 1),
      generation: "4".repeat(64),
      loadedDepth: 1,
    });

    expect(projection.rootFileIds).toEqual([pythonPackage.id]);
    expect(projection.readyFileIds).toEqual([pythonPackage.id, pythonModule.id]);
    expect(projection.loadedFileIds).toEqual([pythonPackage.id, pythonModule.id]);
    expect(indexCanonicalGraphSymbols(python, "python", "4".repeat(64)).symbols)
      .toContainEqual(expect.objectContaining({ id: packageFunction.id, fileId: pythonPackage.id }));
  });

  it("builds the complete deterministic compact symbol index", () => {
    const result = indexCanonicalGraphSymbols(fixture, "graph", "1".repeat(64));
    expect(result.complete).toBe(true);
    expect(result.indexedSymbolCount).toBe(9);
    expect(result.symbols.map(({ id }) => id)).not.toContain(packageNode.id);
    expect(result.symbols.find(({ id }) => id === fnD.id)).toMatchObject({
      fileId: moduleD.id,
      isPrivateMethod: true,
      stepCount: null,
    });
    expect(result.symbols.find(({ id }) => id === fnA.id)?.stepCount).toBe(1);
    expect(result.symbols.map(({ displayName }) => displayName)).toEqual(
      [...result.symbols.map(({ displayName }) => displayName)].sort((a, b) => a.localeCompare(b)),
    );
  });
});

function changedRequest(
  graphId: string,
  seedGraphId: string,
  requestedDepth: number,
  prefetchDepth: number,
): GraphProjectionRequestV1 {
  return {
    version: GRAPH_PROJECTION_VERSION,
    graphId,
    roots: { kind: "changed-files", seedGraphId },
    requestedDepth,
    prefetchDepth,
  };
}

function filesRequest(
  graphId: string,
  fileIds: string[],
  depth: number,
  prefetchDepth = depth,
): GraphProjectionRequestV1 {
  return {
    version: GRAPH_PROJECTION_VERSION,
    graphId,
    roots: { kind: "files", fileIds },
    requestedDepth: depth,
    prefetchDepth,
  };
}

function filePathsRequest(
  graphId: string,
  paths: string[],
  depth: number,
  prefetchDepth: number,
): GraphProjectionRequestV1 {
  return {
    version: GRAPH_PROJECTION_VERSION,
    graphId,
    roots: { kind: "file-paths", paths },
    requestedDepth: depth,
    prefetchDepth,
  };
}

function node(
  id: string,
  kind: string,
  file: string,
  parentId: string | null = null,
  displayName = id,
): GraphNode {
  return { id, kind, qualifiedName: id, displayName, parentId, location: { file, startLine: 1, endLine: 2 } };
}

function edge(kind: string, source: string, target: string): GraphEdge {
  return { id: `${kind}@${source}|${target}`, kind, source, target, resolution: "resolved" };
}

function artifact(
  nodes: GraphNode[],
  edges: GraphEdge[],
  extensions?: Record<string, unknown>,
): GraphArtifact {
  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: "2026-07-31T00:00:00.000Z",
    generator: { name: "test", version: "1" },
    target: { name: "fixture", root: ".", language: "typescript" },
    nodes,
    edges,
    ...(extensions === undefined ? {} : { extensions: extensions as GraphArtifact["extensions"] }),
  };
}
