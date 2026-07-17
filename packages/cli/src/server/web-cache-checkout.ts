import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, realpathSync, renameSync, statSync, utimesSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import {
  canonicalRepositoryUrl,
  gitTokenForRemote,
  parseGitHubSource,
} from "./repository-source";
import type { GenerateRequest } from "./web-request";
import { runGit } from "./git-exec";
import { WebError } from "./web-error";
import {
  createPrivateDirectory,
  createStageDirectory,
  isDirectory,
  publishImmutable,
  readJson,
  removeEntry,
  touchMetadata,
  writePrivateJson,
} from "./web-cache-storage";
import { repositoryMirrorSecurityKey } from "./repository-mirror";
import type {
  PrepareRepositoryWorktree,
  RepositorySourceOperationLease,
  RepositorySourceLeaseReference,
  RepositoryWorktreeLease,
} from "./repository-mirror";
import { withOwnershipCleanup } from "./ownership-cleanup";

const CHECKOUT_FORMAT_VERSION = 4;
// This version belongs to repository identity, not checkout metadata; changing it intentionally
// moves repositories into a new cache namespace.
const REPOSITORY_IDENTITY_VERSION = 2;
const CHECKOUT_LOCK_TIMEOUT_MS = 30_000;
const CHECKOUT_LOCK_POLL_MS = 25;
const CHECKOUT_LOCK_STALE_MS = 10 * 60_000;
const COMMIT = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;
const CHECKOUT_ALIAS_TTL_MS = 30 * 24 * 60 * 60_000;

export interface CachedCheckout {
  branch?: string;
  cache: "hit" | "miss";
  commit: string;
  repoDir: string;
  repositoryKey: string;
  remoteUrl: string;
  sourceLease: RepositorySourceLeaseReference;
  /** Transient owner held through extraction and capability adoption. */
  sourceOperation: RepositorySourceOperationLease;
}

/** The checkout cache depends only on the lease-producing mirror boundary. */
export interface RepositoryMirrorPreparer {
  prepare(request: PrepareRepositoryWorktree): Promise<RepositoryWorktreeLease>;
  retainSource(
    reference: RepositorySourceLeaseReference,
    expectedWorktreeDir: string,
    owner: string,
    retainedUntilMs: number,
  ): Promise<boolean>;
  acquireSource(
    reference: RepositorySourceLeaseReference,
    expectedWorktreeDir: string,
    purpose: string,
    signal?: AbortSignal,
  ): Promise<RepositorySourceOperationLease>;
}

interface CheckoutMetadata {
  formatVersion: typeof CHECKOUT_FORMAT_VERSION;
  repositoryKey: string;
  commit: string;
  remoteUrl: string;
  sourceRoot: string;
  leaseMetadata: string;
  sourceLease: RepositorySourceLeaseReference;
}

interface ValidCheckout {
  repoDir: string;
  sourceLease: RepositorySourceLeaseReference;
}

interface AdvertisedRevision {
  branch?: string;
  commit: string;
  remoteRef: string;
}

export async function checkoutFor(
  cacheRoot: string,
  request: GenerateRequest,
  cwd: string,
  repositoryMirrors: RepositoryMirrorPreparer,
  token?: string,
  onPrepare: () => void | Promise<void> = () => {},
  tokenIsExplicit = false,
  signal?: AbortSignal,
): Promise<CachedCheckout> {
  const { advertised, gitToken, parent, remoteUrl, repositoryKey } = await checkoutIdentity(
    cacheRoot, request, cwd, token, tokenIsExplicit, signal,
  );
  const advertisedEntry = join(parent, advertised.commit);
  const cachedRepo = await reusableCheckout(
    cacheRoot, advertisedEntry, repositoryKey, advertised.commit, remoteUrl, signal,
  );
  if (cachedRepo) {
    const sourceOperation = await retainCheckoutSource(
      repositoryMirrors,
      cachedRepo.sourceLease,
      cachedRepo.repoDir,
      repositoryKey,
      advertised.commit,
      signal,
    );
    touchMetadata(join(advertisedEntry, "metadata.json"));
    touchMetadata(cachedRepo.repoDir);
    return {
      branch: advertised.branch,
      commit: advertised.commit,
      cache: "hit",
      repoDir: cachedRepo.repoDir,
      repositoryKey,
      remoteUrl,
      sourceLease: cachedRepo.sourceLease,
      sourceOperation,
    };
  }
  await onPrepare();
  return prepareCheckout(
    cacheRoot, parent, repositoryKey, remoteUrl, advertised, gitToken, repositoryMirrors, signal,
  );
}

export async function probeCheckout(
  cacheRoot: string,
  request: GenerateRequest,
  cwd: string,
  repositoryMirrors: RepositoryMirrorPreparer,
  token?: string,
  tokenIsExplicit = false,
): Promise<CachedCheckout | null> {
  const { advertised, parent, remoteUrl, repositoryKey } = await checkoutIdentity(
    cacheRoot, request, cwd, token, tokenIsExplicit,
  );
  const entry = join(parent, advertised.commit);
  const repoDir = await validCheckout(cacheRoot, entry, repositoryKey, advertised.commit, remoteUrl);
  if (!repoDir) {
    return null;
  }
  touchMetadata(join(entry, "metadata.json"));
  touchMetadata(repoDir.repoDir);
  const sourceOperation = await retainCheckoutSource(
    repositoryMirrors,
    repoDir.sourceLease,
    repoDir.repoDir,
    repositoryKey,
    advertised.commit,
  );
  return {
    branch: advertised.branch,
    commit: advertised.commit,
    cache: "hit",
    repoDir: repoDir.repoDir,
    repositoryKey,
    remoteUrl,
    sourceLease: repoDir.sourceLease,
    sourceOperation,
  };
}

async function checkoutIdentity(
  cacheRoot: string,
  request: GenerateRequest,
  cwd: string,
  token?: string,
  tokenIsExplicit = false,
  signal?: AbortSignal,
): Promise<{
  advertised: AdvertisedRevision;
  gitToken?: string;
  parent: string;
  remoteUrl: string;
  repositoryKey: string;
}> {
  const remoteUrl = parseGitHubSource(request.value);
  const gitToken = gitTokenForRemote(remoteUrl, token, tokenIsExplicit);
  const repositoryKey = repositoryCacheKey(remoteUrl);
  return {
    advertised: await remoteCommit(remoteUrl, request.ref, cwd, gitToken, signal),
    gitToken,
    parent: join(cacheRoot, "repositories", repositoryKey),
    remoteUrl,
    repositoryKey,
  };
}

async function prepareCheckout(
  cacheRoot: string,
  parent: string,
  repositoryKey: string,
  remoteUrl: string,
  advertised: AdvertisedRevision,
  token: string | undefined,
  repositoryMirrors: RepositoryMirrorPreparer,
  signal?: AbortSignal,
): Promise<CachedCheckout> {
  const stage = createStageDirectory(parent);
  const destination = join(parent, advertised.commit);
  let mirrorLease: RepositoryWorktreeLease | undefined;
  let sourceOperation: RepositorySourceOperationLease | undefined;
  let wonPublication = false;
  try {
    const mirrorRemoteUrl = canonicalRepositoryUrl(remoteUrl);
    mirrorLease = await repositoryMirrors.prepare({
      repositoryKey: repositoryMirrorSecurityKey(repositoryCacheKey(mirrorRemoteUrl), token),
      remoteUrl: mirrorRemoteUrl,
      head: { ref: advertised.remoteRef, oid: advertised.commit },
      base: { ref: advertised.remoteRef, oid: advertised.commit },
      jobId: `base:${advertised.commit}`,
      token,
      ...(signal ? { signal } : {}),
    });
    const stagedRepo = mirrorLease.worktreeDir;
    const commit = requireCommit((await runGit(["rev-parse", "HEAD"], {
      cwd: stagedRepo,
      ...(signal ? { signal } : {}),
    })).trim());
    if (commit !== advertised.commit) {
      throw new WebError(409, "repository mirror prepared an unexpected revision");
    }
    const metadata: CheckoutMetadata = {
      formatVersion: CHECKOUT_FORMAT_VERSION,
      repositoryKey,
      commit,
      remoteUrl,
      sourceRoot: cacheRelativePath(cacheRoot, mirrorLease.worktreeDir),
      leaseMetadata: cacheRelativePath(
        cacheRoot,
        join(dirname(dirname(mirrorLease.worktreeDir)), "leases", `${mirrorLease.leaseId}.json`),
      ),
      sourceLease: {
        repositoryDigest: mirrorLease.repositoryDigest,
        leaseId: mirrorLease.leaseId,
      },
    };
    writePrivateJson(join(stage, "metadata.json"), metadata);
    const repoDir = await withCheckoutEntryLock(destination, signal, async () => {
      const existing = await validCheckout(cacheRoot, destination, repositoryKey, commit, remoteUrl, signal);
      if (existing) return existing;

      // Only the lock owner may repair or publish this immutable entry. Mirror preparation
      // happened above, so the critical section is limited to revalidation and atomic publication.
      removeEntry(destination);
      wonPublication = publishImmutable(stage, destination);
      const published = await validCheckout(cacheRoot, destination, repositoryKey, commit, remoteUrl, signal);
      if (!published) {
        if (wonPublication) removeEntry(destination);
        throw new WebError(422, "cached checkout failed verification");
      }
      return published;
    });
    sourceOperation = await retainCheckoutSource(
      repositoryMirrors,
      repoDir.sourceLease,
      repoDir.repoDir,
      repositoryKey,
      commit,
      signal,
    );
    removeEntry(stage);
    // Transfer the local reference before awaiting release. If release fails, that exact failure is
    // already authoritative and the outer cleanup must release only the source ownership that can
    // no longer be returned; it must not issue a duplicate mirror release attempt.
    const completedMirrorLease = mirrorLease;
    mirrorLease = undefined;
    await completedMirrorLease.release();
    return {
      branch: advertised.branch,
      cache: "miss",
      commit,
      repoDir: repoDir.repoDir,
      repositoryKey,
      remoteUrl,
      sourceLease: repoDir.sourceLease,
      sourceOperation,
    };
  } catch (error) {
    return withOwnershipCleanup(
      () => { throw error; },
      [
        () => sourceOperation?.release(),
        () => mirrorLease?.release(),
        () => { if (wonPublication) removeEntry(destination); },
        () => removeEntry(stage),
      ],
      "checkout preparation",
    );
  }
}

async function validCheckout(
  cacheRoot: string,
  entry: string,
  repositoryKey: string,
  commit: string,
  remoteUrl: string,
  signal?: AbortSignal,
): Promise<ValidCheckout | null> {
  try {
    const metadata = readJson(join(entry, "metadata.json")) as Partial<CheckoutMetadata>;
    if (
      metadata.formatVersion !== CHECKOUT_FORMAT_VERSION
      || metadata.repositoryKey !== repositoryKey
      || metadata.commit !== commit
      || metadata.remoteUrl !== remoteUrl
    ) {
      return null;
    }
    if (typeof metadata.sourceRoot !== "string"
      || typeof metadata.leaseMetadata !== "string"
      || !validSourceLease(metadata.sourceLease)) return null;
    const repoDir = resolveCacheRelativePath(cacheRoot, metadata.sourceRoot);
    const leaseMetadata = resolveCacheRelativePath(cacheRoot, metadata.leaseMetadata);
    if (!repoDir || !isDirectory(repoDir) || !leaseMetadata || !statSync(leaseMetadata).isFile()) return null;
    const expectedLeaseMetadata = join(dirname(dirname(repoDir)), "leases", `${basename(repoDir)}.json`);
    if (leaseMetadata !== expectedLeaseMetadata
      || metadata.sourceLease.leaseId !== basename(repoDir)
      || metadata.sourceLease.repositoryDigest !== basename(dirname(dirname(repoDir)))) return null;
    return requireCommit((await runGit(["rev-parse", "HEAD"], {
      cwd: repoDir,
      ...(signal ? { signal } : {}),
    })).trim()) === commit
      ? { repoDir, sourceLease: metadata.sourceLease }
      : null;
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error;
    return null;
  }
}

async function retainCheckoutSource(
  repositoryMirrors: RepositoryMirrorPreparer,
  sourceLease: RepositorySourceLeaseReference,
  repoDir: string,
  repositoryKey: string,
  commit: string,
  signal?: AbortSignal,
): Promise<RepositorySourceOperationLease> {
  const cacheOwner = `checkout-cache:${repositoryKey}:${commit}`;
  await repositoryMirrors.retainSource(
    sourceLease,
    repoDir,
    cacheOwner,
    Date.now() + CHECKOUT_ALIAS_TTL_MS,
  );
  try {
    return await repositoryMirrors.acquireSource(
      sourceLease,
      repoDir,
      `checkout:${repositoryKey}:${commit}`,
      signal,
    );
  } catch (error) {
    // The cache owner deliberately remains: the immutable alias is still a valid soft root and a
    // later read may retry. Its bounded deadline is renewed only by successful alias reads.
    throw error;
  }
}

function validSourceLease(value: unknown): value is RepositorySourceLeaseReference {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const lease = value as Partial<RepositorySourceLeaseReference>;
  return typeof lease.repositoryDigest === "string" && /^[0-9a-f]{64}$/.test(lease.repositoryDigest)
    && typeof lease.leaseId === "string" && /^[0-9a-f]{64}$/.test(lease.leaseId);
}

async function remoteCommit(
  url: string,
  ref: string | undefined,
  cwd: string,
  token?: string,
  signal?: AbortSignal,
): Promise<AdvertisedRevision> {
  const patterns = ref ? [`refs/heads/${ref}`, `refs/tags/${ref}`, `refs/tags/${ref}^{}`] : ["HEAD"];
  const output = await runGit(["ls-remote", "--exit-code", url, ...patterns], {
    cwd,
    token,
    ...(signal ? { signal } : {}),
  });
  const rows = output.trim().split("\n").map((line) => line.trim().split(/\s+/, 2));
  const preferred = ref
    ? [`refs/heads/${ref}`, `refs/tags/${ref}^{}`, `refs/tags/${ref}`]
    : ["HEAD"];
  for (const name of preferred) {
    const row = rows.find(([, candidate]) => candidate === name);
    if (row?.[0]) {
      const remoteRef = name.endsWith("^{}") ? name.slice(0, -3) : name;
      return {
        branch: name.startsWith("refs/heads/") ? ref : undefined,
        commit: requireCommit(row[0]),
        remoteRef,
      };
    }
  }
  throw new WebError(422, `remote ref was not found: ${ref ?? "HEAD"}`);
}

function requireCommit(value: string): string {
  if (!COMMIT.test(value)) {
    throw new WebError(422, "git returned an invalid commit id");
  }
  return value.toLowerCase();
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24);
}

export function repositoryCacheKey(remoteUrl: string): string {
  return hash([REPOSITORY_IDENTITY_VERSION, remoteUrl]);
}

/**
 * Fast-path valid entries without serialization. A miss is always revalidated while holding the
 * sibling entry lock before deletion, so a concurrent immutable publisher can never have its
 * freshly published checkout removed by a stale validation result.
 */
async function reusableCheckout(
  cacheRoot: string,
  entry: string,
  repositoryKey: string,
  commit: string,
  remoteUrl: string,
  signal?: AbortSignal,
): Promise<ValidCheckout | null> {
  const cached = await validCheckout(cacheRoot, entry, repositoryKey, commit, remoteUrl, signal);
  if (cached) return cached;
  return withCheckoutEntryLock(entry, signal, async () => {
    const revalidated = await validCheckout(cacheRoot, entry, repositoryKey, commit, remoteUrl, signal);
    if (revalidated) return revalidated;
    removeEntry(entry);
    return null;
  });
}

async function withCheckoutEntryLock<T>(
  entry: string,
  signal: AbortSignal | undefined,
  run: () => Promise<T>,
): Promise<T> {
  const unlock = await acquireCheckoutEntryLock(`${entry}.lock`, signal);
  try {
    return await run();
  } finally {
    unlock();
  }
}

async function acquireCheckoutEntryLock(lockPath: string, signal?: AbortSignal): Promise<() => void> {
  createPrivateDirectory(dirname(lockPath));
  const startedAt = Date.now();
  while (true) {
    throwIfAborted(signal);
    const lockId = randomUUID();
    try {
      mkdirSync(lockPath, { mode: 0o700 });
      writePrivateJson(join(lockPath, "owner.json"), { lockId, pid: process.pid, acquiredAtMs: Date.now() });
      const heartbeat = setInterval(() => {
        if (!lockOwnedBy(lockPath, lockId)) return;
        try {
          const now = new Date();
          utimesSync(lockPath, now, now);
        } catch {
          // The owner can release the lock between the ownership check and the timestamp update.
        }
      }, Math.floor(CHECKOUT_LOCK_STALE_MS / 3));
      heartbeat.unref?.();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        clearInterval(heartbeat);
        if (lockOwnedBy(lockPath, lockId)) removeEntry(lockPath);
      };
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      if (Date.now() - entryMtime(lockPath) > CHECKOUT_LOCK_STALE_MS) {
        const quarantine = `${lockPath}.stale-${process.pid}-${randomUUID()}`;
        try {
          // Rename claims the exact stale directory inspected. Cleanup can no longer remove a
          // replacement lock created at the original path by another process.
          renameSync(lockPath, quarantine);
          removeEntry(quarantine);
        } catch (renameError) {
          const code = errorCode(renameError);
          if (code !== "ENOENT" && code !== "EEXIST") throw renameError;
        }
        continue;
      }
      if (Date.now() - startedAt >= CHECKOUT_LOCK_TIMEOUT_MS) {
        throw new WebError(503, "timed out waiting for checkout cache lock");
      }
      await abortableDelay(CHECKOUT_LOCK_POLL_MS, signal);
    }
  }
}

function entryMtime(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function lockOwnedBy(lockPath: string, lockId: string): boolean {
  try {
    const owner = readJson(join(lockPath, "owner.json")) as { lockId?: unknown };
    return owner.lockId === lockId;
  } catch {
    return false;
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const error = new Error("checkout cache operation aborted");
  error.name = "AbortError";
  throw error;
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  return new Promise((resolveDelay, rejectDelay) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolveDelay();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      try {
        throwIfAborted(signal);
      } catch (error) {
        rejectDelay(error);
      }
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function cacheRelativePath(cacheRoot: string, path: string): string {
  const root = realpathSync(cacheRoot);
  const canonical = realpathSync(path);
  const portable = relative(root, canonical).split(sep).join("/");
  if (!portable || portable === ".." || portable.startsWith("../")) {
    throw new WebError(500, "repository worktree escaped the cache root");
  }
  return portable;
}

function resolveCacheRelativePath(cacheRoot: string, portable: string): string | null {
  if (!portable || portable.includes("\\") || portable.startsWith("/")) return null;
  const parts = portable.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) return null;
  const root = realpathSync(cacheRoot);
  const candidate = resolve(root, ...parts);
  if (candidate !== root && !candidate.startsWith(root + sep)) return null;
  try {
    const canonical = realpathSync(candidate);
    return canonical === root || canonical.startsWith(root + sep) ? canonical : null;
  } catch {
    return null;
  }
}
