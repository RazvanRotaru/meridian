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
import {
  AnalysisCoordinator,
  type PhaseAdmission,
} from "./web-analysis-coordinator";
import { materializeValidatedArtifact } from "./web-graph-store";
import { cachedPrGraph } from "./web-pr-cache";
import type { RepositoryAnalysisProgress } from "./repository-analysis-child";
import { runRepositoryAnalysisChildInProcess } from "./repository-analysis-child-test-adapter";
import { FakePrRepositoryMirror } from "./pr-repository-mirror-test-fake";
import {
  tryWithTypeScriptRevisionShardBuildLock,
  withTypeScriptRevisionShardBuildLock,
} from "./web-typescript-revision-shard-lock";

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
    let active = 0;
    let maximumActive = 0;
    const repositoryAnalysis = vi.fn(async (...args: Parameters<typeof runRepositoryAnalysisChildInProcess>) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      try {
        return await runRepositoryAnalysisChildInProcess(...args);
      } finally {
        active -= 1;
      }
    });
    const firstStages: string[] = [];
    const first = await generate(false, BODY, firstStages, SOURCE, repositoryAnalysis);
    const secondStages: string[] = [];
    const secondReservations: number[] = [];
    const secondCompletedLanes: Array<"head" | "mergeBase"> = [];
    const sibling = await generate(
      false,
      SECOND_BODY,
      secondStages,
      SOURCE,
      repositoryAnalysis,
      async (work, options) => {
        secondReservations.push(options?.slots ?? 1);
        return work(new AbortController().signal);
      },
      undefined,
      true,
      2,
      secondCompletedLanes,
    );
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
    expect(secondReservations).toEqual([1]);
    expect(secondCompletedLanes).toEqual(["head"]);
    expect(maximumActive).toBe(1);
    expect(repositories.prepareCalls).toHaveLength(2);
    expect(repositories.acquirePreparedCalls).toHaveLength(1);
  });

  it("reuses a verified merge-base when sibling PRs delete the same extracted subtree", async () => {
    const subdir = "packages/removed-app";
    repositories.materialize = (_inputs, workspace) => {
      mkdirSync(join(workspace.comparisonDir, subdir), { recursive: true });
      writeFileSync(
        join(workspace.comparisonDir, subdir, "index.ts"),
        "export const removed = true;\n",
      );
    };
    const source = { ...SOURCE, subdir };
    const firstStages: string[] = [];
    const firstCompletedLanes: Array<"head" | "mergeBase"> = [];
    const first = await generate(
      false,
      BODY,
      firstStages,
      source,
      runRepositoryAnalysisChildInProcess,
      undefined,
      undefined,
      true,
      1,
      firstCompletedLanes,
    );
    const siblingStages: string[] = [];
    const siblingCompletedLanes: Array<"head" | "mergeBase"> = [];
    const sibling = await generate(
      false,
      SECOND_BODY,
      siblingStages,
      source,
      runRepositoryAnalysisChildInProcess,
      undefined,
      undefined,
      true,
      1,
      siblingCompletedLanes,
    );

    expect(first.cache).toBe("miss");
    expect(sibling.cache).toBe("miss");
    expect(sibling.comparisonMaterial.path).toBe(first.comparisonMaterial.path);
    expect(firstStages).toEqual([
      "clone", "checkout", "extract", "extract-merge-base", "extract-head",
    ]);
    expect(siblingStages).toEqual([
      "clone", "checkout", "reuse-merge-base", "extract", "extract-head",
    ]);
    expect(firstCompletedLanes).toEqual(["mergeBase", "head"]);
    expect(siblingCompletedLanes).toEqual(["head"]);
    expect(vi.mocked(analyzeRepository)).toHaveBeenCalledTimes(3);
  });

  it("seeds an admitted pair from merge-base before HEAD with matching progress ordinals", async () => {
    let active = 0;
    let maximumActive = 0;
    const repositoryAnalysis = vi.fn(async (...args: Parameters<typeof runRepositoryAnalysisChildInProcess>) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      try {
        return await runRepositoryAnalysisChildInProcess(...args);
      } finally {
        active -= 1;
      }
    });
    const reservations: number[] = [];
    const runAnalysis: PhaseAdmission = async (work, options) => {
      reservations.push(options?.slots ?? 1);
      return work(new AbortController().signal);
    };
    const stages: string[] = [];
    const completedLanes: Array<"head" | "mergeBase"> = [];
    const progress: RepositoryAnalysisProgress[] = [];

    const result = await generate(
      false,
      BODY,
      stages,
      SOURCE,
      repositoryAnalysis,
      runAnalysis,
      "admitted",
      true,
      2,
      completedLanes,
      progress,
    );

    expect(result.cache).toBe("miss");
    expect(maximumActive).toBe(1);
    expect(reservations).toEqual([1]);
    expect(stages).toEqual([
      "clone", "checkout", "extract", "extract-merge-base", "extract-head",
    ]);
    expect(completedLanes).toEqual(["mergeBase", "head"]);
    expect(repositoryAnalysis.mock.calls.map(([, options]) => (
      options.progress?.context.revision
    ))).toEqual([
      { kind: "merge-base", commit: MERGE_BASE_SHA, execution: { current: 1, total: 2 } },
      { kind: "head", commit: HEAD_SHA, execution: { current: 2, total: 2 } },
    ]);
    expect(readdirSync(dirname(currentPrSnapshotMetadataPath())))
      .not.toContain("typescript-revision-pair-shards");
  });

  it("keeps a second admitted pair queued until the active base-first pair releases", async () => {
    const coordinator = new AnalysisCoordinator({ maxConcurrentAnalyses: 2 });
    const firstMergeBaseStarted = deferred<void>();
    const secondReservationRequested = deferred<void>();
    const secondMergeBaseStarted = deferred<void>();
    const releaseFirst = deferred<void>();
    const releaseSecond = deferred<void>();
    let calls = 0;
    let active = 0;
    let maximumActive = 0;
    const repositoryAnalysis = vi.fn(async (
      ...args: Parameters<typeof runRepositoryAnalysisChildInProcess>
    ) => {
      calls += 1;
      const pair = calls <= 2 ? "first" : "second";
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      if (calls === 1) firstMergeBaseStarted.resolve();
      if (calls === 3) secondMergeBaseStarted.resolve();
      await (pair === "first" ? releaseFirst.promise : releaseSecond.promise);
      try {
        return await runRepositoryAnalysisChildInProcess(...args);
      } finally {
        active -= 1;
      }
    });
    const reservations = new Map<string, number[]>();
    const generatePr = (
      key: string,
      body: Parameters<typeof cachedPrGraph>[0]["body"],
    ) => coordinator.run(key, async ({
      analysisCapacity,
      signal,
      runPreparation,
      runCoordination,
      runAnalysis,
    }) => cachedPrGraph({
      cacheRoot,
      repositories,
      source: SOURCE,
      body,
      cwd: cacheRoot,
      signal,
      onStage: () => undefined,
      onRevisionComplete: () => undefined,
      runPreparation,
      runCoordination,
      runAnalysis: (work, options) => {
        const jobReservations = reservations.get(key) ?? [];
        jobReservations.push(options?.slots ?? 1);
        reservations.set(key, jobReservations);
        if (key === "second-pr") secondReservationRequested.resolve();
        return runAnalysis(work, options);
      },
      analysisCapacity,
      typeScriptRevisionShardMode: "admitted",
      experimentalPrRevisionCache: false,
      repositoryAnalysis,
    }));

    const first = generatePr("first-pr", BODY);
    await firstMergeBaseStarted.promise;
    const second = generatePr("second-pr", SECOND_BODY);
    await secondReservationRequested.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(calls).toBe(1);
    expect(reservations.get("second-pr")).toEqual([1]);

    releaseFirst.resolve();
    await secondMergeBaseStarted.promise;
    expect(active).toBe(1);
    expect(calls).toBe(3);
    expect(reservations.get("second-pr")).toEqual([1]);

    releaseSecond.resolve();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    await coordinator.close();

    expect(firstResult.cache).toBe("miss");
    expect(secondResult.cache).toBe("miss");
    expect(maximumActive).toBe(1);
    expect(reservations.get("first-pr")).toEqual([1]);
    expect(reservations.get("second-pr")).toEqual([1]);
  });

  it("rechecks a shared merge base after one-slot admission and starts only the remaining HEAD", async () => {
    const coordinator = new AnalysisCoordinator({ maxConcurrentAnalyses: 2 });
    const firstHeadStarted = deferred<void>();
    const secondReservationRequested = deferred<void>();
    const secondHeadStarted = deferred<void>();
    const releaseFirst = deferred<void>();
    const releaseSecondHead = deferred<void>();
    let calls = 0;
    let active = 0;
    let maximumActive = 0;
    const repositoryAnalysis = vi.fn(async (
      ...args: Parameters<typeof runRepositoryAnalysisChildInProcess>
    ) => {
      calls += 1;
      const call = calls;
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      if (call === 2) firstHeadStarted.resolve();
      if (call === 3) secondHeadStarted.resolve();
      if (call === 2) await releaseFirst.promise;
      if (call === 3) await releaseSecondHead.promise;
      try {
        return await runRepositoryAnalysisChildInProcess(...args);
      } finally {
        active -= 1;
      }
    });
    const reservations = new Map<string, number[]>();
    const stages = new Map<string, string[]>();
    const completedLanes = new Map<string, Array<"head" | "mergeBase">>();
    const generatePr = (
      key: string,
      body: Parameters<typeof cachedPrGraph>[0]["body"],
    ) => coordinator.run(key, async ({
      analysisCapacity,
      signal,
      runPreparation,
      runCoordination,
      runAnalysis,
    }) => cachedPrGraph({
      cacheRoot,
      repositories,
      source: SOURCE,
      body,
      cwd: cacheRoot,
      signal,
      onStage: (stage) => {
        const jobStages = stages.get(key) ?? [];
        jobStages.push(stage);
        stages.set(key, jobStages);
      },
      onRevisionComplete: (lane) => {
        const jobLanes = completedLanes.get(key) ?? [];
        jobLanes.push(lane);
        completedLanes.set(key, jobLanes);
      },
      runPreparation,
      runCoordination,
      runAnalysis: (work, options) => {
        const jobReservations = reservations.get(key) ?? [];
        jobReservations.push(options?.slots ?? 1);
        reservations.set(key, jobReservations);
        if (key === "second-pr") secondReservationRequested.resolve();
        return runAnalysis(work, options);
      },
      analysisCapacity,
      typeScriptRevisionShardMode: "admitted",
      experimentalPrRevisionCache: true,
      repositoryAnalysis,
    }));

    const first = generatePr("first-pr", BODY);
    await firstHeadStarted.promise;
    const second = generatePr("second-pr", SECOND_BODY);
    await secondReservationRequested.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(calls).toBe(2);

    releaseFirst.resolve();
    await secondHeadStarted.promise;
    expect(calls).toBe(3);
    expect(active).toBe(1);
    expect(reservations.get("second-pr")).toEqual([1]);

    releaseSecondHead.resolve();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    await coordinator.close();

    expect(firstResult.cache).toBe("miss");
    expect(secondResult.cache).toBe("miss");
    expect(secondResult.comparisonMaterial.path).toBe(firstResult.comparisonMaterial.path);
    expect(maximumActive).toBe(1);
    expect(repositoryAnalysis).toHaveBeenCalledTimes(3);
    expect(repositoryAnalysis.mock.calls[2]?.[1].reviewFingerprints).toEqual({ mode: "changed" });
    expect(stages.get("second-pr")).toEqual([
      "clone", "checkout", "reuse-merge-base", "extract", "extract-head",
    ]);
    expect(completedLanes.get("second-pr")).toEqual(["head"]);
  });

  it("starts no workers when both exact revisions appear before one-slot admission", async () => {
    const coordinator = new AnalysisCoordinator({ maxConcurrentAnalyses: 2 });
    const firstHeadStarted = deferred<void>();
    const secondReservationRequested = deferred<void>();
    const releaseFirst = deferred<void>();
    let calls = 0;
    const repositoryAnalysis = vi.fn(async (
      ...args: Parameters<typeof runRepositoryAnalysisChildInProcess>
    ) => {
      calls += 1;
      if (calls === 2) {
        firstHeadStarted.resolve();
        await releaseFirst.promise;
      }
      return runRepositoryAnalysisChildInProcess(...args);
    });
    const reservations = new Map<string, number[]>();
    const stages = new Map<string, string[]>();
    const completedLanes = new Map<string, Array<"head" | "mergeBase">>();
    const generatePr = (key: string) => coordinator.run(key, async ({
      analysisCapacity,
      signal,
      runPreparation,
      runCoordination,
      runAnalysis,
    }) => cachedPrGraph({
      cacheRoot,
      repositories,
      source: SOURCE,
      body: BODY,
      cwd: cacheRoot,
      signal,
      onStage: (stage) => {
        const jobStages = stages.get(key) ?? [];
        jobStages.push(stage);
        stages.set(key, jobStages);
      },
      onRevisionComplete: (lane) => {
        const jobLanes = completedLanes.get(key) ?? [];
        jobLanes.push(lane);
        completedLanes.set(key, jobLanes);
      },
      runPreparation,
      runCoordination,
      runAnalysis: (work, options) => {
        const jobReservations = reservations.get(key) ?? [];
        jobReservations.push(options?.slots ?? 1);
        reservations.set(key, jobReservations);
        if (key === "second-request") secondReservationRequested.resolve();
        return runAnalysis(work, options);
      },
      analysisCapacity,
      typeScriptRevisionShardMode: "admitted",
      experimentalPrRevisionCache: true,
      repositoryAnalysis,
    }));

    const first = generatePr("first-request");
    await firstHeadStarted.promise;
    const second = generatePr("second-request");
    await secondReservationRequested.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(calls).toBe(2);

    releaseFirst.resolve();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    await coordinator.close();

    expect(firstResult.cache).toBe("miss");
    expect(secondResult.cache).toBe("miss");
    expect(repositoryAnalysis).toHaveBeenCalledTimes(2);
    expect(secondResult.artifactMaterial.path).toBe(firstResult.artifactMaterial.path);
    expect(secondResult.comparisonMaterial.path).toBe(firstResult.comparisonMaterial.path);
    expect(reservations.get("second-request")).toEqual([1]);
    expect(stages.get("second-request")).toEqual([
      "clone", "checkout", "reuse-merge-base", "extract", "reuse-head",
    ]);
    expect(completedLanes.get("second-request")).toBeUndefined();
  });

  it("keeps the non-shard populated pair on the legacy one-worker path", async () => {
    const releaseFirst = deferred<void>();
    const firstStarted = deferred<void>();
    let active = 0;
    let started = 0;
    let maximumActive = 0;
    const repositoryAnalysis = vi.fn(async (
      ...args: Parameters<typeof runRepositoryAnalysisChildInProcess>
    ) => {
      started += 1;
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      if (started === 1) {
        firstStarted.resolve();
        await releaseFirst.promise;
      }
      try {
        return await runRepositoryAnalysisChildInProcess(...args);
      } finally {
        active -= 1;
      }
    });
    const reservations: number[] = [];
    const generated = generate(
      false,
      BODY,
      [],
      SOURCE,
      repositoryAnalysis,
      async (work, options) => {
        reservations.push(options?.slots ?? 1);
        return work(new AbortController().signal);
      },
      undefined,
      true,
      2,
    );

    await firstStarted.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    const startedBeforeRelease = started;
    releaseFirst.resolve();
    await generated;

    expect(startedBeforeRelease).toBe(1);
    expect(started).toBe(2);
    expect(maximumActive).toBe(1);
    expect(reservations).toEqual([1]);
  });

  it("keeps queued base-first PR pairs outside analysis slots while the host fence is busy", async () => {
    const lockHeld = deferred<void>();
    const releaseLock = deferred<void>();
    const lockOwner = withTypeScriptRevisionShardBuildLock(
      cacheRoot,
      undefined,
      async () => {
        lockHeld.resolve();
        await releaseLock.promise;
      },
    );
    await lockHeld.promise;

    const coordinator = new AnalysisCoordinator({ maxConcurrentAnalyses: 2 });
    const attemptsFinished = deferred<void>();
    const reservations = new Map<string, number[]>();
    let finishedAttempts = 0;
    let active = 0;
    let maximumActive = 0;
    const repositoryAnalysis = vi.fn(async (
      ...args: Parameters<typeof runRepositoryAnalysisChildInProcess>
    ) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      try {
        return await runRepositoryAnalysisChildInProcess(...args);
      } finally {
        active -= 1;
      }
    });
    const generatePr = (
      key: string,
      body: Parameters<typeof cachedPrGraph>[0]["body"],
    ) => coordinator.run(key, async ({
      analysisCapacity,
      signal,
      runPreparation,
      runCoordination,
      runAnalysis,
    }) => cachedPrGraph({
      cacheRoot,
      repositories,
      source: SOURCE,
      body,
      cwd: cacheRoot,
      signal,
      onStage: () => undefined,
      onRevisionComplete: () => undefined,
      runPreparation,
      runCoordination,
      runAnalysis: async (work, options) => {
        const jobReservations = reservations.get(key) ?? [];
        jobReservations.push(options?.slots ?? 1);
        reservations.set(key, jobReservations);
        const result = await runAnalysis(work, options);
        finishedAttempts += 1;
        if (finishedAttempts === 2) attemptsFinished.resolve();
        return result;
      },
      analysisCapacity,
      typeScriptRevisionShardMode: "admitted",
      experimentalPrRevisionCache: false,
      repositoryAnalysis,
    }));

    const first = generatePr("first-pr", BODY);
    const second = generatePr("second-pr", SECOND_BODY);
    await attemptsFinished.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));

    const trailingWork = vi.fn(() => "trailing");
    const trailing = coordinator.run("trailing", ({ runAnalysis }) => runAnalysis(trailingWork));
    await new Promise<void>((resolve) => setImmediate(resolve));
    const trailingStartedWhileFenceHeld = trailingWork.mock.calls.length === 1;
    const reservationsBeforeRelease = [...reservations.values()].flat();
    const activeBeforeRelease = active;

    releaseLock.resolve();
    await lockOwner;
    const [firstResult, secondResult, trailingResult] = await Promise.all([first, second, trailing]);
    await coordinator.close();

    expect(trailingStartedWhileFenceHeld).toBe(true);
    expect(trailingResult).toBe("trailing");
    expect(reservationsBeforeRelease).toEqual([1, 1]);
    expect(activeBeforeRelease).toBe(0);
    expect(reservations.get("first-pr")).toEqual([1]);
    expect(reservations.get("second-pr")).toEqual([1]);
    expect(firstResult.cache).toBe("miss");
    expect(secondResult.cache).toBe("miss");
    expect(repositoryAnalysis).toHaveBeenCalledTimes(4);
    expect(maximumActive).toBe(1);
  });

  it("bounds sustained host-fence arrivals and cleans the rejected prepared request", async () => {
    const lockHeld = deferred<void>();
    const releaseLock = deferred<void>();
    const lockOwner = withTypeScriptRevisionShardBuildLock(
      cacheRoot,
      undefined,
      async () => {
        lockHeld.resolve();
        await releaseLock.promise;
      },
    );
    await lockHeld.promise;

    const coordinator = new AnalysisCoordinator({
      maxConcurrentAnalyses: 2,
      maxQueuedCoordinations: 1,
    });
    const firstFenceWaiterStarted = deferred<void>();
    const secondCoordinationRequested = deferred<void>();
    const coordinationStarts: string[] = [];
    let activeFenceWaiters = 0;
    let maximumFenceWaiters = 0;
    const repositoryAnalysis = vi.fn(runRepositoryAnalysisChildInProcess);
    const generatePr = (
      key: string,
      body: Parameters<typeof cachedPrGraph>[0]["body"],
    ) => coordinator.run(key, async ({
      analysisCapacity,
      signal,
      runPreparation,
      runCoordination,
      runAnalysis,
    }) => cachedPrGraph({
      cacheRoot,
      repositories,
      source: SOURCE,
      body,
      cwd: cacheRoot,
      signal,
      onStage: () => undefined,
      onRevisionComplete: () => undefined,
      runPreparation,
      runCoordination: (work) => {
        if (key === "second-pr") secondCoordinationRequested.resolve();
        return runCoordination(async (coordinationSignal, tryRunAnalysis) => {
          activeFenceWaiters += 1;
          maximumFenceWaiters = Math.max(maximumFenceWaiters, activeFenceWaiters);
          coordinationStarts.push(key);
          if (key === "first-pr") firstFenceWaiterStarted.resolve();
          try {
            return await work(coordinationSignal, tryRunAnalysis);
          } finally {
            activeFenceWaiters -= 1;
          }
        });
      },
      runAnalysis,
      analysisCapacity,
      typeScriptRevisionShardMode: "admitted",
      experimentalPrRevisionCache: false,
      repositoryAnalysis,
    }));

    const first = generatePr("first-pr", BODY);
    await firstFenceWaiterStarted.promise;
    const second = generatePr("second-pr", SECOND_BODY);
    await secondCoordinationRequested.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(coordinationStarts).toEqual(["first-pr"]);

    const overflow = generatePr("overflow-pr", BODY);
    await expect(overflow).rejects.toMatchObject({
      name: "AnalysisCoordinatorOverloadedError",
      phase: "coordination",
    });
    const trailingWork = vi.fn(() => "trailing");
    await expect(coordinator.run(
      "trailing-analysis",
      ({ runAnalysis: runTrailing }) => runTrailing(trailingWork),
    )).resolves.toBe("trailing");

    expect(trailingWork).toHaveBeenCalledTimes(1);
    expect(repositoryAnalysis).not.toHaveBeenCalled();
    expect(maximumFenceWaiters).toBe(1);
    expect(repositories.createdWorkspaces).toHaveLength(3);
    expect(repositories.discardedWorkspaceIds).toEqual([
      repositories.createdWorkspaces[2]!.workspaceId,
    ]);
    expect(existsSync(repositories.createdWorkspaces[2]!.root)).toBe(false);
    expect(repositories.activeLeaseCount).toBe(4);
    expect(readdirSync(join(cacheRoot, "pr-staging"))).toHaveLength(2);

    releaseLock.resolve();
    await lockOwner;
    const [firstResult, secondResult] = await Promise.all([first, second]);
    await coordinator.close();

    expect(firstResult.cache).toBe("miss");
    expect(secondResult.cache).toBe("miss");
    expect(coordinationStarts).toEqual(["first-pr", "second-pr"]);
    expect(maximumFenceWaiters).toBe(1);
    expect(activeFenceWaiters).toBe(0);
    expect(repositoryAnalysis).toHaveBeenCalledTimes(4);
  });

  it("does not hold the admitted shard fence while queued for local analysis capacity", async () => {
    const coordinator = new AnalysisCoordinator({ maxConcurrentAnalyses: 1 });
    const blockerStarted = deferred<void>();
    const releaseBlocker = deferred<void>();
    const blocker = coordinator.run("blocker", ({ runAnalysis }) => runAnalysis(async () => {
      blockerStarted.resolve();
      await releaseBlocker.promise;
      return "blocker";
    }));
    await blockerStarted.promise;

    const localAdmissionRequested = deferred<void>();
    const repositoryAnalysis = vi.fn(runRepositoryAnalysisChildInProcess);
    const pr = coordinator.run("pr", async ({
      analysisCapacity,
      signal,
      runPreparation,
      runCoordination,
      runAnalysis,
    }) => cachedPrGraph({
      cacheRoot,
      repositories,
      source: SOURCE,
      body: BODY,
      cwd: cacheRoot,
      signal,
      onStage: () => undefined,
      onRevisionComplete: () => undefined,
      runPreparation,
      runCoordination,
      runAnalysis: (work, options) => {
        localAdmissionRequested.resolve();
        return runAnalysis(work, options);
      },
      analysisCapacity,
      typeScriptRevisionShardMode: "admitted",
      experimentalPrRevisionCache: true,
      repositoryAnalysis,
    }));

    await localAdmissionRequested.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    const fenceProbe = await tryWithTypeScriptRevisionShardBuildLock(
      cacheRoot,
      undefined,
      async () => "available",
    );
    const analysisCallsWhileLocalCapacityBusy = repositoryAnalysis.mock.calls.length;

    releaseBlocker.resolve();
    const [blockerResult, prResult] = await Promise.all([blocker, pr]);
    await coordinator.close();

    expect(fenceProbe).toBe("available");
    expect(analysisCallsWhileLocalCapacityBusy).toBe(0);
    expect(blockerResult).toBe("blocker");
    expect(prResult.cache).toBe("miss");
    expect(repositoryAnalysis).toHaveBeenCalledTimes(2);
  });

  it("keeps the admitted pair merge-base-first when memory policy exposes one slot", async () => {
    const releaseFirst = deferred<void>();
    const firstStarted = deferred<void>();
    let active = 0;
    let started = 0;
    let maximumActive = 0;
    const repositoryAnalysis = vi.fn(async (...args: Parameters<typeof runRepositoryAnalysisChildInProcess>) => {
      started += 1;
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      if (started === 1) {
        firstStarted.resolve();
        await releaseFirst.promise;
      }
      try {
        return await runRepositoryAnalysisChildInProcess(...args);
      } finally {
        active -= 1;
      }
    });
    const reservations: number[] = [];
    const stages: string[] = [];
    const completedLanes: Array<"head" | "mergeBase"> = [];

    const generated = generate(
      false,
      BODY,
      stages,
      SOURCE,
      repositoryAnalysis,
      async (work, options) => {
        reservations.push(options?.slots ?? 1);
        return work(new AbortController().signal);
      },
      "admitted",
      true,
      1,
      completedLanes,
    );
    await firstStarted.promise;
    await Promise.resolve();
    expect(started).toBe(1);
    releaseFirst.resolve();
    await generated;

    expect(maximumActive).toBe(1);
    expect(started).toBe(2);
    expect(reservations).toEqual([1]);
    expect(stages).toEqual([
      "clone", "checkout", "extract", "extract-merge-base", "extract-head",
    ]);
    expect(completedLanes).toEqual(["mergeBase", "head"]);
  });

  it("keeps a materialized empty comparison sequential because it depends on HEAD hints", async () => {
    const subdir = "packages/new-app";
    repositories.materialize = (_inputs, workspace) => {
      mkdirSync(join(workspace.headDir, subdir), { recursive: true });
      writeFileSync(
        join(workspace.headDir, subdir, "index.ts"),
        "export const added = true;\n",
      );
    };
    const stages: string[] = [];
    const reservations: number[] = [];
    const completedLanes: Array<"head" | "mergeBase"> = [];
    let active = 0;
    let maximumActive = 0;
    const repositoryAnalysis = vi.fn(async (...args: Parameters<typeof runRepositoryAnalysisChildInProcess>) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      try {
        return await runRepositoryAnalysisChildInProcess(...args);
      } finally {
        active -= 1;
      }
    });

    const result = await generate(
      false,
      BODY,
      stages,
      { ...SOURCE, subdir },
      repositoryAnalysis,
      async (work, options) => {
        reservations.push(options?.slots ?? 1);
        return work(new AbortController().signal);
      },
      undefined,
      true,
      2,
      completedLanes,
    );

    expect(result.cache).toBe("miss");
    expect(reservations).toEqual([1]);
    expect(stages).toEqual([
      "clone", "checkout", "extract", "extract-head", "extract-merge-base",
    ]);
    expect(completedLanes).toEqual(["head", "mergeBase"]);
    expect(repositoryAnalysis).toHaveBeenCalledTimes(2);
    expect(maximumActive).toBe(1);
    expect(repositoryAnalysis.mock.calls[1]?.[0]).toMatchObject({
      allowEmpty: true,
      hintedFiles: ["src/added.ts"],
    });
  });

  it("does not start HEAD when merge-base seeding fails and cleans pair staging", async () => {
    let started = 0;
    const failure = new Error("merge-base extraction failed");
    const repositoryAnalysis = vi.fn(async (
      request: Parameters<typeof runRepositoryAnalysisChildInProcess>[0],
    ) => {
      started += 1;
      expect(request.changedSince).toBeUndefined();
      throw failure;
    });
    const stages: string[] = [];

    const generated = generate(
      false,
      BODY,
      stages,
      SOURCE,
      repositoryAnalysis as never,
      async (work) => work(new AbortController().signal),
      "admitted",
      true,
      2,
    );

    await expect(generated).rejects.toBe(failure);
    expect(started).toBe(1);
    expect(stages).toEqual([
      "clone", "checkout", "extract", "extract-merge-base",
    ]);
    expect(existsSync(join(cacheRoot, "pr-staging"))).toBe(true);
    expect(readdirSync(join(cacheRoot, "pr-staging"))).toEqual([]);
    const pairCache = join(cacheRoot, "pr-artifacts");
    expect(existsSync(pairCache) ? readdirSync(pairCache) : []).toEqual([]);
  });

  it("keeps cross-pair revision reuse disabled unless the server opts in", async () => {
    const repositoryAnalysis = vi.fn(runRepositoryAnalysisChildInProcess);
    const firstStages: string[] = [];
    const first = await generate(
      false,
      BODY,
      firstStages,
      SOURCE,
      repositoryAnalysis,
      undefined,
      undefined,
      false,
    );
    const siblingStages: string[] = [];
    const sibling = await generate(
      false,
      SECOND_BODY,
      siblingStages,
      SOURCE,
      repositoryAnalysis,
      undefined,
      undefined,
      false,
    );

    expect(first.cache).toBe("miss");
    expect(sibling.cache).toBe("miss");
    expect(first.comparisonMaterial.path).not.toBe(sibling.comparisonMaterial.path);
    expect(firstStages).toEqual([
      "clone", "checkout", "extract", "extract-head", "extract-merge-base",
    ]);
    expect(siblingStages).toEqual([
      "clone", "checkout", "extract", "extract-head", "extract-merge-base",
    ]);
    expect(repositoryAnalysis).toHaveBeenCalledTimes(4);
  });

  it("does not traverse an older shared pair snapshot after the server disables the feature", async () => {
    const repositoryAnalysis = vi.fn(runRepositoryAnalysisChildInProcess);
    const shared = await generate(false, BODY, [], SOURCE, repositoryAnalysis);
    const localStages: string[] = [];
    const local = await generate(
      false,
      BODY,
      localStages,
      SOURCE,
      repositoryAnalysis,
      undefined,
      undefined,
      false,
    );

    expect(shared.artifactMaterial.path).toContain(join("pr-revision-artifacts", "objects"));
    expect(local.cache).toBe("miss");
    expect(local.artifactMaterial.path).toContain(`${join("pr-artifacts", "")}`);
    expect(local.artifactMaterial.path).toContain(`${join("snapshots", "")}`);
    expect(local.artifactMaterial.path).not.toContain("pr-revision-artifacts");
    expect(localStages).toEqual([
      "clone", "checkout", "extract", "extract-head", "extract-merge-base",
    ]);
    expect(repositoryAnalysis).toHaveBeenCalledTimes(4);
  });

  it("injects server-owned shard policy for both exact PR roots without reading it from the PR body", async () => {
    const treeOid = "e".repeat(64);
    vi.mocked(runGit).mockImplementation(async (args, options) => {
      if (args[0] === "ls-remote") {
        return `${BASE_SHA}\trefs/heads/main\n${HEAD_SHA}\trefs/pull/41/head\n`;
      }
      if (args[0] === "rev-parse") {
        const commit = basename(options.cwd) === "head" ? HEAD_SHA : MERGE_BASE_SHA;
        return `${options.cwd}\n${commit}\n${treeOid}\n`;
      }
      return "";
    });
    let active = 0;
    let maximumActive = 0;
    const repositoryAnalysis = vi.fn(async (...args: Parameters<typeof runRepositoryAnalysisChildInProcess>) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      try {
        return await runRepositoryAnalysisChildInProcess(...args);
      } finally {
        active -= 1;
      }
    });
    const reservations: number[] = [];

    await generate(
      false,
      BODY,
      [],
      SOURCE,
      repositoryAnalysis,
      async (work, options) => {
        reservations.push(options?.slots ?? 1);
        return work(new AbortController().signal);
      },
      "shadow",
      true,
      2,
    );

    expect(repositoryAnalysis).toHaveBeenCalledTimes(2);
    expect(reservations).toEqual([1]);
    expect(maximumActive).toBe(1);
    for (const [, options] of repositoryAnalysis.mock.calls) {
      expect(options.typeScriptRevisionShards).toMatchObject({
        version: 1,
        mode: "shadow",
        admission: expect.objectContaining({
          kind: "signer",
          keyId: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
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
  typeScriptRevisionShardMode?: "empty" | "shadow" | "admitted" | "verified-experimental",
  experimentalPrRevisionCache = true,
  analysisCapacity = 1,
  completedLanes: Array<"head" | "mergeBase"> = [],
  extractionProgress?: RepositoryAnalysisProgress[],
) {
  return cachedPrGraph({
    cacheRoot,
    repositories,
    source,
    body,
    cwd: cacheRoot,
    refresh,
    onStage: (stage) => { stages.push(stage); },
    onRevisionComplete: (lane) => { completedLanes.push(lane); },
    ...(extractionProgress === undefined
      ? {}
      : { onExtractionProgress: (progress: RepositoryAnalysisProgress) => {
          extractionProgress.push(progress);
        } }),
    runPreparation: async (work) => work(new AbortController().signal),
    runCoordination: async (work) => work(
      new AbortController().signal,
      async (analysis, options) => ({
        kind: "admitted",
        value: await runAnalysis(analysis, options),
      }),
    ),
    runAnalysis,
    analysisCapacity,
    typeScriptRevisionShardMode,
    experimentalPrRevisionCache,
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
