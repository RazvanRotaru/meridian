import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  GraphGenerationLifecycle,
  sealGraphGenerationStage,
  type GraphGenerationStage,
} from "./graph-generation-lifecycle";
import {
  finalizedGenerationDirectory,
  graphGenerationStagePath,
  graphGenerationStagingRoot,
  repositoryArtifactEntry,
} from "./graph-cache-layout";
import { removeEntry } from "./web-cache-storage";

const REPOSITORY_KEY = "a".repeat(24);
const COMMIT = "b".repeat(40);
const ANALYSIS_KEY = "c".repeat(24);
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) removeEntry(root);
});

describe("GraphGenerationLifecycle", () => {
  it("persists exact hard roots until every independent lease releases", async () => {
    const { root, generation } = fixture();
    const lifecycle = authority(root, "process-a");
    const first = await lifecycle.acquire(generation, { purpose: "cache-read" });
    const second = await lifecycle.acquire(generation, { purpose: "verification" });

    const active = await lifecycle.activeLeaseSnapshot();
    expect(active.activeLeases).toBe(2);
    expect([...active.generationPaths]).toEqual([portable(relative(root, generation))]);

    await first.release();
    expect(await lifecycle.activeLeaseSnapshot()).toMatchObject({ activeLeases: 1 });
    await first.release();
    await second.release();
    expect(await lifecycle.activeLeaseSnapshot()).toMatchObject({ activeLeases: 0 });
  });

  it("reserves an absent destination across the atomic generation publication", async () => {
    const { root, generations } = fixture(false);
    const destination = join(generations, "generation-one");
    const lifecycle = authority(root, "process-a");
    const stage = await lifecycle.reserveStage();
    writeFileSync(join(stage.directory, "payload.bin"), "ready");
    const destinationLease = await lifecycle.acquire(destination, {
      purpose: "publication",
      allowMissing: true,
    });
    await authorizeStagePublication(stage);

    await expect(stage.publish(destinationLease)).resolves.toBe(true);
    expect(await lifecycle.activeLeaseSnapshot()).toMatchObject({ activeLeases: 2 });
    expect(destinationLease.generationDirectory).toBe(realpathSync(destination));
    await stage.release();
    await destinationLease.release();
  });

  it("owns mutable stages only in the dedicated exact-schema staging namespace", async () => {
    const { root } = fixture(false);
    const lifecycle = authority(root, "process-a");
    const stage = await lifecycle.reserveStage();

    expect(stage.directory.startsWith(`${realpathSync(graphGenerationStagingRoot(root))}${sep}`)).toBe(true);
    expect(await lifecycle.activeLeaseSnapshot()).toMatchObject({
      activeLeases: 1,
      repairedLeases: 0,
    });
    await expect(lifecycle.acquire(stage.directory, { purpose: "cache-read" }))
      .rejects.toThrow(/finalized cache coordinate/);

    await stage.release();
    expect(readdirSync(graphGenerationStagingRoot(root))).toEqual([]);
    expect(readdirSync(stagingLeaseRoot(root))).toEqual([]);
  });

  it("reconciles a crashed stage owner and its durable marker after restart", async () => {
    const { root } = fixture(false);
    const original = authority(root, "process-a");
    const stage = await original.reserveStage();
    writeFileSync(join(stage.directory, "payload.bin"), "owned");

    const restarted = authority(root, "process-b");
    expect(await restarted.activeLeaseSnapshot()).toMatchObject({
      activeLeases: 0,
      repairedLeases: 1,
    });
    expect(existsSync(stage.directory)).toBe(false);
    expect(readdirSync(stagingLeaseRoot(root))).toEqual([]);
    await expect(stage.release()).resolves.toBeUndefined();
  });

  it("reclaims an orphan exact-schema stage without traversing unrelated cache trees", async () => {
    const { root } = fixture(false);
    const orphan = graphGenerationStagePath(root, "d".repeat(48));
    mkdirSync(orphan, { recursive: true, mode: 0o700 });
    writeFileSync(join(orphan, "payload.bin"), "orphaned");
    const unrelated = join(root, "source-checkouts", "repo", "generations", "nested");
    mkdirSync(unrelated, { recursive: true, mode: 0o700 });
    writeFileSync(join(unrelated, "keep.bin"), "keep");

    const lifecycle = authority(root, "process-a");
    expect(await lifecycle.activeLeaseSnapshot()).toMatchObject({
      activeLeases: 0,
      repairedLeases: 1,
    });
    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(join(unrelated, "keep.bin"))).toBe(true);
  });

  it("preserves a replacement stage and retires only its stale ownership marker", async () => {
    const { root } = fixture(false);
    const original = authority(root, "process-a");
    const stage = await original.reserveStage();
    writeFileSync(join(stage.directory, "owned.bin"), "original");
    const displaced = join(root, "displaced-owned-stage");
    renameSync(stage.directory, displaced);
    mkdirSync(stage.directory, { mode: 0o700 });
    writeFileSync(join(stage.directory, "replacement.bin"), "replacement");

    const restarted = authority(root, "process-b");
    expect(await restarted.activeLeaseSnapshot()).toMatchObject({
      activeLeases: 0,
      repairedLeases: 1,
    });
    expect(existsSync(join(displaced, "owned.bin"))).toBe(true);
    expect(existsSync(stage.directory)).toBe(false);
    const preserved = readdirSync(rejectedRoot(root))
      .map((name) => join(rejectedRoot(root), name));
    expect(preserved.some((path) => existsSync(join(path, "replacement.bin")))).toBe(true);
    expect(readdirSync(stagingLeaseRoot(root))).toEqual([]);
    await expect(stage.release()).resolves.toBeUndefined();
  });

  it("publishes only through a live branded destination lease", async () => {
    const { root, generations } = fixture(false);
    const lifecycle = authority(root, "process-a");
    const stage = await lifecycle.reserveStage();
    writeFileSync(join(stage.directory, "payload.bin"), "ready");
    const destination = join(generations, "generation-owned");
    const destinationLease = await lifecycle.acquire(destination, {
      purpose: "publication",
      allowMissing: true,
    });
    const forged = {
      generationDirectory: destinationLease.generationDirectory,
      purpose: "publication" as const,
      release: () => Promise.resolve(),
    };
    await authorizeStagePublication(stage);

    await expect(stage.publish(forged)).rejects.toThrow(/not publication-owned/);
    await destinationLease.release();
    await expect(stage.publish(destinationLease)).rejects.toThrow(/no longer active/);
    expect(existsSync(destination)).toBe(false);
    await stage.release();
  });

  it("rejects publication until the owning stage installs a seal capability", async () => {
    const { root, generations } = fixture(false);
    const lifecycle = authority(root, "process-a");
    const stage = await lifecycle.reserveStage();
    const destinationLease = await lifecycle.acquire(join(generations, "unsealed"), {
      purpose: "publication",
      allowMissing: true,
    });

    await expect(stage.publish(destinationLease)).rejects.toThrow(/not sealed/);

    await stage.release();
    await destinationLease.release();
  });

  it("keeps a paused live process and repairs a PID-reused owner without an age heuristic", async () => {
    const { root, generation } = fixture();
    const original = authority(root, "process-a");
    const lease = await original.acquire(generation, { purpose: "publication" });

    const sameProcess = authority(root, "process-a");
    expect(await sameProcess.activeLeaseSnapshot()).toMatchObject({
      activeLeases: 1,
      repairedLeases: 0,
    });

    const reusedPid = authority(root, "process-b");
    expect(await reusedPid.activeLeaseSnapshot()).toMatchObject({
      activeLeases: 0,
      repairedLeases: 1,
    });
    await expect(lease.release()).resolves.toBeUndefined();
  });

  it("fails safe for an unverifiable live PID and repairs it only after process death", async () => {
    const { root, generation } = fixture();
    const live = new GraphGenerationLifecycle({
      cacheRoot: root,
      processIdentity: () => null,
      processAlive: () => true,
    });
    const lease = await live.acquire(generation, { purpose: "cache-read" });
    const restartedLive = new GraphGenerationLifecycle({
      cacheRoot: root,
      processIdentity: () => null,
      processAlive: () => true,
    });
    expect(await restartedLive.activeLeaseSnapshot()).toMatchObject({ activeLeases: 1 });

    const afterDeath = new GraphGenerationLifecycle({
      cacheRoot: root,
      processIdentity: () => null,
      processAlive: () => false,
    });
    expect(await afterDeath.activeLeaseSnapshot()).toMatchObject({
      activeLeases: 0,
      repairedLeases: 1,
    });
    await lease.release();
  });

  it.each([
    {
      label: "marker token mismatch",
      markerToken: "d".repeat(48),
      recordToken: "e".repeat(48),
      generationPath: null,
    },
    {
      label: "non-current generation coordinate",
      markerToken: "f".repeat(48),
      recordToken: "f".repeat(48),
      generationPath: "legacy/generations/forged",
    },
  ])("repairs a forged persisted lease with $label", async ({ markerToken, recordToken, generationPath }) => {
    const { root, generation } = fixture();
    const lifecycle = authority(root, "process-a");
    writeFileSync(join(leaseRoot(root), `${markerToken}.json`), `${JSON.stringify({
      formatVersion: 1,
      token: recordToken,
      pid: process.pid,
      processIdentity: "process-a",
      purpose: "cache-read",
      generationPath: generationPath ?? portable(relative(root, generation)),
      acquiredAtMs: 0,
    })}\n`);

    const snapshot = await lifecycle.activeLeaseSnapshot();

    expect(snapshot).toMatchObject({ activeLeases: 0, repairedLeases: 1 });
    expect([...snapshot.generationPaths]).toEqual([]);
  });

  it("preserves falsy stage-operation errors and aggregates operation plus lease-release failure", async () => {
    const { root, generation } = fixture();
    const lifecycle = new GraphGenerationLifecycle({
      cacheRoot: root,
      processIdentity: () => "process-a",
      processAlive: () => true,
      beforeLeaseReleaseClaim: () => { throw new Error("release failed"); },
    });
    const stage = await lifecycle.reserveStage();
    let stageRejected = false;
    let stageReason: unknown = "not rejected";
    await sealGraphGenerationStage(stage, stage.directory, async () => {
      throw undefined;
    }).then(
      () => undefined,
      (error: unknown) => {
        stageRejected = true;
        stageReason = error;
      },
    );
    expect(stageRejected).toBe(true);
    expect(stageReason).toBeUndefined();
    await stage.release();

    const failure = await lifecycle.withLease(
      generation,
      { purpose: "cache-read" },
      async () => { throw undefined; },
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors[0]).toBeUndefined();
    expect(String((failure as AggregateError).errors[1])).toMatch(/release failed/);
  });

  it("aggregates a falsy stage-operation failure with post-operation ownership loss", async () => {
    const { root } = fixture();
    const lifecycle = authority(root, "process-a");
    const stage = await lifecycle.reserveStage();
    const token = stage.directory.split("stage-").at(-1)!;
    const marker = join(stagingLeaseRoot(root), `${token}.json`);
    const displaced = `${marker}.displaced`;

    const failure = await sealGraphGenerationStage(stage, stage.directory, async () => {
      renameSync(marker, displaced);
      throw undefined;
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors[0]).toBeUndefined();
    expect(String((failure as AggregateError).errors[1])).toMatch(/marker changed/);
    expect(existsSync(displaced)).toBe(true);
  });

  it("quarantines malformed deep leases before asynchronous cleanup", async () => {
    const { root, generation } = fixture();
    const cleanupEntered = deferred<readonly string[]>();
    const resumeCleanup = deferred<void>();
    const lifecycle = new GraphGenerationLifecycle({
      cacheRoot: root,
      processIdentity: () => "process-a",
      processAlive: () => true,
      beforePhysicalCleanup: async (paths) => {
        cleanupEntered.resolve(paths);
        await resumeCleanup.promise;
      },
    });
    let hostile = join(leaseRoot(root), "malformed.json");
    for (let depth = 0; depth < 64; depth += 1) hostile = join(hostile, `level-${depth}`);
    mkdirSync(hostile, { recursive: true });
    for (let index = 0; index < 256; index += 1) {
      writeFileSync(join(hostile, `${index}.bin`), Buffer.alloc(128, index));
    }

    const snapshot = lifecycle.activeLeaseSnapshot();
    const [claim] = await cleanupEntered.promise;
    expect(claim).toContain("graph-generation-lifecycle/v1/quarantine/");
    const overlapping = await lifecycle.acquire(generation, { purpose: "publication" });

    let cleanupFinished = false;
    void snapshot.then(
      () => { cleanupFinished = true; },
      () => { cleanupFinished = true; },
    );
    resumeCleanup.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(cleanupFinished).toBe(false);
    await expect(snapshot).resolves.toMatchObject({ repairedLeases: 1, activeLeases: 0 });
    expect(existsSync(claim!)).toBe(false);
    await overlapping.release();
  });

  it("never deletes a malformed-lease claim replaced after quarantine", async () => {
    const { root } = fixture();
    const cleanupEntered = deferred<readonly string[]>();
    const resumeCleanup = deferred<void>();
    const lifecycle = new GraphGenerationLifecycle({
      cacheRoot: root,
      processIdentity: () => "process-a",
      processAlive: () => true,
      beforePhysicalCleanup: async (paths) => {
        cleanupEntered.resolve(paths);
        await resumeCleanup.promise;
      },
    });
    const malformed = join(leaseRoot(root), "malformed.json");
    mkdirSync(malformed, { mode: 0o700 });
    writeFileSync(join(malformed, "original.bin"), "original");

    const snapshot = lifecycle.activeLeaseSnapshot();
    const [claim] = await cleanupEntered.promise;
    if (!claim) throw new Error("lease reconciliation did not publish a cleanup claim");
    const displaced = `${claim}-displaced`;
    renameSync(claim, displaced);
    mkdirSync(claim, { mode: 0o700 });
    const replacement = join(claim, "replacement.bin");
    writeFileSync(replacement, "replacement");
    resumeCleanup.resolve();

    await expect(snapshot).rejects.toThrow(/claim was replaced/);
    expect(existsSync(join(displaced, "original.bin"))).toBe(true);
    expect(existsSync(replacement)).toBe(true);
  });

  it("memoizes concurrent release and retries after a transient quarantine failure", async () => {
    const { root, generation } = fixture();
    let attempts = 0;
    const lifecycle = new GraphGenerationLifecycle({
      cacheRoot: root,
      processIdentity: () => "process-a",
      processAlive: () => true,
      beforeLeaseReleaseClaim: () => {
        attempts += 1;
        if (attempts === 1) throw new Error("transient quarantine failure");
      },
    });
    const lease = await lifecycle.acquire(generation, { purpose: "cache-read" });

    const first = lease.release();
    const concurrent = lease.release();
    expect(concurrent).toBe(first);
    await expect(first).rejects.toThrow(/transient quarantine failure/);
    expect(await lifecycle.activeLeaseSnapshot()).toMatchObject({ activeLeases: 1 });

    await expect(lease.release()).resolves.toBeUndefined();
    expect(attempts).toBe(2);
    expect(await lifecycle.activeLeaseSnapshot()).toMatchObject({ activeLeases: 0 });
    await expect(lease.release()).resolves.toBeUndefined();
  });

  it("retries release cleanup after a transient physical failure", async () => {
    const { root, generation } = fixture();
    let cleanupAttempts = 0;
    const lifecycle = new GraphGenerationLifecycle({
      cacheRoot: root,
      processIdentity: () => "process-a",
      processAlive: () => true,
      beforePhysicalCleanup: async () => {
        cleanupAttempts += 1;
        if (cleanupAttempts === 1) throw new Error("transient lease cleanup failure");
      },
    });
    const lease = await lifecycle.acquire(generation, { purpose: "cache-read" });

    await expect(lease.release()).rejects.toThrow(/transient lease cleanup failure/);
    await expect(lease.release()).resolves.toBeUndefined();
    expect(cleanupAttempts).toBe(2);
    expect(await lifecycle.activeLeaseSnapshot()).toMatchObject({ activeLeases: 0 });
  });

  it("rejects outside paths, missing reads, and symlinked generation roots", async () => {
    const { root, generations } = fixture(false);
    const outside = temporaryRoot();
    const outsideGeneration = join(outside, "generation");
    mkdirSync(outsideGeneration, { mode: 0o700 });
    const lifecycle = authority(root, "process-a");

    await expect(lifecycle.acquire(outsideGeneration, { purpose: "cache-read" }))
      .rejects.toThrow(/escaped/);
    await expect(lifecycle.acquire(join(generations, "missing"), { purpose: "cache-read" }))
      .rejects.toThrow(/unavailable/);

    const link = join(generations, "linked");
    symlinkSync(outsideGeneration, link);
    await expect(lifecycle.acquire(link, { purpose: "cache-read" }))
      .rejects.toThrow(/unsafe/);
  });
});

function fixture(withGeneration = true): { root: string; generations: string; generation: string } {
  const root = temporaryRoot();
  const entry = repositoryArtifactEntry(root, REPOSITORY_KEY, COMMIT, ANALYSIS_KEY);
  const generation = finalizedGenerationDirectory(entry, "generation-one");
  const generations = join(generation, "..");
  mkdirSync(generations, { recursive: true, mode: 0o700 });
  if (withGeneration) mkdirSync(generation, { mode: 0o700 });
  return { root, generations, generation };
}

function authority(root: string, identity: string): GraphGenerationLifecycle {
  return new GraphGenerationLifecycle({
    cacheRoot: root,
    processIdentity: () => identity,
    processAlive: () => true,
  });
}

async function authorizeStagePublication(stage: GraphGenerationStage): Promise<void> {
  await sealGraphGenerationStage(stage, stage.directory, () => ({
    value: undefined,
    publicationSeal: Object.freeze({ assertCurrent: () => undefined }),
  }));
}

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "meridian-generation-lifecycle-"));
  roots.push(root);
  return root;
}

function portable(path: string): string {
  return path.split(sep).join("/");
}

function leaseRoot(root: string): string {
  return join(root, "graph-generation-lifecycle", "v1", "leases");
}

function stagingLeaseRoot(root: string): string {
  return join(root, "graph-generation-lifecycle", "v1", "staging-leases");
}

function rejectedRoot(root: string): string {
  return join(root, "graph-generation-lifecycle", "v1", "rejected");
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(...args: T extends void ? [] : [value: T]): void;
} {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolve) => { resolvePromise = resolve; });
  return {
    promise,
    resolve: (...args) => resolvePromise(args[0] as T),
  };
}
