import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runGit } from "./git-exec";
import type {
  PrepareRepositoryWorktree,
  RepositoryWorktreeLease,
} from "./repository-mirror";
import { checkoutFor, repositoryCacheKey } from "./web-cache-checkout";
import type { RepositoryMirrorPreparer } from "./web-cache-checkout";
import type { GenerateRequest } from "./web-request";
import { OwnershipCleanupError } from "./ownership-cleanup";

vi.mock("./git-exec", () => ({
  runGit: vi.fn(),
}));

const COMMIT = "a".repeat(40);
const REQUEST: GenerateRequest = { kind: "github", value: "owner/repo" };
const REMOTE_URL = "https://github.com/owner/repo.git";

let cacheRoot: string;
let mirror: ReturnType<typeof createMirror>;

beforeEach(() => {
  cacheRoot = mkdtempSync(join(tmpdir(), "meridian-checkout-cutover-"));
  mirror = createMirror(cacheRoot);
  vi.mocked(runGit).mockImplementation(async (args) => (
    args[0] === "ls-remote" ? `${COMMIT}\tHEAD\n` : `${COMMIT}\n`
  ));
});

afterEach(() => {
  rmSync(cacheRoot, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe("mirror-backed checkout cache", () => {
  it("rejects direct-layout metadata and publishes a mirror lease pointer", async () => {
    const repositoryKey = repositoryCacheKey(REMOTE_URL);
    const entry = join(cacheRoot, "repositories", repositoryKey, COMMIT);
    mkdirSync(join(entry, "repo"), { recursive: true });
    writeFileSync(join(entry, "metadata.json"), JSON.stringify({
      formatVersion: 3,
      repositoryKey,
      commit: COMMIT,
      remoteUrl: REMOTE_URL,
    }));
    const onPrepare = vi.fn();

    const result = await checkoutFor(cacheRoot, REQUEST, cacheRoot, mirror.store, undefined, onPrepare);

    expect(result).toMatchObject({ cache: "miss", commit: COMMIT, repositoryKey, remoteUrl: REMOTE_URL });
    expect(onPrepare).toHaveBeenCalledTimes(1);
    expect(mirror.prepare).toHaveBeenCalledTimes(1);
    expect(JSON.parse(readFileSync(join(entry, "metadata.json"), "utf8"))).toMatchObject({
      formatVersion: 4,
      repositoryKey,
      commit: COMMIT,
      remoteUrl: REMOTE_URL,
      sourceRoot: mirror.sourceRoots[0],
      leaseMetadata: mirror.leaseMetadata[0],
    });
  });

  it("rejects a current-format source path that escapes the cache root", async () => {
    const repositoryKey = repositoryCacheKey(REMOTE_URL);
    const entry = join(cacheRoot, "repositories", repositoryKey, COMMIT);
    mkdirSync(entry, { recursive: true });
    writeFileSync(join(entry, "metadata.json"), JSON.stringify({
      formatVersion: 3,
      repositoryKey,
      commit: COMMIT,
      remoteUrl: REMOTE_URL,
      sourceRoot: "../outside",
      leaseMetadata: "repository-mirrors/v1/missing/leases/missing.json",
    }));

    const result = await checkoutFor(cacheRoot, REQUEST, cacheRoot, mirror.store);

    expect(result.cache).toBe("miss");
    expect(result.repoDir).toBe(realpathSync(join(cacheRoot, mirror.sourceRoots[0])));
    expect(mirror.prepare).toHaveBeenCalledTimes(1);
  });

  it("releases acquired source ownership when final mirror release fails", async () => {
    const mirrorError = new Error("mirror release failed");
    const sourceError = new Error("source release failed");
    const order: string[] = [];
    const originalPrepare = mirror.store.prepare;
    const originalAcquireSource = mirror.store.acquireSource;
    mirror.store.prepare = async (request) => ({
      ...await originalPrepare(request),
      release: async () => { order.push("mirror"); throw mirrorError; },
    });
    mirror.store.acquireSource = async (reference, expectedWorktreeDir, purpose, signal) => ({
      ...await originalAcquireSource(reference, expectedWorktreeDir, purpose, signal),
      release: async () => { order.push("source"); throw sourceError; },
    });

    const outcome = await checkoutFor(cacheRoot, REQUEST, cacheRoot, mirror.store).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(order).toEqual(["mirror", "source"]);
    expect(outcome).toBeInstanceOf(OwnershipCleanupError);
    expect((outcome as OwnershipCleanupError).errors).toEqual([mirrorError, sourceError]);
  });

  it("keeps a falsy checkout failure first when mandatory mirror release fails", async () => {
    const mirrorError = new Error("mirror release failed");
    const originalPrepare = mirror.store.prepare;
    mirror.store.prepare = async (request) => ({
      ...await originalPrepare(request),
      release: async () => { throw mirrorError; },
    });
    vi.mocked(runGit).mockImplementation(async (args) => {
      if (args[0] === "ls-remote") return `${COMMIT}\tHEAD\n`;
      throw 0;
    });

    const outcome = await checkoutFor(cacheRoot, REQUEST, cacheRoot, mirror.store).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(outcome).toBeInstanceOf(OwnershipCleanupError);
    expect((outcome as OwnershipCleanupError).errors).toEqual([0, mirrorError]);
  });
});

function createMirror(root: string): {
  store: RepositoryMirrorPreparer;
  prepare: ReturnType<typeof vi.fn>;
  sourceRoots: string[];
  leaseMetadata: string[];
} {
  let sequence = 0;
  const sourceRoots: string[] = [];
  const leaseMetadata: string[] = [];
  const repositoryDigest = "d".repeat(64);
  const prepare = vi.fn(async (request: PrepareRepositoryWorktree): Promise<RepositoryWorktreeLease> => {
    sequence += 1;
    const leaseId = createHash("sha256").update(`lease-${sequence}`).digest("hex");
    const repositoryRoot = join(root, "repository-mirrors", "v1", repositoryDigest);
    const worktreeDir = join(repositoryRoot, "worktrees", leaseId);
    const metadataPath = join(repositoryRoot, "leases", `${leaseId}.json`);
    mkdirSync(worktreeDir, { recursive: true });
    mkdirSync(join(repositoryRoot, "leases"), { recursive: true });
    writeFileSync(metadataPath, JSON.stringify({ state: "active" }));
    sourceRoots.push(`repository-mirrors/v1/${repositoryDigest}/worktrees/${leaseId}`);
    leaseMetadata.push(`repository-mirrors/v1/${repositoryDigest}/leases/${leaseId}.json`);
    return {
      leaseId,
      repositoryDigest,
      worktreeDir,
      headOid: request.head.oid,
      baseOid: request.base.oid,
      headRef: request.head.ref,
      baseRef: request.base.ref,
      prepareDetachedRevision: async () => { throw new Error("not used by checkout cache tests"); },
      touch: () => {},
      release: async () => {},
    };
  });
  const retainSource = vi.fn(async () => true);
  const acquireSource: RepositoryMirrorPreparer["acquireSource"] = vi.fn(async (
    reference,
    expectedWorktreeDir,
    _purpose,
    signal,
  ) => {
    signal?.throwIfAborted();
    return {
      reference: { ...reference },
      worktreeDir: realpathSync(expectedWorktreeDir),
      signal: new AbortController().signal,
      renew: async () => {},
      release: async () => {},
    };
  });
  return {
    store: { prepare, retainSource, acquireSource },
    prepare,
    sourceRoots,
    leaseMetadata,
  };
}
