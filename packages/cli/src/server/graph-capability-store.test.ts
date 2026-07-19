import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SCHEMA_VERSION, type ChangedFileManifestEntry, type GraphArtifact } from "@meridian/core";
import {
  GraphCapabilityStore,
  isGraphCapabilityId,
  type GraphCapabilityDescriptor,
  type GraphCapabilityExternalOwnerKey,
  type GraphCapabilityStoreOptions,
} from "./graph-capability-store";
import { GRAPH_PROJECTION_DIRECTORY, writeGraphProjectionBundle } from "./graph-projection-bundle";
import {
  freezeGraphGenerationDirectory,
  isVerifiedGraphGeneration,
  measureGraphProjectionBundle,
  sealGraphGeneration,
  verifyGraphGeneration,
  type SealedGraphGenerationStage,
  type VerifiedGraphGeneration,
} from "./graph-generation-verifier";
import { GraphGenerationLifecycle } from "./graph-generation-lifecycle";
import {
  finalizedGenerationDirectory,
  repositoryArtifactEntry,
} from "./graph-cache-layout";
import type { RepositorySourceLeaseReference } from "./repository-mirror";
import { writeSyntheticCapabilitySidecar } from "./synthetic-capability-sidecar";
import { PreparedReviewHandoffStore } from "./prepared-review-handoff-store";
import { removeEntry } from "./web-cache-storage";
import { CacheRootLifecycleLock } from "./cache-root-lifecycle-lock";
import {
  REVIEW_COMPARISON_CONTEXT_FILE,
  writeReviewComparisonContext,
  type ReviewComparisonContextReference,
} from "./review-comparison-context";

const HEAD_SHA = "1".repeat(40);
const BASE_SHA = "c".repeat(40);
const REPOSITORY_DIGEST = "a".repeat(64);

let cacheRoot: string;
let outsideRoot: string;

beforeEach(() => {
  cacheRoot = mkdtempSync(join(tmpdir(), "meridian-graph-capability-"));
  outsideRoot = mkdtempSync(join(tmpdir(), "meridian-graph-capability-outside-"));
});

afterEach(() => {
  removeEntry(cacheRoot);
  removeEntry(outsideRoot);
});

describe("GraphCapabilityStore", () => {
  it("aborts every startup maintenance pass while waiting for lifecycle admission", async () => {
    const mirrors = mirrorAuthority();
    const store = new GraphCapabilityStore({ cacheRoot, repositoryMirrors: mirrors.authority });
    const entered = deferred<void>();
    const release = deferred<void>();
    const holding = new CacheRootLifecycleLock(cacheRoot).runExclusive(async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;

    const starts: Array<(signal: AbortSignal) => Promise<unknown>> = [
      (signal) => store.reconcile({ signal }),
      (signal) => store.scavenge({ signal }),
      (signal) => store.reconcileOwners("prepared-review-handoff", [], { signal }),
    ];
    for (const start of starts) {
      const controller = new AbortController();
      const reason = new DOMException("shutdown", "AbortError");
      const pending = start(controller.signal);
      controller.abort(reason);
      await expect(pending).rejects.toBe(reason);
    }
    expect(mirrors.retained).toEqual([]);
    expect(mirrors.released).toEqual([]);

    release.resolve();
    await holding;
  });

  it("cancels startup reconciliation mid-source admission and repairs on restart", async () => {
    const fixture = await capabilityFixture("reconcile-abort", HEAD_SHA, { sourceLease: sourceLease("9") });
    const initialMirrors = mirrorAuthority();
    const initial = new GraphCapabilityStore({ cacheRoot, repositoryMirrors: initialMirrors.authority });
    await initial.publish(managedInput("reconcile-abort", fixture, sourceLease("9")));

    const entered = deferred<void>();
    const cancellingAuthority: GraphCapabilityStoreOptions["repositoryMirrors"] = {
      async retainSource(_reference, _root, _owner, _until, options) {
        entered.resolve();
        await new Promise<never>((_resolve, reject) => {
          const abort = () => reject(options?.signal?.reason);
          if (options?.signal?.aborted) abort();
          else options?.signal?.addEventListener("abort", abort, { once: true });
        });
        return false;
      },
      async releaseSource() {},
    };
    const restarted = new GraphCapabilityStore({ cacheRoot, repositoryMirrors: cancellingAuthority });
    const controller = new AbortController();
    const reason = new DOMException("shutdown", "AbortError");
    const pending = restarted.reconcile({ signal: controller.signal });
    await entered.promise;
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);

    const recovered = new GraphCapabilityStore({ cacheRoot, repositoryMirrors: initialMirrors.authority });
    await expect(recovered.reconcile()).resolves.toBeUndefined();
    const handle = await recovered.acquire("reconcile-abort");
    expect(handle).not.toBeNull();
    await handle?.release();
  });

  it("leaves an abortable owner release restart-recoverable during scoped reconciliation", async () => {
    const lease = sourceLease("e");
    const fixture = await capabilityFixture("owner-release-abort", HEAD_SHA, { sourceLease: lease });
    const mirrors = mirrorAuthority();
    const original = new GraphCapabilityStore({ cacheRoot, repositoryMirrors: mirrors.authority });
    await publishManaged(original, "owner-release-abort", fixture, lease);
    const owner = preparedOwner("e");
    await original.retainMany(
      [{ id: "owner-release-abort", expectedVcsCommit: HEAD_SHA }],
      owner,
      Date.now() + 60_000,
    );

    const releaseEntered = deferred<void>();
    const cancellingAuthority: GraphCapabilityStoreOptions["repositoryMirrors"] = {
      async retainSource() { return false; },
      async releaseSource(_reference, _owner, options) {
        releaseEntered.resolve();
        await new Promise<never>((_resolve, reject) => {
          const abort = () => reject(options?.signal?.reason);
          if (options?.signal?.aborted) abort();
          else options?.signal?.addEventListener("abort", abort, { once: true });
        });
      },
    };
    const restarted = new GraphCapabilityStore({ cacheRoot, repositoryMirrors: cancellingAuthority });
    const controller = new AbortController();
    const reason = new DOMException("shutdown", "AbortError");
    const pending = restarted.reconcileOwners("prepared-review-handoff", [], {
      signal: controller.signal,
    });
    await releaseEntered.promise;
    controller.abort(reason);
    const failure = await pending.catch((error: unknown) => error);
    expect(flattenErrors(failure)).toContain(reason);
    expect(readOwnerRecord("owner-release-abort", owner)).toMatchObject({ state: "releasing" });

    const recovered = new GraphCapabilityStore({ cacheRoot, repositoryMirrors: mirrors.authority });
    await expect(recovered.reconcileOwners("prepared-review-handoff", []))
      .resolves.toMatchObject({ retainedOwners: [], failures: [] });
    expect(() => readFileSync(ownerRecordPath("owner-release-abort", owner), "utf8")).toThrow();
  });

  it("cancels public owner release during source admission and completes it after restart", async () => {
    const lease = sourceLease("f");
    const fixture = await capabilityFixture("public-owner-release-abort", HEAD_SHA, {
      sourceLease: lease,
    });
    const mirrors = mirrorAuthority();
    const original = new GraphCapabilityStore({ cacheRoot, repositoryMirrors: mirrors.authority });
    await publishManaged(original, "public-owner-release-abort", fixture, lease);
    const owner = preparedOwner("f");
    await original.retainMany(
      [{ id: "public-owner-release-abort", expectedVcsCommit: HEAD_SHA }],
      owner,
      Date.now() + 60_000,
    );

    const releaseEntered = deferred<void>();
    const blockedAuthority: GraphCapabilityStoreOptions["repositoryMirrors"] = {
      async retainSource() { return false; },
      async releaseSource(_reference, _owner, options) {
        releaseEntered.resolve();
        await new Promise<never>((_resolve, reject) => {
          const abort = () => reject(options?.signal?.reason);
          if (options?.signal?.aborted) abort();
          else options?.signal?.addEventListener("abort", abort, { once: true });
        });
      },
    };
    const restarted = new GraphCapabilityStore({ cacheRoot, repositoryMirrors: blockedAuthority });
    const controller = new AbortController();
    const reason = new DOMException("shutdown", "AbortError");
    const pending = restarted.releaseOwner(owner, { signal: controller.signal });
    await releaseEntered.promise;
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    expect(readOwnerRecord("public-owner-release-abort", owner)).toMatchObject({
      state: "releasing",
    });

    const recovered = new GraphCapabilityStore({ cacheRoot, repositoryMirrors: mirrors.authority });
    await expect(recovered.releaseOwner(owner)).resolves.toBeUndefined();
    expect(() => readFileSync(ownerRecordPath("public-owner-release-abort", owner), "utf8"))
      .toThrow();
  });
  it("rolls back every retained source when the second batch retain fails", async () => {
    const head = await capabilityFixture("batch-retain-head", HEAD_SHA, { sourceLease: sourceLease("1") });
    const base = await capabilityFixture("batch-retain-base", BASE_SHA, { sourceLease: sourceLease("2") });
    const mirrors = mirrorAuthority();
    mirrors.failRetainForLeaseId = sourceLease("2").leaseId;
    const store = new GraphCapabilityStore({ cacheRoot, repositoryMirrors: mirrors.authority });
    const inputs = [
      managedInput("batch-head", head, sourceLease("1")),
      managedInput("batch-base", base, sourceLease("2")),
    ];

    await expect(store.publishMany(inputs)).rejects.toThrow("HEAD source disappeared");
    expect(existsSync(descriptorDirectory("batch-head"))).toBe(false);
    expect(existsSync(descriptorDirectory("batch-base"))).toBe(false);
    expect(mirrors.released.map((call) => call.owner)).toEqual(["capability:batch-head"]);
  });

  it("removes the first descriptor and both source owners when second publication fails", async () => {
    const head = await capabilityFixture("batch-publish-head", HEAD_SHA, { sourceLease: sourceLease("3") });
    const base = await capabilityFixture("batch-publish-base", BASE_SHA, { sourceLease: sourceLease("4") });
    const mirrors = mirrorAuthority();
    const store = new GraphCapabilityStore({
      cacheRoot,
      repositoryMirrors: mirrors.authority,
      beforeDescriptorPublish: (_id, index) => { if (index === 1) throw new Error("second publish failed"); },
    });

    await expect(store.publishMany([
      managedInput("publish-head", head, sourceLease("3")),
      managedInput("publish-base", base, sourceLease("4")),
    ])).rejects.toThrow("second publish failed");
    expect(existsSync(descriptorDirectory("publish-head"))).toBe(false);
    expect(existsSync(descriptorDirectory("publish-base"))).toBe(false);
    expect(new Set(mirrors.released.map((call) => call.owner))).toEqual(new Set([
      "capability:publish-head",
      "capability:publish-base",
    ]));
  });

  it("preserves a matching existing descriptor and owner when a new batch member fails", async () => {
    const existing = await capabilityFixture("batch-existing", HEAD_SHA, { sourceLease: sourceLease("5") });
    const added = await capabilityFixture("batch-added", BASE_SHA, { sourceLease: sourceLease("6") });
    const mirrors = mirrorAuthority();
    const store = new GraphCapabilityStore({ cacheRoot, repositoryMirrors: mirrors.authority });
    const existingInput = managedInput("batch-existing", existing, sourceLease("5"));
    await store.publish(existingInput);
    const failing = new GraphCapabilityStore({
      cacheRoot,
      repositoryMirrors: mirrors.authority,
      beforeDescriptorPublish: (id) => { if (id === "batch-added") throw new Error("new publish failed"); },
    });

    await expect(failing.publishMany([
      existingInput,
      managedInput("batch-added", added, sourceLease("6")),
    ])).rejects.toThrow("new publish failed");
    expect(existsSync(descriptorDirectory("batch-existing"))).toBe(true);
    expect(existsSync(descriptorDirectory("batch-added"))).toBe(false);
    expect(mirrors.released.map((call) => call.owner)).not.toContain("capability:batch-existing");
    expect(mirrors.released.map((call) => call.owner)).toContain("capability:batch-added");
  });

  it("preserves a falsy publication failure and every rollback failure", async () => {
    const head = await capabilityFixture("batch-falsy-head", HEAD_SHA, { sourceLease: sourceLease("7") });
    const base = await capabilityFixture("batch-falsy-base", BASE_SHA, { sourceLease: sourceLease("8") });
    const headRelease = new Error("head rollback failed");
    const baseRelease = new Error("base rollback failed");
    const authority: GraphCapabilityStoreOptions["repositoryMirrors"] = {
      async retainSource() { return true; },
      async releaseSource(_reference, owner) {
        if (owner === "capability:falsy-head") throw headRelease;
        if (owner === "capability:falsy-base") throw baseRelease;
      },
    };
    const store = new GraphCapabilityStore({
      cacheRoot,
      repositoryMirrors: authority,
      beforeDescriptorPublish: (_id, index) => { if (index === 1) throw undefined; },
    });

    const error = await store.publishMany([
      managedInput("falsy-head", head, sourceLease("7")),
      managedInput("falsy-base", base, sourceLease("8")),
    ]).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([undefined, baseRelease, headRelease]);
    expect(existsSync(descriptorDirectory("falsy-head"))).toBe(false);
    expect(existsSync(descriptorDirectory("falsy-base"))).toBe(false);
  });
  it("recovers one coherent graph/source capability after restart without retaining graph bytes", async () => {
    const fixture = await capabilityFixture("head", HEAD_SHA);
    const mirrors = mirrorAuthority();
    const original = new GraphCapabilityStore({ cacheRoot, repositoryMirrors: mirrors.authority });
    const descriptor = await original.publish({
      id: "pr-head",
      generation: fixture.generation,
      vcsBranch: "feature/review",
      sourceRoot: fixture.sourceRoot,
      sourceSubdir: "apps/api",
      source: { kind: "github", owner: "org", repo: "repo", subdir: "apps/api" },
      publishedAt: "2026-07-17T10:00:00.000Z",
    });

    expect(descriptor.artifact.path).not.toContain(cacheRoot);
    expect(descriptor.source.kind).toBe("managed-cache");
    if (descriptor.source.kind !== "managed-cache") throw new Error("expected managed source");
    expect(descriptor.source.rootPath).not.toContain(cacheRoot);
    expect(descriptor).not.toHaveProperty("nodes");
    expect(descriptor).not.toHaveProperty("edges");

    const restarted = new GraphCapabilityStore({ cacheRoot, repositoryMirrors: mirrors.authority });
    const handle = await restarted.acquire("pr-head");
    expect(handle).not.toBeNull();
    try {
      expect(handle?.descriptor).toEqual(descriptor);
      expect(handle?.artifactPath).toBe(realpathSync(fixture.artifactPath));
      expect(handle?.projectionDirectory).toBe(realpathSync(fixture.projectionDirectory));
      expect(handle?.generationDirectory).toBe(realpathSync(fixture.generationDirectory));
      expect(handle?.source).toMatchObject({
        rootDir: realpathSync(fixture.sourceRoot),
        sourceDir: realpathSync(join(fixture.sourceRoot, "apps", "api")),
        subdir: "apps/api",
        metadata: { kind: "github", owner: "org", repo: "repo", subdir: "apps/api" },
        owner: null,
      });
      await handle?.renew();
    } finally {
      await handle?.release();
    }
  });

  it("rejects a sealed mutable stage at both the static and runtime publication boundaries", async () => {
    const fixture = await capabilityFixture("unpublished-stage", HEAD_SHA);
    const store = new GraphCapabilityStore({
      cacheRoot,
      repositoryMirrors: mirrorAuthority().authority,
    });

    expect(isVerifiedGraphGeneration(fixture.sealedStage)).toBe(false);
    await expect(store.publish({
      id: "unpublished-stage",
      // @ts-expect-error A sealed stage is deliberately not a finalized graph capability.
      generation: fixture.sealedStage,
      sourceRoot: fixture.sourceRoot,
      source: { kind: "other" },
    })).rejects.toThrow(/generation identity is invalid/);
  });

  it("retries generation-root discovery across concurrent descriptor publication", async () => {
    const fixture = await capabilityFixture("root-descriptor", HEAD_SHA);
    const entered = deferred<void>();
    const resume = deferred<void>();
    let scans = 0;
    const store = new GraphCapabilityStore({
      cacheRoot,
      repositoryMirrors: mirrorAuthority().authority,
      beforeGenerationRootScan: async () => {
        scans += 1;
        if (scans === 1) {
          entered.resolve();
          await resume.promise;
        }
      },
    });
    const pending = store.snapshotGenerationRoots();
    await entered.promise;
    const descriptor = await store.publish({
      id: "root-descriptor",
      generation: fixture.generation,
      sourceRoot: fixture.sourceRoot,
      source: { kind: "other" },
    });
    resume.resolve();

    const snapshot = await pending;
    expect(scans).toBeGreaterThanOrEqual(2);
    expect(snapshot.descriptorGenerationPaths).toContain(descriptor.artifact.generationPath);
    expect(snapshot.generationPaths).toContain(descriptor.artifact.generationPath);
    expect(store.generationRootSnapshotIsCurrent(snapshot)).toBe(true);
  });

  it("retries generation-root discovery across concurrent reader publication", async () => {
    const fixture = await capabilityFixture("root-reader", HEAD_SHA);
    const entered = deferred<void>();
    const resume = deferred<void>();
    let scans = 0;
    const store = new GraphCapabilityStore({
      cacheRoot,
      repositoryMirrors: mirrorAuthority().authority,
      beforeGenerationRootScan: async () => {
        scans += 1;
        if (scans === 1) {
          entered.resolve();
          await resume.promise;
        }
      },
    });
    const descriptor = await store.publish({
      id: "root-reader",
      generation: fixture.generation,
      sourceRoot: fixture.sourceRoot,
      source: { kind: "other" },
    });
    const pending = store.snapshotGenerationRoots();
    await entered.promise;
    const handle = await store.acquire("root-reader");
    resume.resolve();

    try {
      const snapshot = await pending;
      expect(scans).toBeGreaterThanOrEqual(2);
      expect(snapshot.readerGenerationPaths).toContain(descriptor.artifact.generationPath);
      expect(store.generationRootSnapshotIsCurrent(snapshot)).toBe(true);
    } finally {
      await handle?.release();
    }
  });

  it("pins primary and sealed comparison-context generations for descriptors and readers", async () => {
    const base = await capabilityFixture("comparison-base", BASE_SHA);
    const head = await capabilityFixture("comparison-head", HEAD_SHA, {
      reviewContext: {
        mergeBaseSha: BASE_SHA,
        mergeBaseContentId: base.generation.projectionContentId,
        analysisKey: "comparison-analysis",
        changedFiles: [{ path: "src/review.ts", status: "modified" }],
      },
    });
    if (!head.reviewContext) throw new Error("comparison fixture omitted its sealed context");
    const store = new GraphCapabilityStore({
      cacheRoot,
      repositoryMirrors: mirrorAuthority().authority,
    });
    const headInput = {
      id: "comparison-head",
      generation: head.generation,
      sourceRoot: head.sourceRoot,
      source: { kind: "other" as const },
      reviewContext: {
        reference: head.reviewContext,
        side: "head" as const,
        peerGraphId: "comparison-base",
        generation: head.generation,
      },
    };
    const baseInput = {
      id: "comparison-base",
      generation: base.generation,
      sourceRoot: base.sourceRoot,
      source: { kind: "other" } as const,
      reviewContext: {
        reference: head.reviewContext,
        side: "mergeBase" as const,
        peerGraphId: "comparison-head",
        generation: head.generation,
      },
    };
    const [, baseDescriptor] = await store.publishMany([headInput, baseInput]);
    await expect(store.publish(baseInput)).resolves.toEqual(baseDescriptor);
    if (!baseDescriptor.reviewContext) throw new Error("comparison descriptor omitted its context");
    const expectedRoots = new Set([
      baseDescriptor.artifact.generationPath,
      baseDescriptor.reviewContext.generationRoot,
    ]);

    const descriptorSnapshot = await store.snapshotGenerationRoots();
    expect(descriptorSnapshot.descriptorGenerationPaths).toEqual(expectedRoots);

    const handle = await store.acquire("comparison-base");
    try {
      expect(handle?.review).toMatchObject({
        contextId: head.reviewContext.sha256,
        side: "mergeBase",
        context: {
          headSha: HEAD_SHA,
          mergeBaseSha: BASE_SHA,
          changedFiles: [{ path: "src/review.ts", status: "modified" }],
        },
      });
      const readerSnapshot = await store.snapshotGenerationRoots();
      expect(readerSnapshot.readerGenerationPaths).toEqual(expectedRoots);
    } finally {
      await handle?.release();
    }

    chmodSync(head.reviewContext.path, 0o600);
    writeFileSync(head.reviewContext.path, "{}\n");
    await expect(store.acquire("comparison-base")).resolves.toBeNull();
    expect((await store.snapshotGenerationRoots()).descriptorGenerationPaths)
      .toEqual(new Set([baseDescriptor.reviewContext.generationRoot]));
  });

  it.each(["peer", "context", "content"] as const)(
    "fails closed when a persisted review %s binding disagrees with its reciprocal capability",
    async (mismatch) => {
      const base = await capabilityFixture(`reciprocal-${mismatch}-base`, BASE_SHA);
      const head = await capabilityFixture(`reciprocal-${mismatch}-head`, HEAD_SHA, {
        reviewContext: {
          mergeBaseSha: BASE_SHA,
          mergeBaseContentId: base.generation.projectionContentId,
          analysisKey: `reciprocal-${mismatch}`,
          changedFiles: [{ path: "src/review.ts", status: "modified" }],
        },
      });
      if (!head.reviewContext) throw new Error("reciprocal fixture omitted its review context");
      const store = new GraphCapabilityStore({
        cacheRoot,
        repositoryMirrors: mirrorAuthority().authority,
      });
      await store.publishMany([
        {
          id: "reciprocal-head",
          generation: head.generation,
          sourceRoot: head.sourceRoot,
          source: { kind: "other" },
          reviewContext: {
            reference: head.reviewContext,
            side: "head",
            peerGraphId: "reciprocal-base",
            generation: head.generation,
          },
        },
        {
          id: "reciprocal-base",
          generation: base.generation,
          sourceRoot: base.sourceRoot,
          source: { kind: "other" },
          reviewContext: {
            reference: head.reviewContext,
            side: "mergeBase",
            peerGraphId: "reciprocal-head",
            generation: head.generation,
          },
        },
      ]);
      rewriteDescriptor("reciprocal-base", (descriptor) => mismatch === "content"
        ? {
            ...descriptor,
            artifact: { ...descriptor.artifact, projectionContentId: "d".repeat(64) },
          }
        : {
            ...descriptor,
            reviewContext: {
              ...descriptor.reviewContext!,
              ...(mismatch === "peer"
                ? { peerGraphId: "different-head" }
                : { sha256: "e".repeat(64) }),
            },
          });

      await expect(store.acquire("reciprocal-head")).resolves.toBeNull();
    },
  );

  it("physically deletes a hostile quarantine tree only after releasing lifecycle admission", async () => {
    const entered = deferred<void>();
    const resume = deferred<void>();
    const store = new GraphCapabilityStore({
      cacheRoot,
      repositoryMirrors: mirrorAuthority().authority,
      beforePhysicalCleanup: async () => {
        entered.resolve();
        await resume.promise;
      },
    });
    let hostile = join(
      cacheRoot,
      "graph-capabilities",
      "v1",
      "owners",
      "aa",
      "invalid-capability",
    );
    for (let depth = 0; depth < 64; depth += 1) hostile = join(hostile, `level-${depth}`);
    mkdirSync(hostile, { recursive: true });
    writeFileSync(join(hostile, "payload.bin"), Buffer.alloc(64 * 1024, 1));

    const cleanup = store.scavenge();
    await entered.promise;
    const overlapping = new GraphCapabilityStore({
      cacheRoot,
      repositoryMirrors: mirrorAuthority().authority,
    }).scavenge();
    await expect(overlapping).resolves.toMatchObject({ removed: 0 });
    resume.resolve();
    await expect(cleanup).resolves.toMatchObject({ removed: 0 });
  });

  it("refuses to delete a quarantine claim replaced after lifecycle admission", async () => {
    const entered = deferred<readonly string[]>();
    const resume = deferred<void>();
    const store = new GraphCapabilityStore({
      cacheRoot,
      repositoryMirrors: mirrorAuthority().authority,
      beforePhysicalCleanup: async (paths) => {
        entered.resolve(paths);
        await resume.promise;
      },
    });
    const invalid = join(
      cacheRoot,
      "graph-capabilities",
      "v1",
      "owners",
      "aa",
      "invalid-capability",
      "payload",
    );
    mkdirSync(invalid, { recursive: true });
    writeFileSync(join(invalid, "original.bin"), "original");

    const cleanup = store.scavenge();
    const [claim] = await entered.promise;
    if (!claim) throw new Error("scavenger did not publish its quarantine claim");
    const displaced = `${claim}-displaced`;
    renameSync(claim, displaced);
    mkdirSync(claim, { recursive: true });
    const replacement = join(claim, "replacement.bin");
    writeFileSync(replacement, "replacement");
    resume.resolve();

    const failure = await cleanup.catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors.map(String).join("\n")).toMatch(/claim was replaced/);
    expect(readFileSync(replacement, "utf8")).toBe("replacement");
    expect(readFileSync(join(displaced, "original.bin"), "utf8")).toBe("original");
  });

  it("releases a quarantined capability mirror owner outside lifecycle admission", async () => {
    const lease = sourceLease("d");
    const fixture = await capabilityFixture("release-outside-admission", HEAD_SHA, {
      sourceLease: lease,
    });
    const mirrors = mirrorAuthority();
    const releaseStarted = deferred<void>();
    const resumeRelease = deferred<void>();
    let now = 1_000;
    const repositoryMirrors: GraphCapabilityStoreOptions["repositoryMirrors"] = {
      retainSource: mirrors.authority.retainSource.bind(mirrors.authority),
      async releaseSource(reference, owner) {
        if (owner === "capability:release-outside-admission") {
          releaseStarted.resolve();
          await resumeRelease.promise;
        }
        await mirrors.authority.releaseSource(reference, owner);
      },
    };
    const store = new GraphCapabilityStore({
      cacheRoot,
      repositoryMirrors,
      maxIdleMs: 100,
      now: () => now,
    });
    await publishManaged(store, "release-outside-admission", fixture, lease);
    now = 1_101;

    const cleanup = store.scavenge();
    await releaseStarted.promise;
    const overlapping = new GraphCapabilityStore({ cacheRoot, repositoryMirrors }).scavenge();
    await expect(overlapping).resolves.toMatchObject({ removed: 0 });
    resumeRelease.resolve();
    await expect(cleanup).resolves.toMatchObject({ removed: 1 });
    expect(mirrors.released).toContainEqual({
      reference: lease,
      owner: "capability:release-outside-admission",
    });
  });

  it("reclaims identity-bound quarantine residue after a restart", async () => {
    const lease = sourceLease("e");
    const fixture = await capabilityFixture("quarantine-residue", HEAD_SHA, { sourceLease: lease });
    const mirrors = mirrorAuthority();
    const original = new GraphCapabilityStore({
      cacheRoot,
      repositoryMirrors: mirrors.authority,
    });
    await publishManaged(original, "quarantine-residue", fixture, lease);
    const descriptorResidue = descriptorDirectory("quarantine-residue");
    chmodSync(descriptorResidue, 0o700);
    renameSync(descriptorResidue, join(
      cacheRoot,
      "graph-capabilities",
      "v1",
      "quarantine",
      "descriptor-crashed-after-rename",
    ));
    const quarantine = join(
      cacheRoot,
      "graph-capabilities",
      "v1",
      "quarantine",
      "crashed-after-rename",
    );
    mkdirSync(join(quarantine, "nested", "tree"), { recursive: true });
    writeFileSync(join(quarantine, "nested", "tree", "payload.bin"), Buffer.alloc(32 * 1024, 1));
    const store = new GraphCapabilityStore({
      cacheRoot,
      repositoryMirrors: mirrors.authority,
    });

    await store.reconcile();

    expect(readdirSync(join(cacheRoot, "graph-capabilities", "v1", "quarantine"))).toEqual([]);
    expect(mirrors.released).toContainEqual({
      reference: lease,
      owner: "capability:quarantine-residue",
    });
  });

  it("publishes idempotently and never lets an id change its immutable target", async () => {
    const first = await capabilityFixture("first", HEAD_SHA);
    const second = await capabilityFixture("second", BASE_SHA);
    const store = new GraphCapabilityStore({
      cacheRoot,
      repositoryMirrors: mirrorAuthority().authority,
    });
    const input = {
      id: "stable-id",
      generation: first.generation,
      sourceRoot: first.sourceRoot,
      source: { kind: "other" } as const,
      publishedAt: "2026-07-17T10:00:00.000Z",
    };

    const published = await store.publish(input);
    await expect(store.publish({ ...input, publishedAt: "2026-07-17T11:00:00.000Z" }))
      .resolves.toEqual(published);
    await expect(store.publish({
      ...input,
      generation: second.generation,
      sourceRoot: second.sourceRoot,
    })).rejects.toThrow(/already bound/);

    const handle = await store.acquire("stable-id");
    try {
      expect(handle?.artifactPath).toBe(realpathSync(first.artifactPath));
      expect(handle?.descriptor.artifact.revision).toEqual({ kind: "git", commit: HEAD_SHA });
    } finally {
      await handle?.release();
    }
  });

  it("reuses an exact managed-cache graph across physical generations only by semantic idempotence", async () => {
    const firstLease = sourceLease("5");
    const secondLease = sourceLease("6");
    const first = await capabilityFixture("semantic-first", HEAD_SHA, {
      sourceLease: firstLease,
      artifactName: "semantic-graph",
    });
    const second = await capabilityFixture("semantic-second", HEAD_SHA, {
      sourceLease: secondLease,
      artifactName: "semantic-graph",
    });
    const differentLease = sourceLease("4");
    const different = await capabilityFixture("semantic-different", BASE_SHA, {
      sourceLease: differentLease,
      artifactName: "semantic-graph",
    });
    expect(second.generation.artifactSha256).toBe(first.generation.artifactSha256);
    expect(second.generation.projectionSha256).toBe(first.generation.projectionSha256);
    expect(second.generation.sealSha256).not.toBe(first.generation.sealSha256);

    const store = new GraphCapabilityStore({
      cacheRoot,
      repositoryMirrors: mirrorAuthority().authority,
    });
    const source = { kind: "github", owner: "org", repo: "repo", subdir: "apps/api" } as const;
    const published = await store.publish({
      id: "semantic-id",
      generation: first.generation,
      sourceRoot: first.sourceRoot,
      sourceSubdir: "apps/api",
      source,
      sourceLease: firstLease,
    });
    const refreshed = {
      id: "semantic-id",
      generation: second.generation,
      sourceRoot: second.sourceRoot,
      sourceSubdir: "apps/api",
      source,
      sourceLease: secondLease,
    } as const;

    await expect(store.publish(refreshed)).rejects.toThrow(/already bound/);
    await expect(store.publish(refreshed, { idempotence: "managed-cache-semantic" }))
      .resolves.toEqual(published);
    await expect(store.publish({
      ...refreshed,
      source: { ...source, repo: "another-repo" },
    }, { idempotence: "managed-cache-semantic" })).rejects.toThrow(/already bound/);
    await expect(store.publish({
      ...refreshed,
      sourceSubdir: undefined,
    }, { idempotence: "managed-cache-semantic" })).rejects.toThrow(/already bound/);
    await expect(store.publish({
      ...refreshed,
      generation: different.generation,
      sourceRoot: different.sourceRoot,
      sourceLease: differentLease,
    }, { idempotence: "managed-cache-semantic" })).rejects.toThrow(/already bound/);

    const handle = await store.acquire("semantic-id");
    try {
      expect(handle?.artifactPath).toBe(realpathSync(first.artifactPath));
      expect(handle?.source.owner).toEqual(firstLease);
    } finally {
      await handle?.release();
    }
  });

  it("requires exact synthetic execution authority for managed-cache semantic reuse", async () => {
    const firstLease = sourceLease("7");
    const secondLease = sourceLease("8");
    const first = await capabilityFixture("synthetic-semantic-first", HEAD_SHA, {
      sourceLease: firstLease,
      synthetic: true,
      artifactName: "synthetic-semantic-graph",
    });
    const second = await capabilityFixture("synthetic-semantic-second", HEAD_SHA, {
      sourceLease: secondLease,
      synthetic: true,
      artifactName: "synthetic-semantic-graph",
    });
    const store = new GraphCapabilityStore({
      cacheRoot,
      repositoryMirrors: mirrorAuthority().authority,
    });
    const trust = {
      mode: "sandboxed-pr",
      provenance: { repository: "org/repo", headSha: HEAD_SHA },
    } as const;
    const source = { kind: "github", owner: "org", repo: "repo", subdir: "apps/api" } as const;
    const published = await store.publish({
      id: "synthetic-semantic-id",
      generation: first.generation,
      sourceRoot: first.sourceRoot,
      sourceSubdir: "apps/api",
      source,
      sourceLease: firstLease,
      syntheticExecutionTrust: trust,
    });
    const refreshed = {
      id: "synthetic-semantic-id",
      generation: second.generation,
      sourceRoot: second.sourceRoot,
      sourceSubdir: "apps/api",
      source,
      sourceLease: secondLease,
    } as const;

    await expect(store.publish({
      ...refreshed,
      syntheticExecutionTrust: trust,
    }, { idempotence: "managed-cache-semantic" })).resolves.toEqual(published);
    await expect(store.publish(refreshed, { idempotence: "managed-cache-semantic" }))
      .rejects.toThrow(/already bound/);
  });

  it("rejects unsafe ids, outside paths, source traversal, and injected root symlinks", async () => {
    const fixture = await capabilityFixture("safe", HEAD_SHA);
    const store = new GraphCapabilityStore({
      cacheRoot,
      repositoryMirrors: mirrorAuthority().authority,
    });

    for (const id of ["", ".", "../escape", "a/b", "a\\b", "%2e%2e"]) {
      expect(isGraphCapabilityId(id)).toBe(false);
      await expect(store.publish({
        id,
        generation: fixture.generation,
        sourceRoot: fixture.sourceRoot,
        source: { kind: "other" },
      })).rejects.toThrow(/capability id/);
      await expect(store.acquire(id)).resolves.toBeNull();
    }
    expect(isGraphCapabilityId("pr-0123.dead_beef")).toBe(true);

    await expect(store.publish({
      id: "outside-source",
      generation: fixture.generation,
      sourceRoot: outsideRoot,
      source: { kind: "other" },
    })).rejects.toThrow(/inside the cache root/);
    await expect(store.publish({
      id: "source-traversal",
      generation: fixture.generation,
      sourceRoot: fixture.sourceRoot,
      sourceSubdir: "../stolen",
      source: { kind: "other" },
    })).rejects.toThrow(/subdirectory is unsafe/);

    if (process.platform !== "win32") {
      const separateCache = mkdtempSync(join(tmpdir(), "meridian-graph-capability-symlink-"));
      try {
        symlinkSync(outsideRoot, join(separateCache, "graph-capabilities"), "dir");
        expect(() => new GraphCapabilityStore({
          cacheRoot: separateCache,
          repositoryMirrors: mirrorAuthority().authority,
        })).toThrow(/not a private directory/);
      } finally {
        rmSync(separateCache, { recursive: true, force: true });
      }
    }
  });

  it("binds only an exact current mirror source root to its exact lease", async () => {
    const lease = sourceLease("4");
    const fixture = await capabilityFixture("source-binding", HEAD_SHA, { sourceLease: lease });
    const store = new GraphCapabilityStore({
      cacheRoot,
      repositoryMirrors: mirrorAuthority().authority,
    });
    const input = {
      generation: fixture.generation,
      sourceRoot: fixture.sourceRoot,
      source: { kind: "github", owner: "org", repo: "repo" } as const,
      sourceLease: lease,
    };

    await expect(store.publish({ id: "source-binding-exact", ...input })).resolves.toMatchObject({
      source: {
        kind: "managed-cache",
        rootPath: `repository-mirrors/v2/${lease.repositoryDigest}/worktrees/${lease.leaseId}`,
        owner: lease,
      },
    });
    await expect(store.publish({
      id: "source-binding-wrong-digest",
      ...input,
      sourceLease: { ...lease, repositoryDigest: "b".repeat(64) },
    })).rejects.toThrow(/requires its exact source lease/);
    await expect(store.publish({
      id: "source-binding-wrong-lease",
      ...input,
      sourceLease: { ...lease, leaseId: "5".repeat(64) },
    })).rejects.toThrow(/requires its exact source lease/);
    await expect(store.publish({
      id: "source-binding-missing-lease",
      ...input,
      sourceLease: undefined,
    })).rejects.toThrow(/requires its exact source lease/);
    await expect(store.publish({
      id: "source-binding-wrong-root",
      ...input,
      sourceRoot: join(fixture.sourceRoot, "apps"),
    })).rejects.toThrow(/does not match its source root/);

    const legacyRoot = join(
      cacheRoot,
      "repository-mirrors",
      "v1",
      lease.repositoryDigest,
      "worktrees",
      lease.leaseId,
    );
    mkdirSync(legacyRoot, { recursive: true });
    await expect(store.publish({
      id: "source-binding-legacy-root",
      ...input,
      sourceRoot: legacyRoot,
    })).rejects.toThrow(/does not match its source root/);

    if (process.platform !== "win32") {
      const replacementLease = sourceLease("6");
      const replacement = await capabilityFixture("source-binding-replacement", BASE_SHA, {
        sourceLease: replacementLease,
      });
      const displaced = `${fixture.sourceRoot}.displaced`;
      renameSync(fixture.sourceRoot, displaced);
      symlinkSync(replacement.sourceRoot, fixture.sourceRoot, "dir");
      await expect(store.publish({
        id: "source-binding-symlink",
        ...input,
      })).rejects.toThrow(/requires its exact source lease/);
    }
  });

  it("pins a managed source for publication and for the full acquired-handle lifetime", async () => {
    const lease = sourceLease("1");
    const fixture = await capabilityFixture("managed", HEAD_SHA, { sourceLease: lease });
    const mirrors = mirrorAuthority();
    const store = new GraphCapabilityStore({ cacheRoot, repositoryMirrors: mirrors.authority });

    await store.publish({
      id: "managed-head",
      generation: fixture.generation,
      sourceRoot: fixture.sourceRoot,
      sourceSubdir: "apps/api",
      source: { kind: "github", owner: "org", repo: "repo", subdir: "apps/api" },
      sourceLease: lease,
    });
    expect(mirrors.retained).toContainEqual(expect.objectContaining({
      reference: lease,
      rootDir: realpathSync(fixture.sourceRoot),
      owner: "capability:managed-head",
    }));

    const handle = await store.acquire("managed-head");
    expect(handle?.source.owner).toEqual(lease);
    const reader = mirrors.retained.find((call) => call.owner.startsWith("reader:managed-head:"));
    expect(reader).toMatchObject({ reference: lease, rootDir: realpathSync(fixture.sourceRoot) });
    try {
      expect(handle?.artifactPath).toBe(realpathSync(fixture.artifactPath));
    } finally {
      await handle?.release();
    }
    expect(mirrors.released).toContainEqual({ reference: lease, owner: reader?.owner });
  });

  it("keeps a releasing reader record until mirror source release succeeds", async () => {
    const lease = sourceLease("9");
    const fixture = await capabilityFixture("reader-release-retry", HEAD_SHA, { sourceLease: lease });
    const mirrors = mirrorAuthority();
    const store = new GraphCapabilityStore({ cacheRoot, repositoryMirrors: mirrors.authority });
    await publishManaged(store, "reader-release-retry", fixture, lease);
    const handle = await store.acquire("reader-release-retry");
    const readerOwner = mirrors.retained.find((call) => call.owner.startsWith("reader:"))?.owner;
    expect(readerOwner).toBeTypeOf("string");
    mirrors.failReleaseForOwner = readerOwner;

    await expect(handle?.release()).rejects.toThrow("reader source release failed");
    const readersRoot = join(cacheRoot, "graph-capabilities", "v1", "readers");
    const readerFiles = readdirSync(readersRoot);
    expect(readerFiles).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(readersRoot, readerFiles[0]!), "utf8"))).toMatchObject({
      capabilityId: "reader-release-retry",
      state: "releasing",
    });

    mirrors.failReleaseForOwner = undefined;
    await new GraphCapabilityStore({ cacheRoot, repositoryMirrors: mirrors.authority }).reconcile();
    expect(readdirSync(readersRoot)).toEqual([]);
    expect(mirrors.released).toContainEqual({ reference: lease, owner: readerOwner });
  });

  it("preflights exact HEAD and merge-base revisions before retaining either side", async () => {
    const headLease = sourceLease("1");
    const baseLease = sourceLease("2");
    const head = await capabilityFixture("retained-head", HEAD_SHA, { sourceLease: headLease });
    const base = await capabilityFixture("retained-base", BASE_SHA, { sourceLease: baseLease });
    const mirrors = mirrorAuthority();
    const store = new GraphCapabilityStore({ cacheRoot, repositoryMirrors: mirrors.authority });
    await publishManaged(store, "pr-head", head, headLease);
    await publishManaged(store, "pr-base", base, baseLease);
    mirrors.retained.length = 0;
    mirrors.released.length = 0;

    const owner = preparedOwner("f");
    const deadline = Date.now() + 60_000;
    await expect(store.retainMany([
      { id: "pr-head", expectedVcsCommit: HEAD_SHA },
      { id: "pr-base", expectedVcsCommit: HEAD_SHA },
    ], owner, deadline)).rejects.toThrow(/required revision/);
    expect(mirrors.retained).toEqual([]);

    await store.retainMany([
      { id: "pr-head", expectedVcsCommit: HEAD_SHA },
      { id: "pr-base", expectedVcsCommit: BASE_SHA },
    ], owner, deadline);
    expect(mirrors.retained).toEqual(expect.arrayContaining([
      expect.objectContaining({ reference: headLease, owner: externalMirrorOwner("pr-head", owner) }),
      expect.objectContaining({ reference: baseLease, owner: externalMirrorOwner("pr-base", owner) }),
    ]));

    mirrors.retained.length = 0;
    const restarted = new GraphCapabilityStore({ cacheRoot, repositoryMirrors: mirrors.authority });
    await restarted.reconcile();
    expect(mirrors.retained.filter((call) => call.owner.startsWith("capability-owner:"))).toEqual([]);
    await restarted.reconcileOwners("prepared-review-handoff", [{
      owner,
      bindings: [
        { id: "pr-head", expectedVcsCommit: HEAD_SHA },
        { id: "pr-base", expectedVcsCommit: BASE_SHA },
      ],
      retainedUntilMs: deadline,
    }]);
    expect(mirrors.retained).toEqual(expect.arrayContaining([
      expect.objectContaining({ reference: headLease, owner: externalMirrorOwner("pr-head", owner) }),
      expect.objectContaining({ reference: baseLease, owner: externalMirrorOwner("pr-base", owner) }),
    ]));

    await restarted.releaseOwner(owner);
    expect(mirrors.released).toEqual(expect.arrayContaining([
      { reference: headLease, owner: externalMirrorOwner("pr-head", owner) },
      { reference: baseLease, owner: externalMirrorOwner("pr-base", owner) },
    ]));
  });

  it("rolls back the first exact graph owner when the second source retention fails", async () => {
    const baseLease = sourceLease("1");
    const headLease = sourceLease("2");
    const base = await capabilityFixture("rollback-base", BASE_SHA, { sourceLease: baseLease });
    const head = await capabilityFixture("rollback-head", HEAD_SHA, { sourceLease: headLease });
    const mirrors = mirrorAuthority();
    const store = new GraphCapabilityStore({ cacheRoot, repositoryMirrors: mirrors.authority });
    await publishManaged(store, "a-base", base, baseLease);
    await publishManaged(store, "z-head", head, headLease);
    mirrors.retained.length = 0;
    mirrors.released.length = 0;
    const failure = new Error("HEAD source disappeared");
    mirrors.failRetainForLeaseId = headLease.leaseId;
    const owner = preparedOwner("e");

    await expect(store.retainMany([
      { id: "z-head", expectedVcsCommit: HEAD_SHA },
      { id: "a-base", expectedVcsCommit: BASE_SHA },
    ], owner, Date.now() + 60_000)).rejects.toThrow(failure.message);

    expect(mirrors.released).toContainEqual({
      reference: baseLease,
      owner: externalMirrorOwner("a-base", owner),
    });
  });

  it("authoritatively repairs a missing side and releases extra retaining or partial owners", async () => {
    const headLease = sourceLease("5");
    const baseLease = sourceLease("6");
    const extraLease = sourceLease("7");
    const head = await capabilityFixture("owner-head", HEAD_SHA, { sourceLease: headLease });
    const base = await capabilityFixture("owner-base", BASE_SHA, { sourceLease: baseLease });
    const extra = await capabilityFixture("owner-extra", HEAD_SHA, { sourceLease: extraLease });
    const mirrors = mirrorAuthority();
    const store = new GraphCapabilityStore({ cacheRoot, repositoryMirrors: mirrors.authority });
    await publishManaged(store, "owner-head", head, headLease);
    await publishManaged(store, "owner-base", base, baseLease);
    await publishManaged(store, "owner-extra", extra, extraLease);
    const owner = preparedOwner("a");
    const retainedUntilMs = Date.now() + 60_000;
    await store.retainMany([
      { id: "owner-head", expectedVcsCommit: HEAD_SHA },
      { id: "owner-base", expectedVcsCommit: BASE_SHA },
      { id: "owner-extra", expectedVcsCommit: HEAD_SHA },
    ], owner, retainedUntilMs);

    setOwnerRecordState("owner-head", owner, "releasing");
    rmSync(ownerRecordPath("owner-base", owner));
    setOwnerRecordState("owner-extra", owner, "retaining");
    mirrors.retained.length = 0;
    mirrors.released.length = 0;
    const restarted = new GraphCapabilityStore({ cacheRoot, repositoryMirrors: mirrors.authority });
    await restarted.reconcile();
    expect(mirrors.retained.filter((call) => call.owner.startsWith("capability-owner:"))).toEqual([]);

    await expect(restarted.reconcileOwners("prepared-review-handoff", [{
      owner,
      bindings: [
        { id: "owner-head", expectedVcsCommit: HEAD_SHA },
        { id: "owner-base", expectedVcsCommit: BASE_SHA },
      ],
      retainedUntilMs,
    }])).resolves.toMatchObject({ retainedOwners: [owner], failures: [] });

    expect(readOwnerRecord("owner-head", owner)).toMatchObject({ state: "active", owner });
    expect(readOwnerRecord("owner-base", owner)).toMatchObject({ state: "active", owner });
    expect(() => readFileSync(ownerRecordPath("owner-extra", owner))).toThrow();
    expect(mirrors.retained).toEqual(expect.arrayContaining([
      expect.objectContaining({ reference: headLease, owner: externalMirrorOwner("owner-head", owner) }),
      expect.objectContaining({ reference: baseLease, owner: externalMirrorOwner("owner-base", owner) }),
    ]));
    expect(mirrors.released).toContainEqual({
      reference: extraLease,
      owner: externalMirrorOwner("owner-extra", owner),
    });
  });

  it("defers prepared-review owner repair until scoped reconciliation can release a broken pair", async () => {
    const headLease = sourceLease("8");
    const baseLease = sourceLease("9");
    const head = await capabilityFixture("missing-source-head", HEAD_SHA, { sourceLease: headLease });
    const base = await capabilityFixture("missing-source-base", BASE_SHA, { sourceLease: baseLease });
    const mirrors = mirrorAuthority();
    const store = new GraphCapabilityStore({ cacheRoot, repositoryMirrors: mirrors.authority });
    await publishManaged(store, "missing-source-head", head, headLease);
    await publishManaged(store, "missing-source-base", base, baseLease);
    const owner = preparedOwner("c");
    const retainedUntilMs = Date.now() + 60_000;
    const bindings = [
      { id: "missing-source-head", expectedVcsCommit: HEAD_SHA },
      { id: "missing-source-base", expectedVcsCommit: BASE_SHA },
    ] as const;
    await store.retainMany(bindings, owner, retainedUntilMs);
    removeEntry(base.sourceRoot);
    mirrors.retained.length = 0;
    mirrors.released.length = 0;

    const restarted = new GraphCapabilityStore({ cacheRoot, repositoryMirrors: mirrors.authority });
    await expect(restarted.reconcile()).resolves.toBeUndefined();
    expect(mirrors.retained.filter((call) => call.owner.startsWith("capability-owner:"))).toEqual([]);

    const reconciled = await restarted.reconcileOwners("prepared-review-handoff", [{
      owner,
      bindings,
      retainedUntilMs,
    }]);
    expect(reconciled.retainedOwners).toEqual([]);
    expect(reconciled.failures).toHaveLength(1);
    expect(reconciled.failures[0]?.owner).toEqual(owner);
    expect(mirrors.released).toEqual(expect.arrayContaining([
      { reference: headLease, owner: externalMirrorOwner("missing-source-head", owner) },
      { reference: baseLease, owner: externalMirrorOwner("missing-source-base", owner) },
    ]));
    expect(() => readFileSync(ownerRecordPath("missing-source-head", owner))).toThrow();
    expect(() => readFileSync(ownerRecordPath("missing-source-base", owner))).toThrow();
  });

  it("rejects noncanonical handoff bytes and releases both graph and mirror owners", async () => {
    const headLease = sourceLease("b");
    const baseLease = sourceLease("d");
    const head = await capabilityFixture("handoff-head", HEAD_SHA, { sourceLease: headLease });
    const base = await capabilityFixture("handoff-base", BASE_SHA, { sourceLease: baseLease });
    const mirrors = mirrorAuthority();
    const capabilities = new GraphCapabilityStore({ cacheRoot, repositoryMirrors: mirrors.authority });
    const headDescriptor = await publishManagedDescriptor(
      capabilities,
      "handoff-head",
      head,
      headLease,
    );
    const baseDescriptor = await publishManagedDescriptor(
      capabilities,
      "handoff-base",
      base,
      baseLease,
    );
    const handoffs = new PreparedReviewHandoffStore({ cacheRoot, graphCapabilities: capabilities });
    const candidate = handoffs.prepare({
      request: {
        owner: "org",
        repo: "repo",
        prNumber: 41,
        baseRef: "main",
        headRef: "feature/review",
      },
      headSha: HEAD_SHA,
      baseSha: BASE_SHA,
      mergeBaseSha: BASE_SHA,
      changedFiles: [
        { path: "src/deleted.ts", status: "deleted" },
        { path: "src/new.ts", previousPath: "src/old.ts", status: "renamed" },
      ],
      head: preparedGraphDescriptor(headDescriptor),
      mergeBase: preparedGraphDescriptor(baseDescriptor),
      cache: "miss",
      timings: { resolve: 1, git: 2, "extract-head": 3, "extract-merge-base": 4, publish: 5 },
      warnings: [],
    });
    await handoffs.publish(candidate, { deliver: () => undefined });
    const directory = preparedReviewDirectory(candidate.id);
    const handoffPath = join(directory, "handoff.json");
    const integrityPath = join(directory, "sha256");
    const noncanonical = `${JSON.stringify(candidate.document, null, 2)}\n`;
    const rewrittenIntegrity = createHash("sha256").update(noncanonical).digest("hex");
    chmodSync(directory, 0o700);
    chmodSync(handoffPath, 0o600);
    chmodSync(integrityPath, 0o600);
    writeFileSync(handoffPath, noncanonical);
    writeFileSync(integrityPath, `${rewrittenIntegrity}\n`);
    chmodSync(handoffPath, 0o400);
    chmodSync(integrityPath, 0o400);
    chmodSync(directory, 0o500);
    mirrors.released.length = 0;

    await expect(handoffs.resolve(candidate.id)).resolves.toBeNull();
    await expect(handoffs.reconcile()).resolves.toMatchObject({ entries: 0, removed: 1 });

    const owner = { scope: "prepared-review-handoff", id: candidate.id } as const;
    expect(mirrors.released).toEqual(expect.arrayContaining([
      { reference: headLease, owner: externalMirrorOwner("handoff-head", owner) },
      { reference: baseLease, owner: externalMirrorOwner("handoff-base", owner) },
    ]));
    expect(() => readFileSync(handoffPath)).toThrow();
  });

  it("protects active readers and external owners from TTL/LRU scavenging", async () => {
    let now = 10_000;
    const fixture = await capabilityFixture("bounded", HEAD_SHA);
    const store = new GraphCapabilityStore({
      cacheRoot,
      repositoryMirrors: mirrorAuthority().authority,
      maxIdleMs: 100,
      maxEntries: 1,
      maxDiskBytes: 64 * 1024,
      now: () => now,
    });
    await store.publish({
      id: "bounded",
      generation: fixture.generation,
      sourceRoot: fixture.sourceRoot,
      source: { kind: "other" },
    });

    const handle = await store.acquire("bounded");
    now += 1_000;
    await expect(store.scavenge()).resolves.toMatchObject({ entries: 1, protectedEntries: 1 });
    await handle?.release();
    await expect(store.scavenge()).resolves.toMatchObject({ entries: 0, removed: 1 });
    await expect(store.acquire("bounded")).resolves.toBeNull();

    const retained = await capabilityFixture("externally-retained", BASE_SHA);
    await store.publish({
      id: "externally-retained",
      generation: retained.generation,
      sourceRoot: retained.sourceRoot,
      source: { kind: "other" },
    });
    const owner = preparedOwner("b");
    await store.retainMany([
      { id: "externally-retained", expectedVcsCommit: BASE_SHA },
    ], owner, now + 10_000);
    now += 1_000;
    await expect(store.scavenge()).resolves.toMatchObject({ entries: 1, protectedEntries: 1 });
    await store.releaseOwner(owner);
    await expect(store.scavenge()).resolves.toMatchObject({ entries: 0, removed: 1 });
  });

  it("expires an orphan reader strictly by TTL even when its recorded PID is live or reused", async () => {
    let now = 20_000;
    const lease = sourceLease("3");
    const fixture = await capabilityFixture("orphan-reader", HEAD_SHA, { sourceLease: lease });
    const mirrors = mirrorAuthority();
    const store = new GraphCapabilityStore({
      cacheRoot,
      repositoryMirrors: mirrors.authority,
      maxIdleMs: 100,
      now: () => now,
    });
    const descriptor = await store.publish({
      id: "orphan-reader",
      generation: fixture.generation,
      sourceRoot: fixture.sourceRoot,
      source: { kind: "github", owner: "org", repo: "repo" },
      sourceLease: lease,
    });
    mirrors.released.length = 0;
    now += 1_000;
    const token = "00000000-0000-4000-8000-000000000003";
    const readers = join(cacheRoot, "graph-capabilities", "v1", "readers");
    mkdirSync(readers, { recursive: true });
    writeFileSync(join(readers, `${token}.json`), `${JSON.stringify({
      formatVersion: 3,
      token,
      pid: process.pid,
      capabilityId: descriptor.id,
      state: "active",
      generationPaths: [descriptor.artifact.generationPath],
      sourceLease: lease,
      sourceRootPath: descriptor.source.kind === "managed-cache" ? descriptor.source.rootPath : null,
      expiresAtMs: now - 1,
    })}\n`);

    await expect(store.scavenge()).resolves.toMatchObject({ entries: 0, removed: 1 });
    expect(mirrors.released).toContainEqual({
      reference: lease,
      owner: `reader:orphan-reader:${token}`,
    });
  });

  it("rejects a digest-tampered rebind and rechecks descriptor disk state on every acquire", async () => {
    const original = await capabilityFixture("descriptor-original", HEAD_SHA);
    const rebound = await capabilityFixture("descriptor-rebound", BASE_SHA);
    const removed = await capabilityFixture("descriptor-removed", HEAD_SHA);
    const store = new GraphCapabilityStore({
      cacheRoot,
      repositoryMirrors: mirrorAuthority().authority,
    });
    await store.publish({
      id: "tampered",
      generation: original.generation,
      sourceRoot: original.sourceRoot,
      source: { kind: "other" },
    });
    const reboundDescriptor = await store.publish({
      id: "rebound-target",
      generation: rebound.generation,
      sourceRoot: rebound.sourceRoot,
      source: { kind: "other" },
    });
    await store.publish({
      id: "removed",
      generation: removed.generation,
      sourceRoot: removed.sourceRoot,
      source: { kind: "other" },
    });

    await acquireAndRelease(store, "tampered");
    await acquireAndRelease(store, "removed");
    const tamperedPath = descriptorPath("tampered");
    const stored = JSON.parse(readFileSync(tamperedPath, "utf8")) as Record<string, unknown>;
    makeDescriptorWritable("tampered");
    writeFileSync(tamperedPath, `${JSON.stringify({
      ...stored,
      artifact: reboundDescriptor.artifact,
    }, null, 2)}\n`);
    removeEntry(descriptorDirectory("removed"));

    await expect(store.acquire("tampered")).resolves.toBeNull();
    await expect(store.acquire("tampered")).resolves.toBeNull();
    await expect(store.acquire("removed")).resolves.toBeNull();
  });

  it("keeps an acquired reader pinned when a later verifier quarantines its descriptor", async () => {
    const lease = sourceLease("4");
    const fixture = await capabilityFixture("reader-revocation", HEAD_SHA, { sourceLease: lease });
    const mirrors = mirrorAuthority();
    const store = new GraphCapabilityStore({ cacheRoot, repositoryMirrors: mirrors.authority });
    await publishManaged(store, "reader-revocation", fixture, lease);
    const active = await store.acquire("reader-revocation");
    expect(active).not.toBeNull();
    const activeReader = mirrors.retained.find(
      (call) => call.owner.startsWith("reader:reader-revocation:"),
    );
    expect(activeReader).toBeDefined();
    mirrors.released.length = 0;

    mutateSameSize(fixture.artifactPath);
    await expect(store.acquire("reader-revocation")).resolves.toBeNull();
    expect(mirrors.released).not.toContainEqual({
      reference: lease,
      owner: activeReader?.owner,
    });
    expect(realpathSync(active?.source.rootDir as string)).toBe(realpathSync(fixture.sourceRoot));
    expect(readFileSync(active?.artifactPath as string).byteLength).toBeGreaterThan(0);

    await active?.release();
    expect(mirrors.released).toContainEqual({
      reference: lease,
      owner: activeReader?.owner,
    });
  });

  it("reports verification, reader release, and quarantine cleanup failures together", async () => {
    const lease = sourceLease("a");
    const fixture = await capabilityFixture("verification-cleanup", HEAD_SHA, { sourceLease: lease });
    const mirrors = mirrorAuthority();
    const store = new GraphCapabilityStore({ cacheRoot, repositoryMirrors: mirrors.authority });
    await publishManaged(store, "verification-cleanup", fixture, lease);
    mutateSameSize(fixture.artifactPath);
    const readerFailure = new Error("reader cleanup failed");
    const quarantineFailure = new Error("intrinsic cleanup failed");
    mirrors.releaseFailure = (owner) => {
      if (owner.startsWith("reader:verification-cleanup:")) return readerFailure;
      if (owner === "capability:verification-cleanup") return quarantineFailure;
      return undefined;
    };

    const failure = await store.acquire("verification-cleanup").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual(expect.arrayContaining([
      readerFailure,
      quarantineFailure,
    ]));

    mirrors.releaseFailure = undefined;
    await new GraphCapabilityStore({ cacheRoot, repositoryMirrors: mirrors.authority }).reconcile();
    expect(readdirSync(join(cacheRoot, "graph-capabilities", "v1", "readers"))).toEqual([]);
    expect(readdirSync(join(cacheRoot, "graph-capabilities", "v1", "quarantine"))).toEqual([]);
  });

  it("preserves abort and reader cleanup failure when verification observes shutdown", async () => {
    const lease = sourceLease("b");
    const fixture = await capabilityFixture("verification-abort", HEAD_SHA, { sourceLease: lease });
    const mirrors = mirrorAuthority();
    const store = new GraphCapabilityStore({ cacheRoot, repositoryMirrors: mirrors.authority });
    await publishManaged(store, "verification-abort", fixture, lease);
    const controller = new AbortController();
    const reason = new DOMException("shutdown", "AbortError");
    const readerFailure = new Error("cancelled reader cleanup failed");
    mirrors.beforeRetain = (owner) => {
      if (owner === "capability:verification-abort") controller.abort(reason);
    };
    mirrors.releaseFailure = (owner) => (
      owner.startsWith("reader:verification-abort:") ? readerFailure : undefined
    );

    const failure = await store.acquire("verification-abort", { signal: controller.signal })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([reason, readerFailure]);
    expect(existsSync(descriptorDirectory("verification-abort"))).toBe(true);

    mirrors.beforeRetain = undefined;
    mirrors.releaseFailure = undefined;
    await new GraphCapabilityStore({ cacheRoot, repositoryMirrors: mirrors.authority }).reconcile();
    expect(readdirSync(join(cacheRoot, "graph-capabilities", "v1", "readers"))).toEqual([]);
  });

  it("preserves in-flight renewal and reader release failures on idempotent handle release", async () => {
    const lease = sourceLease("d");
    const fixture = await capabilityFixture("reader-release-race", HEAD_SHA, { sourceLease: lease });
    const mirrors = mirrorAuthority();
    const store = new GraphCapabilityStore({ cacheRoot, repositoryMirrors: mirrors.authority });
    await publishManaged(store, "reader-release-race", fixture, lease);
    const handle = await store.acquire("reader-release-race");
    expect(handle).not.toBeNull();
    const renewalEntered = deferred<void>();
    const finishRenewal = deferred<void>();
    const renewalFailure = new Error("reader renewal failed");
    const releaseFailure = new Error("reader release failed after renewal");
    mirrors.beforeRetain = async (owner) => {
      if (!owner.startsWith("reader:reader-release-race:")) return;
      renewalEntered.resolve();
      await finishRenewal.promise;
      throw renewalFailure;
    };
    mirrors.releaseFailure = (owner) => (
      owner.startsWith("reader:reader-release-race:") ? releaseFailure : undefined
    );

    const renewing = handle!.renew();
    await renewalEntered.promise;
    const releasing = handle!.release();
    finishRenewal.resolve();
    await expect(renewing).rejects.toBe(renewalFailure);
    const firstFailure = await releasing.catch((error: unknown) => error);
    expect(firstFailure).toBeInstanceOf(AggregateError);
    expect((firstFailure as AggregateError).errors).toEqual([renewalFailure, releaseFailure]);
    await expect(handle!.release()).rejects.toBe(firstFailure);

    mirrors.beforeRetain = undefined;
    mirrors.releaseFailure = undefined;
    await new GraphCapabilityStore({ cacheRoot, repositoryMirrors: mirrors.authority }).reconcile();
    expect(readdirSync(join(cacheRoot, "graph-capabilities", "v1", "readers"))).toEqual([]);
  });

  it("preserves digest-bound synthetic execution authority on the acquired handle", async () => {
    const fixture = await capabilityFixture("synthetic-head", HEAD_SHA, { synthetic: true });
    const store = new GraphCapabilityStore({
      cacheRoot,
      repositoryMirrors: mirrorAuthority().authority,
    });
    await store.publish({
      id: "synthetic-head",
      generation: fixture.generation,
      sourceRoot: fixture.sourceRoot,
      sourceSubdir: "apps/api",
      source: { kind: "github", owner: "org", repo: "repo", subdir: "apps/api" },
      syntheticExecutionTrust: {
        mode: "sandboxed-pr",
        provenance: { repository: "org/repo", headSha: HEAD_SHA },
      },
    });

    const handle = await store.acquire("synthetic-head");
    try {
      expect(handle?.synthetic).toMatchObject({
        capability: { state: "ready", artifactCommit: HEAD_SHA },
        executionTrust: { provenance: { repository: "org/repo", headSha: HEAD_SHA } },
      });
    } finally {
      await handle?.release();
    }
  });

  it("recovers an external local source after restart and refuses a symlink or inode rebind", async () => {
    const fixture = await capabilityFixture("local-content", HEAD_SHA, { contentRevision: true });
    const localRoot = join(outsideRoot, "project");
    const displacedRoot = join(outsideRoot, "project-displaced");
    mkdirSync(localRoot, { recursive: true });
    writeFileSync(join(localRoot, "index.ts"), "export const local = true;\n");
    const original = new GraphCapabilityStore({
      cacheRoot,
      repositoryMirrors: mirrorAuthority().authority,
    });
    const descriptor = await original.publish({
      id: "local-content",
      generation: fixture.generation,
      sourceRoot: localRoot,
      source: { kind: "path" },
    });
    expect(descriptor.source).toMatchObject({
      kind: "external-local",
      canonicalRoot: realpathSync(localRoot),
      metadata: { kind: "path" },
      owner: null,
    });

    const restarted = new GraphCapabilityStore({
      cacheRoot,
      repositoryMirrors: mirrorAuthority().authority,
    });
    const recovered = await restarted.acquire("local-content");
    expect(recovered?.source.sourceDir).toBe(realpathSync(localRoot));
    await recovered?.release();

    renameSync(localRoot, displacedRoot);
    if (process.platform !== "win32") {
      symlinkSync(displacedRoot, localRoot, "dir");
      await expect(restarted.acquire("local-content")).resolves.toBeNull();
      rmSync(localRoot, { force: true });
    }
    mkdirSync(localRoot, { recursive: true });
    await expect(restarted.acquire("local-content")).resolves.toBeNull();
    await expect(restarted.publish({
      id: "local-content",
      generation: fixture.generation,
      sourceRoot: localRoot,
      source: { kind: "path" },
    }, { idempotence: "managed-cache-semantic" })).rejects.toThrow(/already bound/);
  });
});

interface CapabilityFixture {
  readonly generation: VerifiedGraphGeneration;
  readonly sealedStage: SealedGraphGenerationStage;
  readonly generationDirectory: string;
  readonly artifactPath: string;
  readonly projectionDirectory: string;
  readonly sourceRoot: string;
  readonly reviewContext?: ReviewComparisonContextReference;
}

async function capabilityFixture(
  name: string,
  commit: string,
  options: {
    sourceLease?: RepositorySourceLeaseReference;
    synthetic?: boolean;
    contentRevision?: boolean;
    artifactName?: string;
    reviewContext?: {
      mergeBaseSha: string;
      mergeBaseContentId?: string;
      analysisKey: string;
      changedFiles: ChangedFileManifestEntry[];
    };
  } = {},
): Promise<CapabilityFixture> {
  const repositoryKey = createHash("sha256").update(`repository:${name}`).digest("hex").slice(0, 24);
  const analysisKey = createHash("sha256").update(`analysis:${name}`).digest("hex").slice(0, 24);
  const generationEntry = repositoryArtifactEntry(cacheRoot, repositoryKey, commit, analysisKey);
  const generationDirectory = finalizedGenerationDirectory(generationEntry, `generation-${name}`);
  mkdirSync(dirname(generationDirectory), { recursive: true, mode: 0o700 });
  const lifecycle = new GraphGenerationLifecycle({ cacheRoot });
  const stageHandle = await lifecycle.reserveStage();
  const stage = stageHandle.directory;
  const sourceRoot = options.sourceLease
    ? join(
      cacheRoot,
      "repository-mirrors",
      "v2",
      options.sourceLease.repositoryDigest,
      "worktrees",
      options.sourceLease.leaseId,
    )
    : join(cacheRoot, "sources", name);
  const sourceDir = join(sourceRoot, "apps", "api");
  mkdirSync(sourceDir, { recursive: true });
  writeFileSync(join(sourceDir, "index.ts"), "export const run = () => 'ready';\n");

  const artifact = artifactFor(options.artifactName ?? name, commit, options.synthetic === true);
  const serialized = `${JSON.stringify(artifact)}\n`;
  const artifactPath = join(stage, "artifact.json");
  const projectionDirectory = join(stage, GRAPH_PROJECTION_DIRECTORY);
  writeFileSync(artifactPath, serialized, { mode: 0o600 });
  if (options.synthetic) {
    writeFileSync(join(sourceDir, "meridian.synthetic.json"), JSON.stringify({
      manifestVersion: "1.0.0",
      scenarios: [{
        id: "run",
        label: "Run",
        rootId: "ts:index.ts#run",
        defaultInput: null,
        invoke: { module: "index.ts", export: "run" },
      }],
    }));
    writeSyntheticCapabilitySidecar(artifactPath, sourceDir, artifact);
  }
  const manifest = writeGraphProjectionBundle(projectionDirectory, artifact);
  const stagedReviewContext = options.reviewContext
    ? writeReviewComparisonContext(join(stage, REVIEW_COMPARISON_CONTEXT_FILE), {
        headSha: commit,
        headContentId: manifest.contentId,
        mergeBaseContentId: options.reviewContext.mergeBaseContentId ?? manifest.contentId,
        testClassifications: [],
        ...options.reviewContext,
      })
    : undefined;
  const projectionIntegrity = await measureGraphProjectionBundle(projectionDirectory, cacheRoot);
  const sealed = await sealGraphGeneration({
    cacheRoot,
    stage: stageHandle,
    artifactPath,
    projectionDirectory,
    artifactBytes: Buffer.byteLength(serialized),
    artifactSha256: createHash("sha256").update(serialized).digest("hex"),
    ...projectionIntegrity,
    projectionContentId: manifest.contentId,
    graphSummary: manifest.graphSummary,
    revision: options.contentRevision
      ? { kind: "content", contentId: manifest.contentId }
      : { kind: "git", commit },
  });
  const publicationLease = await lifecycle.acquire(generationDirectory, {
    purpose: "publication",
    allowMissing: true,
  });
  try {
    if (!await stageHandle.publish(publicationLease)) {
      throw new Error("test graph generation unexpectedly collided");
    }
    freezeGraphGenerationDirectory(cacheRoot, generationDirectory);
  } finally {
    await stageHandle.release();
  }
  const publishedArtifact = join(generationDirectory, "artifact.json");
  const publishedProjection = join(generationDirectory, GRAPH_PROJECTION_DIRECTORY);
  let generation: VerifiedGraphGeneration;
  try {
    generation = await verifyGraphGeneration({
      cacheRoot,
      artifactPath: publishedArtifact,
      projectionDirectory: publishedProjection,
      artifactBytes: sealed.artifactBytes,
      artifactSha256: sealed.artifactSha256,
      projectionBytes: sealed.projectionBytes,
      projectionSha256: sealed.projectionSha256,
      projectionContentId: sealed.projectionContentId,
      sealSha256: sealed.sealSha256,
      graphSummary: sealed.graphSummary,
      revision: sealed.revision,
    });
  } finally {
    await publicationLease.release();
  }
  return {
    generation,
    sealedStage: sealed,
    generationDirectory,
    artifactPath: publishedArtifact,
    projectionDirectory: publishedProjection,
    sourceRoot,
    ...(stagedReviewContext ? {
      reviewContext: {
        ...stagedReviewContext,
        path: join(generationDirectory, REVIEW_COMPARISON_CONTEXT_FILE),
      },
    } : {}),
  };
}

function artifactFor(name: string, commit: string, synthetic: boolean): GraphArtifact {
  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: "2026-07-17T00:00:00.000Z",
    generator: { name: "meridian", version: "test" },
    target: {
      name,
      root: ".",
      language: "typescript",
      vcs: { repository: "https://github.com/org/repo.git", commit },
    },
    nodes: synthetic ? [{
      id: "ts:index.ts#run",
      kind: "function",
      qualifiedName: "run",
      displayName: "run",
      parentId: null,
      location: { file: "index.ts", startLine: 1, endLine: 1 },
    }] : [],
    edges: [],
  };
}

function sourceLease(suffix: string): RepositorySourceLeaseReference {
  return { repositoryDigest: REPOSITORY_DIGEST, leaseId: suffix.repeat(64) };
}

function preparedOwner(suffix: string): GraphCapabilityExternalOwnerKey {
  return { scope: "prepared-review-handoff", id: `prh-v1-${suffix.repeat(64)}` };
}

function externalMirrorOwner(capabilityId: string, owner: GraphCapabilityExternalOwnerKey): string {
  return `capability-owner:${owner.scope}:${owner.id}:${capabilityId}`;
}

async function publishManaged(
  store: GraphCapabilityStore,
  id: string,
  fixture: CapabilityFixture,
  sourceLease: RepositorySourceLeaseReference,
): Promise<void> {
  await store.publish({
    id,
    generation: fixture.generation,
    sourceRoot: fixture.sourceRoot,
    source: { kind: "github", owner: "org", repo: "repo" },
    sourceLease,
  });
}

function managedInput(
  id: string,
  fixture: CapabilityFixture,
  lease: RepositorySourceLeaseReference,
) {
  return {
    id,
    generation: fixture.generation,
    sourceRoot: fixture.sourceRoot,
    source: { kind: "github" as const, owner: "org", repo: "repo" },
    sourceLease: lease,
  };
}

async function publishManagedDescriptor(
  store: GraphCapabilityStore,
  id: string,
  fixture: CapabilityFixture,
  sourceLease: RepositorySourceLeaseReference,
): Promise<GraphCapabilityDescriptor> {
  return store.publish({
    id,
    generation: fixture.generation,
    sourceRoot: fixture.sourceRoot,
    source: { kind: "github", owner: "org", repo: "repo" },
    sourceLease,
  });
}

function ownerRecordPath(capabilityId: string, owner: GraphCapabilityExternalOwnerKey): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([owner.scope, owner.id]))
    .digest("hex");
  return join(
    cacheRoot,
    "graph-capabilities",
    "v1",
    "owners",
    capabilityId.slice(0, 2).padEnd(2, "_"),
    capabilityId,
    `${digest}.json`,
  );
}

function readOwnerRecord(
  capabilityId: string,
  owner: GraphCapabilityExternalOwnerKey,
): Record<string, unknown> {
  return JSON.parse(readFileSync(ownerRecordPath(capabilityId, owner), "utf8")) as Record<string, unknown>;
}

function setOwnerRecordState(
  capabilityId: string,
  owner: GraphCapabilityExternalOwnerKey,
  state: "retaining" | "active" | "releasing",
): void {
  const path = ownerRecordPath(capabilityId, owner);
  const record = readOwnerRecord(capabilityId, owner);
  writeFileSync(path, `${JSON.stringify({ ...record, state })}\n`);
}

function preparedGraphDescriptor(descriptor: GraphCapabilityDescriptor) {
  const encoded = encodeURIComponent(descriptor.id);
  return {
    graphId: descriptor.id,
    manifestUrl: `/api/graph/manifest?id=${encoded}`,
    projectionUrl: `/api/graph/projection?id=${encoded}`,
    searchUrl: `/api/graph/search?id=${encoded}`,
    sourceUrl: `/api/source?id=${encoded}`,
    metaUrl: `/api/meta?id=${encoded}`,
    graphSummary: descriptor.graphSummary,
  };
}

function preparedReviewDirectory(id: string): string {
  const digest = id.slice("prh-v1-".length);
  return join(cacheRoot, "prepared-review-handoffs", "v1", digest.slice(0, 2), id);
}

interface RetainCall {
  readonly reference: RepositorySourceLeaseReference;
  readonly rootDir: string;
  readonly owner: string;
  readonly retainedUntilMs: number;
}

interface ReleaseCall {
  readonly reference: RepositorySourceLeaseReference;
  readonly owner: string;
}

function mirrorAuthority(): {
  readonly authority: GraphCapabilityStoreOptions["repositoryMirrors"];
  readonly retained: RetainCall[];
  readonly released: ReleaseCall[];
  failRetainForLeaseId?: string;
  failReleaseForOwner?: string;
  beforeRetain?: (owner: string) => void | Promise<void>;
  releaseFailure?: (owner: string) => Error | undefined;
} {
  const state: {
    authority: GraphCapabilityStoreOptions["repositoryMirrors"];
    retained: RetainCall[];
    released: ReleaseCall[];
    failRetainForLeaseId?: string;
    failReleaseForOwner?: string;
    beforeRetain?: (owner: string) => void | Promise<void>;
    releaseFailure?: (owner: string) => Error | undefined;
  } = {
    retained: [],
    released: [],
    authority: undefined as never,
  };
  state.authority = {
    async retainSource(reference, rootDir, owner, retainedUntilMs) {
      await state.beforeRetain?.(owner);
      if (state.failRetainForLeaseId === reference.leaseId) {
        throw new Error("HEAD source disappeared");
      }
      state.retained.push({ reference: { ...reference }, rootDir, owner, retainedUntilMs });
      return true;
    },
    async releaseSource(reference, owner) {
      if (state.failReleaseForOwner === owner) throw new Error("reader source release failed");
      const releaseFailure = state.releaseFailure?.(owner);
      if (releaseFailure) throw releaseFailure;
      state.released.push({ reference: { ...reference }, owner });
    },
  };
  return state;
}

async function acquireAndRelease(store: GraphCapabilityStore, id: string): Promise<void> {
  const handle = await store.acquire(id);
  expect(handle).not.toBeNull();
  await handle?.release();
}

function descriptorDirectory(id: string): string {
  return join(
    cacheRoot,
    "graph-capabilities",
    "v1",
    "capabilities",
    id.slice(0, 2).padEnd(2, "_"),
    id,
  );
}

function descriptorPath(id: string): string {
  return join(descriptorDirectory(id), "descriptor.json");
}

function descriptorIntegrityPath(id: string): string {
  return join(descriptorDirectory(id), "descriptor.sha256");
}

function rewriteDescriptor(
  id: string,
  update: (descriptor: GraphCapabilityDescriptor) => GraphCapabilityDescriptor,
): void {
  const descriptor = JSON.parse(readFileSync(descriptorPath(id), "utf8")) as GraphCapabilityDescriptor;
  const serialized = `${JSON.stringify(update(descriptor), null, 2)}\n`;
  const digest = createHash("sha256")
    .update(id)
    .update("\0")
    .update(serialized)
    .digest("hex");
  chmodSync(descriptorDirectory(id), 0o700);
  chmodSync(descriptorPath(id), 0o600);
  chmodSync(descriptorIntegrityPath(id), 0o600);
  writeFileSync(descriptorPath(id), serialized);
  writeFileSync(descriptorIntegrityPath(id), `${digest}\n`);
  chmodSync(descriptorPath(id), 0o400);
  chmodSync(descriptorIntegrityPath(id), 0o400);
  chmodSync(descriptorDirectory(id), 0o500);
}

function makeDescriptorWritable(id: string): void {
  chmodSync(descriptorDirectory(id), 0o700);
  chmodSync(descriptorPath(id), 0o600);
}

function mutateSameSize(path: string): void {
  const bytes = readFileSync(path);
  bytes[0] = bytes[0]! ^ 1;
  chmodSync(path, 0o600);
  writeFileSync(path, bytes);
  chmodSync(path, 0o400);
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function flattenErrors(error: unknown): unknown[] {
  if (!(error instanceof AggregateError)) return [error];
  return error.errors.flatMap((nested) => flattenErrors(nested));
}
