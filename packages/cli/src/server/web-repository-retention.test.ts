import { lstat, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RepositoryRetentionScheduler,
  removePathNoFollow,
  repositoryRetentionOptionsFromEnv,
  resolveRepositoryRetentionOptions,
  selectCapacityRetentionCandidates,
  selectIdleRetentionCandidates,
  selectRetentionCandidates,
  sizeOfPathNoFollow,
  type RepositoryRetentionCandidate,
} from "./web-repository-retention";

const GIB = 1024 ** 3;
const DAY_MS = 24 * 60 * 60_000;

afterEach(() => {
  vi.useRealTimers();
});

describe("resolveRepositoryRetentionOptions", () => {
  it("provides bounded defaults with high/low watermark hysteresis", () => {
    expect(resolveRepositoryRetentionOptions()).toEqual({
      maxBytes: 20 * GIB,
      lowWaterBytes: 16 * GIB,
      maxIdleMs: 30 * DAY_MS,
      sweepIntervalMs: 60 * 60_000,
      initialDelayMs: 30_000,
      accessTouchIntervalMs: 5 * 60_000,
      capacityGraceMs: 5 * 60_000,
    });
  });

  it("derives a new low watermark when only maxBytes is overridden", () => {
    expect(resolveRepositoryRetentionOptions({ maxBytes: 10_000 })).toMatchObject({
      maxBytes: 10_000,
      lowWaterBytes: 8_000,
    });
  });

  it.each([
    [{ maxBytes: 0 }, "maxBytes"],
    [{ maxBytes: 10, lowWaterBytes: 10 }, "lowWaterBytes"],
    [{ maxBytes: 10, lowWaterBytes: 11 }, "lowWaterBytes"],
    [{ maxIdleMs: Number.NaN }, "maxIdleMs"],
    [{ sweepIntervalMs: 1.5 }, "sweepIntervalMs"],
    [{ initialDelayMs: -1 }, "initialDelayMs"],
    [{ accessTouchIntervalMs: -1 }, "accessTouchIntervalMs"],
    [{ capacityGraceMs: -1 }, "capacityGraceMs"],
  ] as const)("rejects invalid override %j", (override, message) => {
    expect(() => resolveRepositoryRetentionOptions(override)).toThrow(message);
  });
});

describe("repositoryRetentionOptionsFromEnv", () => {
  it("returns only explicit overrides and preserves 80% hysteresis", () => {
    expect(repositoryRetentionOptionsFromEnv({})).toEqual({});
    expect(repositoryRetentionOptionsFromEnv({
      MERIDIAN_REPOSITORY_CACHE_MAX_GIB: "2.5",
      MERIDIAN_REPOSITORY_CACHE_MAX_AGE_DAYS: "7.5",
    })).toEqual({
      maxBytes: 2.5 * GIB,
      lowWaterBytes: 2 * GIB,
      maxIdleMs: 7.5 * DAY_MS,
    });
  });

  it.each([
    ["MERIDIAN_REPOSITORY_CACHE_MAX_GIB", ""],
    ["MERIDIAN_REPOSITORY_CACHE_MAX_GIB", "0"],
    ["MERIDIAN_REPOSITORY_CACHE_MAX_GIB", "-1"],
    ["MERIDIAN_REPOSITORY_CACHE_MAX_GIB", "1 GiB"],
    ["MERIDIAN_REPOSITORY_CACHE_MAX_GIB", "Infinity"],
    ["MERIDIAN_REPOSITORY_CACHE_MAX_AGE_DAYS", "NaN"],
    ["MERIDIAN_REPOSITORY_CACHE_MAX_AGE_DAYS", "1e3"],
  ])("rejects invalid %s=%j", (name, value) => {
    expect(() => repositoryRetentionOptionsFromEnv({ [name]: value })).toThrow(name);
  });
});

describe("selectRetentionCandidates", () => {
  const policy = resolveRepositoryRetentionOptions({
    maxBytes: 100,
    lowWaterBytes: 60,
    maxIdleMs: 100,
    accessTouchIntervalMs: 0,
    capacityGraceMs: 0,
    now: () => 1_000,
  });

  it("expires idle candidates below the high watermark in deterministic LRU order", () => {
    const input = [
      candidate("b", 10, 900),
      candidate("z", 10, 901),
      candidate("a", 10, 900),
    ];
    const selected = selectRetentionCandidates({ totalBytes: 30, candidates: input }, policy);

    expect(selected.pressure).toBe(false);
    expect(selected.selected.map(({ candidate: item, reason }) => [item.id, reason])).toEqual([
      ["a", "max-idle"],
      ["b", "max-idle"],
    ]);
    expect(selected.selectedBytes).toBe(20);
    expect(selected.projectedBytes).toBe(10);
    expect(input.map(({ id }) => id)).toEqual(["b", "z", "a"]);
  });

  it("crosses the low watermark only after pressure exceeds the high watermark", () => {
    const candidates = [
      candidate("oldest", 25, 950),
      candidate("middle", 25, 960),
      candidate("newest", 25, 970),
    ];
    expect(selectRetentionCandidates({ totalBytes: 100, candidates }, policy).selected).toEqual([]);

    const selected = selectRetentionCandidates({ totalBytes: 101, candidates }, policy);
    expect(selected.pressure).toBe(true);
    expect(selected.selected.map(({ candidate: item, reason }) => [item.id, reason])).toEqual([
      ["oldest", "capacity"],
      ["middle", "capacity"],
    ]);
    expect(selected.projectedBytes).toBe(51);
  });

  it("soft-pins live candidates, reports deferrals, and continues selecting later entries", () => {
    const selected = selectRetentionCandidates({
      totalBytes: 130,
      candidates: [
        candidate("expired-pinned", 40, 800, true),
        candidate("old-unpinned", 40, 950),
        candidate("capacity-pinned", 40, 960, true),
        candidate("new-unpinned", 40, 970),
      ],
    }, policy);

    expect(selected.selected.map(({ candidate: item }) => item.id)).toEqual([
      "old-unpinned",
      "new-unpinned",
    ]);
    expect(selected.deferred.map(({ candidate: item, trigger }) => [item.id, trigger])).toEqual([
      ["expired-pinned", "max-idle"],
      ["capacity-pinned", "capacity"],
    ]);
    expect(selected.projectedBytes).toBe(50);
  });

  it("does not enter pressure mode when age eviction already falls below the high watermark", () => {
    const selected = selectRetentionCandidates({
      totalBytes: 120,
      candidates: [candidate("expired", 30, 800), candidate("fresh", 40, 950)],
    }, policy);

    expect(selected.pressure).toBe(false);
    expect(selected.selected.map(({ candidate: item }) => item.id)).toEqual(["expired"]);
  });

  it("rejects duplicate or malformed snapshot candidates", () => {
    expect(() => selectRetentionCandidates({
      totalBytes: 10,
      candidates: [candidate("same", 1, 1), candidate("same", 1, 2)],
    }, policy)).toThrow("duplicate retention candidate id");
    expect(() => selectRetentionCandidates({
      totalBytes: 10,
      candidates: [{ ...candidate("bad", 1, 1), pinned: undefined as unknown as boolean }],
    }, policy)).toThrow("pinned must be a boolean");
  });
});

describe("composable retention passes", () => {
  it("continues capacity pressure across workspace and repository tiers", () => {
    const workspaces = selectCapacityRetentionCandidates({
      totalBytes: 130,
      candidates: [candidate("workspace", 20, 100)],
    }, { targetBytes: 60 });
    expect(workspaces.projectedBytes).toBe(110);

    const repositories = selectCapacityRetentionCandidates({
      totalBytes: workspaces.projectedBytes,
      candidates: [candidate("repository", 55, 200)],
    }, { targetBytes: 60 });
    expect(repositories.selected.map(({ candidate: item }) => item.id)).toEqual(["repository"]);
    expect(repositories.projectedBytes).toBe(55);
  });

  it("keeps idle expiry separate from capacity triggering", () => {
    const idle = selectIdleRetentionCandidates({
      totalBytes: 50,
      candidates: [candidate("old", 10, 100), candidate("fresh", 10, 950)],
    }, 100, 1_000);
    expect(idle.selected.map(({ candidate: item }) => item.id)).toEqual(["old"]);
    expect(idle.projectedBytes).toBe(40);

    const capacity = selectCapacityRetentionCandidates({
      totalBytes: idle.projectedBytes,
      candidates: [candidate("fresh", 10, 950)],
    }, { targetBytes: 40 });
    expect(capacity.selected).toEqual([]);
  });

  it("protects a just-published candidate during the capacity handoff window", () => {
    const capacity = selectCapacityRetentionCandidates({
      totalBytes: 101,
      candidates: [candidate("recent", 50, 990), candidate("older", 30, 100)],
    }, { targetBytes: 60, minimumAccessAgeMs: 100, now: 1_000 });

    expect(capacity.selected.map(({ candidate: item }) => item.id)).toEqual(["older"]);
    expect(capacity.deferred.map(({ candidate: item, reason }) => [item.id, reason])).toEqual([
      ["recent", "recent"],
    ]);
    expect(capacity.projectedBytes).toBe(71);
  });
});

describe("sizeOfPathNoFollow", () => {
  it("walks asynchronously without traversing symbolic links", async () => {
    const root = await mkdtemp(join(tmpdir(), "meridian-retention-size-"));
    const outside = await mkdtemp(join(tmpdir(), "meridian-retention-outside-"));
    try {
      await mkdir(join(root, "nested"));
      await writeFile(join(root, "one"), "12345");
      await writeFile(join(root, "nested", "two"), "1234567");
      await writeFile(join(outside, "must-not-count"), "x".repeat(1_000));
      const link = join(root, "outside-link");
      await symlink(outside, link, "dir");
      const linkSize = (await lstat(link)).size;

      expect(await sizeOfPathNoFollow(root)).toBe(5 + 7 + linkSize);
      expect(await sizeOfPathNoFollow(join(root, "missing"))).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("honors cancellation before touching the filesystem", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(sizeOfPathNoFollow("/definitely/not/read", controller.signal)).rejects.toThrow(
      "operation was cancelled",
    );
  });
});

describe("removePathNoFollow", () => {
  it("removes a quarantine tree without following an embedded symlink", async () => {
    const root = await mkdtemp(join(tmpdir(), "meridian-retention-remove-"));
    const outside = await mkdtemp(join(tmpdir(), "meridian-retention-remove-outside-"));
    try {
      await mkdir(join(root, "nested"));
      await writeFile(join(root, "nested", "inside"), "inside");
      await writeFile(join(outside, "sentinel"), "outside");
      await symlink(outside, join(root, "nested", "outside-link"), "dir");

      expect(await removePathNoFollow(root)).toBeGreaterThan(0);
      await expect(lstat(root)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await lstat(join(outside, "sentinel"))).toBeDefined();
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
});

describe("RepositoryRetentionScheduler", () => {
  it("uses the initial delay, never overlaps sweeps, and continues on the cadence", async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const firstSweep = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const sweep = vi.fn()
      .mockImplementationOnce(() => firstSweep)
      .mockResolvedValue(undefined);
    const scheduler = new RepositoryRetentionScheduler({
      initialDelayMs: 30,
      sweepIntervalMs: 100,
      sweep,
    });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(29);
    expect(sweep).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(sweep).toHaveBeenCalledTimes(1);
    expect(scheduler.trigger()).toBe(scheduler.trigger());
    finish();
    await vi.runAllTicks();
    await vi.advanceTimersByTimeAsync(99);
    expect(sweep).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sweep).toHaveBeenCalledTimes(2);
    await scheduler.stop();
  });

  it("reports failures without stopping later sweeps and aborts an active sweep on stop", async () => {
    vi.useFakeTimers();
    const error = new Error("sweep failed");
    const onError = vi.fn();
    const signals: AbortSignal[] = [];
    const sweep = vi.fn(async (signal: AbortSignal) => {
      signals.push(signal);
      if (signals.length === 1) throw error;
    });
    const scheduler = new RepositoryRetentionScheduler({
      initialDelayMs: 0,
      sweepIntervalMs: 10,
      sweep,
      onError,
    });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(onError).toHaveBeenCalledWith(error);
    await vi.advanceTimersByTimeAsync(10);
    expect(sweep).toHaveBeenCalledTimes(2);
    await scheduler.stop();
    expect(signals[1]?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(100);
    expect(sweep).toHaveBeenCalledTimes(2);
  });

  it("is terminal after stop and cannot be restarted by a late lifecycle callback", async () => {
    vi.useFakeTimers();
    const sweep = vi.fn();
    const scheduler = new RepositoryRetentionScheduler({
      initialDelayMs: 1,
      sweepIntervalMs: 1,
      sweep,
    });

    scheduler.start();
    await scheduler.stop();
    scheduler.start();
    await vi.advanceTimersByTimeAsync(10);

    expect(scheduler.started).toBe(false);
    expect(sweep).not.toHaveBeenCalled();
    await expect(scheduler.trigger()).rejects.toThrow("not started");
  });

  it("makes concurrent stop callers wait for the same active sweep boundary", async () => {
    let finish!: () => void;
    const deferred = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const scheduler = new RepositoryRetentionScheduler({
      initialDelayMs: 1_000,
      sweepIntervalMs: 1_000,
      sweep: () => deferred,
    });
    scheduler.start();
    const active = scheduler.trigger();
    await Promise.resolve();

    let firstDone = false;
    let secondDone = false;
    const first = scheduler.stop().then(() => { firstDone = true; });
    const second = scheduler.stop().then(() => { secondDone = true; });
    await Promise.resolve();
    expect({ firstDone, secondDone }).toEqual({ firstDone: false, secondDone: false });

    finish();
    await Promise.all([active, first, second]);
    expect({ firstDone, secondDone }).toEqual({ firstDone: true, secondDone: true });
  });
});

function candidate(
  id: string,
  sizeBytes: number,
  lastAccessMs: number,
  pinned = false,
): RepositoryRetentionCandidate {
  return { id, sizeBytes, lastAccessMs, pinned };
}
