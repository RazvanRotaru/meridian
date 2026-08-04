import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SCHEMA_VERSION, type GraphArtifact } from "@meridian/core";
import { runGraphProjectChild } from "./web-graph-project-child";
import {
  MAX_GRAPH_PROJECT_OUTPUT_BYTES,
  type GraphProjectWorkerRequest,
} from "./web-graph-project-worker-job";
import { parsePrPartialSourceTopology } from "./web-pr-partial-topology";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("graph projection child", () => {
  it("projects through a disposable source worker and attests the output file", async () => {
    const fixture = setup();
    const request: GraphProjectWorkerRequest = {
      type: "project",
      id: "projection-test",
      graph: fixture.input,
      seedGraph: null,
      generation: fixture.input.sha256,
      projection: {
        version: 1,
        graphId: "graph",
        roots: { kind: "files", fileIds: ["m:a"] },
        requestedDepth: 0,
        prefetchDepth: 2,
      },
      projectionOutputPath: join(fixture.root, "projection.json"),
      projectionOutputMaxBytes: MAX_GRAPH_PROJECT_OUTPUT_BYTES,
      symbolOutputPath: null,
      symbolSourceRoot: null,
      topologyOutputPath: null,
    };

    const result = await runGraphProjectChild(request, { timeoutMs: 30_000 });
    expect(result.projection).toMatchObject({
      nodes: 2,
      files: 1,
      roots: 1,
      completeRoots: 1,
      loadedDepth: 0,
    });
    const projection = JSON.parse(readFileSync(request.projectionOutputPath!, "utf8"));
    expect(projection).toMatchObject({
      version: 1,
      graphId: "graph",
      seedGraphId: "graph",
      generation: fixture.input.sha256,
      requestedDepth: 0,
      prefetchDepth: 2,
      loadedDepth: 0,
      rootFileIds: ["m:a"],
      loadedFileIds: ["m:a"],
    });
  }, 30_000);

  it("merges projection fragments deterministically and dedupes exact replayed payloads", async () => {
    const fixture = setup();
    const project = async (id: string, output: string) => runGraphProjectChild({
      type: "project",
      id,
      graph: fixture.input,
      seedGraph: null,
      generation: fixture.input.sha256,
      projection: {
        version: 1,
        graphId: "graph",
        roots: { kind: "files", fileIds: ["m:a"] },
        requestedDepth: 0,
        prefetchDepth: 2,
      },
      projectionOutputPath: join(fixture.root, output),
      projectionOutputMaxBytes: MAX_GRAPH_PROJECT_OUTPUT_BYTES,
      symbolOutputPath: null,
      symbolSourceRoot: null,
      topologyOutputPath: null,
    }, { timeoutMs: 30_000 });
    const [first, replay] = await Promise.all([
      project("projection-first", "first.json"),
      project("projection-replay", "replay.json"),
    ]);
    const inputs = [first, replay].map(({ projection }) => ({
      path: projection!.path,
      bytes: projection!.bytes,
      sha256: projection!.sha256,
    }));
    const merge = (id: string, output: string, projectionInputs: typeof inputs) =>
      runGraphProjectChild({
        type: "merge",
        id,
        graph: fixture.input,
        seedGraph: null,
        generation: fixture.input.sha256,
        projection: {
          version: 1,
          graphId: "graph",
          roots: { kind: "changed-files", seedGraphId: "seed" },
          requestedDepth: 0,
          prefetchDepth: 2,
        },
        projectionOutputPath: join(fixture.root, output),
        projectionOutputMaxBytes: MAX_GRAPH_PROJECT_OUTPUT_BYTES,
        symbolOutputPath: null,
        symbolSourceRoot: null,
        topologyOutputPath: null,
        projectionInputs,
      }, { timeoutMs: 30_000 });

    const forward = await merge("projection-merge-forward", "forward.json", inputs);
    const reverse = await merge("projection-merge-reverse", "reverse.json", [...inputs].reverse());

    expect(forward.projection).toMatchObject({ nodes: 2, edges: 0, files: 1, roots: 1, completeRoots: 1 });
    expect(reverse.projection).toMatchObject({ nodes: 2, edges: 0, files: 1, roots: 1, completeRoots: 1 });
    expect(readFileSync(forward.projection!.path, "utf8"))
      .toBe(readFileSync(reverse.projection!.path, "utf8"));
    expect(JSON.parse(readFileSync(forward.projection!.path, "utf8"))).toMatchObject({
      graphId: "graph",
      seedGraphId: "seed",
      rootFileIds: ["m:a"],
      readyFileIds: ["m:a"],
      counts: { slice: { nodes: 2, edges: 0, files: 1 } },
    });
  }, 30_000);

  it("recomputes a frontier closed only by the union of overlapping root shards", async () => {
    const fixture = setupArtifact({
      schemaVersion: SCHEMA_VERSION,
      generatedAt: "2026-07-31T00:00:00.000Z",
      generator: { name: "test", version: "1" },
      target: { name: "fixture", root: ".", language: "typescript" },
      // Keep canonical artifact order identical to binary ID order so the complete projection can
      // be compared byte-for-byte after the merge's deterministic canonical unions.
      nodes: [
        { id: "m:a", kind: "module", qualifiedName: "a", displayName: "a", location: { file: "a.ts", startLine: 1 } },
        { id: "m:b", kind: "module", qualifiedName: "b", displayName: "b", location: { file: "b.ts", startLine: 1 } },
        { id: "m:x", kind: "module", qualifiedName: "x", displayName: "x", location: { file: "x.ts", startLine: 1 } },
      ],
      edges: [
        { id: "imports@m:a|m:x", kind: "imports", source: "m:a", target: "m:x", resolution: "resolved" },
        { id: "imports@m:x|m:b", kind: "imports", source: "m:x", target: "m:b", resolution: "resolved" },
      ],
      extensions: {
        changedSince: { manifest: [
          { path: "a.ts", status: "modified" },
          { path: "b.ts", status: "modified" },
        ] },
      },
    });
    const projectRoot = (rootFileId: string, id: string) => runGraphProjectChild({
      type: "project",
      id,
      graph: fixture.input,
      seedGraph: null,
      generation: fixture.input.sha256,
      projection: {
        version: 1,
        graphId: "graph",
        roots: { kind: "files", fileIds: [rootFileId] },
        requestedDepth: 1,
        prefetchDepth: 2,
      },
      projectionOutputPath: join(fixture.root, `${id}.json`),
      projectionOutputMaxBytes: MAX_GRAPH_PROJECT_OUTPUT_BYTES,
      symbolOutputPath: null,
      symbolSourceRoot: null,
      topologyOutputPath: null,
    }, { timeoutMs: 30_000 });
    const [fromA, fromB] = await Promise.all([
      projectRoot("m:a", "projection-from-a"),
      projectRoot("m:b", "projection-from-b"),
    ]);
    const projectionInputs = [fromA, fromB].map(({ projection }) => ({
      path: projection!.path,
      bytes: projection!.bytes,
      sha256: projection!.sha256,
    }));
    const merged = await runGraphProjectChild({
      type: "merge",
      id: "projection-overlap-merge",
      graph: fixture.input,
      seedGraph: null,
      generation: fixture.input.sha256,
      projection: {
        version: 1,
        graphId: "graph",
        roots: { kind: "changed-files", seedGraphId: "graph" },
        requestedDepth: 1,
        prefetchDepth: 2,
      },
      projectionOutputPath: join(fixture.root, "overlap-merged.json"),
      projectionOutputMaxBytes: MAX_GRAPH_PROJECT_OUTPUT_BYTES,
      symbolOutputPath: null,
      symbolSourceRoot: null,
      topologyOutputPath: null,
      projectionInputs,
    }, { timeoutMs: 30_000 });
    const direct = await runGraphProjectChild({
      type: "project",
      id: "projection-overlap-direct",
      graph: fixture.input,
      seedGraph: fixture.input,
      generation: fixture.input.sha256,
      projection: {
        version: 1,
        graphId: "graph",
        roots: { kind: "changed-files", seedGraphId: "graph" },
        requestedDepth: 1,
        prefetchDepth: 2,
      },
      projectionOutputPath: join(fixture.root, "overlap-direct.json"),
      projectionOutputMaxBytes: MAX_GRAPH_PROJECT_OUTPUT_BYTES,
      symbolOutputPath: null,
      symbolSourceRoot: null,
      topologyOutputPath: null,
    }, { timeoutMs: 30_000 });

    const mergedProjection = JSON.parse(readFileSync(merged.projection!.path, "utf8"));
    const directProjection = JSON.parse(readFileSync(direct.projection!.path, "utf8"));
    expect(mergedProjection).toEqual(directProjection);
    expect(mergedProjection.frontier).toEqual([
      { fileId: "m:a", hasMore: false, completeThroughDepth: 2 },
      { fileId: "m:b", hasMore: false, completeThroughDepth: 2 },
      { fileId: "m:x", hasMore: false, completeThroughDepth: 2 },
    ]);
    expect(mergedProjection.readyFileIds).toEqual(["m:a", "m:b", "m:x"]);
  }, 30_000);

  it("indexes symbols independently so projection readiness never waits on it", async () => {
    const fixture = setup();
    const request: GraphProjectWorkerRequest = {
      type: "symbols",
      id: "symbols-test",
      graph: fixture.input,
      seedGraph: null,
      generation: fixture.input.sha256,
      projection: null,
      projectionOutputPath: null,
      projectionOutputMaxBytes: null,
      symbolOutputPath: join(fixture.root, "symbols.json"),
      symbolSourceRoot: null,
      topologyOutputPath: null,
    };
    const result = await runGraphProjectChild(request, { timeoutMs: 30_000 });
    expect(result.symbols?.count).toBe(2);
    const symbols = JSON.parse(readFileSync(request.symbolOutputPath!, "utf8"));
    expect(symbols).toMatchObject({ complete: true, indexedSymbolCount: 2, totalSymbolCount: 2 });
  }, 30_000);

  it("indexes exact-revision source symbols and topology without a canonical graph", async () => {
    const fixture = setup({
      prInitialGraph: {
        version: 1,
        complete: false,
        depth: 1,
        seedFiles: ["src/a.ts"],
        selectedFiles: ["src/a.ts"],
        frontierFiles: [],
      },
    });
    const sourceRoot = join(fixture.root, "source");
    mkdirSync(join(sourceRoot, "src"), { recursive: true });
    writeFileSync(join(sourceRoot, "src", "a.ts"), "export function disconnected(): void {}\n");
    const request: GraphProjectWorkerRequest = {
      type: "symbols",
      id: "source-symbols-test",
      graph: fixture.input,
      seedGraph: null,
      generation: fixture.input.sha256,
      projection: null,
      projectionOutputPath: null,
      projectionOutputMaxBytes: null,
      symbolOutputPath: join(fixture.root, "source-symbols.json"),
      symbolSourceRoot: sourceRoot,
      topologyOutputPath: join(fixture.root, "source-topology.json"),
    };
    const result = await runGraphProjectChild(request, { timeoutMs: 30_000 });
    expect(result).toMatchObject({
      symbols: { count: 2 },
      topology: { files: 1, adjacencyEntries: 0 },
    });
    const symbols = JSON.parse(readFileSync(request.symbolOutputPath!, "utf8"));
    expect(symbols.symbols).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "ts:src/a.ts#disconnected", fileId: "ts:src/a.ts" }),
    ]));
    const topology = parsePrPartialSourceTopology(
      JSON.parse(readFileSync(request.topologyOutputPath!, "utf8")),
      { graphId: "graph", generation: fixture.input.sha256 },
    );
    expect(topology).toMatchObject({
      seeds: ["src/a.ts"],
      files: [{ path: "src/a.ts", fileId: "ts:src/a.ts", neighbors: [], uncertain: false }],
    });
  }, 30_000);

  it("indexes a mixed TypeScript/Python revision into one bounded topology", async () => {
    const fixture = setup({
      prInitialGraph: {
        version: 1,
        complete: false,
        depth: 1,
        seedFiles: ["src/a.ts", "worker/job.py"],
        selectedFiles: ["src/a.ts", "worker/job.py"],
        frontierFiles: [],
      },
    });
    const sourceRoot = join(fixture.root, "mixed-source");
    mkdirSync(join(sourceRoot, "src"), { recursive: true });
    mkdirSync(join(sourceRoot, "worker"), { recursive: true });
    writeFileSync(join(sourceRoot, "src", "a.ts"), "export function typescriptSymbol(): void {}\n");
    writeFileSync(join(sourceRoot, "worker", "job.py"), "from .helper import help\ndef run():\n    help()\n");
    writeFileSync(join(sourceRoot, "worker", "helper.py"), "def help():\n    pass\n");
    const request: GraphProjectWorkerRequest = {
      type: "symbols",
      id: "mixed-source-symbols-test",
      graph: fixture.input,
      seedGraph: null,
      generation: fixture.input.sha256,
      projection: null,
      projectionOutputPath: null,
      projectionOutputMaxBytes: null,
      symbolOutputPath: join(fixture.root, "mixed-symbols.json"),
      symbolSourceRoot: sourceRoot,
      topologyOutputPath: join(fixture.root, "mixed-topology.json"),
    };

    const result = await runGraphProjectChild(request, { timeoutMs: 30_000 });
    expect(result).toMatchObject({
      symbols: { count: 6 },
      topology: { files: 3, adjacencyEntries: 2 },
    });
    const symbols = JSON.parse(readFileSync(request.symbolOutputPath!, "utf8"));
    expect(symbols.symbols).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "ts:src/a.ts#typescriptSymbol", fileId: "ts:src/a.ts" }),
      expect.objectContaining({ id: "py:worker.job#run", fileId: "py:worker.job" }),
      expect.objectContaining({ id: "py:worker.helper#help", fileId: "py:worker.helper" }),
    ]));
    const topology = parsePrPartialSourceTopology(
      JSON.parse(readFileSync(request.topologyOutputPath!, "utf8")),
      { graphId: "graph", generation: fixture.input.sha256 },
    );
    expect(topology.seeds).toEqual(["src/a.ts", "worker/job.py"]);
    expect(topology.files.find(({ path }) => path === "worker/job.py")?.neighbors)
      .toEqual(["py:worker.helper"]);
  }, 30_000);

  it("canonicalizes merged TypeScript and Python topology in shared UTF-16 binary order", async () => {
    const childOrder = [
      "src/Z.ts",
      "src/a.ts",
      "src/é.ts",
      "\uE000.py",
      "😀.py",
    ];
    const canonical = [
      "src/Z.ts",
      "src/a.ts",
      "src/é.ts",
      "😀.py",
      "\uE000.py",
    ];
    const fixture = setup({
      prInitialGraph: {
        version: 1,
        complete: false,
        depth: 1,
        seedFiles: childOrder,
        selectedFiles: childOrder,
        frontierFiles: [],
      },
    });
    const sourceRoot = join(fixture.root, "ordered-mixed-source");
    mkdirSync(join(sourceRoot, "src"), { recursive: true });
    for (const path of childOrder) {
      const source = path.endsWith(".py") ? "pass\n" : "export {};\n";
      writeFileSync(join(sourceRoot, path), source);
    }
    const request: GraphProjectWorkerRequest = {
      type: "symbols",
      id: "ordered-mixed-symbols-test",
      graph: fixture.input,
      seedGraph: null,
      generation: fixture.input.sha256,
      projection: null,
      projectionOutputPath: null,
      projectionOutputMaxBytes: null,
      symbolOutputPath: join(fixture.root, "ordered-mixed-symbols.json"),
      symbolSourceRoot: sourceRoot,
      topologyOutputPath: join(fixture.root, "ordered-mixed-topology.json"),
    };

    await runGraphProjectChild(request, { timeoutMs: 30_000 });
    const topology = JSON.parse(readFileSync(request.topologyOutputPath!, "utf8"));

    expect(topology.seeds).toEqual(canonical);
    expect(topology.files.map((file: { path: string }) => file.path)).toEqual(canonical);
  }, 30_000);

  it("retains a root generation only for a slice carrying exact partial-graph lineage", async () => {
    const logicalGeneration = "f".repeat(64);
    const fixture = setup({
      prPartialGraph: { version: 1, graphId: "graph", generation: logicalGeneration },
    });
    const request: GraphProjectWorkerRequest = {
      type: "project",
      id: "partial-lineage-test",
      graph: fixture.input,
      seedGraph: null,
      generation: logicalGeneration,
      projection: {
        version: 1,
        graphId: "graph",
        roots: { kind: "files", fileIds: ["m:a"] },
        requestedDepth: 0,
        prefetchDepth: 0,
      },
      projectionOutputPath: join(fixture.root, "partial-projection.json"),
      projectionOutputMaxBytes: MAX_GRAPH_PROJECT_OUTPUT_BYTES,
      symbolOutputPath: null,
      symbolSourceRoot: null,
      topologyOutputPath: null,
    };

    await expect(runGraphProjectChild(request, { timeoutMs: 30_000 })).resolves.toMatchObject({
      generation: logicalGeneration,
    });

    const unproven = setup();
    await expect(runGraphProjectChild({
      ...request,
      graph: unproven.input,
      projectionOutputPath: join(unproven.root, "unproven.json"),
    }, { timeoutMs: 30_000 })).rejects.toThrow(/lineage/);
  }, 30_000);

  it("honours cancellation before forking and leaves no output", async () => {
    const fixture = setup();
    const controller = new AbortController();
    const reason = new Error("cancel projection");
    controller.abort(reason);
    await expect(runGraphProjectChild({
      type: "symbols",
      id: "cancel-test",
      graph: fixture.input,
      seedGraph: null,
      generation: fixture.input.sha256,
      projection: null,
      projectionOutputPath: null,
      projectionOutputMaxBytes: null,
      symbolOutputPath: join(fixture.root, "cancelled.json"),
      symbolSourceRoot: null,
      topologyOutputPath: null,
    }, { signal: controller.signal })).rejects.toBe(reason);
  });

  it("terminates and reaps an active worker on cancellation without publishing partial output", async () => {
    const fixture = setup();
    const outputPath = join(fixture.root, "cancelled-active.json");
    const startedPath = join(fixture.root, "active-worker.pid");
    const workerPath = join(fixture.root, "blocking-graph-project-worker.mjs");
    writeFileSync(workerPath, [
      'import { writeFileSync } from "node:fs";',
      'process.once("message", (request) => {',
      `  writeFileSync(request.symbolOutputPath, "partial-output");`,
      `  writeFileSync(${JSON.stringify(startedPath)}, String(process.pid));`,
      "  setInterval(() => {}, 1_000);",
      "});",
      "",
    ].join("\n"));
    const controller = new AbortController();
    const reason = new Error("cancel active projection");
    const running = runGraphProjectChild({
      type: "symbols",
      id: "active-cancel-test",
      graph: fixture.input,
      seedGraph: null,
      generation: fixture.input.sha256,
      projection: null,
      projectionOutputPath: null,
      projectionOutputMaxBytes: null,
      symbolOutputPath: outputPath,
      symbolSourceRoot: null,
      topologyOutputPath: null,
    }, {
      signal: controller.signal,
      timeoutMs: 30_000,
      workerEntry: workerPath,
      workerExecArgv: [],
    });
    // Attach the rejection handler immediately while still allowing the worker to reach its
    // observable started state before cancellation. Vitest's deferred `.rejects` proxy is not
    // considered awaited until later and can otherwise hide an early unhandled rejection.
    const rejected = running.then(
      () => { throw new Error("expected the active projection worker to reject on cancellation"); },
      (error) => { expect(error).toBe(reason); },
    );

    // The complete CLI suite forks many child-process fixtures in parallel. Give this deliberately
    // blocked worker enough time to receive its first IPC message under that load; the production
    // timeout remains the independent 30-second fail-safe above.
    await vi.waitFor(
      () => expect(existsSync(startedPath)).toBe(true),
      { timeout: 10_000 },
    );
    const childPid = Number(readFileSync(startedPath, "utf8"));
    expect(Number.isSafeInteger(childPid) && childPid > 0).toBe(true);
    expect(processIsAlive(childPid)).toBe(true);
    expect(existsSync(outputPath)).toBe(true);

    controller.abort(reason);
    await rejected;
    expect(existsSync(outputPath)).toBe(false);
    await vi.waitFor(
      () => expect(processIsAlive(childPid)).toBe(false),
      { timeout: 5_000 },
    );
  }, 30_000);
});

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EPERM") return true;
    if (code === "ESRCH") return false;
    throw error;
  }
}

function setup(extraExtensions: Record<string, unknown> = {}): {
  root: string;
  input: { graphId: string; path: string; bytes: number; sha256: string };
} {
  const artifact: GraphArtifact = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: "2026-07-31T00:00:00.000Z",
    generator: { name: "test", version: "1" },
    target: { name: "fixture", root: ".", language: "typescript" },
    nodes: [
      { id: "m:a", kind: "module", qualifiedName: "a", displayName: "a", location: { file: "a.ts", startLine: 1 } },
      { id: "fn:a", kind: "function", qualifiedName: "a.fn", displayName: "fn", parentId: "m:a", location: { file: "a.ts", startLine: 1 } },
    ],
    edges: [],
    extensions: { logicFlow: { "fn:a": [] }, ...extraExtensions },
  };
  return setupArtifact(artifact);
}

function setupArtifact(artifact: GraphArtifact): {
  root: string;
  input: { graphId: string; path: string; bytes: number; sha256: string };
} {
  const root = mkdtempSync(join(tmpdir(), "meridian-graph-project-child-test-"));
  roots.push(root);
  const path = join(root, "artifact.json");
  const bytes = Buffer.from(`${JSON.stringify(artifact)}\n`);
  writeFileSync(path, bytes);
  return {
    root,
    input: {
      graphId: "graph",
      path,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
  };
}
