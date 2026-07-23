import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SCHEMA_VERSION } from "@meridian/core";
import type { GraphArtifact } from "@meridian/core";
import { analyzeRepository } from "../repository-analysis";
import { validateOrThrow } from "../validation";
import { runGit } from "./git-exec";
import { materializeValidatedArtifact } from "./web-graph-store";
import { cachedPrGraph } from "./web-pr-cache";
import { runRepositoryAnalysisChildInProcess } from "./repository-analysis-child-test-adapter";
import { FakePrRepositoryMirror } from "./pr-repository-mirror-test-fake";

vi.mock("../repository-analysis", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../repository-analysis")>();
  return { ...actual, analyzeRepository: vi.fn() };
});
vi.mock("./git-exec", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./git-exec")>();
  return { ...actual, runGit: vi.fn() };
});
vi.mock("../validation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../validation")>();
  return { ...actual, validateOrThrow: vi.fn(actual.validateOrThrow) };
});
vi.mock("./web-graph-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./web-graph-store")>();
  return { ...actual, materializeValidatedArtifact: vi.fn(actual.materializeValidatedArtifact) };
});

const HEAD_SHA = "a".repeat(64);
const BASE_SHA = "b".repeat(64);
const MERGE_BASE_SHA = "c".repeat(64);
const SOURCE = { kind: "github", owner: "org", repo: "repo" } as const;
const BODY = { id: "graph", prNumber: 41, baseRef: "main", headRef: "feature/status" };
const HEAD_ARTIFACT = artifact(HEAD_SHA, BODY.headRef);
const COMPARISON_ARTIFACT = artifact(MERGE_BASE_SHA);

let cacheRoot: string;
let repositories: FakePrRepositoryMirror;

beforeEach(() => {
  cacheRoot = mkdtempSync(join(tmpdir(), "meridian-pr-path-test-"));
  repositories = new FakePrRepositoryMirror(cacheRoot, MERGE_BASE_SHA);
  repositories.materialize = (_inputs, workspace) => {
    writeFileSync(join(workspace.headDir, "head-source.ts"), "export const head = true;\n");
    writeFileSync(join(workspace.comparisonDir, "base-source.ts"), "export const base = true;\n");
  };
  vi.mocked(runGit).mockImplementation(async (args) => {
    if (args[0] === "ls-remote") {
      return `${BASE_SHA}\trefs/heads/main\n${HEAD_SHA}\trefs/pull/41/head\n`;
    }
    return "";
  });
  vi.mocked(analyzeRepository).mockImplementation(async (request) => ({
    artifact: request.changedSince ? HEAD_ARTIFACT : COMPARISON_ARTIFACT,
    warnings: [],
  }) as never);
});

afterEach(() => {
  repositories.releaseAllForTest();
  rmSync(cacheRoot, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe("persistent PR graph artifact paths", () => {
  it("materializes each generated side once and validates persisted sides only on cache hits", async () => {
    const first = await generate();

    expect(first.cache).toBe("miss");
    expect(first.artifactFacts).toMatchObject({
      target: HEAD_ARTIFACT.target,
      changedSinceBaseRef: MERGE_BASE_SHA,
    });
    expect(first).not.toHaveProperty("comparisonArtifact");
    expect(materializeValidatedArtifact).not.toHaveBeenCalled();
    expect(validateOrThrow).not.toHaveBeenCalled();

    const second = await generate();
    expect(second.cache).toBe("hit");
    expect(second).not.toHaveProperty("comparisonArtifact");
    expect(second.artifactFacts).toMatchObject({
      changedSinceBaseRef: MERGE_BASE_SHA,
      changedFiles: expect.arrayContaining([
        { path: "src/added.ts", status: "added" },
        { path: "src/changed.ts", status: "modified" },
        { path: "src/deleted.ts", status: "deleted" },
        { path: "src/renamed.ts", status: "renamed", previousPath: "src/old.ts" },
      ]),
    });
    expect(materializeValidatedArtifact).not.toHaveBeenCalled();
    expect(validateOrThrow).not.toHaveBeenCalled();
    expect(repositories.prepareCalls).toHaveLength(1);
    expect(repositories.acquirePreparedCalls).toHaveLength(1);
  });

  it("returns the exact immutable HEAD and merge-base JSON paths on misses and hits", async () => {
    const first = await generate();
    const second = await generate();
    const firstArtifactPath = first.artifactMaterial.path;
    const firstComparisonPath = first.comparisonMaterial.path;

    expect(first.cache).toBe("miss");
    expect(second.cache).toBe("hit");
    expect(basename(firstArtifactPath)).toBe("artifact.json");
    expect(basename(firstComparisonPath)).toBe("comparison-artifact.json");
    expect(second.artifactMaterial.path).toBe(firstArtifactPath);
    expect(second.comparisonMaterial.path).toBe(firstComparisonPath);
    expect(existsSync(second.artifactMaterial.path)).toBe(true);
    expect(existsSync(second.comparisonMaterial.path)).toBe(true);
    expectWithoutReviewFingerprints(JSON.parse(readFileSync(second.artifactMaterial.path, "utf8")), HEAD_ARTIFACT);
    expectWithoutReviewFingerprints(JSON.parse(readFileSync(second.comparisonMaterial.path, "utf8")), COMPARISON_ARTIFACT);
    expect(first.artifactMaterial.byteDigest).toBe(createHash("sha256").update(readFileSync(firstArtifactPath)).digest("hex"));
    expect(first.comparisonMaterial.byteDigest).toBe(createHash("sha256")
      .update(readFileSync(firstComparisonPath))
      .digest("hex"));
    expect(second.artifactMaterial.byteDigest).toBe(first.artifactMaterial.byteDigest);
    expect(second.comparisonMaterial.byteDigest).toBe(first.comparisonMaterial.byteDigest);
    expect(basename(dirname(firstArtifactPath))).toMatch(/^[a-f0-9]{16}$/);
    expect(basename(dirname(firstArtifactPath))).not.toContain(first.artifactMaterial.byteDigest);
    expect(HEAD_SHA).toHaveLength(64);
    expect(BASE_SHA).toHaveLength(64);
    expect(MERGE_BASE_SHA).toHaveLength(64);
    for (const path of [
      firstArtifactPath,
      firstComparisonPath,
      first.sourceDir,
      first.comparisonSourceDir,
    ]) {
      expect(relative(realpathSync.native(cacheRoot), realpathSync.native(path)).length).toBeLessThanOrEqual(165);
      expect(path).not.toContain(HEAD_SHA);
      expect(path).not.toContain(BASE_SHA);
    }
    const metadata = JSON.parse(readFileSync(join(dirname(firstArtifactPath), "metadata.json"), "utf8"));
    expect(metadata).toMatchObject({
      headSha: HEAD_SHA,
      baseSha: BASE_SHA,
      mergeBaseSha: MERGE_BASE_SHA,
    });
    expect(repositories.prepareCalls).toHaveLength(1);
    expect(vi.mocked(analyzeRepository)).toHaveBeenCalledTimes(2);
  });

  it("rejects a digest-consistent cache snapshot whose compact HEAD facts are bound to another base", async () => {
    const first = await generate();
    rewriteCachedBaseRef(first.artifactMaterial.path, BASE_SHA);

    const replacement = await generate();

    expect(replacement.cache).toBe("miss");
    expect(replacement.artifactMaterial.path).not.toBe(first.artifactMaterial.path);
    expect(replacement.artifactFacts.changedSinceBaseRef).toBe(MERGE_BASE_SHA);
    expect(analyzeRepository).toHaveBeenCalledTimes(4);
  });

  it("keeps the published HEAD and merge-base snapshot readable when refresh fails", async () => {
    const original = await generate();
    const originalHead = readFileSync(join(original.sourceDir, "head-source.ts"), "utf8");
    const originalBase = readFileSync(join(original.comparisonSourceDir, "base-source.ts"), "utf8");
    vi.mocked(analyzeRepository).mockRejectedValueOnce(new Error("extract failed"));

    await expect(generate(true)).rejects.toThrow("extract failed");

    expect(readFileSync(join(original.sourceDir, "head-source.ts"), "utf8")).toBe(originalHead);
    expect(readFileSync(join(original.comparisonSourceDir, "base-source.ts"), "utf8")).toBe(originalBase);
    expectWithoutReviewFingerprints(JSON.parse(readFileSync(original.artifactMaterial.path, "utf8")), HEAD_ARTIFACT);
    expectWithoutReviewFingerprints(JSON.parse(readFileSync(original.comparisonMaterial.path, "utf8")), COMPARISON_ARTIFACT);

    const recovered = await generate();
    expect(recovered.cache).toBe("hit");
    expect(recovered.sourceDir).toBe(original.sourceDir);
    expect(recovered.comparisonSourceDir).toBe(original.comparisonSourceDir);
    expect(recovered.artifactMaterial.path).toBe(original.artifactMaterial.path);
    expect(recovered.comparisonMaterial.path).toBe(original.comparisonMaterial.path);
  });

  it("publishes overlapping refreshes atomically without invalidating any returned snapshot", async () => {
    const original = await generate();
    const enteredA = deferred<void>();
    const enteredB = deferred<void>();
    const releaseA = deferred<void>();
    const releaseB = deferred<void>();
    let refreshGeneration = 0;
    repositories.beforeFetchComplete = async (_inputs, workspace) => {
      const generation = ++refreshGeneration;
      writeFileSync(join(workspace.headDir, "head-source.ts"), `export const generation = ${generation};\n`);
      (generation === 1 ? enteredA : enteredB).resolve();
      await (generation === 1 ? releaseA : releaseB).promise;
    };
    repositories.materialize = (_inputs, workspace) => {
      writeFileSync(join(workspace.comparisonDir, "base-source.ts"), "export const base = true;\n");
    };

    const pendingA = generate(true);
    await enteredA.promise;
    const pendingB = generate(true);
    await enteredB.promise;

    releaseB.resolve();
    const refreshedB = await pendingB;
    expect(readFileSync(join(refreshedB.sourceDir, "head-source.ts"), "utf8")).toContain("generation = 2");
    expect(readFileSync(join(original.sourceDir, "head-source.ts"), "utf8")).toContain("head = true");
    expect(readFileSync(join(original.comparisonSourceDir, "base-source.ts"), "utf8")).toContain("base = true");

    releaseA.resolve();
    const refreshedA = await pendingA;
    expect(refreshedA.sourceDir).not.toBe(refreshedB.sourceDir);
    expect(refreshedA.artifactMaterial.path).not.toBe(refreshedB.artifactMaterial.path);
    expect(readFileSync(join(refreshedA.sourceDir, "head-source.ts"), "utf8")).toContain("generation = 1");
    expect(readFileSync(join(refreshedB.sourceDir, "head-source.ts"), "utf8")).toContain("generation = 2");
    expect(existsSync(refreshedA.comparisonSourceDir)).toBe(true);
    expect(existsSync(refreshedB.comparisonSourceDir)).toBe(true);
    expect(existsSync(original.sourceDir)).toBe(true);
    expect(existsSync(original.comparisonSourceDir)).toBe(true);

    const current = await generate();
    expect(current.cache).toBe("hit");
    expect(current.sourceDir).toBe(refreshedA.sourceDir);
    expect(current.comparisonSourceDir).toBe(refreshedA.comparisonSourceDir);
  });
});

function generate(refresh = false) {
  return cachedPrGraph({
    cacheRoot,
    repositories,
    source: SOURCE,
    body: BODY,
    cwd: cacheRoot,
    refresh,
    onStage: () => {},
    runPreparation: async (work) => work(new AbortController().signal),
    runAnalysis: async (work) => work(new AbortController().signal),
    repositoryAnalysis: runRepositoryAnalysisChildInProcess,
  });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function artifact(commit: string, branch?: string): GraphArtifact {
  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: "2026-07-20T00:00:00.000Z",
    generator: { name: "meridian", version: "test" },
    target: {
      name: "org/repo",
      root: ".",
      language: "typescript",
      vcs: { repository: "https://github.com/org/repo.git", commit, ...(branch ? { branch } : {}) },
    },
    nodes: [],
    edges: [],
    ...(branch ? {
      extensions: {
        changedSince: {
          baseRef: MERGE_BASE_SHA,
          manifest: [
            { path: "src/added.ts", status: "added" },
            { path: "src/changed.ts", status: "modified" },
            { path: "src/deleted.ts", status: "deleted" },
            { path: "src/renamed.ts", status: "renamed", previousPath: "src/old.ts" },
          ],
        },
      },
    } : {}),
  };
}

function rewriteCachedBaseRef(artifactPath: string, baseRef: string): void {
  const snapshot = dirname(artifactPath);
  const metadataPath = join(snapshot, "metadata.json");
  const metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as Record<string, unknown>;
  (metadata.artifactFacts as Record<string, unknown>).changedSinceBaseRef = baseRef;
  metadata.snapshotDigest = snapshotDigest(metadata);
  writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);

  const pointerPath = join(dirname(dirname(snapshot)), "metadata.json");
  const pointer = JSON.parse(readFileSync(pointerPath, "utf8")) as Record<string, unknown>;
  pointer.snapshotDigest = metadata.snapshotDigest;
  writeFileSync(pointerPath, `${JSON.stringify(pointer, null, 2)}\n`);
}

function snapshotDigest(metadata: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify({
    formatVersion: metadata.formatVersion,
    analysisVersion: metadata.analysisVersion,
    repositoryKey: metadata.repositoryKey,
    headSha: metadata.headSha,
    baseSha: metadata.baseSha,
    mergeBaseSha: metadata.mergeBaseSha,
    analysisKey: metadata.analysisKey,
    artifactDigest: metadata.artifactDigest,
    artifactBytes: metadata.artifactBytes,
    artifactFacts: metadata.artifactFacts,
    comparisonArtifactDigest: metadata.comparisonArtifactDigest,
    comparisonArtifactBytes: metadata.comparisonArtifactBytes,
    comparisonFacts: metadata.comparisonFacts,
    workspaceId: metadata.workspaceId,
    warnings: metadata.warnings,
  })).digest("hex");
}

function expectWithoutReviewFingerprints(actual: GraphArtifact, expected: GraphArtifact): void {
  expect(actual.extensions?.reviewFingerprints).toMatchObject({
    version: 1,
    algorithm: "sha256-source-bytes",
    complete: expect.any(Boolean),
  });
  const { reviewFingerprints: _fingerprints, ...extensions } = actual.extensions ?? {};
  expect({ ...actual, ...(Object.keys(extensions).length > 0 ? { extensions } : { extensions: undefined }) })
    .toEqual({ ...expected, ...(expected.extensions ? {} : { extensions: undefined }) });
}
