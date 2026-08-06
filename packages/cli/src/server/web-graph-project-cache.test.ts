import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { WebGraphProjectCache } from "./web-graph-project-cache";

const caches: WebGraphProjectCache[] = [];

afterEach(() => {
  for (const cache of caches.splice(0)) cache.dispose();
});

describe("WebGraphProjectCache", () => {
  it("publishes immutable files and protects a streamed handle from TTL eviction", () => {
    let now = 0;
    const cache = createCache({ ttlMs: 10, now: () => now });
    publish(cache, "one", "payload");
    const handle = cache.acquire("one");
    expect(handle).toBeDefined();

    now = 20;
    cache.sweep();
    expect(cache.stats()).toEqual({ entries: 1, bytes: 7, pins: 1 });

    handle!.release();
    cache.sweep();
    expect(cache.stats()).toEqual({ entries: 0, bytes: 0, pins: 0 });
  });

  it("uses deterministic LRU retention and never evicts a pinned entry", () => {
    let now = 1;
    const cache = createCache({ maxEntries: 1, maxBytes: 1024, now: () => now });
    publish(cache, "old", "old");
    const pin = cache.acquire("old")!;
    now += 1;
    publish(cache, "new", "new");

    expect(cache.acquire("new")).toBeUndefined();
    expect(cache.stats()).toEqual({ entries: 1, bytes: 3, pins: 1 });
    pin.release();
  });

  it("retains the newly published entry when two unpinned accesses share a clock tick", () => {
    const cache = createCache({ maxEntries: 1, maxBytes: 1024, now: () => 1 });
    publish(cache, "z-old", "old");
    publish(cache, "a-new", "new");

    expect(cache.acquire("z-old")).toBeUndefined();
    const latest = cache.acquire("a-new");
    expect(latest).toBeDefined();
    latest!.release();
  });

  it("publishes and pins atomically before soft retention can evict the new entry", () => {
    const cache = createCache({ maxEntries: 1, maxBytes: 3 });
    publish(cache, "existing", "old");
    const stage = cache.createStage();
    const bytes = Buffer.from("new");
    writeFileSync(stage.outputPath, bytes);

    const pinned = cache.publishAndAcquire("replacement", stage, {
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });

    expect(cache.acquire("existing")).toBeUndefined();
    expect(cache.stats()).toEqual({ entries: 1, bytes: 3, pins: 1 });
    expect(pinned.path).toMatch(/result\.json$/);
    pinned.release();
  });

  it("allows a bounded pinned overflow and converges after those handles release", () => {
    const cache = createCache({ maxEntries: 2, maxBytes: 4 });
    const pins = ["a", "b", "c", "d"].map((key) => publishAndAcquire(cache, key, key.repeat(2)));

    expect(cache.stats()).toEqual({ entries: 4, bytes: 8, pins: 4 });
    pins[0]!.release();
    pins[1]!.release();
    expect(cache.stats()).toEqual({ entries: 2, bytes: 4, pins: 2 });
    expect(cache.acquire("a")).toBeUndefined();
    expect(cache.acquire("b")).toBeUndefined();
    pins[2]!.release();
    pins[3]!.release();
  });

  it("pins an exact immutable republish without replacing the existing file", () => {
    const cache = createCache({ maxEntries: 1, maxBytes: 16 });
    publish(cache, "same", "payload");
    const original = cache.acquire("same")!;
    const republished = publishAndAcquire(cache, "same", "payload");

    expect(republished.path).toBe(original.path);
    expect(cache.stats()).toEqual({ entries: 1, bytes: 7, pins: 2 });
    original.release();
    republished.release();
  });

  it("rejects conflicting bytes for an equal immutable cache key", () => {
    const cache = createCache();
    publish(cache, "same", "first");
    const stage = cache.createStage();
    const bytes = Buffer.from("second");
    writeFileSync(stage.outputPath, bytes);
    expect(() => cache.publish("same", stage, {
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    })).toThrow(/conflicting immutable bytes/);
    cache.discardStage(stage);
  });
});

function createCache(options: ConstructorParameters<typeof WebGraphProjectCache>[0] = {}): WebGraphProjectCache {
  const cache = new WebGraphProjectCache({ sweepIntervalMs: 60_000, ...options });
  caches.push(cache);
  return cache;
}

function publish(cache: WebGraphProjectCache, key: string, value: string): void {
  const stage = cache.createStage();
  const bytes = Buffer.from(value);
  writeFileSync(stage.outputPath, bytes);
  cache.publish(key, stage, {
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
}

function publishAndAcquire(cache: WebGraphProjectCache, key: string, value: string) {
  const stage = cache.createStage();
  const bytes = Buffer.from(value);
  writeFileSync(stage.outputPath, bytes);
  return cache.publishAndAcquire(key, stage, {
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
}
