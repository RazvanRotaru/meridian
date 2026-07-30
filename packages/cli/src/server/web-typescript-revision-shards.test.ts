import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runGit } from "./git-exec";
import {
  parseTypeScriptRevisionShardMode,
  serverTypeScriptRevisionShardDecision,
  tryWithServerTypeScriptRevisionShardAnalysisGroup,
  withServerTypeScriptRevisionShardAnalysisGroup,
  withServerTypeScriptRevisionShards,
} from "./web-typescript-revision-shards";
import { tryWithTypeScriptRevisionShardBuildLock } from "./web-typescript-revision-shard-lock";

vi.mock("./git-exec", () => ({ runGit: vi.fn() }));

const roots: string[] = [];
const TREE = "a".repeat(40);
const COMMIT = "d".repeat(40);
const BUILD = "b".repeat(64);

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe("server-owned TypeScript revision shards", () => {
  it("binds an exact Git root/tree to a server-selected cache and stable provenance", async () => {
    const root = temporaryDirectory();
    vi.mocked(runGit).mockResolvedValue(`${root}\n${COMMIT}\n${TREE}\n`);

    const decision = await serverTypeScriptRevisionShardDecision({
      cacheRoot: join(root, "server-cache"),
      root,
      mode: "shadow",
      exactWorkspaces: [activeWorkspace(root)],
      runtimeFingerprint: runtimeFingerprint(),
    });

    expect(decision).toMatchObject({
      kind: "enabled",
      policy: {
        version: 1,
        mode: "shadow",
        admission: {
          version: 1,
          kind: "signer",
          keyId: expect.stringMatching(/^[a-f0-9]{64}$/),
          publicKeySpki: expect.any(String),
          privateKeyPkcs8: expect.any(String),
        },
        cacheDir: join(
          root,
          "server-cache",
          "typescript-revision-shards-v1",
          "shadow-admitted",
        ),
        treeOid: TREE,
        buildFingerprint: BUILD,
        analysisPolicyFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
        runtimeFingerprint: {
          nodeVersion: "v26.0.0",
          platform: "linux",
          arch: "x64",
          typescriptVersion: "6.0.3",
          tsMorphVersion: "28.0.0",
        },
      },
    });
    expect(decision).not.toHaveProperty("policy.runtimeFingerprint.processInstanceNonce");
  });

  it("conservatively falls back for a repository subdirectory", async () => {
    const root = temporaryDirectory();
    const subdir = join(root, "packages", "app");
    mkdirSync(subdir, { recursive: true });
    vi.mocked(runGit).mockResolvedValue(`${root}\n${COMMIT}\n${TREE}\n`);

    await expect(serverTypeScriptRevisionShardDecision({
      cacheRoot: join(root, "server-cache"),
      root: subdir,
      mode: "verified-experimental",
      runtimeFingerprint: runtimeFingerprint(),
    })).resolves.toEqual({ kind: "fallback", reason: "not-exact-git-root" });
  });

  it("injects the capability out-of-band and leaves the analysis request untouched", async () => {
    const root = temporaryDirectory();
    vi.mocked(runGit).mockResolvedValue(`${root}\n${COMMIT}\n${TREE}\n`);
    const repositoryAnalysis = vi.fn(async () => "result");
    const wrapped = withServerTypeScriptRevisionShards(
      repositoryAnalysis as never,
      join(root, "server-cache"),
      "empty",
    );
    const request = { absoluteRoot: root, cwd: root };

    await expect(wrapped(request, {
      artifactOutputPath: join(root, "artifact.json"),
    })).resolves.toBe("result");

    expect(request).toEqual({ absoluteRoot: root, cwd: root });
    expect(repositoryAnalysis).toHaveBeenCalledWith(
      request,
      expect.objectContaining({
        artifactOutputPath: join(root, "artifact.json"),
        typeScriptRevisionShards: expect.objectContaining({
          mode: "empty",
          cacheDir: join(root, "server-cache", "typescript-revision-shards-v1", "empty"),
          treeOid: TREE,
        }),
      }),
    );
  });

  it("requires a matching active RepositoryMirror lease for safe modes", async () => {
    const root = temporaryDirectory();
    vi.mocked(runGit).mockResolvedValue(`${root}\n${COMMIT}\n${TREE}\n`);
    const inputs = {
      cacheRoot: join(root, "server-cache"),
      root,
      mode: "admitted" as const,
      runtimeFingerprint: runtimeFingerprint(),
    };

    await expect(serverTypeScriptRevisionShardDecision(inputs)).resolves.toEqual({
      kind: "fallback",
      reason: "not-owned-exact-workspace",
    });
    await expect(serverTypeScriptRevisionShardDecision({
      ...inputs,
      exactWorkspaces: [{ ...activeWorkspace(root), commit: "e".repeat(40) }],
    })).resolves.toEqual({
      kind: "fallback",
      reason: "not-owned-exact-workspace",
    });
    await expect(serverTypeScriptRevisionShardDecision({
      ...inputs,
      exactWorkspaces: [{ ...activeWorkspace(root), isActive: () => false }],
    })).resolves.toEqual({
      kind: "fallback",
      reason: "not-owned-exact-workspace",
    });
    await expect(serverTypeScriptRevisionShardDecision({
      ...inputs,
      exactWorkspaces: [activeWorkspace(root)],
    })).resolves.toMatchObject({
      kind: "enabled",
      policy: {
        mode: "admitted",
        admission: {
          kind: "verifier",
          keyId: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
      },
    });
  });

  it("injects one ephemeral pair exchange only for an admitted exact workspace", async () => {
    const root = temporaryDirectory();
    const pairCacheDir = join(root, "pair-cache");
    vi.mocked(runGit).mockResolvedValue(`${root}\n${COMMIT}\n${TREE}\n`);
    const common = {
      cacheRoot: join(root, "server-cache"),
      root,
      exactWorkspaces: [activeWorkspace(root)],
      runtimeFingerprint: runtimeFingerprint(),
      pairCacheDir,
    };

    await expect(serverTypeScriptRevisionShardDecision({
      ...common,
      mode: "admitted",
    })).resolves.toMatchObject({
      kind: "enabled",
      policy: { mode: "admitted", pairCacheDir },
    });
    await expect(serverTypeScriptRevisionShardDecision({
      ...common,
      mode: "shadow",
    })).resolves.toMatchObject({
      kind: "enabled",
      policy: { mode: "shadow", pairCacheDir: null },
    });
  });

  it("runs admitted readers concurrently under one cross-process build fence", async () => {
    const owner = temporaryDirectory();
    const head = join(owner, "head");
    const comparison = join(owner, "comparison");
    const cacheRoot = join(owner, "server-cache");
    mkdirSync(head);
    mkdirSync(comparison);
    vi.mocked(runGit).mockImplementation(async (_args, options) =>
      `${options.cwd}\n${COMMIT}\n${TREE}\n`);
    const release = deferred<void>();
    const bothStarted = deferred<void>();
    let active = 0;
    const repositoryAnalysis = vi.fn(async (_request, options) => {
      active += 1;
      if (active === 2) bothStarted.resolve();
      expect(options.signal?.aborted).toBe(false);
      expect(options.typeScriptRevisionShards).toMatchObject({ mode: "admitted" });
      await release.promise;
      active -= 1;
      return options.artifactOutputPath;
    });
    const signal = new AbortController().signal;

    const group = withServerTypeScriptRevisionShardAnalysisGroup({
      repositoryAnalysis: repositoryAnalysis as never,
      cacheRoot,
      mode: "admitted",
      exactWorkspaces: [activeWorkspace(head), activeWorkspace(comparison)],
      signal,
      work: async (analysis, lockSignal) => Promise.all([
        analysis(
          { absoluteRoot: head, cwd: head },
          { artifactOutputPath: join(owner, "head.json"), signal: lockSignal },
        ),
        analysis(
          { absoluteRoot: comparison, cwd: comparison },
          { artifactOutputPath: join(owner, "comparison.json"), signal: lockSignal },
        ),
      ]),
    });

    await bothStarted.promise;
    expect(active).toBe(2);
    await expect(tryWithTypeScriptRevisionShardBuildLock(
      cacheRoot,
      undefined,
      () => "unexpected",
    )).resolves.toBeUndefined();
    const skippedWork = vi.fn(() => "unexpected");
    await expect(tryWithServerTypeScriptRevisionShardAnalysisGroup({
      repositoryAnalysis: repositoryAnalysis as never,
      cacheRoot,
      mode: "admitted",
      exactWorkspaces: [activeWorkspace(head)],
      signal,
      work: skippedWork,
    })).resolves.toEqual({ kind: "unavailable" });
    expect(skippedWork).not.toHaveBeenCalled();
    release.resolve();
    await expect(group).resolves.toEqual([
      join(owner, "head.json"),
      join(owner, "comparison.json"),
    ]);
  });

  it("distinguishes an admitted undefined result from a busy shard fence", async () => {
    const root = temporaryDirectory();
    const cacheRoot = join(root, "server-cache");
    const signal = new AbortController().signal;
    const work = vi.fn(async () => undefined);

    await expect(tryWithServerTypeScriptRevisionShardAnalysisGroup({
      repositoryAnalysis: vi.fn() as never,
      cacheRoot,
      mode: "admitted",
      exactWorkspaces: [],
      signal,
      work,
    })).resolves.toEqual({ kind: "admitted", value: undefined });
    expect(work).toHaveBeenCalledOnce();

    const lockHeld = deferred<void>();
    const releaseLock = deferred<void>();
    const owner = withServerTypeScriptRevisionShardAnalysisGroup({
      repositoryAnalysis: vi.fn() as never,
      cacheRoot,
      mode: "admitted",
      exactWorkspaces: [],
      signal,
      work: async () => {
        lockHeld.resolve();
        await releaseLock.promise;
      },
    });
    await lockHeld.promise;
    const skippedWork = vi.fn(async () => undefined);
    await expect(tryWithServerTypeScriptRevisionShardAnalysisGroup({
      repositoryAnalysis: vi.fn() as never,
      cacheRoot,
      mode: "admitted",
      exactWorkspaces: [],
      signal,
      work: skippedWork,
    })).resolves.toEqual({ kind: "unavailable" });
    expect(skippedWork).not.toHaveBeenCalled();
    releaseLock.resolve();
    await owner;
  });

  it("preserves per-child cancellation while the admitted group fence remains live", async () => {
    const root = temporaryDirectory();
    const cacheRoot = join(root, "server-cache");
    vi.mocked(runGit).mockResolvedValue(`${root}\n${COMMIT}\n${TREE}\n`);
    const started = deferred<AbortSignal>();
    const childController = new AbortController();
    const failure = new Error("sibling extraction failed");
    const repositoryAnalysis = vi.fn(async (_request, options) => {
      const signal = options.signal;
      if (signal === undefined) throw new Error("analysis signal is required");
      started.resolve(signal);
      return new Promise<never>((_resolve, reject) => {
        const abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      });
    });

    await expect(withServerTypeScriptRevisionShardAnalysisGroup({
      repositoryAnalysis: repositoryAnalysis as never,
      cacheRoot,
      mode: "admitted",
      exactWorkspaces: [activeWorkspace(root)],
      signal: new AbortController().signal,
      work: async (analysis, lockSignal) => {
        const child = analysis(
          { absoluteRoot: root, cwd: root },
          { artifactOutputPath: join(root, "artifact.json"), signal: childController.signal },
        );
        const executionSignal = await started.promise;
        expect(executionSignal).not.toBe(childController.signal);
        expect(lockSignal.aborted).toBe(false);
        childController.abort(failure);
        await expect(child).rejects.toBe(failure);
        expect(executionSignal.aborted).toBe(true);
        expect(lockSignal.aborted).toBe(false);
      },
    })).resolves.toBeUndefined();
  });

  it("rejects unknown opt-in modes before server startup", () => {
    expect(parseTypeScriptRevisionShardMode("shadow")).toBe("shadow");
    expect(() => parseTypeScriptRevisionShardMode("on")).toThrow(/must be one of/);
  });
});

function temporaryDirectory(): string {
  const root = mkdtempSync(join(tmpdir(), "meridian-typescript-shards-"));
  roots.push(root);
  return root;
}

function runtimeFingerprint() {
  return {
    formatVersion: 1 as const,
    buildFingerprint: BUILD,
    processInstanceNonce: "c".repeat(32),
    nodeVersion: "v26.0.0",
    platform: "linux" as const,
    arch: "x64",
    typescriptVersion: "6.0.3",
    tsMorphVersion: "28.0.0",
  };
}

function activeWorkspace(repoDir: string) {
  return {
    repoDir,
    commit: COMMIT,
    isActive: () => true,
  };
}

function deferred<Value>() {
  let resolve!: (value: Value | PromiseLike<Value>) => void;
  const promise = new Promise<Value>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
