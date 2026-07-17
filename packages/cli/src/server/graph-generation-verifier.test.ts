import { createHash } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SCHEMA_VERSION, type GraphArtifact } from "@meridian/core";
import { GRAPH_PROJECTION_DIRECTORY, writeGraphProjectionBundle } from "./graph-projection-bundle";
import { removeEntry } from "./web-cache-storage";
import {
  freezeGraphGenerationDirectory,
  graphGenerationVerificationStats,
  isSealedGraphGenerationStage,
  isVerifiedGraphGeneration,
  measureGraphProjectionBundle,
  sealGraphGeneration,
  verifyGraphGeneration,
  type SealedGraphGenerationStage,
  type VerifyGraphGenerationInput,
} from "./graph-generation-verifier";
import { GraphGenerationLifecycle } from "./graph-generation-lifecycle";
import {
  finalizedGenerationDirectory,
  repositoryArtifactEntry,
} from "./graph-cache-layout";

const COMMIT = "a".repeat(40);
const REPOSITORY_KEY = "b".repeat(24);
const ANALYSIS_KEY = "c".repeat(24);
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) removeEntry(root);
});

describe("graph generation seal", () => {
  it("does not stream artifact or projection content on warm verification", async () => {
    const generation = await publishedGeneration();
    const streamsAfterPublication = graphGenerationVerificationStats().fullContentHashStreams;

    await expect(verifyGraphGeneration(generation.input)).resolves.toMatchObject({
      revision: { kind: "git", commit: COMMIT },
    });
    await expect(verifyGraphGeneration(generation.input)).resolves.toMatchObject({
      revision: { kind: "git", commit: COMMIT },
    });

    expect(graphGenerationVerificationStats().fullContentHashStreams).toBe(streamsAfterPublication);
  });

  it("does not brand a sealed mutable stage as a finalized generation", async () => {
    const generation = await publishedGeneration();

    expect(isSealedGraphGenerationStage(generation.sealedStage)).toBe(true);
    expect(isVerifiedGraphGeneration(generation.sealedStage)).toBe(false);
    const finalized = await verifyGraphGeneration(generation.input);
    expect(isVerifiedGraphGeneration(finalized)).toBe(true);
    expect(isSealedGraphGenerationStage(finalized)).toBe(false);
  });

  it("rejects bytes replaced after hashing instead of sealing the replacement identity", async () => {
    await expect(sealedGeneration({
      afterTrustedContentHash: (artifactPath) => mutateSameSize(artifactPath),
    })).rejects.toThrow(/changed after its trusted content hash/);
  });

  it("freezes the sealed stage and rejects a mutation raced after its publication rename", async () => {
    const staged = await sealedGeneration({
      lifecycleFactory: (root) => new GraphGenerationLifecycle({
        cacheRoot: root,
        afterStagePublicationMove: (destination) => mutateSameSize(join(destination, "artifact.json")),
      }),
    });
    expect(lstatSync(staged.stageHandle.directory).mode & 0o777).toBe(0o500);
    const lease = await staged.lifecycle.acquire(staged.published, {
      purpose: "publication",
      allowMissing: true,
    });

    await expect(staged.stageHandle.publish(lease)).rejects.toThrow(/changed after publication/);

    expect(() => lstatSync(staged.published)).toThrow();
    await staged.stageHandle.release();
    await lease.release();
  });

  it("rejects a sealed-stage replacement before the publication rename", async () => {
    const staged = await sealedGeneration();
    chmodSync(staged.stageHandle.directory, 0o700);
    mutateSameSize(join(staged.stageHandle.directory, "artifact.json"));
    chmodSync(staged.stageHandle.directory, 0o500);
    const lease = await staged.lifecycle.acquire(staged.published, {
      purpose: "publication",
      allowMissing: true,
    });

    await expect(staged.stageHandle.publish(lease)).rejects.toThrow(/changed after publication/);
    expect(() => lstatSync(staged.published)).toThrow();

    await staged.stageHandle.release();
    await lease.release();
  });

  it("snapshots and freezes graph summaries at both nominal boundaries", async () => {
    const generation = await publishedGeneration();
    const originalNodeCount = generation.sealedStage.graphSummary.nodeCount;

    (generation.sourceSummary as { nodeCount: number }).nodeCount = originalNodeCount + 99;
    expect(generation.sealedStage.graphSummary.nodeCount).toBe(originalNodeCount);
    expect(Object.isFrozen(generation.sealedStage.graphSummary)).toBe(true);

    const finalized = await verifyGraphGeneration(generation.input);
    expect(finalized.graphSummary.nodeCount).toBe(originalNodeCount);
    expect(Object.isFrozen(finalized.graphSummary)).toBe(true);
    expect(() => {
      (finalized.graphSummary as { nodeCount: number }).nodeCount = originalNodeCount + 1;
    }).toThrow();
  });

  it("evicts verified seals by resident byte weight as well as entry count", async () => {
    const first = await publishedGeneration();
    const second = await publishedGeneration();
    const firstInput = addSealPadding(first.input, 1_100_000);
    const secondInput = addSealPadding(second.input, 1_100_000);
    const readsBefore = graphGenerationVerificationStats().sealFileReads;

    await verifyGraphGeneration(firstInput);
    await verifyGraphGeneration(secondInput);
    expect(graphGenerationVerificationStats().sealFileReads).toBe(readsBefore + 2);

    // Two parsed ~2.2 MiB seals cannot coexist inside the 4 MiB resident ceiling.
    await verifyGraphGeneration(firstInput);
    const stats = graphGenerationVerificationStats();
    expect(stats.sealFileReads).toBe(readsBefore + 3);
    expect(stats.verifiedSealBytes).toBeLessThanOrEqual(stats.maxVerifiedSealBytes);
    expect(stats.verifiedSealEntries).toBeLessThanOrEqual(128);
  });

  it("rejects a same-size projection shard modification without trusting an unchanged manifest", async () => {
    const generation = await publishedGeneration();
    await verifyGraphGeneration(generation.input);
    const shard = firstProjectionFile(generation.input.projectionDirectory);
    mutateSameSize(shard);

    await expect(verifyGraphGeneration(generation.input)).rejects.toThrow(/changed after publication/);
  });

  it("rejects same-size artifact corruption and a post-seal extra file", async () => {
    const corrupted = await publishedGeneration();
    await verifyGraphGeneration(corrupted.input);
    mutateSameSize(corrupted.input.artifactPath);
    await expect(verifyGraphGeneration(corrupted.input)).rejects.toThrow(/changed after publication/);

    const extra = await publishedGeneration();
    chmodSync(dirname(extra.input.artifactPath), 0o700);
    writeFileSync(join(dirname(extra.input.artifactPath), "unsealed.json"), "{}\n", { mode: 0o400 });
    await expect(verifyGraphGeneration(extra.input)).rejects.toThrow(/unsealed file/);
  });

  it("rejects artifact and projection symlinks before reading outside the cache root", async () => {
    const root = temporaryRoot();
    const outside = temporaryRoot();
    const lifecycle = new GraphGenerationLifecycle({ cacheRoot: root });
    const stageHandle = await lifecycle.reserveStage();
    const stage = stageHandle.directory;
    const projection = join(stage, GRAPH_PROJECTION_DIRECTORY);
    const artifact = artifactFor();
    const serialized = JSON.stringify(artifact);
    const outsideArtifact = join(outside, "artifact.json");
    writeFileSync(outsideArtifact, serialized);
    symlinkSync(outsideArtifact, join(stage, "artifact.json"));
    const manifest = writeGraphProjectionBundle(projection, artifact);
    const projectionIntegrity = await measureGraphProjectionBundle(projection, root);

    await expect(sealGraphGeneration({
      cacheRoot: root,
      stage: stageHandle,
      artifactPath: join(stage, "artifact.json"),
      projectionDirectory: projection,
      artifactBytes: Buffer.byteLength(serialized),
      artifactSha256: createHash("sha256").update(serialized).digest("hex"),
      ...projectionIntegrity,
      projectionContentId: manifest.contentId,
      graphSummary: manifest.graphSummary,
      revision: { kind: "git", commit: COMMIT },
    })).rejects.toThrow(/symbolic link/);

    unlinkSync(join(stage, "artifact.json"));
    writeFileSync(join(stage, "artifact.json"), serialized);
    rmSync(projection, { recursive: true, force: true });
    // Measurement is itself generation-lifecycle protected, so keep the adversarial source in a
    // valid unpublished-stage topology while still placing it outside the cache under test.
    const outsideLifecycle = new GraphGenerationLifecycle({ cacheRoot: outside });
    const outsideStage = await outsideLifecycle.reserveStage();
    const outsideProjection = join(outsideStage.directory, GRAPH_PROJECTION_DIRECTORY);
    const outsideManifest = writeGraphProjectionBundle(outsideProjection, artifact);
    const outsideIntegrity = await measureGraphProjectionBundle(outsideProjection, outside);
    symlinkSync(outsideProjection, projection);
    await expect(sealGraphGeneration({
      cacheRoot: root,
      stage: stageHandle,
      artifactPath: join(stage, "artifact.json"),
      projectionDirectory: projection,
      artifactBytes: Buffer.byteLength(serialized),
      artifactSha256: createHash("sha256").update(serialized).digest("hex"),
      ...outsideIntegrity,
      projectionContentId: outsideManifest.contentId,
      graphSummary: outsideManifest.graphSummary,
      revision: { kind: "git", commit: COMMIT },
    })).rejects.toThrow(/symbolic link/);
    await stageHandle.release();
    await outsideStage.release();
  });

  it("rejects a published artifact swapped for an outside symlink", async () => {
    const generation = await publishedGeneration();
    await verifyGraphGeneration(generation.input);
    const outside = join(temporaryRoot(), "outside.json");
    writeFileSync(outside, readFileSync(generation.input.artifactPath));
    chmodSync(dirname(generation.input.artifactPath), 0o700);
    unlinkSync(generation.input.artifactPath);
    symlinkSync(outside, generation.input.artifactPath);

    await expect(verifyGraphGeneration(generation.input)).rejects.toThrow(/symbolic link/);
  });
});

async function publishedGeneration(): Promise<{
  root: string;
  input: VerifyGraphGenerationInput;
  sealedStage: SealedGraphGenerationStage;
  sourceSummary: { nodeCount: number; edgeCount: number; schemaVersion: string; generatedAt: string };
}> {
  const staged = await sealedGeneration();
  const publicationLease = await staged.lifecycle.acquire(staged.published, {
    purpose: "publication",
    allowMissing: true,
  });
  try {
    if (!await staged.stageHandle.publish(publicationLease)) {
      throw new Error("test graph generation unexpectedly collided");
    }
    freezeGraphGenerationDirectory(staged.root, staged.published);
  } finally {
    await staged.stageHandle.release();
    await publicationLease.release();
  }
  return {
    root: staged.root,
    sealedStage: staged.sealed,
    sourceSummary: staged.sourceSummary,
    input: {
      cacheRoot: staged.root,
      artifactPath: join(staged.published, "artifact.json"),
      projectionDirectory: join(staged.published, GRAPH_PROJECTION_DIRECTORY),
      artifactBytes: staged.sealed.artifactBytes,
      artifactSha256: staged.sealed.artifactSha256,
      projectionBytes: staged.sealed.projectionBytes,
      projectionSha256: staged.sealed.projectionSha256,
      projectionContentId: staged.sealed.projectionContentId,
      sealSha256: staged.sealed.sealSha256,
      graphSummary: staged.sealed.graphSummary,
      revision: staged.sealed.revision,
    },
  };
}

async function sealedGeneration(options: {
  afterTrustedContentHash?: (artifactPath: string, projectionDirectory: string) => void;
  lifecycleFactory?: (root: string) => GraphGenerationLifecycle;
} = {}): Promise<{
  root: string;
  lifecycle: GraphGenerationLifecycle;
  stageHandle: Awaited<ReturnType<GraphGenerationLifecycle["reserveStage"]>>;
  published: string;
  sealed: SealedGraphGenerationStage;
  sourceSummary: { nodeCount: number; edgeCount: number; schemaVersion: string; generatedAt: string };
}> {
  const root = temporaryRoot();
  const lifecycle = options.lifecycleFactory?.(root) ?? new GraphGenerationLifecycle({ cacheRoot: root });
  const stageHandle = await lifecycle.reserveStage();
  const stage = stageHandle.directory;
  const entry = repositoryArtifactEntry(root, REPOSITORY_KEY, COMMIT, ANALYSIS_KEY);
  const published = finalizedGenerationDirectory(entry, `published-${roots.length}`);
  mkdirSync(dirname(published), { recursive: true, mode: 0o700 });
  const artifact = artifactFor();
  const serialized = JSON.stringify(artifact);
  const artifactPath = join(stage, "artifact.json");
  const projectionDirectory = join(stage, GRAPH_PROJECTION_DIRECTORY);
  writeFileSync(artifactPath, serialized, { mode: 0o600 });
  const manifest = writeGraphProjectionBundle(projectionDirectory, artifact);
  const projectionIntegrity = await measureGraphProjectionBundle(projectionDirectory, root);
  const sourceSummary = { ...manifest.graphSummary };
  try {
    const sealed = await sealGraphGeneration({
      cacheRoot: root,
      stage: stageHandle,
      artifactPath,
      projectionDirectory,
      artifactBytes: Buffer.byteLength(serialized),
      artifactSha256: createHash("sha256").update(serialized).digest("hex"),
      ...projectionIntegrity,
      projectionContentId: manifest.contentId,
      graphSummary: sourceSummary,
      revision: { kind: "git", commit: COMMIT },
    }, undefined, {
      afterTrustedContentHash: options.afterTrustedContentHash
        ? () => options.afterTrustedContentHash!(artifactPath, projectionDirectory)
        : undefined,
    });
    return { root, lifecycle, stageHandle, published, sealed, sourceSummary };
  } catch (error) {
    await stageHandle.release();
    throw error;
  }
}

function artifactFor(): GraphArtifact {
  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: "2026-07-17T00:00:00.000Z",
    generator: { name: "meridian", version: "test" },
    target: {
      name: "test",
      root: ".",
      language: "typescript",
      vcs: { repository: "https://github.com/org/repo.git", commit: COMMIT },
    },
    nodes: [],
    edges: [],
  };
}

function firstProjectionFile(directory: string): string {
  const visit = (path: string): string | null => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) {
        const nested = visit(child);
        if (nested) return nested;
      } else if (entry.isFile() && entry.name !== "manifest.json" && lstatSync(child).size > 0) {
        return child;
      }
    }
    return null;
  };
  const result = visit(directory);
  if (!result) throw new Error("projection fixture has no mutable shard");
  return result;
}

function mutateSameSize(path: string): void {
  const bytes = readFileSync(path);
  bytes[0] = bytes[0]! ^ 1;
  chmodSync(path, 0o600);
  writeFileSync(path, bytes);
  chmodSync(path, 0o400);
}

function addSealPadding(input: VerifyGraphGenerationInput, bytes: number): VerifyGraphGenerationInput {
  const directory = dirname(input.artifactPath);
  const sealPath = join(directory, "graph-generation.seal.json");
  const seal = JSON.parse(readFileSync(sealPath, "utf8")) as Record<string, unknown>;
  seal.padding = "x".repeat(bytes);
  const serialized = `${JSON.stringify(seal)}\n`;
  chmodSync(directory, 0o700);
  chmodSync(sealPath, 0o600);
  writeFileSync(sealPath, serialized, { mode: 0o400 });
  chmodSync(sealPath, 0o400);
  chmodSync(directory, 0o500);
  return {
    ...input,
    sealSha256: createHash("sha256").update(serialized).digest("hex"),
  };
}

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "meridian-generation-seal-"));
  roots.push(root);
  return root;
}
