/** Bounded process-private TTL/LRU cache for immutable projection and symbol JSON files. */

import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";

const DEFAULT_MAX_ENTRIES = 48;
const DEFAULT_MAX_BYTES = 512 * 1024 * 1024;
const DEFAULT_TTL_MS = 10 * 60_000;
const DEFAULT_SWEEP_INTERVAL_MS = 30_000;

export interface WebGraphProjectCacheOptions {
  maxEntries?: number;
  maxBytes?: number;
  ttlMs?: number;
  sweepIntervalMs?: number;
  now?: () => number;
}

export interface WebGraphProjectCacheStage {
  readonly directory: string;
  readonly outputPath: string;
}

export interface WebGraphProjectCacheHandle {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
  release(): void;
}

interface CacheEntry {
  key: string;
  directory: string;
  path: string;
  bytes: number;
  sha256: string;
  lastAccessMs: number;
  lastAccessOrder: number;
  expiresAtMs: number;
  pins: number;
}

export class WebGraphProjectCache {
  readonly rootPath: string;
  readonly #maxEntries: number;
  readonly #maxBytes: number;
  readonly #ttlMs: number;
  readonly #now: () => number;
  readonly #entries = new Map<string, CacheEntry>();
  readonly #sweepTimer: NodeJS.Timeout;
  #disposed = false;
  #accessOrder = 0;

  constructor(options: WebGraphProjectCacheOptions = {}) {
    this.#maxEntries = positiveInteger(options.maxEntries ?? DEFAULT_MAX_ENTRIES, "projection cache max entries");
    this.#maxBytes = positiveInteger(options.maxBytes ?? DEFAULT_MAX_BYTES, "projection cache max bytes");
    this.#ttlMs = positiveInteger(options.ttlMs ?? DEFAULT_TTL_MS, "projection cache TTL");
    const sweepIntervalMs = positiveInteger(
      options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS,
      "projection cache sweep interval",
    );
    this.#now = options.now ?? Date.now;
    // Always own a fresh private directory: dispose must never recursively remove caller-owned data.
    this.rootPath = mkdtempSync(join(tmpdir(), "meridian-graph-projections-"));
    this.#sweepTimer = setInterval(() => this.sweep(), sweepIntervalMs);
    this.#sweepTimer.unref?.();
  }

  createStage(): WebGraphProjectCacheStage {
    this.#assertActive();
    const directory = mkdtempSync(join(this.rootPath, ".stage-"));
    return { directory, outputPath: join(directory, "result.json") };
  }

  discardStage(stage: WebGraphProjectCacheStage): void {
    if (!this.#isOwnedStage(stage.directory)) return;
    rmSync(stage.directory, { recursive: true, force: true });
  }

  /** Atomically publish a child-verified stage. An equal-key loser reuses the existing file. */
  publish(
    key: string,
    stage: WebGraphProjectCacheStage,
    facts: { bytes: number; sha256: string },
  ): void {
    this.#publish(key, stage, facts, false);
  }

  /** Atomically publish and pin a child-verified stage. The returned handle closes the otherwise
   * observable gap where soft-limit enforcement could evict a new entry before its workflow owner
   * acquires it. */
  publishAndAcquire(
    key: string,
    stage: WebGraphProjectCacheStage,
    facts: { bytes: number; sha256: string },
  ): WebGraphProjectCacheHandle {
    return this.#publish(key, stage, facts, true) as WebGraphProjectCacheHandle;
  }

  #publish(
    key: string,
    stage: WebGraphProjectCacheStage,
    facts: { bytes: number; sha256: string },
    acquire: boolean,
  ): WebGraphProjectCacheHandle | undefined {
    this.#assertActive();
    if (!this.#isOwnedStage(stage.directory) || stage.outputPath !== join(stage.directory, "result.json")) {
      throw new TypeError("projection cache stage is not owned by this cache");
    }
    const file = lstatSync(stage.outputPath);
    if (!file.isFile() || file.size !== facts.bytes || !/^[a-f0-9]{64}$/.test(facts.sha256)) {
      throw new TypeError("projection cache stage facts do not match");
    }
    const existing = this.#entries.get(key);
    if (existing !== undefined) {
      if (existing.bytes !== facts.bytes || existing.sha256 !== facts.sha256) {
        throw new Error("equal projection cache key produced conflicting immutable bytes");
      }
      this.discardStage(stage);
      existing.lastAccessMs = this.#now();
      existing.lastAccessOrder = ++this.#accessOrder;
      existing.expiresAtMs = existing.lastAccessMs + this.#ttlMs;
      const handle = acquire ? this.acquire(key) : undefined;
      this.#enforce();
      if (acquire && handle === undefined) {
        throw new Error("published projection cache entry is unavailable");
      }
      return handle;
    }
    const directory = join(this.rootPath, `entry-${createHash("sha256").update(key).digest("hex")}`);
    if (existsSync(directory)) throw new Error("projection cache destination is unexpectedly occupied");
    renameSync(stage.directory, directory);
    const now = this.#now();
    this.#entries.set(key, {
      key,
      directory,
      path: join(directory, "result.json"),
      bytes: facts.bytes,
      sha256: facts.sha256,
      lastAccessMs: now,
      lastAccessOrder: ++this.#accessOrder,
      expiresAtMs: now + this.#ttlMs,
      pins: 0,
    });
    const handle = acquire ? this.acquire(key) : undefined;
    this.#enforce();
    if (acquire && handle === undefined) {
      throw new Error("published projection cache entry is unavailable");
    }
    return handle;
  }

  acquire(key: string): WebGraphProjectCacheHandle | undefined {
    this.#assertActive();
    const entry = this.#entries.get(key);
    if (entry === undefined) return undefined;
    const now = this.#now();
    if (entry.pins === 0 && entry.expiresAtMs <= now) {
      this.#evict(entry);
      return undefined;
    }
    const file = lstatSync(entry.path);
    if (!file.isFile() || file.size !== entry.bytes) {
      this.#evict(entry);
      return undefined;
    }
    entry.pins += 1;
    entry.lastAccessMs = now;
    entry.lastAccessOrder = ++this.#accessOrder;
    entry.expiresAtMs = now + this.#ttlMs;
    let released = false;
    return {
      path: entry.path,
      bytes: entry.bytes,
      sha256: entry.sha256,
      release: () => {
        if (released) return;
        released = true;
        if (entry.pins > 0) entry.pins -= 1;
        if (!this.#disposed) this.#enforce();
      },
    };
  }

  sweep(): void {
    if (this.#disposed) return;
    this.#enforce();
  }

  stats(): { entries: number; bytes: number; pins: number } {
    this.#assertActive();
    let bytes = 0;
    let pins = 0;
    for (const entry of this.#entries.values()) {
      bytes += entry.bytes;
      pins += entry.pins;
    }
    return { entries: this.#entries.size, bytes, pins };
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    clearInterval(this.#sweepTimer);
    this.#entries.clear();
    rmSync(this.rootPath, { recursive: true, force: true });
  }

  #enforce(): void {
    const now = this.#now();
    for (const entry of [...this.#entries.values()]) {
      if (entry.pins === 0 && entry.expiresAtMs <= now) this.#evict(entry);
    }
    const candidates = [...this.#entries.values()]
      .filter((entry) => entry.pins === 0)
      .sort((left, right) => (
        left.lastAccessMs - right.lastAccessMs
        || left.lastAccessOrder - right.lastAccessOrder
        || left.key.localeCompare(right.key)
      ));
    let bytes = [...this.#entries.values()].reduce((total, entry) => total + entry.bytes, 0);
    for (const entry of candidates) {
      if (this.#entries.size <= this.#maxEntries && bytes <= this.#maxBytes) break;
      bytes -= entry.bytes;
      this.#evict(entry);
    }
  }

  #evict(entry: CacheEntry): void {
    if (entry.pins > 0 || this.#entries.get(entry.key) !== entry) return;
    this.#entries.delete(entry.key);
    rmSync(entry.directory, { recursive: true, force: true });
  }

  #isOwnedStage(directory: string): boolean {
    const rel = relative(this.rootPath, directory);
    return rel.startsWith(".stage-") && !rel.includes("/") && !rel.includes("\\");
  }

  #assertActive(): void {
    if (this.#disposed) throw new Error("graph projection cache is disposed");
  }
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${label} must be a positive integer`);
  return value;
}
