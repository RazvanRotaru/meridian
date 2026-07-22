import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { base64Auth, runGit } from "../src/server/git-exec";
import {
  WebRepositoryMirror,
  repositoryKeyFor,
  type PreparedPullRequest,
} from "../src/server/web-repository-mirror";

interface GitFixture {
  baseSha: string;
  cacheRoot: string;
  headSha: string;
  remoteDir: string;
  remoteUrl: string;
  root: string;
  workDir: string;
}

let fixture: GitFixture;
let mirrors: WebRepositoryMirror[];

beforeEach(() => {
  fixture = createFixture();
  mirrors = [];
}, 30_000);

afterEach(async () => {
  await Promise.all(mirrors.map((mirror) => mirror.close()));
  rmSync(fixture.root, { recursive: true, force: true });
}, 30_000);

// These are real-Git integration tests. Parallel CI load can make several partial fetch/worktree
// operations exceed Vitest's unit-test default even though every Git call has its own production
// timeout and cancellation coverage.
describe("WebRepositoryMirror", { timeout: 30_000 }, () => {
  it("derives one versioned repository identity from the credential-free remote URL", () => {
    expect(repositoryKeyFor(fixture.remoteUrl)).toMatch(/^[a-f0-9]{24}$/);
    expect(repositoryKeyFor(fixture.remoteUrl)).toBe(repositoryKeyFor(fixture.remoteUrl));
    expect(repositoryKeyFor(`${fixture.remoteUrl}other`)).not.toBe(repositoryKeyFor(fixture.remoteUrl));
    expect(repositoryKeyFor("https://github.com/UiPath/Autopilot"))
      .toBe(repositoryKeyFor("https://github.com/uipath/autopilot.git/"));
  });

  it("initializes and reacquires a SHA-256 mirror in the remote object format", async () => {
    const sha256 = createFixture("sha256");
    const first = new WebRepositoryMirror({
      cacheRoot: sha256.cacheRoot,
      allowFileRemotesForTests: true,
    });
    const restarted = new WebRepositoryMirror({
      cacheRoot: sha256.cacheRoot,
      allowFileRemotesForTests: true,
    });
    mirrors.push(first, restarted);
    try {
      expect(sha256.baseSha).toHaveLength(64);
      const created = await first.acquireWorkspace({
        remoteUrl: sha256.remoteUrl,
        revision: { remoteRef: "refs/heads/main", expectedSha: sha256.baseSha },
      });
      expect(created.cache).toBe("miss");
      created.release();

      const cached = await restarted.acquireCachedWorkspace({
        remoteUrl: sha256.remoteUrl,
        expectedSha: sha256.baseSha,
      });
      expect(cached?.cache).toBe("hit");
      expect(git(cached!.repoDir, "rev-parse", "HEAD")).toBe(sha256.baseSha);
      expect(git(join(repositoryEntryFor(sha256), "mirror.git"), "rev-parse", "--show-object-format"))
        .toBe("sha256");
      cached?.release();
    } finally {
      rmSync(sha256.root, { recursive: true, force: true });
    }
  });

  it.each([
    "HEAD",
    "refs/heads/feature+picker@team",
    "refs/heads/release/$next",
    "refs/heads/unicode/ramură",
    "refs/tags/v1+picker@team$",
  ])("preserves Git-valid remote selector %s", async (remoteRef) => {
    const mirror = createMirror({ cacheRoot: join(fixture.root, `selector-${mirrors.length}`) });
    const lease = await mirror.acquireWorkspace({
      remoteUrl: fixture.remoteUrl,
      revision: { remoteRef, expectedSha: fixture.baseSha },
    });

    expect(git(lease.repoDir, "rev-parse", "HEAD")).toBe(fixture.baseSha);
    lease.release();
  });

  it("keeps a cache probe non-mutating when the exact workspace is absent", async () => {
    const mirror = createMirror();
    const missing = await mirror.acquireCachedWorkspace({
      remoteUrl: fixture.remoteUrl,
      expectedSha: "f".repeat(40),
    });

    expect(missing).toBeNull();
    expect(existsSync(join(fixture.cacheRoot, "repository-store-v1"))).toBe(false);
  });

  it("rejects query and fragment credentials before creating persistent state", async () => {
    const mirror = createMirror();
    const revision = { remoteRef: "refs/heads/main", expectedSha: fixture.baseSha };

    await expect(mirror.acquireWorkspace({
      remoteUrl: "https://example.test/repo.git?access_token=secret",
      revision,
    })).rejects.toMatchObject({ status: 400 });
    await expect(mirror.acquireWorkspace({
      remoteUrl: "https://example.test/repo.git#credential",
      revision,
    })).rejects.toMatchObject({ status: 400 });
    expect(existsSync(join(fixture.cacheRoot, "repository-store-v1"))).toBe(false);
  });

  it("singleflights one stable exact-SHA workspace across callers and mirror instances", async () => {
    const firstMirror = createMirror();
    const secondMirror = createMirror();
    const firstFetched = vi.fn();
    const secondFetched = vi.fn();
    const firstMiss = vi.fn();
    const secondMiss = vi.fn();
    const revision = { remoteRef: "refs/heads/main", expectedSha: fixture.baseSha };

    const [first, second] = await Promise.all([
      firstMirror.acquireWorkspace({
        remoteUrl: fixture.remoteUrl,
        revision,
        onCacheMiss: firstMiss,
        onFetchComplete: firstFetched,
      }),
      secondMirror.acquireWorkspace({
        remoteUrl: fixture.remoteUrl,
        revision,
        onCacheMiss: secondMiss,
        onFetchComplete: secondFetched,
      }),
    ]);

    expect(first.repoDir).toBe(second.repoDir);
    expect(first.commit).toBe(fixture.baseSha);
    expect(git(first.repoDir, "rev-parse", "HEAD")).toBe(fixture.baseSha);
    expect(git(first.repoDir, "status", "--porcelain=v1", "--untracked-files=all")).toBe("");
    const mirrorDir = join(repositoryEntryFor(fixture), "mirror.git");
    expect(git(mirrorDir, "config", "--get", "remote.origin.promisor")).toBe("true");
    expect(git(mirrorDir, "config", "--get", "remote.origin.partialclonefilter")).toBe("blob:none");
    expect(git(mirrorDir, "config", "--get", "core.longpaths")).toBe("true");
    expect(firstFetched.mock.calls.length + secondFetched.mock.calls.length).toBe(1);
    expect(firstMiss.mock.calls.length + secondMiss.mock.calls.length).toBe(1);
    expect([first.cache, second.cache].sort()).toEqual(["hit", "miss"]);
    const registeredWorktrees = worktreePaths(first.repoDir);
    expect(registeredWorktrees).toContain(realpathSync(first.repoDir));
    expect(
      registeredWorktrees.filter((worktreePath) => worktreePath.endsWith("/repo")),
    ).toEqual([realpathSync(first.repoDir)]);

    first.release();
    first.release();
    second.release();
    const restarted = createMirror();
    const cached = await restarted.acquireCachedWorkspace({
      remoteUrl: fixture.remoteUrl,
      expectedSha: fixture.baseSha,
    });
    expect(cached?.repoDir).toBe(first.repoDir);
    cached?.release();
  });

  it("uses opaque target refs, validates the preflight SHA, and never writes FETCH_HEAD", async () => {
    const mirror = createMirror();

    await expect(mirror.acquireWorkspace({
      remoteUrl: fixture.remoteUrl,
      revision: { remoteRef: "refs/pull/41/head", expectedSha: fixture.baseSha },
    })).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("remote revision changed"),
    });

    const repositoryEntry = repositoryEntryFor(fixture);
    const mirrorDir = join(repositoryEntry, "mirror.git");
    expect(existsSync(join(mirrorDir, "FETCH_HEAD"))).toBe(false);
    expect(git(mirrorDir, "for-each-ref", "--format=%(refname)", "refs/meridian")).toBe("");
    expect(existsSync(join(repositoryEntry, "workspaces"))).toBe(false);
  });

  it("keeps verified snapshot refs immutable when a remote ref moves during preparation", async () => {
    const mirror = createMirror();
    const prepared = await prepareFixturePullRequest(mirror);
    prepared.release();
    await prepared.discard();
    const mirrorDir = join(repositoryEntryFor(fixture), "mirror.git");
    const snapshotsBefore = git(
      mirrorDir,
      "for-each-ref",
      "--format=%(refname) %(objectname)",
      "refs/meridian/snapshots",
    );

    writeFileSync(join(fixture.workDir, "moved.ts"), "export const moved = true;\n");
    git(fixture.workDir, "add", "moved.ts");
    git(fixture.workDir, "commit", "-m", "move pull request head");
    git(fixture.workDir, "push", "--force", "origin", "HEAD:refs/pull/41/head");

    await expect(prepareFixturePullRequest(mirror)).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("remote revision changed"),
    });
    expect(git(
      mirrorDir,
      "for-each-ref",
      "--format=%(refname) %(objectname)",
      "refs/meridian/snapshots",
    )).toBe(snapshotsBefore);
    expect(git(mirrorDir, "for-each-ref", "--format=%(refname)", "refs/meridian/incoming")).toBe("");
  });

  it("keeps ordinary fetches shallow and expands history only when PR comparison needs it", async () => {
    const gitCalls: string[][] = [];
    const mirror = createMirror({
      git: async (args, options) => {
        gitCalls.push(args);
        return runGit(args, options);
      },
    });
    const ordinary = await mirror.acquireWorkspace({
      remoteUrl: fixture.remoteUrl,
      revision: { remoteRef: "refs/pull/41/head", expectedSha: fixture.headSha },
    });
    ordinary.release();
    const mirrorDir = join(repositoryEntryFor(fixture), "mirror.git");

    expect(git(mirrorDir, "rev-parse", "--is-shallow-repository")).toBe("true");
    expect(gitCalls.some((args) => args[0] === "fetch" && args.includes("--depth=1"))).toBe(true);
    gitCalls.length = 0;

    const prepared = await prepareFixturePullRequest(mirror);

    expect(prepared.mergeBaseSha).toBe(fixture.baseSha);
    expect(git(mirrorDir, "rev-parse", "--is-shallow-repository")).toBe("false");
    expect(gitCalls.some((args) => args[0] === "fetch" && args.includes("--unshallow"))).toBe(true);
    gitCalls.length = 0;

    // Promotion is monotonic while an already-prepared PR can still be analyzed outside the lock.
    writeFileSync(join(fixture.workDir, "later.ts"), "export const later = true;\n");
    git(fixture.workDir, "add", "later.ts");
    git(fixture.workDir, "commit", "-m", "later ordinary revision");
    const laterSha = git(fixture.workDir, "rev-parse", "HEAD");
    git(fixture.workDir, "push", "origin", "HEAD:refs/heads/later");
    const later = await mirror.acquireWorkspace({
      remoteUrl: fixture.remoteUrl,
      revision: { remoteRef: "refs/heads/later", expectedSha: laterSha },
    });

    expect(gitCalls.some((args) => args[0] === "fetch" && args.includes("--depth=1"))).toBe(false);
    expect(git(mirrorDir, "rev-parse", "--is-shallow-repository")).toBe("false");
    expect(git(mirrorDir, "merge-base", prepared.baseSha, prepared.headSha)).toBe(prepared.mergeBaseSha);
    later.release();
    await prepared.discard();
  });

  it("preserves the previous base-to-head merge-base selection for criss-cross histories", async () => {
    const mirror = createMirror();
    const crissCross = createCrissCrossRefs(fixture);
    const all = git(fixture.workDir, "merge-base", "--all", crissCross.baseSha, crissCross.headSha)
      .split("\n");
    expect(all).toHaveLength(2);
    const selected = git(fixture.workDir, "merge-base", crissCross.baseSha, crissCross.headSha);

    const prepared = await mirror.preparePullRequest({
      remoteUrl: fixture.remoteUrl,
      base: { remoteRef: "refs/heads/criss-base", expectedSha: crissCross.baseSha },
      head: { remoteRef: "refs/heads/criss-head", expectedSha: crissCross.headSha },
    });

    expect(prepared.mergeBaseSha).toBe(selected);
    await prepared.discard();
  });

  it("creates unique PR generations over one mirror and reacquires them without fetching", async () => {
    const mirror = createMirror();
    const firstFetched = vi.fn();
    const request = {
      remoteUrl: fixture.remoteUrl,
      base: { remoteRef: "refs/heads/main", expectedSha: fixture.baseSha },
      head: { remoteRef: "refs/pull/41/head", expectedSha: fixture.headSha },
    };
    const first = await mirror.preparePullRequest({ ...request, onFetchComplete: firstFetched });
    const second = await mirror.preparePullRequest(request);

    expect(first.workspaceId).toMatch(/^[a-f0-9]{32}$/);
    expect(second.workspaceId).toMatch(/^[a-f0-9]{32}$/);
    expect(first.workspaceId).not.toBe(second.workspaceId);
    expect(first.head.repoDir).not.toBe(second.head.repoDir);
    expect(first.comparison.repoDir).not.toBe(second.comparison.repoDir);
    expect(first.headSha).toBe(fixture.headSha);
    expect(first.baseSha).toBe(fixture.baseSha);
    expect(first.mergeBaseSha).toBe(fixture.baseSha);
    expect(git(first.head.repoDir, "rev-parse", "HEAD")).toBe(fixture.headSha);
    expect(git(first.comparison.repoDir, "rev-parse", "HEAD")).toBe(fixture.baseSha);
    expect(firstFetched).toHaveBeenCalledTimes(1);

    // Whole-subtree review handling is allowed to add empty directories, but generations never
    // share a physical side and Git still considers the exact-SHA source clean.
    mkdirSync(join(first.head.repoDir, "packages", "new-app"), { recursive: true });
    expect(existsSync(join(second.head.repoDir, "packages", "new-app"))).toBe(false);
    first.release();
    second.release();

    const restarted = createMirror();
    const cached = await restarted.acquirePreparedPullRequest({
      repositoryKey: first.repositoryKey,
      remoteUrl: first.remoteUrl,
      workspaceId: first.workspaceId,
      baseSha: first.baseSha,
      headSha: first.headSha,
      mergeBaseSha: first.mergeBaseSha,
    });
    expect(cached).not.toBeNull();
    expect(cached?.baseSha).toBe(fixture.baseSha);
    expect(cached?.head.repoDir).toBe(first.head.repoDir);
    cached?.release();

    await first.discard();
    await first.discard();
    expect(existsSync(dirname(first.head.repoDir))).toBe(false);
    expect(worktreePaths(second.head.repoDir)).not.toContain(first.head.repoDir);
    await second.discard();
  });

  it("reacquires exact published PR workspaces without a full-tree status scan", async () => {
    const gitCalls: string[][] = [];
    const mirror = createMirror({
      git: async (args, options) => {
        gitCalls.push(args);
        return runGit(args, options);
      },
    });
    const prepared = await prepareFixturePullRequest(mirror);
    prepared.release();
    gitCalls.length = 0;

    const cached = await mirror.acquirePreparedPullRequest({
      repositoryKey: prepared.repositoryKey,
      remoteUrl: prepared.remoteUrl,
      workspaceId: prepared.workspaceId,
      baseSha: prepared.baseSha,
      headSha: prepared.headSha,
      mergeBaseSha: prepared.mergeBaseSha,
    });

    expect(cached).not.toBeNull();
    expect(gitCalls.filter(([command]) => command === "rev-parse")).toHaveLength(2);
    expect(gitCalls.some((args) => args.includes("status"))).toBe(false);
    cached?.release();
    await prepared.discard();
  });

  it("rejects a prepared side whose exact HEAD moved without deleting it", async () => {
    const mirror = createMirror();
    const prepared = await prepareFixturePullRequest(mirror);
    prepared.release();
    git(prepared.head.repoDir, "checkout", "--detach", fixture.baseSha);

    const cached = await mirror.acquirePreparedPullRequest({
      repositoryKey: prepared.repositoryKey,
      remoteUrl: prepared.remoteUrl,
      workspaceId: prepared.workspaceId,
      baseSha: prepared.baseSha,
      headSha: prepared.headSha,
      mergeBaseSha: prepared.mergeBaseSha,
    });

    expect(cached).toBeNull();
    expect(existsSync(prepared.head.repoDir)).toBe(true);
    git(prepared.head.repoDir, "checkout", "--detach", prepared.headSha);
    await prepared.discard();
  });

  it("does not persist the raw or encoded credential in mirror, workspace, refs, or metadata", async () => {
    const token = "secret-mirror-token-value";
    const gitCalls: Array<{ args: string[]; token: string | undefined }> = [];
    const mirror = createMirror({
      git: async (args, options) => {
        gitCalls.push({ args, token: options.token });
        return runGit(args, options);
      },
    });
    const lease = await mirror.acquireWorkspace({
      remoteUrl: fixture.remoteUrl,
      revision: { remoteRef: "refs/heads/main", expectedSha: fixture.baseSha },
      token,
    });
    lease.release();

    const bytes = allFileBytes(join(fixture.cacheRoot, "repository-store-v1"));
    expect(bytes.includes(Buffer.from(token))).toBe(false);
    expect(bytes.includes(Buffer.from(base64Auth(token)))).toBe(false);
    const config = readFileSync(join(repositoryEntryFor(fixture), "mirror.git", "config"), "utf8");
    expect(config).toContain(fixture.remoteUrl);
    expect(config.toLowerCase()).not.toContain("extraheader");
    expect(gitCalls.filter(({ args }) => args[0] === "fetch")).toEqual([
      expect.objectContaining({ token }),
    ]);
    expect(gitCalls.filter(({ args }) => args[0] === "worktree" && args[1] === "add")).toEqual([
      expect.objectContaining({ token }),
    ]);
    expect(gitCalls.filter(({ args }) => args[0] === "checkout")).toEqual([
      expect.objectContaining({ token }),
    ]);
  });

  it("rolls back both Git worktrees when cancellation interrupts PR checkout", async () => {
    const controller = new AbortController();
    let checkoutCalls = 0;
    const mirror = createMirror({
      git: async (args, options) => {
        if (args[0] === "checkout" && ++checkoutCalls === 2) {
          controller.abort(new Error("caller left during comparison checkout"));
        }
        return runGit(args, options);
      },
    });

    await expect(mirror.preparePullRequest({
      remoteUrl: fixture.remoteUrl,
      base: { remoteRef: "refs/heads/main", expectedSha: fixture.baseSha },
      head: { remoteRef: "refs/pull/41/head", expectedSha: fixture.headSha },
      signal: controller.signal,
    })).rejects.toThrow("git operation was cancelled");

    const repositoryEntry = repositoryEntryFor(fixture);
    const mirrorDir = join(repositoryEntry, "mirror.git");
    const pullRequests = join(repositoryEntry, "workspaces", "pull-requests");
    expect(controller.signal.aborted).toBe(true);
    expect(existsSync(pullRequests) ? readdirSync(pullRequests) : []).toEqual([]);
    expect(worktreePaths(mirrorDir).filter((path) => path.includes("/pull-requests/"))).toEqual([]);
    expect(git(mirrorDir, "for-each-ref", "--format=%(refname)", "refs/meridian/incoming")).toBe("");
  });

  it("discards a completed PR generation when cancellation wins the final handoff", async () => {
    const controller = new AbortController();
    const mirror = createMirror({
      git: async (args, options) => {
        const output = await runGit(args, options);
        if (args[0] === "rev-parse" && args[1] === "HEAD" && basename(options.cwd) === "comparison") {
          controller.abort(new Error("caller left after final validation"));
        }
        return output;
      },
    });

    await expect(mirror.preparePullRequest({
      remoteUrl: fixture.remoteUrl,
      base: { remoteRef: "refs/heads/main", expectedSha: fixture.baseSha },
      head: { remoteRef: "refs/pull/41/head", expectedSha: fixture.headSha },
      signal: controller.signal,
    })).rejects.toThrow("operation was cancelled");

    const repositoryEntry = repositoryEntryFor(fixture);
    const mirrorDir = join(repositoryEntry, "mirror.git");
    const pullRequests = join(repositoryEntry, "workspaces", "pull-requests");
    expect(existsSync(pullRequests) ? readdirSync(pullRequests) : []).toEqual([]);
    expect(worktreePaths(mirrorDir).filter((path) => path.includes("/pull-requests/"))).toEqual([]);
  });

  it("releases a cached commit lease when cancellation wins the final handoff", async () => {
    const seed = createMirror();
    const created = await seed.acquireWorkspace({
      remoteUrl: fixture.remoteUrl,
      revision: { remoteRef: "refs/heads/main", expectedSha: fixture.baseSha },
    });
    const repoDir = created.repoDir;
    created.release();

    const controller = new AbortController();
    const restarted = createMirror({
      git: async (args, options) => {
        const output = await runGit(args, options);
        if (args[0] === "rev-parse" && args[1] === "HEAD" && options.cwd === repoDir) {
          controller.abort(new Error("caller left after cached commit validation"));
        }
        return output;
      },
    });

    await expect(restarted.acquireCachedWorkspace({
      remoteUrl: fixture.remoteUrl,
      expectedSha: fixture.baseSha,
      signal: controller.signal,
    })).rejects.toThrow("operation was cancelled");

    expect(readdirSync(join(dirname(repoDir), ".leases"))).toEqual([]);
    const reacquired = await seed.acquireCachedWorkspace({
      remoteUrl: fixture.remoteUrl,
      expectedSha: fixture.baseSha,
    });
    expect(reacquired).not.toBeNull();
    reacquired?.release();
  });

  it("releases cached PR leases when cancellation wins the final handoff", async () => {
    const seed = createMirror();
    const published = await prepareFixturePullRequest(seed);
    published.release();
    const controller = new AbortController();
    const restarted = createMirror({
      git: async (args, options) => {
        const output = await runGit(args, options);
        if (
          args[0] === "rev-parse"
          && args[1] === "HEAD"
          && options.cwd === published.comparison.repoDir
        ) {
          controller.abort(new Error("caller left after cached PR validation"));
        }
        return output;
      },
    });

    await expect(restarted.acquirePreparedPullRequest({
      repositoryKey: published.repositoryKey,
      remoteUrl: published.remoteUrl,
      workspaceId: published.workspaceId,
      baseSha: published.baseSha,
      headSha: published.headSha,
      mergeBaseSha: published.mergeBaseSha,
      signal: controller.signal,
    })).rejects.toThrow("operation was cancelled");

    expect(readdirSync(join(dirname(published.head.repoDir), ".leases"))).toEqual([]);
    expect(readdirSync(join(dirname(published.comparison.repoDir), ".leases"))).toEqual([]);
    const reacquired = await seed.acquirePreparedPullRequest({
      repositoryKey: published.repositoryKey,
      remoteUrl: published.remoteUrl,
      workspaceId: published.workspaceId,
      baseSha: published.baseSha,
      headSha: published.headSha,
      mergeBaseSha: published.mergeBaseSha,
    });
    expect(reacquired).not.toBeNull();
    reacquired?.release();
    await published.discard();
  });

  it("prevents another process from repairing a workspace while its durable lease is held", async () => {
    const firstMirror = createMirror();
    const secondMirror = createMirror();
    const revision = { remoteRef: "refs/heads/main", expectedSha: fixture.baseSha };
    const held = await firstMirror.acquireWorkspace({ remoteUrl: fixture.remoteUrl, revision });
    const metadata = join(dirname(held.repoDir), "metadata.json");
    writeFileSync(metadata, "{\"corrupt\":true}\n");

    await expect(secondMirror.acquireWorkspace({
      remoteUrl: fixture.remoteUrl,
      revision,
    })).rejects.toMatchObject({ status: 409 });
    expect(existsSync(held.repoDir)).toBe(true);
    expect(git(held.repoDir, "rev-parse", "HEAD")).toBe(fixture.baseSha);

    held.release();
    const repaired = await secondMirror.acquireWorkspace({ remoteUrl: fixture.remoteUrl, revision });
    expect(repaired.cache).toBe("miss");
    expect(git(repaired.repoDir, "rev-parse", "HEAD")).toBe(fixture.baseSha);
    repaired.release();
  });

  it("sweeps crash-left incoming refs and incomplete PR worktrees under the next lock", async () => {
    const gitCalls: string[][] = [];
    const mirror = createMirror({
      git: async (args, options) => {
        gitCalls.push(args);
        return runGit(args, options);
      },
    });
    const stable = await mirror.acquireWorkspace({
      remoteUrl: fixture.remoteUrl,
      revision: { remoteRef: "refs/heads/main", expectedSha: fixture.baseSha },
    });
    stable.release();
    const repositoryEntry = repositoryEntryFor(fixture);
    const mirrorDir = join(repositoryEntry, "mirror.git");
    const orphanRoot = join(repositoryEntry, "workspaces", "pull-requests", "f".repeat(32));
    const orphanHead = join(orphanRoot, "head");
    const historicalRoot = join(repositoryEntry, "workspaces", "pull-requests", "d".repeat(32));
    mkdirSync(orphanRoot, { recursive: true });
    mkdirSync(historicalRoot, { recursive: true });
    writeFileSync(join(historicalRoot, "unrelated"), "must not be scanned");
    writeFileSync(join(repositoryEntry, "pending.json"), `${JSON.stringify({
      formatVersion: 1,
      incomingCount: 2,
      kind: "pull-request-workspace",
      operationId: "f".repeat(32),
      repositoryKey: repositoryKeyFor(fixture.remoteUrl),
      workspaceId: "f".repeat(32),
    })}\n`);
    git(mirrorDir, "update-ref", `refs/meridian/incoming/${"f".repeat(32)}/0`, fixture.baseSha);
    git(mirrorDir, "worktree", "add", "--detach", "--no-checkout", orphanHead, fixture.headSha);
    gitCalls.length = 0;

    const prepared = await prepareFixturePullRequest(mirror);

    expect(existsSync(orphanRoot)).toBe(false);
    expect(existsSync(historicalRoot)).toBe(true);
    expect(git(
      mirrorDir,
      "for-each-ref",
      "--format=%(refname)",
      `refs/meridian/incoming/${"f".repeat(32)}/0`,
    )).toBe("");
    expect(gitCalls.some((args) => args[0] === "for-each-ref")).toBe(false);
    expect(worktreePaths(mirrorDir)).not.toContain(orphanHead);
    await prepared.discard();
  });

  it("preserves a completely published commit when recovering its final journal boundary", async () => {
    const mirror = createMirror();
    const stable = await mirror.acquireWorkspace({
      remoteUrl: fixture.remoteUrl,
      revision: { remoteRef: "refs/heads/main", expectedSha: fixture.baseSha },
    });
    const stableDir = stable.repoDir;
    stable.release();
    const repositoryEntry = repositoryEntryFor(fixture);
    writeFileSync(join(repositoryEntry, "pending.json"), `${JSON.stringify({
      formatVersion: 1,
      incomingCount: 1,
      kind: "commit-workspace",
      operationId: "c".repeat(32),
      repositoryKey: repositoryKeyFor(fixture.remoteUrl),
      commit: fixture.baseSha,
    })}\n`);

    const prepared = await prepareFixturePullRequest(mirror);

    expect(existsSync(join(repositoryEntry, "pending.json"))).toBe(false);
    expect(existsSync(stableDir)).toBe(true);
    expect(git(stableDir, "rev-parse", "HEAD")).toBe(fixture.baseSha);
    await prepared.discard();
  });

  it("keeps the journal discoverable until temporary-ref cleanup succeeds", async () => {
    let deleteFailures = 0;
    const failing = createMirror({
      git: async (args, options) => {
        if (args[0] === "update-ref" && args[1] === "-d" && deleteFailures < 2) {
          deleteFailures += 1;
          throw new Error("injected ref cleanup failure");
        }
        return runGit(args, options);
      },
    });

    await expect(failing.acquireWorkspace({
      remoteUrl: fixture.remoteUrl,
      revision: { remoteRef: "refs/heads/main", expectedSha: fixture.baseSha },
    })).rejects.toMatchObject({ status: 500 });

    const repositoryEntry = repositoryEntryFor(fixture);
    const pendingPath = join(repositoryEntry, "pending.json");
    const pending = JSON.parse(readFileSync(pendingPath, "utf8")) as { operationId: string };
    const incoming = `refs/meridian/incoming/${pending.operationId}/0`;
    const mirrorDir = join(repositoryEntry, "mirror.git");
    expect(git(mirrorDir, "for-each-ref", "--format=%(refname)", incoming)).toBe(incoming);

    const restarted = createMirror();
    const recovered = await restarted.acquireWorkspace({
      remoteUrl: fixture.remoteUrl,
      revision: { remoteRef: "refs/heads/main", expectedSha: fixture.baseSha },
    });

    expect(existsSync(pendingPath)).toBe(false);
    expect(git(mirrorDir, "for-each-ref", "--format=%(refname)", incoming)).toBe("");
    recovered.release();
  });

  it("removes the one deterministic initialization stage before retrying", async () => {
    const repositoryKey = repositoryKeyFor(fixture.remoteUrl);
    const stage = join(
      fixture.cacheRoot,
      "repository-store-v1",
      "repositories",
      `.stage-${repositoryKey}`,
    );
    mkdirSync(join(stage, "mirror.git"), { recursive: true });
    writeFileSync(join(stage, "interrupted"), "partial initialization");

    const mirror = createMirror();
    const lease = await mirror.acquireWorkspace({
      remoteUrl: fixture.remoteUrl,
      revision: { remoteRef: "refs/heads/main", expectedSha: fixture.baseSha },
    });

    expect(existsSync(stage)).toBe(false);
    expect(git(lease.repoDir, "rev-parse", "HEAD")).toBe(fixture.baseSha);
    lease.release();
  });

  it("fails closed when complete-history metadata points at a shallow mirror", async () => {
    const mirror = createMirror();
    const ordinary = await mirror.acquireWorkspace({
      remoteUrl: fixture.remoteUrl,
      revision: { remoteRef: "refs/pull/41/head", expectedSha: fixture.headSha },
    });
    ordinary.release();
    const repositoryEntry = repositoryEntryFor(fixture);
    const metadataPath = join(repositoryEntry, "metadata.json");
    const metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as Record<string, unknown>;
    writeFileSync(metadataPath, `${JSON.stringify({ ...metadata, historyMode: "complete" }, null, 2)}\n`);

    await expect(prepareFixturePullRequest(mirror)).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining("complete-history invariant"),
    });
    expect(existsSync(join(repositoryEntry, "pending.json"))).toBe(false);
  });

  it("resumes an interrupted history promotion without re-shallowing", async () => {
    const gitCalls: string[][] = [];
    const mirror = createMirror({
      git: async (args, options) => {
        gitCalls.push(args);
        return runGit(args, options);
      },
    });
    const ordinary = await mirror.acquireWorkspace({
      remoteUrl: fixture.remoteUrl,
      revision: { remoteRef: "refs/pull/41/head", expectedSha: fixture.headSha },
    });
    ordinary.release();
    const repositoryEntry = repositoryEntryFor(fixture);
    const mirrorDir = join(repositoryEntry, "mirror.git");
    const metadataPath = join(repositoryEntry, "metadata.json");
    const metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as Record<string, unknown>;
    writeFileSync(metadataPath, `${JSON.stringify({ ...metadata, historyMode: "promoting" }, null, 2)}\n`);
    git(mirrorDir, "fetch", "--unshallow", "--no-tags", "origin", "refs/heads/main");
    expect(git(mirrorDir, "rev-parse", "--is-shallow-repository")).toBe("false");

    writeFileSync(join(fixture.workDir, "after-crash.ts"), "export const recovered = true;\n");
    git(fixture.workDir, "add", "after-crash.ts");
    git(fixture.workDir, "commit", "-m", "revision after interrupted promotion");
    const laterSha = git(fixture.workDir, "rev-parse", "HEAD");
    git(fixture.workDir, "push", "origin", "HEAD:refs/heads/after-crash");
    gitCalls.length = 0;

    const recovered = await mirror.acquireWorkspace({
      remoteUrl: fixture.remoteUrl,
      revision: { remoteRef: "refs/heads/after-crash", expectedSha: laterSha },
    });

    expect(gitCalls.some((args) => args[0] === "fetch" && args.includes("--depth=1"))).toBe(false);
    expect(git(mirrorDir, "rev-parse", "--is-shallow-repository")).toBe("false");
    expect(JSON.parse(readFileSync(metadataPath, "utf8"))).toMatchObject({ historyMode: "complete" });
    recovered.release();
  });

  it("keeps a long live transaction fenced with heartbeats and bounds contender latency", async () => {
    const owner = createMirror({ staleLockMs: 45 });
    const contender = createMirror({ staleLockMs: 45, lockWaitTimeoutMs: 120 });
    let entered!: () => void;
    let unblock!: () => void;
    const fetchComplete = new Promise<void>((resolveEntered) => { entered = resolveEntered; });
    const gate = new Promise<void>((resolveGate) => { unblock = resolveGate; });
    const revision = { remoteRef: "refs/heads/main", expectedSha: fixture.baseSha };
    const first = owner.acquireWorkspace({
      remoteUrl: fixture.remoteUrl,
      revision,
      onFetchComplete: async () => {
        entered();
        await gate;
      },
    });
    await fetchComplete;

    await expect(contender.acquireWorkspace({ remoteUrl: fixture.remoteUrl, revision }))
      .rejects.toMatchObject({ status: 503, message: expect.stringContaining("busy") });
    unblock();
    const lease = await first;
    lease.release();
  });

  it("lets a default contender wait for a healthy owner instead of failing on elapsed time", async () => {
    const owner = createMirror({ staleLockMs: 45 });
    const contender = createMirror({ staleLockMs: 45 });
    let entered!: () => void;
    let unblock!: () => void;
    const fetchComplete = new Promise<void>((resolveEntered) => { entered = resolveEntered; });
    const gate = new Promise<void>((resolveGate) => { unblock = resolveGate; });
    const revision = { remoteRef: "refs/heads/main", expectedSha: fixture.baseSha };
    const first = owner.acquireWorkspace({
      remoteUrl: fixture.remoteUrl,
      revision,
      onFetchComplete: async () => {
        entered();
        await gate;
      },
    });
    await fetchComplete;
    let contenderSettled = false;
    const second = contender.acquireWorkspace({ remoteUrl: fixture.remoteUrl, revision }).finally(() => {
      contenderSettled = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(contenderSettled).toBe(false);
    unblock();
    const firstLease = await first;
    const secondLease = await second;
    expect(secondLease.cache).toBe("hit");
    firstLease.release();
    secondLease.release();
  });

  it("fences a worker that loses lock ownership and leaves exact recovery state", async () => {
    const mirror = createMirror({ staleLockMs: 45 });
    let entered!: () => void;
    let unblock!: () => void;
    const fetchComplete = new Promise<void>((resolveEntered) => { entered = resolveEntered; });
    const gate = new Promise<void>((resolveGate) => { unblock = resolveGate; });
    const pending = mirror.acquireWorkspace({
      remoteUrl: fixture.remoteUrl,
      revision: { remoteRef: "refs/heads/main", expectedSha: fixture.baseSha },
      onFetchComplete: async () => {
        entered();
        await gate;
      },
    });
    await fetchComplete;
    const repositoryKey = repositoryKeyFor(fixture.remoteUrl);
    const lock = join(fixture.cacheRoot, "repository-store-v1", "locks", `${repositoryKey}.lock`);
    writeFileSync(join(lock, "owner.json"), JSON.stringify({
      formatVersion: 1,
      host: hostname(),
      nonce: "replacement-owner",
      pid: process.pid,
    }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    rmSync(lock, { recursive: true, force: true });
    const replacement = createMirror({ staleLockMs: 45 });
    const recovered = await replacement.acquireWorkspace({
      remoteUrl: fixture.remoteUrl,
      revision: { remoteRef: "refs/heads/main", expectedSha: fixture.baseSha },
    });
    unblock();

    await expect(pending).rejects.toMatchObject({
      status: 503,
      message: expect.stringContaining("ownership was lost"),
    });
    expect(existsSync(join(repositoryEntryFor(fixture), "pending.json"))).toBe(false);
    expect(existsSync(recovered.repoDir)).toBe(true);
    expect(git(recovered.repoDir, "rev-parse", "HEAD")).toBe(fixture.baseSha);
    recovered.release();
  });

  it("returns a retryable busy error for a fresh lock when no caller signal is provided", async () => {
    const mirror = createMirror({ lockWaitTimeoutMs: 40, staleLockMs: 5_000 });
    const repositoryKey = repositoryKeyFor(fixture.remoteUrl);
    const lock = join(fixture.cacheRoot, "repository-store-v1", "locks", `${repositoryKey}.lock`);
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, "owner.json"), JSON.stringify({
      formatVersion: 1,
      host: hostname(),
      nonce: "live-owner",
      pid: process.pid,
    }));

    await expect(mirror.acquireWorkspace({
      remoteUrl: fixture.remoteUrl,
      revision: { remoteRef: "refs/heads/main", expectedSha: fixture.baseSha },
    })).rejects.toMatchObject({ status: 503, message: expect.stringContaining("busy") });
  });

  it("never steals a stale lock from a live host process", async () => {
    const mirror = createMirror({ staleLockMs: 45 });
    const repositoryKey = repositoryKeyFor(fixture.remoteUrl);
    const lock = join(fixture.cacheRoot, "repository-store-v1", "locks", `${repositoryKey}.lock`);
    const ownerPath = join(lock, "owner.json");
    mkdirSync(lock, { recursive: true });
    writeFileSync(ownerPath, JSON.stringify({
      formatVersion: 1,
      host: hostname(),
      nonce: "blocked-live-owner",
      pid: process.pid,
    }));
    const old = new Date(Date.now() - 5_000);
    utimesSync(ownerPath, old, old);

    await expect(mirror.acquireWorkspace({
      remoteUrl: fixture.remoteUrl,
      revision: { remoteRef: "refs/heads/main", expectedSha: fixture.baseSha },
    })).rejects.toMatchObject({ status: 503, message: expect.stringContaining("unresponsive") });
    expect(existsSync(lock)).toBe(true);
  });

  it("recovers a stale lock whose host process is gone", async () => {
    const mirror = createMirror({ staleLockMs: 45 });
    const repositoryKey = repositoryKeyFor(fixture.remoteUrl);
    const lock = join(fixture.cacheRoot, "repository-store-v1", "locks", `${repositoryKey}.lock`);
    const ownerPath = join(lock, "owner.json");
    mkdirSync(lock, { recursive: true });
    writeFileSync(ownerPath, JSON.stringify({
      formatVersion: 1,
      host: hostname(),
      nonce: "dead-owner",
      pid: 2_147_483_647,
    }));
    const old = new Date(Date.now() - 5_000);
    utimesSync(ownerPath, old, old);

    const lease = await mirror.acquireWorkspace({
      remoteUrl: fixture.remoteUrl,
      revision: { remoteRef: "refs/heads/main", expectedSha: fixture.baseSha },
    });
    expect(git(lease.repoDir, "rev-parse", "HEAD")).toBe(fixture.baseSha);
    lease.release();
  });

  it("lets an aborted waiter stop waiting for a live cross-process lock", async () => {
    const mirror = createMirror();
    const repositoryKey = repositoryKeyFor(fixture.remoteUrl);
    const lock = join(fixture.cacheRoot, "repository-store-v1", "locks", `${repositoryKey}.lock`);
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, "owner.json"), JSON.stringify({
      formatVersion: 1,
      host: hostname(),
      nonce: "live-owner",
      pid: process.pid,
    }));
    const controller = new AbortController();
    const pending = mirror.acquireWorkspace({
      remoteUrl: fixture.remoteUrl,
      revision: { remoteRef: "refs/heads/main", expectedSha: fixture.baseSha },
      signal: controller.signal,
    });
    controller.abort(new Error("caller left"));

    await expect(pending).rejects.toThrow("caller left");
    expect(existsSync(repositoryEntryFor(fixture))).toBe(false);
  });
});

function createMirror(overrides: Partial<ConstructorParameters<typeof WebRepositoryMirror>[0]> = {}): WebRepositoryMirror {
  const mirror = new WebRepositoryMirror({
    cacheRoot: fixture.cacheRoot,
    allowFileRemotesForTests: true,
    ...overrides,
  });
  mirrors.push(mirror);
  return mirror;
}

function prepareFixturePullRequest(mirror: WebRepositoryMirror): Promise<PreparedPullRequest> {
  return mirror.preparePullRequest({
    remoteUrl: fixture.remoteUrl,
    base: { remoteRef: "refs/heads/main", expectedSha: fixture.baseSha },
    head: { remoteRef: "refs/pull/41/head", expectedSha: fixture.headSha },
  });
}

function createFixture(objectFormat: "sha1" | "sha256" = "sha1"): GitFixture {
  const root = mkdtempSync(join(tmpdir(), "meridian-mirror-test-"));
  const remoteDir = join(root, "remote.git");
  const workDir = join(root, "work");
  const cacheRoot = join(root, "cache");
  const formatArg = `--object-format=${objectFormat}`;
  git(root, "init", "--bare", formatArg, remoteDir);
  git(remoteDir, "config", "uploadpack.allowFilter", "true");
  git(root, "init", formatArg, workDir);
  git(workDir, "config", "user.email", "meridian@example.test");
  git(workDir, "config", "user.name", "Meridian Tests");
  writeFileSync(join(workDir, "base.ts"), "export const base = true;\n");
  git(workDir, "add", "base.ts");
  git(workDir, "commit", "-m", "base");
  git(workDir, "branch", "-M", "main");
  const baseSha = git(workDir, "rev-parse", "HEAD");
  git(workDir, "remote", "add", "origin", remoteDir);
  git(workDir, "push", "origin", "main");
  git(remoteDir, "symbolic-ref", "HEAD", "refs/heads/main");
  for (const remoteRef of [
    "refs/heads/feature+picker@team",
    "refs/heads/release/$next",
    "refs/heads/unicode/ramură",
    "refs/tags/v1+picker@team$",
  ]) {
    git(workDir, "push", "origin", `${baseSha}:${remoteRef}`);
  }
  git(workDir, "checkout", "-b", "feature");
  writeFileSync(join(workDir, "head.ts"), "export const head = true;\n");
  git(workDir, "add", "head.ts");
  git(workDir, "commit", "-m", "head");
  const headSha = git(workDir, "rev-parse", "HEAD");
  git(workDir, "push", "origin", "HEAD:refs/pull/41/head");
  return {
    baseSha,
    cacheRoot,
    headSha,
    remoteDir,
    remoteUrl: pathToFileURL(remoteDir).href,
    root,
    workDir,
  };
}

function createCrissCrossRefs(value: GitFixture): { baseSha: string; headSha: string } {
  const tree = git(value.workDir, "rev-parse", `${value.baseSha}^{tree}`);
  const firstBase = git(value.workDir, "commit-tree", tree, "-p", value.baseSha, "-m", "criss base one");
  const firstHead = git(value.workDir, "commit-tree", tree, "-p", value.baseSha, "-m", "criss head one");
  const baseSha = git(value.workDir, "commit-tree", tree, "-p", firstBase, "-p", firstHead, "-m", "criss base");
  const headSha = git(value.workDir, "commit-tree", tree, "-p", firstHead, "-p", firstBase, "-m", "criss head");
  git(value.workDir, "push", "origin", `${baseSha}:refs/heads/criss-base`);
  git(value.workDir, "push", "origin", `${headSha}:refs/heads/criss-head`);
  return { baseSha, headSha };
}

function repositoryEntryFor(value: GitFixture): string {
  return join(
    value.cacheRoot,
    "repository-store-v1",
    "repositories",
    repositoryKeyFor(value.remoteUrl),
  );
}

function worktreePaths(anyWorkspace: string): string[] {
  const common = git(anyWorkspace, "rev-parse", "--git-common-dir");
  const mirrorDir = common.startsWith("/") ? common : join(anyWorkspace, common);
  const output = git(mirrorDir, "worktree", "list", "--porcelain");
  return output.split("\n").filter((line) => line.startsWith("worktree ")).map((line) => line.slice(9));
}

function allFileBytes(root: string): Buffer {
  const chunks: Buffer[] = [];
  const visit = (path: string) => {
    const stat = statSync(path);
    if (stat.isFile()) {
      chunks.push(readFileSync(path));
      return;
    }
    if (!stat.isDirectory()) return;
    for (const name of readdirSync(path)) visit(join(path, name));
  };
  visit(root);
  return Buffer.concat(chunks);
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
