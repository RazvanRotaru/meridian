import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SCHEMA_VERSION,
  graphProjectionIdentityPreimage,
  graphProjectionReviewMetadataIdentityPreimage,
} from "@meridian/core";
import type { ChangedFileManifestEntry, GraphArtifact } from "@meridian/core";
import { runGit } from "./git-exec";
import {
  acquirePrPreparationSourceOperations,
  cachedPrPreparation,
  PrBaseInspectionCoordinator,
} from "./web-pr-cache";
import type {
  CachedPrPreparation,
  PrExtractionRunner,
  PrPrepareProgress,
  PrPreparationInputs,
} from "./web-pr-cache";
import type {
  RepositoryDetachedWorktreeLease,
  RepositoryMirrorStore,
  RepositoryWorktreeLease,
} from "./repository-mirror";
import type { ExtractionWorkerResult, SerializablePipelineRequest } from "./extraction-worker";
import {
  defaultGraphProjectionRequest,
  GRAPH_PROJECTION_DIRECTORY,
  writeGraphProjectionBundle,
} from "./graph-projection-bundle";
import {
  freezeGraphGenerationDirectory,
  measureGraphProjectionBundle,
  sealGraphGeneration,
  verifyExistingGraphGeneration,
} from "./graph-generation-verifier";
import { GraphGenerationLifecycle } from "./graph-generation-lifecycle";
import {
  finalizedGenerationDirectory,
  graphGenerationContainerForNestedPath,
  graphGenerationStagingRoot,
  localArtifactGenerations,
  parseFinalizedGenerationPath,
} from "./graph-cache-layout";
import { handlePrPrepare } from "./web-pr-prepare";
import {
  GraphProjectionRegistry,
  handleGraphProjection,
  handleGraphSymbolSearch,
  sendProjectionManifest,
  sendReviewMetadata,
} from "./web-graph";
import { createGraphProjectionAdmission } from "./graph-projection-response";
import { InspectionScheduler } from "./inspection-scheduler";
import { graphSummaryFor } from "./graph-generation-contract";
import {
  GraphCapabilityStore,
  type GraphCapabilityBinding,
  type GraphCapabilityExternalOwnerKey,
  type GraphCapabilityOwnerExpectation,
} from "./graph-capability-store";
import { writeSyntheticCapabilitySidecar } from "./synthetic-capability-sidecar";
import { SessionStore } from "./session";
import { createGitHubClient } from "./github";
import type { Context } from "./web-server";
import { WebError } from "./web-error";
import { removeEntry } from "./web-cache-storage";
import {
  MAX_PREPARED_REVIEW_HANDOFF_BYTES,
  PreparedReviewHandoffStore,
  type PreparedReviewHandoffDocument,
  type PreparedReviewHandoffInput,
} from "./prepared-review-handoff-store";
import {
  effectiveReviewProjectionContentId,
  REVIEW_COMPARISON_CONTEXT_FILE,
  writeReviewComparisonContext,
} from "./review-comparison-context";
import { OwnershipCleanupError } from "./ownership-cleanup";

vi.mock("./git-exec", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./git-exec")>();
  return { ...actual, runGit: vi.fn() };
});

const HEAD_ONE = "1111111111111111111111111111111111111111";
const HEAD_TWO = "2222222222222222222222222222222222222222";
const BASE_ONE = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const BASE_TWO = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const MERGE_BASE = "cccccccccccccccccccccccccccccccccccccccc";
const MERGE_BASE_TWO = "dddddddddddddddddddddddddddddddddddddddd";
const MANIFEST: ChangedFileManifestEntry[] = [
  { path: "src/added.ts", status: "added" },
  { path: "src/deleted.ts", status: "deleted" },
  { path: "src/modified.ts", status: "modified" },
  { path: "src/new-name.ts", previousPath: "src/old-name.ts", status: "renamed" },
];

let cacheRoot: string;
let baseSha = BASE_ONE;
let commitsByDirectory: Map<string, string>;
let headsByPr: Map<number, string>;
let baseInspectionCoordinator: PrBaseInspectionCoordinator;

beforeEach(() => {
  cacheRoot = mkdtempSync(join(tmpdir(), "meridian-pr-prepare-"));
  commitsByDirectory = new Map();
  headsByPr = new Map([[41, HEAD_ONE], [42, HEAD_TWO]]);
  baseInspectionCoordinator = new PrBaseInspectionCoordinator();
  baseSha = BASE_ONE;
  vi.stubEnv("GITHUB_TOKEN", "");
  vi.stubEnv("GH_TOKEN", "");
  vi.mocked(runGit).mockImplementation(async (args, options) => {
    if (args[0] === "ls-remote") {
      const headRef = args.find((arg) => arg.startsWith("refs/pull/"));
      const pr = Number(headRef?.split("/")[2]);
      const head = headsByPr.get(pr);
      if (!head || !headRef) return "";
      const baseRef = args.find((arg) => arg.startsWith("refs/heads/")) ?? "refs/heads/main";
      return `${baseSha}\t${baseRef}\n${head}\t${headRef}\n`;
    }
    if (args[0] === "merge-base") return `${MERGE_BASE}\n`;
    if (args[0] === "rev-parse" && args[1] === "HEAD") {
      const commit = commitsByDirectory.get(options.cwd);
      if (!commit) throw new Error(`unknown fake worktree ${options.cwd}`);
      return `${commit}\n`;
    }
    throw new Error(`unexpected git command ${args.join(" ")}`);
  });
});

afterEach(async () => {
  await baseInspectionCoordinator.close();
  removeEntry(cacheRoot);
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("PrBaseInspectionCoordinator", () => {
  it("closes idempotently only after the last-subscriber executor and lease physically drain", async () => {
    const coordinator = new PrBaseInspectionCoordinator();
    const started = deferred<void>();
    const aborted = deferred<void>();
    const releaseDrain = deferred<void>();
    const releaseLease = vi.fn(async () => undefined);
    const lease = { release: releaseLease } as unknown as RepositoryDetachedWorktreeLease;
    const subscription = coordinator.subscribe("base", lease, undefined, (signal) => {
      started.resolve();
      return new Promise<never>((_resolve, reject) => {
        const onAbort = () => {
          aborted.resolve();
          void releaseDrain.promise.then(() => reject(signal.reason));
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      });
    });
    const outcome = subscription.promise.catch((error: unknown) => error);
    await started.promise;

    const firstClose = coordinator.close();
    const secondClose = coordinator.close();
    expect(secondClose).toBe(firstClose);
    await aborted.promise;
    let closeSettled = false;
    void firstClose.then(() => { closeSettled = true; });
    await Promise.resolve();
    expect(closeSettled).toBe(false);
    expect(releaseLease).not.toHaveBeenCalled();

    releaseDrain.resolve();
    await firstClose;
    await expect(outcome).resolves.toMatchObject({ name: "AbortError" });
    expect(releaseLease).toHaveBeenCalledTimes(1);
  });

  it("accepts a structural AbortError from a physically drained flight", async () => {
    const coordinator = new PrBaseInspectionCoordinator();
    const started = deferred<void>();
    const releaseLease = vi.fn(async () => undefined);
    const subscription = coordinator.subscribe(
      "structural-abort",
      { release: releaseLease } as unknown as RepositoryDetachedWorktreeLease,
      undefined,
      (signal) => new Promise<never>((_resolve, reject) => {
        started.resolve();
        const rejectAbort = () => reject(new DOMException("executor stopped", "AbortError"));
        if (signal.aborted) rejectAbort();
        else signal.addEventListener("abort", rejectAbort, { once: true });
      }),
    );
    const subscriberOutcome = subscription.promise.catch((error: unknown) => error);
    await started.promise;

    const firstClose = coordinator.close();
    expect(coordinator.close()).toBe(firstClose);
    await expect(firstClose).resolves.toBeUndefined();
    await expect(subscriberOutcome).resolves.toMatchObject({ name: "AbortError" });
    expect(releaseLease).toHaveBeenCalledTimes(1);
  });

  it("never suppresses a release failure wrapped around an aborted flight", async () => {
    const coordinator = new PrBaseInspectionCoordinator();
    const started = deferred<void>();
    const releaseError = new Error("detached lease release failed");
    const releaseLease = vi.fn(async () => { throw releaseError; });
    const subscription = coordinator.subscribe(
      "abort-with-cleanup-failure",
      { release: releaseLease } as unknown as RepositoryDetachedWorktreeLease,
      undefined,
      (signal) => new Promise<never>((_resolve, reject) => {
        started.resolve();
        const rejectAbort = () => reject(new DOMException("executor stopped", "AbortError"));
        if (signal.aborted) rejectAbort();
        else signal.addEventListener("abort", rejectAbort, { once: true });
      }),
    );
    void subscription.promise.catch(() => undefined);
    await started.promise;

    const firstClose = coordinator.close();
    expect(coordinator.close()).toBe(firstClose);
    const error = await firstClose.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([
      expect.objectContaining({ name: "AbortError" }),
      releaseError,
    ]);
    expect(releaseLease).toHaveBeenCalledTimes(1);
  });

  it("isolates identical merge-base flights owned by two server coordinators", async () => {
    const serverA = new PrBaseInspectionCoordinator();
    const serverB = new PrBaseInspectionCoordinator();
    const startedA = deferred<void>();
    const startedB = deferred<void>();
    const drainA = deferred<void>();
    const drainB = deferred<void>();
    let signalB: AbortSignal | undefined;
    const operation = (
      started: ReturnType<typeof deferred<void>>,
      drain: ReturnType<typeof deferred<void>>,
      capture?: (signal: AbortSignal) => void,
    ) => (signal: AbortSignal) => {
      capture?.(signal);
      started.resolve();
      return new Promise<never>((_resolve, reject) => {
        const onAbort = () => { void drain.promise.then(() => reject(signal.reason)); };
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      });
    };
    const releaseA = vi.fn(async () => undefined);
    const releaseB = vi.fn(async () => undefined);
    const pendingA = serverA.subscribe(
      "identical-key",
      { release: releaseA } as unknown as RepositoryDetachedWorktreeLease,
      undefined,
      operation(startedA, drainA),
    ).promise.catch((error: unknown) => error);
    const pendingB = serverB.subscribe(
      "identical-key",
      { release: releaseB } as unknown as RepositoryDetachedWorktreeLease,
      undefined,
      operation(startedB, drainB, (signal) => { signalB = signal; }),
    ).promise.catch((error: unknown) => error);
    await Promise.all([startedA.promise, startedB.promise]);

    const closeA = serverA.close();
    expect(signalB?.aborted).toBe(false);
    drainA.resolve();
    await closeA;
    expect(signalB?.aborted).toBe(false);
    expect(releaseA).toHaveBeenCalledTimes(1);
    expect(releaseB).not.toHaveBeenCalled();

    const closeB = serverB.close();
    drainB.resolve();
    await closeB;
    await Promise.all([pendingA, pendingB]);
    expect(releaseB).toHaveBeenCalledTimes(1);
  });
});

describe("cachedPrPreparation", () => {
  it("extracts populated HEAD and merge-base sides concurrently", async () => {
    const mirrors = fakeMirrors({ baseHasSubdir: true });
    const release = deferred<void>();
    let started = 0;
    const extractionStages: string[] = [];
    const underlyingRunner = fakeExtractionRunner({
      onAny: async () => {
        started += 1;
        await release.promise;
      },
    });
    const runner: PrExtractionRunner = (request, options) => {
      extractionStages.push(dirname(options.artifactOutputPath));
      return underlyingRunner(request, options);
    };
    const pending = cachedPrPreparation(inputs(41, mirrors, runner));
    let prepared: CachedPrPreparation | undefined;

    try {
      await vi.waitFor(() => expect(started).toBe(2));
    } finally {
      release.resolve();
      prepared = await pending;
    }
    expect(prepared).toBeDefined();
    const canonicalCacheRoot = realpathSync(cacheRoot);
    expect(extractionStages).toHaveLength(2);
    for (const stage of extractionStages) {
      expect(graphGenerationContainerForNestedPath(canonicalCacheRoot, stage)?.kind).toBe("stage");
    }
    expect(readdirSync(graphGenerationStagingRoot(canonicalCacheRoot))).toEqual([]);
    expect(parseFinalizedGenerationPath(
      canonicalCacheRoot,
      prepared!.head.verifiedGeneration.generationDirectory,
    )?.kind).toBe("pr-head");
    expect(parseFinalizedGenerationPath(
      canonicalCacheRoot,
      prepared!.mergeBase.verifiedGeneration.generationDirectory,
    )?.kind).toBe("pr-base");
  });

  it("aborts and drains the peer extraction before a paired failure escapes", async () => {
    const mirrors = fakeMirrors({ baseHasSubdir: true });
    const baseStarted = deferred<void>();
    let baseDrained = false;
    const runner: PrExtractionRunner = async (request, options) => {
      if (request.changedSince !== undefined) {
        await baseStarted.promise;
        throw new Error("HEAD extraction failed");
      }
      baseStarted.resolve();
      return await new Promise<ExtractionWorkerResult>((_resolve, reject) => {
        const signal = options.signal;
        const onAbort = () => {
          baseDrained = true;
          reject(signal?.reason ?? new Error("peer extraction aborted"));
        };
        if (signal?.aborted) onAbort();
        else signal?.addEventListener("abort", onAbort, { once: true });
      });
    };

    await expect(cachedPrPreparation(inputs(41, mirrors, runner))).rejects.toThrow("HEAD extraction failed");
    expect(baseDrained).toBe(true);
    expect(readdirSync(graphGenerationStagingRoot(realpathSync(cacheRoot)))).toEqual([]);
  });

  it("retains an independent peer cleanup failure after parallel extraction cancellation", async () => {
    const mirrors = fakeMirrors({ baseHasSubdir: true });
    const headStarted = deferred<void>();
    const baseError = new Error("merge-base extraction failed");
    const headCleanupError = new Error("HEAD extraction cleanup failed");
    const runner: PrExtractionRunner = async (request, options) => {
      if (request.changedSince === undefined) {
        await headStarted.promise;
        throw baseError;
      }
      headStarted.resolve();
      return new Promise<ExtractionWorkerResult>((_resolve, reject) => {
        const onAbort = () => reject(new OwnershipCleanupError(
          [options.signal?.reason, headCleanupError],
          "HEAD extraction",
        ));
        if (options.signal?.aborted) onAbort();
        else options.signal?.addEventListener("abort", onAbort, { once: true });
      });
    };

    const outcome = await cachedPrPreparation(inputs(41, mirrors, runner)).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(outcome).toBeInstanceOf(AggregateError);
    expect((outcome as AggregateError).errors).toEqual([headCleanupError, baseError]);
    expect(readdirSync(graphGenerationStagingRoot(realpathSync(cacheRoot)))).toEqual([]);
  });

  it("does not start a zero-subscriber shared-base flight after cancellation", async () => {
    const mirrors = fakeMirrors({ baseHasSubdir: true });
    let baseExtractions = 0;
    const runner = fakeExtractionRunner({
      onBase: async () => {
        baseExtractions += 1;
      },
    });
    const controller = new AbortController();
    controller.abort(new DOMException("inspection cancelled", "AbortError"));

    await expect(cachedPrPreparation({
      ...inputs(41, mirrors, runner),
      signal: controller.signal,
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(baseExtractions).toBe(0);
  });

  it("singleflights one populated merge-base extraction across concurrent PRs", async () => {
    const mirrors = fakeMirrors({ baseHasSubdir: true });
    const gate = deferred<void>();
    let baseExtractions = 0;
    const runner = fakeExtractionRunner({
      onBase: async () => {
        baseExtractions += 1;
        await gate.promise;
      },
    });
    const first = cachedPrPreparation(inputs(41, mirrors, runner));
    const second = cachedPrPreparation(inputs(42, mirrors, runner));

    await vi.waitFor(() => expect(baseExtractions).toBe(1));
    gate.resolve();
    const [left, right] = await Promise.all([first, second]);

    expect(left.headSha).toBe(HEAD_ONE);
    expect(right.headSha).toBe(HEAD_TWO);
    expect(left.mergeBase.artifactPath).toBe(right.mergeBase.artifactPath);
    expect(left.mergeBaseGenerationId).toBe(right.mergeBaseGenerationId);
    expect(left.head.artifactPath).not.toBe(right.head.artifactPath);
    expect(baseExtractions).toBe(1);
    expect(left.changedFiles).toEqual(MANIFEST);
    expect(runGit).toHaveBeenCalledWith(
      ["merge-base", expect.stringContaining("/base"), "HEAD"],
      expect.objectContaining({ cwd: expect.stringContaining("/worktrees/") }),
    );
  });

  it("persists changed files in deterministic UTF-8 path order", async () => {
    const unordered: ChangedFileManifestEntry[] = [
      { path: "src/\u{10000}.ts", status: "modified" },
      { path: "src/é.ts", status: "added" },
      { path: "src/z.ts", status: "deleted" },
      { path: "src/\u{e000}.ts", previousPath: "src/old.ts", status: "renamed" },
    ];
    const expected: ChangedFileManifestEntry[] = [
      unordered[2]!,
      unordered[1]!,
      unordered[3]!,
      unordered[0]!,
    ];
    const mirrors = fakeMirrors({ baseHasSubdir: true });
    const runner = fakeExtractionRunner({ changedFiles: unordered });

    const first = await cachedPrPreparation(inputs(41, mirrors, runner));
    const second = await cachedPrPreparation(inputs(41, mirrors, runner));

    expect(first.changedFiles).toEqual(expected);
    expect(second.changedFiles).toEqual(expected);
    expect(second.cache).toBe("hit");
  });

  it("queues one successor behind a cancelled base flight until it physically drains", async () => {
    const mirrors = fakeMirrors({ baseHasSubdir: true });
    const firstBaseStarted = deferred<void>();
    const firstBaseDrained = deferred<void>();
    const releaseFirstDrain = deferred<void>();
    const successful = fakeExtractionRunner();
    let baseExtractions = 0;
    let concurrentBaseExtractions = 0;
    let maxConcurrentBaseExtractions = 0;
    const runner: PrExtractionRunner = async (request, options) => {
      if (request.changedSince === undefined) {
        baseExtractions += 1;
        concurrentBaseExtractions += 1;
        maxConcurrentBaseExtractions = Math.max(maxConcurrentBaseExtractions, concurrentBaseExtractions);
        try {
          if (baseExtractions === 1) {
            firstBaseStarted.resolve();
            await new Promise<void>((_resolve, reject) => {
              const onAbort = () => {
                void releaseFirstDrain.promise.then(() => {
                  firstBaseDrained.resolve();
                  reject(options.signal?.reason);
                });
              };
              if (options.signal?.aborted) onAbort();
              else options.signal?.addEventListener("abort", onAbort, { once: true });
            });
          }
          return successful(request, options);
        } finally {
          concurrentBaseExtractions -= 1;
        }
      }
      return successful(request, options);
    };
    const firstController = new AbortController();
    const first = cachedPrPreparation({
      ...inputs(41, mirrors, runner),
      signal: firstController.signal,
    });
    const firstOutcome = first.catch((error: unknown) => error);
    await firstBaseStarted.promise;
    firstController.abort(new DOMException("first subscriber left", "AbortError"));

    const second = cachedPrPreparation(inputs(42, mirrors, runner));
    await Promise.resolve();
    expect(baseExtractions).toBe(1);

    releaseFirstDrain.resolve();
    await firstBaseDrained.promise;
    await expect(firstOutcome).resolves.toMatchObject({ name: "AbortError" });
    await expect(second).resolves.toMatchObject({ headSha: HEAD_TWO, mergeBaseSha: MERGE_BASE });
    expect(baseExtractions).toBe(2);
    expect(maxConcurrentBaseExtractions).toBe(1);
  });

  it("does not alias empty merge-base artifacts selected by different hinted files", async () => {
    const mirrors = fakeMirrors({ baseHasSubdir: false });
    const baseRequests: SerializablePipelineRequest[] = [];
    const runner = fakeExtractionRunner({
      hintsByHead: new Map([[HEAD_ONE, ["pkg/a.ts"]], [HEAD_TWO, ["pkg/b.py"]]]),
      onBase: async (request) => { baseRequests.push(request); },
    });
    const first = await cachedPrPreparation(inputs(41, mirrors, runner, "pkg"));
    const second = await cachedPrPreparation(inputs(42, mirrors, runner, "pkg"));

    expect(baseRequests).toHaveLength(2);
    expect(baseRequests.map((request) => request.hintedFiles)).toEqual([["pkg/a.ts"], ["pkg/b.py"]]);
    expect(baseRequests.every((request) => request.allowEmpty === true)).toBe(true);
    expect(first.mergeBase.artifactPath).not.toBe(second.mergeBase.artifactPath);
    expect(first.mergeBaseGenerationId).not.toBe(second.mergeBaseGenerationId);
  });

  it("prepares a whole-subtree deletion base-first and extracts an empty HEAD with base hints", async () => {
    const mirrors = fakeMirrors({ baseHasSubdir: true, headHasSubdir: false });
    const calls: SerializablePipelineRequest[] = [];
    const result = await cachedPrPreparation(inputs(
      41,
      mirrors,
      fakeExtractionRunner({ onAny: async (request) => { calls.push(request); } }),
      "src",
    ));

    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ vcs: { commit: MERGE_BASE } });
    expect(calls[0].changedSince).toBeUndefined();
    expect(calls[1]).toMatchObject({
      vcs: { commit: HEAD_ONE },
      allowEmpty: true,
      hintedFiles: ["src/base.ts"],
      changedSinceLabel: MERGE_BASE,
    });
    expect(calls[1].changedSince).toMatch(/^refs\/meridian\/jobs\/.+\/commit$/);
    expect(result.mergeBase.graphSummary).toMatchObject({ nodeCount: 0, edgeCount: 0 });
  });

  it("keeps a cache hit when only advertised baseSha moves and merge-base identity is unchanged", async () => {
    const mirrors = fakeMirrors({ baseHasSubdir: true });
    let extractions = 0;
    const runner = fakeExtractionRunner({ onAny: async () => { extractions += 1; } });
    const first = await cachedPrPreparation(inputs(41, mirrors, runner));
    const extractionsAfterFirstGeneration = extractions;
    baseSha = BASE_TWO;
    const second = await cachedPrPreparation(inputs(41, mirrors, runner));

    expect(first.cache).toBe("miss");
    expect(first.baseSha).toBe(BASE_ONE);
    expect(second.baseSha).toBe(BASE_TWO);
    expect(second.headSha).toBe(first.headSha);
    expect(second.mergeBaseSha).toBe(first.mergeBaseSha);
    expect(second.mergeBaseSha).toBe(MERGE_BASE);
    expect(second.cache).toBe("hit");
    expect(second.generationId).toBe(first.generationId);
    expect(second.mergeBaseGenerationId).toBe(first.mergeBaseGenerationId);
    expect(extractionsAfterFirstGeneration).toBe(2); // one HEAD and one shared merge-base extraction
    expect(extractions).toBe(extractionsAfterFirstGeneration); // moving base provenance performs no extraction
    expect(mirrors.prepare).toHaveBeenCalledTimes(2);
  });

  it("serves an exact warm hit without preparing a mirror worktree", async () => {
    const mirrors = fakeMirrors({ baseHasSubdir: true });
    let extractions = 0;
    const runner = fakeExtractionRunner({ onAny: async () => { extractions += 1; } });
    const first = await cachedPrPreparation(inputs(41, mirrors, runner));
    const second = await cachedPrPreparation(inputs(41, mirrors, runner));

    expect(first.cache).toBe("miss");
    expect(second.cache).toBe("hit");
    expect(second.generationId).toBe(first.generationId);
    expect(mirrors.prepare).toHaveBeenCalledTimes(1);
    expect(extractions).toBe(2);
  });

  it("rolls back a newly-created HEAD alias owner when its base-side owner cannot be retained", async () => {
    const mirrors = fakeMirrors({ baseHasSubdir: true });
    const retain = vi.mocked(mirrors.retainSource);
    const release = vi.mocked(mirrors.releaseSource);
    const retainNormally = retain.getMockImplementation()!;
    let retainCall = 0;
    retain.mockImplementation(async (...args) => {
      retainCall += 1;
      // Shared-base ownership is committed first. The HEAD alias then retains its two sides.
      if (retainCall === 3) throw new Error("base alias owner failed");
      return retainNormally(...args);
    });

    await expect(cachedPrPreparation(inputs(41, mirrors, fakeExtractionRunner())))
      .rejects.toThrow("base alias owner failed");

    expect(release).toHaveBeenCalledTimes(1);
    expect(release.mock.calls[0]?.[1]).toMatch(/^pr-head-cache:/);
  });

  it("releases the first subscriber operation when acquiring the second side fails", async () => {
    const prepared = await standalonePreparation();
    const firstRelease = vi.fn(async () => undefined);
    const mirrors = {
      acquireSource: vi.fn()
        .mockResolvedValueOnce({
          reference: prepared.head.sourceLease,
          worktreeDir: prepared.head.sourceRoot,
          signal: new AbortController().signal,
          renew: async () => undefined,
          release: firstRelease,
        })
        .mockRejectedValueOnce(new Error("base source unavailable")),
    } as unknown as RepositoryMirrorStore;

    await expect(acquirePrPreparationSourceOperations(mirrors, prepared))
      .rejects.toThrow("base source unavailable");
    expect(firstRelease).toHaveBeenCalledTimes(1);
  });

  it("preserves source acquisition and partial-release failures together", async () => {
    const prepared = await standalonePreparation();
    const acquisitionError = new Error("base source unavailable");
    const releaseError = new Error("head source release failed");
    const firstRelease = vi.fn(async () => { throw releaseError; });
    const mirrors = {
      acquireSource: vi.fn()
        .mockResolvedValueOnce({
          reference: prepared.head.sourceLease,
          worktreeDir: prepared.head.sourceRoot,
          signal: new AbortController().signal,
          renew: async () => undefined,
          release: firstRelease,
        })
        .mockRejectedValueOnce(acquisitionError),
    } as unknown as RepositoryMirrorStore;

    const error = await acquirePrPreparationSourceOperations(mirrors, prepared)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([acquisitionError, releaseError]);
    expect(firstRelease).toHaveBeenCalledTimes(1);
  });

  it("preserves a falsy primary failure and every worktree cleanup failure", async () => {
    const mirrors = fakeMirrors({ baseHasSubdir: true });
    const prepareNormally = vi.mocked(mirrors.prepare).getMockImplementation()!;
    const baseCleanupError = new Error("base worktree release failed");
    const headCleanupError = new Error("head worktree release failed");
    const baseRelease = vi.fn(async () => { throw baseCleanupError; });
    const headRelease = vi.fn(async () => { throw headCleanupError; });
    vi.mocked(mirrors.prepare).mockImplementation(async (...args) => {
      const lease = await prepareNormally(...args);
      const prepareDetachedNormally = lease.prepareDetachedRevision.bind(lease);
      lease.prepareDetachedRevision = async (options) => {
        const detached = await prepareDetachedNormally(options);
        detached.release = baseRelease;
        return detached;
      };
      lease.release = headRelease;
      return lease;
    });
    const lifecycle = new GraphGenerationLifecycle({ cacheRoot });
    vi.spyOn(lifecycle, "reserveStage").mockRejectedValue(undefined);

    const error = await cachedPrPreparation({
      ...inputs(41, mirrors, fakeExtractionRunner()),
      generationLifecycle: lifecycle,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([
      undefined,
      baseCleanupError,
      headCleanupError,
    ]);
    expect(baseRelease).toHaveBeenCalledTimes(1);
    expect(headRelease).toHaveBeenCalledTimes(1);
  });

  it("rejects fresh extraction output bound to the wrong commit", async () => {
    const mirrors = fakeMirrors({ baseHasSubdir: true });
    const runner = fakeExtractionRunner({
      vcsCommitFor: (request) => request.changedSince ? HEAD_TWO : request.vcs?.commit ?? "",
    });

    await expect(cachedPrPreparation(inputs(41, mirrors, runner)))
      .rejects.toMatchObject({ status: 422 } satisfies Partial<WebError>);
  });

  it("treats a same-size artifact corruption as a miss and replaces the HEAD generation", async () => {
    const mirrors = fakeMirrors({ baseHasSubdir: true });
    let extractions = 0;
    const runner = fakeExtractionRunner({ onAny: async () => { extractions += 1; } });
    const first = await cachedPrPreparation(inputs(41, mirrors, runner));
    const original = readFileSync(first.head.artifactPath, "utf8");
    const corrupted = original.replace('"version":"test"', '"version":"tEst"');
    expect(Buffer.byteLength(corrupted)).toBe(Buffer.byteLength(original));
    expect(corrupted).not.toBe(original);
    makeTamperable(first.head.artifactPath);
    writeFileSync(first.head.artifactPath, corrupted, { mode: 0o600 });

    const second = await cachedPrPreparation(inputs(41, mirrors, runner));

    expect(second.cache).toBe("miss");
    expect(second.generationId).not.toBe(first.generationId);
    expect(extractions).toBe(3); // initial HEAD/base, then only the corrupt HEAD
    expect(mirrors.prepare).toHaveBeenCalledTimes(2);
  });

  it("rejects a cached projection manifest bound to a different commit", async () => {
    const mirrors = fakeMirrors({ baseHasSubdir: true });
    let extractions = 0;
    const runner = fakeExtractionRunner({ onAny: async () => { extractions += 1; } });
    const first = await cachedPrPreparation(inputs(41, mirrors, runner));
    const manifestPath = join(first.head.projectionDirectory, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      header: { target: { vcs: { commit: string } } };
    };
    manifest.header.target.vcs.commit = HEAD_TWO;
    makeTamperable(manifestPath);
    writeFileSync(manifestPath, JSON.stringify(manifest), { mode: 0o600 });

    const second = await cachedPrPreparation(inputs(41, mirrors, runner));

    expect(second.cache).toBe("miss");
    expect(second.generationId).not.toBe(first.generationId);
    expect(extractions).toBe(3);
  });

  it("rejects cached HEAD projection metadata bound to a different merge base", async () => {
    const mirrors = fakeMirrors({ baseHasSubdir: true });
    let extractions = 0;
    const runner = fakeExtractionRunner({ onAny: async () => { extractions += 1; } });
    const first = await cachedPrPreparation(inputs(41, mirrors, runner));
    const changedMetaPath = join(first.head.projectionDirectory, "changed-meta.json");
    makeTamperable(changedMetaPath);
    writeFileSync(
      changedMetaPath,
      `${JSON.stringify({ baseRef: BASE_TWO })}\n`,
      { mode: 0o600 },
    );

    const second = await cachedPrPreparation(inputs(41, mirrors, runner));

    expect(second.cache).toBe("miss");
    expect(second.generationId).not.toBe(first.generationId);
    expect(extractions).toBe(3);
  });

  it("keeps a canonical preparation usable when the optional exact-base alias cannot be written", async () => {
    const mirrors = fakeMirrors({ baseHasSubdir: true });
    let extractions = 0;
    const runner = fakeExtractionRunner({ onAny: async () => { extractions += 1; } });
    writeFileSync(join(cacheRoot, "pr-exact-lookups"), "blocked\n", { mode: 0o600 });

    const first = await cachedPrPreparation(inputs(41, mirrors, runner));
    const second = await cachedPrPreparation(inputs(41, mirrors, runner));

    expect(first.cache).toBe("miss");
    expect(existsSync(first.head.artifactPath)).toBe(true);
    expect(second.cache).toBe("hit");
    expect(second.generationId).toBe(first.generationId);
    expect(mirrors.prepare).toHaveBeenCalledTimes(2); // no accelerator alias; canonical fallback is used
    expect(extractions).toBe(2);
  });
});

describe("POST /api/pr/prepare transport", () => {
  it("emits only versioned progress/done records with two restart-safe descriptors", async () => {
    const prepared = await standalonePreparation();
    const scheduler = new InspectionScheduler<string, PrPreparationInputs, CachedPrPreparation, { stage: "resolve"; elapsedMs: number }>({
      concurrency: 1,
      execute: ({ reportProgress }) => {
        reportProgress({ stage: "resolve", elapsedMs: 1.25 });
        return prepared;
      },
    });
    const ctx = handlerContext(scheduler as Context["prInspectionScheduler"]);
    const publishMany = vi.spyOn(ctx.graphCapabilities, "publishMany");
    const publishHandoff = vi.spyOn(ctx.preparedReviewHandoffs, "publish");
    const captured = capturedResponse();
    await handlePrPrepare(ctx, requestWith({
      owner: "Org",
      repo: "Repo.git",
      prNumber: 41,
      baseRef: "main",
      headRef: "feature/x",
    }), captured.response);

    const records = captured.lines();
    expect(captured.contentType()).toContain("application/x-ndjson");
    expect(records[0]).toEqual({ version: 1, type: "progress", stage: "resolve", elapsedMs: 1.25 });
    expect(records[1]).toMatchObject({
      version: 1,
      type: "done",
      headSha: HEAD_ONE,
      baseSha: BASE_ONE,
      mergeBaseSha: MERGE_BASE,
      changedFiles: MANIFEST,
      cache: "miss",
    });
    expect(records[1]).not.toHaveProperty("stage");
    expect(records[1].changedFiles).toEqual(MANIFEST);
    expect(records.filter((record) => record.type === "done" || record.type === "error")).toHaveLength(1);
    expect(publishMany).toHaveBeenCalledOnce();
    const publishedSides = publishMany.mock.calls[0]![0];
    expect(publishedSides.map((side) => side.id)).toEqual([
      (records[1].mergeBase as Record<string, string>).graphId,
      (records[1].head as Record<string, string>).graphId,
    ]);
    expect(publishedSides[0]?.reviewContext?.side).toBe("mergeBase");
    expect(publishedSides[1]?.reviewContext?.side).toBe("head");
    expect(publishedSides[0]).not.toHaveProperty("syntheticExecutionTrust");
    expect(ctx.graphGenerationMaintenance.notePublication).toHaveBeenCalledTimes(2);
    expect(vi.mocked(ctx.graphGenerationMaintenance.notePublication).mock.invocationCallOrder[0])
      .toBeGreaterThan(publishHandoff.mock.invocationCallOrder[0]!);
    for (const side of [records[1].head, records[1].mergeBase] as Array<Record<string, unknown>>) {
      expect(side).toMatchObject({
        graphId: expect.stringMatching(/^pr-(?:head|base)-/),
        manifestUrl: expect.stringContaining("/api/graph/manifest?id="),
        projectionUrl: expect.stringContaining("/api/graph/projection?id="),
        searchUrl: expect.stringContaining("/api/graph/search?id="),
        sourceUrl: expect.stringContaining("/api/source?id="),
        metaUrl: expect.stringContaining("/api/meta?id="),
        graphSummary: expect.objectContaining({ nodeCount: 3, edgeCount: 0 }),
      });
      const handle = await ctx.graphCapabilities.acquire(side.graphId as string);
      expect(handle).not.toBeNull();
      expect(handle?.descriptor.artifact.vcsBranch).toBeNull();
      await handle?.release();
    }
    const handoff = records[1].handoff as Record<string, string>;
    expect(handoff).toEqual({
      id: expect.stringMatching(/^prh-v1-[0-9a-f]{64}$/),
      url: `/api/pr/prepared?id=${handoff.id}`,
      viewUrl: expect.stringMatching(
        new RegExp(`^/view\\?id=pr-head-.+&view=modules&prn=41&rev=1&prepared=${handoff.id}$`),
      ),
    });
    const restarted = new PreparedReviewHandoffStore({
      cacheRoot,
      graphCapabilities: ctx.graphCapabilities,
    });
    expect((await restarted.resolve(handoff.id))?.document).toMatchObject({
      version: 1,
      request: {
        owner: "org",
        repo: "repo",
        prNumber: 41,
        baseRef: "main",
        headRef: "feature/x",
      },
      headSha: HEAD_ONE,
      baseSha: BASE_ONE,
      mergeBaseSha: MERGE_BASE,
      changedFiles: MANIFEST,
    });
  });

  it("rolls back the merge-base-first capability batch when the HEAD publication fails", async () => {
    const prepared = await standalonePreparation("batch-failure");
    const sourceAuthority = fakeSourceAuthority();
    const publicationOrder: string[] = [];
    const graphCapabilities = new GraphCapabilityStore({
      cacheRoot,
      repositoryMirrors: sourceAuthority as unknown as RepositoryMirrorStore,
      beforeDescriptorPublish: (id, index) => {
        publicationOrder.push(id);
        if (index === 1) throw new Error("HEAD capability publication failed");
      },
    });
    const handoffs = new PreparedReviewHandoffStore({ cacheRoot, graphCapabilities });
    const ctx = handlerContext(
      new InspectionScheduler({ concurrency: 1, execute: () => prepared }),
      handoffs,
    );
    ctx.repositoryMirrors = sourceAuthority as unknown as RepositoryMirrorStore;
    ctx.graphCapabilities = graphCapabilities;
    const publishMany = vi.spyOn(graphCapabilities, "publishMany");
    const publishHandoff = vi.spyOn(handoffs, "publish");
    const captured = capturedResponse();

    await handlePrPrepare(ctx, requestWith({
      owner: "org", repo: "repo", prNumber: 41, baseRef: "main", headRef: "feature/x",
    }), captured.response);

    expect(publishMany).toHaveBeenCalledOnce();
    const inputs = publishMany.mock.calls[0]![0];
    expect(inputs.map((input) => input.id)).toEqual(publicationOrder);
    expect(inputs[0]?.id).toMatch(/^pr-base-/);
    expect(inputs[1]?.id).toMatch(/^pr-head-/);
    expect(inputs[0]?.generation.generationDirectory)
      .toBe(prepared.mergeBase.verifiedGeneration.generationDirectory);
    expect(inputs[0]?.reviewContext?.generation.generationDirectory)
      .toBe(prepared.head.verifiedGeneration.generationDirectory);
    expect(publishHandoff).not.toHaveBeenCalled();
    expect(captured.lines()).toEqual([{
      version: 1,
      type: "error",
      message: "internal error while preparing the pull request",
    }]);
    expect(await graphCapabilities.acquire(inputs[0]!.id)).toBeNull();
    expect(await graphCapabilities.acquire(inputs[1]!.id)).toBeNull();
    expect(ctx.graphGenerationMaintenance.notePublication).not.toHaveBeenCalled();
  });

  it("releases every transient source and generation lease before handoff publication", async () => {
    const prepared = await standalonePreparation("release-before-handoff");
    const ctx = handlerContext(new InspectionScheduler({ concurrency: 1, execute: () => prepared }));
    const sourceAuthority = fakeSourceAuthority();
    ctx.repositoryMirrors = sourceAuthority as unknown as RepositoryMirrorStore;
    const generationReleases: Array<ReturnType<typeof vi.fn>> = [];
    const acquireGeneration = ctx.graphGenerationLifecycle.acquire.bind(ctx.graphGenerationLifecycle);
    vi.spyOn(ctx.graphGenerationLifecycle, "acquire").mockImplementation(
      async (generationDirectory, options) => {
        const lease = await acquireGeneration(generationDirectory, options);
        const release = vi.fn(() => lease.release());
        generationReleases.push(release);
        return {
          generationDirectory: lease.generationDirectory,
          purpose: lease.purpose,
          release,
        };
      },
    );
    const publishHandoff = vi.spyOn(ctx.preparedReviewHandoffs, "publish");
    const captured = capturedResponse();

    await handlePrPrepare(ctx, requestWith({
      owner: "org", repo: "repo", prNumber: 41, baseRef: "main", headRef: "feature/x",
    }), captured.response);

    expect(sourceAuthority.operationReleases).toHaveLength(2);
    expect(generationReleases).toHaveLength(2);
    expect(publishHandoff).toHaveBeenCalledOnce();
    const orderedCalls = [
      ...sourceAuthority.operationReleases,
      ...generationReleases,
      publishHandoff,
    ].map((operation) => operation.mock.invocationCallOrder[0]);
    expect(orderedCalls).toEqual([...orderedCalls].sort((left, right) => left! - right!));
    expect(captured.lines().filter((record) => record.type === "done")).toHaveLength(1);
  });

  it("aggregates multiple falsy cleanup failures and emits one error without a handoff", async () => {
    const prepared = await standalonePreparation("cleanup-failure");
    const ctx = handlerContext(new InspectionScheduler({ concurrency: 1, execute: () => prepared }));
    const sourceAuthority = fakeSourceAuthority({ operationReleaseErrors: [undefined, null] });
    ctx.repositoryMirrors = sourceAuthority as unknown as RepositoryMirrorStore;
    const generationErrors: readonly unknown[] = [false, 0];
    const generationReleases: Array<ReturnType<typeof vi.fn>> = [];
    const acquireGeneration = ctx.graphGenerationLifecycle.acquire.bind(ctx.graphGenerationLifecycle);
    vi.spyOn(ctx.graphGenerationLifecycle, "acquire").mockImplementation(
      async (generationDirectory, options) => {
        const lease = await acquireGeneration(generationDirectory, options);
        const index = generationReleases.length;
        const release = vi.fn(async () => {
          await lease.release();
          throw generationErrors[index];
        });
        generationReleases.push(release);
        return {
          generationDirectory: lease.generationDirectory,
          purpose: lease.purpose,
          release,
        };
      },
    );
    const publishHandoff = vi.spyOn(ctx.preparedReviewHandoffs, "publish");
    const captured = capturedResponse();

    await handlePrPrepare(ctx, requestWith({
      owner: "org", repo: "repo", prNumber: 41, baseRef: "main", headRef: "feature/x",
    }), captured.response);

    expect(sourceAuthority.operationReleases).toHaveLength(2);
    expect(generationReleases).toHaveLength(2);
    for (const release of [...sourceAuthority.operationReleases, ...generationReleases]) {
      expect(release).toHaveBeenCalledOnce();
    }
    expect(publishHandoff).not.toHaveBeenCalled();
    expect(captured.lines()).toEqual([{
      version: 1,
      type: "error",
      message: "internal error while preparing the pull request",
    }]);
    expect(ctx.graphGenerationMaintenance.notePublication).not.toHaveBeenCalled();
  });

  it("records both miss generations only after handoff publication completes and records no hit", async () => {
    const miss = await standalonePreparation("publication-notification-miss");
    const missCtx = handlerContext(new InspectionScheduler({ concurrency: 1, execute: () => miss }));
    const publishCompleted = deferred<void>();
    const finishPublish = deferred<void>();
    const publishHandoff = missCtx.preparedReviewHandoffs.publish.bind(missCtx.preparedReviewHandoffs);
    vi.spyOn(missCtx.preparedReviewHandoffs, "publish").mockImplementation(
      async (candidate, publication) => {
        const reference = await publishHandoff(candidate, publication);
        publishCompleted.resolve();
        await finishPublish.promise;
        return reference;
      },
    );
    const missCaptured = capturedResponse();
    const handlingMiss = handlePrPrepare(missCtx, requestWith({
      owner: "org", repo: "repo", prNumber: 41, baseRef: "main", headRef: "feature/miss",
    }), missCaptured.response);

    await publishCompleted.promise;
    expect(missCaptured.lines().filter((record) => record.type === "done")).toHaveLength(1);
    expect(missCtx.graphGenerationMaintenance.notePublication).not.toHaveBeenCalled();
    finishPublish.resolve();
    await handlingMiss;
    expect(missCtx.graphGenerationMaintenance.notePublication).toHaveBeenCalledTimes(2);

    const hit: CachedPrPreparation = {
      ...await standalonePreparation("publication-notification-hit"),
      cache: "hit",
    };
    const hitCtx = handlerContext(new InspectionScheduler({ concurrency: 1, execute: () => hit }));
    const hitCaptured = capturedResponse();
    await handlePrPrepare(hitCtx, requestWith({
      owner: "org", repo: "repo", prNumber: 41, baseRef: "main", headRef: "feature/hit",
    }), hitCaptured.response);

    expect(hitCaptured.lines().filter((record) => record.type === "done")).toHaveLength(1);
    expect(hitCtx.graphGenerationMaintenance.notePublication).not.toHaveBeenCalled();
  });

  it("serves one coherent context-bound manifest, search identity, overview, and side-aware file projection", async () => {
    const prepared = await standalonePreparation("http-comparison");
    const ctx = handlerContext(new InspectionScheduler({ concurrency: 1, execute: () => prepared }));
    const done = await invokePreparation(ctx, {
      owner: "org", repo: "repo", prNumber: 41, baseRef: "main", headRef: "feature/x",
    });
    const headId = (done.head as Record<string, string>).graphId;
    const baseId = (done.mergeBase as Record<string, string>).graphId;

    const manifestFor = async (id: string) => {
      const response = capturedJsonResponse();
      await sendProjectionManifest(ctx, requestWith({}), response.value, id);
      expect(response.status()).toBe(200);
      return response.json<{
        graphId: string;
        contentId: string;
        defaultView: { view: string; filePaths: string[]; reviewCursor: string | null };
      }>();
    };
    const headManifest = await manifestFor(headId);
    const baseManifest = await manifestFor(baseId);
    expect(headManifest).toMatchObject({
      graphId: headId,
      defaultView: { view: "review", filePaths: [], reviewCursor: null },
    });
    expect(baseManifest).toMatchObject({
      graphId: baseId,
      defaultView: { view: "review", filePaths: [], reviewCursor: null },
    });
    expect(headManifest.contentId).toBe(effectiveReviewProjectionContentId(
      prepared.head.verifiedGeneration.projectionContentId,
      prepared.reviewContext.sha256,
      "head",
    ));
    expect(baseManifest.contentId).toBe(effectiveReviewProjectionContentId(
      prepared.mergeBase.verifiedGeneration.projectionContentId,
      prepared.reviewContext.sha256,
      "mergeBase",
    ));
    expect(baseManifest.contentId).not.toBe(headManifest.contentId);

    const metadataFor = async (id: string) => {
      const response = capturedJsonResponse();
      await sendReviewMetadata(ctx, requestWith({}), response.value, new URLSearchParams({ id }));
      expect(response.status()).toBe(200);
      return response.json<{
        version: number;
        metadataId: string;
        contextId: string;
        headGraphId: string;
        mergeBaseGraphId: string;
        headContentId: string;
        mergeBaseContentId: string;
        totalFiles: number;
        testClassifications: Array<{ index: number; isTest: boolean }>;
      }>();
    };
    const headMetadata = await metadataFor(headId);
    const baseMetadata = await metadataFor(baseId);
    const metadataIdentity = {
      contextId: prepared.reviewContext.sha256,
      headGraphId: headId,
      mergeBaseGraphId: baseId,
      headContentId: headManifest.contentId,
      mergeBaseContentId: baseManifest.contentId,
    };
    expect(headMetadata).toEqual({
      version: 1,
      metadataId: createHash("sha256")
        .update(graphProjectionReviewMetadataIdentityPreimage(metadataIdentity))
        .digest("hex"),
      ...metadataIdentity,
      totalFiles: MANIFEST.length,
      testClassifications: [],
    });
    expect(baseMetadata).toEqual(headMetadata);

    const projectionFor = async (id: string, reviewCursor: string | null) => {
      const response = capturedJsonResponse();
      await handleGraphProjection(
        ctx,
        requestWith({ ...defaultGraphProjectionRequest(), view: "review", reviewCursor }),
        response.value,
        new URLSearchParams({ id }),
      );
      expect(response.status()).toBe(200);
      return response.json<{
        contentId: string;
        projectionId: string;
        request: ReturnType<typeof defaultGraphProjectionRequest>;
        artifact: GraphArtifact;
        viewFacts: {
          review: {
            page: { entries: Array<ChangedFileManifestEntry & { index: number }> } | null;
            overview: {
              entries: Array<{
                index: number;
                state: "included" | "unmapped" | "filtered" | "deferred" | "absent";
                isTest: boolean | null;
              }>;
            } | null;
            selection: {
              graphPath: string | null;
              graphMatched: boolean;
              entry: ChangedFileManifestEntry & { index: number };
            } | null;
          };
        };
      }>();
    };
    for (const [id, contentId] of [
      [headId, headManifest.contentId],
      [baseId, baseManifest.contentId],
    ] as const) {
      const overview = await projectionFor(id, null);
      expect(overview.contentId).toBe(contentId);
      expect(overview.projectionId).toBe(createHash("sha256")
        .update(graphProjectionIdentityPreimage(contentId, overview.request))
        .digest("hex"));
      expect(overview.request).toEqual(expect.objectContaining({ view: "review", reviewCursor: null }));
      const expectedOverviewPaths = id === headId
        ? ["src/added.ts", "src/modified.ts", "src/new-name.ts"]
        : ["src/deleted.ts", "src/modified.ts", "src/old-name.ts"];
      expect(overview.artifact.nodes.map((node) => node.location?.file))
        .toEqual(expectedOverviewPaths);
      expect(overview.viewFacts.review.page?.entries)
        .toEqual(MANIFEST.map((entry, index) => ({ index, ...entry })));
      expect(overview.viewFacts.review.overview?.entries).toEqual(
        MANIFEST.map((entry, index) => ({
          index,
          state: id === headId
            ? entry.status === "deleted" ? "absent" : "included"
            : entry.status === "added" ? "absent" : "included",
          isTest: id === headId
            ? entry.status === "deleted" ? null : false
            : entry.status === "added" ? null : false,
        })),
      );
      expect(overview.viewFacts.review.selection).toBeNull();
    }

    const cases = [
      [headId, 0, "src/added.ts", true],
      [baseId, 0, null, false],
      [headId, 1, null, false],
      [baseId, 1, "src/deleted.ts", true],
      [headId, 3, "src/new-name.ts", true],
      [baseId, 3, "src/old-name.ts", true],
    ] as const;
    for (const [id, index, graphPath, graphMatched] of cases) {
      const projection = await projectionFor(id, `file:${index}`);
      expect(projection.viewFacts.review.selection).toMatchObject({
        graphPath,
        graphMatched,
        entry: { index, ...MANIFEST[index] },
      });
      expect(projection.artifact.nodes.map((node) => node.location?.file))
        .toEqual(graphPath === null ? [] : [graphPath]);
    }

    const searchResponse = capturedJsonResponse();
    await handleGraphSymbolSearch(
      ctx,
      requestWith({ version: 1, query: "added", mode: "map", scope: "public" }),
      searchResponse.value,
      new URLSearchParams({ id: headId }),
    );
    expect(searchResponse.json<{ graphId: string; contentId: string }>()).toMatchObject({
      graphId: headId,
      contentId: headManifest.contentId,
    });

    await expect(handleGraphProjection(
      ctx,
      requestWith(defaultGraphProjectionRequest()),
      capturedJsonResponse().value,
      new URLSearchParams({ id: headId }),
    )).rejects.toMatchObject({ status: 400 });

    makeTamperable(prepared.reviewContext.path);
    writeFileSync(prepared.reviewContext.path, "{}\n");
    const tamperedMetadata = capturedJsonResponse();
    await sendReviewMetadata(ctx, requestWith({}), tamperedMetadata.value, new URLSearchParams({ id: baseId }));
    expect(tamperedMetadata.status()).toBe(404);
    const tampered = capturedJsonResponse();
    await sendProjectionManifest(ctx, requestWith({}), tampered.value, baseId);
    expect(tampered.status()).toBe(404);
  });

  it("rejects the removed session id field at the strict request boundary", async () => {
    const ctx = handlerContext(new InspectionScheduler({ concurrency: 1, execute: () => standalonePreparation() }));
    await expect(handlePrPrepare(ctx, requestWith({
      id: "legacy-session",
      owner: "org",
      repo: "repo",
      prNumber: 41,
      baseRef: "main",
      headRef: "feature/x",
    }), capturedResponse().response)).rejects.toMatchObject({ status: 400 } satisfies Partial<WebError>);
  });

  it("uses the same successfully published descriptor ids for aliases of one immutable PR pair", async () => {
    const prepared = await standalonePreparation();
    let executions = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const ctx = handlerContext(new InspectionScheduler({
      concurrency: 1,
      execute: async () => {
        executions += 1;
        await gate;
        return prepared;
      },
    }));
    const invokeAlias = async (headRef: string) => {
      const captured = capturedResponse();
      await handlePrPrepare(ctx, requestWith({
        owner: "org", repo: "repo", prNumber: 41, baseRef: "main", headRef,
      }), captured.response);
      return captured.lines().find((record) => record.type === "done")!;
    };
    const firstPending = invokeAlias("feature/x");
    const secondPending = invokeAlias("users/alice/feature-x");
    await vi.waitFor(() => expect(executions).toBe(1));
    release();
    const [first, second] = await Promise.all([firstPending, secondPending]);

    expect(executions).toBe(1);
    expect((first.head as Record<string, unknown>).graphId)
      .toBe((second.head as Record<string, unknown>).graphId);
    expect((first.mergeBase as Record<string, unknown>).graphId)
      .toBe((second.mergeBase as Record<string, unknown>).graphId);
    expect((first.handoff as Record<string, unknown>).id)
      .not.toBe((second.handoff as Record<string, unknown>).id);
    for (const record of [first, second]) {
      for (const side of [record.head, record.mergeBase] as Array<Record<string, unknown>>) {
        const handle = await ctx.graphCapabilities.acquire(side.graphId as string);
        expect(handle).not.toBeNull();
        await handle?.release();
      }
    }
  });

  it("keeps graph ids stable across byte-identical refreshed physical generations", async () => {
    const firstPrepared = await standalonePreparation("refresh-first");
    const secondPrepared = await standalonePreparation("refresh-second");
    expect(secondPrepared.head.verifiedGeneration.artifactSha256)
      .toBe(firstPrepared.head.verifiedGeneration.artifactSha256);
    expect(secondPrepared.head.verifiedGeneration.projectionSha256)
      .toBe(firstPrepared.head.verifiedGeneration.projectionSha256);
    expect(secondPrepared.head.verifiedGeneration.sealSha256)
      .not.toBe(firstPrepared.head.verifiedGeneration.sealSha256);
    const prepared = [firstPrepared, secondPrepared];
    let execution = 0;
    const ctx = handlerContext(new InspectionScheduler({
      concurrency: 1,
      execute: () => prepared[execution++]!,
    }));
    const request = {
      owner: "org", repo: "repo", prNumber: 41, baseRef: "main", headRef: "feature/x",
    };

    const first = await invokePreparation(ctx, request);
    const second = await invokePreparation(ctx, request);

    expect((second.head as Record<string, unknown>).graphId)
      .toBe((first.head as Record<string, unknown>).graphId);
    expect((second.mergeBase as Record<string, unknown>).graphId)
      .toBe((first.mergeBase as Record<string, unknown>).graphId);
    const handle = await ctx.graphCapabilities.acquire(
      (second.head as Record<string, unknown>).graphId as string,
    );
    try {
      expect(handle?.artifactPath).toBe(realpathSync(firstPrepared.head.artifactPath));
    } finally {
      await handle?.release();
    }
  });

  it("keeps graph ids stable when base provenance moves but the merge-base is unchanged", async () => {
    const firstPrepared = await standalonePreparation("moving-base");
    const secondPrepared = { ...firstPrepared, baseSha: BASE_TWO };
    const prepared = [firstPrepared, secondPrepared];
    let execution = 0;
    const ctx = handlerContext(new InspectionScheduler({
      concurrency: 1,
      execute: () => prepared[execution++]!,
    }));
    const request = {
      owner: "org", repo: "repo", prNumber: 41, baseRef: "main", headRef: "feature/x",
    };

    const first = await invokePreparation(ctx, request);
    const second = await invokePreparation(ctx, request);

    expect((second.head as Record<string, unknown>).graphId)
      .toBe((first.head as Record<string, unknown>).graphId);
    expect((second.mergeBase as Record<string, unknown>).graphId)
      .toBe((first.mergeBase as Record<string, unknown>).graphId);
    const firstHandoff = first.handoff as { id: string };
    const secondHandoff = second.handoff as { id: string };
    expect(secondHandoff.id).not.toBe(firstHandoff.id);
    expect((await ctx.preparedReviewHandoffs.resolve(firstHandoff.id))?.document.baseSha).toBe(BASE_ONE);
    expect((await ctx.preparedReviewHandoffs.resolve(secondHandoff.id))?.document.baseSha).toBe(BASE_TWO);
  });

  it("uses a distinct HEAD id when the same HEAD revision has different merge-base semantics", async () => {
    const firstPrepared = await standalonePreparation("merge-base-first");
    const secondPrepared = await standalonePreparation("merge-base-second", MERGE_BASE_TWO);
    const prepared = [firstPrepared, secondPrepared];
    let execution = 0;
    const ctx = handlerContext(new InspectionScheduler({
      concurrency: 1,
      execute: () => prepared[execution++]!,
    }));
    const request = {
      owner: "org", repo: "repo", prNumber: 41, baseRef: "main", headRef: "feature/x",
    };

    const first = await invokePreparation(ctx, request);
    const second = await invokePreparation(ctx, request);

    expect(first.headSha).toBe(second.headSha);
    expect((second.head as Record<string, unknown>).graphId)
      .not.toBe((first.head as Record<string, unknown>).graphId);
    expect((second.mergeBase as Record<string, unknown>).graphId)
      .not.toBe((first.mergeBase as Record<string, unknown>).graphId);
    expect(second.changedFiles).toEqual(MANIFEST);
  });

  it("keeps a shared physical merge-base while publishing distinct reciprocal comparison capabilities", async () => {
    const firstPrepared = await standalonePreparation("shared-base-first");
    const secondHeadSide = await standaloneSide(
      "head",
      HEAD_TWO,
      "shared-base-second",
      MERGE_BASE,
      HEAD_TWO,
      firstPrepared.mergeBase.verifiedGeneration.projectionContentId,
    );
    const { reviewContext, ...secondHead } = secondHeadSide;
    if (!reviewContext) throw new Error("second HEAD fixture omitted its review context");
    const secondPrepared: CachedPrPreparation = {
      ...firstPrepared,
      generationId: "head-generation-shared-base-second",
      headSha: HEAD_TWO,
      head: secondHead,
      reviewContext,
    };
    const prepared = [firstPrepared, secondPrepared];
    let execution = 0;
    const ctx = handlerContext(new InspectionScheduler({
      concurrency: 1,
      execute: () => prepared[execution++]!,
    }));
    const first = await invokePreparation(ctx, {
      owner: "org", repo: "repo", prNumber: 41, baseRef: "main", headRef: "feature/one",
    });
    const second = await invokePreparation(ctx, {
      owner: "org", repo: "repo", prNumber: 42, baseRef: "main", headRef: "feature/two",
    });
    const firstHeadId = (first.head as Record<string, string>).graphId;
    const firstBaseId = (first.mergeBase as Record<string, string>).graphId;
    const secondHeadId = (second.head as Record<string, string>).graphId;
    const secondBaseId = (second.mergeBase as Record<string, string>).graphId;
    expect(secondBaseId).not.toBe(firstBaseId);

    const handles = await Promise.all([
      ctx.graphCapabilities.acquire(firstHeadId),
      ctx.graphCapabilities.acquire(firstBaseId),
      ctx.graphCapabilities.acquire(secondHeadId),
      ctx.graphCapabilities.acquire(secondBaseId),
    ]);
    const [firstHead, firstBase, secondHeadHandle, secondBase] = handles;
    try {
      expect(firstBase?.descriptor.artifact.generationPath)
        .toBe(secondBase?.descriptor.artifact.generationPath);
      expect(firstHead?.descriptor.reviewContext).toMatchObject({
        side: "head", peerGraphId: firstBaseId,
      });
      expect(firstBase?.descriptor.reviewContext).toMatchObject({
        side: "mergeBase", peerGraphId: firstHeadId,
      });
      expect(secondHeadHandle?.descriptor.reviewContext).toMatchObject({
        side: "head", peerGraphId: secondBaseId,
      });
      expect(secondBase?.descriptor.reviewContext).toMatchObject({
        side: "mergeBase", peerGraphId: secondHeadId,
      });
      expect(firstBase?.review?.context.headSha).toBe(HEAD_ONE);
      expect(secondBase?.review?.context.headSha).toBe(HEAD_TWO);
    } finally {
      await Promise.allSettled(handles.map((handle) => handle?.release()));
    }
  });

  it("checks the exact terminal line before publishing a near-limit handoff", async () => {
    const prepared = await standalonePreparation();
    const ctx = handlerContext(new InspectionScheduler({ concurrency: 1, execute: () => prepared }));
    const requestBody = {
      owner: "org", repo: "repo", prNumber: 41, baseRef: "main", headRef: "feature/x",
    };
    const initial = capturedResponse();
    await handlePrPrepare(ctx, requestWith(requestBody), initial.response);
    const initialDone = initial.lines().find((record) => record.type === "done")!;
    const initialId = (initialDone.handoff as { id: string }).id;
    const initialDocument = (await ctx.preparedReviewHandoffs.resolve(initialId))!.document;
    const { version: _version, ...handoffInput } = initialDocument;
    const candidate = candidateWithExactTerminalBytes(
      ctx.preparedReviewHandoffs,
      handoffInput,
      MAX_PREPARED_REVIEW_HANDOFF_BYTES,
    );
    expect(Buffer.byteLength(candidate.serialized)).toBeLessThanOrEqual(MAX_PREPARED_REVIEW_HANDOFF_BYTES);
    expect(Buffer.byteLength(terminalJson(candidate))).toBe(MAX_PREPARED_REVIEW_HANDOFF_BYTES);
    expect(Buffer.byteLength(`${terminalJson(candidate)}\n`)).toBe(MAX_PREPARED_REVIEW_HANDOFF_BYTES + 1);
    prepared.changedFiles = candidate.document.changedFiles;
    prepared.warnings = candidate.document.warnings;

    const captured = capturedResponse();
    await handlePrPrepare(ctx, requestWith(requestBody), captured.response);

    expect(captured.lines()).toEqual([{
      version: 1,
      type: "error",
      message: "PR preparation result exceeds the 2 MiB NDJSON line limit",
    }]);
    expect(await ctx.preparedReviewHandoffs.resolve(candidate.id)).toBeNull();
    const retained = await ctx.preparedReviewHandoffs.resolve(initialId);
    expect(retained?.document.warnings).toEqual([]);
    expect(retained?.size).toBeLessThan(MAX_PREPARED_REVIEW_HANDOFF_BYTES);
  });

  it("does not retain or deliver a handoff when the client leaves while publication is queued", async () => {
    const retainStarted = deferred<void>();
    const retainGate = deferred<void>();
    const capabilityPublishStarted = deferred<void>();
    const capabilityPublishGate = deferred<void>();
    const retainedOwners: string[] = [];
    let blockNextRetain = true;
    let blockNextCapabilityPublish = true;
    const graphCapabilities = {
      async publishMany() {
        if (!blockNextCapabilityPublish) return;
        blockNextCapabilityPublish = false;
        capabilityPublishStarted.resolve();
        await capabilityPublishGate.promise;
      },
      async acquire() { return null; },
      async retainMany(
        _bindings: readonly GraphCapabilityBinding[],
        owner: GraphCapabilityExternalOwnerKey,
      ) {
        retainedOwners.push(owner.id);
        if (!blockNextRetain) return;
        blockNextRetain = false;
        retainStarted.resolve();
        await retainGate.promise;
      },
      async releaseOwner() {},
      async reconcileOwners(
        _scope: "prepared-review-handoff",
        expectations: readonly GraphCapabilityOwnerExpectation[],
      ) {
        return { retainedOwners: expectations.map((expectation) => expectation.owner), failures: [] };
      },
    };
    const store = new PreparedReviewHandoffStore({ cacheRoot, graphCapabilities });
    const prepared = await standalonePreparation();
    const predecessor = store.prepare(handoffInput(60));
    const publishSpy = vi.spyOn(store, "publish");
    const ctx = handlerContext(
      new InspectionScheduler({ concurrency: 1, execute: () => prepared }),
      store,
    );
    ctx.graphCapabilities = graphCapabilities as unknown as Context["graphCapabilities"];
    const generationCleanupStarted = deferred<void>();
    const generationCleanupGate = deferred<void>();
    const acquireGeneration = ctx.graphGenerationLifecycle.acquire.bind(ctx.graphGenerationLifecycle);
    let generationIndex = 0;
    vi.spyOn(ctx.graphGenerationLifecycle, "acquire").mockImplementation(
      async (generationDirectory, options) => {
        const lease = await acquireGeneration(generationDirectory, options);
        const index = generationIndex;
        generationIndex += 1;
        return {
          generationDirectory: lease.generationDirectory,
          purpose: lease.purpose,
          release: async () => {
            await lease.release();
            if (index !== 1) return;
            generationCleanupStarted.resolve();
            await generationCleanupGate.promise;
          },
        };
      },
    );
    const captured = capturedResponse();
    const handling = handlePrPrepare(ctx, requestWith({
      owner: "org", repo: "repo", prNumber: 41, baseRef: "main", headRef: "feature/x",
    }), captured.response);
    // Let the request acquire and release its generation-lifecycle admission before deliberately
    // occupying the shared cache lifecycle lock. This preserves production lock order while still
    // proving cancellation of the later handoff-lock waiter.
    await capabilityPublishStarted.promise;
    capabilityPublishGate.resolve();
    await generationCleanupStarted.promise;
    const predecessorPending = store.publish(predecessor, { deliver: () => undefined });
    await retainStarted.promise;
    generationCleanupGate.resolve();
    await vi.waitFor(() => expect(publishSpy).toHaveBeenCalledTimes(2));
    captured.close();
    retainGate.resolve();

    await predecessorPending;
    await handling;
    expect(retainedOwners).toEqual([predecessor.id]);
    expect(captured.lines()).toEqual([]);
    expect(await store.scavenge()).toMatchObject({ entries: 1, removed: 0 });
  });

  it("releases both subscriber source operations when capability publication fails", async () => {
    const prepared = await standalonePreparation();
    const ctx = handlerContext(new InspectionScheduler({ concurrency: 1, execute: () => prepared }));
    const sourceAuthority = fakeSourceAuthority();
    ctx.repositoryMirrors = sourceAuthority as unknown as RepositoryMirrorStore;
    ctx.graphCapabilities = {
      async publishMany() { throw new Error("capability publication failed"); },
    } as unknown as Context["graphCapabilities"];
    const captured = capturedResponse();

    await handlePrPrepare(ctx, requestWith({
      owner: "org", repo: "repo", prNumber: 41, baseRef: "main", headRef: "feature/x",
    }), captured.response);

    expect(captured.lines()).toEqual([{
      version: 1,
      type: "error",
      message: "internal error while preparing the pull request",
    }]);
    expect(sourceAuthority.operationReleases).toHaveLength(2);
    for (const release of sourceAuthority.operationReleases) {
      expect(release).toHaveBeenCalledTimes(1);
    }
  });

  it("does not admit preparation when the request closed before cancellation listeners attach", async () => {
    const execute = vi.fn(() => standalonePreparation());
    const ctx = handlerContext(new InspectionScheduler({ concurrency: 1, execute }));
    const request = requestWith({
      owner: "org", repo: "repo", prNumber: 41, baseRef: "main", headRef: "feature/x",
    });
    Object.defineProperty(request, "aborted", { configurable: true, value: true });
    const captured = capturedResponse();

    await expect(handlePrPrepare(ctx, request, captured.response)).rejects.toMatchObject({
      status: 400,
      message: "client closed request body",
    });

    expect(execute).not.toHaveBeenCalled();
    expect(captured.lines()).toEqual([]);
    expect(await ctx.preparedReviewHandoffs.scavenge()).toMatchObject({ entries: 0 });
  });

  it("gives singleflight subscribers independent source operations when one disconnects", async () => {
    const prepared = await standalonePreparation();
    const executeGate = deferred<void>();
    let executions = 0;
    const scheduler = new InspectionScheduler<string, PrPreparationInputs, CachedPrPreparation, PrPrepareProgress>({
      concurrency: 1,
      execute: async () => {
        executions += 1;
        await executeGate.promise;
        return prepared;
      },
    });
    const firstPublishStarted = deferred<void>();
    let blockedSignal: AbortSignal | undefined;
    const graphCapabilities = {
      async publishMany(_inputs: readonly unknown[], options?: { signal?: AbortSignal }) {
        if (blockedSignal === undefined) {
          blockedSignal = options?.signal;
          firstPublishStarted.resolve();
          await rejectWhenAborted(options?.signal);
        }
      },
      async acquire() { return null; },
      async retainMany() {},
      async releaseOwner() {},
      async reconcileOwners(
        _scope: "prepared-review-handoff",
        expectations: readonly GraphCapabilityOwnerExpectation[],
      ) {
        return { retainedOwners: expectations.map((expectation) => expectation.owner), failures: [] };
      },
    };
    const handoffs = new PreparedReviewHandoffStore({
      cacheRoot,
      graphCapabilities,
    });
    const ctx = handlerContext(scheduler as Context["prInspectionScheduler"], handoffs);
    const sourceAuthority = fakeSourceAuthority();
    ctx.repositoryMirrors = sourceAuthority as unknown as RepositoryMirrorStore;
    ctx.graphCapabilities = graphCapabilities as unknown as Context["graphCapabilities"];

    const first = capturedResponse();
    const firstHandling = handlePrPrepare(ctx, requestWith({
      owner: "org", repo: "repo", prNumber: 41, baseRef: "main", headRef: "feature/first",
    }), first.response);
    await vi.waitFor(() => expect(executions).toBe(1));
    const second = capturedResponse();
    const secondHandling = handlePrPrepare(ctx, requestWith({
      owner: "org", repo: "repo", prNumber: 41, baseRef: "main", headRef: "feature/second",
    }), second.response);

    await vi.waitFor(() => expect(second.contentType()).toContain("application/x-ndjson"));
    executeGate.resolve();
    await firstPublishStarted.promise;
    first.close();
    await Promise.all([firstHandling, secondHandling]);

    expect(executions).toBe(1);
    expect(first.lines()).toEqual([]);
    expect(second.lines().some((record) => record.type === "done")).toBe(true);
    expect(sourceAuthority.acquireSource).toHaveBeenCalledTimes(4);
    expect(sourceAuthority.operationReleases).toHaveLength(4);
    for (const release of sourceAuthority.operationReleases) {
      expect(release).toHaveBeenCalledTimes(1);
    }
  });
});

function inputs(
  prNumber: number,
  mirrors: RepositoryMirrorStore,
  runExtraction: PrExtractionRunner,
  subdir?: string,
): PrPreparationInputs {
  return {
    cacheRoot,
    request: {
      owner: "org",
      repo: "repo",
      ...(subdir ? { subdir } : {}),
      prNumber,
      baseRef: "main",
      headRef: `feature/${prNumber}`,
    },
    cwd: cacheRoot,
    repositoryMirrors: mirrors,
    baseInspectionCoordinator,
    generationLifecycle: new GraphGenerationLifecycle({ cacheRoot }),
    runExtraction,
  };
}

function fakeMirrors(options: { baseHasSubdir: boolean; headHasSubdir?: boolean }): RepositoryMirrorStore {
  let sequence = 0;
  const repositoryDigest = "d".repeat(64);
  const makeLeasePaths = (commit: string) => {
    sequence += 1;
    const leaseId = createHash("sha256").update(`${sequence}:${commit}`).digest("hex");
    const root = join(cacheRoot, "repository-mirrors", "v2", repositoryDigest, "worktrees", leaseId);
    const metadata = join(cacheRoot, "repository-mirrors", "v2", repositoryDigest, "leases", `${leaseId}.json`);
    mkdirSync(root, { recursive: true, mode: 0o700 });
    mkdirSync(dirname(metadata), { recursive: true, mode: 0o700 });
    writeFileSync(metadata, "{}\n", { mode: 0o600 });
    commitsByDirectory.set(realpathSync(root), commit);
    return { leaseId, root };
  };
  return {
    prepare: vi.fn(async (request) => {
      const head = makeLeasePaths(request.head.oid);
      if (options.baseHasSubdir && options.headHasSubdir !== false) {
        mkdirSync(join(head.root, "src"), { recursive: true });
        writeFileSync(join(head.root, "src", "head.ts"), "export const head = true;\n");
      } else {
        mkdirSync(join(head.root, "pkg"), { recursive: true });
        writeFileSync(join(head.root, "pkg", request.head.oid === HEAD_ONE ? "a.ts" : "b.py"), "value = 1\n");
      }
      const parent = leaseFor(head.leaseId, head.root, request.head.oid, request.base.oid);
      parent.prepareDetachedRevision = async ({ oid }) => {
        const base = makeLeasePaths(oid);
        if (options.baseHasSubdir) {
          mkdirSync(join(base.root, "src"), { recursive: true });
          writeFileSync(join(base.root, "src", "base.ts"), "export const base = true;\n");
        }
        return detachedLeaseFor(base.leaseId, base.root, oid);
      };
      return parent;
    }),
    ...fakeSourceAuthority(),
  } as unknown as RepositoryMirrorStore;
}

function leaseFor(leaseId: string, worktreeDir: string, headOid: string, baseOid: string): RepositoryWorktreeLease {
  return {
    leaseId,
    repositoryDigest: "d".repeat(64),
    worktreeDir,
    headOid,
    baseOid,
    headRef: `refs/meridian/jobs/${leaseId}/head`,
    baseRef: `refs/meridian/jobs/${leaseId}/base`,
    prepareDetachedRevision: async () => { throw new Error("detached factory was not installed"); },
    touch() {},
    async release() {},
  };
}

function detachedLeaseFor(leaseId: string, worktreeDir: string, oid: string): RepositoryDetachedWorktreeLease {
  return {
    leaseId,
    repositoryDigest: "d".repeat(64),
    worktreeDir,
    oid,
    ref: `refs/meridian/jobs/${leaseId}/commit`,
    touch() {},
    async release() {},
  };
}

function fakeExtractionRunner(options: {
  hintsByHead?: Map<string, string[]>;
  changedFiles?: ChangedFileManifestEntry[];
  onBase?: (request: SerializablePipelineRequest) => Promise<void>;
  onAny?: (request: SerializablePipelineRequest) => Promise<void>;
  vcsCommitFor?: (request: SerializablePipelineRequest) => string;
} = {}): PrExtractionRunner {
  return async (request, worker) => {
    await options.onAny?.(request);
    const commit = request.vcs?.commit ?? "";
    const vcsCommit = options.vcsCommitFor?.(request) ?? commit;
    const isHead = request.changedSince !== undefined;
    if (!isHead) await options.onBase?.(request);
    const hintedFiles = isHead
      ? (options.hintsByHead?.get(commit) ?? ["src/head.ts"])
      : (request.hintedFiles ? [...request.hintedFiles] : ["src/base.ts"]);
    const changedFiles = isHead ? (options.changedFiles ?? MANIFEST) : [];
    const artifact: GraphArtifact = {
      schemaVersion: SCHEMA_VERSION,
      generatedAt: "2026-07-15T00:00:00.000Z",
      generator: { name: "meridian", version: "test" },
      target: {
        name: request.targetName ?? "org/repo",
        root: ".",
        language: hintedFiles.some((file) => file.endsWith(".py")) ? "python" : "typescript",
        ...(request.vcs ? { vcs: { ...request.vcs, commit: vcsCommit } } : {}),
      },
      telemetry: {
        joinKey: "node.id",
        requiredRuntimeAttributes: ["service.name", "deployment.environment.name"],
        serviceDefaulting: "forbidden",
      },
      nodes: [],
      edges: [],
      ...(isHead ? {
        extensions: { changedSince: { baseRef: request.changedSinceLabel, manifest: changedFiles } } as unknown as GraphArtifact["extensions"],
      } : {}),
    };
    const serialized = JSON.stringify(artifact);
    mkdirSync(dirname(worker.artifactOutputPath), { recursive: true, mode: 0o700 });
    writeFileSync(worker.artifactOutputPath, serialized, { mode: 0o600 });
    writeSyntheticCapabilitySidecar(worker.artifactOutputPath, dirname(worker.artifactOutputPath), artifact);
    const projectionDirectory = join(dirname(worker.artifactOutputPath), GRAPH_PROJECTION_DIRECTORY);
    const manifest = writeGraphProjectionBundle(projectionDirectory, artifact);
    const projectionIntegrity = await measureGraphProjectionBundle(projectionDirectory, cacheRoot);
    return {
      kind: "file",
      artifactPath: worker.artifactOutputPath,
      artifactBytes: Buffer.byteLength(serialized),
      artifactSha256: createHash("sha256").update(serialized).digest("hex"),
      projectionDirectory,
      ...projectionIntegrity,
      projectionContentId: manifest.contentId,
      graphSummary: graphSummaryFor(artifact),
      changedFiles,
      hintedFiles,
      ...(isHead ? { changedSinceBaseRef: request.changedSinceLabel } : {}),
      vcsCommit,
      warnings: [],
    } satisfies ExtractionWorkerResult;
  };
}

async function standalonePreparation(
  storageKey = "",
  mergeBaseSha = MERGE_BASE,
): Promise<CachedPrPreparation> {
  const mergeBase = await standaloneSide("base", mergeBaseSha, storageKey);
  const headSide = await standaloneSide(
    "head",
    HEAD_ONE,
    storageKey,
    mergeBaseSha,
    HEAD_ONE,
    mergeBase.verifiedGeneration.projectionContentId,
  );
  const { reviewContext, ...head } = headSide;
  if (!reviewContext) throw new Error("standalone HEAD fixture omitted its review context");
  const generationSuffix = storageKey ? `-${storageKey}` : "";
  return {
    analysisKey: "analysis",
    repositoryKey: "repository",
    securityDigest: "security",
    generationId: `head-generation${generationSuffix}`,
    mergeBaseGenerationId: `base-generation${generationSuffix}`,
    headSha: HEAD_ONE,
    baseSha: BASE_ONE,
    mergeBaseSha,
    changedFiles: MANIFEST,
    reviewContext,
    head,
    mergeBase,
    cache: "miss",
    timings: { resolve: 1.25 },
    warnings: [],
  };
}

async function standaloneSide(
  name: string,
  commit: string,
  storageKey = "",
  reviewMergeBaseSha = MERGE_BASE,
  reviewHeadSha = HEAD_ONE,
  reviewMergeBaseContentId?: string,
) {
  const physicalName = storageKey ? `${storageKey}-${name}` : name;
  const lifecycle = new GraphGenerationLifecycle({ cacheRoot });
  const stage = await lifecycle.reserveStage();
  const sideRoot = stage.directory;
  const generationDirectory = finalizedGenerationDirectory(
    dirname(localArtifactGenerations(cacheRoot)),
    physicalName,
  );
  mkdirSync(dirname(generationDirectory), { recursive: true, mode: 0o700 });
  const repositoryDigest = createHash("sha256").update(`repository:${physicalName}`).digest("hex");
  const leaseId = createHash("sha256").update(`lease:${physicalName}`).digest("hex");
  const sourceRoot = join(cacheRoot, "repository-mirrors", "v2", repositoryDigest, "worktrees", leaseId);
  const artifactPath = join(sideRoot, "artifact.json");
  mkdirSync(sourceRoot, { recursive: true });
  const graphPaths = name === "head"
    ? ["src/added.ts", "src/modified.ts", "src/new-name.ts"]
    : ["src/deleted.ts", "src/modified.ts", "src/old-name.ts"];
  const artifact: GraphArtifact = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: "2026-07-15T00:00:00.000Z",
    generator: { name: "meridian", version: "test" },
    target: { name, root: ".", language: "typescript", vcs: { repository: "https://github.com/org/repo.git", commit } },
    telemetry: { joinKey: "node.id", requiredRuntimeAttributes: [], serviceDefaulting: "forbidden" },
    nodes: graphPaths.map((path) => ({
      id: `module:${path}`,
      kind: "module" as const,
      qualifiedName: path,
      displayName: path,
      parentId: null,
      location: { file: path, startLine: 1 },
    })),
    edges: [],
  };
  const serialized = JSON.stringify(artifact);
  writeFileSync(artifactPath, serialized);
  writeSyntheticCapabilitySidecar(artifactPath, sourceRoot, artifact);
  const projectionDirectory = join(sideRoot, GRAPH_PROJECTION_DIRECTORY);
  const manifest = writeGraphProjectionBundle(projectionDirectory, artifact);
  const projectionIntegrity = await measureGraphProjectionBundle(projectionDirectory, cacheRoot);
  const reviewContext = name === "head"
    ? writeReviewComparisonContext(join(sideRoot, REVIEW_COMPARISON_CONTEXT_FILE), {
        headSha: reviewHeadSha,
        mergeBaseSha: reviewMergeBaseSha,
        headContentId: manifest.contentId,
        mergeBaseContentId: reviewMergeBaseContentId ?? manifest.contentId,
        analysisKey: "analysis",
        changedFiles: MANIFEST,
        testClassifications: [],
      })
    : undefined;
  let generationLease: Awaited<ReturnType<GraphGenerationLifecycle["acquire"]>> | undefined;
  try {
    const sealed = await sealGraphGeneration({
      cacheRoot,
      stage,
      artifactPath,
      projectionDirectory,
      artifactBytes: Buffer.byteLength(serialized),
      artifactSha256: createHash("sha256").update(serialized).digest("hex"),
      ...projectionIntegrity,
      projectionContentId: manifest.contentId,
      graphSummary: graphSummaryFor(artifact),
      revision: { kind: "git", commit },
    });
    generationLease = await lifecycle.acquire(generationDirectory, {
      purpose: "publication",
      allowMissing: true,
    });
    if (!await stage.publish(generationLease)) {
      throw new Error(`standalone fixture generation already exists: ${physicalName}`);
    }
    freezeGraphGenerationDirectory(cacheRoot, generationDirectory);
    const finalizedArtifactPath = join(generationDirectory, "artifact.json");
    const finalizedProjectionDirectory = join(generationDirectory, GRAPH_PROJECTION_DIRECTORY);
    const finalizedReviewContext = reviewContext
      ? { ...reviewContext, path: join(generationDirectory, REVIEW_COMPARISON_CONTEXT_FILE) }
      : undefined;
    const verifiedGeneration = await verifyExistingGraphGeneration({
      cacheRoot,
      artifactPath: finalizedArtifactPath,
      projectionDirectory: finalizedProjectionDirectory,
      artifactBytes: sealed.artifactBytes,
      artifactSha256: sealed.artifactSha256,
      projectionBytes: sealed.projectionBytes,
      projectionSha256: sealed.projectionSha256,
      projectionContentId: sealed.projectionContentId,
      graphSummary: sealed.graphSummary,
      revision: sealed.revision,
    });
    return {
      artifactPath: finalizedArtifactPath,
      projectionDirectory: finalizedProjectionDirectory,
      graphSummary: graphSummaryFor(artifact),
      sourceDir: sourceRoot,
      sourceRoot,
      sourceLease: { repositoryDigest, leaseId },
      verifiedGeneration,
      ...(finalizedReviewContext ? { reviewContext: finalizedReviewContext } : {}),
    };
  } finally {
    await stage.release();
    await generationLease?.release();
  }
}

function handlerContext(
  scheduler: Context["prInspectionScheduler"],
  suppliedHandoffs?: PreparedReviewHandoffStore,
): Context {
  const repositoryMirrors = testRepositoryMirrors();
  const graphCapabilities = new GraphCapabilityStore({ cacheRoot, repositoryMirrors });
  const preparedReviewHandoffs = suppliedHandoffs ?? new PreparedReviewHandoffStore({
    cacheRoot,
    graphCapabilities,
  });
  return {
    shutdownSignal: new AbortController().signal,
    prInspectionScheduler: scheduler,
    prBaseInspectionCoordinator: baseInspectionCoordinator,
    graphCapabilities,
    graphGenerationLifecycle: new GraphGenerationLifecycle({ cacheRoot }),
    graphGenerationMaintenance: {
      notePublication: vi.fn(),
    } as unknown as Context["graphGenerationMaintenance"],
    preparedReviewHandoffs,
    repositoryMirrors,
    runExtraction: async () => { throw new Error("unused"); },
    cacheRoot,
    refreshCache: false,
    cwd: cacheRoot,
    sessions: new SessionStore(),
    github: createGitHubClient({ clientId: "Iv1.test" }),
    graphProjectionAdmission: createGraphProjectionAdmission(),
    graphProjectionRegistry: new GraphProjectionRegistry(),
  } as unknown as Context;
}

function makeTamperable(path: string): void {
  chmodSync(dirname(path), 0o700);
  chmodSync(path, 0o600);
}

function testRepositoryMirrors(): RepositoryMirrorStore {
  return fakeSourceAuthority() as unknown as RepositoryMirrorStore;
}

function fakeSourceAuthority(options: { operationReleaseErrors?: readonly unknown[] } = {}) {
  const retained = new Set<string>();
  const operationReleases: Array<ReturnType<typeof vi.fn>> = [];
  return {
    operationReleases,
    retainSource: vi.fn(async (
      reference: { repositoryDigest: string; leaseId: string },
      _root: string,
      owner: string,
    ) => {
      const key = `${reference.repositoryDigest}:${reference.leaseId}:${owner}`;
      const added = !retained.has(key);
      retained.add(key);
      return added;
    }),
    releaseSource: vi.fn(async (
      reference: { repositoryDigest: string; leaseId: string },
      owner: string,
    ) => {
      retained.delete(`${reference.repositoryDigest}:${reference.leaseId}:${owner}`);
    }),
    acquireSource: vi.fn(async (
      reference: { repositoryDigest: string; leaseId: string },
      root: string,
      _purpose: string,
      signal?: AbortSignal,
    ) => {
      signal?.throwIfAborted();
      const ownership = new AbortController();
      const releaseIndex = operationReleases.length;
      const release = vi.fn(async () => {
        if (releaseIndex < (options.operationReleaseErrors?.length ?? 0)) {
          throw options.operationReleaseErrors![releaseIndex];
        }
      });
      operationReleases.push(release);
      return {
        reference: { ...reference },
        worktreeDir: root,
        signal: ownership.signal,
        renew: async () => undefined,
        release,
      };
    }),
  };
}

async function rejectWhenAborted(signal?: AbortSignal): Promise<never> {
  if (!signal) throw new Error("source publication omitted its ownership signal");
  if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
  return new Promise<never>((_resolve, reject) => {
    signal.addEventListener("abort", () => {
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    }, { once: true });
  });
}

function requestWith(body: unknown): IncomingMessage {
  return Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), {
    headers: {},
    once: Readable.prototype.once,
    off: Readable.prototype.off,
  }) as unknown as IncomingMessage;
}

async function invokePreparation(
  ctx: Context,
  body: {
    owner: string;
    repo: string;
    prNumber: number;
    baseRef: string;
    headRef: string;
    subdir?: string;
  },
): Promise<Record<string, unknown>> {
  const captured = capturedResponse();
  await handlePrPrepare(ctx, requestWith(body), captured.response);
  const records = captured.lines();
  expect(records.filter((record) => record.type === "error")).toEqual([]);
  const done = records.find((record) => record.type === "done");
  expect(done).toBeDefined();
  return done!;
}

function capturedResponse() {
  let body = "";
  let contentType = "";
  const listeners = new Map<string, () => void>();
  const response = {
    writableEnded: false,
    writeHead(_status: number, headers?: Record<string, string>) {
      contentType = headers?.["content-type"] ?? "";
      return response;
    },
    setHeader() {},
    write(chunk: unknown) { body += String(chunk); return true; },
    end(chunk?: unknown) { if (chunk !== undefined) body += String(chunk); response.writableEnded = true; },
    once(event: string, listener: () => void) { listeners.set(event, listener); return response; },
    off(event: string) { listeners.delete(event); return response; },
  };
  return {
    response: response as unknown as ServerResponse,
    contentType: () => contentType,
    lines: () => body.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>),
    close: () => listeners.get("close")?.(),
  };
}

function capturedJsonResponse() {
  const response = new EventEmitter() as EventEmitter & ServerResponse;
  let body = "";
  let status = 0;
  Object.assign(response, {
    writableEnded: false,
    destroyed: false,
    writeHead(code: number) {
      status = code;
      return response;
    },
    setHeader() {},
    write(chunk: unknown, callback?: (error?: Error | null) => void) {
      body += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      callback?.(null);
      return true;
    },
    end(chunk?: unknown, callback?: () => void) {
      if (chunk !== undefined) body += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      Object.assign(response, { writableEnded: true });
      callback?.();
      response.emit("finish");
      return response;
    },
  });
  return {
    value: response,
    status: () => status,
    json: <Value>() => JSON.parse(body) as Value,
  };
}

function handoffInput(prNumber: number): PreparedReviewHandoffInput {
  return {
    request: {
      owner: "org", repo: "repo", prNumber, baseRef: "main", headRef: `feature/${prNumber}`,
    },
    headSha: HEAD_ONE,
    baseSha: BASE_ONE,
    mergeBaseSha: MERGE_BASE,
    changedFiles: MANIFEST,
    head: handoffDescriptor(`queued-head-${prNumber}`),
    mergeBase: handoffDescriptor(`queued-base-${prNumber}`),
    cache: "miss",
    timings: {},
    warnings: [],
  };
}

function handoffDescriptor(graphId: string) {
  const id = encodeURIComponent(graphId);
  return {
    graphId,
    manifestUrl: `/api/graph/manifest?id=${id}`,
    projectionUrl: `/api/graph/projection?id=${id}`,
    searchUrl: `/api/graph/search?id=${id}`,
    sourceUrl: `/api/source?id=${id}`,
    metaUrl: `/api/meta?id=${id}`,
    graphSummary: {
      schemaVersion: SCHEMA_VERSION,
      generatedAt: "2026-07-17T00:00:00.000Z",
      nodeCount: 0,
      edgeCount: 0,
    },
  };
}

function candidateWithExactTerminalBytes(
  store: PreparedReviewHandoffStore,
  input: Omit<PreparedReviewHandoffDocument, "version">,
  targetBytes: number,
) {
  // Changed-file records carry most of a valid v1 line's bounded payload. Find the largest valid
  // prefix below the line ceiling, then use one bounded warning to fill the sub-record remainder.
  const files = Array.from({ length: 100_000 }, (_, index) => ({
    path: `f/${index.toString(36)}`,
    status: "modified" as const,
  }));
  let low = 0;
  let high = files.length;
  let fileCount = 0;
  let candidate = store.prepare({ ...input, changedFiles: [], warnings: [] });
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    try {
      const next = store.prepare({ ...input, changedFiles: files.slice(0, middle), warnings: [] });
      const bytes = Buffer.byteLength(terminalJson(next));
      if (bytes <= targetBytes) {
        candidate = next;
        fileCount = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    } catch {
      high = middle - 1;
    }
  }

  let gap = targetBytes - Buffer.byteLength(terminalJson(candidate));
  if (gap === 1) {
    fileCount -= 1;
    candidate = store.prepare({ ...input, changedFiles: files.slice(0, fileCount), warnings: [] });
    gap = targetBytes - Buffer.byteLength(terminalJson(candidate));
  }
  if (gap > 0) {
    low = 0;
    high = Math.min(4_000, gap);
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const next = store.prepare({
        ...input,
        changedFiles: files.slice(0, fileCount),
        warnings: ["x".repeat(middle)],
      });
      const bytes = Buffer.byteLength(terminalJson(next));
      if (bytes <= targetBytes) {
        candidate = next;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
  }
  expect(Buffer.byteLength(terminalJson(candidate))).toBe(targetBytes);
  return candidate;
}

function terminalJson(candidate: ReturnType<PreparedReviewHandoffStore["prepare"]>): string {
  return JSON.stringify({
    version: 1,
    type: "done",
    headSha: candidate.document.headSha,
    baseSha: candidate.document.baseSha,
    mergeBaseSha: candidate.document.mergeBaseSha,
    changedFiles: candidate.document.changedFiles,
    head: candidate.document.head,
    mergeBase: candidate.document.mergeBase,
    cache: candidate.document.cache,
    timings: candidate.document.timings,
    warnings: candidate.document.warnings,
    handoff: candidate.reference,
  });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}
