import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SCHEMA_VERSION, type GraphArtifact } from "@meridian/core";
import { GraphCapabilityStore } from "./graph-capability-store";
import {
  GRAPH_PROJECTION_DIRECTORY,
  writeGraphProjectionBundle,
} from "./graph-projection-bundle";
import { measureGraphProjectionBundle } from "./graph-generation-verifier";
import { GraphGenerationLifecycle } from "./graph-generation-lifecycle";
import { OwnershipCleanupError } from "./ownership-cleanup";
import {
  graphGenerationStagingRoot,
  localArtifactGenerations,
  parseGraphGenerationStagePath,
} from "./graph-cache-layout";
import { generateGraph } from "./web-generation";
import type { Context } from "./web-server";
import { removeEntry } from "./web-cache-storage";
import type { CachedGraph } from "./web-cache";

const remoteCacheHarness = vi.hoisted(() => ({
  implementation: undefined as undefined | ((inputs: unknown) => Promise<CachedGraph>),
}));

vi.mock("./web-cache", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./web-cache")>();
  return {
    ...actual,
    cachedRemoteGraph: (inputs: Parameters<typeof actual.cachedRemoteGraph>[0]) => (
      remoteCacheHarness.implementation
        ? remoteCacheHarness.implementation(inputs)
        : actual.cachedRemoteGraph(inputs)
    ),
  };
});

describe("local graph generation", () => {
  let root: string;
  let cacheRoot: string;
  let sourceRoot: string;

  beforeEach(() => {
    remoteCacheHarness.implementation = undefined;
    root = realpathSync(mkdtempSync(join(tmpdir(), "meridian-local-generation-")));
    cacheRoot = join(root, "cache");
    sourceRoot = join(root, "project");
    mkdirSync(sourceRoot, { recursive: true });
    writeFileSync(join(sourceRoot, "index.ts"), "export const ready = true;\n");
  });

  afterEach(() => {
    removeEntry(root);
  });

  it("reuses an exact deterministic immutable generation and capability", async () => {
    const graphCapabilities = new GraphCapabilityStore({
      cacheRoot,
      repositoryMirrors: {
        retainSource: async () => true,
        releaseSource: async () => {},
      },
    });
    const artifact: GraphArtifact = {
      schemaVersion: SCHEMA_VERSION,
      generatedAt: "2026-07-17T00:00:00.000Z",
      generator: { name: "meridian", version: "test" },
      target: { name: "project", root: ".", language: "typescript" },
      nodes: [],
      edges: [],
    };
    const runExtraction = vi.fn<Context["runExtraction"]>(async (_request, options) => {
      const serialized = `${JSON.stringify(artifact)}\n`;
      mkdirSync(dirname(options.artifactOutputPath), { recursive: true });
      writeFileSync(options.artifactOutputPath, serialized);
      const projectionDirectory = join(dirname(options.artifactOutputPath), GRAPH_PROJECTION_DIRECTORY);
      const manifest = writeGraphProjectionBundle(projectionDirectory, artifact);
      const projection = await measureGraphProjectionBundle(projectionDirectory, cacheRoot);
      return {
        kind: "file",
        artifactPath: options.artifactOutputPath,
        artifactBytes: Buffer.byteLength(serialized),
        artifactSha256: createHash("sha256").update(serialized).digest("hex"),
        projectionDirectory,
        ...projection,
        projectionContentId: manifest.contentId,
        graphSummary: manifest.graphSummary,
        changedFiles: [],
        hintedFiles: [],
        warnings: [],
      };
    });
    const context = {
      cwd: root,
      cacheRoot,
      graphCapabilities,
      graphGenerationLifecycle: new GraphGenerationLifecycle({ cacheRoot }),
      graphGenerationMaintenance: { notePublication: vi.fn() },
      runExtraction,
    } as unknown as Context;

    const first = await generateGraph(context, { kind: "path", value: sourceRoot }, undefined);
    const generationsRoot = localArtifactGenerations(cacheRoot);
    const generationsAfterFirst = readdirSync(generationsRoot);
    expect(generationsAfterFirst).toHaveLength(1);
    const generationDirectory = join(generationsRoot, generationsAfterFirst[0]!);
    const firstGenerationInode = lstatSync(generationDirectory).ino;
    const firstArtifact = readFileSync(join(generationDirectory, "artifact.json"));

    const second = await generateGraph(context, { kind: "path", value: sourceRoot }, undefined);

    expect(second.id).toBe(first.id);
    expect(runExtraction).toHaveBeenCalledTimes(2);
    expect(readdirSync(generationsRoot)).toEqual(generationsAfterFirst);
    expect(lstatSync(generationDirectory).ino).toBe(firstGenerationInode);
    expect(readFileSync(join(generationDirectory, "artifact.json"))).toEqual(firstArtifact);
    expect(readdirSync(graphGenerationStagingRoot(cacheRoot))).toEqual([]);
    expect(context.graphGenerationMaintenance.notePublication).toHaveBeenCalledTimes(1);
    for (const [, options] of runExtraction.mock.calls) {
      expect(parseGraphGenerationStagePath(cacheRoot, dirname(options.artifactOutputPath))).not.toBeNull();
    }
    const handle = await graphCapabilities.acquire(first.id);
    expect(handle?.descriptor.artifact.revision).toEqual({
      kind: "content",
      contentId: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(handle?.descriptor.source).toMatchObject({
      kind: "external-local",
      canonicalRoot: sourceRoot,
    });
    await handle?.release();
  });

  it("releases its exact mutable stage when extraction fails", async () => {
    const graphCapabilities = new GraphCapabilityStore({
      cacheRoot,
      repositoryMirrors: {
        retainSource: async () => true,
        releaseSource: async () => {},
      },
    });
    const context = {
      cwd: root,
      cacheRoot,
      graphCapabilities,
      graphGenerationLifecycle: new GraphGenerationLifecycle({ cacheRoot }),
      graphGenerationMaintenance: { notePublication: vi.fn() },
      runExtraction: vi.fn<Context["runExtraction"]>(async () => {
        throw new Error("local extraction failed");
      }),
    } as unknown as Context;

    await expect(generateGraph(
      context,
      { kind: "path", value: sourceRoot },
      undefined,
    )).rejects.toThrow("local extraction failed");

    expect(readdirSync(graphGenerationStagingRoot(cacheRoot))).toEqual([]);
    const generationsRoot = localArtifactGenerations(cacheRoot);
    expect(existsSync(generationsRoot) ? readdirSync(generationsRoot) : []).toEqual([]);
  });

  it("surfaces generation and source release failures after successful remote publication", async () => {
    const generationError = new Error("generation release failed");
    const sourceError = new Error("source release failed");
    const order: string[] = [];
    const cached = remoteCachedGraph(
      async () => { order.push("generation release"); throw generationError; },
      async () => { order.push("source release"); throw sourceError; },
    );
    remoteCacheHarness.implementation = async () => cached;
    const context = remoteContext(async () => { order.push("publish"); });

    const outcome = await generateGraph(
      context,
      { kind: "github", value: "owner/repo" },
      undefined,
    ).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(order).toEqual(["publish", "generation release", "source release"]);
    expect(outcome).toBeInstanceOf(OwnershipCleanupError);
    expect((outcome as OwnershipCleanupError).errors).toEqual([generationError, sourceError]);
  });

  it("keeps a falsy publication failure first when both remote ownership releases fail", async () => {
    const generationError = new Error("generation release failed");
    const sourceError = new Error("source release failed");
    remoteCacheHarness.implementation = async () => remoteCachedGraph(
      async () => { throw generationError; },
      async () => { throw sourceError; },
    );
    const context = remoteContext(async () => { throw 0; });

    const outcome = await generateGraph(
      context,
      { kind: "github", value: "owner/repo" },
      undefined,
    ).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(outcome).toBeInstanceOf(OwnershipCleanupError);
    expect((outcome as OwnershipCleanupError).errors).toEqual([0, generationError, sourceError]);
  });
});

function remoteCachedGraph(
  releaseGeneration: () => Promise<void>,
  releaseSource: () => Promise<void>,
): CachedGraph {
  return {
    analysisKey: "analysis",
    artifactPath: "/cache/artifact.json",
    projectionDirectory: "/cache/projection",
    graphSummary: {
      schemaVersion: SCHEMA_VERSION,
      generatedAt: "2026-07-17T00:00:00.000Z",
      nodeCount: 1,
      edgeCount: 2,
    },
    verifiedGeneration: {} as CachedGraph["verifiedGeneration"],
    generationLease: { release: releaseGeneration } as CachedGraph["generationLease"],
    cache: "hit",
    checkout: {
      cache: "hit",
      commit: "a".repeat(40),
      repoDir: "/cache/source",
      repositoryKey: "repository",
      remoteUrl: "https://github.com/owner/repo.git",
      sourceLease: { repositoryDigest: "b".repeat(64), leaseId: "c".repeat(64) },
      sourceOperation: { release: releaseSource } as CachedGraph["checkout"]["sourceOperation"],
    },
    sourceDir: "/cache/source",
    generationId: "generation",
    target: "owner/repo",
    warnings: [],
  };
}

function remoteContext(publish: () => Promise<void>): Context {
  return {
    cwd: "/workspace",
    cacheRoot: "/cache",
    refreshCache: false,
    repositoryMirrors: {},
    runExtraction: vi.fn(),
    graphGenerationLifecycle: {},
    graphGenerationMaintenance: { notePublication: vi.fn() },
    graphCapabilities: { publish: vi.fn(publish) },
  } as unknown as Context;
}
