import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CacheRootLifecycleLock } from "./cache-root-lifecycle-lock";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("CacheRootLifecycleLock", () => {
  it("serializes independent instances while remaining reentrant in the owning call chain", async () => {
    const root = temporaryRoot();
    const firstLock = new CacheRootLifecycleLock(root);
    const secondLock = new CacheRootLifecycleLock(root);
    const firstEntered = deferred<void>();
    const releaseFirst = deferred<void>();
    let secondEntered = false;

    const first = firstLock.runExclusive(async () => {
      await firstLock.runExclusive(() => firstEntered.resolve());
      await releaseFirst.promise;
    });
    await firstEntered.promise;
    const second = secondLock.runExclusive(() => { secondEntered = true; });
    await delay(40);
    expect(secondEntered).toBe(false);

    releaseFirst.resolve();
    await Promise.all([first, second]);
    expect(secondEntered).toBe(true);
  });

  it("does not let a detached child reuse an AsyncLocalStorage token after release", async () => {
    const root = temporaryRoot();
    const inherited = new CacheRootLifecycleLock(root);
    const competing = new CacheRootLifecycleLock(root);
    const startDetached = deferred<void>();
    const detachedDone = deferred<void>();
    let detachedEntered = false;

    await inherited.runExclusive(() => {
      void (async () => {
        await startDetached.promise;
        await inherited.runExclusive(() => { detachedEntered = true; });
        detachedDone.resolve();
      })();
    });

    const competitorEntered = deferred<void>();
    const releaseCompetitor = deferred<void>();
    const competitor = competing.runExclusive(async () => {
      competitorEntered.resolve();
      await releaseCompetitor.promise;
    });
    await competitorEntered.promise;
    startDetached.resolve();
    await delay(40);
    expect(detachedEntered).toBe(false);

    releaseCompetitor.resolve();
    await Promise.all([competitor, detachedDone.promise]);
    expect(detachedEntered).toBe(true);
  });

  it("quarantines a deep hostile release tree before asynchronous cleanup", async () => {
    const root = temporaryRoot();
    const cleanupEntered = deferred<readonly string[]>();
    const resumeCleanup = deferred<void>();
    const owner = new CacheRootLifecycleLock(root, {
      beforePhysicalCleanup: async (paths) => {
        cleanupEntered.resolve(paths);
        await resumeCleanup.promise;
      },
    });
    let deepest = join(root, ".graph-capability-lifecycle.lock", "hostile");
    const holding = owner.runExclusive(() => {
      for (let depth = 0; depth < 64; depth += 1) deepest = join(deepest, `level-${depth}`);
      mkdirSync(deepest, { recursive: true });
      for (let index = 0; index < 256; index += 1) {
        writeFileSync(join(deepest, `${index}.bin`), Buffer.alloc(128, index));
      }
    });
    const [claim] = await cleanupEntered.promise;
    expect(claim).toContain(".graph-capability-lifecycle.lock.release-");

    // The lock path is free as soon as it is atomically quarantined; recursive deletion must not
    // hold admission for the next independent request.
    let competitorEntered = false;
    await new CacheRootLifecycleLock(root).runExclusive(() => { competitorEntered = true; });
    expect(competitorEntered).toBe(true);

    let cleanupFinished = false;
    void holding.then(
      () => { cleanupFinished = true; },
      () => { cleanupFinished = true; },
    );
    resumeCleanup.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(cleanupFinished).toBe(false);
    await holding;
    expect(existsSync(claim!)).toBe(false);
  });

  it("never deletes a release claim replaced after atomic quarantine", async () => {
    const root = temporaryRoot();
    const cleanupEntered = deferred<readonly string[]>();
    const resumeCleanup = deferred<void>();
    const owner = new CacheRootLifecycleLock(root, {
      beforePhysicalCleanup: async (paths) => {
        cleanupEntered.resolve(paths);
        await resumeCleanup.promise;
      },
    });

    const holding = owner.runExclusive(() => undefined);
    const [claim] = await cleanupEntered.promise;
    if (!claim) throw new Error("lock release did not publish a cleanup claim");
    const displaced = `${claim}-displaced`;
    renameSync(claim, displaced);
    mkdirSync(claim, { mode: 0o700 });
    const replacement = join(claim, "replacement.bin");
    writeFileSync(replacement, "replacement");
    resumeCleanup.resolve();

    await expect(holding).rejects.toThrow(/claim was replaced/);
    expect(existsSync(join(displaced, "owner.json"))).toBe(true);
    expect(existsSync(replacement)).toBe(false);
    const rejected = readdirSync(join(root, ".graph-capability-lifecycle-cleanup"))
      .find((name) => name.includes(".rejected-"));
    expect(rejected).toBeDefined();
    expect(existsSync(join(root, ".graph-capability-lifecycle-cleanup", rejected!, "replacement.bin")))
      .toBe(true);
  });

  it("revalidates token and exact lock identities before release quarantine", async () => {
    const root = temporaryRoot();
    const canonical = join(root, ".graph-capability-lifecycle.lock");
    const displaced = `${canonical}.displaced`;
    const lock = new CacheRootLifecycleLock(root, {
      beforeReleaseClaim: (path) => {
        renameSync(path, displaced);
        mkdirSync(path, { mode: 0o700 });
        // Copying the exact owner token is insufficient: the lock and owner inodes are different.
        writeFileSync(join(path, "owner.json"), readFileSync(join(displaced, "owner.json")));
      },
    });

    await expect(lock.runExclusive(() => "complete"))
      .rejects.toThrow(/ownership changed before release quarantine/);
    expect(existsSync(join(canonical, "owner.json"))).toBe(true);
    expect(existsSync(join(displaced, "owner.json"))).toBe(true);
  });

  it("atomically quarantines and asynchronously removes a failed acquisition rollback", async () => {
    const root = temporaryRoot();
    let injected = false;
    const cleanupPaths: string[] = [];
    const lock = new CacheRootLifecycleLock(root, {
      beforeOwnerWrite: (path) => {
        if (injected) return;
        injected = true;
        const hostile = join(path, "partial", "deep");
        mkdirSync(hostile, { recursive: true });
        writeFileSync(join(hostile, "payload.bin"), "partial");
        throw new Error("injected owner write failure");
      },
      beforePhysicalCleanup: async (paths) => { cleanupPaths.push(...paths); },
    });

    await expect(lock.runExclusive(() => undefined)).rejects.toThrow(/injected owner write failure/);
    expect(cleanupPaths).toHaveLength(1);
    expect(cleanupPaths[0]).toContain(".graph-capability-lifecycle.lock.rollback-");
    expect(existsSync(join(root, ".graph-capability-lifecycle.lock"))).toBe(false);
    await expect(new CacheRootLifecycleLock(root).runExclusive(() => "ready")).resolves.toBe("ready");
  });

  it("does not roll back a same-path replacement after owner-write failure", async () => {
    const root = temporaryRoot();
    const canonical = join(root, ".graph-capability-lifecycle.lock");
    const displaced = `${canonical}.created-displaced`;
    const replacement = join(canonical, "replacement.bin");
    const lock = new CacheRootLifecycleLock(root, {
      beforeOwnerWrite: (path) => {
        renameSync(path, displaced);
        mkdirSync(path, { mode: 0o700 });
        writeFileSync(replacement, "replacement");
        throw new Error("injected owner write failure after replacement");
      },
    });

    const failure = await lock.runExclusive(() => undefined).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors.map(String).join("\n"))
      .toMatch(/acquisition path was replaced before rollback/);
    expect(existsSync(displaced)).toBe(true);
    expect(existsSync(replacement)).toBe(true);
  });

  it("retries a quarantined release cleanup after a transient physical failure", async () => {
    const root = temporaryRoot();
    let cleanupAttempts = 0;
    let operations = 0;
    const lock = new CacheRootLifecycleLock(root, {
      beforePhysicalCleanup: async () => {
        cleanupAttempts += 1;
        if (cleanupAttempts === 1) throw new Error("transient physical cleanup failure");
      },
    });

    await expect(lock.runExclusive(() => {
      operations += 1;
      return "first";
    })).rejects.toThrow(/transient physical cleanup failure/);
    expect(operations).toBe(1);

    await expect(lock.runExclusive(() => {
      operations += 1;
      return "second";
    })).resolves.toBe("second");
    expect(operations).toBe(2);
    expect(cleanupAttempts).toBe(3);
  });

  it("recovers durable cleanup residue with a new lifecycle instance after restart", async () => {
    const root = temporaryRoot();
    let abandonedPath = "";
    const crashed = new CacheRootLifecycleLock(root, {
      beforePhysicalCleanup: async ([path]) => {
        abandonedPath = path ?? "";
        throw new Error("simulated process exit before physical cleanup");
      },
    });
    await expect(crashed.runExclusive(() => "published"))
      .rejects.toThrow(/simulated process exit/);
    expect(abandonedPath).not.toBe("");
    expect(existsSync(abandonedPath)).toBe(true);

    const recovered: string[] = [];
    await new CacheRootLifecycleLock(root, {
      beforePhysicalCleanup: async (paths) => { recovered.push(...paths); },
    }).runExclusive(() => "next process");

    expect(recovered.some((path) => path.includes(".residue-"))).toBe(true);
    expect(existsSync(abandonedPath)).toBe(false);
  });

  it("retries durable residue concurrently without delaying canonical admission", async () => {
    const root = temporaryRoot();
    let abandonedPath = "";
    await expect(new CacheRootLifecycleLock(root, {
      beforePhysicalCleanup: async ([path]) => {
        abandonedPath = path ?? "";
        throw new Error("transient cleanup failure");
      },
    }).runExclusive(() => undefined)).rejects.toThrow(/transient cleanup failure/);

    const retryEntered = deferred<void>();
    const resumeRetry = deferred<void>();
    const operationEntered = deferred<void>();
    const finishOperation = deferred<void>();
    let retriedPath = "";
    const retrying = new CacheRootLifecycleLock(root, {
      beforePhysicalCleanup: async ([path]) => {
        if (!path?.includes(".residue-")) return;
        retriedPath = path;
        retryEntered.resolve();
        await resumeRetry.promise;
      },
    }).runExclusive(async () => {
      operationEntered.resolve();
      await finishOperation.promise;
    });

    await retryEntered.promise;
    await operationEntered.promise;
    expect(existsSync(join(root, ".graph-capability-lifecycle.lock"))).toBe(true);
    resumeRetry.resolve();
    finishOperation.resolve();
    await retrying;
    expect(existsSync(abandonedPath)).toBe(false);
    expect(retriedPath).not.toBe(abandonedPath);
  });

  it("gives exactly one instance atomic cleanup authority for concurrent residue recovery", async () => {
    const root = temporaryRoot();
    let abandonedPath = "";
    await expect(new CacheRootLifecycleLock(root, {
      beforePhysicalCleanup: async ([path]) => {
        abandonedPath = path ?? "";
        throw new Error("leave one durable release residue");
      },
    }).runExclusive(() => undefined)).rejects.toThrow(/leave one durable release residue/);

    const bothScanned = deferred<void>();
    const allowClaims = deferred<void>();
    let scanners = 0;
    const claimedResidue: string[] = [];
    const options = {
      beforeResidueClaim: async (paths: readonly string[]) => {
        expect(paths).toContain(abandonedPath);
        scanners += 1;
        if (scanners === 2) bothScanned.resolve();
        await allowClaims.promise;
      },
      beforePhysicalCleanup: async ([path]: readonly string[]) => {
        if (path?.includes(".residue-")) claimedResidue.push(path);
      },
    };
    const first = new CacheRootLifecycleLock(root, options).runExclusive(() => "first");
    const second = new CacheRootLifecycleLock(root, options).runExclusive(() => "second");
    await bothScanned.promise;
    allowClaims.resolve();

    await expect(Promise.all([first, second])).resolves.toEqual(["first", "second"]);
    expect(claimedResidue).toHaveLength(1);
    expect(existsSync(abandonedPath)).toBe(false);
  });

  it("accepts a missing old claim as an atomic cross-process cleanup handoff", async () => {
    const root = temporaryRoot();
    let handedOff = "";
    const owner = new CacheRootLifecycleLock(root, {
      beforePhysicalCleanup: async ([path]) => {
        if (!path?.includes(".release-") || handedOff) return;
        handedOff = join(
          root,
          ".graph-capability-lifecycle-cleanup",
          `.graph-capability-lifecycle.lock.residue-${"a".repeat(24)}`,
        );
        renameSync(path, handedOff);
        throw new Error("old scanner lost its path after a physical-cleanup failure");
      },
    });

    await expect(owner.runExclusive(() => "handed off")).resolves.toBe("handed off");
    expect(existsSync(handedOff)).toBe(true);
    await expect(new CacheRootLifecycleLock(root).runExclusive(() => "recovered"))
      .resolves.toBe("recovered");
    expect(existsSync(handedOff)).toBe(false);
  });

  it("never steals an old lock whose owner process is still alive", async () => {
    const root = temporaryRoot();
    const owner = new CacheRootLifecycleLock(root, { staleMs: 1 });
    const contender = new CacheRootLifecycleLock(root, { staleMs: 1 });
    const entered = deferred<void>();
    const release = deferred<void>();
    const holding = owner.runExclusive(async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    await delay(10);

    const controller = new AbortController();
    const reason = new Error("stop waiting");
    const timeout = setTimeout(() => controller.abort(reason), 40);
    await expect(contender.runExclusive(() => undefined, controller.signal)).rejects.toBe(reason);
    clearTimeout(timeout);
    release.resolve();
    await holding;
  });

  it("fails bounded acquisition instead of waiting forever behind a paused live owner", async () => {
    const root = temporaryRoot();
    const identity = () => "same-boot-and-process-start";
    const owner = new CacheRootLifecycleLock(root, {
      staleMs: 1,
      acquireTimeoutMs: 1_000,
      processIdentity: identity,
    });
    const contender = new CacheRootLifecycleLock(root, {
      staleMs: 1,
      acquireTimeoutMs: 35,
      processIdentity: identity,
    });
    const entered = deferred<void>();
    const release = deferred<void>();
    const holding = owner.runExclusive(async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    await delay(5);

    await expect(contender.runExclusive(() => undefined)).rejects.toThrow(/timed out acquiring/);
    release.resolve();
    await holding;
  });

  it("reclaims a stale lock when a live PID has a different process-start identity", async () => {
    const root = temporaryRoot();
    const path = join(root, ".graph-capability-lifecycle.lock");
    mkdirSync(path, { mode: 0o700 });
    writeFileSync(join(path, "owner.json"), `${JSON.stringify({
      token: "previous-process",
      pid: process.pid,
      processIdentity: "previous-boot-and-start",
      acquiredAtMs: 1,
    })}\n`, { mode: 0o600 });
    const old = new Date(1_000);
    utimesSync(path, old, old);

    let entered = false;
    await new CacheRootLifecycleLock(root, {
      staleMs: 1,
      processIdentity: () => "current-boot-and-start",
    }).runExclusive(() => { entered = true; });
    expect(entered).toBe(true);
  });

  it("never steals a live lock whose stored process identity is missing or unverifiable", async () => {
    for (const storedIdentity of [undefined, `unverifiable:${process.pid}:transient-failure`]) {
      const root = temporaryRoot();
      const path = join(root, ".graph-capability-lifecycle.lock");
      mkdirSync(path, { mode: 0o700 });
      writeFileSync(join(path, "owner.json"), `${JSON.stringify({
        token: `live-${storedIdentity ?? "legacy"}`,
        pid: process.pid,
        ...(storedIdentity ? { processIdentity: storedIdentity } : {}),
        acquiredAtMs: 1,
      })}\n`, { mode: 0o600 });
      const old = new Date(1_000);
      utimesSync(path, old, old);

      const contender = new CacheRootLifecycleLock(root, {
        staleMs: 1,
        acquireTimeoutMs: 35,
        processIdentity: () => "verifiable-current-start",
      });
      await expect(contender.runExclusive(() => undefined)).rejects.toThrow(/timed out acquiring/);
    }
  });

  it("recovers an unchanged stale lock left by a dead process", async () => {
    const root = temporaryRoot();
    const path = join(root, ".graph-capability-lifecycle.lock");
    mkdirSync(path, { mode: 0o700 });
    writeFileSync(join(path, "owner.json"), `${JSON.stringify({
      token: "dead-owner",
      pid: 2_147_483_647,
      acquiredAtMs: 1,
    })}\n`, { mode: 0o600 });
    const old = new Date(1_000);
    utimesSync(path, old, old);

    let entered = false;
    await new CacheRootLifecycleLock(root, { staleMs: 1 }).runExclusive(() => { entered = true; });
    expect(entered).toBe(true);
  });

  it("never deletes a same-path replacement raced after the final stale observation", async () => {
    const root = temporaryRoot();
    const path = join(root, ".graph-capability-lifecycle.lock");
    const displaced = `${path}.displaced`;
    mkdirSync(path, { mode: 0o700 });
    writeFileSync(join(path, "owner.json"), `${JSON.stringify({
      token: "dead-owner",
      pid: 2_147_483_647,
      acquiredAtMs: 1,
    })}\n`, { mode: 0o600 });
    const old = new Date(1_000);
    utimesSync(path, old, old);
    const ownerBytes = readFileSync(join(path, "owner.json"));

    const contender = new CacheRootLifecycleLock(root, {
      staleMs: 1,
      beforeStaleQuarantine: (canonical) => {
        renameSync(canonical, displaced);
        mkdirSync(canonical, { mode: 0o700 });
        writeFileSync(join(canonical, "owner.json"), ownerBytes);
        utimesSync(canonical, old, old);
      },
    });
    await expect(contender.runExclusive(() => undefined))
      .rejects.toThrow(/stale quarantine changed the final observed lock identity/);

    expect(existsSync(join(displaced, "owner.json"))).toBe(true);
    const cleanupRoot = join(root, ".graph-capability-lifecycle-cleanup");
    const quarantined = readdirSync(cleanupRoot).map((name) => join(cleanupRoot, name));
    expect(quarantined).toHaveLength(1);
    expect(existsSync(join(quarantined[0]!, "owner.json"))).toBe(true);
  });

  it("frees stale-lock admission before deleting a hostile stale tree", async () => {
    const root = temporaryRoot();
    const path = join(root, ".graph-capability-lifecycle.lock");
    let hostile = join(path, "hostile");
    for (let depth = 0; depth < 32; depth += 1) hostile = join(hostile, `level-${depth}`);
    mkdirSync(hostile, { recursive: true, mode: 0o700 });
    writeFileSync(join(path, "owner.json"), `${JSON.stringify({
      token: "dead-owner",
      pid: 2_147_483_647,
      acquiredAtMs: 1,
    })}\n`, { mode: 0o600 });
    writeFileSync(join(hostile, "payload.bin"), "stale");
    const old = new Date(1_000);
    utimesSync(path, old, old);
    const cleanupEntered = deferred<readonly string[]>();
    const resumeCleanup = deferred<void>();
    const reclaiming = new CacheRootLifecycleLock(root, {
      staleMs: 1,
      beforePhysicalCleanup: async (paths) => {
        cleanupEntered.resolve(paths);
        await resumeCleanup.promise;
      },
    }).runExclusive(() => "reclaimed");
    await cleanupEntered.promise;

    // The stale directory was already renamed; another instance can use the canonical lock path.
    await expect(new CacheRootLifecycleLock(root).runExclusive(() => "overlap"))
      .resolves.toBe("overlap");
    resumeCleanup.resolve();
    await expect(reclaiming).resolves.toBe("reclaimed");
  });
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "meridian-lifecycle-lock-"));
  roots.push(root);
  return root;
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
