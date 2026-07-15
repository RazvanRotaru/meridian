import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  RepositoryMirrorStore,
  type PrepareRepositoryWorktree,
  type RepositoryGitOptions,
  type RepositoryGitRunner,
} from "./repository-mirror";

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
    if (command === "worktree" && args[1] === "prune") return "";
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
    if (command === "for-each-ref") {
      const prefix = `${options.cwd}\0`;
      return [...this.refs.keys()]
        .filter((key) => key.startsWith(prefix))
        .map((key) => key.slice(prefix.length))
        .join("\n");
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

function deferred<T>() {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolve) => { resolvePromise = resolve; });
  return { promise, resolve: resolvePromise };
}
