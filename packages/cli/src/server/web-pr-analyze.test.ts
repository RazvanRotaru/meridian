/**
 * POST /api/pr/analyze behaviour with git and the extract pipeline mocked — no network, no real
 * git. Pins the miss stream, revision-addressed restart hit, force-push/base invalidation, blobless
 * full-history clone argv, token-only-in-extraHeader, and failed-stage cleanup.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { SCHEMA_VERSION } from "@meridian/core";
import type { GraphArtifact } from "@meridian/core";
import { analyzeRepository, REPOSITORY_ANALYSIS_VERSION } from "../repository-analysis";
import { base64Auth, runGit, runGitClone } from "./git-exec";
import { handlePrAnalyze } from "./web-pr-analyze";
import type { Context } from "./web-server";
import type { ArtifactSource } from "./web-source";
import { SessionStore } from "./session";
import { sendJson } from "./http-response";
import { WebError } from "./web-error";
import { createGitHubClient } from "./github";
import { materializeValidatedArtifact, WebGraphStore } from "./web-graph-store";
import { AnalysisCoordinator } from "./web-analysis-coordinator";
import { runRepositoryAnalysisChildInProcess } from "./repository-analysis-child-test-adapter";
import {
  loadSyntheticScenarios,
  runSyntheticScenarioInOci,
} from "./synthetic-execution";
import { syntheticSourceFingerprintForFiles } from "./synthetic-fingerprint";

vi.mock("../repository-analysis", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../repository-analysis")>();
  return { ...actual, analyzeRepository: vi.fn() };
});
vi.mock("./git-exec", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./git-exec")>();
  return { ...actual, runGit: vi.fn(), runGitClone: vi.fn() };
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

const BODY = { id: "artifact", prNumber: 41, baseRef: "main", headRef: "feat/x" };
const HEAD_SHA = "abc1234def5678900000aaaabbbbccccddddeeee";
const BASE_SHA = "def1234def5678900000aaaabbbbccccddddeeee";
const MERGE_BASE_SHA = "0123456789abcdef0123456789abcdef01234567";
const REVERSED_MERGE_BASE_SHA = "76543210fedcba9876543210fedcba9876543210";
const LEGACY_ANALYSIS_VERSION_WITHOUT_RUNTIME_IMPORT_EDGES = 7;

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

describe("handlePrAnalyze", () => {
  beforeEach(() => {
    cacheRoot = mkdtempSync(join(tmpdir(), "meridian-pr-cache-test-"));
    activeGraphStores = [];
    activeCoordinators = [];
    vi.stubEnv("GITHUB_TOKEN", "");
    vi.stubEnv("GH_TOKEN", "");
    vi.mocked(runGitClone).mockImplementation(async (args) => {
      mkdirSync(args.at(-1)!, { recursive: true });
    });
    mockGitRevisions();
    vi.mocked(analyzeRepository).mockImplementation(async (request) => {
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
    await Promise.all(activeCoordinators.map((coordinator) => coordinator.close()));
    for (const store of activeGraphStores) store.dispose();
    rmSync(cacheRoot, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("streams clone -> checkout -> extract -> done and registers the persistent checkout", async () => {
    const ctx = githubCtx();
    ctx.allowSyntheticExecution = true; // The local-only flag must never admit a PR artifact.
    const captured = await invoke(ctx, BODY);
    expect(captured.status()).toBe(200);
    expect(captured.contentType()).toContain("application/x-ndjson");
    const lines = captured.lines();
    expect(lines.map((line) => line.stage)).toEqual(["clone", "checkout", "extract", "done"]);

    const done = lines[3];
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
    expectWithoutReviewFingerprints(ctx.graphStore.loadArtifact(done.graphId as string), ARTIFACT);
    expectWithoutReviewFingerprints(ctx.graphStore.loadArtifact(done.comparisonGraphId as string), COMPARISON_ARTIFACT);
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

    expect(firstResult.lines().map((line) => line.stage)).toEqual(["clone", "checkout", "extract", "done"]);
    expect(secondResult.lines().map((line) => line.stage)).toEqual(["clone", "checkout", "extract", "done"]);
    expect(firstResult.lines().at(-1)?.graphId).not.toBe(secondResult.lines().at(-1)?.graphId);
    expect(maximumActive).toBe(2);
    expect(runGitClone).toHaveBeenCalledTimes(2);
    expect(analyzeRepository).toHaveBeenCalledTimes(4);
  });

  it("singleflights identical PR requests while preserving each response stream", async () => {
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

    const first = beginInvoke(ctx, BODY);
    await firstAnalysisStarted.promise;
    const follower = beginInvoke(ctx, BODY);
    await waitFor(() => follower.captured.body().includes('"stage":"extract"'));
    release.resolve();
    await Promise.all([first.completion, follower.completion]);

    expect(first.captured.lines().map((line) => line.stage)).toEqual(["clone", "checkout", "extract", "done"]);
    expect(follower.captured.lines().map((line) => line.stage)).toEqual(["extract", "done"]);
    expect(follower.captured.lines().at(-1)?.graphId).toBe(first.captured.lines().at(-1)?.graphId);
    expect(runGitClone).toHaveBeenCalledTimes(1);
    expect(analyzeRepository).toHaveBeenCalledTimes(2);
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
    await waitFor(() => survivor.captured.body().includes('"stage":"extract"'));
    abandoned.request.emit("aborted");
    await abandoned.completion;
    release.resolve();
    await survivor.completion;

    expect(abandoned.captured.lines().some((line) => line.stage === "error" || line.stage === "done")).toBe(false);
    expect(survivor.captured.lines().at(-1)?.stage).toBe("done");
    expect(runGitClone).toHaveBeenCalledTimes(1);
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

    expect(lines.map((line) => line.stage)).toEqual(["clone", "checkout", "extract", "error"]);
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
    expectWithoutReviewFingerprints(ctx.graphStore.loadArtifact(first.graphId as string), ARTIFACT);
    expectWithoutReviewFingerprints(ctx.graphStore.loadArtifact(second.graphId as string), ARTIFACT);
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
    expect(lines.map((line) => line.stage)).toEqual(["clone", "checkout", "extract", "done"]);
    const done = lines.at(-1)!;
    const graphId = done.graphId as string;
    expectWithoutReviewFingerprints(ctx.graphStore.loadArtifact(graphId), ARTIFACT);
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
    vi.mocked(runGitClone).mockImplementationOnce(async (args) => {
      const cloneRoot = args.at(-1)!;
      symlinkSync(outside, join(cloneRoot, "selected"));
    });
    const ctx = githubCtx({ kind: "github", owner: "org", repo: "repo", subdir: "selected" });
    const publish = vi.spyOn(ctx.graphStore, "publish");
    ctx.allowSyntheticPrExecution = true;
    ctx.syntheticPrSandboxRuntimeSupported = () => true;
    try {
      const captured = await invoke(ctx, BODY);
      expect(captured.lines().map((line) => line.stage)).toEqual(["clone", "error"]);
      expect(publish).not.toHaveBeenCalled();
      expect(analyzeRepository).not.toHaveBeenCalled();
      expect(existsSync(clonedDir())).toBe(false);
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
    expect(ctx.graphStore.has(first.graphId as string)).toBe(true);
    expect(ctx.graphStore.has(second.graphId as string)).toBe(true);
  });

  it("reuses an unchanged PR artifact and checkout after a server restart", async () => {
    const first = (await invoke(githubCtx(), BODY)).lines();
    const restarted = githubCtx();
    const second = (await invoke(restarted, BODY)).lines();

    expect(first.map((line) => line.stage)).toEqual(["clone", "checkout", "extract", "done"]);
    expect(first.at(-1)?.cache).toBe("miss");
    expect(second.map((line) => line.stage)).toEqual(["done"]);
    expect(second.at(-1)?.cache).toBe("hit");
    expect(second.at(-1)?.graphId).toBe(first.at(-1)?.graphId);
    expect(second.at(-1)?.comparisonGraphId).toBe(first.at(-1)?.comparisonGraphId);
    expect(second.at(-1)?.warnings).toEqual(["w1", "base warning"]);
    expect(runGitClone).toHaveBeenCalledTimes(1);
    expect(analyzeRepository).toHaveBeenCalledTimes(2);
    expect(existsSync(graphDescriptor(restarted, second.at(-1)?.graphId as string).sourceRoot)).toBe(true);
    expect(existsSync(graphDescriptor(restarted, second.at(-1)?.comparisonGraphId as string).sourceRoot)).toBe(true);
    expectWithoutReviewFingerprints(restarted.graphStore.loadArtifact(second.at(-1)?.comparisonGraphId as string), COMPARISON_ARTIFACT);
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
    expect(ctx.graphStore.loadArtifact(firstHeadId)?.generatedAt).toBe(ARTIFACT.generatedAt);
    expect(ctx.graphStore.loadArtifact(firstComparisonId)?.generatedAt).toBe(COMPARISON_ARTIFACT.generatedAt);
    expect(ctx.graphStore.loadArtifact(secondHeadId)?.generatedAt).toBe(refreshedAt);
    expect(ctx.graphStore.loadArtifact(secondComparisonId)?.generatedAt).toBe(refreshedAt);
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

    expect(failed.map((line) => line.stage)).toEqual(["clone", "checkout", "extract", "error"]);
    expectWithoutReviewFingerprints(ctx.graphStore.loadArtifact(headId), ARTIFACT);
    expectWithoutReviewFingerprints(ctx.graphStore.loadArtifact(comparisonId), COMPARISON_ARTIFACT);
    expect(existsSync(headRoot)).toBe(true);
    expect(existsSync(comparisonRoot)).toBe(true);
  });

  it("re-analyzes both revisions when cache metadata predates runtime import extraction", async () => {
    const firstCtx = githubCtx();
    const first = (await invoke(firstCtx, BODY)).lines();
    const firstDone = first.at(-1)!;
    expect(firstDone.cache).toBe("miss");

    const metadataPath = join(graphDescriptor(firstCtx, firstDone.graphId as string).sourceRoot, "..", "metadata.json");
    const metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as Record<string, unknown>;
    expect(metadata.analysisVersion).toBe(REPOSITORY_ANALYSIS_VERSION);
    expect(REPOSITORY_ANALYSIS_VERSION).toBeGreaterThan(LEGACY_ANALYSIS_VERSION_WITHOUT_RUNTIME_IMPORT_EDGES);
    writeFileSync(metadataPath, JSON.stringify({
      ...metadata,
      analysisVersion: LEGACY_ANALYSIS_VERSION_WITHOUT_RUNTIME_IMPORT_EDGES,
    }));

    const restarted = githubCtx();
    const second = (await invoke(restarted, BODY)).lines();
    const secondDone = second.at(-1)!;

    expect(second.map((line) => line.stage)).toEqual(["clone", "checkout", "extract", "done"]);
    expect(secondDone.cache).toBe("miss");
    expect(secondDone.graphId).toBe(firstDone.graphId);
    expect(secondDone.comparisonGraphId).toBe(firstDone.comparisonGraphId);
    expect(secondDone.headSha).toBe(HEAD_SHA);
    expect(secondDone.mergeBaseSha).toBe(MERGE_BASE_SHA);
    expectWithoutReviewFingerprints(restarted.graphStore.loadArtifact(secondDone.graphId as string), ARTIFACT);
    expectWithoutReviewFingerprints(restarted.graphStore.loadArtifact(secondDone.comparisonGraphId as string), COMPARISON_ARTIFACT);
    expect(runGitClone).toHaveBeenCalledTimes(2);
    expect(analyzeRepository).toHaveBeenCalledTimes(4);

    const restoredMetadataPath = join(
      graphDescriptor(restarted, secondDone.graphId as string).sourceRoot,
      "..",
      "metadata.json",
    );
    expect(restoredMetadataPath).not.toBe(metadataPath);
    const retainedLegacyMetadata = JSON.parse(readFileSync(metadataPath, "utf8")) as Record<string, unknown>;
    expect(retainedLegacyMetadata.analysisVersion).toBe(LEGACY_ANALYSIS_VERSION_WITHOUT_RUNTIME_IMPORT_EDGES);
    const restoredMetadata = JSON.parse(readFileSync(restoredMetadataPath, "utf8")) as Record<string, unknown>;
    expect(restoredMetadata.analysisVersion).toBe(REPOSITORY_ANALYSIS_VERSION);
  });

  it("analyzes a configured subdirectory added wholesale with an empty comparison root, including cache hits", async () => {
    const subdir = "packages/new-app";
    vi.mocked(runGitClone).mockImplementation(async (args) => {
      mkdirSync(join(args.at(-1)!, subdir), { recursive: true });
    });
    // The comparison worktree intentionally contains only its repository root: `subdir` did not
    // exist at the merge base.
    mockGitRevisions();
    const source = { kind: "github", owner: "org", repo: "repo", subdir } as const;
    const firstCtx = githubCtx(source);
    const first = (await invoke(firstCtx, BODY)).lines();
    const done = first.at(-1)!;

    expect(first.map((line) => line.stage)).toEqual(["clone", "checkout", "extract", "done"]);
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
    mockGitRevisions(HEAD_SHA, "main", BASE_SHA, subdir);
    const source = { kind: "github", owner: "org", repo: "repo", subdir } as const;
    const ctx = githubCtx(source);
    const lines = (await invoke(ctx, BODY)).lines();
    const done = lines.at(-1)!;

    expect(lines.map((line) => line.stage)).toEqual(["clone", "checkout", "extract", "done"]);
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

    const restarted = githubCtx(source);
    const cached = (await invoke(restarted, BODY)).lines();
    expect(cached.map((line) => line.stage)).toEqual(["done"]);
    expect(cached.at(-1)?.cache).toBe("hit");
    expect(readdirSync(graphDescriptor(restarted, cached.at(-1)?.graphId as string).sourceRoot)).toEqual([]);
    expect(analyzeRepository).toHaveBeenCalledTimes(2);
  });

  it("does not materialize a configured subdirectory missing from both revisions", async () => {
    const lines = (await invoke(
      githubCtx({ kind: "github", owner: "org", repo: "repo", subdir: "packages/typo" }),
      BODY,
    )).lines();

    expect(lines.map((line) => line.stage)).toEqual(["clone", "checkout", "extract", "error"]);
    expect(lines.at(-1)?.message).toContain("source subfolder was not found in the repository");
    expect(analyzeRepository).not.toHaveBeenCalled();
  });

  it("rejects an extraction subdirectory that escapes a fresh HEAD checkout through a symlink", async () => {
    const outside = join(cacheRoot, "outside-miss");
    mkdirSync(outside, { recursive: true });
    vi.mocked(runGitClone).mockImplementation(async (args) => {
      const repoDir = args.at(-1)!;
      mkdirSync(repoDir, { recursive: true });
      symlinkSync(outside, join(repoDir, "linked"), process.platform === "win32" ? "junction" : "dir");
    });

    const lines = (await invoke(
      githubCtx({ kind: "github", owner: "org", repo: "repo", subdir: "linked" }),
      BODY,
    )).lines();

    expect(lines.map((line) => line.stage)).toEqual(["clone", "checkout", "extract", "error"]);
    expect(lines.at(-1)?.message).toContain("escapes the repository through a symbolic link");
    expect(analyzeRepository).not.toHaveBeenCalled();
  });

  it("rejects an extraction subdirectory that escapes a fresh comparison checkout through a symlink", async () => {
    const outside = join(cacheRoot, "outside-comparison-miss");
    mkdirSync(outside, { recursive: true });
    vi.mocked(runGitClone).mockImplementation(async (args) => {
      mkdirSync(join(args.at(-1)!, "linked"), { recursive: true });
    });
    vi.mocked(runGit).mockImplementation(async (args) => {
      if (args[0] === "worktree" && args[1] === "add") {
        mkdirSync(args[3], { recursive: true });
        symlinkSync(outside, join(args[3], "linked"), process.platform === "win32" ? "junction" : "dir");
      }
      return gitOutput(args, HEAD_SHA, "main", BASE_SHA);
    });

    const lines = (await invoke(
      githubCtx({ kind: "github", owner: "org", repo: "repo", subdir: "linked" }),
      BODY,
    )).lines();

    expect(lines.map((line) => line.stage)).toEqual(["clone", "checkout", "extract", "error"]);
    expect(lines.at(-1)?.message).toContain("escapes the repository through a symbolic link");
    expect(analyzeRepository).toHaveBeenCalledTimes(1);
    const headRequest = vi.mocked(analyzeRepository).mock.calls[0][0];
    expect(headRequest.absoluteRoot.endsWith(join("repo", "linked"))).toBe(true);
    expect(headRequest.changedSince).toBe(MERGE_BASE_SHA);
  });

  it("does not materialize an absent comparison subdirectory through an escaping symlink parent", async () => {
    const outside = join(cacheRoot, "outside-comparison-parent");
    mkdirSync(outside, { recursive: true });
    vi.mocked(runGitClone).mockImplementation(async (args) => {
      mkdirSync(join(args.at(-1)!, "packages", "app"), { recursive: true });
    });
    vi.mocked(runGit).mockImplementation(async (args) => {
      if (args[0] === "worktree" && args[1] === "add") {
        mkdirSync(args[3], { recursive: true });
        symlinkSync(outside, join(args[3], "packages"), process.platform === "win32" ? "junction" : "dir");
      }
      return gitOutput(args, HEAD_SHA, "main", BASE_SHA);
    });

    const lines = (await invoke(
      githubCtx({ kind: "github", owner: "org", repo: "repo", subdir: "packages/app" }),
      BODY,
    )).lines();

    expect(lines.map((line) => line.stage)).toEqual(["clone", "checkout", "extract", "error"]);
    expect(lines.at(-1)?.message).toContain("escapes the repository through a symbolic link");
    expect(existsSync(join(outside, "app"))).toBe(false);
    // HEAD extraction remains the established first half of the extract stage; comparison is never
    // handed to the analyzer after containment validation fails.
    expect(analyzeRepository).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["HEAD", "graphId"],
    ["comparison", "comparisonGraphId"],
  ] as const)("invalidates a cache hit whose %s source subdirectory was replaced by an escaping symlink", async (_side, idField) => {
    const subdir = "packages/app";
    vi.mocked(runGitClone).mockImplementation(async (args) => {
      mkdirSync(join(args.at(-1)!, subdir), { recursive: true });
    });
    mockGitRevisions(HEAD_SHA, "main", BASE_SHA, subdir);
    const source = { kind: "github", owner: "org", repo: "repo", subdir } as const;
    const firstCtx = githubCtx(source);
    const firstDone = (await invoke(firstCtx, BODY)).lines().at(-1)!;
    expect(firstDone.cache).toBe("miss");

    const poisonedSourceDir = graphDescriptor(firstCtx, firstDone[idField] as string).sourceRoot;
    const outside = join(cacheRoot, `outside-${idField}`);
    mkdirSync(outside, { recursive: true });
    rmSync(poisonedSourceDir, { recursive: true, force: true });
    symlinkSync(outside, poisonedSourceDir, process.platform === "win32" ? "junction" : "dir");

    const restarted = githubCtx(source);
    const secondLines = (await invoke(restarted, BODY)).lines();
    expect(secondLines.map((line) => line.stage)).toEqual(["clone", "checkout", "extract", "done"]);
    expect(secondLines.at(-1)?.cache).toBe("miss");
    expect(runGitClone).toHaveBeenCalledTimes(2);
    expect(analyzeRepository).toHaveBeenCalledTimes(4);

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

  it("re-analyzes when the base branch moves even if the PR head is unchanged", async () => {
    const ctx = githubCtx();
    const first = (await invoke(ctx, BODY)).lines().at(-1)!;
    mockGitRevisions(HEAD_SHA, "main", "eee1234def5678900000aaaabbbbccccddddeeee");
    const second = (await invoke(ctx, BODY)).lines().at(-1)!;

    expect(second.headSha).toBe(first.headSha);
    expect(second.graphId).not.toBe(first.graphId);
    expect(runGitClone).toHaveBeenCalledTimes(2);
    expect(analyzeRepository).toHaveBeenCalledTimes(4);
  });

  it("pins GitHub's base-first merge base to both comparison source and canonical diff", async () => {
    vi.mocked(runGit).mockImplementation(async (args) => {
      if (args[0] === "worktree" && args[1] === "add") {
        mkdirSync(args[3], { recursive: true });
      }
      if (args[0] === "merge-base") {
        // A valid criss-cross history may select a different best base when these arguments are
        // reversed. The production flow must ask only GitHub's base...head ordering.
        return `${args[1] === "origin/main" && args[2] === "HEAD"
          ? MERGE_BASE_SHA
          : REVERSED_MERGE_BASE_SHA}\n`;
      }
      return gitOutput(args, HEAD_SHA, "main", BASE_SHA);
    });

    const done = (await invoke(githubCtx(), BODY)).lines().at(-1)!;

    expect(done.mergeBaseSha).toBe(MERGE_BASE_SHA);
    expect(vi.mocked(analyzeRepository).mock.calls[0][0].changedSince).toBe(MERGE_BASE_SHA);
    expect(vi.mocked(analyzeRepository).mock.calls[1][0].vcs?.commit).toBe(MERGE_BASE_SHA);
    expect(runGit).not.toHaveBeenCalledWith(
      ["merge-base", "HEAD", "origin/main"],
      expect.anything(),
    );
  });

  it("clones full history and drives git in fetch-base, fetch-pr-head, detach order", async () => {
    await invoke(githubCtx(), BODY);
    const cloneArgs = vi.mocked(runGitClone).mock.calls[0][0];
    expect(cloneArgs).toContain("--no-tags");
    expect(cloneArgs).toContain("--filter=blob:none");
    expect(cloneArgs).toContain("--");
    expect(cloneArgs).not.toContain("--depth");
    expect(cloneArgs).not.toContain("--single-branch");
    const tmpDir = clonedDir();
    expect(vi.mocked(runGitClone).mock.calls[0][2]).toEqual({
      timeoutMs: 600_000,
      signal: expect.any(AbortSignal),
    });
    expect(runGit).toHaveBeenCalledWith(
      ["ls-remote", "--exit-code", "https://github.com/org/repo.git", "refs/heads/main", "refs/pull/41/head"],
      { cwd: "", token: "", timeoutMs: 300_000, signal: expect.any(AbortSignal) },
    );
    expect(runGit).toHaveBeenCalledWith(
      ["fetch", "origin", "+refs/heads/main:refs/remotes/origin/main"],
      { cwd: tmpDir, token: "", timeoutMs: 300_000, signal: expect.any(AbortSignal) },
    );
    expect(runGit).toHaveBeenCalledWith(
      ["fetch", "origin", "pull/41/head"],
      { cwd: tmpDir, token: "", timeoutMs: 300_000, signal: expect.any(AbortSignal) },
    );
    expect(runGit).toHaveBeenCalledWith(
      ["checkout", "--detach", "FETCH_HEAD"],
      { cwd: tmpDir, token: "", timeoutMs: 300_000, signal: expect.any(AbortSignal) },
    );
    expect(runGit).toHaveBeenCalledWith(
      ["merge-base", "origin/main", "HEAD"],
      { cwd: tmpDir, timeoutMs: 300_000, signal: expect.any(AbortSignal) },
    );
    expect(runGit).toHaveBeenCalledWith(
      ["worktree", "add", "--detach", expect.stringContaining("comparison-repo"), MERGE_BASE_SHA],
      { cwd: tmpDir, token: "", timeoutMs: 300_000, signal: expect.any(AbortSignal) },
    );
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

  it("puts the env token ONLY in the clone's -c http.extraHeader, never raw in argv", async () => {
    vi.stubEnv("GITHUB_TOKEN", "env_secret");
    await invoke(githubCtx(), BODY);
    const cloneArgs = vi.mocked(runGitClone).mock.calls[0][0];
    expect(cloneArgs.slice(0, 2)).toEqual(["-c", `http.extraHeader=AUTHORIZATION: basic ${base64Auth("env_secret")}`]);
    expect(cloneArgs.join(" ")).not.toContain("env_secret");
    expect(vi.mocked(runGit).mock.calls[0][1]).toMatchObject({ token: "env_secret" });
    expect(vi.mocked(runGit).mock.calls[2][1]).toMatchObject({ token: "env_secret" });

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
    const publish = vi.spyOn(ctx.graphStore, "publish");
    vi.mocked(runGit).mockImplementation(async (args) => {
      if (args[0] === "fetch") throw new WebError(422, "git failed: boom");
      return gitOutput(args, HEAD_SHA, "main");
    });
    const captured = await invoke(ctx, BODY);
    const lines = captured.lines();
    expect(lines.map((line) => line.stage)).toEqual(["clone", "checkout", "error"]);
    expect(lines[2].message).toBe("git failed: boom");
    expect(existsSync(clonedDir())).toBe(false);
    expect(publish).not.toHaveBeenCalled();
  });

  it("never echoes a non-WebError's text into the error line", async () => {
    vi.mocked(analyzeRepository).mockRejectedValueOnce(new Error("/tmp/leaky/path exploded"));
    const lines = (await invoke(githubCtx(), BODY)).lines();
    const errors = lines.filter((line) => line.stage === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toBe("internal error while analyzing the pull request");
    expect(existsSync(clonedDir())).toBe(false);
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
    expect(runGitClone).not.toHaveBeenCalled();
    expect(runGit).not.toHaveBeenCalled();
  });

  it("accepts the same valid Git branch names as repository generation", async () => {
    const body = { ...BODY, baseRef: "release+candidate@team", headRef: "unicode/ramură" };
    mockGitRevisions(HEAD_SHA, body.baseRef);
    const captured = await invoke(githubCtx(), body);

    expect(captured.status()).toBe(200);
    expect(runGit).toHaveBeenCalledWith(
      ["fetch", "origin", `+refs/heads/${body.baseRef}:refs/remotes/origin/${body.baseRef}`],
      expect.objectContaining({ timeoutMs: 300_000 }),
    );
  });

  it("404s a non-GitHub artifact source without streaming", async () => {
    const captured = await invoke(githubCtx({ kind: "other" }), BODY);
    expect(captured.status()).toBe(404);
    expect(runGitClone).not.toHaveBeenCalled();
  });
});

/** The temp clone dir is the last positional of the clone argv — how tests find what to check. */
function clonedDir(): string {
  const args = vi.mocked(runGitClone).mock.calls[0][0];
  return args[args.length - 1];
}

function mockGitRevisions(headSha = HEAD_SHA, baseRef = "main", baseSha = BASE_SHA, subdir?: string): void {
  vi.mocked(runGit).mockImplementation(async (args) => {
    if (args[0] === "worktree" && args[1] === "add") {
      mkdirSync(subdir ? join(args[3], subdir) : args[3], { recursive: true });
    }
    return gitOutput(args, headSha, baseRef, baseSha);
  });
}

function gitOutput(args: string[], headSha: string, baseRef: string, baseSha = BASE_SHA): string {
  if (args[0] === "ls-remote") {
    return `${baseSha}\trefs/heads/${baseRef}\n${headSha}\t${args.at(-1)}\n`;
  }
  if (args[0] === "rev-parse") {
    return `${args[1] === "HEAD" ? headSha : baseSha}\n`;
  }
  if (args[0] === "merge-base") {
    return `${MERGE_BASE_SHA}\n`;
  }
  return "";
}

async function invoke(ctx: Context, body: unknown) {
  const running = beginInvoke(ctx, body);
  await running.completion;
  return running.captured;
}

function beginInvoke(ctx: Context, body: unknown) {
  const captured = capturedResponse();
  const request = requestWith(body);
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

function githubCtx(source: ArtifactSource = { kind: "github", owner: "org", repo: "repo" }): Context {
  const graphStore = new WebGraphStore();
  const analysisCoordinator = new AnalysisCoordinator({ maxConcurrentAnalyses: 2 });
  activeGraphStores.push(graphStore);
  activeCoordinators.push(analysisCoordinator);
  graphStore.publish({
    id: "artifact",
    material: materializeValidatedArtifact(ARTIFACT),
    metadata: {
      sourceRoot: cacheRoot,
      source,
      synthetic: { scenarios: [], sourceFingerprint: null, trust: null },
    },
  });
  return {
    graphStore,
    analysisCoordinator,
    repositoryAnalysis: runRepositoryAnalysisChildInProcess,
    prFilesCache: new Map(),
    rendererIndex: "",
    landingHtml: "",
    staticAssets: { rendererRoot: "", indexHtml: "" },
    cwd: "",
    sessions: new SessionStore(),
    github: createGitHubClient({ clientId: "Iv1.test" }),
    cacheRoot,
    refreshCache: false,
    allowSyntheticExecution: false,
    allowSyntheticPrExecution: false,
    syntheticPrSandboxRuntimeSupported: () => false,
    runSyntheticScenarioInOci,
  } as Context;
}

function graphDescriptor(ctx: Context, id: string) {
  const descriptor = ctx.graphStore.descriptor(id);
  expect(descriptor).toBeDefined();
  return descriptor!;
}

function requestWith(body: unknown): IncomingMessage {
  return Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { headers: {} }) as unknown as IncomingMessage;
}

function capturedResponse() {
  let status = 0;
  let contentType = "";
  let body = "";
  let writableEnded = false;
  const events = new EventEmitter();
  const response = Object.assign(events, {
    destroyed: false,
    get writableEnded() {
      return writableEnded;
    },
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
