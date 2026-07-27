import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TypeScriptRevisionShardBuildLockOwnershipLostError,
  tryWithTypeScriptRevisionShardBuildLock,
  withTypeScriptRevisionShardBuildLock,
} from "./web-typescript-revision-shard-lock";

const roots: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("TypeScript revision-shard build lock", () => {
  it("serializes callers and publishes only private host/PID/nonce ownership", async () => {
    const root = temporaryDirectory();
    const firstStarted = deferred<AbortSignal>();
    const releaseFirst = deferred<void>();
    const order: string[] = [];
    const first = withTypeScriptRevisionShardBuildLock(root, undefined, async (signal) => {
      order.push("first-enter");
      firstStarted.resolve(signal);
      await releaseFirst.promise;
      order.push("first-exit");
      return "first";
    });
    await firstStarted.promise;

    const ownerPath = lockOwnerPath(root);
    const owner = JSON.parse(readFileSync(ownerPath, "utf8")) as Record<string, unknown>;
    expect(owner).toMatchObject({
      formatVersion: 1,
      host: hostname(),
      pid: process.pid,
      processStartedAtMs: expect.any(Number),
    });
    expect(owner.nonce).toMatch(/^[0-9a-f-]{36}$/);
    expect(lstatSync(ownerPath).mode & 0o777).toBe(0o600);
    expect(lstatSync(lockDirectory(root)).mode & 0o777).toBe(0o700);
    expect(lstatSync(locksRoot(root)).mode & 0o777).toBe(0o700);

    let secondEntered = false;
    const second = withTypeScriptRevisionShardBuildLock(root, undefined, () => {
      secondEntered = true;
      order.push("second-enter");
      return "second";
    });
    await delay(20);
    expect(secondEntered).toBe(false);

    releaseFirst.resolve();
    await expect(first).resolves.toBe("first");
    await expect(second).resolves.toBe("second");
    expect(order).toEqual(["first-enter", "first-exit", "second-enter"]);
    expect(existsSync(lockDirectory(root))).toBe(false);
  });

  it("aborts a contending waiter without disturbing the current owner", async () => {
    const root = temporaryDirectory();
    const firstStarted = deferred<void>();
    const releaseFirst = deferred<void>();
    const first = withTypeScriptRevisionShardBuildLock(root, undefined, async () => {
      firstStarted.resolve();
      await releaseFirst.promise;
    });
    await firstStarted.promise;
    const originalOwner = readFileSync(lockOwnerPath(root), "utf8");

    const controller = new AbortController();
    let entered = false;
    const waiting = withTypeScriptRevisionShardBuildLock(root, controller.signal, () => {
      entered = true;
    });
    await delay(20);
    const cancellation = new Error("stop waiting");
    controller.abort(cancellation);

    await expect(waiting).rejects.toBe(cancellation);
    expect(entered).toBe(false);
    expect(readFileSync(lockOwnerPath(root), "utf8")).toBe(originalOwner);
    releaseFirst.resolve();
    await first;
  });

  it("lets background maintenance skip an active build without queueing", async () => {
    const root = temporaryDirectory();
    const started = deferred<void>();
    const release = deferred<void>();
    const active = withTypeScriptRevisionShardBuildLock(root, undefined, async () => {
      started.resolve();
      await release.promise;
    });
    await started.promise;
    let entered = false;

    await expect(tryWithTypeScriptRevisionShardBuildLock(
      root,
      undefined,
      () => { entered = true; },
    )).resolves.toBeUndefined();
    expect(entered).toBe(false);

    release.resolve();
    await active;
  });

  it("recovers a fresh lock immediately after its local owner is proven dead", async () => {
    const root = temporaryDirectory();
    await withTypeScriptRevisionShardBuildLock(root, undefined, () => undefined);
    createLock(root, {
      formatVersion: 1,
      host: hostname(),
      nonce: randomUUID(),
      pid: deadPid(),
      processStartedAtMs: 0,
    });

    let entered = false;
    await withTypeScriptRevisionShardBuildLock(root, undefined, () => {
      entered = true;
    });

    expect(entered).toBe(true);
    expect(existsSync(lockDirectory(root))).toBe(false);
  });

  it("recovers a prior incarnation that reused this process PID", async () => {
    const root = temporaryDirectory();
    let ownerTemplate!: Record<string, unknown>;
    await withTypeScriptRevisionShardBuildLock(root, undefined, () => {
      ownerTemplate = JSON.parse(
        readFileSync(lockOwnerPath(root), "utf8"),
      ) as Record<string, unknown>;
    });
    createLock(root, {
      ...ownerTemplate,
      nonce: randomUUID(),
      processStartedAtMs: Number(ownerTemplate.processStartedAtMs) + 1,
    });

    let entered = false;
    await withTypeScriptRevisionShardBuildLock(root, undefined, () => {
      entered = true;
    });

    expect(entered).toBe(true);
    expect(existsSync(lockDirectory(root))).toBe(false);
  });

  it("never steals a stale lock from a PID that is still alive", async () => {
    const root = temporaryDirectory();
    let ownerTemplate!: Record<string, unknown>;
    await withTypeScriptRevisionShardBuildLock(root, undefined, () => {
      ownerTemplate = JSON.parse(
        readFileSync(lockOwnerPath(root), "utf8"),
      ) as Record<string, unknown>;
    });
    const liveOwner = {
      ...ownerTemplate,
      nonce: randomUUID(),
    };
    createLock(root, liveOwner);
    ageLock(root);

    let entered = false;
    const waiting = withTypeScriptRevisionShardBuildLock(root, undefined, () => {
      entered = true;
    });
    await expect(waiting).rejects.toThrow(/owner is unresponsive/);

    expect(entered).toBe(false);
    expect(JSON.parse(readFileSync(lockOwnerPath(root), "utf8"))).toEqual(liveOwner);
  });

  it("treats another live PID with unknown incarnation as a conservative reuse ambiguity", async () => {
    const root = temporaryDirectory();
    await withTypeScriptRevisionShardBuildLock(root, undefined, () => undefined);
    const ambiguousOwner = {
      formatVersion: 1,
      host: hostname(),
      nonce: randomUUID(),
      pid: process.ppid,
      processStartedAtMs: 0,
    };
    createLock(root, ambiguousOwner);
    ageLock(root);

    let entered = false;
    await expect(withTypeScriptRevisionShardBuildLock(root, undefined, () => {
      entered = true;
    })).rejects.toThrow(/owner is unresponsive/);

    expect(entered).toBe(false);
    expect(JSON.parse(readFileSync(lockOwnerPath(root), "utf8"))).toEqual(ambiguousOwner);
  });

  it("revalidates the exact generation after a delayed stale observation", async () => {
    const root = temporaryDirectory();
    await withTypeScriptRevisionShardBuildLock(root, undefined, () => undefined);
    createLock(root, {
      formatVersion: 1,
      host: hostname(),
      nonce: randomUUID(),
      pid: deadPid(),
      processStartedAtMs: 0,
    });
    ageLock(root);

    const observed = deferred<void>();
    const claimEstablished = deferred<void>();
    const resumeReclaimer = deferred<void>();
    let delayedEntered = false;
    const delayed = withTypeScriptRevisionShardBuildLock(
      root,
      undefined,
      () => {
        delayedEntered = true;
      },
      {
        afterRecoverableObservation: async () => {
          observed.resolve();
          await resumeReclaimer.promise;
        },
        afterRecoveryClaimEstablished: () => claimEstablished.resolve(),
      },
    );
    await observed.promise;

    rmSync(lockDirectory(root), { recursive: true });
    const replacementStarted = deferred<void>();
    const releaseReplacement = deferred<void>();
    const replacement = withTypeScriptRevisionShardBuildLock(root, undefined, async () => {
      replacementStarted.resolve();
      await releaseReplacement.promise;
    });
    await replacementStarted.promise;
    const replacementOwner = readFileSync(lockOwnerPath(root), "utf8");

    resumeReclaimer.resolve();
    await claimEstablished.promise;
    expect(delayedEntered).toBe(false);
    expect(readFileSync(lockOwnerPath(root), "utf8")).toBe(replacementOwner);

    releaseReplacement.resolve();
    await replacement;
    await delayed;
    expect(delayedEntered).toBe(true);
  });

  it("leaves an abandoned recovery claim fenced for explicit repair", async () => {
    const root = temporaryDirectory();
    await withTypeScriptRevisionShardBuildLock(root, undefined, () => undefined);
    const claim = {
      formatVersion: 1,
      host: hostname(),
      kind: "recovery-claim",
      nonce: randomUUID(),
      pid: deadPid(),
      processStartedAtMs: 0,
    };
    writeFileSync(recoveryClaimPath(root), `${JSON.stringify(claim)}\n`, {
      flag: "wx",
      mode: 0o600,
    });

    let entered = false;
    await expect(withTypeScriptRevisionShardBuildLock(root, undefined, () => {
      entered = true;
    })).rejects.toThrow(/manual cache repair/);

    expect(entered).toBe(false);
    expect(JSON.parse(readFileSync(recoveryClaimPath(root), "utf8"))).toEqual(claim);
    expect(existsSync(lockDirectory(root))).toBe(false);
  });

  it("honors a recovery claim that appears after owner establishment", async () => {
    const root = temporaryDirectory();
    const ownerEstablished = deferred<void>();
    const resume = deferred<void>();
    let entered = false;
    const operation = withTypeScriptRevisionShardBuildLock(
      root,
      undefined,
      () => {
        entered = true;
      },
      {
        afterOwnerEstablished: async () => {
          ownerEstablished.resolve();
          await resume.promise;
        },
      },
    );
    void operation.catch(() => undefined);
    await ownerEstablished.promise;

    const claim = {
      formatVersion: 1,
      host: hostname(),
      kind: "recovery-claim",
      nonce: randomUUID(),
      pid: deadPid(),
      processStartedAtMs: 0,
    };
    writeFileSync(recoveryClaimPath(root), `${JSON.stringify(claim)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    resume.resolve();

    await expect(operation).rejects.toThrow(/manual cache repair/);
    expect(entered).toBe(false);
    expect(existsSync(lockDirectory(root))).toBe(false);
    expect(JSON.parse(readFileSync(recoveryClaimPath(root), "utf8"))).toEqual(claim);
  });

  it("fences in-flight work and leaves a replacement owner intact", async () => {
    vi.useFakeTimers();
    const root = temporaryDirectory();
    const started = deferred<AbortSignal>();
    const operation = withTypeScriptRevisionShardBuildLock(root, undefined, async (signal) => {
      started.resolve(signal);
      await rejectWhenAborted(signal);
      return "unreachable";
    });
    void operation.catch(() => undefined);
    const workSignal = await started.promise;
    const replacement = {
      ...(JSON.parse(readFileSync(lockOwnerPath(root), "utf8")) as Record<string, unknown>),
      nonce: randomUUID(),
    };
    writeFileSync(lockOwnerPath(root), `${JSON.stringify(replacement)}\n`, { mode: 0o600 });

    await vi.advanceTimersByTimeAsync(30_000);
    await expect(operation).rejects.toBeInstanceOf(
      TypeScriptRevisionShardBuildLockOwnershipLostError,
    );
    expect(workSignal.reason).toBeInstanceOf(
      TypeScriptRevisionShardBuildLockOwnershipLostError,
    );
    expect(existsSync(lockDirectory(root))).toBe(true);
    expect(JSON.parse(readFileSync(lockOwnerPath(root), "utf8"))).toEqual(replacement);
  });

  it("fails closed for symlinked lock topology without touching the target", async () => {
    const root = temporaryDirectory();
    const shardRoot = join(root, "typescript-revision-shards-v1");
    const outside = join(root, "outside");
    mkdirSync(shardRoot, { mode: 0o700 });
    mkdirSync(outside, { mode: 0o700 });
    symlinkSync(outside, locksRoot(root));

    await expect(
      withTypeScriptRevisionShardBuildLock(root, undefined, () => undefined),
    ).rejects.toThrow(/not a real directory/);
    expect(lstatSync(outside).isDirectory()).toBe(true);
  });

  it("never follows a symlinked owner file", async () => {
    const root = temporaryDirectory();
    await withTypeScriptRevisionShardBuildLock(root, undefined, () => undefined);
    mkdirSync(lockDirectory(root), { mode: 0o700 });
    const outside = join(root, "outside-owner.json");
    const outsideContents = "{\"doNotTouch\":true}\n";
    writeFileSync(outside, outsideContents, { mode: 0o600 });
    symlinkSync(outside, lockOwnerPath(root));

    await expect(
      withTypeScriptRevisionShardBuildLock(root, undefined, () => undefined),
    ).rejects.toThrow();
    expect(readFileSync(outside, "utf8")).toBe(outsideContents);
    expect(lstatSync(lockOwnerPath(root)).isSymbolicLink()).toBe(true);
  });

  it("rejects a lock store marked for another host", async () => {
    const root = temporaryDirectory();
    mkdirSync(join(root, "typescript-revision-shards-v1"), { mode: 0o700 });
    mkdirSync(locksRoot(root), { mode: 0o700 });
    writeFileSync(join(locksRoot(root), "host-v1.json"), JSON.stringify({
      formatVersion: 1,
      host: `not-${hostname()}`,
    }), { mode: 0o600 });

    await expect(
      withTypeScriptRevisionShardBuildLock(root, undefined, () => undefined),
    ).rejects.toThrow(/host-local cache/);
  });
});

function temporaryDirectory(): string {
  const root = mkdtempSync(join(tmpdir(), "meridian-shard-build-lock-"));
  roots.push(root);
  return root;
}

function locksRoot(root: string): string {
  return join(root, "typescript-revision-shards-v1", "build-locks-v1");
}

function lockDirectory(root: string): string {
  return join(locksRoot(root), "global.lock");
}

function lockOwnerPath(root: string): string {
  return join(lockDirectory(root), "owner.json");
}

function recoveryClaimPath(root: string): string {
  return join(locksRoot(root), "global.recovery.json");
}

function createLock(root: string, owner: Record<string, unknown>): void {
  mkdirSync(lockDirectory(root), { mode: 0o700 });
  writeFileSync(lockOwnerPath(root), `${JSON.stringify(owner)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
}

function ageLock(root: string): void {
  const stale = new Date(Date.now() - 16 * 60_000);
  utimesSync(lockOwnerPath(root), stale, stale);
  utimesSync(lockDirectory(root), stale, stale);
}

function deadPid(): number {
  for (const pid of [process.pid + 1_000_000, 2_147_483_647]) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (
        typeof error === "object"
        && error !== null
        && "code" in error
        && error.code === "ESRCH"
      ) {
        return pid;
      }
    }
  }
  throw new Error("could not find a dead PID for the lock test");
}

function rejectWhenAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function deferred<Value>() {
  let resolve!: (value: Value | PromiseLike<Value>) => void;
  const promise = new Promise<Value>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
