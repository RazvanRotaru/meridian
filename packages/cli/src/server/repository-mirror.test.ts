import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseRepositoryMirrorSourceRoot,
  RepositoryMirrorStore,
  type PrepareRepositoryWorktree,
  type RepositoryGitLineRunner,
  type RepositoryGitOptions,
  type RepositoryGitRunner,
} from "./repository-mirror";
import { claimPathForCleanup } from "./claimed-path-cleanup";
import { cacheEntryIdentityDigest } from "./web-cache-storage";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const OTHER = "c".repeat(40);
const HEAD_REF = "refs/pull/41/head";
const BASE_REF = "refs/heads/main";
const TOKEN = "secret-repository-token";

let cacheRoot: string;
let fakeGit: FakeGit;
let ids: number;

beforeEach(() => {
  cacheRoot = mkdtempSync(join(tmpdir(), "meridian-repository-mirror-test-"));
  fakeGit = new FakeGit(new Map([
    ["HEAD", HEAD],
    [HEAD_REF, HEAD],
    [BASE_REF, BASE],
  ]));
  ids = 0;
});

afterEach(() => {
  rmSync(cacheRoot, { recursive: true, force: true });
});

describe("RepositoryMirrorStore", () => {
  it("parses only the exact current repository source-root binding", () => {
    const repositoryDigest = "d".repeat(64);
    const leaseId = "e".repeat(64);
    const current = `repository-mirrors/v2/${repositoryDigest}/worktrees/${leaseId}`;

    expect(parseRepositoryMirrorSourceRoot(current)).toEqual({ repositoryDigest, leaseId });
    for (const invalid of [
      `repository-mirrors/v1/${repositoryDigest}/worktrees/${leaseId}`,
      `repository-mirrors/v2/${repositoryDigest.slice(1)}/worktrees/${leaseId}`,
      `repository-mirrors/v2/${repositoryDigest}/worktrees/${leaseId.slice(1)}`,
      `repository-mirrors/v2/${repositoryDigest}/worktrees/${leaseId}/nested`,
      `prefix/repository-mirrors/v2/${repositoryDigest}/worktrees/${leaseId}`,
    ]) {
      expect(parseRepositoryMirrorSourceRoot(invalid)).toBeNull();
    }
  });

  it("creates a credential-free partial mirror and an idempotent detached worktree lease", async () => {
    const store = createStore();
    const lease = await store.prepare(request({ token: TOKEN, jobId: "review-41-private" }));

    expect(existsSync(lease.worktreeDir)).toBe(true);
    expect(readFileSync(join(lease.worktreeDir, "source.ts"), "utf8")).toContain(HEAD);
    expect(lease.headOid).toBe(HEAD);
    expect(lease.baseOid).toBe(BASE);
    expect(lease.headRef).toBe(`refs/meridian/jobs/${lease.leaseId}/head`);
    expect(lease.baseRef).toBe(`refs/meridian/jobs/${lease.leaseId}/base`);
    expect(lease.worktreeDir).not.toContain("objects.git");
    expect("mirrorDir" in lease).toBe(false);

    const fetch = fakeGit.calls.find((call) => call.args[0] === "fetch")!;
    expect(fetch.args).toContain("--filter=blob:none");
    expect(fetch.args).toContain("--no-write-fetch-head");
    expect(fetch.args).toContain(`+${HEAD_REF}:${lease.headRef}`);
    expect(fetch.args).toContain(`+${BASE_REF}:${lease.baseRef}`);
    expect(fetch.options.token).toBe(TOKEN);
    const worktreeAdd = fakeGit.calls.find((call) => call.args[0] === "worktree" && call.args[1] === "add")!;
    expect(worktreeAdd.args).toEqual([
      "worktree", "add", "--detach", "--no-checkout", lease.worktreeDir, lease.headRef,
    ]);
    expect(worktreeAdd.options.token).toBeUndefined();
    const materialize = fakeGit.calls.find((call) => call.args[0] === "reset")!;
    expect(materialize.options).toMatchObject({ cwd: lease.worktreeDir, token: TOKEN });
    expect(fakeGit.calls.flatMap((call) => call.args)).not.toContain(TOKEN);

    const persisted = allFileContents(cacheRoot).join("\n");
    expect(persisted).not.toContain(TOKEN);
    expect(persisted).not.toContain("tenant-a/org/repo");
    expect(persisted).not.toContain("review-41-private");

    const firstRelease = lease.release();
    const secondRelease = lease.release();
    expect(secondRelease).toBe(firstRelease);
    await firstRelease;
    expect(existsSync(lease.worktreeDir)).toBe(false);
    expect(fakeGit.refs.size).toBe(0);
    expect(fakeGit.calls.filter((call) => call.args[0] === "update-ref")).toHaveLength(2);
  });

  it("overlaps same-repository fetches while allocating unique worktrees and refs", async () => {
    fakeGit.fetchDelayMs = 35;
    const store = createStore({ lockPollMs: 2 });

    const [first, second] = await Promise.all([
      store.prepare(request({ jobId: "first" })),
      store.prepare(request({ jobId: "second" })),
    ]);

    expect(fakeGit.maxActiveFetches).toBe(2);
    expect(fakeGit.calls.filter((call) => call.args[0] === "fetch")).toHaveLength(2);
    expect(fakeGit.calls.filter((call) => call.args[0] === "init")).toHaveLength(1);
    expect(first.worktreeDir).not.toBe(second.worktreeDir);
    expect(first.headRef).not.toBe(second.headRef);
    expect(existsSync(first.worktreeDir)).toBe(true);
    expect(existsSync(second.worktreeDir)).toBe(true);

    await Promise.all([first.release(), second.release()]);
  });

  it("reuses one mirror for a default-HEAD base graph and a PR worktree", async () => {
    const store = createStore();
    const base = await store.prepare(request({
      jobId: "base-graph",
      head: { ref: "HEAD", oid: HEAD },
      base: { ref: "HEAD", oid: HEAD },
    }));
    const pullRequest = await store.prepare(request({ jobId: "pull-request" }));

    expect(fakeGit.calls.filter((call) => call.args[0] === "init")).toHaveLength(1);
    expect(base.repositoryDigest).toBe(pullRequest.repositoryDigest);
    expect(base.worktreeDir).not.toBe(pullRequest.worktreeDir);
    expect(readFileSync(join(base.worktreeDir, "source.ts"), "utf8")).toContain(HEAD);

    await Promise.all([base.release(), pullRequest.release()]);
  });

  it("materializes an already-present commit as an independent child lease without refetching", async () => {
    const store = createStore();
    const parent = await store.prepare(request({ token: TOKEN, jobId: "parent-review" }));
    const fetchCount = fakeGit.calls.filter((call) => call.args[0] === "fetch").length;

    const child = await parent.prepareDetachedRevision({
      oid: BASE.toUpperCase(),
      jobId: "merge-base-private-label",
    });

    expect(child.repositoryDigest).toBe(parent.repositoryDigest);
    expect(child.oid).toBe(BASE);
    expect(child.ref).toBe(`refs/meridian/jobs/${child.leaseId}/commit`);
    expect(child.worktreeDir).not.toBe(parent.worktreeDir);
    expect("mirrorDir" in child).toBe(false);
    expect(readFileSync(join(child.worktreeDir, "source.ts"), "utf8")).toContain(BASE);
    expect(fakeGit.calls.filter((call) => call.args[0] === "fetch")).toHaveLength(fetchCount);

    const createRef = fakeGit.calls.find((call) => (
      call.args[0] === "update-ref" && call.args[1] === child.ref
    ))!;
    expect(createRef.args).toEqual(["update-ref", child.ref, BASE, "0".repeat(40)]);
    const childAdd = fakeGit.calls.find((call) => (
      call.args[0] === "worktree" && call.args[1] === "add" && call.args[4] === child.worktreeDir
    ))!;
    expect(childAdd.args).toEqual([
      "worktree", "add", "--detach", "--no-checkout", child.worktreeDir, child.ref,
    ]);
    const childReset = fakeGit.calls.find((call) => (
      call.args[0] === "reset" && call.options.cwd === child.worktreeDir
    ))!;
    expect(childReset.options.token).toBe(TOKEN);

    const persisted = allFileContents(cacheRoot).join("\n");
    expect(persisted).not.toContain(TOKEN);
    expect(persisted).not.toContain("merge-base-private-label");

    await child.release();
    expect(existsSync(child.worktreeDir)).toBe(false);
    expect(fakeGit.refs.has(refKey(mirrorCwd(fakeGit), child.ref))).toBe(false);
    expect(fakeGit.refs.has(refKey(mirrorCwd(fakeGit), parent.headRef))).toBe(true);
    expect(existsSync(parent.worktreeDir)).toBe(true);
    await parent.release();
  });

  it("serializes child worktree registration while overlapping materialization", async () => {
    fakeGit.worktreeAddDelayMs = 25;
    fakeGit.resetDelayMs = 40;
    const store = createStore({ lockPollMs: 2 });
    const parent = await store.prepare(request());
    fakeGit.maxActiveWorktreeAdds = 0;
    fakeGit.maxActiveResets = 0;

    const [first, second] = await Promise.all([
      parent.prepareDetachedRevision({ oid: BASE, jobId: "merge-base-one" }),
      parent.prepareDetachedRevision({ oid: BASE, jobId: "merge-base-two" }),
    ]);

    expect(first.ref).not.toBe(second.ref);
    expect(first.worktreeDir).not.toBe(second.worktreeDir);
    expect(fakeGit.maxActiveWorktreeAdds).toBe(1);
    expect(fakeGit.maxActiveResets).toBe(2);
    expect(fakeGit.calls.filter((call) => call.args[0] === "fetch")).toHaveLength(1);

    await Promise.all([first.release(), second.release(), parent.release()]);
  });

  it("rejects absent commits, cancellation, and child creation from a released lease", async () => {
    const store = createStore();
    const parent = await store.prepare(request());

    await expect(parent.prepareDetachedRevision({ oid: OTHER })).rejects.toMatchObject({
      status: 409,
      message: "requested repository commit is not present in the active mirror",
    });
    expect(fakeGit.calls.some((call) => (
      call.args[0] === "update-ref" && call.args[1]?.endsWith("/commit") && call.args[1] !== "-d"
    ))).toBe(false);

    const controller = new AbortController();
    controller.abort();
    await expect(parent.prepareDetachedRevision({ oid: BASE, signal: controller.signal }))
      .rejects.toMatchObject({ name: "AbortError" });

    await parent.release();
    await expect(parent.prepareDetachedRevision({ oid: BASE })).rejects.toMatchObject({
      status: 409,
      message: "repository worktree lease is no longer active",
    });
  });

  it("scavenges stale detached leases independently from their active parent", async () => {
    let now = Date.now();
    const startedAt = now;
    const store = createStore({ now: () => now });
    const parent = await store.prepare(request());
    const child = await parent.prepareDetachedRevision({ oid: BASE });
    now = startedAt + 1_500;
    parent.touch();

    const result = await store.scavenge({ maxLeaseAgeMs: 1_000, now: startedAt + 2_000 });
    expect(result).toMatchObject({ repositoriesVisited: 1, leasesRemoved: 1 });
    expect(existsSync(child.worktreeDir)).toBe(false);
    expect(existsSync(parent.worktreeDir)).toBe(true);
    expect(fakeGit.refs.has(refKey(mirrorCwd(fakeGit), child.ref))).toBe(false);
    expect(fakeGit.refs.has(refKey(mirrorCwd(fakeGit), parent.headRef))).toBe(true);

    await expect(child.release()).resolves.toBeUndefined();
    await parent.release();
  });

  it("rejects a moved revision and removes the partial job state", async () => {
    const store = createStore();
    await expect(store.prepare(request({ head: { ref: HEAD_REF, oid: OTHER } }))).rejects.toMatchObject({
      status: 409,
      message: "repository revision changed while preparing inspection; retry",
    });

    expect(fakeGit.refs.size).toBe(0);
    expect(findNames(cacheRoot, "worktrees").flatMap((path) => readdirSync(path))).toEqual([]);
    expect(findNames(cacheRoot, "leases").flatMap((path) => readdirSync(path))).toEqual([]);
  });

  it("honors an AbortSignal while waiting for another job's fetch lock", async () => {
    const fetchStarted = deferred<void>();
    const releaseFetch = deferred<void>();
    fakeGit.onFetchStart = () => fetchStarted.resolve();
    fakeGit.fetchGate = releaseFetch.promise;
    const store = createStore({ lockPollMs: 2 });
    const firstPending = store.prepare(request({ jobId: "first" }));
    await fetchStarted.promise;

    const controller = new AbortController();
    const secondPending = store.prepare(request({ jobId: "second", signal: controller.signal }));
    controller.abort();
    await expect(secondPending).rejects.toMatchObject({ name: "AbortError" });
    expect(fakeGit.calls.filter((call) => call.args[0] === "fetch")).toHaveLength(1);

    releaseFetch.resolve();
    const first = await firstPending;
    await first.release();
  });

  it("times out without age-stealing a paused repository lock owned by the same live process", async () => {
    const identity = () => "same-boot-and-process-start";
    const store = createStore({
      staleLockMs: 1,
      lockTimeoutMs: 35,
      lockPollMs: 2,
      processIdentity: identity,
    });
    const seed = await store.prepare(request({ jobId: "lock-seed" }));
    await seed.release();
    const lock = join(dirname(dirname(seed.worktreeDir)), "fetch.lock");
    mkdirSync(lock, { mode: 0o700 });
    writeFileSync(join(lock, "owner.json"), `${JSON.stringify({
      lockId: "paused-owner",
      pid: process.pid,
      processIdentity: identity(),
      acquiredAtMs: 1,
    })}\n`, { mode: 0o600 });
    const old = new Date(1_000);
    utimesSync(lock, old, old);

    await expect(store.prepare(request({ jobId: "must-wait" }))).rejects.toMatchObject({ status: 503 });
    expect(existsSync(lock)).toBe(true);
  });

  it("reclaims a stale repository lock after verifiable PID reuse", async () => {
    const seedStore = createStore({ processIdentity: () => "current-start" });
    const seed = await seedStore.prepare(request({ jobId: "pid-reuse-seed" }));
    await seed.release();
    const lock = join(dirname(dirname(seed.worktreeDir)), "fetch.lock");
    mkdirSync(lock, { mode: 0o700 });
    writeFileSync(join(lock, "owner.json"), `${JSON.stringify({
      lockId: "previous-owner",
      pid: process.pid,
      processIdentity: "previous-start",
      acquiredAtMs: 1,
    })}\n`, { mode: 0o600 });
    populateDeepTree(join(lock, "hostile"));
    const old = new Date(1_000);
    utimesSync(lock, old, old);

    const cleanupEntered = deferred<string>();
    const resumeCleanup = deferred<void>();
    let blocked = false;
    const store = createStore({
      staleLockMs: 1,
      lockPollMs: 2,
      processIdentity: () => "current-start",
      beforePhysicalCleanup: async ([path]) => {
        if (!blocked && path?.includes(".meridian-cleanup-lock-")) {
          blocked = true;
          cleanupEntered.resolve(path);
          await resumeCleanup.promise;
        }
      },
    });
    const preparing = store.prepare(request({ jobId: "pid-reuse-successor" }));
    const quarantined = await cleanupEntered.promise;
    const lease = await preparing;
    expect(existsSync(lease.worktreeDir)).toBe(true);
    expect(existsSync(lock)).toBe(false);
    expect(existsSync(quarantined)).toBe(true);

    resumeCleanup.resolve();
    await store.drainCleanup();
    expect(existsSync(quarantined)).toBe(false);
    await lease.release();
  });

  it("never quarantines a replacement installed immediately before stale-lock rename", async () => {
    const seedStore = createStore({ processIdentity: () => "current-start" });
    const seed = await seedStore.prepare(request({ jobId: "stale-replacement-seed" }));
    await seed.release();
    await seedStore.drainCleanup();
    const lock = join(dirname(dirname(seed.worktreeDir)), "fetch.lock");
    mkdirSync(lock, { mode: 0o700 });
    writeFileSync(join(lock, "owner.json"), `${JSON.stringify({
      lockId: "previous-owner",
      pid: process.pid,
      processIdentity: "previous-start",
      acquiredAtMs: 1,
    })}\n`, { mode: 0o600 });
    const old = new Date(1_000);
    utimesSync(lock, old, old);

    let displaced = "";
    const store = createStore({
      staleLockMs: 1,
      lockPollMs: 2,
      processIdentity: () => "current-start",
      beforeQuarantine: (path) => {
        if (path !== lock || displaced) return;
        displaced = `${path}.expected-owner`;
        renameSync(path, displaced);
        mkdirSync(path, { mode: 0o700 });
        writeFileSync(join(path, "owner.json"), `${JSON.stringify({
          lockId: "replacement-owner",
          pid: process.pid,
          processIdentity: "current-start",
          acquiredAtMs: Date.now(),
        })}\n`, { mode: 0o600 });
      },
    });

    await expect(store.prepare(request({ jobId: "stale-replacement-race" })))
      .rejects.toThrow(/cache entry changed before quarantine/);
    expect(JSON.parse(readFileSync(join(lock, "owner.json"), "utf8")))
      .toMatchObject({ lockId: "replacement-owner" });
    expect(existsSync(displaced)).toBe(true);
    expect(findEntryPaths(cacheRoot, (name) => name.includes(".meridian-cleanup-lock-")))
      .toEqual([]);

    rmSync(lock, { recursive: true, force: true });
    rmSync(displaced, { recursive: true, force: true });
  });

  it("never quarantines a replacement installed immediately before owned-lock release", async () => {
    let injectReplacement = false;
    let lock = "";
    let displaced = "";
    const store = createStore({
      beforeQuarantine: (path) => {
        if (!injectReplacement || !path.endsWith("source-owners.lock") || displaced) return;
        lock = path;
        displaced = `${path}.expected-owner`;
        renameSync(path, displaced);
        mkdirSync(path, { mode: 0o700 });
        writeFileSync(join(path, "owner.json"), `${JSON.stringify({
          lockId: "replacement-owner",
          pid: process.pid,
          processIdentity: "replacement-process",
          acquiredAtMs: Date.now(),
        })}\n`, { mode: 0o600 });
      },
    });
    const lease = await store.prepare(request({ jobId: "owned-lock-replacement" }));
    const reference = { repositoryDigest: lease.repositoryDigest, leaseId: lease.leaseId };

    injectReplacement = true;
    await expect(store.retainSource(
      reference,
      lease.worktreeDir,
      "replacement-owner-capability",
      Date.now() + 10_000,
    )).rejects.toThrow(/cache entry changed before quarantine/);
    expect(JSON.parse(readFileSync(join(lock, "owner.json"), "utf8")))
      .toMatchObject({ lockId: "replacement-owner" });
    expect(existsSync(displaced)).toBe(true);

    injectReplacement = false;
    const savedReplacement = `${lock}.replacement-preserved`;
    renameSync(lock, savedReplacement);
    rmSync(displaced, { recursive: true, force: true });
    await store.releaseSource(reference, "replacement-owner-capability");
    await lease.release();
    expect(JSON.parse(readFileSync(join(savedReplacement, "owner.json"), "utf8")))
      .toMatchObject({ lockId: "replacement-owner" });
  });

  it("quarantines a failed lock publication and cleans its deep tree outside admission", async () => {
    const publicationFailure = new Error("owner record write failed");
    const cleanupEntered = deferred<string>();
    const resumeCleanup = deferred<void>();
    const failing = createStore({
      writeLockOwner: (path) => {
        populateDeepTree(join(dirname(path), "partial"));
        throw publicationFailure;
      },
      beforePhysicalCleanup: async ([path]) => {
        if (path?.includes(".meridian-cleanup-lock-")) {
          cleanupEntered.resolve(path);
          await resumeCleanup.promise;
        }
      },
    });

    await expect(failing.prepare(request())).rejects.toBe(publicationFailure);
    const quarantined = await cleanupEntered.promise;
    expect(findNames(cacheRoot, "fetch.lock")).toEqual([]);
    expect(existsSync(quarantined)).toBe(true);

    const recovered = createStore();
    const lease = await recovered.prepare(request());
    expect(existsSync(lease.worktreeDir)).toBe(true);

    resumeCleanup.resolve();
    await failing.drainCleanup();
    expect(existsSync(quarantined)).toBe(false);
    await lease.release();
  });

  it("releases deep lock trees without delaying the next repository admission", async () => {
    const cleanupEntered = deferred<string>();
    const resumeCleanup = deferred<void>();
    let populated = false;
    let blocked = false;
    const store = createStore({
      writeLockOwner: (path, value) => {
        writeFileSync(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
        if (!populated) {
          populated = true;
          populateDeepTree(join(dirname(path), "hostile"));
        }
      },
      beforePhysicalCleanup: async ([path]) => {
        if (!blocked && path?.includes(".meridian-cleanup-lock-")) {
          blocked = true;
          cleanupEntered.resolve(path);
          await resumeCleanup.promise;
        }
      },
    });

    const firstPending = store.prepare(request({ jobId: "deep-lock-first" }));
    const quarantined = await cleanupEntered.promise;
    const first = await firstPending;
    const second = await store.prepare(request({ jobId: "deep-lock-second" }));
    expect(existsSync(first.worktreeDir)).toBe(true);
    expect(existsSync(second.worktreeDir)).toBe(true);
    expect(existsSync(quarantined)).toBe(true);

    let eventLoopTurn = false;
    setImmediate(() => { eventLoopTurn = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(eventLoopTurn).toBe(true);

    resumeCleanup.resolve();
    await store.drainCleanup();
    expect(existsSync(quarantined)).toBe(false);
    await Promise.all([first.release(), second.release()]);
  });

  it("renews active leases and scavenges them after the renewed deadline", async () => {
    let now = Date.now();
    const startedAt = now;
    const store = createStore({ now: () => now });
    const lease = await store.prepare(request());
    now = startedAt + 500;
    lease.touch();

    const kept = await store.scavenge({ maxLeaseAgeMs: 1_000, now: startedAt + 1_000 });
    expect(kept).toMatchObject({ repositoriesVisited: 1, leasesRemoved: 0 });
    expect(existsSync(lease.worktreeDir)).toBe(true);

    const removed = await store.scavenge({ maxLeaseAgeMs: 1_000, now: startedAt + 2_000 });
    expect(removed).toMatchObject({ repositoriesVisited: 1, leasesRemoved: 1 });
    expect(existsSync(lease.worktreeDir)).toBe(false);
    expect(fakeGit.refs.size).toBe(0);
    await expect(lease.release()).resolves.toBeUndefined();
  });

  it("streams thousands of orphan refs with at most one fixed batch unconsumed", async () => {
    const seedStore = createStore();
    const seed = await seedStore.prepare(request({ jobId: "streaming-ref-seed" }));
    const mirror = mirrorCwd(fakeGit);
    await seed.release();
    await seedStore.drainCleanup();

    const total = 4_096;
    for (let index = 1; index <= total; index += 1) {
      const leaseId = index.toString(16).padStart(64, "0");
      fakeGit.refs.set(refKey(mirror, `refs/meridian/jobs/${leaseId}/head`), HEAD);
    }
    let delivered = 0;
    let maxUnconsumed = 0;
    const gitLines: RepositoryGitLineRunner = async (_args, options, consume) => {
      const prefix = `${options.cwd}\0`;
      for (const key of fakeGit.refs.keys()) {
        if (!key.startsWith(prefix)) continue;
        delivered += 1;
        maxUnconsumed = Math.max(maxUnconsumed, delivered - (total - fakeGit.refs.size));
        await consume(key.slice(prefix.length));
        maxUnconsumed = Math.max(maxUnconsumed, delivered - (total - fakeGit.refs.size));
      }
    };

    const store = createStore({ gitLines });
    const result = await store.scavenge({ maxLeaseAgeMs: 0, now: Date.now() });

    expect(result.orphanRefsRemoved).toBe(total);
    expect(delivered).toBe(total);
    expect(maxUnconsumed).toBeLessThanOrEqual(32);
    expect(fakeGit.refs.size).toBe(0);
    expect(fakeGit.calls.some((call) => call.args[0] === "for-each-ref")).toBe(false);
  });

  it("observes setImmediate cancellation during a streamed ref inventory", async () => {
    const seedStore = createStore();
    const seed = await seedStore.prepare(request({ jobId: "abort-ref-seed" }));
    const mirror = mirrorCwd(fakeGit);
    await seed.release();
    await seedStore.drainCleanup();

    const total = 4_096;
    for (let index = 1; index <= total; index += 1) {
      const leaseId = index.toString(16).padStart(64, "0");
      fakeGit.refs.set(refKey(mirror, `refs/meridian/jobs/${leaseId}/head`), HEAD);
    }
    const controller = new AbortController();
    const reason = new Error("stop streamed ref scan");
    reason.name = "AbortError";
    let delivered = 0;
    const gitLines: RepositoryGitLineRunner = async (_args, options, consume) => {
      const prefix = `${options.cwd}\0`;
      for (const key of fakeGit.refs.keys()) {
        if (!key.startsWith(prefix)) continue;
        delivered += 1;
        if (delivered === 1) setImmediate(() => controller.abort(reason));
        await consume(key.slice(prefix.length));
      }
    };

    const store = createStore({ gitLines });
    await expect(store.scavenge({
      maxLeaseAgeMs: 0,
      now: Date.now(),
      signal: controller.signal,
    })).rejects.toBe(reason);

    expect(delivered).toBeGreaterThan(0);
    expect(delivered).toBeLessThan(total);
    expect(fakeGit.calls.some((call) => call.args[0] === "for-each-ref")).toBe(false);
  });

  it("quarantines a deep worktree before async deletion and frees repository admission", async () => {
    const cleanupEntered = deferred<string>();
    const resumeCleanup = deferred<void>();
    let worktreesDir = "";
    let blocked = false;
    const store = createStore({
      beforePhysicalCleanup: async ([path]) => {
        if (!blocked
          && path
          && dirname(path) === worktreesDir
          && path.includes(".meridian-cleanup-worktree-")) {
          blocked = true;
          cleanupEntered.resolve(path);
          await resumeCleanup.promise;
        }
      },
    });
    const lease = await store.prepare(request({ jobId: "deep-worktree" }));
    worktreesDir = dirname(lease.worktreeDir);
    populateDeepTree(join(lease.worktreeDir, "hostile"));

    const release = lease.release();
    const quarantined = await cleanupEntered.promise;
    expect(existsSync(lease.worktreeDir)).toBe(false);
    expect(existsSync(quarantined)).toBe(true);

    let releaseSettled = false;
    void release.then(
      () => { releaseSettled = true; },
      () => { releaseSettled = true; },
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(releaseSettled).toBe(false);

    // A second PR can register and materialize its worktree while the first deep tree is still
    // physically present in quarantine.
    const concurrent = await store.prepare(request({ jobId: "concurrent-after-quarantine" }));
    expect(existsSync(concurrent.worktreeDir)).toBe(true);

    resumeCleanup.resolve();
    await release;
    expect(existsSync(quarantined)).toBe(false);
    await concurrent.release();
  });

  it("never quarantines a worktree replacement installed immediately before rename", async () => {
    let target = "";
    let displaced = "";
    let injectReplacement = false;
    const store = createStore({
      beforeQuarantine: (path) => {
        if (!injectReplacement || path !== target || displaced) return;
        displaced = `${path}.expected-worktree`;
        renameSync(path, displaced);
        mkdirSync(path, { mode: 0o700 });
        writeFileSync(join(path, "replacement.bin"), "replacement");
      },
    });
    const lease = await store.prepare(request({ jobId: "pre-quarantine-worktree-replacement" }));
    target = lease.worktreeDir;
    injectReplacement = true;

    await expect(lease.release()).rejects.toThrow(/changed before quarantine/);
    expect(readFileSync(join(target, "replacement.bin"), "utf8")).toBe("replacement");
    expect(existsSync(displaced)).toBe(true);
    expect(findEntryPaths(cacheRoot, (name) => name.includes(".meridian-cleanup-worktree-")))
      .toEqual([]);

    injectReplacement = false;
    const savedReplacement = `${target}.replacement-preserved`;
    renameSync(target, savedReplacement);
    renameSync(displaced, target);
    await lease.release();

    expect(readFileSync(join(savedReplacement, "replacement.bin"), "utf8")).toBe("replacement");
    expect(existsSync(target)).toBe(false);
  });

  it("accepts post-rename disappearance as cleanup ownership handoff", async () => {
    let target = "";
    let handedOff = "";
    const store = createStore({
      afterQuarantineRename: (path) => {
        if (!target || handedOff || !path.startsWith(`${target}.meridian-cleanup-worktree-`)) return;
        handedOff = `${path}.scanner-owned`;
        renameSync(path, handedOff);
      },
    });
    const lease = await store.prepare(request({ jobId: "post-rename-cleanup-handoff" }));
    target = lease.worktreeDir;

    await expect(lease.release()).resolves.toBeUndefined();

    expect(existsSync(target)).toBe(false);
    expect(existsSync(handedOff)).toBe(true);
    expect(readFileSync(join(handedOff, "source.ts"), "utf8")).toContain(HEAD);
  });

  it("rejects and preserves a mismatched inode still present after quarantine rename", async () => {
    let target = "";
    let expectedInode = "";
    let injectReplacement = true;
    const store = createStore({
      afterQuarantineRename: (path) => {
        if (!injectReplacement
          || !target
          || !path.startsWith(`${target}.meridian-cleanup-worktree-`)) return;
        injectReplacement = false;
        expectedInode = `${path}.expected-inode`;
        renameSync(path, expectedInode);
        mkdirSync(path, { mode: 0o700 });
        writeFileSync(join(path, "replacement.bin"), "replacement");
      },
    });
    const lease = await store.prepare(request({ jobId: "post-rename-inode-mismatch" }));
    target = lease.worktreeDir;

    await expect(lease.release()).rejects.toThrow(
      /changed during quarantine and was preserved as rejected/,
    );
    expect(existsSync(expectedInode)).toBe(true);
    const rejected = findEntryPaths(dirname(target), (name) => (
      name.startsWith(`${lease.leaseId}.meridian-rejected-worktree-`)
    ));
    expect(rejected).toHaveLength(1);
    expect(readFileSync(join(rejected[0]!, "replacement.bin"), "utf8")).toBe("replacement");

    renameSync(expectedInode, target);
    await lease.release();
    expect(readFileSync(join(rejected[0]!, "replacement.bin"), "utf8")).toBe("replacement");
  });

  it("never deletes a replaced worktree claim and lets release retry the original inode", async () => {
    let worktreesDir = "";
    let cleanupPath = "";
    let displaced = "";
    let attempts = 0;
    const store = createStore({
      cleanupRetryMs: 60_000,
      beforePhysicalCleanup: async ([path]) => {
        if (!path
          || dirname(path) !== worktreesDir
          || !path.includes(".meridian-cleanup-worktree-")) return;
        attempts += 1;
        if (attempts === 1) {
          cleanupPath = path;
          displaced = `${path}.owned-inode`;
          renameSync(path, displaced);
          mkdirSync(path, { mode: 0o700 });
          writeFileSync(join(path, "replacement.bin"), "replacement");
        }
      },
    });
    const lease = await store.prepare(request({ jobId: "replacement-claim" }));
    worktreesDir = dirname(lease.worktreeDir);

    await expect(lease.release()).rejects.toThrow(/claim was replaced/);
    await expect(store.drainCleanup()).rejects.toThrow(/claim was replaced/);
    expect(readFileSync(join(cleanupPath, "replacement.bin"), "utf8")).toBe("replacement");

    const replacement = `${cleanupPath}.replacement-preserved`;
    renameSync(cleanupPath, replacement);
    renameSync(displaced, cleanupPath);
    await lease.release();

    expect(readFileSync(join(replacement, "replacement.bin"), "utf8")).toBe("replacement");
    expect(existsSync(cleanupPath)).toBe(false);
  });

  it("rediscovers an interrupted worktree quarantine after restart", async () => {
    const retryObserved = deferred<void>();
    let worktreesDir = "";
    let quarantined = "";
    let attempts = 0;
    const interrupted = createStore({
      cleanupRetryMs: 60_000,
      beforePhysicalCleanup: async ([path]) => {
        if (!path
          || dirname(path) !== worktreesDir
          || !path.includes(".meridian-cleanup-worktree-")) return;
        quarantined = path;
        attempts += 1;
        if (attempts >= 2) retryObserved.resolve();
        throw new Error("injected interrupted physical cleanup");
      },
    });
    const lease = await interrupted.prepare(request({ jobId: "restart-residue" }));
    worktreesDir = dirname(lease.worktreeDir);
    populateDeepTree(join(lease.worktreeDir, "hostile"));

    await expect(lease.release()).rejects.toThrow(/interrupted physical cleanup/);
    await retryObserved.promise;
    expect(existsSync(quarantined)).toBe(true);

    const restarted = createStore();
    await restarted.scavenge({ maxLeaseAgeMs: 0, now: Date.now() });
    expect(existsSync(quarantined)).toBe(false);
    await expect(lease.release()).resolves.toBeUndefined();
  });

  it("retries every cleanup-owner claim after an early failure beyond 32 entries", async () => {
    let phase: "seed" | "retry" | "cleanup" = "seed";
    let blocked = "";
    const retryAttempts = new Set<string>();
    const store = createStore({
      cleanupRetryMs: 60_000,
      beforePhysicalCleanup: async ([path]) => {
        if (!path?.includes(".meridian-cleanup-owner-")) return;
        if (phase === "seed") throw new Error("seed owner retry claims");
        if (phase === "retry") {
          retryAttempts.add(path);
          blocked ||= path;
          if (path === blocked) throw new Error("early cleanup-owner retry failure");
        }
      },
    });
    const lease = await store.prepare(request({ jobId: "cleanup-owner-retry" }));
    const repositoryRoot = dirname(dirname(lease.worktreeDir));
    const retentionDir = join(repositoryRoot, "source-retentions", lease.leaseId);
    mkdirSync(retentionDir, { recursive: true, mode: 0o700 });
    for (let index = 0; index < 33; index += 1) {
      const owner = `${index.toString(16).padStart(64, "0")}.json`;
      const livePath = join(retentionDir, owner);
      writeFileSync(livePath, String(index), { mode: 0o600 });
      const identityDigest = cacheEntryIdentityDigest(claimPathForCleanup(livePath).identity);
      renameSync(
        livePath,
        `${livePath}.meridian-cleanup-owner-${index.toString(16).padStart(32, "0")}-${identityDigest}`,
      );
    }

    let seedFailure: unknown;
    try {
      await lease.release();
    } catch (error) {
      seedFailure = error;
    }
    expect(errorMessages(seedFailure)).toContain("seed owner retry claims");
    let drainFailure: unknown;
    try {
      await store.drainCleanup();
    } catch (error) {
      drainFailure = error;
    }
    expect(errorMessages(drainFailure)).toContain("seed owner retry claims");

    phase = "retry";
    await expect(lease.release()).rejects.toThrow(/early cleanup-owner retry failure/);
    expect(retryAttempts.size).toBe(33);

    phase = "cleanup";
    await lease.release();
    expect(existsSync(lease.worktreeDir)).toBe(false);
  });

  it("preserves restart residue whose filename identity does not match its inode", async () => {
    const seedStore = createStore();
    const seed = await seedStore.prepare(request({ jobId: "identity-residue-seed" }));
    const worktreesDir = dirname(seed.worktreeDir);
    await seed.release();

    const base = "d".repeat(64);
    const residue = join(
      worktreesDir,
      `${base}.meridian-cleanup-worktree-${"e".repeat(32)}-${"0".repeat(64)}`,
    );
    mkdirSync(residue, { mode: 0o700 });
    writeFileSync(join(residue, "replacement.bin"), "must survive");

    const restarted = createStore();
    await restarted.scavenge({ maxLeaseAgeMs: 0, now: Date.now() });

    expect(existsSync(residue)).toBe(false);
    const rejected = findEntryPaths(worktreesDir, (name) => (
      name.startsWith(`${base}.meridian-rejected-worktree-`)
    ));
    expect(rejected).toHaveLength(1);
    expect(readFileSync(join(rejected[0]!, "replacement.bin"), "utf8")).toBe("must survive");
  });

  it("persists prepared-source retention across restart and scavenges only after its deadline", async () => {
    let now = Date.now();
    const startedAt = now;
    const firstProcess = createStore({ now: () => now });
    const lease = await firstProcess.prepare(request());
    const reference = {
      repositoryDigest: lease.repositoryDigest,
      leaseId: lease.leaseId,
    };
    await firstProcess.retainSource(reference, lease.worktreeDir, "handoff-one", startedAt + 10_000);

    now = startedAt + 2_000;
    const restarted = createStore({ now: () => now });
    const protectedResult = await restarted.scavenge({ maxLeaseAgeMs: 1_000, now });
    expect(protectedResult).toMatchObject({ repositoriesVisited: 1, leasesRemoved: 0 });
    expect(existsSync(lease.worktreeDir)).toBe(true);

    now = startedAt + 10_001;
    const expiredResult = await restarted.scavenge({ maxLeaseAgeMs: 1_000, now });
    expect(expiredResult).toMatchObject({ repositoriesVisited: 1, leasesRemoved: 1 });
    expect(existsSync(lease.worktreeDir)).toBe(false);
    expect(fakeGit.refs.size).toBe(0);
    await expect(lease.release()).resolves.toBeUndefined();
  });

  it("aborts promptly while waiting for source-owner admission without creating retention", async () => {
    const store = createStore({ lockPollMs: 2 });
    const lease = await store.prepare(request({ jobId: "source-owner-abort" }));
    const reference = { repositoryDigest: lease.repositoryDigest, leaseId: lease.leaseId };
    const lock = join(dirname(dirname(lease.worktreeDir)), "source-owners.lock");
    mkdirSync(lock, { mode: 0o700 });
    writeFileSync(join(lock, "owner.json"), `${JSON.stringify({
      lockId: "live-source-owner",
      pid: process.pid,
      processIdentity: "unverifiable:test",
      acquiredAtMs: Date.now(),
    })}\n`, { mode: 0o600 });
    const controller = new AbortController();
    const reason = new DOMException("shutdown", "AbortError");
    const pending = store.retainSource(
      reference,
      lease.worktreeDir,
      "must-not-persist",
      Date.now() + 10_000,
      { signal: controller.signal },
    );
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    expect(findEntryPaths(cacheRoot, (name) => name.endsWith(".json") && name !== "owner.json")
      .some((path) => path.includes("source-retentions"))).toBe(false);
    rmSync(lock, { recursive: true, force: true });
    await lease.release();
  });

  it("aborts source release before admission without removing the durable owner", async () => {
    const store = createStore({ lockPollMs: 2 });
    const lease = await store.prepare(request({ jobId: "source-release-abort" }));
    const reference = { repositoryDigest: lease.repositoryDigest, leaseId: lease.leaseId };
    await store.retainSource(reference, lease.worktreeDir, "must-survive", Date.now() + 10_000);
    const retainedBefore = findEntryPaths(cacheRoot, (name) => name.endsWith(".json"))
      .filter((path) => path.includes("source-retentions"));
    expect(retainedBefore).toHaveLength(1);

    const lock = join(dirname(dirname(lease.worktreeDir)), "source-owners.lock");
    mkdirSync(lock, { mode: 0o700 });
    writeFileSync(join(lock, "owner.json"), `${JSON.stringify({
      lockId: "live-source-release",
      pid: process.pid,
      processIdentity: "unverifiable:test",
      acquiredAtMs: Date.now(),
    })}\n`, { mode: 0o600 });
    const controller = new AbortController();
    const reason = new DOMException("shutdown", "AbortError");
    const pending = store.releaseSource(reference, "must-survive", { signal: controller.signal });
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    expect(findEntryPaths(cacheRoot, (name) => name.endsWith(".json"))
      .filter((path) => path.includes("source-retentions"))).toEqual(retainedBefore);

    rmSync(lock, { recursive: true, force: true });
    await store.releaseSource(reference, "must-survive");
    await lease.release();
  });

  it("preserves in-flight renewal and exact release failures on source-operation release", async () => {
    const store = createStore();
    const lease = await store.prepare(request({ jobId: "source-operation-release" }));
    const reference = { repositoryDigest: lease.repositoryDigest, leaseId: lease.leaseId };
    const operation = await store.acquireSource(reference, lease.worktreeDir, "projection");
    const renewalEntered = deferred<void>();
    const finishRenewal = deferred<void>();
    const renewalFailure = new Error("source renewal failed");
    const releaseFailure = new Error("source release reported failure");
    const originalRelease = store.releaseSource.bind(store);
    const retainSpy = vi.spyOn(store, "retainSource").mockImplementationOnce(async () => {
      renewalEntered.resolve();
      await finishRenewal.promise;
      throw renewalFailure;
    });
    const releaseSpy = vi.spyOn(store, "releaseSource").mockImplementationOnce(async (...args) => {
      await originalRelease(...args);
      throw releaseFailure;
    });

    const renewing = operation.renew();
    await renewalEntered.promise;
    const releasing = operation.release();
    finishRenewal.resolve();
    await expect(renewing).rejects.toBe(renewalFailure);
    const firstFailure = await releasing.catch((error: unknown) => error);
    expect(firstFailure).toBeInstanceOf(AggregateError);
    expect((firstFailure as AggregateError).errors).toEqual([renewalFailure, releaseFailure]);
    await expect(operation.release()).rejects.toBe(firstFailure);

    retainSpy.mockRestore();
    releaseSpy.mockRestore();
    await lease.release();
  });

  it("refuses to retain a source through a mismatched worktree capability", async () => {
    const store = createStore();
    const lease = await store.prepare(request());
    const other = await store.prepare(request({ jobId: "other" }));

    await expect(store.retainSource({
      repositoryDigest: lease.repositoryDigest,
      leaseId: lease.leaseId,
    }, other.worktreeDir, "handoff-one", Date.now() + 10_000)).rejects.toMatchObject({
      status: 409,
      message: "repository source lease does not own the published worktree",
    });

    await Promise.all([lease.release(), other.release()]);
  });

  it("rejects a same-path symlink replacement before resolving a source capability", async () => {
    const store = createStore();
    const lease = await store.prepare(request({ jobId: "source-symlink-replacement" }));
    const reference = { repositoryDigest: lease.repositoryDigest, leaseId: lease.leaseId };
    const displaced = `${lease.worktreeDir}.expected-worktree`;
    const external = join(cacheRoot, "external-source");
    mkdirSync(external, { mode: 0o700 });
    writeFileSync(join(external, "preserved.txt"), "external");
    renameSync(lease.worktreeDir, displaced);
    symlinkSync(external, lease.worktreeDir, "dir");

    await expect(store.retainSource(
      reference,
      lease.worktreeDir,
      "symlink-capability",
      Date.now() + 10_000,
    )).rejects.toMatchObject({
      status: 409,
      message: "repository source lease no longer owns its persisted worktree",
    });
    expect(readFileSync(join(external, "preserved.txt"), "utf8")).toBe("external");

    rmSync(lease.worktreeDir, { force: true });
    renameSync(displaced, lease.worktreeDir);
    await lease.release();
    expect(readFileSync(join(external, "preserved.txt"), "utf8")).toBe("external");
  });

  it("reconciles per-handoff source owners and reclaims after the last owner leaves", async () => {
    const store = createStore();
    const lease = await store.prepare(request());
    const reference = { repositoryDigest: lease.repositoryDigest, leaseId: lease.leaseId };
    await store.retainSource(reference, lease.worktreeDir, "handoff-one", Date.now() + 10_000);
    await store.retainSource(reference, lease.worktreeDir, "handoff-two", Date.now() + 10_000);

    await store.releaseSource(reference, "handoff-one");
    expect(existsSync(lease.worktreeDir)).toBe(true);

    await store.releaseSource(reference, "handoff-two");
    // External owners cannot reclaim a worktree while the originating job lease is still live.
    expect(existsSync(lease.worktreeDir)).toBe(true);
    await expect(lease.release()).resolves.toBeUndefined();
    expect(existsSync(lease.worktreeDir)).toBe(false);
    expect(fakeGit.refs.size).toBe(0);
  });

  it("reclaims a released-retained lease after its last owner leaves without a restart", async () => {
    const store = createStore();
    const lease = await store.prepare(request());
    const reference = { repositoryDigest: lease.repositoryDigest, leaseId: lease.leaseId };
    await store.retainSource(reference, lease.worktreeDir, "capability", Date.now() + 10_000);
    await lease.release();
    expect(existsSync(lease.worktreeDir)).toBe(true);

    await store.releaseSource(reference, "capability");
    await store.drainCleanup();

    expect(existsSync(lease.worktreeDir)).toBe(false);
    expect(fakeGit.refs.size).toBe(0);
  });

  it("releases a globally addressed cache owner without generation metadata", async () => {
    const store = createStore();
    const target = await store.prepare(request({ jobId: "gc-target" }));
    const unrelated = await store.prepare(request({ jobId: "gc-unrelated" }));
    const targetReference = {
      repositoryDigest: target.repositoryDigest,
      leaseId: target.leaseId,
    };
    const unrelatedReference = {
      repositoryDigest: unrelated.repositoryDigest,
      leaseId: unrelated.leaseId,
    };
    await store.retainSource(
      targetReference,
      target.worktreeDir,
      "pr-head-cache:repo:security:generation",
      Date.now() + 10_000,
    );
    await store.retainSource(
      unrelatedReference,
      unrelated.worktreeDir,
      "unrelated-owner",
      Date.now() + 10_000,
    );
    await Promise.all([target.release(), unrelated.release()]);

    await expect(store.releaseSourceOwner("pr-head-cache:repo:security:generation"))
      .resolves.toBe(1);
    await store.drainCleanup();

    expect(existsSync(target.worktreeDir)).toBe(false);
    expect(existsSync(unrelated.worktreeDir)).toBe(true);
    await store.releaseSource(unrelatedReference, "unrelated-owner");
    await store.drainCleanup();
  });

  it("aggregates owner, unlock, and physical failures after attempting the whole batch", async () => {
    const owner = "aggregate-owner";
    let injectFailures = false;
    let ownerAttempts = 0;
    let physicalFailureInjected = false;
    const physicalClaims = new Set<string>();
    const store = createStore({
      cleanupRetryMs: 60_000,
      beforeQuarantine: (path) => {
        if (!injectFailures) return;
        if (path.endsWith("source-owners.lock")) {
          throw new Error("unlock quarantine failure");
        }
        if (!path.includes("source-retentions") || !path.endsWith(".json")) return;
        ownerAttempts += 1;
        if (ownerAttempts === 2) throw new Error("primary owner quarantine failure");
      },
      beforePhysicalCleanup: async ([path]) => {
        if (!injectFailures || !path?.includes(".meridian-cleanup-owner-")) return;
        physicalClaims.add(path);
        if (!physicalFailureInjected) {
          physicalFailureInjected = true;
          throw new Error("physical cleanup failure");
        }
      },
    });
    const leases = await Promise.all([
      store.prepare(request({ jobId: "aggregate-one" })),
      store.prepare(request({ jobId: "aggregate-two" })),
      store.prepare(request({ jobId: "aggregate-three" })),
    ]);
    for (const lease of leases) {
      await store.retainSource(
        { repositoryDigest: lease.repositoryDigest, leaseId: lease.leaseId },
        lease.worktreeDir,
        owner,
        Date.now() + 10_000,
      );
    }
    await Promise.all(leases.map((lease) => lease.release()));

    injectFailures = true;
    let failure: unknown;
    try {
      await store.releaseSourceOwner(owner);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(AggregateError);
    expect(errorMessages(failure)).toEqual(expect.arrayContaining([
      "primary owner quarantine failure",
      "unlock quarantine failure",
      "physical cleanup failure",
    ]));
    expect(ownerAttempts).toBe(3);
    expect(physicalClaims.size).toBe(2);

    injectFailures = false;
    const sourceOwnersLock = join(dirname(dirname(leases[0]!.worktreeDir)), "source-owners.lock");
    rmSync(sourceOwnersLock, { recursive: true, force: true });
    await store.releaseSourceOwner(owner);
    await store.drainCleanup();
    expect(leases.every((lease) => !existsSync(lease.worktreeDir))).toBe(true);
  });

  it("continues source-owner traversal beyond a failed 32-entry batch", async () => {
    const owner = "multi-batch-owner";
    let injectFailure = false;
    let ownerAttempts = 0;
    const store = createStore({
      lockPollMs: 2,
      beforeQuarantine: (path) => {
        if (!injectFailure
          || !path.includes("source-retentions")
          || !path.endsWith(".json")) return;
        ownerAttempts += 1;
        if (ownerAttempts === 1) throw new Error("first owner batch failed");
      },
    });
    const leases = await Promise.all(Array.from({ length: 33 }, (_, index) => (
      store.prepare(request({ jobId: `owner-batch-${index}` }))
    )));
    for (const lease of leases) {
      await store.retainSource(
        { repositoryDigest: lease.repositoryDigest, leaseId: lease.leaseId },
        lease.worktreeDir,
        owner,
        Date.now() + 10_000,
      );
    }
    await Promise.all(leases.map((lease) => lease.release()));

    injectFailure = true;
    await expect(store.releaseSourceOwner(owner)).rejects.toThrow(/first owner batch failed/);
    expect(ownerAttempts).toBe(33);

    injectFailure = false;
    await expect(store.releaseSourceOwner(owner)).resolves.toBe(1);
    await store.drainCleanup();
    expect(leases.every((lease) => !existsSync(lease.worktreeDir))).toBe(true);
  });

  it("lets a concurrent re-retain win before the cleanup tombstone is committed", async () => {
    const store = createStore({ lockPollMs: 2 });
    const lease = await store.prepare(request());
    const reference = { repositoryDigest: lease.repositoryDigest, leaseId: lease.leaseId };
    await store.retainSource(reference, lease.worktreeDir, "old-owner", Date.now() + 10_000);
    await lease.release();

    const fetchLock = join(dirname(dirname(lease.worktreeDir)), "fetch.lock");
    mkdirSync(fetchLock);
    await store.releaseSource(reference, "old-owner");
    await store.retainSource(reference, lease.worktreeDir, "new-owner", Date.now() + 10_000);
    rmSync(fetchLock, { recursive: true, force: true });
    await store.drainCleanup();
    expect(existsSync(lease.worktreeDir)).toBe(true);

    await store.releaseSource(reference, "new-owner");
    await store.drainCleanup();
    expect(existsSync(lease.worktreeDir)).toBe(false);
  });

  it("keeps the cleanup queue bounded and uses an on-disk sweep after overflow", async () => {
    const store = createStore({ cleanupQueueLimit: 1, lockPollMs: 2 });
    const leases = await Promise.all([
      store.prepare(request({ jobId: "overflow-one" })),
      store.prepare(request({ jobId: "overflow-two" })),
      store.prepare(request({ jobId: "overflow-three" })),
    ]);
    for (const lease of leases) {
      await store.retainSource(
        { repositoryDigest: lease.repositoryDigest, leaseId: lease.leaseId },
        lease.worktreeDir,
        "owner",
        Date.now() + 10_000,
      );
    }
    await Promise.all(leases.map((lease) => lease.release()));

    const fetchLock = join(dirname(dirname(leases[0]!.worktreeDir)), "fetch.lock");
    mkdirSync(fetchLock);
    for (const lease of leases) {
      await store.releaseSource(
        { repositoryDigest: lease.repositoryDigest, leaseId: lease.leaseId },
        "owner",
      );
    }
    rmSync(fetchLock, { recursive: true, force: true });
    await store.drainCleanup();

    expect(leases.every((lease) => !existsSync(lease.worktreeDir))).toBe(true);
    expect(fakeGit.refs.size).toBe(0);
  });

  it("continues the released-lease sweep after an early permanent failure", async () => {
    let injectFailure = false;
    let blockedWorktree = "";
    const store = createStore({
      cleanupQueueLimit: 1,
      cleanupRetryMs: 60_000,
      lockPollMs: 2,
      beforeQuarantine: (path) => {
        if (injectFailure && path === blockedWorktree) {
          throw new Error("early released lease failure");
        }
      },
    });
    const leases = await Promise.all([
      store.prepare(request({ jobId: "sweep-fairness-one" })),
      store.prepare(request({ jobId: "sweep-fairness-two" })),
      store.prepare(request({ jobId: "sweep-fairness-three" })),
    ]);
    for (const lease of leases) {
      await store.retainSource(
        { repositoryDigest: lease.repositoryDigest, leaseId: lease.leaseId },
        lease.worktreeDir,
        "sweep-owner",
        Date.now() + 10_000,
      );
    }
    await Promise.all(leases.map((lease) => lease.release()));

    const fetchLock = join(dirname(dirname(leases[0]!.worktreeDir)), "fetch.lock");
    mkdirSync(fetchLock, { mode: 0o700 });
    for (const lease of leases) {
      await store.releaseSource(
        { repositoryDigest: lease.repositoryDigest, leaseId: lease.leaseId },
        "sweep-owner",
      );
    }
    blockedWorktree = leases[0]!.worktreeDir;
    injectFailure = true;
    rmSync(fetchLock, { recursive: true, force: true });

    let cleanupFailure: unknown;
    try {
      await store.drainCleanup();
    } catch (error) {
      cleanupFailure = error;
    }
    expect(errorMessages(cleanupFailure)).toContain("early released lease failure");
    expect(existsSync(blockedWorktree)).toBe(true);
    expect(existsSync(leases[1]!.worktreeDir)).toBe(false);
    expect(existsSync(leases[2]!.worktreeDir)).toBe(false);

    injectFailure = false;
    await store.drainCleanup();
    expect(leases.every((lease) => !existsSync(lease.worktreeDir))).toBe(true);
  });

  it("streams every restart residue beyond the scanner batch and yields the event loop", async () => {
    const seedStore = createStore();
    const seed = await seedStore.prepare(request({ jobId: "restart-overflow-seed" }));
    const worktreesDir = dirname(seed.worktreeDir);
    await seed.release();
    await seedStore.drainCleanup();

    const residues: string[] = [];
    for (let index = 0; index < 35; index += 1) {
      const base = index.toString(16).padStart(64, "0");
      const livePath = join(worktreesDir, base);
      mkdirSync(livePath, { mode: 0o700 });
      writeFileSync(join(livePath, "residue.bin"), String(index));
      const identityDigest = cacheEntryIdentityDigest(claimPathForCleanup(livePath).identity);
      const residue = `${livePath}.meridian-cleanup-worktree-${index.toString(16).padStart(32, "0")}-${identityDigest}`;
      renameSync(livePath, residue);
      residues.push(residue);
    }

    let eventLoopTurn = false;
    let blocked = "";
    let injectFailure = true;
    const attempted = new Set<string>();
    setImmediate(() => { eventLoopTurn = true; });
    const restarted = createStore({
      cleanupQueueLimit: 1,
      cleanupRetryMs: 60_000,
      beforePhysicalCleanup: async ([path]) => {
        if (!path?.includes(".meridian-cleanup-worktree-")) return;
        attempted.add(path);
        blocked ||= path;
        if (injectFailure && path === blocked) throw new Error("early residue failure");
      },
    });
    await expect(restarted.scavenge({ maxLeaseAgeMs: 0, now: Date.now() }))
      .rejects.toThrow(/early residue failure/);

    expect(eventLoopTurn).toBe(true);
    expect(attempted.size).toBe(35);
    expect(residues.every((path) => !existsSync(path))).toBe(true);
    expect(existsSync(blocked)).toBe(true);

    injectFailure = false;
    await restarted.drainCleanup();
    expect(findEntryPaths(cacheRoot, (name) => (
      name.includes(".meridian-cleanup-worktree-")
    ))).toEqual([]);
  });

  it("continues all 35 scan entries after an exact pre-quarantine failure", async () => {
    const seedStore = createStore();
    const seed = await seedStore.prepare(request({ jobId: "pre-quarantine-scan-seed" }));
    const worktreesDir = dirname(seed.worktreeDir);
    await seed.release();
    await seedStore.drainCleanup();

    const residues: string[] = [];
    for (let index = 0; index < 35; index += 1) {
      const livePath = join(worktreesDir, (index + 100).toString(16).padStart(64, "0"));
      mkdirSync(livePath, { mode: 0o700 });
      writeFileSync(join(livePath, "residue.bin"), String(index));
      residues.push(createCleanupResidue(livePath, "worktree", index + 100));
    }

    let injectFailure = true;
    let failed = "";
    const attempted = new Set<string>();
    const restarted = createStore({
      beforeQuarantine: (path) => {
        if (!path.includes(".meridian-cleanup-worktree-")) return;
        attempted.add(path);
        if (injectFailure && !failed) {
          failed = path;
          throw new Error("exact pre-quarantine residue failure");
        }
      },
    });
    let failure: unknown;
    try {
      await restarted.scavenge({ maxLeaseAgeMs: 0, now: Date.now() });
    } catch (error) {
      failure = error;
    }

    expect(errorMessages(failure)).toContain("exact pre-quarantine residue failure");
    expect(attempted.size).toBe(35);
    expect(existsSync(failed)).toBe(true);
    expect(residues.filter((path) => path !== failed).every((path) => !existsSync(path))).toBe(true);

    injectFailure = false;
    await restarted.scavenge({ maxLeaseAgeMs: 0, now: Date.now() });
    expect(existsSync(failed)).toBe(false);
  });

  it("continues worktree, metadata, retention, and owner residue categories after lock failure", async () => {
    const seedStore = createStore();
    const seed = await seedStore.prepare(request({ jobId: "cross-category-residue-seed" }));
    const repositoryRoot = dirname(dirname(seed.worktreeDir));
    const worktreesDir = dirname(seed.worktreeDir);
    await seed.release();
    await seedStore.drainCleanup();

    const lockLive = join(repositoryRoot, "fetch.lock");
    mkdirSync(lockLive, { mode: 0o700 });
    const lockResidue = createCleanupResidue(lockLive, "lock", 201);
    const worktreeLive = join(worktreesDir, "a".repeat(64));
    mkdirSync(worktreeLive, { mode: 0o700 });
    const worktreeResidue = createCleanupResidue(worktreeLive, "worktree", 202);
    const metadataLive = join(repositoryRoot, "leases", `${"b".repeat(64)}.json`);
    writeFileSync(metadataLive, "metadata", { mode: 0o600 });
    const metadataResidue = createCleanupResidue(metadataLive, "metadata", 203);
    const retentionLive = join(repositoryRoot, "source-retentions", "c".repeat(64));
    mkdirSync(retentionLive, { recursive: true, mode: 0o700 });
    const retentionResidue = createCleanupResidue(retentionLive, "retention", 204);
    const ownerDir = join(repositoryRoot, "source-retentions", "d".repeat(64));
    mkdirSync(ownerDir, { mode: 0o700 });
    const ownerLive = join(ownerDir, `${"e".repeat(64)}.json`);
    writeFileSync(ownerLive, "owner", { mode: 0o600 });
    const ownerResidue = createCleanupResidue(ownerLive, "owner", 205);
    const laterResidues = [worktreeResidue, metadataResidue, retentionResidue, ownerResidue];
    const attempted = new Set<string>();
    let injectFailure = true;
    const restarted = createStore({
      beforeQuarantine: (path) => {
        if (path === lockResidue && injectFailure) {
          attempted.add(path);
          throw new Error("lock category residue failure");
        }
        if (laterResidues.includes(path)) attempted.add(path);
      },
    });
    let failure: unknown;
    try {
      await restarted.scavenge({ maxLeaseAgeMs: 0, now: Date.now() });
    } catch (error) {
      failure = error;
    }

    expect(errorMessages(failure)).toContain("lock category residue failure");
    expect(attempted).toEqual(new Set([lockResidue, ...laterResidues]));
    expect(existsSync(lockResidue)).toBe(true);
    expect(laterResidues.every((path) => !existsSync(path))).toBe(true);

    injectFailure = false;
    await restarted.scavenge({ maxLeaseAgeMs: 0, now: Date.now() });
    expect(existsSync(lockResidue)).toBe(false);
  });

  it("continues public scavenging into later repositories after an early repository failure", async () => {
    let blockedWorktree = "";
    let laterWorktree = "";
    let injectFailure = false;
    let laterAttempted = false;
    const store = createStore({
      beforeQuarantine: (path) => {
        if (path === laterWorktree) laterAttempted = true;
        if (injectFailure && path === blockedWorktree) {
          throw new Error("first repository scavenge failure");
        }
      },
    });
    const first = await store.prepare(request({
      repositoryKey: "tenant-a/org/first-repository",
      jobId: "first-repository",
    }));
    const second = await store.prepare(request({
      repositoryKey: "tenant-a/org/second-repository",
      jobId: "second-repository",
    }));
    blockedWorktree = first.worktreeDir;
    laterWorktree = second.worktreeDir;
    injectFailure = true;

    let failure: unknown;
    try {
      await store.scavenge({ maxLeaseAgeMs: 0, now: Date.now() + 1_000 });
    } catch (error) {
      failure = error;
    }

    expect(errorMessages(failure)).toContain("first repository scavenge failure");
    expect(laterAttempted).toBe(true);
    expect(existsSync(blockedWorktree)).toBe(true);
    expect(existsSync(laterWorktree)).toBe(false);

    injectFailure = false;
    await store.scavenge({ maxLeaseAgeMs: 0, now: Date.now() + 2_000 });
    expect(existsSync(blockedWorktree)).toBe(false);
    await Promise.all([first.release(), second.release()]);
  });

  it("does not suppress a residue error when the repository root disappears", async () => {
    const seedStore = createStore();
    const seed = await seedStore.prepare(request({ jobId: "disappearing-root-seed" }));
    const repositoryRoot = dirname(dirname(seed.worktreeDir));
    const repositoriesRoot = dirname(repositoryRoot);
    const livePath = join(dirname(seed.worktreeDir), "f".repeat(64));
    await seed.release();
    await seedStore.drainCleanup();
    mkdirSync(livePath, { mode: 0o700 });
    const residue = createCleanupResidue(livePath, "worktree", 301);

    const restarted = createStore({
      beforeQuarantine: (path) => {
        if (path !== residue) return;
        rmSync(repositoriesRoot, { recursive: true, force: true });
        throw new Error("residue failure before disappearing root");
      },
    });
    let failure: unknown;
    try {
      await restarted.scavenge({ maxLeaseAgeMs: 0, now: Date.now() });
    } catch (error) {
      failure = error;
    }

    expect(errorMessages(failure)).toContain("residue failure before disappearing root");
  });

  it("rejects pre-v2 lease metadata instead of deriving cleanup authority", async () => {
    const store = createStore();
    const lease = await store.prepare(request({ jobId: "legacy-lease-record" }));
    const metadata = join(dirname(dirname(lease.worktreeDir)), "leases", `${lease.leaseId}.json`);
    const record = JSON.parse(readFileSync(metadata, "utf8")) as Record<string, unknown>;
    record.formatVersion = 1;
    delete record.worktreeIdentity;
    writeFileSync(metadata, `${JSON.stringify(record)}\n`, { mode: 0o600 });

    await expect(lease.release()).rejects.toMatchObject({
      status: 409,
      message: "repository worktree lease metadata is incompatible",
    });
    expect(existsSync(lease.worktreeDir)).toBe(true);
  });

  it("binds a repository/security key to one credential-free remote", async () => {
    const store = createStore();
    const lease = await store.prepare(request());
    await lease.release();

    await expect(store.prepare(request({ remoteUrl: "https://github.com/other/repo.git" }))).rejects.toMatchObject({
      status: 409,
      message: "repository mirror key is already bound to a different remote",
    });
    await expect(store.prepare(request({
      remoteUrl: "https://token@github.com/org/repo.git",
    }))).rejects.toMatchObject({ status: 400 });
  });
});

function createStore(overrides: Partial<ConstructorParameters<typeof RepositoryMirrorStore>[0]> = {}) {
  return new RepositoryMirrorStore({
    cacheRoot,
    git: fakeGit.runner,
    gitLines: fakeGit.lineRunner,
    makeId: () => `test-id-${ids += 1}`,
    lockTimeoutMs: 2_000,
    ...overrides,
  });
}

function request(overrides: Partial<PrepareRepositoryWorktree> = {}): PrepareRepositoryWorktree {
  return {
    repositoryKey: "tenant-a/org/repo",
    remoteUrl: "https://github.com/org/repo.git",
    head: { ref: HEAD_REF, oid: HEAD },
    base: { ref: BASE_REF, oid: BASE },
    ...overrides,
  };
}

interface GitCall {
  args: string[];
  options: RepositoryGitOptions;
}

class FakeGit {
  readonly calls: GitCall[] = [];
  readonly lineCalls: GitCall[] = [];
  readonly refs = new Map<string, string>();
  readonly worktreeHeads = new Map<string, string>();
  readonly mirrorRemotes = new Map<string, string>();
  readonly objects: Set<string>;
  activeFetches = 0;
  maxActiveFetches = 0;
  activeWorktreeAdds = 0;
  maxActiveWorktreeAdds = 0;
  activeResets = 0;
  maxActiveResets = 0;
  fetchDelayMs = 0;
  worktreeAddDelayMs = 0;
  resetDelayMs = 0;
  fetchGate?: Promise<void>;
  onFetchStart?: () => void;

  constructor(readonly remoteRefs: Map<string, string>) {
    this.objects = new Set(remoteRefs.values());
  }

  readonly lineRunner: RepositoryGitLineRunner = async (readonlyArgs, options, consume) => {
    const args = [...readonlyArgs];
    this.lineCalls.push({ args, options: { ...options } });
    if (args[0] !== "for-each-ref") {
      throw new Error(`unhandled fake streaming git command: ${args.join(" ")}`);
    }
    const prefix = `${options.cwd}\0`;
    for (const key of this.refs.keys()) {
      if (!key.startsWith(prefix)) continue;
      await consume(key.slice(prefix.length));
    }
  };

  readonly runner: RepositoryGitRunner = async (readonlyArgs, options) => {
    const args = [...readonlyArgs];
    this.calls.push({ args, options: { ...options } });
    const command = args[0];

    if (command === "init") return "";
    if (command === "config") {
      if (args[1] === "--get" && args[2] === "remote.origin.url") {
        return `${this.mirrorRemotes.get(options.cwd) ?? ""}\n`;
      }
      if (args[1] === "remote.origin.url" && args[2]) this.mirrorRemotes.set(options.cwd, args[2]);
      return "";
    }
    if (command === "fetch") {
      this.activeFetches += 1;
      this.maxActiveFetches = Math.max(this.maxActiveFetches, this.activeFetches);
      this.onFetchStart?.();
      try {
        if (this.fetchDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.fetchDelayMs));
        await this.fetchGate;
        for (const refspec of args.filter((arg) => arg.startsWith("+"))) {
          const separator = refspec.indexOf(":");
          const source = refspec.slice(1, separator);
          const destination = refspec.slice(separator + 1);
          const oid = this.remoteRefs.get(source);
          if (!oid) throw new Error(`missing fake remote ref: ${source}`);
          this.objects.add(oid);
          this.refs.set(refKey(options.cwd, destination), oid);
        }
      } finally {
        this.activeFetches -= 1;
      }
      return "";
    }
    if (command === "rev-parse") {
      if (args[1] === "--is-bare-repository") return "true\n";
      const ref = args[1]?.replace(/\^\{commit\}$/, "");
      if (ref === "HEAD") return `${this.worktreeHeads.get(options.cwd) ?? ""}\n`;
      if (ref && this.objects.has(ref.toLowerCase())) return `${ref.toLowerCase()}\n`;
      return `${this.refs.get(refKey(options.cwd, ref ?? "")) ?? ""}\n`;
    }
    if (command === "worktree" && args[1] === "add") {
      this.activeWorktreeAdds += 1;
      this.maxActiveWorktreeAdds = Math.max(this.maxActiveWorktreeAdds, this.activeWorktreeAdds);
      try {
        if (this.worktreeAddDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, this.worktreeAddDelayMs));
        }
        const worktreeDir = args[4]!;
        const headRef = args[5]!;
        const oid = this.refs.get(refKey(options.cwd, headRef));
        if (!oid) throw new Error(`missing fake head ref: ${headRef}`);
        mkdirSync(worktreeDir, { recursive: true });
        this.worktreeHeads.set(worktreeDir, oid);
        return "";
      } finally {
        this.activeWorktreeAdds -= 1;
      }
    }
    if (command === "reset") {
      this.activeResets += 1;
      this.maxActiveResets = Math.max(this.maxActiveResets, this.activeResets);
      try {
        if (this.resetDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.resetDelayMs));
        const oid = this.worktreeHeads.get(options.cwd);
        if (!oid) throw new Error(`missing fake worktree head: ${options.cwd}`);
        writeFileSync(join(options.cwd, "source.ts"), `export const commit = "${oid}";\n`);
        return "";
      } finally {
        this.activeResets -= 1;
      }
    }
    if (command === "worktree" && args[1] === "remove") {
      this.worktreeHeads.delete(args[3]!);
      return "";
    }
    if (command === "worktree" && args[1] === "prune") {
      for (const worktree of this.worktreeHeads.keys()) {
        if (!existsSync(worktree)) this.worktreeHeads.delete(worktree);
      }
      return "";
    }
    if (command === "update-ref") {
      if (args[1] === "-d") {
        this.refs.delete(refKey(options.cwd, args[2]!));
        return "";
      }
      const ref = args[1]!;
      const oid = args[2]!;
      const expectedOld = args[3];
      if (!this.objects.has(oid)) throw new Error(`missing fake object: ${oid}`);
      if (expectedOld && !/^0+$/.test(expectedOld)) throw new Error(`unexpected old oid: ${expectedOld}`);
      const key = refKey(options.cwd, ref);
      if (expectedOld && this.refs.has(key)) throw new Error(`fake ref already exists: ${ref}`);
      this.refs.set(key, oid);
      return "";
    }
    throw new Error(`unhandled fake git command: ${args.join(" ")}`);
  };
}

function refKey(cwd: string, ref: string): string {
  return `${cwd}\0${ref}`;
}

function mirrorCwd(git: FakeGit): string {
  const cwd = git.mirrorRemotes.keys().next().value as string | undefined;
  if (!cwd) throw new Error("fake mirror was not initialized");
  return cwd;
}

function allFileContents(root: string): string[] {
  const contents: string[] = [];
  const visit = (path: string): void => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) visit(child);
      else if (entry.isFile()) contents.push(readFileSync(child, "utf8"));
    }
  };
  visit(root);
  return contents;
}

function findNames(root: string, name: string): string[] {
  const matches: string[] = [];
  const visit = (path: string): void => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const child = join(path, entry.name);
      if (entry.name === name) matches.push(child);
      visit(child);
    }
  };
  visit(root);
  return matches;
}

function findEntryPaths(root: string, accepts: (name: string) => boolean): string[] {
  const matches: string[] = [];
  const visit = (path: string): void => {
    if (!existsSync(path)) return;
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (accepts(entry.name)) matches.push(child);
      if (entry.isDirectory() && !entry.isSymbolicLink()) visit(child);
    }
  };
  visit(root);
  return matches;
}

function errorMessages(error: unknown): string[] {
  if (!(error instanceof Error)) return [String(error)];
  const messages = [error.message];
  if (error instanceof AggregateError) {
    for (const nested of error.errors) messages.push(...errorMessages(nested));
  }
  return messages;
}

function createCleanupResidue(
  livePath: string,
  kind: "lock" | "worktree" | "metadata" | "retention" | "owner",
  nonce: number,
): string {
  const identityDigest = cacheEntryIdentityDigest(claimPathForCleanup(livePath).identity);
  const residue = `${livePath}.meridian-cleanup-${kind}-${nonce.toString(16).padStart(32, "0")}-${identityDigest}`;
  renameSync(livePath, residue);
  return residue;
}

function populateDeepTree(root: string): void {
  let deepest = root;
  for (let depth = 0; depth < 64; depth += 1) deepest = join(deepest, `level-${depth}`);
  mkdirSync(deepest, { recursive: true });
  for (let index = 0; index < 256; index += 1) {
    writeFileSync(join(deepest, `${index}.bin`), Buffer.alloc(128, index));
  }
}

function deferred<T>() {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolve) => { resolvePromise = resolve; });
  return { promise, resolve: resolvePromise };
}
