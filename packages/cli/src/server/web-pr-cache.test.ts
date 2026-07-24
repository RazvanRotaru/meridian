import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REVIEW_FINGERPRINT_VERSION, SCHEMA_VERSION } from "@meridian/core";
import type { GraphArtifact } from "@meridian/core";
import {
  REPOSITORY_ANALYSIS_POLICY,
  REPOSITORY_ANALYSIS_VERSION,
} from "../repository-analysis-contract";
import { analyzeRepository } from "../repository-analysis";
import { validateOrThrow } from "../validation";
import { runGit } from "./git-exec";
import type { PhaseAdmission } from "./web-analysis-coordinator";
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
const SECOND_HEAD_SHA = "d".repeat(64);
const BASE_SHA = "b".repeat(64);
const MERGE_BASE_SHA = "c".repeat(64);
const SOURCE = { kind: "github", owner: "org", repo: "repo" } as const;
const BODY = { id: "graph", prNumber: 41, baseRef: "main", headRef: "feature/status" };
const SECOND_BODY = { id: "graph", prNumber: 42, baseRef: "main", headRef: "feature/other" };
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
  mockRemoteRevisions();
  vi.mocked(analyzeRepository).mockImplementation(async (request) => ({
    artifact: artifact(
      request.vcs?.commit ?? HEAD_SHA,
      request.vcs?.branch,
      request.changedSince,
    ),
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
    expect(basename(firstComparisonPath)).toBe("artifact.json");
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
    expect(basename(dirname(firstComparisonPath))).toMatch(/^[a-f0-9]{16}$/);
    expect(basename(dirname(firstArtifactPath))).not.toContain(first.artifactMaterial.byteDigest);
    expect(dirname(firstComparisonPath)).toContain(first.comparisonMaterial.byteDigest);
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
    const pairMetadata = JSON.parse(readFileSync(currentPrSnapshotMetadataPath(), "utf8"));
    expect(pairMetadata).toMatchObject({
      formatVersion: 12,
      headSha: HEAD_SHA,
      baseSha: BASE_SHA,
      mergeBaseSha: MERGE_BASE_SHA,
      headStorage: { kind: "shared" },
      comparisonStorage: { kind: "shared" },
    });
    const headMetadata = JSON.parse(
      readFileSync(join(dirname(firstArtifactPath), "metadata.json"), "utf8"),
    );
    expect(headMetadata.input).toMatchObject({
      formatVersion: 2,
      role: "head",
      repositoryUrl: "https://github.com/org/repo.git",
      commit: HEAD_SHA,
      branch: BODY.headRef,
      subdir: "",
      analysis: {
        changedSince: MERGE_BASE_SHA,
        allowEmpty: false,
        hintedFiles: [],
        reviewFingerprints: {
          mode: "changed",
          version: REVIEW_FINGERPRINT_VERSION,
          algorithm: "sha256-source-bytes",
        },
      },
    });
    const comparisonMetadata = JSON.parse(
      readFileSync(join(dirname(firstComparisonPath), "metadata.json"), "utf8"),
    );
    expect(comparisonMetadata.input).toEqual({
      formatVersion: 2,
      role: "comparison",
      analysisVersion: REPOSITORY_ANALYSIS_VERSION,
      schemaVersion: SCHEMA_VERSION,
      generatorVersion: expect.any(String),
      analysisRuntimeFingerprint: {
        formatVersion: 1,
        buildFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
        processInstanceNonce: expect.stringMatching(/^[a-f0-9]{32}$/),
        nodeVersion: process.versions.node,
        platform: process.platform,
        arch: process.arch,
        typescriptVersion: expect.any(String),
        tsMorphVersion: expect.any(String),
      },
      repositoryKey: expect.stringMatching(/^[a-f0-9]+$/),
      repositoryUrl: "https://github.com/org/repo.git",
      commit: MERGE_BASE_SHA,
      targetName: "org/repo",
      subdir: "",
      policy: REPOSITORY_ANALYSIS_POLICY,
      analysis: {
        changedSince: null,
        allowEmpty: false,
        hintedFiles: [],
        reviewFingerprints: {
          mode: "all",
          version: REVIEW_FINGERPRINT_VERSION,
          algorithm: "sha256-source-bytes",
        },
      },
    });
    expect(repositories.prepareCalls).toHaveLength(1);
    expect(vi.mocked(analyzeRepository)).toHaveBeenCalledTimes(2);
  });

  it("shares one verified canonical merge-base extraction across different PR pairs", async () => {
    const repositoryAnalysis = vi.fn(runRepositoryAnalysisChildInProcess);
    const firstStages: string[] = [];
    const first = await generate(false, BODY, firstStages, SOURCE, repositoryAnalysis);
    const secondStages: string[] = [];
    const sibling = await generate(false, SECOND_BODY, secondStages, SOURCE, repositoryAnalysis);
    const warmStages: string[] = [];
    const warmSibling = await generate(false, SECOND_BODY, warmStages, SOURCE, repositoryAnalysis);

    expect(first.cache).toBe("miss");
    expect(sibling.cache).toBe("miss");
    expect(warmSibling.cache).toBe("hit");
    expect(first.artifactMaterial.path).not.toBe(sibling.artifactMaterial.path);
    expect(sibling.artifactMaterial.path).toBe(warmSibling.artifactMaterial.path);
    expect(first.comparisonMaterial.path).toBe(sibling.comparisonMaterial.path);
    expect(sibling.comparisonMaterial.path).toBe(warmSibling.comparisonMaterial.path);
    expect(first.comparisonMaterial.path).toContain(join("pr-revision-artifacts", "objects"));
    expect(existsSync(join(dirname(first.artifactMaterial.path), "comparison-artifact.json"))).toBe(false);
    expect(vi.mocked(analyzeRepository)).toHaveBeenCalledTimes(3);
    expect(repositoryAnalysis.mock.calls.map((call) => call[1].reviewFingerprints)).toEqual([
      { mode: "changed" },
      { mode: "all" },
      { mode: "changed" },
    ]);
    expect(firstStages).toEqual([
      "clone",
      "checkout",
      "extract",
      "extract-head",
      "extract-merge-base",
    ]);
    expect(secondStages).toEqual([
      "clone",
      "checkout",
      "reuse-merge-base",
      "extract",
      "extract-head",
    ]);
    expect(warmStages).toEqual([]);
    expect(repositories.prepareCalls).toHaveLength(2);
    expect(repositories.acquirePreparedCalls).toHaveLength(1);
  });

  it("injects server-owned shard policy for both exact PR roots without reading it from the PR body", async () => {
    const treeOid = "e".repeat(64);
    vi.mocked(runGit).mockImplementation(async (args, options) => {
      if (args[0] === "ls-remote") {
        return `${BASE_SHA}\trefs/heads/main\n${HEAD_SHA}\trefs/pull/41/head\n`;
      }
      if (args[0] === "rev-parse") {
        return `${options.cwd}\n${treeOid}\n`;
      }
      return "";
    });
    const repositoryAnalysis = vi.fn(runRepositoryAnalysisChildInProcess);

    await generate(
      false,
      BODY,
      [],
      SOURCE,
      repositoryAnalysis,
      async (work) => work(new AbortController().signal),
      "shadow",
    );

    expect(repositoryAnalysis).toHaveBeenCalledTimes(2);
    for (const [, options] of repositoryAnalysis.mock.calls) {
      expect(options.typeScriptRevisionShards).toMatchObject({
        version: 1,
        mode: "shadow",
        cacheDir: join(cacheRoot, "typescript-revision-shards-v1", "shadow-admitted"),
        treeOid,
        buildFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
        analysisPolicyFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
    }
    expect(BODY).not.toHaveProperty("typeScriptRevisionShards");
    expect(vi.mocked(analyzeRepository).mock.calls.every(([request]) => (
      request.typeScriptRevisionShards?.cacheDir
        === join(cacheRoot, "typescript-revision-shards-v1", "shadow-admitted")
    ))).toBe(true);
  });

  it("reuses unchanged HEAD and merge-base artifacts after only the base tip moves without analysis admission", async () => {
    const repositoryAnalysis = vi.fn(runRepositoryAnalysisChildInProcess);
    const first = await generate(false, BODY, [], SOURCE, repositoryAnalysis);
    mockRemoteRevisions("e".repeat(64));
    const stages: string[] = [];
    const rejectAnalysis: PhaseAdmission = async () => {
      throw new Error("a fully reused pair must not enter analysis admission");
    };

    const movedBase = await generate(
      false,
      BODY,
      stages,
      SOURCE,
      repositoryAnalysis,
      rejectAnalysis,
    );

    expect(movedBase.cache).toBe("miss");
    expect(movedBase.baseSha).toBe("e".repeat(64));
    expect(movedBase.headSha).toBe(first.headSha);
    expect(movedBase.mergeBaseSha).toBe(first.mergeBaseSha);
    expect(movedBase.artifactMaterial.path).toBe(first.artifactMaterial.path);
    expect(movedBase.comparisonMaterial.path).toBe(first.comparisonMaterial.path);
    expect(stages).toEqual([
      "clone",
      "checkout",
      "reuse-head",
      "reuse-merge-base",
    ]);
    expect(repositoryAnalysis).toHaveBeenCalledTimes(2);
    expect(repositories.prepareCalls).toHaveLength(2);
  });

  it("fails closed and re-extracts a corrupt shared HEAD while retaining merge-base reuse", async () => {
    const first = await generate();
    writeFileSync(first.artifactMaterial.path, "{}\n");
    mockRemoteRevisions("e".repeat(64));
    const stages: string[] = [];

    const movedBase = await generate(false, BODY, stages);

    expect(movedBase.cache).toBe("miss");
    expect(movedBase.artifactMaterial.path).not.toBe(first.artifactMaterial.path);
    expect(movedBase.comparisonMaterial.path).toBe(first.comparisonMaterial.path);
    expect(stages).toEqual([
      "clone",
      "checkout",
      "reuse-merge-base",
      "extract",
      "extract-head",
    ]);
    expect(vi.mocked(analyzeRepository)).toHaveBeenCalledTimes(3);
    expect(createHash("sha256").update(readFileSync(movedBase.artifactMaterial.path)).digest("hex"))
      .toBe(movedBase.artifactMaterial.byteDigest);
  });

  it("invalidates populated HEAD reuse when its exact merge base changes", async () => {
    const first = await generate();
    const nextMergeBase = "f".repeat(64);
    repositories.mergeBaseSha = nextMergeBase;
    mockRemoteRevisions("e".repeat(64));
    const stages: string[] = [];

    const changedBase = await generate(false, BODY, stages);

    expect(changedBase.cache).toBe("miss");
    expect(changedBase.mergeBaseSha).toBe(nextMergeBase);
    expect(changedBase.artifactMaterial.path).not.toBe(first.artifactMaterial.path);
    expect(changedBase.comparisonMaterial.path).not.toBe(first.comparisonMaterial.path);
    expect(stages).toEqual([
      "clone",
      "checkout",
      "extract",
      "extract-head",
      "extract-merge-base",
    ]);
    expect(vi.mocked(analyzeRepository)).toHaveBeenCalledTimes(4);
  });

  it("invalidates populated HEAD reuse when its serialized branch provenance changes", async () => {
    const first = await generate();
    const stages: string[] = [];
    const changedHeadRef = { ...BODY, headRef: "feature/renamed" };

    const renamed = await generate(false, changedHeadRef, stages);

    expect(renamed.cache).toBe("miss");
    expect(renamed.artifactMaterial.path).not.toBe(first.artifactMaterial.path);
    expect(renamed.comparisonMaterial.path).toBe(first.comparisonMaterial.path);
    expect(stages).toEqual([
      "clone",
      "checkout",
      "reuse-merge-base",
      "extract",
      "extract-head",
    ]);
    expect(vi.mocked(analyzeRepository)).toHaveBeenCalledTimes(3);
  });

  it("fails closed and re-extracts when shared merge-base bytes no longer match their digest", async () => {
    const first = await generate();
    writeFileSync(first.comparisonMaterial.path, "{}\n");

    const siblingStages: string[] = [];
    const sibling = await generate(false, SECOND_BODY, siblingStages);

    expect(sibling.cache).toBe("miss");
    expect(sibling.comparisonMaterial.path).not.toBe(first.comparisonMaterial.path);
    expect(siblingStages).toEqual([
      "clone",
      "checkout",
      "extract",
      "extract-head",
      "extract-merge-base",
    ]);
    expect(vi.mocked(analyzeRepository)).toHaveBeenCalledTimes(4);
    expect(createHash("sha256").update(readFileSync(sibling.comparisonMaterial.path)).digest("hex"))
      .toBe(sibling.comparisonMaterial.byteDigest);
  });

  it("does not reuse a merge-base artifact across different extraction subdirectories", async () => {
    repositories.materialize = (_inputs, workspace) => {
      mkdirSync(join(workspace.headDir, "pkg"), { recursive: true });
      mkdirSync(join(workspace.comparisonDir, "pkg"), { recursive: true });
      writeFileSync(join(workspace.headDir, "pkg", "head-source.ts"), "export const head = true;\n");
      writeFileSync(join(workspace.comparisonDir, "pkg", "base-source.ts"), "export const base = true;\n");
    };
    const first = await generate();
    const subdirectorySource = { ...SOURCE, subdir: "pkg" };

    const sibling = await generate(false, SECOND_BODY, [], subdirectorySource);

    expect(sibling.cache).toBe("miss");
    expect(sibling.comparisonMaterial.path).not.toBe(first.comparisonMaterial.path);
    expect(vi.mocked(analyzeRepository)).toHaveBeenCalledTimes(4);
  });

  it("bypasses shared revision reuse for an explicit refresh without invalidating the old object", async () => {
    const original = await generate();
    const refreshStages: string[] = [];

    const refreshed = await generate(true, BODY, refreshStages);

    expect(refreshed.cache).toBe("miss");
    expect(refreshed.artifactMaterial.path).not.toBe(original.artifactMaterial.path);
    expect(refreshed.comparisonMaterial.path).not.toBe(original.comparisonMaterial.path);
    expect(existsSync(original.artifactMaterial.path)).toBe(true);
    expect(existsSync(original.comparisonMaterial.path)).toBe(true);
    expect(refreshStages).toEqual([
      "clone",
      "checkout",
      "extract",
      "extract-head",
      "extract-merge-base",
    ]);
    expect(vi.mocked(analyzeRepository)).toHaveBeenCalledTimes(4);
  });

  it("rejects poisoned pair facts while reusing the separately verified HEAD revision", async () => {
    const first = await generate();
    rewriteCachedBaseRef(BASE_SHA);

    const replacement = await generate();

    expect(replacement.cache).toBe("miss");
    expect(replacement.artifactMaterial.path).toBe(first.artifactMaterial.path);
    expect(replacement.artifactFacts.changedSinceBaseRef).toBe(MERGE_BASE_SHA);
    expect(analyzeRepository).toHaveBeenCalledTimes(2);
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

function generate(
  refresh = false,
  body = BODY,
  stages: string[] = [],
  source: typeof SOURCE | (typeof SOURCE & { subdir: string }) = SOURCE,
  repositoryAnalysis: typeof runRepositoryAnalysisChildInProcess = runRepositoryAnalysisChildInProcess,
  runAnalysis: PhaseAdmission = async (work) => work(new AbortController().signal),
  typeScriptRevisionShardMode?: "empty" | "shadow" | "verified-experimental",
) {
  return cachedPrGraph({
    cacheRoot,
    repositories,
    source,
    body,
    cwd: cacheRoot,
    refresh,
    onStage: (stage) => { stages.push(stage); },
    runPreparation: async (work) => work(new AbortController().signal),
    runAnalysis,
    typeScriptRevisionShardMode,
    repositoryAnalysis,
  });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function artifact(commit: string, branch?: string, changedSince = MERGE_BASE_SHA): GraphArtifact {
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
            baseRef: changedSince,
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

function rewriteCachedBaseRef(baseRef: string): void {
  const metadataPath = currentPrSnapshotMetadataPath();
  const snapshot = dirname(metadataPath);
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
    headStorage: metadata.headStorage,
    comparisonArtifactDigest: metadata.comparisonArtifactDigest,
    comparisonArtifactBytes: metadata.comparisonArtifactBytes,
    comparisonFacts: metadata.comparisonFacts,
    comparisonStorage: metadata.comparisonStorage,
    workspaceId: metadata.workspaceId,
    warnings: metadata.warnings,
  })).digest("hex");
}

function currentPrSnapshotMetadataPath(): string {
  const artifactsRoot = join(cacheRoot, "pr-artifacts");
  const slots = readdirSync(artifactsRoot);
  expect(slots).toHaveLength(1);
  const slot = join(artifactsRoot, slots[0]!);
  const pointer = JSON.parse(readFileSync(join(slot, "metadata.json"), "utf8")) as { snapshotId: string };
  return join(slot, "snapshots", pointer.snapshotId, "metadata.json");
}

function mockRemoteRevisions(baseSha = BASE_SHA): void {
  vi.mocked(runGit).mockImplementation(async (args) => {
    if (args[0] === "ls-remote") {
      const second = args.includes("refs/pull/42/head");
      return `${baseSha}\trefs/heads/main\n${second ? SECOND_HEAD_SHA : HEAD_SHA}\t${
        second ? "refs/pull/42/head" : "refs/pull/41/head"
      }\n`;
    }
    return "";
  });
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
