import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GraphArtifact } from "@meridian/core";
import { WebGraphProjectCache, type WebGraphProjectCacheOptions } from "./web-graph-project-cache";
import {
  materializeValidatedArtifact,
  WebGraphStore,
  type WebGraphRegistrationHandle,
} from "./web-graph-store";
import {
  PrReviewHandoffClaimError,
  PrReviewHandoffOverloadedError,
  PrReviewHandoffRegistry,
  PrReviewHandoffRegistryClosedError,
  type PrReviewHandoffPair,
  type PrReviewHandoffRegistryOptions,
} from "./web-pr-review-handoff";
import {
  handlePrReviewHandoffAttach,
  handlePrReviewHandoffCommit,
  handlePrReviewHandoffRelease,
  prReviewHandoffClaimIdFromPath,
} from "./web-pr-review-handoff-api";
import type { Context } from "./web-server";

const ARTIFACT: GraphArtifact = {
  schemaVersion: "1.1.0",
  generatedAt: "2026-08-06T00:00:00.000Z",
  generator: { name: "meridian-test", version: "1" },
  target: { name: "handoff", root: ".", language: "typescript" },
  nodes: [],
  edges: [],
};

interface Harness {
  readonly registry: PrReviewHandoffRegistry;
  readonly store: WebGraphStore;
  readonly cache: WebGraphProjectCache;
  readonly acquired: {
    readonly graph: () => number;
    readonly projection: () => number;
  };
}

const harnesses: Harness[] = [];

afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    await harness.registry.close();
    harness.cache.dispose();
    harness.store.dispose();
  }
  vi.useRealTimers();
});

describe("PrReviewHandoffRegistry", () => {
  it("retains two different ready pairs without either superseding the other", async () => {
    const harness = createHarness();
    const first = seedPair(harness, "first");
    const second = seedPair(harness, "second");

    await Promise.all([
      prepare(harness.registry, first),
      prepare(harness.registry, second),
    ]);

    expect(harness.registry.stats()).toMatchObject({
      activePairs: 2,
      queuedPairs: 0,
      preparingPairs: 0,
      readyPairs: 2,
      pinnedBytes: 8,
      graphHandles: 4,
      projectionHandles: 4,
    });
    expect(harness.acquired.graph()).toBe(4);
    expect(harness.acquired.projection()).toBe(4);

    for (const pair of [first, second]) {
      const claim = harness.registry.issueClaim(pair.key);
      expect(claim.claimId).toMatch(/^[A-Za-z0-9_-]{32}$/);
      expect(claim.pair).toEqual(pair);
      const leaseId = createPairViewLease(harness, pair);
      harness.registry.attach(claim.claimId, leaseId);
      harness.registry.commit(claim.claimId, leaseId);
    }
    expect(harness.registry.stats()).toMatchObject({ activePairs: 0, pinnedBytes: 0 });
  });

  it("singleflights the same key, issues distinct claims, and keeps a sibling alive", async () => {
    const harness = createHarness();
    const pair = seedPair(harness, "shared");
    const gate = deferred<void>();
    let producerCalls = 0;
    const first = harness.registry.prepare(pair.key, new AbortController().signal, async () => {
      producerCalls += 1;
      await gate.promise;
      return pair;
    });
    const second = harness.registry.prepare(pair.key, new AbortController().signal, async () => {
      throw new Error("same-key follower producer must not run");
    });
    gate.resolve();

    await expect(first).resolves.toEqual(pair);
    expect(producerCalls).toBe(1);
    const one = harness.registry.issueClaim(pair.key);
    expect(harness.registry.release(one.claimId)).toBe("released");
    expect(harness.registry.stats()).toMatchObject({
      activePairs: 1,
      activeClaims: 0,
      unclaimedEntitlements: 1,
      graphHandles: 2,
      projectionHandles: 2,
    });
    await expect(second).resolves.toEqual(pair);
    const two = harness.registry.issueClaim(pair.key);
    expect(one.claimId).not.toBe(two.claimId);
    const leaseId = createPairViewLease(harness, pair);
    harness.registry.attach(two.claimId, leaseId);
    expect(harness.registry.commit(two.claimId, leaseId)).toBe("committed");
    expect(harness.registry.stats()).toMatchObject({ activePairs: 0, activeClaims: 0 });
  });

  it("bounds active same-pair consumer claims without disturbing admitted siblings", async () => {
    const harness = createHarness({ maxClaimsPerPair: 2 });
    const pair = seedPair(harness, "claim-bound");
    await prepare(harness.registry, pair);
    const first = harness.registry.issueClaim(pair.key);
    const second = harness.registry.issueClaim(pair.key);

    expect(() => harness.registry.issueClaim(pair.key)).toThrow(expect.objectContaining({
      name: "PrReviewHandoffOverloadedError",
      reason: "claims",
      retryAfterSeconds: 5,
    }));
    expect(harness.registry.stats()).toMatchObject({ activePairs: 1, activeClaims: 2 });
    expect(harness.registry.release(first.claimId)).toBe("released");
    expect(harness.registry.stats()).toMatchObject({ activePairs: 1, activeClaims: 1 });
    expect(harness.registry.release(second.claimId)).toBe("released");
    expect(harness.registry.stats()).toMatchObject({ activePairs: 0, activeClaims: 0 });
  });

  it("admits distinct queued pairs in FIFO order as ready claims settle", async () => {
    const harness = createHarness({ maxActivePairs: 1, maxQueuedPairs: 2 });
    const pairs = [seedPair(harness, "a"), seedPair(harness, "b"), seedPair(harness, "c")];
    const started: string[] = [];
    const run = (pair: PrReviewHandoffPair) => harness.registry.prepare(
      pair.key,
      new AbortController().signal,
      async () => {
        started.push(pair.key);
        return pair;
      },
    );

    await run(pairs[0]!);
    const second = run(pairs[1]!);
    const third = run(pairs[2]!);
    expect(started).toEqual(["a"]);
    expect(harness.registry.stats()).toMatchObject({ activePairs: 1, queuedPairs: 2 });

    settleReleased(harness.registry, "a");
    await expect(second).resolves.toEqual(pairs[1]);
    expect(started).toEqual(["a", "b"]);
    expect(harness.registry.stats().queuedPairs).toBe(1);

    settleReleased(harness.registry, "b");
    await expect(third).resolves.toEqual(pairs[2]);
    expect(started).toEqual(["a", "b", "c"]);
    settleReleased(harness.registry, "c");
  });

  it("returns a retryable overload without disturbing active or queued pairs", async () => {
    const harness = createHarness({ maxActivePairs: 1, maxQueuedPairs: 1 });
    const first = seedPair(harness, "active");
    const second = seedPair(harness, "queued");
    const refused = seedPair(harness, "refused");
    await prepare(harness.registry, first);
    const queued = prepare(harness.registry, second);

    const rejection = harness.registry.prepare(
      refused.key,
      new AbortController().signal,
      async () => refused,
    );
    await expect(rejection).rejects.toMatchObject({
      name: "PrReviewHandoffOverloadedError",
      reason: "queue",
      retryAfterSeconds: 5,
    });
    expect(harness.registry.stats()).toMatchObject({ activePairs: 1, queuedPairs: 1 });

    settleReleased(harness.registry, first.key);
    await expect(queued).resolves.toEqual(second);
    settleReleased(harness.registry, second.key);
  });

  it("enforces the actual aggregate pinned-byte budget and rolls back every refused handle", async () => {
    const harness = createHarness({ maxActivePairs: 2, maxPinnedBytes: 5 });
    const admitted = seedPair(harness, "admitted", "aa", "bb");
    const refused = seedPair(harness, "too-large", "cc", "dd");
    await prepare(harness.registry, admitted);

    await expect(prepare(harness.registry, refused)).rejects.toEqual(
      expect.objectContaining<Partial<PrReviewHandoffOverloadedError>>({
        name: "PrReviewHandoffOverloadedError",
        reason: "pinned-bytes",
      }),
    );
    expect(harness.registry.stats()).toMatchObject({
      activePairs: 1,
      readyPairs: 1,
      pinnedBytes: 4,
      graphHandles: 2,
      projectionHandles: 2,
    });
    expect(harness.acquired.graph()).toBe(2);
    expect(harness.acquired.projection()).toBe(2);
    settleReleased(harness.registry, admitted.key);
  });

  it("releases producer preparation pins only after registry adoption or refusal", async () => {
    const harness = createHarness();
    const adopted = seedPair(harness, "adopted");
    const adoptedRelease = vi.fn();
    await harness.registry.prepare(adopted.key, new AbortController().signal, async () => ({
      ...adopted,
      releasePreparationPins: adoptedRelease,
    }));
    expect(adoptedRelease).toHaveBeenCalledTimes(1);
    expect(harness.registry.stats()).toMatchObject({ graphHandles: 2, projectionHandles: 2 });
    settleReleased(harness.registry, adopted.key);

    const refused = seedPair(harness, "missing-projection");
    const refusedRelease = vi.fn();
    await expect(harness.registry.prepare(
      refused.key,
      new AbortController().signal,
      async () => ({
        ...refused,
        comparisonProjectionKey: "not-published",
        releasePreparationPins: refusedRelease,
      }),
    )).rejects.toMatchObject({ name: "PrReviewHandoffResourceError" });
    expect(refusedRelease).toHaveBeenCalledTimes(1);
    expect(harness.acquired.graph()).toBe(0);
    expect(harness.acquired.projection()).toBe(0);
  });

  it("expires unclaimed entries and claims independently without refreshing siblings", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    const harness = createHarness({ readyTtlMs: 10, claimTtlMs: 10, now: Date.now });
    const unclaimed = seedPair(harness, "unclaimed");
    await prepare(harness.registry, unclaimed);
    await vi.advanceTimersByTimeAsync(10);
    expect(harness.registry.stats()).toMatchObject({ activePairs: 0, pinnedBytes: 0 });

    const claimed = seedPair(harness, "claimed");
    await prepare(harness.registry, claimed);
    const older = harness.registry.issueClaim(claimed.key);
    await vi.advanceTimersByTimeAsync(5);
    const newer = harness.registry.issueClaim(claimed.key);
    await vi.advanceTimersByTimeAsync(5);
    expect(harness.registry.stats()).toMatchObject({ activePairs: 1, activeClaims: 1 });
    expect(harness.registry.release(older.claimId)).toBe("released");

    await vi.advanceTimersByTimeAsync(5);
    expect(harness.registry.stats()).toMatchObject({ activePairs: 0, activeClaims: 0 });
    expect(harness.registry.release(newer.claimId)).toBe("released");

    const attached = seedPair(harness, "attached-expiry");
    await prepare(harness.registry, attached);
    const attachedClaim = harness.registry.issueClaim(attached.key);
    const leaseId = createPairViewLease(harness, attached);
    harness.registry.attach(attachedClaim.claimId, leaseId);
    await vi.advanceTimersByTimeAsync(10);
    expect(harness.registry.inspectClaim(attachedClaim.claimId)).toMatchObject({
      claimId: attachedClaim.claimId,
      attachedViewLeaseId: leaseId,
    });
    expect(harness.registry.stats()).toMatchObject({ activePairs: 1, activeClaims: 1 });
    harness.store.releaseViewLease(leaseId);
    await vi.advanceTimersByTimeAsync(10);
    expect(harness.registry.stats()).toMatchObject({ activePairs: 0, activeClaims: 0 });
    expect(harness.registry.commit(attachedClaim.claimId, leaseId)).toBe("released");
  });

  it("inspects strictly and attaches retry-idempotently only to a pair-protecting lease", async () => {
    const harness = createHarness();
    const pair = seedPair(harness, "attach");
    await prepare(harness.registry, pair);
    const claim = harness.registry.issueClaim(pair.key);
    const leaseId = createPairViewLease(harness, pair);

    expect(harness.registry.inspectClaim(claim.claimId)).toEqual(claim);
    expect(() => harness.registry.attach(claim.claimId, "missing-view"))
      .toThrow(/does not protect/);
    expect(harness.registry.attach(claim.claimId, leaseId)).toMatchObject({
      claimId: claim.claimId,
      attachedViewLeaseId: leaseId,
    });
    expect(harness.registry.attach(claim.claimId, leaseId)).toMatchObject({
      attachedViewLeaseId: leaseId,
    });
    expect(() => harness.registry.attach(claim.claimId, "view-two"))
      .toThrow(PrReviewHandoffClaimError);
    expect(harness.registry.stats()).toMatchObject({ activeClaims: 1, attachedClaims: 1 });
    harness.store.renewViewLease(leaseId, [pair.headGraphId]);
    expect(() => harness.registry.commit(claim.claimId, leaseId))
      .toThrow(/no longer protects/);
    const recreatedLeaseId = createPairViewLease(harness, pair);
    expect(harness.registry.attach(claim.claimId, recreatedLeaseId)).toMatchObject({
      attachedViewLeaseId: recreatedLeaseId,
    });
    expect(harness.registry.commit(claim.claimId, recreatedLeaseId)).toBe("committed");
    expect(() => harness.registry.inspectClaim(claim.claimId)).toThrow(/unknown/);
  });

  it("commits and releases claims idempotently while preserving the first settlement", async () => {
    const harness = createHarness();
    const pair = seedPair(harness, "settle");
    await prepare(harness.registry, pair);
    const committed = harness.registry.issueClaim(pair.key);
    const released = harness.registry.issueClaim(pair.key);
    const leaseId = createPairViewLease(harness, pair);

    expect(() => harness.registry.commit(committed.claimId)).toThrow(/must be attached/);
    harness.registry.attach(committed.claimId, leaseId);
    expect(harness.registry.commit(committed.claimId, leaseId)).toBe("committed");
    expect(harness.registry.commit(committed.claimId, leaseId)).toBe("committed");
    expect(() => harness.registry.commit(committed.claimId, "other-view"))
      .toThrow(/another view/);
    expect(harness.registry.release(committed.claimId)).toBe("committed");
    expect(harness.registry.stats()).toMatchObject({ activePairs: 1, activeClaims: 1 });

    expect(harness.registry.release(released.claimId)).toBe("released");
    expect(harness.registry.release(released.claimId)).toBe("released");
    expect(harness.registry.commit(released.claimId)).toBe("released");
    expect(harness.registry.stats()).toMatchObject({ activePairs: 0, activeClaims: 0 });
  });

  it("keeps same-pair work alive for one waiter and drains after the last waiter aborts", async () => {
    const harness = createHarness({ maxActivePairs: 1 });
    const pair = seedPair(harness, "abort");
    const producerGate = deferred<void>();
    const producerStarted = deferred<AbortSignal>();
    const firstController = new AbortController();
    const secondController = new AbortController();
    const releasePreparationPins = vi.fn();
    const first = harness.registry.prepare(pair.key, firstController.signal, async (signal) => {
      producerStarted.resolve(signal);
      await producerGate.promise;
      return { ...pair, releasePreparationPins };
    });
    const second = harness.registry.prepare(pair.key, secondController.signal, async () => {
      throw new Error("follower producer must not run");
    });
    const firstReason = new Error("first left");
    const secondReason = new Error("last left");
    const firstRejection = expect(first).rejects.toBe(firstReason);
    const secondRejection = expect(second).rejects.toBe(secondReason);
    const producerSignal = await producerStarted.promise;

    firstController.abort(firstReason);
    await firstRejection;
    expect(producerSignal.aborted).toBe(false);
    secondController.abort(secondReason);
    expect(producerSignal.aborted).toBe(true);
    expect(harness.registry.stats()).toMatchObject({ activePairs: 1, preparingPairs: 1 });
    let lastWaiterSettled = false;
    void second.then(
      () => { lastWaiterSettled = true; },
      () => { lastWaiterSettled = true; },
    );
    await Promise.resolve();
    expect(lastWaiterSettled).toBe(false);

    producerGate.resolve();
    await secondRejection;
    await vi.waitFor(() => expect(harness.registry.stats().activePairs).toBe(0));
    expect(releasePreparationPins).toHaveBeenCalledTimes(1);
    expect(harness.acquired.graph()).toBe(0);
    expect(harness.acquired.projection()).toBe(0);
  });

  it("closes synchronously, releases ready handles, aborts work, rejects its queue, and drains", async () => {
    const harness = createHarness({ maxActivePairs: 2, maxQueuedPairs: 1 });
    const ready = seedPair(harness, "ready");
    const running = seedPair(harness, "running");
    const queued = seedPair(harness, "queued-close");
    await prepare(harness.registry, ready);
    const liveClaim = harness.registry.issueClaim(ready.key);
    const runningGate = deferred<void>();
    const runningStarted = deferred<AbortSignal>();
    const runningReleasePreparationPins = vi.fn();
    const runningPromise = harness.registry.prepare(
      running.key,
      new AbortController().signal,
      async (signal) => {
        runningStarted.resolve(signal);
        await runningGate.promise;
        return { ...running, releasePreparationPins: runningReleasePreparationPins };
      },
    );
    const queuedPromise = prepare(harness.registry, queued);
    const runningRejection = expect(runningPromise).rejects.toBeInstanceOf(PrReviewHandoffRegistryClosedError);
    const queuedRejection = expect(queuedPromise).rejects.toBeInstanceOf(PrReviewHandoffRegistryClosedError);
    const runningSignal = await runningStarted.promise;

    const close = harness.registry.close();
    expect(harness.registry.stats()).toMatchObject({ closed: true, readyPairs: 0, activeClaims: 0 });
    expect(runningSignal.aborted).toBe(true);
    expect(harness.acquired.graph()).toBe(0);
    expect(harness.acquired.projection()).toBe(0);
    expect(harness.registry.release(liveClaim.claimId)).toBe("released");
    await Promise.all([runningRejection, queuedRejection]);

    let drained = false;
    void close.then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);
    runningGate.resolve();
    await close;
    expect(runningReleasePreparationPins).toHaveBeenCalledTimes(1);
    expect(harness.registry.stats()).toMatchObject({
      closed: true,
      activePairs: 0,
      queuedPairs: 0,
      pinnedBytes: 0,
      graphHandles: 0,
      projectionHandles: 0,
    });
    expect(harness.acquired.graph()).toBe(0);
    expect(harness.acquired.projection()).toBe(0);
    await expect(prepare(harness.registry, ready)).rejects.toBeInstanceOf(
      PrReviewHandoffRegistryClosedError,
    );
    await expect(harness.registry.close()).resolves.toBeUndefined();
  });
});

describe("prepared PR-review handoff HTTP boundary", () => {
  it("attaches and retry-idempotently commits the exact pair lease", async () => {
    const harness = createHarness();
    const pair = seedPair(harness, "api");
    await prepare(harness.registry, pair);
    const claim = harness.registry.issueClaim(pair.key);
    const viewLeaseId = createPairViewLease(harness, pair);
    const ctx = {
      shutdownSignal: new AbortController().signal,
      prReviewHandoffs: harness.registry,
    } as Context;

    const attached = await invokeApi((request, response) => (
      handlePrReviewHandoffAttach(ctx, request, response, claim.claimId)
    ), { version: 1, viewLeaseId });
    expect(attached).toMatchObject({
      status: 200,
      json: { version: 1, expiresAtMs: expect.any(Number) },
    });
    expect(harness.registry.inspectClaim(claim.claimId).attachedViewLeaseId).toBe(viewLeaseId);

    const commitBody = { version: 1, viewLeaseId, action: "commit" };
    const committed = await invokeApi((request, response) => (
      handlePrReviewHandoffCommit(ctx, request, response, claim.claimId)
    ), commitBody);
    const retried = await invokeApi((request, response) => (
      handlePrReviewHandoffCommit(ctx, request, response, claim.claimId)
    ), commitBody);
    expect(committed).toMatchObject({ status: 200, json: { version: 1 } });
    expect(retried).toMatchObject({ status: 200, json: { version: 1 } });
    expect(harness.registry.stats()).toMatchObject({ activePairs: 0, activeClaims: 0 });
  });

  it("parses only opaque claim paths and keeps DELETE non-enumerating", () => {
    const harness = createHarness();
    const claimId = "a".repeat(32);
    expect(prReviewHandoffClaimIdFromPath(`/api/pr-review-handoffs/${claimId}`)).toBe(claimId);
    expect(prReviewHandoffClaimIdFromPath("/api/pr-review-handoffs")).toBeNull();
    expect(() => prReviewHandoffClaimIdFromPath("/api/pr-review-handoffs/short"))
      .toThrow(/unknown prepared PR review handoff/);

    const response = new ApiResponse();
    handlePrReviewHandoffRelease(
      { prReviewHandoffs: harness.registry } as Context,
      response as unknown as ServerResponse,
      claimId,
    );
    expect(response.status).toBe(204);
    expect(response.body()).toBe("");
  });
});

function createHarness(
  registryOptions: PrReviewHandoffRegistryOptions = {},
  cacheOptions: WebGraphProjectCacheOptions = {},
): Harness {
  const store = new WebGraphStore({
    maxEntries: 32,
    lowWaterEntries: 24,
    maxArtifactBytes: 1024 * 1024,
    lowWaterArtifactBytes: 768 * 1024,
    maxSourceLeases: 32,
    lowWaterSourceLeases: 24,
    publicationHandoffTtlMs: 0,
    sweepIntervalMs: 60_000,
  });
  const cache = new WebGraphProjectCache({
    maxEntries: 32,
    maxBytes: 1024 * 1024,
    sweepIntervalMs: 60_000,
    ...cacheOptions,
  });
  let graphHandles = 0;
  let projectionHandles = 0;
  const acquireGraph = store.acquire.bind(store);
  vi.spyOn(store, "acquire").mockImplementation((id) => {
    const handle = acquireGraph(id);
    if (handle === undefined) return undefined;
    graphHandles += 1;
    return trackedGraphHandle(handle, () => { graphHandles -= 1; });
  });
  const acquireProjection = cache.acquire.bind(cache);
  vi.spyOn(cache, "acquire").mockImplementation((key) => {
    const handle = acquireProjection(key);
    if (handle === undefined) return undefined;
    projectionHandles += 1;
    let released = false;
    return {
      ...handle,
      release() {
        if (released) return;
        released = true;
        projectionHandles -= 1;
        handle.release();
      },
    };
  });
  const registry = new PrReviewHandoffRegistry(store, cache, registryOptions);
  const harness = {
    registry,
    store,
    cache,
    acquired: {
      graph: () => graphHandles,
      projection: () => projectionHandles,
    },
  } satisfies Harness;
  harnesses.push(harness);
  return harness;
}

function trackedGraphHandle(
  handle: WebGraphRegistrationHandle,
  onRelease: () => void,
): WebGraphRegistrationHandle {
  let released = false;
  return {
    ...handle,
    release() {
      if (released) return;
      released = true;
      onRelease();
      handle.release();
    },
  };
}

function seedPair(
  harness: Harness,
  key: string,
  headProjection = "hh",
  comparisonProjection = "cc",
): PrReviewHandoffPair {
  const pair = {
    key,
    headGraphId: `${key}-head`,
    comparisonGraphId: `${key}-comparison`,
    headProjectionKey: `${key}-head-projection`,
    comparisonProjectionKey: `${key}-comparison-projection`,
  } satisfies PrReviewHandoffPair;
  for (const id of [pair.headGraphId, pair.comparisonGraphId]) {
    harness.store.publish({
      id,
      material: materializeValidatedArtifact(ARTIFACT),
      rawGraphPayload: "projection-only",
      metadata: {
        sourceRoot: "/workspace/handoff",
        source: { kind: "path" },
        synthetic: { scenarios: [], sourceFingerprint: null, trust: null },
      },
    });
  }
  publishProjection(harness.cache, pair.headProjectionKey, headProjection);
  publishProjection(harness.cache, pair.comparisonProjectionKey, comparisonProjection);
  return pair;
}

function publishProjection(cache: WebGraphProjectCache, key: string, value: string): void {
  const stage = cache.createStage();
  const bytes = Buffer.from(value);
  writeFileSync(stage.outputPath, bytes);
  cache.publish(key, stage, {
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
}

function prepare(
  registry: PrReviewHandoffRegistry,
  pair: PrReviewHandoffPair,
): Promise<PrReviewHandoffPair> {
  return registry.prepare(pair.key, new AbortController().signal, async () => pair);
}

function createPairViewLease(harness: Harness, pair: PrReviewHandoffPair): string {
  return harness.store.createViewLease(pair.headGraphId, [
    pair.headGraphId,
    pair.comparisonGraphId,
  ]).leaseId;
}

function settleReleased(registry: PrReviewHandoffRegistry, key: string): void {
  const claim = registry.issueClaim(key);
  registry.release(claim.claimId);
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => { resolve = innerResolve; });
  return { promise, resolve };
}

async function invokeApi(
  handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>,
  body: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const request = new PassThrough() as PassThrough & IncomingMessage;
  request.end(JSON.stringify(body));
  const response = new ApiResponse();
  await handler(request, response as unknown as ServerResponse);
  return { status: response.status, json: JSON.parse(response.body()) as Record<string, unknown> };
}

class ApiResponse extends Writable {
  status = 0;
  readonly chunks: Buffer[] = [];

  writeHead(status: number): this {
    this.status = status;
    return this;
  }

  body(): string {
    return Buffer.concat(this.chunks).toString("utf8");
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
