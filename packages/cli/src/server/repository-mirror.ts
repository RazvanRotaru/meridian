/**
 * A node-local Git object cache for concurrent repository inspections.
 *
 * One bare partial mirror is kept for each caller-provided repository/security key. Every job
 * fetches into private refs and receives a detached, uniquely named worktree. The caller's key,
 * job label, and credential are never written to disk; only hashes and credential-free remotes
 * are persisted. A small directory lock serializes operations that may contact the remote while
 * extraction and graph work remain fully parallel in the leased worktrees.
 */

import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, renameSync, statSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { runGit } from "./git-exec";
import {
  createPrivateDirectory,
  readJson,
  removeEntry,
  writePrivateJson,
} from "./web-cache-storage";
import { WebError } from "./web-error";

const FORMAT_VERSION = 1;
const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const SAFE_ID = /^[0-9a-f]{64}$/;
const FORBIDDEN_REF_CHARACTER = /[\x00-\x20\x7f~^:?*\[\\]/u;
const DEFAULT_GIT_TIMEOUT_MS = 300_000;
const DEFAULT_LOCK_TIMEOUT_MS = 30_000;
const DEFAULT_LOCK_POLL_MS = 25;
const DEFAULT_STALE_LOCK_MS = 10 * 60_000;
const DEFAULT_LEASE_MAX_AGE_MS = 6 * 60 * 60_000;

export interface RepositoryRevision {
  /** Fully qualified advertised ref, for example `refs/pull/41/head`. */
  ref: string;
  /** Commit OID resolved before the mirror is prepared. */
  oid: string;
}

export interface PrepareRepositoryWorktree {
  /**
   * Stable repository + authorization-domain identity supplied by the caller. Repositories that
   * must not share objects must use different keys, even when their remote URL is the same.
   */
  repositoryKey: string;
  /** Credential-free remote URL. Pass credentials separately in `token`. */
  remoteUrl: string;
  head: RepositoryRevision;
  base: RepositoryRevision;
  /** Optional diagnostic label. It contributes to a hash but is never persisted verbatim. */
  jobId?: string;
  /** Passed only to Git's transient HTTP header configuration by the shared Git runner. */
  token?: string;
  signal?: AbortSignal;
}

export interface PrepareDetachedRepositoryRevision {
  /** Full commit OID that is already present in this lease's repository mirror. */
  oid: string;
  /** Optional diagnostic label. It contributes to a hash but is never persisted verbatim. */
  jobId?: string;
  signal?: AbortSignal;
}

export interface RepositoryDetachedWorktreeLease {
  readonly leaseId: string;
  readonly repositoryDigest: string;
  readonly worktreeDir: string;
  readonly oid: string;
  /** Job-private ref suitable for extraction commands that need a stable commit name. */
  readonly ref: string;
  /** Renew a long-running extraction so startup scavenging cannot reclaim it. */
  touch(): void;
  /** Remove the worktree and its private ref. Safe to call repeatedly. */
  release(): Promise<void>;
}

export interface RepositoryWorktreeLease {
  readonly leaseId: string;
  readonly repositoryDigest: string;
  readonly worktreeDir: string;
  readonly headOid: string;
  readonly baseOid: string;
  /** Job-private refs suitable for `git diff` and other inspection commands. */
  readonly headRef: string;
  readonly baseRef: string;
  /**
   * Materialize an already-present commit in a second isolated worktree without another fetch.
   * The child automatically stays in this lease's repository and authorization domain.
   */
  prepareDetachedRevision(
    request: PrepareDetachedRepositoryRevision,
  ): Promise<RepositoryDetachedWorktreeLease>;
  /** Renew a long-running inspection so startup scavenging cannot reclaim it. */
  touch(): void;
  /** Remove the worktree and its private refs. Safe to call repeatedly. */
  release(): Promise<void>;
}

export interface RepositoryGitOptions {
  cwd: string;
  token?: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

/** Injectable for focused tests and for a future child-process runner with active cancellation. */
export type RepositoryGitRunner = (
  args: readonly string[],
  options: RepositoryGitOptions,
) => Promise<string>;

export interface RepositoryMirrorStoreOptions {
  cacheRoot: string;
  git?: RepositoryGitRunner;
  now?: () => number;
  makeId?: () => string;
  gitTimeoutMs?: number;
  lockTimeoutMs?: number;
  lockPollMs?: number;
  staleLockMs?: number;
}

export interface ScavengeRepositoryMirrorsOptions {
  maxLeaseAgeMs?: number;
  now?: number;
  signal?: AbortSignal;
}

export interface RepositoryMirrorScavengeResult {
  repositoriesVisited: number;
  leasesRemoved: number;
  orphanWorktreesRemoved: number;
  orphanRefsRemoved: number;
}

/** Keep private object stores separated by the effective credential/security domain. */
export function repositoryMirrorSecurityKey(repositoryKey: string, token?: string): string {
  const authorizationDomain = token ? createHash("sha256").update(token).digest("hex") : "anonymous";
  return `${repositoryKey}:${authorizationDomain}`;
}

interface MirrorMetadata {
  formatVersion: number;
  repositoryDigest: string;
  remoteUrl: string;
}

interface LeaseRecordBase {
  formatVersion: number;
  leaseId: string;
  kind: "inspection" | "detached";
  state: "preparing" | "active";
  createdAtMs: number;
  updatedAtMs: number;
}

interface InspectionLeaseRecord extends LeaseRecordBase {
  kind: "inspection";
  headRef: string;
  baseRef: string;
  headOid: string;
  baseOid: string;
}

interface DetachedLeaseRecord extends LeaseRecordBase {
  kind: "detached";
  parentLeaseId: string;
  ref: string;
  oid: string;
}

type LeaseRecord = InspectionLeaseRecord | DetachedLeaseRecord;

interface DerivedLeaseRecord extends LeaseRecordBase {
  kind: "inspection";
  headRef: string;
  baseRef: string;
  headOid: string;
  baseOid: string;
  /** A corrupt record may have belonged to either lease kind, so reclaim every derived ref. */
  cleanupRefs: readonly string[];
}

interface RepositoryPaths {
  repositoryRoot: string;
  mirrorDir: string;
  mirrorMetadata: string;
  worktreesDir: string;
  leasesDir: string;
  fetchLock: string;
}

interface LeasePaths {
  worktreeDir: string;
  metadata: string;
}

/**
 * Owns node-local mirrors and hands out isolated worktree leases.
 *
 * AbortSignals are forwarded into the shared Git runner, which terminates the active subprocess,
 * and are also checked between commands and while waiting for the filesystem lock.
 */
export class RepositoryMirrorStore {
  private readonly cacheRoot: string;
  private readonly git: RepositoryGitRunner;
  private readonly now: () => number;
  private readonly makeId: () => string;
  private readonly gitTimeoutMs: number;
  private readonly lockTimeoutMs: number;
  private readonly lockPollMs: number;
  private readonly staleLockMs: number;

  constructor(options: RepositoryMirrorStoreOptions) {
    if (!options.cacheRoot.trim()) {
      throw new WebError(500, "repository mirror cache root is required");
    }
    this.cacheRoot = options.cacheRoot;
    this.git = options.git ?? defaultGitRunner;
    this.now = options.now ?? Date.now;
    this.makeId = options.makeId ?? randomUUID;
    this.gitTimeoutMs = positiveDuration(options.gitTimeoutMs, DEFAULT_GIT_TIMEOUT_MS, "git timeout");
    this.lockTimeoutMs = positiveDuration(options.lockTimeoutMs, DEFAULT_LOCK_TIMEOUT_MS, "lock timeout");
    this.lockPollMs = positiveDuration(options.lockPollMs, DEFAULT_LOCK_POLL_MS, "lock poll interval");
    this.staleLockMs = positiveDuration(options.staleLockMs, DEFAULT_STALE_LOCK_MS, "stale lock age");
  }

  async prepare(request: PrepareRepositoryWorktree): Promise<RepositoryWorktreeLease> {
    const repositoryKey = requireNonEmpty(request.repositoryKey, "repository key");
    const remoteUrl = requireCredentialFreeRemote(request.remoteUrl);
    const head = requireRevision(request.head, "head");
    const base = requireRevision(request.base, "base");
    throwIfAborted(request.signal);

    const repositoryDigest = digest([FORMAT_VERSION, repositoryKey]);
    const repositoryPaths = this.pathsForDigest(repositoryDigest);
    createPrivateDirectory(repositoryPaths.repositoryRoot);
    createPrivateDirectory(repositoryPaths.worktreesDir);
    createPrivateDirectory(repositoryPaths.leasesDir);

    const leaseId = this.newLeaseId(repositoryDigest, request.jobId, repositoryPaths);
    const refs = refsForLease(leaseId);
    const leasePaths = this.leasePaths(repositoryPaths, leaseId);
    const timestamp = this.now();
    const record: InspectionLeaseRecord = {
      formatVersion: FORMAT_VERSION,
      leaseId,
      kind: "inspection",
      state: "preparing",
      headRef: refs.headRef,
      baseRef: refs.baseRef,
      headOid: head.oid,
      baseOid: base.oid,
      createdAtMs: timestamp,
      updatedAtMs: timestamp,
    };

    let unlock: (() => void) | undefined;
    let refsMayExist = false;
    try {
      unlock = await this.acquireFetchLock(repositoryPaths, request.signal);
      await this.ensureMirror(repositoryPaths, repositoryDigest, remoteUrl, request.signal);
      // This record is published before refs so a crash is always discoverable by the scavenger.
      writePrivateJson(leasePaths.metadata, record);
      refsMayExist = true;
      unlock();
      unlock = undefined;

      // Job refs are unique, Git's object writes are content-addressed, and maintenance is off, so
      // separate PR fetches may safely overlap without holding Meridian's repository-admin lock.
      await this.gitCommand(
        [
          "fetch",
          "--force",
          "--no-tags",
          "--filter=blob:none",
          "--no-write-fetch-head",
          "--no-auto-maintenance",
          "origin",
          `+${head.ref}:${refs.headRef}`,
          `+${base.ref}:${refs.baseRef}`,
        ],
        { cwd: repositoryPaths.mirrorDir, token: request.token, signal: request.signal },
      );
      await this.verifyRef(repositoryPaths.mirrorDir, refs.headRef, head.oid, request.signal);
      await this.verifyRef(repositoryPaths.mirrorDir, refs.baseRef, base.oid, request.signal);

      // Only the fast worktree-admin registration is serialized. `--no-checkout` prevents this
      // section from downloading/materializing blobs while another PR is waiting for the lock.
      unlock = await this.acquireFetchLock(repositoryPaths, request.signal);
      await this.gitCommand(
        ["worktree", "add", "--detach", "--no-checkout", leasePaths.worktreeDir, refs.headRef],
        { cwd: repositoryPaths.mirrorDir, signal: request.signal },
      );
      unlock();
      unlock = undefined;

      // Materialization can lazily fetch many blobs. It runs in the isolated worktree and outside
      // Meridian's lock, allowing another PR to prepare while this one downloads or checks out.
      await this.gitCommand(
        ["reset", "--hard", "HEAD"],
        { cwd: leasePaths.worktreeDir, token: request.token, signal: request.signal },
      );
      await this.verifyRef(leasePaths.worktreeDir, "HEAD", head.oid, request.signal);

      record.state = "active";
      record.updatedAtMs = this.now();
      writePrivateJson(leasePaths.metadata, record);
      return this.createInspectionLease(
        repositoryPaths,
        leasePaths,
        repositoryDigest,
        record,
        request.token,
      );
    } catch (error) {
      if (refsMayExist) {
        if (unlock) {
          await this.cleanupLease(repositoryPaths, leasePaths, record).catch(() => undefined);
        } else {
          await this.releaseLease(repositoryPaths, leasePaths, record).catch(() => undefined);
        }
      } else {
        removeEntry(leasePaths.metadata);
        removeEntry(leasePaths.worktreeDir);
      }
      throw error;
    } finally {
      unlock?.();
    }
  }

  private async prepareDetachedRevision(
    repositoryPaths: RepositoryPaths,
    repositoryDigest: string,
    parentPaths: LeasePaths,
    parentRecord: InspectionLeaseRecord,
    token: string | undefined,
    request: PrepareDetachedRepositoryRevision,
  ): Promise<RepositoryDetachedWorktreeLease> {
    const oid = normalizeOid(request.oid);
    throwIfAborted(request.signal);
    this.verifyActiveParentLease(parentPaths, parentRecord);

    const leaseId = this.newLeaseId(repositoryDigest, request.jobId, repositoryPaths);
    const refs = refsForLease(leaseId);
    const leasePaths = this.leasePaths(repositoryPaths, leaseId);
    const timestamp = this.now();
    const record: DetachedLeaseRecord = {
      formatVersion: FORMAT_VERSION,
      leaseId,
      kind: "detached",
      state: "preparing",
      parentLeaseId: parentRecord.leaseId,
      ref: refs.commitRef,
      oid,
      createdAtMs: timestamp,
      updatedAtMs: timestamp,
    };

    let unlock: (() => void) | undefined;
    let refMayExist = false;
    try {
      // Refuse to use an arbitrary or missing object. This command only resolves local objects;
      // the API deliberately has no ref or remote input and never issues a second fetch.
      await this.verifyPresentCommit(repositoryPaths.mirrorDir, oid, request.signal);
      writePrivateJson(leasePaths.metadata, record);
      refMayExist = true;
      await this.gitCommand(
        ["update-ref", refs.commitRef, oid, "0".repeat(oid.length)],
        { cwd: repositoryPaths.mirrorDir, signal: request.signal },
      );
      await this.verifyRef(repositoryPaths.mirrorDir, refs.commitRef, oid, request.signal);

      // Only Git's shared worktree registry is protected. Private-ref creation and checkout blob
      // materialization are safe to overlap across child leases.
      unlock = await this.acquireFetchLock(repositoryPaths, request.signal);
      await this.gitCommand(
        ["worktree", "add", "--detach", "--no-checkout", leasePaths.worktreeDir, refs.commitRef],
        { cwd: repositoryPaths.mirrorDir, signal: request.signal },
      );
      unlock();
      unlock = undefined;

      await this.gitCommand(
        ["reset", "--hard", "HEAD"],
        { cwd: leasePaths.worktreeDir, token, signal: request.signal },
      );
      await this.verifyRef(leasePaths.worktreeDir, "HEAD", oid, request.signal);

      record.state = "active";
      record.updatedAtMs = this.now();
      writePrivateJson(leasePaths.metadata, record);
      return this.createDetachedLease(repositoryPaths, leasePaths, repositoryDigest, record);
    } catch (error) {
      if (refMayExist) {
        if (unlock) {
          await this.cleanupLease(repositoryPaths, leasePaths, record).catch(() => undefined);
        } else {
          await this.releaseLease(repositoryPaths, leasePaths, record).catch(() => undefined);
        }
      } else {
        removeEntry(leasePaths.metadata);
        removeEntry(leasePaths.worktreeDir);
      }
      throw error;
    } finally {
      unlock?.();
    }
  }

  /** Reclaim expired leases plus crash-orphaned worktrees and job refs. */
  async scavenge(options: ScavengeRepositoryMirrorsOptions = {}): Promise<RepositoryMirrorScavengeResult> {
    const maxLeaseAgeMs = nonNegativeDuration(
      options.maxLeaseAgeMs,
      DEFAULT_LEASE_MAX_AGE_MS,
      "maximum lease age",
    );
    const cutoff = (options.now ?? this.now()) - maxLeaseAgeMs;
    const result: RepositoryMirrorScavengeResult = {
      repositoriesVisited: 0,
      leasesRemoved: 0,
      orphanWorktreesRemoved: 0,
      orphanRefsRemoved: 0,
    };
    const repositoriesRoot = this.repositoriesRoot();
    if (!isPlainDirectory(repositoriesRoot)) return result;

    for (const repositoryDigest of plainDirectoryNames(repositoriesRoot).filter((name) => SAFE_ID.test(name))) {
      throwIfAborted(options.signal);
      const paths = this.pathsForDigest(repositoryDigest);
      if (!isPlainDirectory(paths.mirrorDir)) continue;
      const unlock = await this.acquireFetchLock(paths, options.signal);
      try {
        result.repositoriesVisited += 1;
        const metadataIds = new Set(leaseMetadataIds(paths.leasesDir));
        for (const leaseId of metadataIds) {
          const leasePaths = this.leasePaths(paths, leaseId);
          const record = readLeaseRecord(leasePaths.metadata, leaseId);
          // Snapshot source resolution touches the worktree root, so restart-safe reads renew the
          // same lease even when no in-memory RepositoryWorktreeLease object exists anymore.
          if (Math.max(record.updatedAtMs, entryMtime(leasePaths.worktreeDir)) <= cutoff) {
            await this.cleanupLease(paths, leasePaths, record);
            result.leasesRemoved += 1;
          }
        }

        const remainingIds = new Set(leaseMetadataIds(paths.leasesDir));
        for (const leaseId of plainDirectoryNames(paths.worktreesDir).filter((name) => SAFE_ID.test(name))) {
          if (remainingIds.has(leaseId)) continue;
          const leasePaths = this.leasePaths(paths, leaseId);
          if (entryMtime(leasePaths.worktreeDir) <= cutoff) {
            await this.cleanupLease(paths, leasePaths, derivedLeaseRecord(leaseId, leasePaths.worktreeDir));
            result.orphanWorktreesRemoved += 1;
          }
        }

        const liveIds = new Set(leaseMetadataIds(paths.leasesDir));
        const refs = await this.listJobRefs(paths.mirrorDir, options.signal);
        for (const ref of refs) {
          const leaseId = leaseIdFromRef(ref);
          if (!leaseId || liveIds.has(leaseId)) continue;
          const leasePaths = this.leasePaths(paths, leaseId);
          if (existsSync(leasePaths.worktreeDir)) continue;
          await this.gitCommand(["update-ref", "-d", ref], { cwd: paths.mirrorDir, signal: options.signal });
          result.orphanRefsRemoved += 1;
        }
        await this.gitCommand(["worktree", "prune", "--expire", "now"], {
          cwd: paths.mirrorDir,
          signal: options.signal,
        });
      } finally {
        unlock();
      }
    }
    return result;
  }

  private repositoriesRoot(): string {
    return join(this.cacheRoot, "repository-mirrors", `v${FORMAT_VERSION}`);
  }

  private pathsForDigest(repositoryDigest: string): RepositoryPaths {
    const repositoryRoot = join(this.repositoriesRoot(), repositoryDigest);
    return {
      repositoryRoot,
      mirrorDir: join(repositoryRoot, "objects.git"),
      mirrorMetadata: join(repositoryRoot, "mirror.json"),
      worktreesDir: join(repositoryRoot, "worktrees"),
      leasesDir: join(repositoryRoot, "leases"),
      fetchLock: join(repositoryRoot, "fetch.lock"),
    };
  }

  private leasePaths(paths: RepositoryPaths, leaseId: string): LeasePaths {
    return {
      worktreeDir: join(paths.worktreesDir, leaseId),
      metadata: join(paths.leasesDir, `${leaseId}.json`),
    };
  }

  private newLeaseId(repositoryDigest: string, jobId: string | undefined, paths: RepositoryPaths): string {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const leaseId = digest([repositoryDigest, jobId ?? "", this.makeId()]);
      const leasePaths = this.leasePaths(paths, leaseId);
      if (!existsSync(leasePaths.metadata) && !existsSync(leasePaths.worktreeDir)) return leaseId;
    }
    throw new WebError(409, "could not allocate a unique repository worktree lease");
  }

  private async ensureMirror(
    paths: RepositoryPaths,
    repositoryDigest: string,
    remoteUrl: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (existsSync(paths.mirrorMetadata)) {
      const metadata = mirrorMetadata(paths.mirrorMetadata);
      if (
        metadata.formatVersion !== FORMAT_VERSION
        || metadata.repositoryDigest !== repositoryDigest
        || metadata.remoteUrl !== remoteUrl
      ) {
        throw new WebError(409, "repository mirror key is already bound to a different remote");
      }
      const bare = (await this.gitCommand(["rev-parse", "--is-bare-repository"], {
        cwd: paths.mirrorDir,
        signal,
      })).trim();
      const configuredRemote = (await this.gitCommand(["config", "--get", "remote.origin.url"], {
        cwd: paths.mirrorDir,
        signal,
      })).trim();
      if (bare !== "true" || configuredRemote !== remoteUrl) {
        throw new WebError(409, "repository mirror failed integrity verification");
      }
      return;
    }

    createPrivateDirectory(paths.mirrorDir);
    await this.gitCommand(["init", "--bare", "--quiet", "."], { cwd: paths.mirrorDir, signal });
    await this.gitCommand(["config", "gc.auto", "0"], { cwd: paths.mirrorDir, signal });
    await this.gitCommand(["config", "remote.origin.url", remoteUrl], { cwd: paths.mirrorDir, signal });
    await this.gitCommand(["config", "remote.origin.promisor", "true"], { cwd: paths.mirrorDir, signal });
    await this.gitCommand(["config", "remote.origin.partialclonefilter", "blob:none"], {
      cwd: paths.mirrorDir,
      signal,
    });
    writePrivateJson(paths.mirrorMetadata, {
      formatVersion: FORMAT_VERSION,
      repositoryDigest,
      remoteUrl,
    } satisfies MirrorMetadata);
  }

  private async verifyRef(cwd: string, ref: string, expectedOid: string, signal?: AbortSignal): Promise<void> {
    const actual = normalizeOid((await this.gitCommand(["rev-parse", `${ref}^{commit}`], { cwd, signal })).trim());
    if (actual !== expectedOid) {
      throw new WebError(409, "repository revision changed while preparing inspection; retry");
    }
  }

  private async verifyPresentCommit(cwd: string, oid: string, signal?: AbortSignal): Promise<void> {
    let actual: string;
    try {
      const output = (await this.gitCommand(["rev-parse", `${oid}^{commit}`], { cwd, signal })).trim();
      if (!OID.test(output)) throw new Error("commit is not present");
      actual = output.toLowerCase();
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new WebError(409, "requested repository commit is not present in the active mirror");
    }
    if (actual !== oid) {
      throw new WebError(409, "requested repository commit is not present in the active mirror");
    }
  }

  private verifyActiveParentLease(
    leasePaths: LeasePaths,
    expected: InspectionLeaseRecord,
  ): void {
    if (!existsSync(leasePaths.metadata)) {
      throw new WebError(409, "repository worktree lease is no longer active");
    }
    const persisted = readLeaseRecord(leasePaths.metadata, expected.leaseId);
    if (
      "cleanupRefs" in persisted
      || persisted.kind !== "inspection"
      || persisted.state !== "active"
      || persisted.headOid !== expected.headOid
      || persisted.baseOid !== expected.baseOid
    ) {
      throw new WebError(409, "repository worktree lease is no longer active");
    }
  }

  private createInspectionLease(
    repositoryPaths: RepositoryPaths,
    leasePaths: LeasePaths,
    repositoryDigest: string,
    record: InspectionLeaseRecord,
    token: string | undefined,
  ): RepositoryWorktreeLease {
    let releasePromise: Promise<void> | undefined;
    let releaseStarted = false;
    const store = this;
    return {
      leaseId: record.leaseId,
      repositoryDigest,
      worktreeDir: leasePaths.worktreeDir,
      headOid: record.headOid,
      baseOid: record.baseOid,
      headRef: record.headRef,
      baseRef: record.baseRef,
      prepareDetachedRevision(request): Promise<RepositoryDetachedWorktreeLease> {
        if (releaseStarted) {
          return Promise.reject(new WebError(409, "repository worktree lease is no longer active"));
        }
        return store.prepareDetachedRevision(
          repositoryPaths,
          repositoryDigest,
          leasePaths,
          record,
          token,
          request,
        );
      },
      touch(): void {
        if (releaseStarted || !existsSync(leasePaths.metadata)) return;
        record.updatedAtMs = store.now();
        writePrivateJson(leasePaths.metadata, record);
      },
      release(): Promise<void> {
        if (!releasePromise) {
          releaseStarted = true;
          releasePromise = store.releaseLease(repositoryPaths, leasePaths, record);
        }
        return releasePromise;
      },
    };
  }

  private createDetachedLease(
    repositoryPaths: RepositoryPaths,
    leasePaths: LeasePaths,
    repositoryDigest: string,
    record: DetachedLeaseRecord,
  ): RepositoryDetachedWorktreeLease {
    let releasePromise: Promise<void> | undefined;
    let releaseStarted = false;
    const store = this;
    return {
      leaseId: record.leaseId,
      repositoryDigest,
      worktreeDir: leasePaths.worktreeDir,
      oid: record.oid,
      ref: record.ref,
      touch(): void {
        if (releaseStarted || !existsSync(leasePaths.metadata)) return;
        record.updatedAtMs = store.now();
        writePrivateJson(leasePaths.metadata, record);
      },
      release(): Promise<void> {
        if (!releasePromise) {
          releaseStarted = true;
          releasePromise = store.releaseLease(repositoryPaths, leasePaths, record);
        }
        return releasePromise;
      },
    };
  }

  private async releaseLease(
    repositoryPaths: RepositoryPaths,
    leasePaths: LeasePaths,
    record: LeaseRecord,
  ): Promise<void> {
    const unlock = await this.acquireFetchLock(repositoryPaths);
    try {
      await this.cleanupLease(repositoryPaths, leasePaths, record);
    } finally {
      unlock();
    }
  }

  private async cleanupLease(
    repositoryPaths: RepositoryPaths,
    leasePaths: LeasePaths,
    record: LeaseRecord | DerivedLeaseRecord,
  ): Promise<void> {
    let firstError: unknown;
    const attempt = async (run: () => Promise<unknown>): Promise<void> => {
      try {
        await run();
      } catch (error) {
        firstError ??= error;
      }
    };

    if (existsSync(leasePaths.worktreeDir)) {
      await attempt(() => this.gitCommand(
        ["worktree", "remove", "--force", leasePaths.worktreeDir],
        { cwd: repositoryPaths.mirrorDir },
      ));
    }
    removeEntry(leasePaths.worktreeDir);
    for (const ref of cleanupRefs(record)) {
      await attempt(() => this.gitCommand(["update-ref", "-d", ref], { cwd: repositoryPaths.mirrorDir }));
    }
    await attempt(() => this.gitCommand(["worktree", "prune", "--expire", "now"], {
      cwd: repositoryPaths.mirrorDir,
    }));
    removeEntry(leasePaths.metadata);
    if (firstError) throw firstError;
  }

  private async listJobRefs(mirrorDir: string, signal?: AbortSignal): Promise<string[]> {
    const output = await this.gitCommand(
      ["for-each-ref", "--format=%(refname)", "refs/meridian/jobs"],
      { cwd: mirrorDir, signal },
    );
    return output.split("\n").map((line) => line.trim()).filter(Boolean);
  }

  private async gitCommand(
    args: readonly string[],
    options: Omit<RepositoryGitOptions, "timeoutMs">,
  ): Promise<string> {
    throwIfAborted(options.signal);
    const output = await this.git(args, { ...options, timeoutMs: this.gitTimeoutMs });
    throwIfAborted(options.signal);
    return output;
  }

  private async acquireFetchLock(paths: RepositoryPaths, signal?: AbortSignal): Promise<() => void> {
    createPrivateDirectory(paths.repositoryRoot);
    const startedAt = Date.now();
    while (true) {
      throwIfAborted(signal);
      const lockId = this.makeId();
      try {
        mkdirSync(paths.fetchLock, { mode: 0o700 });
        writePrivateJson(join(paths.fetchLock, "owner.json"), {
          lockId,
          pid: process.pid,
          acquiredAtMs: Date.now(),
        });
        const heartbeat = setInterval(() => {
          if (!lockOwnedBy(paths.fetchLock, lockId)) return;
          try {
            const now = new Date();
            utimesSync(paths.fetchLock, now, now);
          } catch {
            // A cleanup can remove the lock between the ownership check and the timestamp update.
          }
        }, Math.max(1, Math.min(30_000, Math.floor(this.staleLockMs / 3))));
        heartbeat.unref?.();
        let released = false;
        return () => {
          if (released) return;
          released = true;
          clearInterval(heartbeat);
          if (lockOwnedBy(paths.fetchLock, lockId)) removeEntry(paths.fetchLock);
        };
      } catch (error) {
        if (errorCode(error) !== "EEXIST") throw error;
        if (Date.now() - entryMtime(paths.fetchLock) > this.staleLockMs) {
          // Rename claims exactly the stale inode we inspected. A new owner may create fetch.lock
          // immediately afterward, but cleanup can no longer delete that replacement.
          const quarantine = `${paths.fetchLock}.stale-${process.pid}-${this.makeId()}`;
          try {
            renameSync(paths.fetchLock, quarantine);
            removeEntry(quarantine);
          } catch (renameError) {
            const code = errorCode(renameError);
            if (code !== "ENOENT" && code !== "EEXIST") throw renameError;
          }
          continue;
        }
        if (Date.now() - startedAt >= this.lockTimeoutMs) {
          throw new WebError(503, "timed out waiting for repository fetch lock");
        }
        await abortableDelay(this.lockPollMs, signal);
      }
    }
  }
}

async function defaultGitRunner(args: readonly string[], options: RepositoryGitOptions): Promise<string> {
  return runGit([...args], {
    cwd: options.cwd,
    token: options.token,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  });
}

function mirrorMetadata(path: string): MirrorMetadata {
  try {
    const value = readJson(path) as Partial<MirrorMetadata>;
    if (
      value.formatVersion === FORMAT_VERSION
      && typeof value.repositoryDigest === "string"
      && typeof value.remoteUrl === "string"
    ) {
      return value as MirrorMetadata;
    }
  } catch {
    // Converted to a stable, browser-safe failure below.
  }
  throw new WebError(409, "repository mirror metadata is invalid");
}

function readLeaseRecord(path: string, leaseId: string): LeaseRecord | DerivedLeaseRecord {
  try {
    const value = readJson(path) as Record<string, unknown>;
    const refs = refsForLease(leaseId);
    const commonIsValid = (
      value.formatVersion === FORMAT_VERSION
      && value.leaseId === leaseId
      && (value.state === "preparing" || value.state === "active")
      && typeof value.createdAtMs === "number"
      && Number.isFinite(value.createdAtMs)
      && typeof value.updatedAtMs === "number"
      && Number.isFinite(value.updatedAtMs)
    );
    if (
      commonIsValid
      && value.kind === "inspection"
      && value.headRef === refs.headRef
      && value.baseRef === refs.baseRef
      && typeof value.headOid === "string"
      && OID.test(value.headOid)
      && typeof value.baseOid === "string"
      && OID.test(value.baseOid)
    ) {
      return {
        ...value,
        headOid: value.headOid.toLowerCase(),
        baseOid: value.baseOid.toLowerCase(),
      } as InspectionLeaseRecord;
    }
    if (
      commonIsValid
      && value.kind === "detached"
      && typeof value.parentLeaseId === "string"
      && SAFE_ID.test(value.parentLeaseId)
      && value.ref === refs.commitRef
      && typeof value.oid === "string"
      && OID.test(value.oid)
    ) {
      return { ...value, oid: value.oid.toLowerCase() } as DetachedLeaseRecord;
    }
  } catch {
    // A corrupt record is still safely reclaimable because refs and paths derive from its filename.
  }
  return derivedLeaseRecord(leaseId, path);
}

function derivedLeaseRecord(leaseId: string, timestampPath: string): DerivedLeaseRecord {
  const refs = refsForLease(leaseId);
  const timestamp = entryMtime(timestampPath);
  return {
    formatVersion: FORMAT_VERSION,
    leaseId,
    kind: "inspection",
    state: "preparing",
    headRef: refs.headRef,
    baseRef: refs.baseRef,
    headOid: "0".repeat(40),
    baseOid: "0".repeat(40),
    createdAtMs: timestamp,
    updatedAtMs: timestamp,
    cleanupRefs: [refs.headRef, refs.baseRef, refs.commitRef],
  };
}

function refsForLease(leaseId: string): { headRef: string; baseRef: string; commitRef: string } {
  return {
    headRef: `refs/meridian/jobs/${leaseId}/head`,
    baseRef: `refs/meridian/jobs/${leaseId}/base`,
    commitRef: `refs/meridian/jobs/${leaseId}/commit`,
  };
}

function leaseIdFromRef(ref: string): string | null {
  const match = /^refs\/meridian\/jobs\/([0-9a-f]{64})\/(?:head|base|commit)$/.exec(ref);
  return match?.[1] ?? null;
}

function cleanupRefs(record: LeaseRecord | DerivedLeaseRecord): readonly string[] {
  if ("cleanupRefs" in record) return record.cleanupRefs;
  if (record.kind === "detached") return [record.ref];
  return [record.headRef, record.baseRef];
}

function leaseMetadataIds(leasesDir: string): string[] {
  if (!isPlainDirectory(leasesDir)) return [];
  return readdirSync(leasesDir, { withFileTypes: true }).flatMap((entry) => {
    if (!entry.isFile() || !entry.name.endsWith(".json")) return [];
    const leaseId = entry.name.slice(0, -5);
    return SAFE_ID.test(leaseId) ? [leaseId] : [];
  });
}

function plainDirectoryNames(path: string): string[] {
  if (!isPlainDirectory(path)) return [];
  return readdirSync(path, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}

function isPlainDirectory(path: string): boolean {
  try {
    const entry = lstatSync(path);
    return entry.isDirectory() && !entry.isSymbolicLink();
  } catch {
    return false;
  }
}

function entryMtime(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

function requireRevision(revision: RepositoryRevision, label: string): RepositoryRevision {
  if (!revision || !isAllowedFullRef(revision.ref)) {
    throw new WebError(400, `${label} ref must be a fully qualified Git ref`);
  }
  return { ref: revision.ref, oid: normalizeOid(revision.oid) };
}

function isAllowedFullRef(value: string): boolean {
  if (value === "HEAD") return true;
  if (
    !value.startsWith("refs/")
    || value.endsWith("/")
    || value.endsWith(".")
    || value.includes("..")
    || value.includes("@{")
    || value.includes("//")
    || FORBIDDEN_REF_CHARACTER.test(value)
  ) {
    return false;
  }
  return value.split("/").every((component) => (
    component.length > 0
    && !component.startsWith(".")
    && !component.endsWith(".lock")
  ));
}

function normalizeOid(value: string): string {
  if (!OID.test(value)) throw new WebError(422, "git returned an invalid commit id");
  return value.toLowerCase();
}

function requireNonEmpty(value: string, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 4_096) {
    throw new WebError(400, `${label} is required`);
  }
  return value;
}

function requireCredentialFreeRemote(value: string): string {
  const remote = requireNonEmpty(value, "remote URL");
  if (remote !== remote.trim() || remote.includes("\0") || remote.includes("\n") || remote.includes("\r")) {
    throw new WebError(400, "remote URL is invalid");
  }
  if (remote.includes("://")) {
    try {
      const parsed = new URL(remote);
      if (parsed.username || parsed.password || parsed.search || parsed.hash) {
        throw new WebError(400, "remote URL must not contain credentials, a query, or a fragment");
      }
    } catch (error) {
      if (error instanceof WebError) throw error;
      throw new WebError(400, "remote URL is invalid");
    }
  }
  return remote;
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function positiveDuration(value: number | undefined, fallback: number, label: string): number {
  const result = value ?? fallback;
  if (!Number.isFinite(result) || result <= 0) throw new WebError(500, `${label} must be positive`);
  return result;
}

function nonNegativeDuration(value: number | undefined, fallback: number, label: string): number {
  const result = value ?? fallback;
  if (!Number.isFinite(result) || result < 0) throw new WebError(400, `${label} must not be negative`);
  return result;
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  return String((error as { code?: unknown }).code);
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
  const error = new Error("repository mirror operation aborted");
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
