/**
 * POST /api/pr/analyze behaviour with a structural repository mirror and mocked extraction — no
 * network, no real Git. Pins progress, two-sided revision semantics, restart hits, invalidation,
 * cancellation, singleflight publication, source-lease ownership, and failed-stage cleanup.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { Readable, Writable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { buildNodeId, SCHEMA_VERSION } from "@meridian/core";
import type { GraphArtifact, GraphProjectionV1 } from "@meridian/core";
import { analyzeRepository, REPOSITORY_ANALYSIS_VERSION } from "../repository-analysis";
import { runGit } from "./git-exec";
import { handlePrAnalyze, handlePrPrepare } from "./web-pr-analyze";
import type { Context } from "./web-server";
import type { ArtifactSource } from "./web-source";
import { SessionStore } from "./session";
import { sendJson } from "./http-response";
import { sendGraph } from "./web-graph";
import { WebError } from "./web-error";
import {
  parsePrAnalyzeRequest,
  PR_FULL_BASELINE_BENCHMARK_CAPABILITY,
  PR_FULL_BASELINE_BENCHMARK_HEADER,
} from "./web-pr-request";
import { createGitHubClient } from "./github";
import { materializeValidatedArtifact, WebGraphStore } from "./web-graph-store";
import type { GraphRetentionOptions } from "./web-graph-retention";
import { AnalysisCoordinator } from "./web-analysis-coordinator";
import type { AnalysisCoordinatorOptions } from "./web-analysis-coordinator";
import { WebGraphProjectCache } from "./web-graph-project-cache";
import {
  PrReviewHandoffRegistry,
  type PrReviewHandoffRegistryOptions,
} from "./web-pr-review-handoff";
import {
  GRAPH_PROJECTION_CACHE_HEADER,
  GRAPH_PROJECTION_KEY_HEADER,
  GRAPH_PROJECTION_READY_HEADER,
  handleGraphProject,
  handleGraphProjectWarm,
  handleGraphSymbols,
} from "./web-graph-project";
import type { GraphProjectWorkerRequest, GraphProjectWorkerResult } from "./web-graph-project-worker-job";
import {
  runRepositoryAnalysisChildInProcess,
  runRepositoryArtifactRestampChildInProcess,
} from "./repository-analysis-child-test-adapter";
import {
  loadSyntheticScenarios,
  runSyntheticScenarioInOci,
} from "./synthetic-execution";
import { syntheticSourceFingerprintForFiles } from "./synthetic-fingerprint";
import { FakePrRepositoryMirror } from "./pr-repository-mirror-test-fake";

vi.mock("../repository-analysis", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../repository-analysis")>();
  return { ...actual, analyzeRepository: vi.fn() };
});
vi.mock("./git-exec", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./git-exec")>();
  return { ...actual, runGit: vi.fn() };
});
vi.mock("./synthetic-execution", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./synthetic-execution")>();
  return {
    ...actual,
    loadSyntheticScenarios: vi.fn(() => []),
  };
});
vi.mock("./synthetic-fingerprint", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./synthetic-fingerprint")>();
  return { ...actual, syntheticSourceFingerprintForFiles: vi.fn(() => "fixture-fingerprint") };
});

const BODY = { id: "artifact", prNumber: 41, baseRef: "main", headRef: "feat/x", progressive: false };
const DIRECT_BODY = {
  repository: "org/repo",
  prNumber: 41,
  baseRef: "main",
  headRef: "feat/x",
};
const HEAD_SHA = "abc1234def5678900000aaaabbbbccccddddeeee";
const BASE_SHA = "def1234def5678900000aaaabbbbccccddddeeee";
const MERGE_BASE_SHA = "0123456789abcdef0123456789abcdef01234567";
const LEGACY_ANALYSIS_VERSION_WITHOUT_VALUE_CALLBACKS = 14;

const ARTIFACT = {
  schemaVersion: SCHEMA_VERSION,
  generatedAt: "2026-07-13T00:00:00.000Z",
  generator: { name: "meridian", version: "test" },
  target: {
    name: "org/repo",
    root: ".",
    language: "typescript",
    vcs: { repository: "https://github.com/org/repo.git", commit: HEAD_SHA, branch: BODY.headRef },
  },
  nodes: [],
  edges: [],
  extensions: {
    changedSince: {
      baseRef: MERGE_BASE_SHA,
      files: { "src/a.ts": [[1, 3]] },
      manifest: [
        { path: "assets/logo.png", status: "modified" },
        { path: "src/a.ts", status: "modified" },
        { path: "src/gone.ts", status: "deleted" },
        { path: "src/new.ts", status: "renamed", previousPath: "src/old.ts" },
      ],
    },
  },
} as unknown as GraphArtifact;

const COMPARISON_ARTIFACT = {
  ...ARTIFACT,
  generatedAt: "2026-07-12T00:00:00.000Z",
  target: {
    ...ARTIFACT.target,
    vcs: { repository: "https://github.com/org/repo.git", commit: MERGE_BASE_SHA },
  },
  extensions: {},
} as unknown as GraphArtifact;
let cacheRoot: string;
let activeGraphStores: WebGraphStore[];
let activeCoordinators: AnalysisCoordinator[];
let activeGraphProjectCaches: WebGraphProjectCache[];
let activePrReviewHandoffRegistries: PrReviewHandoffRegistry[];
let activeShutdownControllers: AbortController[];
let repositories: FakePrRepositoryMirror;

describe("handlePrAnalyze", () => {
  it("defaults an omitted delivery flag to the production partial-only contract", () => {
    expect(parsePrAnalyzeRequest({
      id: "artifact",
      prNumber: 41,
      baseRef: "main",
      headRef: "feat/x",
    }).progressive).toBe(true);
    expect(parsePrAnalyzeRequest(BODY).progressive).toBe(false);
  });

  beforeEach(() => {
    cacheRoot = mkdtempSync(join(tmpdir(), "meridian-pr-cache-test-"));
    activeGraphStores = [];
    activeCoordinators = [];
    activeGraphProjectCaches = [];
    activePrReviewHandoffRegistries = [];
    activeShutdownControllers = [];
    vi.stubEnv("GITHUB_TOKEN", "");
    vi.stubEnv("GH_TOKEN", "");
    repositories = new FakePrRepositoryMirror(cacheRoot, MERGE_BASE_SHA);
    repositories.materialize = (_inputs, workspace) => {
      writeFileSync(join(workspace.headDir, "head-source.ts"), "export const head = true;\n");
      writeFileSync(join(workspace.comparisonDir, "base-source.ts"), "export const base = true;\n");
    };
    mockGitRevisions();
    vi.mocked(analyzeRepository).mockImplementation(async (request) => {
      if (request.initialGraph !== undefined) {
        throw new Error("initial graph fixture is opt-in per test");
      }
      const template = request.changedSince ? ARTIFACT : COMPARISON_ARTIFACT;
      return {
        artifact: { ...template, target: { ...template.target, vcs: request.vcs } },
        warnings: request.changedSince ? ["w1"] : ["base warning"],
      } as never;
    });
    vi.mocked(loadSyntheticScenarios).mockReturnValue([]);
    vi.mocked(syntheticSourceFingerprintForFiles).mockReturnValue("fixture-fingerprint");
  });

  afterEach(async () => {
    for (const controller of activeShutdownControllers) controller.abort();
    await Promise.all(activePrReviewHandoffRegistries.map((registry) => registry.close()));
    await Promise.all(activeCoordinators.map((coordinator) => coordinator.close()));
    for (const cache of activeGraphProjectCaches) cache.dispose();
    for (const store of activeGraphStores) store.dispose();
    repositories.releaseAllForTest();
    rmSync(cacheRoot, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("rejects progressive:false in a normal app before graph or repository work", async () => {
    const ctx = githubCtx();
    ctx.benchmarkPrFullBaseline = false;
    const acquire = vi.spyOn(ctx.graphStore, "acquire");

    const captured = await invoke(ctx, BODY);

    expect(captured.status()).toBe(403);
    expect(captured.lines()).toEqual([{
      error: "complete PR graph baselines require the loopback benchmark capability",
    }]);
    expect(acquire).not.toHaveBeenCalled();
    expect(repositories.prepareCalls).toEqual([]);
    expect(runGit).not.toHaveBeenCalled();
  });

  it("rejects an unmarked progressive:false request even on a benchmark server", async () => {
    const ctx = githubCtx();
    const acquire = vi.spyOn(ctx.graphStore, "acquire");

    const captured = await invoke(ctx, BODY, {});

    expect(captured.status()).toBe(403);
    expect(acquire).not.toHaveBeenCalled();
    expect(repositories.prepareCalls).toEqual([]);
  });

  it("streams clone -> checkout -> HEAD -> merge-base -> done and registers the persistent checkout", async () => {
    const ctx = githubCtx();
    ctx.allowSyntheticExecution = true; // The local-only flag must never admit a PR artifact.
    const captured = await invoke(ctx, BODY);
    expect(captured.status()).toBe(200);
    expect(captured.contentType()).toContain("application/x-ndjson");
    const lines = captured.lines();
    expect(lines.map((line) => line.stage)).toEqual([
      "clone",
      "checkout",
      "extract",
      "extract-head",
      "lane-complete",
      "extract-merge-base",
      "lane-complete",
      "done",
    ]);
    expect(lines.filter((line) => line.stage === "lane-complete")).toEqual([
      { stage: "lane-complete", lane: "head" },
      { stage: "lane-complete", lane: "mergeBase" },
    ]);

    const done = lines.at(-1)!;
    expect(done.graphId).toMatch(/^pr-[0-9a-f]{12}-[0-9a-f]{40}$/);
    expect(done.comparisonGraphId).toMatch(/^pr-base-[0-9a-f]{12}-[0-9a-f]{40}$/);
    expect(done.headSha).toBe("abc1234def5678900000aaaabbbbccccddddeeee");
    expect(done.mergeBaseSha).toBe(MERGE_BASE_SHA);
    expect(String(done.graphId).endsWith(`-${done.headSha}`)).toBe(true);
    expect(String(done.comparisonGraphId).endsWith(`-${done.mergeBaseSha}`)).toBe(true);
    expect(done.counts).toEqual({ nodes: 0, edges: 0 });
    expect(done.changedFiles).toEqual([
      { path: "assets/logo.png", status: "modified" },
      { path: "src/a.ts", status: "modified" },
      { path: "src/gone.ts", status: "deleted" },
      { path: "src/new.ts", status: "renamed", previousPath: "src/old.ts" },
    ]);
    expect(done.warnings).toEqual(["w1", "base warning"]);

    const sourceDir = graphDescriptor(ctx, done.graphId as string).sourceRoot;
    expectWithoutReviewFingerprints(loadGraph(ctx, done.graphId as string), ARTIFACT);
    expectWithoutReviewFingerprints(loadGraph(ctx, done.comparisonGraphId as string), COMPARISON_ARTIFACT);
    expect(sourceDir).toContain(cacheRoot);
    expect(graphDescriptor(ctx, done.comparisonGraphId as string).sourceRoot).toContain(cacheRoot);
    expect(graphDescriptor(ctx, done.graphId as string).source).toMatchObject({ kind: "github", owner: "org", repo: "repo" });
    expect(graphDescriptor(ctx, done.graphId as string).synthetic).toEqual({
      scenarios: [],
      sourceFingerprint: null,
      trust: null,
    });
    expect(graphDescriptor(ctx, done.comparisonGraphId as string).source).toMatchObject({
      kind: "github",
      owner: "org",
      repo: "repo",
    });
    expect(existsSync(sourceDir)).toBe(true);
  });

  it("streams strict revision-scoped extraction detail under the active side stage", async () => {
    vi.mocked(analyzeRepository).mockImplementation(async (request) => {
      request.onExtractionProgress?.({
        language: "typescript",
        phase: "project-load",
        unit: { current: 1, total: 1, path: "." },
        sourceFile: null,
      });
      request.onExtractionProgress?.({
        language: "typescript",
        phase: "finalize",
        unit: null,
        sourceFile: null,
      });
      const template = request.changedSince ? ARTIFACT : COMPARISON_ARTIFACT;
      return {
        artifact: { ...template, target: { ...template.target, vcs: request.vcs } },
        warnings: [],
      } as never;
    });

    const lines = (await invoke(githubCtx(), BODY)).lines();
    const detailed = lines.filter((line) => line.progress !== undefined);
    expect(detailed).toHaveLength(4);
    expect(detailed.map((line) => line.stage)).toEqual([
      "extract-head",
      "extract-head",
      "extract-merge-base",
      "extract-merge-base",
    ]);
    expect(detailed.map((line) => (
      line.progress as { revision: unknown; phase: string }
    ).phase)).toEqual(["project-load", "finalize", "project-load", "finalize"]);
    expect(detailed.map((line) => (
      line.progress as { revision: { kind: string; commit: string; execution: unknown } }
    ).revision)).toEqual([
      { kind: "head", commit: HEAD_SHA, execution: { current: 1, total: 2 } },
      { kind: "head", commit: HEAD_SHA, execution: { current: 1, total: 2 } },
      { kind: "merge-base", commit: MERGE_BASE_SHA, execution: { current: 2, total: 2 } },
      { kind: "merge-base", commit: MERGE_BASE_SHA, execution: { current: 2, total: 2 } },
    ]);
  });

  it("ends progressive preparation at the accepted bounded pair without starting canonical extraction", async () => {
    vi.mocked(analyzeRepository).mockImplementation(async (request) => {
      const template = request.changedSince ? ARTIFACT : COMPARISON_ARTIFACT;
      return {
        artifact: { ...template, target: { ...template.target, vcs: request.vcs } },
        warnings: request.changedSince ? ["w1"] : ["base warning"],
      } as never;
    });
    const ctx = githubCtx(undefined, { maxConcurrentAnalyses: 1 });
    const repositoryAnalysis = vi.fn(ctx.repositoryAnalysis);
    ctx.repositoryAnalysis = repositoryAnalysis;
    const running = beginInvokePrepare(ctx, { ...DIRECT_BODY, headSha: HEAD_SHA });

    await vi.waitFor(() => expect(
      running.captured.lines().some((line) => line.stage === "ready"),
    ).toBe(true));
    const ready = running.captured.lines().find((line) => line.stage === "ready")!;
    expect(ready).toMatchObject({
      completeness: "provisional",
      pairId: expect.stringMatching(/^[a-f0-9]{20}$/),
      graphId: expect.stringMatching(/^pr-partial-/),
      comparisonGraphId: expect.stringMatching(/^pr-partial-base-/),
      initialProjectionCache: { ready: true, depth: 1, prefetchDepth: 3 },
      preparedPair: { completeness: "provisional" },
    });
    const earlyDestination = new URL(String(ready.viewUrl), "http://meridian.local");
    expect(earlyDestination.searchParams.get("partial")).toBe("1");
    expect(earlyDestination.searchParams.get("pair")).toBe(ready.pairId);
    const provisionalRequests = vi.mocked(analyzeRepository).mock.calls
      .map(([request]) => request)
      .filter((request) => request.initialGraph !== undefined);
    expect(provisionalRequests).toEqual([
      expect.objectContaining({
        changedSince: MERGE_BASE_SHA,
        initialGraph: { depth: 1 },
        vcs: { repository: "https://github.com/org/repo.git", commit: HEAD_SHA, branch: "feat/x" },
      }),
      expect.objectContaining({
        initialGraph: {
          depth: 1,
          seedFiles: ["assets/logo.png", "src/a.ts", "src/gone.ts", "src/old.ts"],
        },
        vcs: { repository: "https://github.com/org/repo.git", commit: MERGE_BASE_SHA },
      }),
    ]);

    await running.completion;
    const lines = running.captured.lines();
    expect(lines.findIndex((line) => line.stage === "ready"))
      .toBeLessThan(lines.findIndex((line) => line.stage === "done"));
    expect(lines.at(-1)).toMatchObject({
      stage: "done",
      completeness: "provisional",
      pairId: ready.pairId,
      graphId: ready.graphId,
      comparisonGraphId: ready.comparisonGraphId,
    });
    expect(vi.mocked(analyzeRepository).mock.calls.every(([request]) => (
      request.initialGraph !== undefined
    ))).toBe(true);
    expect(repositoryAnalysis.mock.calls.map(([, options]) => options.workerHeapMb)).toEqual([
      2_048,
      2_048,
    ]);
  });

  it("publishes distinct exact HEAD and merge-base root plans instead of the raw manifest", async () => {
    const headSeeds = Array.from(
      { length: 513 },
      (_, index) => `src/head-${String(index).padStart(3, "0")}.ts`,
    );
    const baseSeeds = Array.from(
      { length: 513 },
      (_, index) => `src/base-${String(index).padStart(3, "0")}.ts`,
    );
    vi.mocked(analyzeRepository).mockImplementation(async (request) => {
      const template = request.changedSince ? ARTIFACT : COMPARISON_ARTIFACT;
      const seeds = request.changedSince ? headSeeds : baseSeeds;
      return {
        artifact: {
          ...template,
          target: { ...template.target, vcs: request.vcs },
          extensions: {
            ...(template.extensions ?? {}),
            prInitialGraph: {
              version: 1,
              complete: false,
              depth: 1,
              seedFiles: seeds,
              selectedFiles: seeds,
              frontierFiles: seeds,
            },
          },
        },
        warnings: [],
      } as never;
    });
    const ctx = githubCtx(undefined, { maxConcurrentAnalyses: 1 });
    const running = beginInvokePrepare(ctx, { ...DIRECT_BODY, headSha: HEAD_SHA });
    await running.completion;
    const ready = running.captured.lines().find((line) => line.stage === "ready")!;

    expect(graphDescriptor(ctx, String(ready.graphId)).projectionRootChunks).toEqual([
      headSeeds.slice(0, 512),
      headSeeds.slice(512),
    ]);
    expect(graphDescriptor(ctx, String(ready.comparisonGraphId)).projectionRootChunks).toEqual([
      baseSeeds.slice(0, 512),
      baseSeeds.slice(512),
    ]);
    expect(headSeeds).not.toContain("assets/logo.png");
  });

  it("releases every joined foreground waiter at the bounded terminal", async () => {
    vi.mocked(analyzeRepository).mockImplementation(async (request) => {
      const template = request.changedSince ? ARTIFACT : COMPARISON_ARTIFACT;
      return {
        artifact: { ...template, target: { ...template.target, vcs: request.vcs } },
        warnings: [],
      } as never;
    });
    const ctx = githubCtx(undefined, { maxConcurrentAnalyses: 1 });
    const first = beginInvokePrepare(ctx, { ...DIRECT_BODY, headSha: HEAD_SHA });
    const joined = beginInvokePrepare(ctx, { ...DIRECT_BODY, headSha: HEAD_SHA });

    await vi.waitFor(() => expect([
      first.captured.lines().some((line) => line.stage === "ready"),
      joined.captured.lines().some((line) => line.stage === "ready"),
    ]).toEqual([true, true]));
    const ready = first.captured.lines().find((line) => line.stage === "ready")!;

    await Promise.all([first.completion, joined.completion]);
    // Both preparation waiters have finished and released foreground ownership; symbol indexing now
    // enters the ordinary bounded analysis lane.
    await expect(invokeSymbols(ctx, String(ready.graphId))).resolves.toMatchObject({
      status: 200,
      json: {
        graphId: ready.graphId,
        complete: true,
      },
    });
    expect(first.captured.lines().at(-1)).toMatchObject({ stage: "done", completeness: "provisional" });
    expect(joined.captured.lines().at(-1)).toMatchObject({ stage: "done", completeness: "provisional" });
  });

  it("finishes bounded cleanup without publishing a canonical pair after landing navigation", async () => {
    vi.mocked(analyzeRepository).mockImplementation(async (request) => {
      const template = request.changedSince ? ARTIFACT : COMPARISON_ARTIFACT;
      return {
        artifact: { ...template, target: { ...template.target, vcs: request.vcs } },
        warnings: [],
      } as never;
    });
    const ctx = githubCtx(undefined, { maxConcurrentAnalyses: 1 });
    const publishBatch = vi.spyOn(ctx.graphStore, "publishBatch");
    const landing = beginInvokePrepare(ctx, { ...DIRECT_BODY, headSha: HEAD_SHA });

    await vi.waitFor(() => expect(
      landing.captured.lines().some((line) => line.stage === "ready"),
    ).toBe(true));
    landing.request.emit("aborted");
    await landing.completion;

    const deliveredDone = landing.captured.lines().find((line) => line.stage === "done");
    if (deliveredDone !== undefined) {
      expect(deliveredDone).toMatchObject({ completeness: "provisional" });
    }
    expect(publishBatch).toHaveBeenCalledTimes(1);
    expect(publishBatch.mock.calls[0]![0].map(({ id }) => id)).toEqual([
      expect.stringMatching(/^pr-partial-/),
      expect.stringMatching(/^pr-partial-base-/),
    ]);
    expect(publishBatch.mock.calls[0]![1]).toEqual({
      receipt: true,
      publicationHandoffTtlMs: 60_000,
    });
    expect(vi.mocked(analyzeRepository).mock.calls.every(([request]) => request.initialGraph !== undefined)).toBe(true);
    expect(ctx.graphStore.stats()).toMatchObject({ registrations: 3, sourceLeases: 2 });
    expect(repositories.activeLeaseCount).toBe(2);
    await expect(ctx.analysisCoordinator.run(
      "after-service-owned-pr-completion",
      ({ runAnalysis }) => runAnalysis(async () => "drained"),
    )).resolves.toBe("drained");
  });

  it("reuses a delayed landing pair after its publication handoff TTL while registrations survive", async () => {
    vi.mocked(analyzeRepository).mockImplementation(async (request) => {
      const template = request.changedSince ? ARTIFACT : COMPARISON_ARTIFACT;
      return {
        artifact: { ...template, target: { ...template.target, vcs: request.vcs } },
        warnings: [],
      } as never;
    });
    let now = Date.parse("2026-08-03T12:00:00.000Z");
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const ctx = githubCtx(
      undefined,
      { maxConcurrentAnalyses: 1 },
      {},
      false,
      { readyTtlMs: 5, claimTtlMs: 5 },
    );

    const first = (await invokePrepare(ctx, { ...DIRECT_BODY, headSha: HEAD_SHA })).lines();
    const firstReady = first.find((line) => line.stage === "ready")!;
    const analysisCalls = vi.mocked(analyzeRepository).mock.calls.length;
    expect(firstReady).toMatchObject({ completeness: "provisional", cache: "miss" });
    now += 60_001;
    await vi.waitFor(() => expect(ctx.prReviewHandoffs.stats().activePairs).toBe(0));
    const projectionCacheAcquire = vi.spyOn(ctx.graphProjectCache, "acquire");

    // The publication is now retention-eligible, but it still exists. Its server-owned metadata
    // must remain reusable so a long render/control measurement cannot manufacture a new graph id.
    const delayed = (await invokePrepare(ctx, { ...DIRECT_BODY, headSha: HEAD_SHA })).lines();

    expect(delayed.map((line) => line.stage)).toEqual(["ready", "done"]);
    expect(delayed[0]).toMatchObject({
      cache: "hit",
      graphId: firstReady.graphId,
      comparisonGraphId: firstReady.comparisonGraphId,
      pairId: firstReady.pairId,
    });
    expect(delayed[1]).toMatchObject({
      cache: "hit",
      graphId: firstReady.graphId,
      comparisonGraphId: firstReady.comparisonGraphId,
      pairId: firstReady.pairId,
    });
    expect(vi.mocked(analyzeRepository)).toHaveBeenCalledTimes(analysisCalls);
    expect(repositories.prepareCalls).toHaveLength(1);
    // Revalidation must re-prove and claim both initial projections; the first browser's expired
    // capability cannot confer resource ownership on this later, independent navigation.
    expect(projectionCacheAcquire).toHaveBeenCalled();
    nowSpy.mockRestore();
  });

  it("enforces a picker-pinned head for a waiter joining an unpinned progressive job", async () => {
    const releaseCanonical = deferred<void>();
    vi.mocked(analyzeRepository).mockImplementation(async (request) => {
      const template = request.changedSince ? ARTIFACT : COMPARISON_ARTIFACT;
      if (request.initialGraph === undefined && request.changedSince) {
        await releaseCanonical.promise;
      }
      return {
        artifact: { ...template, target: { ...template.target, vcs: request.vcs } },
        warnings: [],
      } as never;
    });
    const ctx = githubCtx(undefined, { maxConcurrentAnalyses: 1 });
    const live = beginInvoke(ctx, { ...BODY, progressive: true });
    await vi.waitFor(() => expect(
      live.captured.lines().some((line) => line.stage === "ready"),
    ).toBe(true));

    const stalePicker = beginInvokePrepare(ctx, {
      ...DIRECT_BODY,
      headSha: "f".repeat(40),
    });
    await stalePicker.completion;

    expect(stalePicker.captured.lines().some((line) => line.stage === "ready")).toBe(false);
    expect(stalePicker.captured.lines().at(-1)).toEqual({
      stage: "error",
      message: "the pull request head changed after it was selected; refresh and try again",
    });
    expect(repositories.prepareCalls).toHaveLength(1);

    releaseCanonical.resolve();
    await live.completion;
    expect(live.captured.lines().at(-1)?.stage).toBe("done");
  });

  it("publishes the manifest before the exact boot pair and delivers done only after both are reserved", async () => {
    vi.mocked(analyzeRepository).mockImplementation(async (request) => {
      const template = request.changedSince ? ARTIFACT : COMPARISON_ARTIFACT;
      return {
        artifact: { ...template, target: { ...template.target, vcs: request.vcs } },
        warnings: request.changedSince ? ["w1"] : ["base warning"],
      } as never;
    });
    const ctx = githubCtx();
    const originalGraphProject = ctx.graphProject;
    const releaseProjections = deferred<void>();
    const graphProject = vi.fn(async (
      request: GraphProjectWorkerRequest,
      options: Parameters<Context["graphProject"]>[1] = {},
    ) => {
      await releaseProjections.promise;
      return originalGraphProject(request, options);
    });
    ctx.graphProject = graphProject;
    const running = beginInvokePrepare(ctx, { ...DIRECT_BODY, headSha: HEAD_SHA });

    await vi.waitFor(() => expect(graphProject).toHaveBeenCalledTimes(2));
    expect(running.captured.lines().some((line) => line.stage === "manifest-ready")).toBe(true);
    expect(running.captured.lines().some((line) => line.stage === "done")).toBe(false);
    releaseProjections.resolve();
    await running.completion;
    expect(graphProject).toHaveBeenCalledTimes(2);
    expect(graphProject.mock.calls.map(([request]) => request.projection)).toEqual([
      expect.objectContaining({
        graphId: expect.stringMatching(/^pr-/),
        roots: { kind: "changed-files", seedGraphId: expect.stringMatching(/^pr-/) },
        requestedDepth: 1,
        prefetchDepth: 3,
      }),
      expect.objectContaining({
        graphId: expect.stringMatching(/^pr-partial-base-/),
        roots: { kind: "changed-files", seedGraphId: expect.stringMatching(/^pr-/) },
        requestedDepth: 1,
        prefetchDepth: 3,
      }),
    ]);
    const captured = running.captured;

    expect(captured.status()).toBe(200);
    const lines = captured.lines();
    const manifestReady = lines.find((line) => line.stage === "manifest-ready");
    expect(Object.keys(manifestReady ?? {}).sort()).toEqual([
      "baseSha",
      "changedFiles",
      "headSha",
      "mergeBaseSha",
      "stage",
    ]);
    expect(manifestReady).toEqual({
      stage: "manifest-ready",
      headSha: HEAD_SHA,
      baseSha: BASE_SHA,
      mergeBaseSha: MERGE_BASE_SHA,
      changedFiles: [
        { path: "assets/logo.png", status: "modified" },
        { path: "src/a.ts", status: "modified" },
        { path: "src/gone.ts", status: "deleted" },
        { path: "src/new.ts", status: "renamed", previousPath: "src/old.ts" },
      ],
    });
    expect(lines.indexOf(manifestReady!)).toBeLessThan(lines.length - 1);
    expect(lines.at(-1)).toMatchObject({
      stage: "done",
      completeness: "provisional",
      graphId: expect.stringMatching(/^pr-partial-/),
      comparisonGraphId: expect.stringMatching(/^pr-partial-base-/),
      headSha: HEAD_SHA,
      baseSha: BASE_SHA,
      mergeBaseSha: MERGE_BASE_SHA,
      preparedPair: {
        version: 1,
        prNumber: 41,
        completeness: "provisional",
        headGraphId: expect.stringMatching(/^pr-partial-/),
        mergeBaseGraphId: expect.stringMatching(/^pr-partial-base-/),
        headSha: HEAD_SHA,
        baseSha: BASE_SHA,
        mergeBaseSha: MERGE_BASE_SHA,
      },
      initialProjectionCache: {
        version: 1,
        depth: 1,
        prefetchDepth: 3,
        headKey: expect.stringMatching(/^[a-f0-9]{64}$/),
        comparisonKey: expect.stringMatching(/^[a-f0-9]{64}$/),
        ready: true,
      },
    });
    const done = lines.at(-1)!;
    expect(manifestReady?.changedFiles).toEqual(done.changedFiles);
    const destination = new URL(String(done.viewUrl), "http://meridian.local");
    expect(destination.pathname).toBe("/view");
    expect(destination.searchParams.get("id")).toBe(done.graphId);
    expect(destination.searchParams.get("prn")).toBe("41");
    expect(destination.searchParams.get("rev")).toBe("1");
    expect(destination.searchParams.get("progressive")).toBe("1");
    expect(destination.searchParams.get("partial")).toBe("1");
    expect(destination.searchParams.get("pair")).toBe(done.pairId);

    for (const graphId of [String(done.graphId), String(done.comparisonGraphId)]) {
      const registration = ctx.graphStore.acquire(graphId);
      expect(registration?.descriptor.rawGraphPayload).toBe("projection-only");
      registration?.release();

      const raw = capturedResponse();
      await sendGraph(ctx, raw.response, graphId);
      expect(raw.status()).toBe(409);
      expect(JSON.parse(raw.body())).toEqual({
        error: "raw graph payload is unavailable for a projection-only graph",
      });
    }

    const initialProjectionCache = done.initialProjectionCache as {
      headKey: string;
      comparisonKey: string;
    };
    const headProjection = await invokeProjection(ctx, {
      version: 1,
      graphId: done.graphId,
      roots: { kind: "changed-files", seedGraphId: done.graphId },
      requestedDepth: 1,
      prefetchDepth: 3,
    });
    const comparisonProjection = await invokeProjection(ctx, {
      version: 1,
      graphId: done.comparisonGraphId,
      roots: { kind: "changed-files", seedGraphId: done.graphId },
      requestedDepth: 1,
      prefetchDepth: 3,
    });
    expect(headProjection).toMatchObject({
      status: 200,
      headers: {
        [GRAPH_PROJECTION_CACHE_HEADER]: "hit",
        [GRAPH_PROJECTION_KEY_HEADER]: initialProjectionCache.headKey,
        [GRAPH_PROJECTION_READY_HEADER]: "true",
      },
    });
    expect(comparisonProjection).toMatchObject({
      status: 200,
      headers: {
        [GRAPH_PROJECTION_CACHE_HEADER]: "hit",
        [GRAPH_PROJECTION_KEY_HEADER]: initialProjectionCache.comparisonKey,
        [GRAPH_PROJECTION_READY_HEADER]: "true",
      },
    });
    expect(graphProject).toHaveBeenCalledTimes(2);

    const analysisCallsAfterBoundedTerminal = vi.mocked(analyzeRepository).mock.calls.length;
    const warm = (await invokePrepare(ctx, { ...DIRECT_BODY, headSha: HEAD_SHA })).lines();
    expect(warm.map((line) => line.stage)).toEqual(["ready", "done"]);
    expect(warm[0]).toMatchObject({ completeness: "provisional", cache: "hit" });
    expect(warm[1]).toMatchObject({ completeness: "provisional", cache: "hit" });
    expect(warm[0]?.changedFiles).toEqual(warm[1]?.changedFiles);
    expect(warm[1]?.initialProjectionCache).toMatchObject({ ready: true, depth: 1, prefetchDepth: 3 });
    expect(graphProject).toHaveBeenCalledTimes(2);
    expect(vi.mocked(analyzeRepository)).toHaveBeenCalledTimes(analysisCallsAfterBoundedTerminal);
    expect(repositories.prepareCalls).toHaveLength(1);
  });

  it("gives concurrent evidence and landing subscribers the same progressive pair terminal", async () => {
    vi.mocked(analyzeRepository).mockImplementation(async (request) => {
      const template = request.changedSince ? ARTIFACT : COMPARISON_ARTIFACT;
      return {
        artifact: { ...template, target: { ...template.target, vcs: request.vcs } },
        warnings: [],
      } as never;
    });
    const ctx = githubCtx();
    const originalGraphProject = ctx.graphProject;
    const releaseProjections = deferred<void>();
    const graphProject = vi.fn(async (
      request: GraphProjectWorkerRequest,
      options: Parameters<Context["graphProject"]>[1] = {},
    ) => {
      await releaseProjections.promise;
      return originalGraphProject(request, options);
    });
    ctx.graphProject = graphProject;

    const evidenceSubscriber = beginInvokePrepare(ctx, { ...DIRECT_BODY, headSha: HEAD_SHA });
    await vi.waitFor(() => expect(graphProject).toHaveBeenCalledTimes(2));
    const landingSubscriber = beginInvokePrepare(ctx, { ...DIRECT_BODY, headSha: HEAD_SHA });
    await vi.waitFor(() => expect(
      landingSubscriber.captured.lines().some((line) => line.stage === "manifest-ready"),
    ).toBe(true));
    expect(landingSubscriber.captured.lines().some((line) => line.stage === "done")).toBe(false);

    releaseProjections.resolve();
    await Promise.all([evidenceSubscriber.completion, landingSubscriber.completion]);
    expect(graphProject).toHaveBeenCalledTimes(2);
    const terminals = [evidenceSubscriber, landingSubscriber].map(({ captured }) => captured.lines().at(-1)!);
    for (const terminal of terminals) {
      expect(terminal).toMatchObject({
        stage: "done",
        initialProjectionCache: {
          version: 1,
          depth: 1,
          prefetchDepth: 3,
          headKey: expect.stringMatching(/^[a-f0-9]{64}$/),
          comparisonKey: expect.stringMatching(/^[a-f0-9]{64}$/),
          ready: true,
        },
      });
      expect(new URL(String(terminal.viewUrl), "http://meridian.local").searchParams.get("progressive"))
        .toBe("1");
    }
    expect(terminals[0]?.initialProjectionCache).toEqual(terminals[1]?.initialProjectionCache);
    expect(graphProject).toHaveBeenCalledTimes(2);
    expect(ctx.graphProjectCache.stats()).toMatchObject({ entries: 2, pins: 2 });
  });

  it("prepares two independent PR-review pairs concurrently without superseding either handoff", async () => {
    vi.mocked(analyzeRepository).mockImplementation(async (request) => {
      const template = request.changedSince ? ARTIFACT : COMPARISON_ARTIFACT;
      return {
        artifact: { ...template, target: { ...template.target, vcs: request.vcs } },
        warnings: [],
      } as never;
    });
    const ctx = githubCtx();
    const originalGraphProject = ctx.graphProject;
    const releaseFirstPair = deferred<void>();
    const releaseSecondPair = deferred<void>();
    let projectionCallCount = 0;
    const graphProject = vi.fn(async (
      request: GraphProjectWorkerRequest,
      options: Parameters<Context["graphProject"]>[1] = {},
    ) => {
      projectionCallCount += 1;
      await (projectionCallCount <= 2 ? releaseFirstPair.promise : releaseSecondPair.promise);
      return originalGraphProject(request, options);
    });
    ctx.graphProject = graphProject;

    const first = beginInvokePrepare(ctx, { ...DIRECT_BODY, headSha: HEAD_SHA });
    let second: ReturnType<typeof beginInvokePrepare> | undefined;
    try {
      await vi.waitFor(() => expect(graphProject).toHaveBeenCalledTimes(2));
      second = beginInvokePrepare(ctx, {
        ...DIRECT_BODY,
        prNumber: 42,
        headRef: "feat/second",
        headSha: HEAD_SHA,
      });
      await vi.waitFor(() => expect(second!.captured.lines().length).toBeGreaterThan(0));
      // The two large projection workers already consume the configured analysis capacity. The
      // second extraction waits here by design, without cancelling or replacing the first review.
      expect(graphProject).toHaveBeenCalledTimes(2);
      expect(second.captured.lines().some((line) => line.stage === "done")).toBe(false);

      releaseFirstPair.resolve();
      await vi.waitFor(() => expect(graphProject).toHaveBeenCalledTimes(4));
      expect(ctx.prReviewHandoffs.stats()).toMatchObject({
        activePairs: 2,
        preparingPairs: 1,
        readyPairs: 1,
        queuedPairs: 0,
      });

      releaseSecondPair.resolve();
      await Promise.all([first.completion, second.completion]);
      const terminals = [first, second].map(({ captured }) => captured.lines().at(-1)!);
      expect(terminals.map((line) => line.stage)).toEqual(["done", "done"]);
      expect(terminals.every((line) => (
        (line.initialProjectionCache as { ready?: unknown } | undefined)?.ready === true
      ))).toBe(true);
      expect(new Set(terminals.map((line) => line.graphId)).size).toBe(2);
      expect(new Set(terminals.map((line) => (
        (line.preparedReviewHandoff as { claimId?: unknown }).claimId
      ))).size).toBe(2);
      expect(ctx.prReviewHandoffs.stats()).toMatchObject({
        activePairs: 2,
        readyPairs: 2,
        activeClaims: 2,
        projectionHandles: 4,
      });
      expect(ctx.graphProjectCache.stats()).toMatchObject({ entries: 4, pins: 4 });
    } finally {
      releaseFirstPair.resolve();
      releaseSecondPair.resolve();
      await Promise.allSettled([
        first.completion,
        ...(second === undefined ? [] : [second.completion]),
      ]);
    }
  });

  it("fails progressive preparation without starting canonical analysis when projection readiness fails", async () => {
    vi.mocked(analyzeRepository).mockImplementation(async (request) => {
      const template = request.changedSince ? ARTIFACT : COMPARISON_ARTIFACT;
      return {
        artifact: { ...template, target: { ...template.target, vcs: request.vcs } },
        warnings: [],
      } as never;
    });
    const ctx = githubCtx();
    ctx.graphProject = vi.fn(async () => {
      throw new Error("sensitive projection worker path");
    });

    const captured = await invokePrepare(ctx, { ...DIRECT_BODY, headSha: HEAD_SHA });
    const lines = captured.lines();
    expect(lines.at(-1)).toEqual({
      stage: "error",
      message: "the bounded PR graph could not be prepared; try again",
    });
    expect(JSON.stringify(lines)).not.toContain("sensitive projection worker path");
    expect(vi.mocked(analyzeRepository).mock.calls.filter(([request]) => (
      request.initialGraph === undefined
    ))).toHaveLength(0);
    expect(ctx.graphProjectCache.stats()).toEqual({ entries: 0, bytes: 0, pins: 0 });
    await vi.waitFor(() => {
      expect(ctx.graphStore.stats()).toMatchObject({ registrations: 1, sourceLeases: 0 });
      expect(repositories.activeLeaseCount).toBe(0);
    });
  });

  it("cancels and drains the initial projection gate without emitting a terminal line", async () => {
    vi.mocked(analyzeRepository).mockImplementation(async (request) => {
      const template = request.changedSince ? ARTIFACT : COMPARISON_ARTIFACT;
      return {
        artifact: { ...template, target: { ...template.target, vcs: request.vcs } },
        warnings: [],
      } as never;
    });
    const ctx = githubCtx(undefined, { maxConcurrentAnalyses: 1 });
    const workerSignals: AbortSignal[] = [];
    ctx.graphProject = vi.fn((
      _request: GraphProjectWorkerRequest,
      options: Parameters<Context["graphProject"]>[1] = {},
    ) => new Promise<GraphProjectWorkerResult>((_resolve, reject) => {
      const signal = options.signal ?? new AbortController().signal;
      workerSignals.push(signal);
      const onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    }));

    const abandoned = beginInvokePrepare(ctx, { ...DIRECT_BODY, headSha: HEAD_SHA });
    await vi.waitFor(() => expect(workerSignals).toHaveLength(1));
    expect(abandoned.captured.lines().some((line) => line.stage === "manifest-ready")).toBe(true);
    abandoned.request.emit("aborted");
    await abandoned.completion;

    expect(workerSignals[0]?.aborted).toBe(true);
    expect(abandoned.captured.lines().some((line) => (
      line.stage === "done" || line.stage === "error"
    ))).toBe(false);
    expect(ctx.graphProjectCache.stats()).toEqual({ entries: 0, bytes: 0, pins: 0 });
    await expect(ctx.analysisCoordinator.run(
      "after-cancelled-initial-projection",
      ({ runAnalysis }) => runAnalysis(async () => "drained"),
    )).resolves.toBe("drained");
    await vi.waitFor(() => {
      expect(ctx.graphStore.stats()).toMatchObject({ registrations: 1, sourceLeases: 0 });
      expect(repositories.activeLeaseCount).toBe(0);
    });
  });

  it("does not coalesce a picker-pinned direct request with an unpinned live revalidation", async () => {
    const ctx = githubCtx();
    const releaseAnalysis = deferred<void>();
    vi.mocked(analyzeRepository).mockImplementation(async (request) => {
      await releaseAnalysis.promise;
      const template = request.changedSince ? ARTIFACT : COMPARISON_ARTIFACT;
      return {
        artifact: { ...template, target: { ...template.target, vcs: request.vcs } },
        warnings: [],
      } as never;
    });

    const live = beginInvoke(ctx, BODY);
    await vi.waitFor(() => expect(analyzeRepository).toHaveBeenCalled());
    const moved = await invokePrepare(ctx, {
      ...DIRECT_BODY,
      headSha: "f".repeat(40),
    });

    expect(moved.lines()).toEqual([{
      stage: "error",
      message: "the pull request head changed after it was selected; refresh and try again",
    }]);
    releaseAnalysis.resolve();
    await live.completion;
    expect(live.captured.lines().at(-1)?.stage).toBe("done");
  });

  it("runs two distinct two-sided PR analyses concurrently within the default memory bound", async () => {
    const ctx = githubCtx();
    const release = deferred<void>();
    const twoAnalysesStarted = deferred<void>();
    let active = 0;
    let maximumActive = 0;
    vi.mocked(analyzeRepository).mockImplementation(async (request) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      if (active === 2) twoAnalysesStarted.resolve();
      await release.promise;
      active -= 1;
      const template = request.changedSince ? ARTIFACT : COMPARISON_ARTIFACT;
      return {
        artifact: { ...template, target: { ...template.target, vcs: request.vcs } },
        warnings: request.changedSince ? ["w1"] : ["base warning"],
      } as never;
    });

    const first = invoke(ctx, BODY);
    const second = invoke(ctx, { ...BODY, prNumber: 42, headRef: "feat/y" });
    await twoAnalysesStarted.promise;
    expect(active).toBe(2);
    release.resolve();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult.lines().map((line) => line.stage)).toEqual([
      "clone", "checkout", "extract", "extract-head", "lane-complete",
      "extract-merge-base", "lane-complete", "done",
    ]);
    expect(secondResult.lines().map((line) => line.stage)).toEqual([
      "clone", "checkout", "extract", "extract-head", "lane-complete",
      "extract-merge-base", "lane-complete", "done",
    ]);
    expect(firstResult.lines().at(-1)?.graphId).not.toBe(secondResult.lines().at(-1)?.graphId);
    expect(maximumActive).toBe(2);
    expect(repositories.prepareCalls).toHaveLength(2);
    expect(analyzeRepository).toHaveBeenCalledTimes(4);
  });

  it("publishes a coherent two-sided graph above the soft target while the active session is pinned", async () => {
    const ctx = githubCtx(undefined, { maxConcurrentAnalyses: 2 }, {
      maxEntries: 2,
      lowWaterEntries: 1,
    });

    const captured = await invoke(ctx, BODY);

    expect(captured.lines().map((line) => line.stage)).toEqual([
      "clone",
      "checkout",
      "extract",
      "extract-head",
      "lane-complete",
      "extract-merge-base",
      "lane-complete",
      "done",
    ]);
    const done = captured.lines().at(-1);
    expect(done).toMatchObject({
      graphId: expect.any(String),
      comparisonGraphId: expect.any(String),
    });
    expect(ctx.graphStore.stats()).toMatchObject({ registrations: 3, sourceLeases: 2 });
    expect(hasGraph(ctx, "artifact")).toBe(true);
    expect(hasGraph(ctx, String(done?.graphId))).toBe(true);
    expect(hasGraph(ctx, String(done?.comparisonGraphId))).toBe(true);
    expect(readdirSync(ctx.graphStore.rootPath)).toHaveLength(3);
    expect(repositories.leaseRecords).toEqual([
      expect.objectContaining({ side: "head", releaseCount: 0 }),
      expect.objectContaining({ side: "comparison", releaseCount: 0 }),
    ]);
  });

  it("returns a retryable preparation overload without starting another clone", async () => {
    const ctx = githubCtx(undefined, {
      maxConcurrentAnalyses: 1,
      maxConcurrentPreparations: 1,
      maxQueuedPreparations: 0,
    });
    const firstPreparationStarted = deferred<void>();
    const releaseFirstPreparation = deferred<void>();
    let preparations = 0;
    repositories.beforeFetchComplete = async () => {
      preparations += 1;
      if (preparations === 1) {
        firstPreparationStarted.resolve();
        await releaseFirstPreparation.promise;
      }
    };

    const first = beginInvoke(ctx, BODY);
    await firstPreparationStarted.promise;
    const overloaded = await invoke(ctx, { ...BODY, prNumber: 42, headRef: "feat/y" });

    expect(overloaded.lines()).toEqual([{
      stage: "error",
      message: "repository preparation capacity is full; try again shortly",
      retryAfterSeconds: 5,
    }]);
    expect(repositories.prepareCalls).toHaveLength(1);

    releaseFirstPreparation.resolve();
    await first.completion;
    expect(first.captured.lines().at(-1)?.stage).toBe("done");

    const retry = await invoke(ctx, { ...BODY, prNumber: 42, headRef: "feat/y" });
    expect(retry.lines().at(-1)?.stage).toBe("done");
    expect(repositories.prepareCalls).toHaveLength(2);
  });

  it("cleans its prepared checkout when the bounded analysis queue refuses it", async () => {
    const ctx = githubCtx(undefined, {
      maxConcurrentAnalyses: 1,
      maxConcurrentPreparations: 2,
      maxQueuedAnalyses: 0,
    });
    const firstAnalysisStarted = deferred<void>();
    const releaseFirstAnalysis = deferred<void>();
    let analyses = 0;
    vi.mocked(analyzeRepository).mockImplementation(async (request) => {
      analyses += 1;
      if (analyses === 1) {
        firstAnalysisStarted.resolve();
        await releaseFirstAnalysis.promise;
      }
      const template = request.changedSince ? ARTIFACT : COMPARISON_ARTIFACT;
      return {
        artifact: { ...template, target: { ...template.target, vcs: request.vcs } },
        warnings: request.changedSince ? ["w1"] : ["base warning"],
      } as never;
    });

    const first = beginInvoke(ctx, BODY);
    await firstAnalysisStarted.promise;
    const overloaded = await invoke(ctx, { ...BODY, prNumber: 42, headRef: "feat/y" });

    expect(overloaded.lines().map((line) => line.stage)).toEqual([
      "clone",
      "checkout",
      "extract",
      "error",
    ]);
    expect(overloaded.lines().at(-1)).toMatchObject({
      message: "repository analysis capacity is full; try again shortly",
      retryAfterSeconds: 5,
    });
    expect(stageEntries()).toHaveLength(1);
    expect(repositories.discardedWorkspaceIds).toEqual([repositories.createdWorkspaces[1]!.workspaceId]);
    expect(repositories.leaseRecordsFor(repositories.discardedWorkspaceIds[0]!))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ side: "head", releaseCount: 1 }),
        expect.objectContaining({ side: "comparison", releaseCount: 1 }),
      ]));

    releaseFirstAnalysis.resolve();
    await first.completion;
    expect(first.captured.lines().at(-1)?.stage).toBe("done");
    expect(stageEntries()).toEqual([]);
  });

  it("reclaims preparation staging after the sole waiter aborts non-cooperative mirror work", async () => {
    const ctx = githubCtx();
    const preparationStarted = deferred<void>();
    const releasePreparation = deferred<void>();
    repositories.beforeFetchComplete = async () => {
      preparationStarted.resolve();
      await releasePreparation.promise;
    };

    const abandoned = beginInvoke(ctx, BODY);
    await preparationStarted.promise;
    expect(stageEntries()).toHaveLength(1);
    abandoned.request.emit("aborted");
    await abandoned.completion;
    releasePreparation.resolve();
    await waitFor(() => stageEntries().length === 0);

    expect(abandoned.captured.lines().some((line) => line.stage === "done" || line.stage === "error")).toBe(false);
    expect(analyzeRepository).not.toHaveBeenCalled();
    expect(existsSync(repositories.createdWorkspaces[0]!.root)).toBe(false);
    expect(repositories.leaseRecords).toEqual([]);
  });

  it("reclaims analyzed staging when a non-cooperative worker resolves after the last abort", async () => {
    const ctx = githubCtx();
    const analysisStarted = deferred<void>();
    const releaseAnalysis = deferred<void>();
    vi.mocked(analyzeRepository).mockImplementation(async (request) => {
      analysisStarted.resolve();
      await releaseAnalysis.promise;
      const template = request.changedSince ? ARTIFACT : COMPARISON_ARTIFACT;
      return {
        artifact: { ...template, target: { ...template.target, vcs: request.vcs } },
        warnings: [],
      } as never;
    });

    const abandoned = beginInvoke(ctx, BODY);
    await analysisStarted.promise;
    expect(stageEntries()).toHaveLength(1);
    abandoned.request.emit("aborted");
    await abandoned.completion;
    releaseAnalysis.resolve();
    await waitFor(() => stageEntries().length === 0);

    expect(abandoned.captured.lines().some((line) => line.stage === "done" || line.stage === "error")).toBe(false);
    expect(graphDescriptor(ctx, "artifact")).toBeDefined();
    expect(repositories.discardedWorkspaceIds).toHaveLength(1);
    expect(repositories.leaseRecordsFor(repositories.discardedWorkspaceIds[0]!))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ side: "head", releaseCount: 1 }),
        expect.objectContaining({ side: "comparison", releaseCount: 1 }),
      ]));
  });

  it("serves an exact warm PR snapshot while both cold-work pools are saturated", async () => {
    const ctx = githubCtx(undefined, {
      maxConcurrentAnalyses: 1,
      maxConcurrentPreparations: 1,
      maxQueuedAnalyses: 0,
      maxQueuedPreparations: 0,
    });
    expect((await invoke(ctx, BODY)).lines().at(-1)).toMatchObject({ stage: "done", cache: "miss" });
    const prepareCalls = repositories.prepareCalls.length;
    const acquireCalls = repositories.acquirePreparedCalls.length;
    const analysisCalls = vi.mocked(analyzeRepository).mock.calls.length;
    const releasePreparation = deferred<void>();
    const releaseAnalysis = deferred<void>();
    const preparationStarted = deferred<void>();
    const analysisStarted = deferred<void>();
    const preparation = ctx.analysisCoordinator.run("prep-blocker", ({ runPreparation }) => runPreparation(async () => {
      preparationStarted.resolve();
      await releasePreparation.promise;
    }));
    const analysis = ctx.analysisCoordinator.run("analysis-blocker", ({ runAnalysis }) => runAnalysis(async () => {
      analysisStarted.resolve();
      await releaseAnalysis.promise;
    }));
    await Promise.all([preparationStarted.promise, analysisStarted.promise]);

    const warm = await invoke(ctx, BODY);
    expect(warm.lines()).toEqual([expect.objectContaining({ stage: "done", cache: "hit" })]);
    expect(repositories.prepareCalls).toHaveLength(prepareCalls);
    expect(repositories.acquirePreparedCalls).toHaveLength(acquireCalls + 1);
    expect(analyzeRepository).toHaveBeenCalledTimes(analysisCalls);
    expect(repositories.leaseRecords.slice(-2)).toEqual([
      expect.objectContaining({ side: "head", releaseCount: 1 }),
      expect.objectContaining({ side: "comparison", releaseCount: 1 }),
    ]);

    releasePreparation.resolve();
    releaseAnalysis.resolve();
    await Promise.all([preparation, analysis]);
  });

  it("preempts active speculation before a capacity-one PR analysis asks for admission", async () => {
    const ctx = githubCtx(undefined, { maxConcurrentAnalyses: 1 });
    const warmStarted = deferred<void>();
    let warmAborted = false;
    ctx.graphProject = vi.fn((
      _request: GraphProjectWorkerRequest,
      options: Parameters<Context["graphProject"]>[1] = {},
    ) => new Promise<GraphProjectWorkerResult>((_resolve, reject) => {
      const signal = options.signal ?? new AbortController().signal;
      warmStarted.resolve();
      const onAbort = () => {
        warmAborted = true;
        reject(signal.reason);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    }));

    const warm = await invokeWarmProjection(ctx, {
      version: 1,
      graphId: "artifact",
      roots: { kind: "changed-files", seedGraphId: "artifact" },
      requestedDepth: 2,
      prefetchDepth: 2,
    });
    expect(warm).toMatchObject({ status: 202, json: { accepted: true, completed: false } });
    await warmStarted.promise;

    // No worker release is provided. The real PR route must preempt the warm before entering the
    // coordinator, then use the freed sole slot for repository extraction.
    const review = await invoke(ctx, BODY);
    expect(review.lines().at(-1)).toMatchObject({ stage: "done", cache: "miss" });
    await vi.waitFor(() => expect(warmAborted).toBe(true));
    await vi.waitFor(() => expect(ctx.graphProjectCache.stats()).toEqual({
      entries: 0,
      bytes: 0,
      pins: 0,
    }));
    await expect(ctx.analysisCoordinator.run(
      "after-foreground-preemption",
      ({ runAnalysis }) => runAnalysis(async () => "drained"),
    )).resolves.toBe("drained");
  });

  it("singleflights identical PR requests while preserving each response stream", async () => {
    const ctx = githubCtx();
    const publishBatch = vi.spyOn(ctx.graphStore, "publishBatch");
    const firstAnalysisStarted = deferred<void>();
    const release = deferred<void>();
    vi.mocked(analyzeRepository).mockImplementation(async (request) => {
      firstAnalysisStarted.resolve();
      await release.promise;
      const template = request.changedSince ? ARTIFACT : COMPARISON_ARTIFACT;
      return {
        artifact: { ...template, target: { ...template.target, vcs: request.vcs } },
        warnings: request.changedSince ? ["w1"] : ["base warning"],
      } as never;
    });

    const first = beginInvoke(ctx, BODY);
    await firstAnalysisStarted.promise;
    const follower = beginInvoke(ctx, BODY);
    await waitFor(() => follower.captured.body().includes('"stage":"extract-head"'));
    release.resolve();
    await Promise.all([first.completion, follower.completion]);

    expect(first.captured.lines().map((line) => line.stage)).toEqual([
      "clone", "checkout", "extract", "extract-head", "lane-complete",
      "extract-merge-base", "lane-complete", "done",
    ]);
    expect(follower.captured.lines().map((line) => line.stage)).toEqual([
      "extract", "extract-head", "lane-complete", "extract-merge-base", "lane-complete", "done",
    ]);
    expect(follower.captured.lines().at(-1)).toStrictEqual(first.captured.lines().at(-1));
    expect(repositories.prepareCalls).toHaveLength(1);
    expect(analyzeRepository).toHaveBeenCalledTimes(2);
    expect(publishBatch).toHaveBeenCalledTimes(1);
    const transferredLeases = publishBatch.mock.calls[0]![0]
      .map((registration) => registration.metadata.sourceLease);
    expect(transferredLeases).toStrictEqual(repositories.leaseRecords.map((record) => record.lease));
    expect(repositories.leaseRecords).toEqual([
      expect.objectContaining({ side: "head", releaseCount: 0 }),
      expect.objectContaining({ side: "comparison", releaseCount: 0 }),
    ]);
    expect(repositories.discardedWorkspaceIds).toEqual([]);

    ctx.graphStore.dispose();
    expect(repositories.leaseRecords).toEqual([
      expect.objectContaining({ side: "head", releaseCount: 1 }),
      expect.objectContaining({ side: "comparison", releaseCount: 1 }),
    ]);
    ctx.graphStore.dispose();
    expect(repositories.leaseRecords.every((record) => record.releaseCount === 1)).toBe(true);
  });

  it("replays a completed HEAD lane to a follower while merge-base remains active", async () => {
    const ctx = githubCtx();
    const comparisonStarted = deferred<void>();
    const releaseComparison = deferred<void>();
    vi.mocked(analyzeRepository).mockImplementation(async (request) => {
      if (request.changedSince === undefined) {
        comparisonStarted.resolve();
        await releaseComparison.promise;
      }
      const template = request.changedSince ? ARTIFACT : COMPARISON_ARTIFACT;
      return {
        artifact: { ...template, target: { ...template.target, vcs: request.vcs } },
        warnings: [],
      } as never;
    });

    const first = beginInvoke(ctx, BODY);
    await comparisonStarted.promise;
    await waitFor(() => first.captured.body().includes(
      '{"stage":"lane-complete","lane":"head"}',
    ));
    const follower = beginInvoke(ctx, BODY);
    await waitFor(() => follower.captured.body().includes('"stage":"extract-merge-base"'));

    expect(follower.captured.lines()).toEqual([
      { stage: "extract" },
      { stage: "lane-complete", lane: "head" },
      { stage: "extract-merge-base" },
    ]);

    releaseComparison.resolve();
    await Promise.all([first.completion, follower.completion]);
    expect(follower.captured.lines().map((line) => line.stage)).toEqual([
      "extract",
      "lane-complete",
      "extract-merge-base",
      "lane-complete",
      "done",
    ]);
    expect(follower.captured.lines().filter((line) => line.stage === "lane-complete")).toEqual([
      { stage: "lane-complete", lane: "head" },
      { stage: "lane-complete", lane: "mergeBase" },
    ]);
  });

  it("detaches an aborted waiter without cancelling its identical surviving request", async () => {
    const ctx = githubCtx();
    const firstAnalysisStarted = deferred<void>();
    const release = deferred<void>();
    vi.mocked(analyzeRepository).mockImplementation(async (request) => {
      firstAnalysisStarted.resolve();
      await release.promise;
      const template = request.changedSince ? ARTIFACT : COMPARISON_ARTIFACT;
      return {
        artifact: { ...template, target: { ...template.target, vcs: request.vcs } },
        warnings: request.changedSince ? ["w1"] : ["base warning"],
      } as never;
    });

    const abandoned = beginInvoke(ctx, BODY);
    await firstAnalysisStarted.promise;
    const survivor = beginInvoke(ctx, BODY);
    await waitFor(() => survivor.captured.body().includes('"stage":"extract-head"'));
    abandoned.request.emit("aborted");
    await abandoned.completion;
    release.resolve();
    await survivor.completion;

    expect(abandoned.captured.lines().some((line) => line.stage === "error" || line.stage === "done")).toBe(false);
    expect(survivor.captured.lines().at(-1)?.stage).toBe("done");
    expect(repositories.prepareCalls).toHaveLength(1);
    expect(analyzeRepository).toHaveBeenCalledTimes(2);
  });

  it("fails closed instead of downgrading changed files to modified when the canonical manifest is absent", async () => {
    vi.mocked(analyzeRepository).mockImplementation(async (request) => {
      const template = request.changedSince ? {
        ...ARTIFACT,
        extensions: {
          changedSince: {
            ...((ARTIFACT.extensions?.changedSince ?? {}) as Record<string, unknown>),
            manifest: undefined,
          },
        },
      } : COMPARISON_ARTIFACT;
      return {
        artifact: { ...template, target: { ...template.target, vcs: request.vcs } },
        warnings: [],
      } as never;
    });

    const lines = (await invoke(githubCtx(), BODY)).lines();

    expect(lines.map((line) => line.stage)).toEqual([
      "clone", "checkout", "extract", "extract-head", "error",
    ]);
    expect(lines.at(-1)?.message).toBe("internal error while analyzing the pull request");
    expect(lines.some((line) => line.stage === "done")).toBe(false);
  });

  it("retains validated scenarios, fingerprint, and commit provenance only with PR opt-in plus OCI support", async () => {
    const ctx = githubCtx();
    ctx.allowSyntheticPrExecution = true;
    ctx.syntheticPrSandboxRuntimeSupported = () => true;
    vi.mocked(loadSyntheticScenarios).mockReturnValue([{
      id: "add-item",
      label: "Add item",
      rootId: "ts:src/api/cartRoutes.ts#CartRoutes.handleAddItem",
      defaultInput: { cartId: "cart-1" },
    }]);

    const done = (await invoke(ctx, BODY)).lines().at(-1)!;
    const graphId = done.graphId as string;
    const descriptor = graphDescriptor(ctx, graphId);
    expect(descriptor.synthetic.scenarios).toEqual([expect.objectContaining({ id: "add-item" })]);
    expect(descriptor.synthetic.sourceFingerprint).toBe("fixture-fingerprint");
    expect(descriptor.synthetic.trust).toEqual({
      mode: "sandboxed-pr",
      provenance: {
        repository: "org/repo",
        headSha: "abc1234def5678900000aaaabbbbccccddddeeee",
      },
    });
    expect(loadSyntheticScenarios).toHaveBeenCalledWith(descriptor.sourceRoot);
    expect(syntheticSourceFingerprintForFiles).toHaveBeenCalledWith(descriptor.sourceRoot, []);
  });

  it("retains sandbox provenance when enabled even when the PR has no authored scenarios", async () => {
    const ctx = githubCtx();
    ctx.allowSyntheticPrExecution = true;
    ctx.syntheticPrSandboxRuntimeSupported = () => true;

    const done = (await invoke(ctx, BODY)).lines().at(-1)!;
    const graphId = done.graphId as string;
    const synthetic = graphDescriptor(ctx, graphId).synthetic;
    expect(synthetic.scenarios).toEqual([]);
    expect(synthetic.sourceFingerprint).toBeNull();
    expect(synthetic.trust).toEqual({
      mode: "sandboxed-pr",
      provenance: {
        repository: "org/repo",
        headSha: "abc1234def5678900000aaaabbbbccccddddeeee",
      },
    });
    expect(done.warnings).toEqual([
      "w1",
      "base warning",
      "Synthetic execution needs a valid meridian.synthetic.json scenario manifest.",
    ]);
  });

  it("versions the PR graph capability when sandbox admission changes for the same artifact", async () => {
    const ctx = githubCtx();
    ctx.allowSyntheticPrExecution = true;
    let runtimeSupported = false;
    ctx.syntheticPrSandboxRuntimeSupported = () => runtimeSupported;

    const first = (await invoke(ctx, BODY)).lines().at(-1)!;
    runtimeSupported = true;
    const second = (await invoke(ctx, BODY)).lines().at(-1)!;

    expect(second.cache).toBe("hit");
    expect(second.graphId).not.toBe(first.graphId);
    expect(second.comparisonGraphId).toBe(first.comparisonGraphId);
    expect(graphDescriptor(ctx, first.graphId as string).synthetic.trust).toBeNull();
    expect(graphDescriptor(ctx, second.graphId as string).synthetic.trust).toEqual({
      mode: "sandboxed-pr",
      provenance: { repository: "org/repo", headSha: HEAD_SHA },
    });
    expectWithoutReviewFingerprints(loadGraph(ctx, first.graphId as string), ARTIFACT);
    expectWithoutReviewFingerprints(loadGraph(ctx, second.graphId as string), ARTIFACT);
  });

  it("keeps the PR graph reviewable and leaks no details when its synthetic manifest is malformed", async () => {
    const ctx = githubCtx();
    ctx.allowSyntheticPrExecution = true;
    ctx.syntheticPrSandboxRuntimeSupported = () => true;
    vi.mocked(loadSyntheticScenarios).mockImplementation(() => {
      throw new Error("/tmp/private-clone: hostile <manifest> payload");
    });

    const captured = await invoke(ctx, BODY);
    const lines = captured.lines();
    expect(lines.map((line) => line.stage)).toEqual([
      "clone", "checkout", "extract", "extract-head", "lane-complete",
      "extract-merge-base", "lane-complete", "done",
    ]);
    const done = lines.at(-1)!;
    const graphId = done.graphId as string;
    expectWithoutReviewFingerprints(loadGraph(ctx, graphId), ARTIFACT);
    expect(graphDescriptor(ctx, graphId).synthetic).toEqual({
      scenarios: [],
      sourceFingerprint: null,
      trust: null,
    });
    expect(done.warnings).toEqual([
      "w1",
      "base warning",
      "Synthetic execution was disabled because the PR scenario manifest is invalid.",
    ]);
    expect(JSON.stringify(done)).not.toContain("/tmp/private-clone");
    expect(JSON.stringify(done)).not.toContain("hostile");
  });

  it("rejects a PR-controlled extraction subdir symlink before extracting or storing a capability", async () => {
    const outside = mkdtempSync(join(tmpdir(), "meridian-pr-outside-"));
    repositories.materialize = (_inputs, workspace) => {
      symlinkSync(outside, join(workspace.headDir, "selected"));
    };
    const ctx = githubCtx({ kind: "github", owner: "org", repo: "repo", subdir: "selected" });
    const publishBatch = vi.spyOn(ctx.graphStore, "publishBatch");
    ctx.allowSyntheticPrExecution = true;
    ctx.syntheticPrSandboxRuntimeSupported = () => true;
    try {
      const captured = await invoke(ctx, BODY);
      expect(captured.lines().map((line) => line.stage)).toEqual(["clone", "checkout", "error"]);
      expect(publishBatch).not.toHaveBeenCalled();
      expect(analyzeRepository).not.toHaveBeenCalled();
      expect(existsSync(repositories.createdWorkspaces[0]!.root)).toBe(false);
      expect(repositories.discardedWorkspaceIds).toHaveLength(1);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("stores force-pushed heads under different commit-pinned graph ids", async () => {
    const ctx = githubCtx();
    const first = (await invoke(ctx, BODY)).lines().at(-1)!;
    mockGitRevisions("fff1234def5678900000aaaabbbbccccddddeeee");
    const second = (await invoke(ctx, BODY)).lines().at(-1)!;

    expect(first.headSha).not.toBe(second.headSha);
    expect(first.graphId).not.toBe(second.graphId);
    expect(first.comparisonGraphId).toBe(second.comparisonGraphId);
    expect(hasGraph(ctx, first.graphId as string)).toBe(true);
    expect(hasGraph(ctx, second.graphId as string)).toBe(true);
  });

  it("reuses an unchanged PR artifact and checkout after a server restart", async () => {
    const first = (await invoke(githubCtx(), BODY)).lines();
    const restarted = githubCtx();
    const second = (await invoke(restarted, BODY)).lines();

    expect(first.map((line) => line.stage)).toEqual([
      "clone", "checkout", "extract", "extract-head", "lane-complete",
      "extract-merge-base", "lane-complete", "done",
    ]);
    expect(first.at(-1)?.cache).toBe("miss");
    expect(second.map((line) => line.stage)).toEqual(["done"]);
    expect(second.at(-1)?.cache).toBe("hit");
    expect(second.at(-1)?.graphId).toBe(first.at(-1)?.graphId);
    expect(second.at(-1)?.comparisonGraphId).toBe(first.at(-1)?.comparisonGraphId);
    expect(second.at(-1)?.warnings).toEqual(["w1", "base warning"]);
    expect(repositories.prepareCalls).toHaveLength(1);
    expect(repositories.acquirePreparedCalls).toHaveLength(1);
    expect(analyzeRepository).toHaveBeenCalledTimes(2);
    expect(existsSync(graphDescriptor(restarted, second.at(-1)?.graphId as string).sourceRoot)).toBe(true);
    expect(existsSync(graphDescriptor(restarted, second.at(-1)?.comparisonGraphId as string).sourceRoot)).toBe(true);
    expectWithoutReviewFingerprints(loadGraph(restarted, second.at(-1)?.comparisonGraphId as string), COMPARISON_ARTIFACT);
  });

  it("publishes refreshed PR snapshots under new ids without rebinding the open review", async () => {
    const ctx = githubCtx();
    const first = (await invoke(ctx, BODY)).lines().at(-1)!;
    const firstHeadId = first.graphId as string;
    const firstComparisonId = first.comparisonGraphId as string;
    const firstSourceRoot = graphDescriptor(ctx, firstHeadId).sourceRoot;
    const refreshedAt = "2026-07-20T01:00:00.000Z";
    ctx.refreshCache = true;
    vi.mocked(analyzeRepository).mockImplementation(async (request) => {
      const template = request.changedSince ? ARTIFACT : COMPARISON_ARTIFACT;
      return {
        artifact: {
          ...template,
          generatedAt: refreshedAt,
          target: { ...template.target, vcs: request.vcs },
        },
        warnings: request.changedSince ? ["w1"] : ["base warning"],
      } as never;
    });

    const second = (await invoke(ctx, BODY)).lines().at(-1)!;
    const secondHeadId = second.graphId as string;
    const secondComparisonId = second.comparisonGraphId as string;

    expect(second.cache).toBe("miss");
    expect(secondHeadId).not.toBe(firstHeadId);
    expect(secondComparisonId).not.toBe(firstComparisonId);
    expect(loadGraph(ctx, firstHeadId)?.generatedAt).toBe(ARTIFACT.generatedAt);
    expect(loadGraph(ctx, firstComparisonId)?.generatedAt).toBe(COMPARISON_ARTIFACT.generatedAt);
    expect(loadGraph(ctx, secondHeadId)?.generatedAt).toBe(refreshedAt);
    expect(loadGraph(ctx, secondComparisonId)?.generatedAt).toBe(refreshedAt);
    expect(existsSync(firstSourceRoot)).toBe(true);
  });

  it("keeps the open HEAD and merge-base review intact when refresh extraction fails", async () => {
    const ctx = githubCtx();
    const first = (await invoke(ctx, BODY)).lines().at(-1)!;
    const headId = first.graphId as string;
    const comparisonId = first.comparisonGraphId as string;
    const headRoot = graphDescriptor(ctx, headId).sourceRoot;
    const comparisonRoot = graphDescriptor(ctx, comparisonId).sourceRoot;
    ctx.refreshCache = true;
    vi.mocked(analyzeRepository).mockRejectedValueOnce(new Error("refresh extraction failed"));

    const failed = (await invoke(ctx, BODY)).lines();

    expect(failed.map((line) => line.stage)).toEqual([
      "clone", "checkout", "extract", "extract-head", "error",
    ]);
    expectWithoutReviewFingerprints(loadGraph(ctx, headId), ARTIFACT);
    expectWithoutReviewFingerprints(loadGraph(ctx, comparisonId), COMPARISON_ARTIFACT);
    expect(existsSync(headRoot)).toBe(true);
    expect(existsSync(comparisonRoot)).toBe(true);
  });

  it("rebuilds v14 pair metadata after value callback extraction from verified revision artifacts", async () => {
    const firstCtx = githubCtx(undefined, undefined, undefined, true);
    const first = (await invoke(firstCtx, BODY)).lines();
    const firstDone = first.at(-1)!;
    expect(firstDone.cache).toBe("miss");

    const metadataPath = currentPrSnapshotMetadataPath();
    const metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as Record<string, unknown>;
    expect(metadata.analysisVersion).toBe(REPOSITORY_ANALYSIS_VERSION);
    expect(REPOSITORY_ANALYSIS_VERSION).toBeGreaterThan(LEGACY_ANALYSIS_VERSION_WITHOUT_VALUE_CALLBACKS);
    writeFileSync(metadataPath, JSON.stringify({
      ...metadata,
      analysisVersion: LEGACY_ANALYSIS_VERSION_WITHOUT_VALUE_CALLBACKS,
    }));

    const restarted = githubCtx(undefined, undefined, undefined, true);
    const second = (await invoke(restarted, BODY)).lines();
    const secondDone = second.at(-1)!;

    expect(second.map((line) => line.stage)).toEqual([
      "clone", "checkout", "reuse-head", "reuse-merge-base", "done",
    ]);
    expect(secondDone.cache).toBe("miss");
    expect(secondDone.graphId).toBe(firstDone.graphId);
    expect(secondDone.comparisonGraphId).toBe(firstDone.comparisonGraphId);
    expect(secondDone.headSha).toBe(HEAD_SHA);
    expect(secondDone.mergeBaseSha).toBe(MERGE_BASE_SHA);
    expectWithoutReviewFingerprints(loadGraph(restarted, secondDone.graphId as string), ARTIFACT);
    expectWithoutReviewFingerprints(loadGraph(restarted, secondDone.comparisonGraphId as string), COMPARISON_ARTIFACT);
    expect(repositories.prepareCalls).toHaveLength(2);
    expect(analyzeRepository).toHaveBeenCalledTimes(2);

    const restoredMetadataPath = currentPrSnapshotMetadataPath();
    expect(restoredMetadataPath).not.toBe(metadataPath);
    const retainedLegacyMetadata = JSON.parse(readFileSync(metadataPath, "utf8")) as Record<string, unknown>;
    expect(retainedLegacyMetadata.analysisVersion).toBe(LEGACY_ANALYSIS_VERSION_WITHOUT_VALUE_CALLBACKS);
    const restoredMetadata = JSON.parse(readFileSync(restoredMetadataPath, "utf8")) as Record<string, unknown>;
    expect(restoredMetadata.analysisVersion).toBe(REPOSITORY_ANALYSIS_VERSION);
  });

  it("analyzes a configured subdirectory added wholesale with an empty comparison root, including cache hits", async () => {
    const subdir = "packages/new-app";
    repositories.materialize = (_inputs, workspace) => {
      mkdirSync(join(workspace.headDir, subdir), { recursive: true });
    };
    // The comparison worktree intentionally contains only its repository root: `subdir` did not
    // exist at the merge base.
    const source = { kind: "github", owner: "org", repo: "repo", subdir } as const;
    const firstCtx = githubCtx(source);
    const first = (await invoke(firstCtx, BODY)).lines();
    const done = first.at(-1)!;

    expect(first.map((line) => line.stage)).toEqual([
      "clone", "checkout", "extract", "extract-head", "lane-complete",
      "extract-merge-base", "lane-complete", "done",
    ]);
    expect(done.cache).toBe("miss");
    const headRoot = graphDescriptor(firstCtx, done.graphId as string).sourceRoot;
    const comparisonRoot = graphDescriptor(firstCtx, done.comparisonGraphId as string).sourceRoot;
    expect(headRoot.endsWith(subdir)).toBe(true);
    expect(comparisonRoot.endsWith(subdir)).toBe(true);
    expect(readdirSync(comparisonRoot)).toEqual([]);
    expect(vi.mocked(analyzeRepository).mock.calls.map(([request]) => request.absoluteRoot.endsWith(subdir))).toEqual([true, true]);
    expect(vi.mocked(analyzeRepository).mock.calls[0][0]).toMatchObject({
      allowEmpty: false,
      hintedFiles: [],
    });
    expect(vi.mocked(analyzeRepository).mock.calls[1][0]).toMatchObject({
      allowEmpty: true,
      hintedFiles: ["src/a.ts"],
    });

    const restarted = githubCtx(source);
    const second = (await invoke(restarted, BODY)).lines();
    expect(second.map((line) => line.stage)).toEqual(["done"]);
    expect(second.at(-1)?.cache).toBe("hit");
    expect(readdirSync(graphDescriptor(restarted, second.at(-1)?.comparisonGraphId as string).sourceRoot)).toEqual([]);
    expect(analyzeRepository).toHaveBeenCalledTimes(2);
  });

  it("analyzes a configured subdirectory deleted wholesale with an empty HEAD root", async () => {
    const subdir = "packages/retired-app";
    const populatedComparison = {
      ...COMPARISON_ARTIFACT,
      target: { ...COMPARISON_ARTIFACT.target, language: "mixed" },
      nodes: [
        {
          id: "ts:src/index.ts",
          kind: "module",
          qualifiedName: "src/index.ts",
          displayName: "index.ts",
          parentId: null,
          language: "typescript",
          location: { file: "src/index.ts", startLine: 1 },
        },
        {
          id: "py:src/app.py",
          kind: "module",
          qualifiedName: "src.app",
          displayName: "app.py",
          parentId: null,
          language: "python",
          location: { file: "src/app.py", startLine: 1 },
        },
      ],
    } as GraphArtifact;
    vi.mocked(analyzeRepository).mockImplementation(async (request) => {
      const template = request.changedSince ? ARTIFACT : populatedComparison;
      return {
        artifact: { ...template, target: { ...template.target, vcs: request.vcs } },
        warnings: request.changedSince ? ["w1"] : ["base warning"],
      } as never;
    });
    // The cloned PR head intentionally lacks `subdir`; the comparison worktree proves it existed.
    repositories.materialize = (_inputs, workspace) => {
      mkdirSync(join(workspace.comparisonDir, subdir), { recursive: true });
    };
    const source = { kind: "github", owner: "org", repo: "repo", subdir } as const;
    const ctx = githubCtx(source, undefined, undefined, true);
    const lines = (await invoke(ctx, BODY)).lines();
    const done = lines.at(-1)!;

    expect(lines.map((line) => line.stage)).toEqual([
      "clone", "checkout", "extract", "extract-merge-base", "lane-complete",
      "extract-head", "lane-complete", "done",
    ]);
    expect(done.cache).toBe("miss");
    const headRoot = graphDescriptor(ctx, done.graphId as string).sourceRoot;
    const comparisonRoot = graphDescriptor(ctx, done.comparisonGraphId as string).sourceRoot;
    expect(headRoot.endsWith(subdir)).toBe(true);
    expect(comparisonRoot.endsWith(subdir)).toBe(true);
    expect(readdirSync(headRoot)).toEqual([]);
    expect(vi.mocked(analyzeRepository).mock.calls.map(([request]) => request.absoluteRoot.endsWith(subdir))).toEqual([true, true]);
    expect(vi.mocked(analyzeRepository).mock.calls[0][0]).toMatchObject({
      allowEmpty: false,
      hintedFiles: [],
    });
    expect(vi.mocked(analyzeRepository).mock.calls[0][0]).not.toHaveProperty("changedSince");
    expect(vi.mocked(analyzeRepository).mock.calls[1][0]).toMatchObject({
      allowEmpty: true,
      hintedFiles: ["src/app.py", "src/index.ts"],
      changedSince: MERGE_BASE_SHA,
    });

    const restarted = githubCtx(source, undefined, undefined, true);
    const cached = (await invoke(restarted, BODY)).lines();
    expect(cached.map((line) => line.stage)).toEqual(["done"]);
    expect(cached.at(-1)?.cache).toBe("hit");
    expect(readdirSync(graphDescriptor(restarted, cached.at(-1)?.graphId as string).sourceRoot)).toEqual([]);
    expect(analyzeRepository).toHaveBeenCalledTimes(2);

    mockGitRevisions(HEAD_SHA, "main", "eee1234def5678900000aaaabbbbccccddddeeee");
    const movedBase = (await invoke(githubCtx(source, undefined, undefined, true), BODY)).lines();
    expect(movedBase.map((line) => line.stage)).toEqual([
      "clone", "checkout", "reuse-merge-base", "extract", "extract-head", "lane-complete", "done",
    ]);
    expect(movedBase.at(-1)?.cache).toBe("miss");
    expect(movedBase.at(-1)?.comparisonGraphId).toBe(done.comparisonGraphId);
    expect(analyzeRepository).toHaveBeenCalledTimes(3);
  });

  it("does not materialize a configured subdirectory missing from both revisions", async () => {
    const lines = (await invoke(
      githubCtx({ kind: "github", owner: "org", repo: "repo", subdir: "packages/typo" }),
      BODY,
    )).lines();

    expect(lines.map((line) => line.stage)).toEqual(["clone", "checkout", "error"]);
    expect(lines.at(-1)?.message).toContain("source subfolder was not found in the repository");
    expect(analyzeRepository).not.toHaveBeenCalled();
  });

  it("rejects an extraction subdirectory that escapes a fresh HEAD checkout through a symlink", async () => {
    const outside = join(cacheRoot, "outside-miss");
    mkdirSync(outside, { recursive: true });
    repositories.materialize = (_inputs, workspace) => {
      symlinkSync(outside, join(workspace.headDir, "linked"), process.platform === "win32" ? "junction" : "dir");
    };

    const lines = (await invoke(
      githubCtx({ kind: "github", owner: "org", repo: "repo", subdir: "linked" }),
      BODY,
    )).lines();

    expect(lines.map((line) => line.stage)).toEqual(["clone", "checkout", "error"]);
    expect(lines.at(-1)?.message).toContain("escapes the repository through a symbolic link");
    expect(analyzeRepository).not.toHaveBeenCalled();
  });

  it("rejects an extraction subdirectory that escapes a fresh comparison checkout through a symlink", async () => {
    const outside = join(cacheRoot, "outside-comparison-miss");
    mkdirSync(outside, { recursive: true });
    repositories.materialize = (_inputs, workspace) => {
      mkdirSync(join(workspace.headDir, "linked"), { recursive: true });
      symlinkSync(
        outside,
        join(workspace.comparisonDir, "linked"),
        process.platform === "win32" ? "junction" : "dir",
      );
    };

    const lines = (await invoke(
      githubCtx({ kind: "github", owner: "org", repo: "repo", subdir: "linked" }),
      BODY,
    )).lines();

    expect(lines.map((line) => line.stage)).toEqual([
      "clone", "checkout", "error",
    ]);
    expect(lines.at(-1)?.message).toContain("escapes the repository through a symbolic link");
    expect(analyzeRepository).not.toHaveBeenCalled();
  });

  it("does not materialize an absent comparison subdirectory through an escaping symlink parent", async () => {
    const outside = join(cacheRoot, "outside-comparison-parent");
    mkdirSync(outside, { recursive: true });
    repositories.materialize = (_inputs, workspace) => {
      mkdirSync(join(workspace.headDir, "packages", "app"), { recursive: true });
      symlinkSync(
        outside,
        join(workspace.comparisonDir, "packages"),
        process.platform === "win32" ? "junction" : "dir",
      );
    };

    const lines = (await invoke(
      githubCtx({ kind: "github", owner: "org", repo: "repo", subdir: "packages/app" }),
      BODY,
    )).lines();

    expect(lines.map((line) => line.stage)).toEqual([
      "clone", "checkout", "error",
    ]);
    expect(lines.at(-1)?.message).toContain("escapes the repository through a symbolic link");
    expect(existsSync(join(outside, "app"))).toBe(false);
    // Both exact roots are validated before cache probing or memory-heavy analysis admission.
    expect(analyzeRepository).not.toHaveBeenCalled();
  });

  it.each([
    ["HEAD", "graphId"],
    ["comparison", "comparisonGraphId"],
  ] as const)("invalidates a cache hit whose %s source subdirectory was replaced by an escaping symlink", async (_side, idField) => {
    const subdir = "packages/app";
    repositories.materialize = (_inputs, workspace) => {
      mkdirSync(join(workspace.headDir, subdir), { recursive: true });
      mkdirSync(join(workspace.comparisonDir, subdir), { recursive: true });
    };
    const source = { kind: "github", owner: "org", repo: "repo", subdir } as const;
    const firstCtx = githubCtx(source, undefined, undefined, true);
    const firstDone = (await invoke(firstCtx, BODY)).lines().at(-1)!;
    expect(firstDone.cache).toBe("miss");

    const poisonedSourceDir = graphDescriptor(firstCtx, firstDone[idField] as string).sourceRoot;
    const outside = join(cacheRoot, `outside-${idField}`);
    mkdirSync(outside, { recursive: true });
    rmSync(poisonedSourceDir, { recursive: true, force: true });
    symlinkSync(outside, poisonedSourceDir, process.platform === "win32" ? "junction" : "dir");

    const restarted = githubCtx(source, undefined, undefined, true);
    const secondLines = (await invoke(restarted, BODY)).lines();
    expect(secondLines.map((line) => line.stage)).toEqual([
      "clone", "checkout", "reuse-head", "reuse-merge-base", "done",
    ]);
    expect(secondLines.at(-1)?.cache).toBe("miss");
    expect(repositories.prepareCalls).toHaveLength(2);
    expect(analyzeRepository).toHaveBeenCalledTimes(2);

    const replacement = graphDescriptor(restarted, secondLines.at(-1)?.[idField] as string).sourceRoot;
    expect(realpathSync.native(replacement)).not.toBe(realpathSync.native(outside));
  });

  it("runs canonical PR analysis without persisting or forwarding a language selector", async () => {
    const ctx = githubCtx();
    const done = (await invoke(ctx, BODY)).lines().at(-1)!;

    expect(vi.mocked(analyzeRepository)).toHaveBeenCalledTimes(2);
    for (const [request] of vi.mocked(analyzeRepository).mock.calls) {
      expect(request).not.toHaveProperty("language");
    }
    expect(graphDescriptor(ctx, done.graphId as string).source).toEqual({
      kind: "github",
      owner: "org",
      repo: "repo",
    });
    expect(graphDescriptor(ctx, done.comparisonGraphId as string).source).toEqual({
      kind: "github",
      owner: "org",
      repo: "repo",
    });
  });

  it("lets an explicit legacy request prepare a complete pair after a bounded landing session", async () => {
    vi.mocked(analyzeRepository).mockImplementation(async (request) => {
      const template = request.changedSince ? ARTIFACT : COMPARISON_ARTIFACT;
      return {
        artifact: { ...template, target: { ...template.target, vcs: request.vcs } },
        warnings: request.changedSince ? ["w1"] : ["base warning"],
      } as never;
    });
    const ctx = githubCtx(undefined, undefined, undefined, true);
    const firstLines = (await invokePrepare(ctx, { ...DIRECT_BODY, headSha: HEAD_SHA })).lines();
    const first = firstLines.at(-1)!;
    const movedBaseSha = "eee1234def5678900000aaaabbbbccccddddeeee";
    mockGitRevisions(HEAD_SHA, "main", movedBaseSha);
    const secondLines = (await invoke(ctx, { ...BODY, id: first.graphId as string })).lines();
    const second = secondLines.at(-1)!;

    expect(secondLines.map((line) => line.stage)).toEqual([
      "clone", "checkout", "extract", "extract-head", "lane-complete",
      "extract-merge-base", "lane-complete", "done",
    ]);
    expect(second.cache).toBe("miss");
    expect(second.baseSha).toBe(movedBaseSha);
    expect(second.headSha).toBe(first.headSha);
    expect(second.mergeBaseSha).toBe(first.mergeBaseSha);
    expect(second.graphId).not.toBe(first.graphId);
    expect(second.comparisonGraphId).not.toBe(first.comparisonGraphId);
    expect(repositories.prepareCalls).toHaveLength(2);
    expect(vi.mocked(analyzeRepository).mock.calls.filter(([request]) => (
      request.initialGraph === undefined
    ))).toHaveLength(2);
  });

  it("changes the immutable HEAD id and rebuilds when the live merge base changes", async () => {
    vi.mocked(analyzeRepository).mockImplementation(async (request) => {
      const template = request.changedSince ? ARTIFACT : COMPARISON_ARTIFACT;
      return {
        artifact: { ...template, target: { ...template.target, vcs: request.vcs } },
        warnings: request.changedSince ? ["w1"] : ["base warning"],
      } as never;
    });
    const ctx = githubCtx(undefined, undefined, undefined, true);
    const first = (await invokePrepare(ctx, { ...DIRECT_BODY, headSha: HEAD_SHA })).lines().at(-1)!;
    const movedBaseSha = "eee1234def5678900000aaaabbbbccccddddeeee";
    const movedMergeBaseSha = "fedcba9876543210fedcba9876543210fedcba98";
    repositories.mergeBaseSha = movedMergeBaseSha;
    mockGitRevisions(HEAD_SHA, "main", movedBaseSha);
    vi.mocked(analyzeRepository).mockImplementation(async (request) => {
      const template = request.changedSince ? ARTIFACT : COMPARISON_ARTIFACT;
      const extensions = request.changedSince
        ? {
            ...template.extensions,
            changedSince: {
              ...(template.extensions as { changedSince: Record<string, unknown> }).changedSince,
              baseRef: request.changedSince,
            },
          }
        : template.extensions;
      return {
        artifact: { ...template, target: { ...template.target, vcs: request.vcs }, extensions },
        warnings: request.changedSince ? ["w1"] : ["base warning"],
      } as never;
    });

    const secondLines = (await invoke(ctx, { ...BODY, id: first.graphId as string })).lines();
    const second = secondLines.at(-1)!;

    expect(secondLines.map((line) => line.stage)).toEqual([
      "clone", "checkout", "extract", "extract-head", "lane-complete",
      "extract-merge-base", "lane-complete", "done",
    ]);
    expect(second.cache).toBe("miss");
    expect(second.baseSha).toBe(movedBaseSha);
    expect(second.headSha).toBe(first.headSha);
    expect(second.mergeBaseSha).toBe(movedMergeBaseSha);
    expect(second.graphId).not.toBe(first.graphId);
    expect(second.comparisonGraphId).not.toBe(first.comparisonGraphId);
    expect(repositories.prepareCalls).toHaveLength(2);
    expect(vi.mocked(analyzeRepository).mock.calls.filter(([request]) => (
      request.initialGraph === undefined
    ))).toHaveLength(2);
  });

  it("uses the mirror's exact merge base for both comparison source and canonical diff", async () => {
    const done = (await invoke(githubCtx(), BODY)).lines().at(-1)!;

    expect(done.mergeBaseSha).toBe(MERGE_BASE_SHA);
    expect(vi.mocked(analyzeRepository).mock.calls[0][0].changedSince).toBe(MERGE_BASE_SHA);
    expect(vi.mocked(analyzeRepository).mock.calls[1][0].vcs?.commit).toBe(MERGE_BASE_SHA);
    expect(repositories.prepareCalls[0]).toMatchObject({
      base: { remoteRef: "refs/heads/main", expectedSha: BASE_SHA },
      head: { remoteRef: "refs/pull/41/head", expectedSha: HEAD_SHA },
    });
  });

  it("prepares the exact remote refs structurally and analyzes both returned workspaces", async () => {
    await invoke(githubCtx(), BODY);
    expect(repositories.prepareCalls).toHaveLength(1);
    expect(repositories.prepareCalls[0]).toMatchObject({
      remoteUrl: "https://github.com/org/repo.git",
      base: { remoteRef: "refs/heads/main", expectedSha: BASE_SHA },
      head: { remoteRef: "refs/pull/41/head", expectedSha: HEAD_SHA },
      signal: expect.any(AbortSignal),
      onFetchComplete: expect.any(Function),
    });
    expect(vi.mocked(analyzeRepository)).toHaveBeenCalledWith(
      expect.objectContaining({
        changedSince: MERGE_BASE_SHA,
        changedSinceTimeoutMs: 300_000,
      }),
    );
    expect(vi.mocked(analyzeRepository).mock.calls[1][0]).toEqual(expect.objectContaining({
      vcs: { repository: "https://github.com/org/repo.git", commit: MERGE_BASE_SHA },
    }));
    expect(vi.mocked(analyzeRepository).mock.calls[1][0]).not.toHaveProperty("changedSince");
  });

  it("passes the token opaquely to preflight, mirror preparation, and canonical diff", async () => {
    vi.stubEnv("GITHUB_TOKEN", "env_secret");
    await invoke(githubCtx(), BODY);
    expect(repositories.prepareCalls[0]).toMatchObject({
      remoteUrl: "https://github.com/org/repo.git",
      token: "env_secret",
    });
    expect(vi.mocked(runGit).mock.calls[0][1]).toMatchObject({ token: "env_secret" });

    const executeDiff = vi.mocked(analyzeRepository).mock.calls[0][0].changedSinceGitExecutor;
    expect(executeDiff).toBeTypeOf("function");
    const diffArgs = ["diff", "--merge-base", "origin/main", "--relative", "--unified=0", "--no-color"];
    await executeDiff!("/tmp/private-repo", diffArgs, 300_000);
    expect(runGit).toHaveBeenLastCalledWith(diffArgs, {
      cwd: "/tmp/private-repo",
      token: "env_secret",
      timeoutMs: 300_000,
    });
  });

  it("emits exactly one error line mid-pipeline and removes the temp dir", async () => {
    const ctx = githubCtx();
    const publishBatch = vi.spyOn(ctx.graphStore, "publishBatch");
    repositories.afterFetchComplete = () => {
      throw new WebError(422, "repository preparation failed: boom");
    };
    const captured = await invoke(ctx, BODY);
    const lines = captured.lines();
    expect(lines.map((line) => line.stage)).toEqual(["clone", "checkout", "error"]);
    expect(lines[2].message).toBe("repository preparation failed: boom");
    expect(existsSync(repositories.createdWorkspaces[0]!.root)).toBe(false);
    expect(repositories.leaseRecords).toEqual([]);
    expect(publishBatch).not.toHaveBeenCalled();
  });

  it("never echoes a non-WebError's text into the error line", async () => {
    vi.mocked(analyzeRepository).mockRejectedValueOnce(new Error("/tmp/leaky/path exploded"));
    const lines = (await invoke(githubCtx(), BODY)).lines();
    const errors = lines.filter((line) => line.stage === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toBe("internal error while analyzing the pull request");
    expect(repositories.discardedWorkspaceIds).toHaveLength(1);
    expect(existsSync(repositories.createdWorkspaces[0]!.root)).toBe(false);
  });

  it("rejects unsafe refs and non-integer PR numbers before touching git", async () => {
    for (const bad of [
      { ...BODY, baseRef: "--upload-pack=/bin/sh" },
      { ...BODY, headRef: "feat x; rm -rf /" },
      { ...BODY, prNumber: 0 },
      { ...BODY, prNumber: 1.5 },
      { ...BODY, prNumber: "41" },
    ]) {
      expect((await invoke(githubCtx(), bad)).status()).toBe(400);
    }
    expect(repositories.prepareCalls).toEqual([]);
    expect(runGit).not.toHaveBeenCalled();
  });

  it("accepts the same valid Git branch names as repository generation", async () => {
    const body = { ...BODY, baseRef: "release+candidate@team", headRef: "unicode/ramură" };
    mockGitRevisions(HEAD_SHA, body.baseRef);
    const captured = await invoke(githubCtx(), body);

    expect(captured.status()).toBe(200);
    expect(repositories.prepareCalls[0]).toMatchObject({
      base: { remoteRef: `refs/heads/${body.baseRef}`, expectedSha: BASE_SHA },
      head: { remoteRef: "refs/pull/41/head", expectedSha: HEAD_SHA },
    });
  });

  it("404s a non-GitHub artifact source without streaming", async () => {
    const captured = await invoke(githubCtx({ kind: "other" }), BODY);
    expect(captured.status()).toBe(404);
    expect(repositories.prepareCalls).toEqual([]);
  });
});

function mockGitRevisions(headSha = HEAD_SHA, baseRef = "main", baseSha = BASE_SHA): void {
  vi.mocked(runGit).mockImplementation(async (args) => {
    if (args[0] === "ls-remote") {
      return `${baseSha}\trefs/heads/${baseRef}\n${headSha}\t${args.at(-1)}\n`;
    }
    return "";
  });
}

async function invoke(ctx: Context, body: unknown, headers?: Record<string, string>) {
  const running = beginInvoke(ctx, body, headers);
  await running.completion;
  return running.captured;
}

async function invokePrepare(ctx: Context, body: unknown) {
  const running = beginInvokePrepare(ctx, body);
  await running.completion;
  return running.captured;
}

function beginInvokePrepare(ctx: Context, body: unknown) {
  const captured = capturedResponse();
  const request = requestWith(body);
  const completion = (async () => {
    try {
      await handlePrPrepare(ctx, request, captured.response);
    } catch (error) {
      if (!(error instanceof WebError)) throw error;
      sendJson(captured.response, error.status, { error: error.message });
    }
  })();
  return { captured, completion, request };
}

function beginInvoke(ctx: Context, body: unknown, headers?: Record<string, string>) {
  const captured = capturedResponse();
  const request = requestWith(body, headers);
  const completion = (async () => {
    try {
      await handlePrAnalyze(ctx, request, captured.response);
    } catch (error) {
      if (!(error instanceof WebError)) {
        throw error;
      }
      sendJson(captured.response, error.status, { error: error.message });
    }
  })();
  return { captured, completion, request };
}

function githubCtx(
  source: ArtifactSource | undefined = { kind: "github", owner: "org", repo: "repo" },
  coordinatorOptions: AnalysisCoordinatorOptions = { maxConcurrentAnalyses: 2 },
  graphRetention: Partial<GraphRetentionOptions> = {},
  experimentalPrRevisionCache = false,
  prReviewHandoffOptions: PrReviewHandoffRegistryOptions = {},
): Context {
  const graphStore = new WebGraphStore(graphRetention);
  const graphProjectCache = new WebGraphProjectCache({ sweepIntervalMs: 60_000 });
  const analysisCoordinator = new AnalysisCoordinator(coordinatorOptions);
  const prReviewHandoffs = new PrReviewHandoffRegistry(
    graphStore,
    graphProjectCache,
    prReviewHandoffOptions,
  );
  const shutdown = new AbortController();
  activeGraphStores.push(graphStore);
  activeGraphProjectCaches.push(graphProjectCache);
  activeCoordinators.push(analysisCoordinator);
  activePrReviewHandoffRegistries.push(prReviewHandoffs);
  activeShutdownControllers.push(shutdown);
  graphStore.publish({
    id: "artifact",
    material: materializeValidatedArtifact(ARTIFACT),
    rawGraphPayload: "complete",
    metadata: {
      sourceRoot: cacheRoot,
      source: source ?? { kind: "github", owner: "org", repo: "repo" },
      synthetic: { scenarios: [], sourceFingerprint: null, trust: null },
    },
  });
  return {
    shutdownSignal: shutdown.signal,
    graphStore,
    graphProjectCache,
    analysisCoordinator,
    prReviewHandoffs,
    repositories,
    repositoryAnalysis: runRepositoryAnalysisChildInProcess,
    repositoryArtifactRestamp: runRepositoryArtifactRestampChildInProcess,
    graphProject: async (request: GraphProjectWorkerRequest) => writeGraphProjectResult(request),
    prFilesCache: new Map(),
    rendererIndex: "",
    landingHtml: "",
    staticAssets: { rendererRoot: "", indexHtml: "" },
    cwd: "",
    sessions: new SessionStore(),
    github: createGitHubClient({ clientId: "Iv1.test" }),
    cacheRoot,
    refreshCache: false,
    experimentalPrRevisionCache,
    allowSyntheticExecution: false,
    allowSyntheticPrExecution: false,
    // Existing BODY-based tests exercise the deliberately complete benchmark control. Dedicated
    // denial tests above turn this off or omit its per-request marker.
    benchmarkPrFullBaseline: true,
    syntheticPrSandboxRuntimeSupported: () => false,
    runSyntheticScenarioInOci,
    folderPicker: async () => null,
  } as unknown as Context;
}

function stageEntries(): string[] {
  const root = join(cacheRoot, "pr-staging");
  return existsSync(root) ? readdirSync(root).filter((entry) => entry.startsWith(".stage-")) : [];
}

function currentPrSnapshotMetadataPath(): string {
  const artifactsRoot = join(cacheRoot, "pr-artifacts");
  const slots = readdirSync(artifactsRoot);
  expect(slots).toHaveLength(1);
  const slot = join(artifactsRoot, slots[0]!);
  const pointer = JSON.parse(readFileSync(join(slot, "metadata.json"), "utf8")) as { snapshotId: string };
  return join(slot, "snapshots", pointer.snapshotId, "metadata.json");
}

function graphDescriptor(ctx: Context, id: string) {
  const registration = ctx.graphStore.acquire(id);
  try {
    expect(registration).toBeDefined();
    return registration!.descriptor;
  } finally {
    registration?.release();
  }
}

function loadGraph(ctx: Context, id: string): GraphArtifact | undefined {
  const registration = ctx.graphStore.acquire(id);
  try {
    return registration?.loadArtifact();
  } finally {
    registration?.release();
  }
}

function hasGraph(ctx: Context, id: string): boolean {
  const registration = ctx.graphStore.acquire(id);
  registration?.release();
  return registration !== undefined;
}

function requestWith(body: unknown, headers?: Record<string, string>): IncomingMessage {
  const benchmarkHeaders = typeof body === "object"
    && body !== null
    && !Array.isArray(body)
    && (body as { progressive?: unknown }).progressive === false
    ? { [PR_FULL_BASELINE_BENCHMARK_HEADER]: PR_FULL_BASELINE_BENCHMARK_CAPABILITY }
    : {};
  return Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), {
    headers: headers ?? benchmarkHeaders,
  }) as unknown as IncomingMessage;
}

async function invokeProjection(ctx: Context, body: unknown): Promise<ProjectionResponseResult> {
  const response = new ProjectionResponse();
  await handleGraphProject(ctx, requestWith(body), response as unknown as ServerResponse);
  return response.result();
}

async function invokeWarmProjection(ctx: Context, body: unknown): Promise<ProjectionResponseResult> {
  const response = new ProjectionResponse();
  await handleGraphProjectWarm(ctx, requestWith(body), response as unknown as ServerResponse);
  return response.result();
}

async function invokeSymbols(ctx: Context, graphId: string): Promise<ProjectionResponseResult> {
  const response = new ProjectionResponse();
  const request = Object.assign(Readable.from([]), { headers: {} }) as unknown as IncomingMessage;
  await handleGraphSymbols(ctx, request, response as unknown as ServerResponse, graphId);
  return response.result();
}

interface ProjectionResponseResult {
  status: number;
  json: Record<string, unknown>;
  headers: Record<string, string>;
}

class ProjectionResponse extends Writable {
  status = 0;
  readonly headers: Record<string, string> = {};
  readonly chunks: Buffer[] = [];

  writeHead(status: number, headers: Record<string, unknown> = {}): this {
    this.status = status;
    for (const [name, value] of Object.entries(headers)) {
      if (value !== undefined) this.headers[name.toLowerCase()] = String(value);
    }
    return this;
  }

  result(): ProjectionResponseResult {
    return {
      status: this.status,
      json: JSON.parse(Buffer.concat(this.chunks).toString("utf8")) as Record<string, unknown>,
      headers: { ...this.headers },
    };
  }

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.chunks.push(Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(chunk));
    callback();
  }
}

function writeGraphProjectResult(request: GraphProjectWorkerRequest): GraphProjectWorkerResult {
  if (request.type === "symbols") {
    if (request.symbolOutputPath === null) throw new TypeError("symbol output path is missing");
    const payload = {
      version: 1,
      graphId: request.graph.graphId,
      generation: request.generation,
      complete: true,
      indexedSymbolCount: 0,
      totalSymbolCount: 0,
      symbols: [],
    };
    const bytes = Buffer.from(`${JSON.stringify(payload)}\n`);
    writeFileSync(request.symbolOutputPath, bytes);
    let topology: GraphProjectWorkerResult["topology"] = null;
    if (request.topologyOutputPath !== null) {
      const artifact = JSON.parse(readFileSync(request.graph.path, "utf8")) as GraphArtifact;
      const marker = artifact.extensions?.prInitialGraph as {
        seedFiles?: string[];
        selectedFiles?: string[];
      } | undefined;
      const selectedFiles = [...(marker?.selectedFiles ?? [])].sort();
      const topologyPayload = {
        version: 1,
        graphId: request.graph.graphId,
        generation: request.generation,
        target: artifact.target,
        changedSinceBaseRef: typeof (artifact.extensions?.changedSince as { baseRef?: unknown } | undefined)?.baseRef
          === "string"
          ? (artifact.extensions!.changedSince as { baseRef: string }).baseRef
          : null,
        seeds: [...(marker?.seedFiles ?? [])].sort(),
        files: selectedFiles.map((path) => ({
          path,
          fileId: buildNodeId({ lang: "ts", modulePath: path }),
          neighbors: [],
          uncertain: false,
        })),
      };
      const topologyBytes = Buffer.from(`${JSON.stringify(topologyPayload)}\n`);
      writeFileSync(request.topologyOutputPath, topologyBytes);
      topology = {
        path: request.topologyOutputPath,
        bytes: topologyBytes.length,
        sha256: createHash("sha256").update(topologyBytes).digest("hex"),
        files: selectedFiles.length,
        adjacencyEntries: 0,
      };
    }
    return {
      id: request.id,
      operation: "symbols",
      graphId: request.graph.graphId,
      generation: request.generation,
      projection: null,
      symbols: {
        path: request.symbolOutputPath,
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        count: 0,
      },
      topology,
    };
  }
  if (request.projection === null || request.projectionOutputPath === null) {
    throw new TypeError("graph projection coordinates are missing");
  }
  const projection: GraphProjectionV1 = {
    version: 1,
    graphId: request.graph.graphId,
    seedGraphId: request.projection.roots.kind === "changed-files"
      ? request.projection.roots.seedGraphId
      : request.graph.graphId,
    generation: request.generation,
    requestedDepth: request.projection.requestedDepth,
    prefetchDepth: request.projection.prefetchDepth,
    loadedDepth: request.projection.requestedDepth,
    schemaVersion: ARTIFACT.schemaVersion,
    generatedAt: ARTIFACT.generatedAt,
    generator: ARTIFACT.generator,
    target: ARTIFACT.target,
    nodes: [],
    edges: [],
    rootFileIds: [],
    readyFileIds: [],
    loadedFileIds: [],
    frontier: [],
    counts: {
      full: { nodes: 0, edges: 0, files: 0 },
      slice: { nodes: 0, edges: 0, files: 0 },
    },
  };
  const bytes = Buffer.from(`${JSON.stringify(projection)}\n`);
  writeFileSync(request.projectionOutputPath, bytes);
  return {
    id: request.id,
    operation: "project",
    graphId: request.graph.graphId,
    generation: request.generation,
    projection: {
      path: request.projectionOutputPath,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      nodes: 0,
      edges: 0,
      files: 0,
      roots: 0,
      completeRoots: 0,
      loadedDepth: projection.loadedDepth,
    },
    symbols: null,
    topology: null,
  };
}

function capturedResponse() {
  let status = 0;
  let contentType = "";
  let body = "";
  let writableEnded = false;
  const events = new EventEmitter();
  const response = Object.assign(events, {
    destroyed: false,
    writableEnded: false,
    writeHead(code: number, headers?: Record<string, string>) {
      status = code;
      contentType = headers?.["content-type"] ?? "";
      return response;
    },
    write(
      chunk: unknown,
      encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
      callback?: (error?: Error | null) => void,
    ) {
      body += String(chunk);
      const done = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
      done?.();
      return true;
    },
    end(chunk?: unknown, callback?: () => void) {
      body += typeof chunk === "string" ? chunk : "";
      writableEnded = true;
      callback?.();
      events.emit("finish");
      events.emit("close");
      return response;
    },
  }) as unknown as ServerResponse;
  // Object.assign evaluates accessors on its source, so install this live ServerResponse property
  // explicitly; a normal post-end `close` must not look like peer cancellation to the handler.
  Object.defineProperty(response, "writableEnded", { get: () => writableEnded });
  return {
    response,
    status: () => status,
    contentType: () => contentType,
    body: () => body,
    lines: () => body.trim() === ""
      ? []
      : body.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("condition was not reached");
}

function expectWithoutReviewFingerprints(actual: GraphArtifact | undefined, expected: GraphArtifact): void {
  expect(actual).toBeDefined();
  if (actual === undefined) throw new Error("expected stored graph artifact");
  expect(actual.extensions?.reviewFingerprints).toMatchObject({
    version: 1,
    algorithm: "sha256-source-bytes",
    complete: expect.any(Boolean),
  });
  const { reviewFingerprints: _fingerprints, ...extensions } = actual.extensions ?? {};
  expect({ ...actual, extensions }).toStrictEqual({ ...expected, extensions: expected.extensions ?? {} });
}
