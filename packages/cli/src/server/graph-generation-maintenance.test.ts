import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GraphGenerationMaintenanceCoordinator,
} from "./graph-generation-maintenance";
import type { GraphGenerationRootAuthority } from "./graph-generation-gc";

const roots: GraphGenerationRootAuthority = {
  async snapshotGenerationRoots() {
    return { revision: "test", generationPaths: new Set() };
  },
  generationRootSnapshotIsCurrent(snapshot) {
    return snapshot.revision === "test";
  },
};

afterEach(() => {
  vi.useRealTimers();
});

describe("GraphGenerationMaintenanceCoordinator", () => {
  it("runs startup collection and triggers recurring work by publication count", async () => {
    const collect = vi.fn(async () => collectionResult());
    const shutdown = new AbortController();
    const coordinator = new GraphGenerationMaintenanceCoordinator({
      collector: { collect },
      roots,
      shutdownSignal: shutdown.signal,
      publicationThreshold: 2,
    });

    await coordinator.start();
    expect(collect).toHaveBeenCalledTimes(1);
    coordinator.notePublication();
    expect(collect).toHaveBeenCalledTimes(1);
    coordinator.notePublication();
    await vi.waitFor(() => expect(collect).toHaveBeenCalledTimes(2));
    await coordinator.close();
  });

  it("singleflights one active pass and coalesces publications into one successor", async () => {
    const active = deferred<void>();
    let running = 0;
    let peak = 0;
    let calls = 0;
    const collect = vi.fn(async () => {
      calls += 1;
      running += 1;
      peak = Math.max(peak, running);
      try {
        if (calls === 2) await active.promise;
        return collectionResult();
      } finally {
        running -= 1;
      }
    });
    const coordinator = new GraphGenerationMaintenanceCoordinator({
      collector: { collect },
      roots,
      shutdownSignal: new AbortController().signal,
      publicationThreshold: 1,
    });
    await coordinator.start();

    coordinator.notePublication();
    await vi.waitFor(() => expect(calls).toBe(2));
    coordinator.notePublication();
    coordinator.notePublication();
    coordinator.notePublication();
    active.resolve();
    await vi.waitFor(() => expect(calls).toBe(3));

    expect(peak).toBe(1);
    await coordinator.close();
  });

  it("uses the periodic pass as a liveness backstop below the publication threshold", async () => {
    vi.useFakeTimers();
    const collect = vi.fn(async () => collectionResult());
    const coordinator = new GraphGenerationMaintenanceCoordinator({
      collector: { collect },
      roots,
      shutdownSignal: new AbortController().signal,
      publicationThreshold: 2,
      maxIntervalMs: 1_000,
    });
    await coordinator.start();
    coordinator.notePublication();

    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(collect).toHaveBeenCalledTimes(2));
    coordinator.notePublication();
    await Promise.resolve();
    expect(collect).toHaveBeenCalledTimes(2);
    coordinator.notePublication();
    await vi.waitFor(() => expect(collect).toHaveBeenCalledTimes(3));

    await coordinator.close();
  });

  it("aborts and physically joins an active pass during idempotent close", async () => {
    const started = deferred<void>();
    const physicalDrain = deferred<void>();
    let calls = 0;
    const collect = vi.fn(async (_roots: GraphGenerationRootAuthority, signal?: AbortSignal) => {
      calls += 1;
      if (calls === 1) return collectionResult();
      started.resolve();
      return await new Promise<never>((_resolve, reject) => {
        const onAbort = () => {
          void physicalDrain.promise.then(() => reject(new DOMException("aborted", "AbortError")));
        };
        if (signal?.aborted) onAbort();
        else signal?.addEventListener("abort", onAbort, { once: true });
      });
    });
    const coordinator = new GraphGenerationMaintenanceCoordinator({
      collector: { collect },
      roots,
      shutdownSignal: new AbortController().signal,
      publicationThreshold: 1,
    });
    await coordinator.start();
    coordinator.notePublication();
    await started.promise;

    const closing = coordinator.close();
    expect(coordinator.close()).toBe(closing);
    let settled = false;
    void closing.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    physicalDrain.resolve();
    await expect(closing).resolves.toBeUndefined();
  });

  it("surfaces a startup maintenance failure without an unhandled background branch", async () => {
    const failure = new Error("collection failed");
    const collect = vi.fn(async () => { throw failure; });
    const coordinator = new GraphGenerationMaintenanceCoordinator({
      collector: { collect },
      roots,
      shutdownSignal: new AbortController().signal,
    });

    const firstStart = coordinator.start();
    expect(coordinator.start()).toBe(firstStart);
    await expect(firstStart).rejects.toBe(failure);
    await expect(coordinator.start()).rejects.toBe(failure);
    expect(collect).toHaveBeenCalledTimes(1);
    await expect(coordinator.close()).rejects.toBe(failure);
  });
});

function collectionResult() {
  return Object.freeze({
    retainedGenerations: 0,
    retainedBytes: 0,
    quarantinedGenerations: 0,
    reclaimedBytes: 0,
    repairedLeases: 0,
  });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}
