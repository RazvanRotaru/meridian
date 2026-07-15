import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, realpathSync, renameSync, statSync, utimesSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import {
  buildCloneArgs,
  canonicalRepositoryUrl,
  gitTokenForRemote,
  parseGitHubSource,
} from "./clone";
import type { GenerateRequest } from "./web-request";
import { runGit, runGitClone } from "./git-exec";
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
import { RepositoryMirrorStore, repositoryMirrorSecurityKey } from "./repository-mirror";
import type { RepositoryWorktreeLease } from "./repository-mirror";

const CHECKOUT_FORMAT_VERSION = 3;
// This version belongs to repository identity, not checkout metadata; changing it intentionally
// moves repositories into a new cache namespace.
const REPOSITORY_IDENTITY_VERSION = 2;
const CHECKOUT_LOCK_TIMEOUT_MS = 30_000;
const CHECKOUT_LOCK_POLL_MS = 25;
const CHECKOUT_LOCK_STALE_MS = 10 * 60_000;
const COMMIT = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;

export interface CachedCheckout {
  branch?: string;
  cache: "hit" | "miss";
  commit: string;
  repoDir: string;
  repositoryKey: string;
  remoteUrl: string;
}

interface CheckoutMetadata {
  formatVersion: typeof CHECKOUT_FORMAT_VERSION;
  repositoryKey: string;
  commit: string;
  remoteUrl: string;
  sourceRoot?: string;
  leaseMetadata?: string;
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
  token?: string,
  onClone: () => void | Promise<void> = () => {},
  tokenIsExplicit = false,
  repositoryMirrors?: RepositoryMirrorStore,
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
    touchMetadata(join(advertisedEntry, "metadata.json"));
    touchMetadata(cachedRepo);
    return { branch: advertised.branch, commit: advertised.commit, cache: "hit", repoDir: cachedRepo, repositoryKey, remoteUrl };
  }
  await onClone();
  return cloneCheckout(
    cacheRoot, parent, repositoryKey, remoteUrl, request.ref, advertised, gitToken, repositoryMirrors, signal,
  );
}

export async function probeCheckout(
  cacheRoot: string,
  request: GenerateRequest,
  cwd: string,
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
  touchMetadata(repoDir);
  return { branch: advertised.branch, commit: advertised.commit, cache: "hit", repoDir, repositoryKey, remoteUrl };
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

async function cloneCheckout(
  cacheRoot: string,
  parent: string,
  repositoryKey: string,
  remoteUrl: string,
  ref: string | undefined,
  advertised: AdvertisedRevision,
  token: string | undefined,
  repositoryMirrors?: RepositoryMirrorStore,
  signal?: AbortSignal,
): Promise<CachedCheckout> {
  const stage = createStageDirectory(parent);
  let stagedRepo = join(stage, "repo");
  let mirrorLease: RepositoryWorktreeLease | undefined;
  try {
    if (repositoryMirrors) {
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
      stagedRepo = mirrorLease.worktreeDir;
    } else {
      await runGitClone(buildCloneArgs(remoteUrl, stagedRepo, { ref, token }), token, {
        ...(signal ? { signal } : {}),
      });
    }
    const commit = requireCommit((await runGit(["rev-parse", "HEAD"], {
      cwd: stagedRepo,
      ...(signal ? { signal } : {}),
    })).trim());
    const metadata: CheckoutMetadata = {
      formatVersion: CHECKOUT_FORMAT_VERSION,
      repositoryKey,
      commit,
      remoteUrl,
      ...(mirrorLease ? {
        sourceRoot: cacheRelativePath(cacheRoot, mirrorLease.worktreeDir),
        leaseMetadata: cacheRelativePath(
          cacheRoot,
          join(dirname(dirname(mirrorLease.worktreeDir)), "leases", `${mirrorLease.leaseId}.json`),
        ),
      } : {}),
    };
    writePrivateJson(join(stage, "metadata.json"), metadata);
    const destination = join(parent, commit);
    let wonPublication = false;
    const repoDir = await withCheckoutEntryLock(destination, signal, async () => {
      const existing = await validCheckout(cacheRoot, destination, repositoryKey, commit, remoteUrl, signal);
      if (existing) return existing;

      // Only the lock owner may repair or publish this immutable entry. Clone/fetch happened
      // above, so the critical section is limited to revalidation and atomic publication.
      removeEntry(destination);
      wonPublication = publishImmutable(stage, destination);
      const published = await validCheckout(cacheRoot, destination, repositoryKey, commit, remoteUrl, signal);
      if (!published) {
        if (wonPublication) removeEntry(destination);
        throw new WebError(422, "cached checkout failed verification");
      }
      return published;
    });
    if (!wonPublication) {
      removeEntry(stage);
      await mirrorLease?.release();
    }
    return { branch: advertised.branch, cache: "miss", commit, repoDir, repositoryKey, remoteUrl };
  } catch (error) {
    await mirrorLease?.release().catch(() => undefined);
    removeEntry(stage);
    throw error;
  }
}

async function validCheckout(
  cacheRoot: string,
  entry: string,
  repositoryKey: string,
  commit: string,
  remoteUrl: string,
  signal?: AbortSignal,
): Promise<string | null> {
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
    const repoDir = metadata.sourceRoot
      ? resolveCacheRelativePath(cacheRoot, metadata.sourceRoot)
      : join(entry, "repo");
    if (!repoDir || !isDirectory(repoDir)) return null;
    return requireCommit((await runGit(["rev-parse", "HEAD"], {
      cwd: repoDir,
      ...(signal ? { signal } : {}),
    })).trim()) === commit
      ? repoDir
      : null;
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error;
    return null;
  }
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
): Promise<string | null> {
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
