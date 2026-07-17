import { describe, expect, it, vi } from "vitest";
import { BoundedAsyncValueCache } from "./boundedAsyncValueCache";

const LIMITS = {
  maxEntries: 2,
  maxResidentBytes: 8,
  maxFlights: 4,
  maxActiveFlights: 2,
  maxActiveBytes: 20,
  maxSubscribers: 8,
} as const;

describe("BoundedAsyncValueCache", () => {
  it("singleflights one immutable key and aborts only after its final subscriber leaves", async () => {
    const started = deferred<void>();
    const result = deferred<string>();
    let physicalSignal: AbortSignal | undefined;
    const loader = vi.fn(async (signal: AbortSignal) => {
      physicalSignal = signal;
      started.resolve();
      return result.promise;
    });
    const cache = new BoundedAsyncValueCache<string, string>(LIMITS, (value) => value.length);
    const first = new AbortController();
    const second = new AbortController();

    const left = cache.load("same", { estimatedBytes: 10, signal: first.signal }, loader);
    const right = cache.load("same", { estimatedBytes: 10, signal: second.signal }, loader);
    await started.promise;
    expect(loader).toHaveBeenCalledOnce();
    expect(cache.subscriberCount).toBe(2);

    first.abort();
    await expect(left).rejects.toMatchObject({ name: "AbortError" });
    expect(physicalSignal?.aborted).toBe(false);
    expect(cache.subscriberCount).toBe(1);

    second.abort();
    await expect(right).rejects.toMatchObject({ name: "AbortError" });
    expect(physicalSignal?.aborted).toBe(true);
    expect(cache.subscriberCount).toBe(0);
    result.reject(physicalSignal?.reason);
    await vi.waitFor(() => expect(cache.flightCount).toBe(0));
  });

  it("bounds rapid unique requests across active, queued, and rejected ownership", async () => {
    const releases: Array<ReturnType<typeof deferred<string>>> = [];
    const cache = new BoundedAsyncValueCache<string, string>(LIMITS, (value) => value.length);
    const loader = vi.fn((_signal: AbortSignal) => {
      const current = deferred<string>();
      releases.push(current);
      return current.promise;
    });

    const pending = Array.from({ length: 7 }, (_value, index) => cache.load(
      `key-${index}`,
      { estimatedBytes: 10 },
      loader,
    ));
    const observed = pending.map((request) => request.then(
      (value) => value,
      (error: Error) => error.message,
    ));
    await vi.waitFor(() => expect(loader).toHaveBeenCalledTimes(2));
    expect(cache.flightCount).toBe(4);
    expect(cache.activeFlightCount).toBe(2);
    expect(cache.queuedFlightCount).toBe(2);
    expect(cache.activeFlightByteLength).toBe(20);
    expect(cache.subscriberCount).toBe(4);
    await expect(Promise.all(observed.slice(4)))
      .resolves.toEqual(Array(3).fill("too many async value flights are already active"));

    releases[0]!.resolve("one");
    releases[1]!.resolve("two");
    await vi.waitFor(() => expect(loader).toHaveBeenCalledTimes(4));
    releases[2]!.resolve("three");
    releases[3]!.resolve("four");
    await Promise.all(observed.slice(0, 4));
    expect(cache.flightCount).toBe(0);
    expect(cache.activeFlightCount).toBe(0);
    expect(cache.queuedFlightCount).toBe(0);
    expect(cache.subscriberCount).toBe(0);
  });

  it("cancels a queued latest-navigation loser before it ever starts", async () => {
    const activeResult = deferred<string>();
    const cache = new BoundedAsyncValueCache<string, string>(
      { ...LIMITS, maxActiveFlights: 1, maxActiveBytes: 10 },
      (value) => value.length,
    );
    const loader = vi.fn((signal: AbortSignal) => signal.aborted
      ? Promise.reject(signal.reason)
      : activeResult.promise);
    const active = cache.load("active", { estimatedBytes: 10 }, loader);
    await vi.waitFor(() => expect(loader).toHaveBeenCalledOnce());
    const staleController = new AbortController();
    const stale = cache.load("stale", { estimatedBytes: 10, signal: staleController.signal }, loader);
    await vi.waitFor(() => expect(cache.queuedFlightCount).toBe(1));

    staleController.abort();
    await expect(stale).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(cache.queuedFlightCount).toBe(0));
    expect(loader).toHaveBeenCalledOnce();
    expect(cache.subscriberCount).toBe(1);

    activeResult.resolve("active");
    await expect(active).resolves.toBe("active");
  });

  it("keeps only count/byte-bounded settled values and promotes an LRU hit", async () => {
    const cache = new BoundedAsyncValueCache<string, string>(LIMITS, (value) => value.length);
    const loader = vi.fn(async (_signal: AbortSignal) => "1234");
    await cache.load("first", { estimatedBytes: 1 }, loader);
    await cache.load("second", { estimatedBytes: 1 }, loader);
    await cache.load("first", { estimatedBytes: 1 }, loader);
    await cache.load("third", { estimatedBytes: 1 }, loader);

    expect(cache.size).toBe(2);
    expect(cache.residentByteLength).toBe(8);
    await cache.load("first", { estimatedBytes: 1 }, loader);
    expect(loader).toHaveBeenCalledTimes(3);
    await cache.load("second", { estimatedBytes: 1 }, loader);
    expect(loader).toHaveBeenCalledTimes(4);
  });

  it("never retains a rejected or individually oversized decoded value", async () => {
    const cache = new BoundedAsyncValueCache<string, string>(LIMITS, (value) => value.length);
    await expect(cache.load("failed", { estimatedBytes: 1 }, async () => {
      throw new Error("source failed");
    })).rejects.toThrow("source failed");
    await expect(cache.load("large", { estimatedBytes: 1 }, async () => "123456789"))
      .resolves.toBe("123456789");
    expect(cache.size).toBe(0);
    expect(cache.residentByteLength).toBe(0);
  });
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
