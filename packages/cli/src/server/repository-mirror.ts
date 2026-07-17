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
import { existsSync, lstatSync, mkdirSync, realpathSync, statSync, utimesSync } from "node:fs";
import { opendir } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { runGit, streamGitLines } from "./git-exec";
import {
  cacheEntryIdentityDigest,
  createPrivateDirectory,
  parseCacheQuarantineEntryName,
  quarantineCacheEntry,
  readJson,
  writePrivateJson,
} from "./web-cache-storage";
import { WebError } from "./web-error";
import {
  resolveProcessIdentity,
  type ProcessIdentityResolver,
} from "./cache-root-lifecycle-lock";
import {
  claimPathForCleanup,
  claimedPathIsCurrent,
  removeClaimedPath,
  sameClaimedPathIdentity,
  type ClaimedPath,
  type ClaimedPathIdentity,
} from "./claimed-path-cleanup";

const FORMAT_VERSION = 2;
const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const SAFE_ID = /^[0-9a-f]{64}$/;
const FORBIDDEN_REF_CHARACTER = /[\x00-\x20\x7f~^:?*\[\\]/u;
const DEFAULT_GIT_TIMEOUT_MS = 300_000;
const DEFAULT_LOCK_TIMEOUT_MS = 30_000;
const DEFAULT_LOCK_POLL_MS = 25;
const DEFAULT_STALE_LOCK_MS = 10 * 60_000;
const DEFAULT_LEASE_MAX_AGE_MS = 6 * 60 * 60_000;
const SOURCE_OPERATION_TTL_MS = 5 * 60_000;
const SOURCE_OPERATION_RENEW_MS = 60_000;
const DEFAULT_CLEANUP_QUEUE_LIMIT = 256;
const DEFAULT_CLEANUP_RETRY_MS = 1_000;
const CLEANUP_BATCH_SIZE = 32;
const MAX_REPORTED_CLEANUP_ERRORS = 32;

type RepositoryCleanupKind = "lock" | "worktree" | "metadata" | "retention" | "owner";

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

/** Stable, credential-free identity for a persisted repository worktree lease. */
export interface RepositorySourceLeaseReference {
  readonly repositoryDigest: string;
  readonly leaseId: string;
}

/**
 * Parse the one cache-root-relative path shape that can be owned by a repository source lease.
 *
 * This is the shared boundary between the mirror store and durable consumers such as graph
 * capabilities. Keep the current on-disk version here so consumers never duplicate (and drift
 * from) the mirror layout. Pre-v2 paths are deliberately not accepted.
 */
export function parseRepositoryMirrorSourceRoot(
  sourceRootPath: string,
): RepositorySourceLeaseReference | null {
  if (typeof sourceRootPath !== "string") return null;
  const parts = sourceRootPath.split("/");
  if (parts.length !== 5
    || parts[0] !== "repository-mirrors"
    || parts[1] !== `v${FORMAT_VERSION}`
    || !SAFE_ID.test(parts[2] ?? "")
    || parts[3] !== "worktrees"
    || !SAFE_ID.test(parts[4] ?? "")) return null;
  return Object.freeze({ repositoryDigest: parts[2]!, leaseId: parts[4]! });
}

/** Exact transient owner used by cache reads and publication handoff; never a bare path. */
export interface RepositorySourceOperationLease {
  readonly reference: RepositorySourceLeaseReference;
  readonly worktreeDir: string;
  readonly signal: AbortSignal;
  renew(): Promise<void>;
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

/** Streaming-only Git contract for stdout inventories that must never be fully materialized. */
export type RepositoryGitLineRunner = (
  args: readonly string[],
  options: RepositoryGitOptions,
  consume: (line: string) => void | Promise<void>,
) => Promise<void>;

export interface RepositoryMirrorStoreOptions {
  cacheRoot: string;
  git?: RepositoryGitRunner;
  gitLines?: RepositoryGitLineRunner;
  now?: () => number;
  makeId?: () => string;
  gitTimeoutMs?: number;
  lockTimeoutMs?: number;
  lockPollMs?: number;
  staleLockMs?: number;
  cleanupQueueLimit?: number;
  cleanupRetryMs?: number;
  processIdentity?: ProcessIdentityResolver;
  /** Test seam for the atomic owner record; production always uses the private JSON writer. */
  writeLockOwner?: (path: string, value: unknown) => void;
  /** Test seam after atomic quarantine and outside repository admission. */
  beforePhysicalCleanup?: (paths: readonly string[]) => Promise<void>;
  /** Test seam after final caller revalidation and immediately before quarantine. */
  beforeQuarantine?: (path: string, expected: ClaimedPath) => void;
  /** Test seam immediately after atomic quarantine and before post-rename identity capture. */
  afterQuarantineRename?: (path: string) => void;
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
  /** Persisted job ownership; released-retained leases may only be read through named owners. */
  state: "preparing" | "active-job" | "released-retained" | "cleanup-pending";
  createdAtMs: number;
  updatedAtMs: number;
  /** Exact checkout directory identity; required once worktree registration succeeds. */
  worktreeIdentity?: ClaimedPathIdentity;
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
  repositoryDigest: string;
  repositoryRoot: string;
  mirrorDir: string;
  mirrorMetadata: string;
  worktreesDir: string;
  leasesDir: string;
  sourceRetentionsDir: string;
  fetchLock: string;
  sourceOwnersLock: string;
}

interface LeasePaths {
  worktreeDir: string;
  metadata: string;
  retentionDir: string;
}

interface SourceRetentionRecord {
  formatVersion: typeof FORMAT_VERSION;
  repositoryDigest: string;
  leaseId: string;
  ownerDigest: string;
  retainedUntilMs: number;
}

interface CleanupCandidate {
  repositoryDigest: string;
  leaseId: string;
}

interface PendingCleanupClaim {
  readonly claim: ClaimedPath;
  readonly ownerKey: string;
  inFlight: Promise<void> | null;
}

type CleanupScanOutcome =
  | { readonly ok: true; readonly claim: ClaimedPath }
  | { readonly ok: false; readonly error: unknown };

type RepositoryLockRelease = () => unknown | null;

/**
 * Owns node-local mirrors and hands out isolated worktree leases.
 *
 * AbortSignals are forwarded into the shared Git runner, which terminates the active subprocess,
 * and are also checked between commands and while waiting for the filesystem lock.
 */
export class RepositoryMirrorStore {
  private readonly cacheRoot: string;
  private readonly git: RepositoryGitRunner;
  private readonly gitLines: RepositoryGitLineRunner;
  private readonly now: () => number;
  private readonly makeId: () => string;
  private readonly gitTimeoutMs: number;
  private readonly lockTimeoutMs: number;
  private readonly lockPollMs: number;
  private readonly staleLockMs: number;
  private readonly cleanupQueueLimit: number;
  private readonly cleanupRetryMs: number;
  private readonly processIdentity: ProcessIdentityResolver;
  private readonly ownerProcessIdentity: string;
  private readonly writeLockOwner: (path: string, value: unknown) => void;
  private readonly beforePhysicalCleanup: (paths: readonly string[]) => Promise<void>;
  private readonly beforeQuarantine: (path: string, expected: ClaimedPath) => void;
  private readonly afterQuarantineRename: (path: string) => void;
  private readonly cleanupQueue = new Map<string, CleanupCandidate>();
  private readonly cleanupClaims = new Map<string, PendingCleanupClaim>();
  private cleanupSweepRequested = false;
  private cleanupWorker: Promise<void> | null = null;
  private cleanupLastError: unknown;
  private cleanupRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private cleanupClosed = false;

  constructor(options: RepositoryMirrorStoreOptions) {
    if (!options.cacheRoot.trim()) {
      throw new WebError(500, "repository mirror cache root is required");
    }
    this.cacheRoot = options.cacheRoot;
    this.git = options.git ?? defaultGitRunner;
    this.gitLines = options.gitLines ?? defaultGitLineRunner;
    this.now = options.now ?? Date.now;
    this.makeId = options.makeId ?? randomUUID;
    this.gitTimeoutMs = positiveDuration(options.gitTimeoutMs, DEFAULT_GIT_TIMEOUT_MS, "git timeout");
    this.lockTimeoutMs = positiveDuration(options.lockTimeoutMs, DEFAULT_LOCK_TIMEOUT_MS, "lock timeout");
    this.lockPollMs = positiveDuration(options.lockPollMs, DEFAULT_LOCK_POLL_MS, "lock poll interval");
    this.staleLockMs = positiveDuration(options.staleLockMs, DEFAULT_STALE_LOCK_MS, "stale lock age");
    this.cleanupQueueLimit = positiveInteger(
      options.cleanupQueueLimit,
      DEFAULT_CLEANUP_QUEUE_LIMIT,
      "cleanup queue limit",
    );
    this.cleanupRetryMs = positiveDuration(
      options.cleanupRetryMs,
      DEFAULT_CLEANUP_RETRY_MS,
      "cleanup retry interval",
    );
    this.processIdentity = options.processIdentity ?? resolveProcessIdentity;
    this.ownerProcessIdentity = this.processIdentity(process.pid)
      ?? `unverifiable:${process.pid}:${this.makeId()}`;
    this.writeLockOwner = options.writeLockOwner ?? writePrivateJson;
    this.beforePhysicalCleanup = options.beforePhysicalCleanup ?? (() => Promise.resolve());
    this.beforeQuarantine = options.beforeQuarantine ?? (() => undefined);
    this.afterQuarantineRename = options.afterQuarantineRename ?? (() => undefined);
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

    let refsMayExist = false;
    try {
      await runWithRepositoryLock(
        await this.acquireFetchLock(repositoryPaths, request.signal),
        async () => {
          await this.ensureMirror(repositoryPaths, repositoryDigest, remoteUrl, request.signal);
          // This record is published before refs so a crash is always discoverable by the scavenger.
          writePrivateJson(leasePaths.metadata, record);
          refsMayExist = true;
        },
        "repository mirror initialization and lock release both failed",
      );

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
      await runWithRepositoryLock(
        await this.acquireFetchLock(repositoryPaths, request.signal),
        async () => {
          await this.gitCommand(
            ["worktree", "add", "--detach", "--no-checkout", leasePaths.worktreeDir, refs.headRef],
            { cwd: repositoryPaths.mirrorDir, signal: request.signal },
          );
          record.worktreeIdentity = requireWorktreeIdentity(leasePaths.worktreeDir);
          writePrivateJson(leasePaths.metadata, record);
        },
        "repository worktree registration and lock release both failed",
      );

      // Materialization can lazily fetch many blobs. It runs in the isolated worktree and outside
      // Meridian's lock, allowing another PR to prepare while this one downloads or checks out.
      await this.gitCommand(
        ["reset", "--hard", "HEAD"],
        { cwd: leasePaths.worktreeDir, token: request.token, signal: request.signal },
      );
      await this.verifyRef(leasePaths.worktreeDir, "HEAD", head.oid, request.signal);

      record.state = "active-job";
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
      const errors: unknown[] = [error];
      const claims: ClaimedPath[] = [];
      if (refsMayExist) {
        try {
          await this.releaseLease(repositoryPaths, leasePaths, record);
        } catch (cleanupError) {
          errors.push(cleanupError);
        }
      } else {
        try {
          const metadataExpected = this.expectedEntry(leasePaths.metadata);
          const worktreeExpected = this.expectedEntry(leasePaths.worktreeDir);
          const metadata = metadataExpected
            ? this.quarantineEntry(leasePaths.metadata, "metadata", metadataExpected)
            : null;
          const worktree = worktreeExpected
            ? this.quarantineEntry(leasePaths.worktreeDir, "worktree", worktreeExpected)
            : null;
          if (metadata) claims.push(metadata);
          if (worktree) claims.push(worktree);
        } catch (quarantineError) {
          errors.push(quarantineError);
        }
        try {
          await this.cleanupClaimsNow(
            claims,
            leaseCleanupOwnerKey(repositoryDigest, record.leaseId),
          );
        } catch (cleanupError) {
          errors.push(cleanupError);
        }
      }
      throwCollectedErrors(errors, "repository preparation and rollback failed");
    }
  }

  /**
   * Persist a source-capability pin independently from ordinary lease activity. Prepared-review
   * handoffs renew this deadline whenever their own idle TTL is renewed, so startup scavenging can
   * never remove a worktree while a restart-safe handoff still promises `/api/source` access.
   */
  async retainSource(
    reference: RepositorySourceLeaseReference,
    expectedWorktreeDir: string,
    owner: string,
    retainedUntilMs: number,
    options: { signal?: AbortSignal } = {},
  ): Promise<boolean> {
    throwIfAborted(options.signal);
    const repositoryDigest = requireDigest(reference.repositoryDigest, "repository digest");
    const leaseId = requireDigest(reference.leaseId, "lease id");
    const ownerDigest = digest(["source-retention-owner", requireNonEmpty(owner, "source retention owner")]);
    if (!Number.isSafeInteger(retainedUntilMs) || retainedUntilMs <= this.now()) {
      throw new WebError(500, "repository source retention deadline must be in the future");
    }
    const paths = this.pathsForDigest(repositoryDigest);
    const leasePaths = this.leasePaths(paths, leaseId);
    return runWithRepositoryLock(
      await this.acquireSourceOwnersLock(paths, options.signal),
      () => {
        throwIfAborted(options.signal);
        const record = readLeaseRecord(leasePaths.metadata, leaseId);
        if ("cleanupRefs" in record
          || (record.state !== "active-job" && record.state !== "released-retained")) {
          throw new WebError(409, "repository source lease is no longer active");
        }
        if (!record.worktreeIdentity) {
          throw new WebError(409, "repository source lease worktree identity is unavailable");
        }
        let liveWorktree: ClaimedPath;
        try {
          liveWorktree = claimPathForCleanup(leasePaths.worktreeDir);
        } catch {
          throw new WebError(409, "repository source lease worktree is unavailable");
        }
        if (liveWorktree.identity.kind !== "directory"
          || !sameClaimedPathIdentity(liveWorktree.identity, record.worktreeIdentity)) {
          throw new WebError(409, "repository source lease no longer owns its persisted worktree");
        }
        let actualWorktree: string;
        let expectedWorktree: string;
        try {
          actualWorktree = realpathSync(leasePaths.worktreeDir);
          expectedWorktree = realpathSync(expectedWorktreeDir);
        } catch {
          throw new WebError(409, "repository source lease worktree is unavailable");
        }
        if (actualWorktree !== expectedWorktree) {
          throw new WebError(409, "repository source lease does not own the published worktree");
        }
        requirePrivateRetentionDirectory(leasePaths.retentionDir, paths.repositoryRoot);
        const path = join(leasePaths.retentionDir, `${ownerDigest}.json`);
        const current = readSourceRetention(path, repositoryDigest, leaseId, ownerDigest);
        writePrivateJson(path, {
          formatVersion: FORMAT_VERSION,
          repositoryDigest,
          leaseId,
          ownerDigest,
          retainedUntilMs: Math.max(current, retainedUntilMs),
        } satisfies SourceRetentionRecord);
        return current === 0;
      },
      "repository source retention and lock release both failed",
    );
  }

  /** Acquire a heartbeat-backed transient source owner for one exact persisted worktree lease. */
  async acquireSource(
    reference: RepositorySourceLeaseReference,
    expectedWorktreeDir: string,
    purpose: string,
    signal?: AbortSignal,
  ): Promise<RepositorySourceOperationLease> {
    throwIfAborted(signal);
    const normalizedPurpose = requireNonEmpty(purpose, "source operation purpose");
    const token = this.makeId();
    const owner = `operation:${digest([normalizedPurpose])}:${token}`;
    const ownership = new AbortController();
    let released = false;
    let renewing: Promise<void> | null = null;
    let releasePromise: Promise<void> | null = null;
    const renew = async (): Promise<void> => {
      if (released) throw new WebError(409, "repository source operation has been released");
      throwIfAborted(signal);
      ownership.signal.throwIfAborted();
      if (renewing) return renewing;
      renewing = this.retainSource(
        reference,
        expectedWorktreeDir,
        owner,
        this.now() + SOURCE_OPERATION_TTL_MS,
        { signal },
      ).then(() => undefined).finally(() => { renewing = null; });
      return renewing;
    };
    await renew();
    const heartbeat = setInterval(() => {
      void renew().catch((error: unknown) => {
        if (!ownership.signal.aborted) ownership.abort(error);
      });
    }, SOURCE_OPERATION_RENEW_MS);
    heartbeat.unref?.();
    const release = (): Promise<void> => {
      if (releasePromise) return releasePromise;
      released = true;
      clearInterval(heartbeat);
      const pendingRenewal = renewing;
      releasePromise = (async () => {
        const errors: unknown[] = [];
        if (pendingRenewal) {
          try {
            await pendingRenewal;
          } catch (renewalError) {
            appendDistinctErrors(errors, renewalError);
          }
        }
        try {
          await this.releaseSource(reference, owner);
        } catch (releaseError) {
          appendDistinctErrors(errors, releaseError);
        }
        if (errors.length > 0) {
          throwCollectedErrors(errors, "repository source renewal and release failed");
        }
      })();
      return releasePromise;
    };
    return Object.freeze({
      reference: { ...reference },
      worktreeDir: realpathSync(expectedWorktreeDir),
      signal: ownership.signal,
      renew,
      release,
    });
  }

  /** Release exactly one handoff's ownership; reclaim the worktree when no live owner remains. */
  async releaseSource(
    reference: RepositorySourceLeaseReference,
    owner: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<void> {
    throwIfAborted(options.signal);
    const repositoryDigest = requireDigest(reference.repositoryDigest, "repository digest");
    const leaseId = requireDigest(reference.leaseId, "lease id");
    const ownerDigest = digest(["source-retention-owner", requireNonEmpty(owner, "source retention owner")]);
    const paths = this.pathsForDigest(repositoryDigest);
    const leasePaths = this.leasePaths(paths, leaseId);
    if (!existsSync(paths.repositoryRoot)) return;
    const claims: ClaimedPath[] = [];
    const errors: unknown[] = [];
    let releaseAdmitted = false;
    try {
      await runWithRepositoryLock(
        await this.acquireSourceOwnersLock(paths, options.signal),
        () => {
          throwIfAborted(options.signal);
          // From here onward the release owns the durable transition. Abort is deliberately not
          // observed again: a quarantined owner record must be physically removed and followed by
          // lease cleanup even when shutdown arrives concurrently.
          releaseAdmitted = true;
          const retentionPath = join(leasePaths.retentionDir, `${ownerDigest}.json`);
          const expected = this.expectedEntry(retentionPath);
          const claim = expected ? this.quarantineEntry(retentionPath, "owner", expected) : null;
          if (claim) claims.push(claim);
        },
        "repository source release and lock release both failed",
      );
    } catch (error) {
      // Admission cancellation happened before any durable state changed. Propagate it directly
      // without scheduling lease cleanup or otherwise turning a cancelled release into mutation.
      if (!releaseAdmitted) throw error;
      errors.push(error);
    }
    try {
      await this.cleanupClaimsNow(claims, leaseCleanupOwnerKey(repositoryDigest, leaseId));
    } catch (error) {
      errors.push(error);
    }
    this.enqueueReleasedLeaseCleanup({ repositoryDigest, leaseId });
    if (errors.length > 0) {
      throwCollectedErrors(errors, "repository source release failed");
    }
  }

  /**
   * Release one globally unique durable owner without trusting generation metadata for its lease.
   * Generation GC uses this after quarantine, so corrupt cache metadata cannot strand a mirror
   * worktree until its retention deadline.
   */
  async releaseSourceOwner(owner: string): Promise<number> {
    const ownerDigest = digest(["source-retention-owner", requireNonEmpty(owner, "source retention owner")]);
    const repositoriesRoot = this.repositoriesRoot();
    if (!existsSync(repositoriesRoot)) return 0;
    let removed = 0;
    const errors = new BoundedErrorCollector();
    for await (const repositoryDigest of plainDirectoryEntryNames(repositoriesRoot)) {
      if (!SAFE_ID.test(repositoryDigest)) continue;
      const paths = this.pathsForDigest(repositoryDigest);
      if (!existsSync(paths.repositoryRoot)) continue;
      let batch: string[] = [];
      for await (const leaseId of plainDirectoryEntryNames(paths.sourceRetentionsDir)) {
        if (!SAFE_ID.test(leaseId)) continue;
        batch.push(leaseId);
        if (batch.length < CLEANUP_BATCH_SIZE) continue;
        const current = batch;
        batch = [];
        try {
          removed += await this.releaseSourceOwnerBatch(paths, repositoryDigest, ownerDigest, current);
        } catch (error) {
          errors.add(error);
        }
        await yieldToEventLoop();
      }
      if (batch.length > 0) {
        try {
          removed += await this.releaseSourceOwnerBatch(paths, repositoryDigest, ownerDigest, batch);
        } catch (error) {
          errors.add(error);
        }
      }
    }
    errors.throwIfAny("repository source-owner sweep failed");
    return removed;
  }

  private async releaseSourceOwnerBatch(
    paths: RepositoryPaths,
    repositoryDigest: string,
    ownerDigest: string,
    leaseIds: readonly string[],
  ): Promise<number> {
    const cleanup: CleanupCandidate[] = [];
    const claims: ClaimedPath[] = [];
    const errors: unknown[] = [];
    try {
      await runWithRepositoryLock(
        await this.acquireSourceOwnersLock(paths),
        () => {
          const quarantineErrors: unknown[] = [];
          for (const leaseId of leaseIds) {
            try {
              const retention = join(paths.sourceRetentionsDir, leaseId, `${ownerDigest}.json`);
              const expected = this.expectedEntry(retention);
              if (!expected) continue;
              const claim = this.quarantineEntry(retention, "owner", expected);
              if (claim) claims.push(claim);
              cleanup.push({ repositoryDigest, leaseId });
            } catch (error) {
              quarantineErrors.push(error);
            }
          }
          if (quarantineErrors.length > 0) {
            throwCollectedErrors(quarantineErrors, "repository source-owner quarantine batch failed");
          }
        },
        "repository source-owner batch and lock release both failed",
      );
    } catch (error) {
      errors.push(error);
    }
    try {
      await this.cleanupClaimsNow(claims, `source-owner:${repositoryDigest}:${ownerDigest}`);
    } catch (error) {
      errors.push(error);
    }
    for (const candidate of cleanup) this.enqueueReleasedLeaseCleanup(candidate);
    if (errors.length > 0) {
      throwCollectedErrors(errors, "repository source-owner cleanup batch failed");
    }
    return cleanup.length;
  }

  /** Wait until all currently scheduled last-owner cleanup has physically completed. */
  async drainCleanup(): Promise<void> {
    while (this.cleanupQueue.size > 0
      || this.cleanupClaims.size > 0
      || this.cleanupSweepRequested
      || this.cleanupWorker) {
      this.startCleanupWorker(true);
      const worker = this.cleanupWorker;
      if (!worker) break;
      await worker;
      if (this.cleanupLastError !== undefined) throw this.cleanupLastError;
    }
  }

  /** Stop retry timers and drain already-authorized cleanup during server shutdown. */
  async close(): Promise<void> {
    this.cleanupClosed = true;
    if (this.cleanupRetryTimer) {
      clearTimeout(this.cleanupRetryTimer);
      this.cleanupRetryTimer = null;
      this.cleanupSweepRequested = true;
    }
    await this.drainCleanup();
  }

  private enqueueReleasedLeaseCleanup(candidate: CleanupCandidate): void {
    if (this.cleanupClosed) return;
    const key = cleanupCandidateKey(candidate);
    if (this.cleanupQueue.has(key)) return;
    if (this.cleanupQueue.size + this.cleanupClaims.size < this.cleanupQueueLimit) {
      this.cleanupQueue.set(key, candidate);
    } else {
      // Overflow does not grow memory: the next pass discovers every cleanup tombstone on disk.
      this.cleanupSweepRequested = true;
    }
    this.startCleanupWorker();
  }

  private enqueueCleanupClaim(claim: ClaimedPath, ownerKey: string): void {
    if (this.cleanupClaims.has(claim.path)) return;
    if (this.cleanupQueue.size + this.cleanupClaims.size < this.cleanupQueueLimit) {
      this.cleanupClaims.set(claim.path, { claim, ownerKey, inFlight: null });
    } else {
      // Quarantine names are durable capabilities. A bounded sweep rediscovers overflow on disk.
      this.cleanupSweepRequested = true;
    }
    this.startCleanupWorker();
  }

  private async cleanupClaimsNow(claims: readonly ClaimedPath[], ownerKey: string): Promise<void> {
    const errors: unknown[] = [];
    for (const claim of claims) {
      try {
        await this.performPhysicalCleanup(claim);
      } catch (error) {
        errors.push(error);
        this.enqueueCleanupClaim(claim, ownerKey);
      }
    }
    if (errors.length > 0) {
      throwCollectedErrors(errors, "repository physical cleanup batch failed");
    }
  }

  private async retryCleanupOwner(ownerKey: string): Promise<void> {
    const errors = new BoundedErrorCollector();
    let remaining = this.cleanupClaims.size;
    let visited = 0;
    for (const pending of this.cleanupClaims.values()) {
      if (remaining <= 0) break;
      remaining -= 1;
      if (pending.ownerKey === ownerKey) {
        try {
          await this.cleanupPendingClaim(pending);
        } catch (error) {
          errors.add(error);
        }
      }
      visited += 1;
      if (visited % CLEANUP_BATCH_SIZE === 0) await yieldToEventLoop();
    }
    errors.throwIfAny("repository cleanup-owner retry failed");
  }

  private async cleanupPendingClaim(pending: PendingCleanupClaim): Promise<void> {
    if (pending.inFlight) return pending.inFlight;
    const cleanup = this.performPhysicalCleanup(pending.claim);
    pending.inFlight = cleanup;
    try {
      await cleanup;
      if (this.cleanupClaims.get(pending.claim.path) === pending) {
        this.cleanupClaims.delete(pending.claim.path);
      }
    } finally {
      pending.inFlight = null;
    }
  }

  private async performPhysicalCleanup(claim: ClaimedPath): Promise<void> {
    if (!await claimedPathIsCurrent(claim)) return;
    await this.beforePhysicalCleanup(Object.freeze([claim.path]));
    try {
      await removeClaimedPath(claim);
    } catch (error) {
      // A restart scanner may atomically move this exact residue to establish new cleanup
      // ownership. The old claim becoming absent is a successful handoff, not a deletion failure.
      if (!await claimedPathIsCurrent(claim)) return;
      throw error;
    }
  }

  private startCleanupWorker(force = false): void {
    if (this.cleanupWorker || (this.cleanupClosed && !force)) return;
    this.cleanupLastError = undefined;
    const worker = this.runCleanupQueue();
    this.cleanupWorker = worker;
    void worker.then(
      () => this.finishCleanupWorker(worker),
      (error: unknown) => {
        this.cleanupLastError = error;
        this.finishCleanupWorker(worker);
      },
    );
  }

  private finishCleanupWorker(worker: Promise<void>): void {
    if (this.cleanupWorker !== worker) return;
    this.cleanupWorker = null;
    if (this.cleanupLastError !== undefined && !this.cleanupClosed) {
      this.scheduleCleanupRetry();
      return;
    }
    if ((this.cleanupQueue.size > 0 || this.cleanupClaims.size > 0 || this.cleanupSweepRequested)
      && !this.cleanupClosed) {
      this.startCleanupWorker();
    }
  }

  private scheduleCleanupRetry(): void {
    if (this.cleanupRetryTimer || this.cleanupClosed) return;
    const timer = setTimeout(() => {
      if (this.cleanupRetryTimer !== timer) return;
      this.cleanupRetryTimer = null;
      this.cleanupSweepRequested = true;
      this.startCleanupWorker();
    }, this.cleanupRetryMs);
    timer.unref?.();
    this.cleanupRetryTimer = timer;
  }

  private async runCleanupQueue(): Promise<void> {
    const errors = new BoundedErrorCollector();
    const deferredCandidates = new Map<string, CleanupCandidate>();
    const deferredClaims = new Set<string>();
    let deferredSweep = false;
    let lateWaveAvailable = true;
    try {
      while (this.hasEligibleCleanupWork(deferredCandidates, deferredClaims)) {
        const candidates: CleanupCandidate[] = [];
        for (const [key, candidate] of this.cleanupQueue) {
          if (deferredCandidates.has(key)) continue;
          candidates.push(candidate);
          this.cleanupQueue.delete(key);
        }
        const sweep = this.cleanupSweepRequested;
        this.cleanupSweepRequested = false;
        let waveFailed = false;

        for (const candidate of candidates) {
          try {
            await this.cleanupReleasedLease(candidate);
          } catch (error) {
            errors.add(error);
            deferredCandidates.set(cleanupCandidateKey(candidate), candidate);
            waveFailed = true;
          }
        }
        if (sweep) {
          try {
            await this.sweepReleasedLeaseCleanup();
          } catch (error) {
            errors.add(error);
            deferredSweep = true;
            waveFailed = true;
          }
          try {
            await this.sweepPhysicalCleanupResidue();
          } catch (error) {
            errors.add(error);
            deferredSweep = true;
            waveFailed = true;
          }
        }

        const pending = [...this.cleanupClaims.values()].filter((entry) => (
          !deferredClaims.has(entry.claim.path)
        ));
        for (const entry of pending) {
          try {
            await this.cleanupPendingClaim(entry);
          } catch (error) {
            errors.add(error);
            deferredClaims.add(entry.claim.path);
            waveFailed = true;
          }
        }

        if (waveFailed) {
          if (!lateWaveAvailable) break;
          // Capture exactly one bounded wave that arrived while the failing work was awaiting an
          // external lock or filesystem operation. Failed work is excluded until the next worker
          // invocation, preventing a permanent early residue from spinning or starving siblings.
          lateWaveAvailable = false;
          continue;
        }
        if (!lateWaveAvailable) break;
      }
    } finally {
      for (const [key, candidate] of deferredCandidates) {
        if (this.cleanupQueue.has(key)) continue;
        if (this.cleanupQueue.size + this.cleanupClaims.size < this.cleanupQueueLimit) {
          this.cleanupQueue.set(key, candidate);
        } else {
          deferredSweep = true;
        }
      }
      if (deferredSweep) this.cleanupSweepRequested = true;
    }
    errors.throwIfAny("repository cleanup batch failed");
  }

  private hasEligibleCleanupWork(
    deferredCandidates: ReadonlyMap<string, CleanupCandidate>,
    deferredClaims: ReadonlySet<string>,
  ): boolean {
    if (this.cleanupSweepRequested) return true;
    for (const key of this.cleanupQueue.keys()) {
      if (!deferredCandidates.has(key)) return true;
    }
    for (const pending of this.cleanupClaims.values()) {
      if (!deferredClaims.has(pending.claim.path)) return true;
    }
    return false;
  }

  private async sweepReleasedLeaseCleanup(): Promise<void> {
    const repositoriesRoot = this.repositoriesRoot();
    if (!isPlainDirectory(repositoriesRoot)) return;
    const errors = new BoundedErrorCollector();
    for await (const repositoryDigest of plainDirectoryEntryNames(repositoriesRoot)) {
      if (!SAFE_ID.test(repositoryDigest)) continue;
      const paths = this.pathsForDigest(repositoryDigest);
      if (!isPlainDirectory(paths.mirrorDir)) continue;
      for await (const leaseId of leaseMetadataEntryIds(paths.leasesDir)) {
        try {
          await this.cleanupReleasedLease({ repositoryDigest, leaseId });
        } catch (error) {
          errors.add(error);
        }
      }
      await yieldToEventLoop();
    }
    errors.throwIfAny("released repository lease sweep failed");
  }

  private async cleanupReleasedLease(candidate: CleanupCandidate): Promise<void> {
    const paths = this.pathsForDigest(candidate.repositoryDigest);
    if (!existsSync(paths.repositoryRoot)) return;
    const leasePaths = this.leasePaths(paths, candidate.leaseId);
    const ownerKey = leaseCleanupOwnerKey(candidate.repositoryDigest, candidate.leaseId);
    await this.retryCleanupOwner(ownerKey);
    await this.cleanupLeaseResidue(leasePaths, candidate.leaseId, ownerKey);
    if (!existsSync(leasePaths.metadata)) return;

    const claims: ClaimedPath[] = [];
    const errors: unknown[] = [];
    try {
      await runWithRepositoryLock(
        await this.acquireFetchLock(paths),
        async () => {
          let cleanup: LeaseRecord | DerivedLeaseRecord | null = null;
          await runWithRepositoryLock(
            await this.acquireSourceOwnersLock(paths),
            async () => {
              if (existsSync(leasePaths.metadata)) {
                const record = readLeaseRecord(leasePaths.metadata, candidate.leaseId);
                if ("cleanupRefs" in record || record.state === "cleanup-pending") {
                  cleanup = record;
                } else if (record.state === "released-retained"
                  && await sourceRetentionDeadline(
                    leasePaths.retentionDir,
                    candidate.repositoryDigest,
                    candidate.leaseId,
                    this.now(),
                  ) <= this.now()) {
                  record.state = "cleanup-pending";
                  record.updatedAtMs = this.now();
                  writePrivateJson(leasePaths.metadata, record);
                  cleanup = record;
                }
              }
            },
            "released repository lease state update and owner-lock release both failed",
          );
          if (cleanup) await this.cleanupLeaseLocked(paths, leasePaths, cleanup, claims);
        },
        "released repository lease cleanup and fetch-lock release both failed",
      );
    } catch (error) {
      errors.push(error);
    }
    try {
      await this.cleanupClaimsNow(claims, ownerKey);
    } catch (error) {
      errors.push(error);
    }
    if (errors.length > 0) {
      throwCollectedErrors(errors, "released repository lease cleanup failed");
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
      await runWithRepositoryLock(
        await this.acquireFetchLock(repositoryPaths, request.signal),
        async () => {
          await this.gitCommand(
            ["worktree", "add", "--detach", "--no-checkout", leasePaths.worktreeDir, refs.commitRef],
            { cwd: repositoryPaths.mirrorDir, signal: request.signal },
          );
          record.worktreeIdentity = requireWorktreeIdentity(leasePaths.worktreeDir);
          writePrivateJson(leasePaths.metadata, record);
        },
        "detached repository worktree registration and lock release both failed",
      );

      await this.gitCommand(
        ["reset", "--hard", "HEAD"],
        { cwd: leasePaths.worktreeDir, token, signal: request.signal },
      );
      await this.verifyRef(leasePaths.worktreeDir, "HEAD", oid, request.signal);

      record.state = "active-job";
      record.updatedAtMs = this.now();
      writePrivateJson(leasePaths.metadata, record);
      return this.createDetachedLease(repositoryPaths, leasePaths, repositoryDigest, record);
    } catch (error) {
      const errors: unknown[] = [error];
      const claims: ClaimedPath[] = [];
      if (refMayExist) {
        try {
          await this.releaseLease(repositoryPaths, leasePaths, record);
        } catch (cleanupError) {
          errors.push(cleanupError);
        }
      } else {
        try {
          const metadataExpected = this.expectedEntry(leasePaths.metadata);
          const worktreeExpected = this.expectedEntry(leasePaths.worktreeDir);
          const metadata = metadataExpected
            ? this.quarantineEntry(leasePaths.metadata, "metadata", metadataExpected)
            : null;
          const worktree = worktreeExpected
            ? this.quarantineEntry(leasePaths.worktreeDir, "worktree", worktreeExpected)
            : null;
          if (metadata) claims.push(metadata);
          if (worktree) claims.push(worktree);
        } catch (quarantineError) {
          errors.push(quarantineError);
        }
        try {
          await this.cleanupClaimsNow(
            claims,
            leaseCleanupOwnerKey(repositoryDigest, record.leaseId),
          );
        } catch (cleanupError) {
          errors.push(cleanupError);
        }
      }
      throwCollectedErrors(errors, "detached repository preparation and rollback failed");
    }
  }

  /** Reclaim expired leases plus crash-orphaned worktrees and job refs. */
  async scavenge(options: ScavengeRepositoryMirrorsOptions = {}): Promise<RepositoryMirrorScavengeResult> {
    const errors = new BoundedErrorCollector();
    // A previous process may have crashed after the atomic admission-side rename. Quarantine names
    // are durable cleanup capabilities, so reclaim them before inspecting the live namespaces.
    try {
      await this.sweepPhysicalCleanupResidue(options.signal);
    } catch (error) {
      if (options.signal?.aborted) throwIfAborted(options.signal);
      errors.add(error);
    }
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
    if (!isPlainDirectory(repositoriesRoot)) {
      errors.throwIfAny("repository mirror scavenging failed");
      return result;
    }

    try {
      for await (const repositoryDigest of plainDirectoryEntryNames(repositoriesRoot)) {
        if (!SAFE_ID.test(repositoryDigest)) continue;
        throwIfAborted(options.signal);
        const paths = this.pathsForDigest(repositoryDigest);
        if (!isPlainDirectory(paths.mirrorDir)) continue;
        result.repositoriesVisited += 1;
        try {
          for await (const leaseId of leaseMetadataEntryIds(paths.leasesDir)) {
            throwIfAborted(options.signal);
            try {
              if (await this.scavengeLease(paths, leaseId, cutoff, options)) {
                result.leasesRemoved += 1;
              }
            } catch (error) {
              if (options.signal?.aborted) throwIfAborted(options.signal);
              errors.add(error);
            }
          }
        } catch (error) {
          if (options.signal?.aborted) throwIfAborted(options.signal);
          errors.add(error);
        }
        try {
          for await (const entry of directoryEntryNames(paths.sourceRetentionsDir)) {
            throwIfAborted(options.signal);
            if (parseCleanupEntryName(entry)) continue;
            try {
              await this.scavengeRetentionEntry(paths, entry, options.signal);
            } catch (error) {
              if (options.signal?.aborted) throwIfAborted(options.signal);
              errors.add(error);
            }
          }
        } catch (error) {
          if (options.signal?.aborted) throwIfAborted(options.signal);
          errors.add(error);
        }
        try {
          for await (const leaseId of plainDirectoryEntryNames(paths.worktreesDir)) {
            throwIfAborted(options.signal);
            if (!SAFE_ID.test(leaseId)) continue;
            try {
              if (await this.scavengeOrphanWorktree(paths, leaseId, cutoff, options.signal)) {
                result.orphanWorktreesRemoved += 1;
              }
            } catch (error) {
              if (options.signal?.aborted) throwIfAborted(options.signal);
              errors.add(error);
            }
          }
        } catch (error) {
          if (options.signal?.aborted) throwIfAborted(options.signal);
          errors.add(error);
        }
        try {
          result.orphanRefsRemoved += await this.scavengeOrphanRefs(paths, options.signal);
        } catch (error) {
          if (options.signal?.aborted) throwIfAborted(options.signal);
          errors.add(error);
        }
        await yieldToEventLoop();
      }
    } catch (error) {
      if (options.signal?.aborted) throwIfAborted(options.signal);
      errors.add(error);
    }
    errors.throwIfAny("repository mirror scavenging failed");
    return result;
  }

  private async scavengeLease(
    paths: RepositoryPaths,
    leaseId: string,
    cutoff: number,
    options: ScavengeRepositoryMirrorsOptions,
  ): Promise<boolean> {
    const leasePaths = this.leasePaths(paths, leaseId);
    const claims: ClaimedPath[] = [];
    let removed = false;
    const errors: unknown[] = [];
    try {
      await runWithRepositoryLock(
        await this.acquireFetchLock(paths, options.signal),
        async () => {
          let cleanup: LeaseRecord | DerivedLeaseRecord | null = null;
          await runWithRepositoryLock(
            await this.acquireSourceOwnersLock(paths, options.signal),
            async () => {
              if (!existsSync(leasePaths.metadata)) return;
              const now = options.now ?? this.now();
              const record = readLeaseRecord(leasePaths.metadata, leaseId);
              const retainedUntilMs = await sourceRetentionDeadline(
                leasePaths.retentionDir,
                paths.repositoryDigest,
                leaseId,
                now,
              );
              const stale = Math.max(
                record.updatedAtMs,
                entryMtime(leasePaths.metadata),
                entryMtime(leasePaths.worktreeDir),
              ) <= cutoff;
              const cleanupPending = !("cleanupRefs" in record) && record.state === "cleanup-pending";
              const releasedWithoutOwners = !("cleanupRefs" in record)
                && record.state === "released-retained" && retainedUntilMs <= now;
              if (cleanupPending || releasedWithoutOwners || (stale && retainedUntilMs <= now)) {
                cleanup = record;
                if (!("cleanupRefs" in record)) {
                  record.state = "cleanup-pending";
                  record.updatedAtMs = now;
                  writePrivateJson(leasePaths.metadata, record);
                }
              } else if (stale && retainedUntilMs > now
                && !("cleanupRefs" in record) && record.state === "active-job") {
                record.state = "released-retained";
                record.updatedAtMs = now;
                writePrivateJson(leasePaths.metadata, record);
              }
            },
            "repository lease scavenging and owner-lock release both failed",
          );
          if (cleanup) {
            await this.cleanupLeaseLocked(paths, leasePaths, cleanup, claims);
            removed = true;
          }
        },
        "repository lease scavenging and fetch-lock release both failed",
      );
    } catch (error) {
      errors.push(error);
    }
    try {
      await this.cleanupClaimsNow(claims, `scavenge:${paths.repositoryDigest}:${leaseId}`);
    } catch (error) {
      errors.push(error);
    }
    if (errors.length > 0) {
      throwCollectedErrors(errors, "repository lease scavenging failed");
    }
    return removed;
  }

  private async scavengeRetentionEntry(
    paths: RepositoryPaths,
    entryName: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const validLiveLease = SAFE_ID.test(entryName)
      && existsSync(this.leasePaths(paths, entryName).metadata);
    if (validLiveLease) return;
    const claims: ClaimedPath[] = [];
    const errors: unknown[] = [];
    try {
      await runWithRepositoryLock(
        await this.acquireSourceOwnersLock(paths, signal),
        () => {
          if (SAFE_ID.test(entryName) && existsSync(this.leasePaths(paths, entryName).metadata)) return;
          const path = join(paths.sourceRetentionsDir, entryName);
          const expected = this.expectedEntry(path);
          const claim = expected ? this.quarantineEntry(path, "retention", expected) : null;
          if (claim) claims.push(claim);
        },
        "repository retention scavenging and lock release both failed",
      );
    } catch (error) {
      errors.push(error);
    }
    try {
      await this.cleanupClaimsNow(claims, `scavenge-retention:${paths.repositoryDigest}`);
    } catch (error) {
      errors.push(error);
    }
    if (errors.length > 0) {
      throwCollectedErrors(errors, "repository retention scavenging failed");
    }
  }

  private async scavengeOrphanWorktree(
    paths: RepositoryPaths,
    leaseId: string,
    cutoff: number,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const leasePaths = this.leasePaths(paths, leaseId);
    if (existsSync(leasePaths.metadata) || entryMtime(leasePaths.worktreeDir) > cutoff) return false;
    const claims: ClaimedPath[] = [];
    let removed = false;
    const errors: unknown[] = [];
    try {
      await runWithRepositoryLock(
        await this.acquireFetchLock(paths, signal),
        async () => {
          if (!existsSync(leasePaths.metadata)
            && existsSync(leasePaths.worktreeDir)
            && entryMtime(leasePaths.worktreeDir) <= cutoff) {
            await this.cleanupLeaseLocked(
              paths,
              leasePaths,
              derivedLeaseRecord(leaseId, leasePaths.worktreeDir),
              claims,
            );
            removed = true;
          }
        },
        "orphan repository worktree scavenging and lock release both failed",
      );
    } catch (error) {
      errors.push(error);
    }
    try {
      await this.cleanupClaimsNow(claims, `scavenge-worktree:${paths.repositoryDigest}:${leaseId}`);
    } catch (error) {
      errors.push(error);
    }
    if (errors.length > 0) {
      throwCollectedErrors(errors, "orphan repository worktree scavenging failed");
    }
    return removed;
  }

  private async scavengeOrphanRefs(paths: RepositoryPaths, signal?: AbortSignal): Promise<number> {
    return runWithRepositoryLock(
      await this.acquireFetchLock(paths, signal),
      async () => {
        let removed = 0;
        let batch: string[] = [];
        const processBatch = async (refs: readonly string[]): Promise<void> => {
          for (const ref of refs) {
            throwIfAborted(signal);
            const leaseId = leaseIdFromRef(ref);
            if (!leaseId) continue;
            const leasePaths = this.leasePaths(paths, leaseId);
            if (existsSync(leasePaths.metadata) || existsSync(leasePaths.worktreeDir)) continue;
            await this.gitCommand(["update-ref", "-d", ref], { cwd: paths.mirrorDir, signal });
            removed += 1;
          }
          await yieldToEventLoop();
          throwIfAborted(signal);
        };
        throwIfAborted(signal);
        await this.gitLines(
          ["for-each-ref", "--format=%(refname)", "refs/meridian/jobs"],
          { cwd: paths.mirrorDir, timeoutMs: this.gitTimeoutMs, signal },
          async (line) => {
            throwIfAborted(signal);
            if (!line) return;
            batch.push(line);
            if (batch.length < CLEANUP_BATCH_SIZE) return;
            const current = batch;
            batch = [];
            await processBatch(current);
          },
        );
        throwIfAborted(signal);
        if (batch.length > 0) {
          const current = batch;
          batch = [];
          await processBatch(current);
        }
        await this.gitCommand(["worktree", "prune", "--expire", "now"], {
          cwd: paths.mirrorDir,
          signal,
        });
        return removed;
      },
      "orphan repository ref scavenging and lock release both failed",
    );
  }

  private repositoriesRoot(): string {
    return join(this.cacheRoot, "repository-mirrors", `v${FORMAT_VERSION}`);
  }

  private pathsForDigest(repositoryDigest: string): RepositoryPaths {
    const repositoryRoot = join(this.repositoriesRoot(), repositoryDigest);
    return {
      repositoryDigest,
      repositoryRoot,
      mirrorDir: join(repositoryRoot, "objects.git"),
      mirrorMetadata: join(repositoryRoot, "mirror.json"),
      worktreesDir: join(repositoryRoot, "worktrees"),
      leasesDir: join(repositoryRoot, "leases"),
      sourceRetentionsDir: join(repositoryRoot, "source-retentions"),
      fetchLock: join(repositoryRoot, "fetch.lock"),
      sourceOwnersLock: join(repositoryRoot, "source-owners.lock"),
    };
  }

  private leasePaths(paths: RepositoryPaths, leaseId: string): LeasePaths {
    return {
      worktreeDir: join(paths.worktreesDir, leaseId),
      metadata: join(paths.leasesDir, `${leaseId}.json`),
      retentionDir: join(paths.sourceRetentionsDir, leaseId),
    };
  }

  private expectedEntry(path: string, identity?: ClaimedPathIdentity): ClaimedPath | null {
    let expected: ClaimedPath;
    try {
      expected = claimPathForCleanup(path);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return null;
      throw error;
    }
    if (identity && !sameClaimedPathIdentity(expected.identity, identity)) {
      throw new Error(`repository-owned cache entry changed before cleanup: ${path}`);
    }
    return expected;
  }

  private quarantineEntry(
    path: string,
    kind: RepositoryCleanupKind,
    expected: ClaimedPath,
    basePath = path,
  ): ClaimedPath | null {
    this.beforeQuarantine(path, expected);
    return quarantineCacheEntry(path, expected, {
      namespace: "meridian-cleanup",
      kind,
      basePath,
      afterRename: this.afterQuarantineRename,
    });
  }

  private async cleanupLeaseResidue(
    leasePaths: LeasePaths,
    leaseId: string,
    ownerKey: string,
  ): Promise<void> {
    const errors = new BoundedErrorCollector();
    const cleanup = async (outcomes: AsyncIterable<CleanupScanOutcome>): Promise<void> => {
      try {
        await this.cleanupScannedClaims(outcomes, ownerKey);
      } catch (error) {
        errors.add(error);
      }
    };
    await cleanup(this.scanCleanupDirectory(
      dirname(leasePaths.worktreeDir),
      (base, kind) => base === leaseId && kind === "worktree",
    ));
    await cleanup(this.scanCleanupDirectory(
      dirname(leasePaths.metadata),
      (base, kind) => base === `${leaseId}.json` && kind === "metadata",
    ));
    await cleanup(this.scanCleanupDirectory(
      dirname(leasePaths.retentionDir),
      (base, kind) => base === leaseId && kind === "retention",
    ));
    await cleanup(this.scanCleanupDirectory(
      leasePaths.retentionDir,
      (base, kind) => kind === "owner" && /^[0-9a-f]{64}\.json$/.test(base),
    ));
    errors.throwIfAny("repository lease-residue cleanup failed");
  }

  private async *scanCleanupDirectory(
    directory: string,
    accepts: (base: string, kind: RepositoryCleanupKind) => boolean,
    signal?: AbortSignal,
  ): AsyncGenerator<CleanupScanOutcome> {
    throwIfAborted(signal);
    const handle = await openDirectory(directory);
    if (!handle) return;
    let visited = 0;
    for await (const entry of handle) {
      throwIfAborted(signal);
      visited += 1;
      if (visited % CLEANUP_BATCH_SIZE === 0) await yieldToEventLoop();
      const parsed = parseCleanupEntryName(entry.name);
      if (!parsed || !accepts(parsed.base, parsed.kind)) continue;
      const path = join(directory, entry.name);
      if (this.cleanupClaims.has(path)) continue;
      try {
        const expected = this.expectedEntry(path);
        if (!expected) continue;
        if (cacheEntryIdentityDigest(expected.identity) !== parsed.identityDigest) {
          // A replacement can never inherit cleanup authority from a filename. Preserve it in a
          // namespace restart scanning deliberately does not recognize.
          this.beforeQuarantine(path, expected);
          quarantineCacheEntry(path, expected, {
            namespace: "meridian-rejected",
            kind: parsed.kind,
            basePath: join(directory, parsed.base),
          });
          continue;
        }
        // A residue may still be referenced by the previous process's in-memory retry. Moving it
        // again establishes one exact scanner owner; the previous path becomes a harmless miss.
        const claimed = this.quarantineEntry(
          path,
          parsed.kind,
          expected,
          join(directory, parsed.base),
        );
        if (claimed) yield { ok: true, claim: claimed };
      } catch (error) {
        if (errorCode(error) !== "ENOENT") yield { ok: false, error };
      }
    }
  }

  private async cleanupScannedClaims(
    outcomes: AsyncIterable<CleanupScanOutcome>,
    ownerKey: string,
    signal?: AbortSignal,
  ): Promise<void> {
    let batch: ClaimedPath[] = [];
    const errors = new BoundedErrorCollector();
    try {
      for await (const outcome of outcomes) {
        throwIfAborted(signal);
        if (!outcome.ok) {
          errors.add(outcome.error);
          continue;
        }
        batch.push(outcome.claim);
        if (batch.length < CLEANUP_BATCH_SIZE) continue;
        const current = batch;
        batch = [];
        try {
          await this.cleanupClaimsNow(current, ownerKey);
        } catch (error) {
          errors.add(error);
        }
        await yieldToEventLoop();
      }
    } catch (error) {
      if (signal?.aborted) throwIfAborted(signal);
      // Directory-stream failures are category-local. Flush every claim already admitted before
      // surfacing the scan failure so an unreadable later entry cannot strand the partial batch.
      errors.add(error);
    }
    if (batch.length > 0) {
      throwIfAborted(signal);
      try {
        await this.cleanupClaimsNow(batch, ownerKey);
      } catch (error) {
        errors.add(error);
      }
    }
    errors.throwIfAny("repository cleanup-residue sweep failed");
  }

  private async sweepPhysicalCleanupResidue(signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    const repositoriesRoot = this.repositoriesRoot();
    if (!isPlainDirectory(repositoriesRoot)) return;
    const errors = new BoundedErrorCollector();
    const cleanup = async (
      outcomes: AsyncIterable<CleanupScanOutcome>,
      ownerKey: string,
    ): Promise<void> => {
      try {
        await this.cleanupScannedClaims(outcomes, ownerKey, signal);
      } catch (error) {
        if (signal?.aborted) throwIfAborted(signal);
        errors.add(error);
      }
    };
    for await (const repositoryDigest of plainDirectoryEntryNames(repositoriesRoot)) {
      throwIfAborted(signal);
      if (!SAFE_ID.test(repositoryDigest)) continue;
      const paths = this.pathsForDigest(repositoryDigest);
      const ownerKey = `residue:${repositoryDigest}`;
      await cleanup(this.scanCleanupDirectory(paths.repositoryRoot, (base, kind) => (
        kind === "lock" && (base === "fetch.lock" || base === "source-owners.lock")
      ), signal), ownerKey);
      await cleanup(this.scanCleanupDirectory(paths.worktreesDir, (base, kind) => (
        kind === "worktree" && SAFE_ID.test(base)
      ), signal), ownerKey);
      await cleanup(this.scanCleanupDirectory(paths.leasesDir, (base, kind) => (
        kind === "metadata" && /^[0-9a-f]{64}\.json$/.test(base)
      ), signal), ownerKey);
      await cleanup(this.scanCleanupDirectory(paths.sourceRetentionsDir, (base, kind) => (
        kind === "retention" && SAFE_ID.test(base)
      ), signal), ownerKey);
      try {
        for await (const leaseId of plainDirectoryEntryNames(paths.sourceRetentionsDir)) {
          if (!SAFE_ID.test(leaseId)) continue;
          await cleanup(this.scanCleanupDirectory(
            join(paths.sourceRetentionsDir, leaseId),
            (base, kind) => (
            kind === "owner" && /^[0-9a-f]{64}\.json$/.test(base)
            ),
            signal,
          ), ownerKey);
        }
      } catch (error) {
        if (signal?.aborted) throwIfAborted(signal);
        errors.add(error);
      }
      await yieldToEventLoop();
    }
    errors.throwIfAny("repository physical-residue sweep failed");
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
      || persisted.state !== "active-job"
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
    let releaseCompleted = false;
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
        const at = new Date(store.now());
        utimesSync(leasePaths.metadata, at, at);
        if (existsSync(leasePaths.worktreeDir)) utimesSync(leasePaths.worktreeDir, at, at);
      },
      release(): Promise<void> {
        if (releaseCompleted) return Promise.resolve();
        if (!releasePromise) {
          releaseStarted = true;
          releasePromise = store.releaseLease(repositoryPaths, leasePaths, record)
            .then(() => { releaseCompleted = true; })
            .finally(() => { releasePromise = undefined; });
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
    let releaseCompleted = false;
    const store = this;
    return {
      leaseId: record.leaseId,
      repositoryDigest,
      worktreeDir: leasePaths.worktreeDir,
      oid: record.oid,
      ref: record.ref,
      touch(): void {
        if (releaseStarted || !existsSync(leasePaths.metadata)) return;
        const at = new Date(store.now());
        utimesSync(leasePaths.metadata, at, at);
        if (existsSync(leasePaths.worktreeDir)) utimesSync(leasePaths.worktreeDir, at, at);
      },
      release(): Promise<void> {
        if (releaseCompleted) return Promise.resolve();
        if (!releasePromise) {
          releaseStarted = true;
          releasePromise = store.releaseLease(repositoryPaths, leasePaths, record)
            .then(() => { releaseCompleted = true; })
            .finally(() => { releasePromise = undefined; });
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
    const ownerKey = leaseCleanupOwnerKey(repositoryPaths.repositoryDigest, record.leaseId);
    await this.retryCleanupOwner(ownerKey);
    await this.cleanupLeaseResidue(leasePaths, record.leaseId, ownerKey);
    if (!existsSync(leasePaths.metadata)) return;

    const claims: ClaimedPath[] = [];
    const errors: unknown[] = [];
    try {
      await runWithRepositoryLock(
        await this.acquireFetchLock(repositoryPaths),
        async () => {
          let cleanup: LeaseRecord | DerivedLeaseRecord | null = null;
          await runWithRepositoryLock(
            await this.acquireSourceOwnersLock(repositoryPaths),
            async () => {
              if (!existsSync(leasePaths.metadata)) return;
              const persisted = readLeaseRecord(leasePaths.metadata, record.leaseId);
              if ("cleanupRefs" in persisted || persisted.state === "cleanup-pending") {
                cleanup = persisted;
              } else {
                // Persist job release before inspecting external owners. A crash after this
                // transition is distinguishable from a live job and startup can finish cleanup.
                persisted.state = "released-retained";
                persisted.updatedAtMs = this.now();
                writePrivateJson(leasePaths.metadata, persisted);
                if (await sourceRetentionDeadline(
                  leasePaths.retentionDir,
                  repositoryPaths.repositoryDigest,
                  record.leaseId,
                  this.now(),
                ) <= this.now()) {
                  cleanup = persisted;
                  // This tombstone is the CAS: retainSource fails after this point, while retries
                  // can still discover the lease if Git or physical cleanup fails.
                  persisted.state = "cleanup-pending";
                  persisted.updatedAtMs = this.now();
                  writePrivateJson(leasePaths.metadata, persisted);
                }
              }
            },
            "repository lease state transition and owner-lock release both failed",
          );
          if (cleanup) await this.cleanupLeaseLocked(repositoryPaths, leasePaths, cleanup, claims);
        },
        "repository lease cleanup and fetch-lock release both failed",
      );
    } catch (error) {
      errors.push(error);
    }
    try {
      await this.cleanupClaimsNow(claims, ownerKey);
    } catch (error) {
      errors.push(error);
    }
    if (errors.length > 0) {
      throwCollectedErrors(errors, "repository lease cleanup failed");
    }
  }

  private async cleanupLeaseLocked(
    repositoryPaths: RepositoryPaths,
    leasePaths: LeasePaths,
    record: LeaseRecord | DerivedLeaseRecord,
    claims: ClaimedPath[],
  ): Promise<void> {
    let firstError: unknown;
    const attempt = async (run: () => Promise<unknown>): Promise<void> => {
      try {
        await run();
      } catch (error) {
        firstError ??= error;
      }
    };

    // Removing a registered worktree asks Git to recursively walk the checkout while holding the
    // repository-admin lock. Move the exact checkout out of the live namespace instead; prune can
    // unregister the now-missing path without touching the quarantined tree.
    const worktreeExpected = this.expectedEntry(leasePaths.worktreeDir, record.worktreeIdentity);
    const worktree = worktreeExpected
      ? this.quarantineEntry(leasePaths.worktreeDir, "worktree", worktreeExpected)
      : null;
    if (worktree) claims.push(worktree);
    for (const ref of cleanupRefs(record)) {
      await attempt(() => this.gitCommand(["update-ref", "-d", ref], { cwd: repositoryPaths.mirrorDir }));
    }
    await attempt(() => this.gitCommand(["worktree", "prune", "--expire", "now"], {
      cwd: repositoryPaths.mirrorDir,
    }));
    if (firstError) throw firstError;
    // Keep the cleanup-pending metadata tombstone until every Git cleanup step succeeds. A
    // background retry or restart sweep can then finish partial cleanup deterministically.
    const retentionExpected = this.expectedEntry(leasePaths.retentionDir);
    const retention = retentionExpected
      ? this.quarantineEntry(leasePaths.retentionDir, "retention", retentionExpected)
      : null;
    if (retention) claims.push(retention);
    const metadataExpected = this.expectedEntry(leasePaths.metadata);
    const metadata = metadataExpected
      ? this.quarantineEntry(leasePaths.metadata, "metadata", metadataExpected)
      : null;
    if (metadata) claims.push(metadata);
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

  private async acquireFetchLock(paths: RepositoryPaths, signal?: AbortSignal): Promise<RepositoryLockRelease> {
    return this.acquireDirectoryLock(paths.repositoryRoot, paths.fetchLock, signal);
  }

  private async acquireSourceOwnersLock(paths: RepositoryPaths, signal?: AbortSignal): Promise<RepositoryLockRelease> {
    return this.acquireDirectoryLock(paths.repositoryRoot, paths.sourceOwnersLock, signal);
  }

  private async acquireDirectoryLock(
    repositoryRoot: string,
    lockPath: string,
    signal?: AbortSignal,
  ): Promise<RepositoryLockRelease> {
    createPrivateDirectory(repositoryRoot);
    const startedAt = Date.now();
    while (true) {
      throwIfAborted(signal);
      const lockId = this.makeId();
      let createdIdentity: DirectoryIdentity | null = null;
      try {
        mkdirSync(lockPath, { mode: 0o700 });
        createdIdentity = safeDirectoryStat(lockPath);
        if (!createdIdentity) throw new Error("repository lifecycle lock directory is unsafe");
        this.writeLockOwner(join(lockPath, "owner.json"), {
          lockId,
          pid: process.pid,
          processIdentity: this.ownerProcessIdentity,
          acquiredAtMs: Date.now(),
        });
        const heartbeat = setInterval(() => {
          if (!lockOwnedBy(lockPath, lockId)) return;
          try {
            const now = new Date();
            utimesSync(lockPath, now, now);
          } catch {
            // A cleanup can remove the lock between the ownership check and the timestamp update.
          }
        }, Math.max(1, Math.min(30_000, Math.floor(this.staleLockMs / 3))));
        heartbeat.unref?.();
        let released = false;
        return () => {
          if (released) return null;
          released = true;
          clearInterval(heartbeat);
          const observedEntry = safeDirectoryStat(lockPath);
          const observedOwner = readDirectoryLockOwner(lockPath);
          if (!observedEntry || observedOwner?.lockId !== lockId) return null;
          const currentEntry = safeDirectoryStat(lockPath);
          const currentOwner = readDirectoryLockOwner(lockPath);
          if (!currentEntry
            || !sameDirectoryIdentity(observedEntry, currentEntry)
            || !sameDirectoryLockOwner(observedOwner, currentOwner)) return null;
          try {
            const expected = this.expectedEntry(lockPath);
            if (!expected || !directoryIdentityMatchesClaim(currentEntry, expected.identity)) return null;
            const claim = this.quarantineEntry(lockPath, "lock", expected);
            if (claim) this.enqueueCleanupClaim(claim, `lock:${repositoryRoot}:${lockId}`);
            return null;
          } catch (error) {
            const code = errorCode(error);
            return code === "ENOENT" || code === "EEXIST" ? null : error;
          }
        };
      } catch (error) {
        if (createdIdentity) {
          const currentEntry = safeDirectoryStat(lockPath);
          const currentOwner = readDirectoryLockOwner(lockPath);
          if (currentEntry
            && sameDirectoryInode(createdIdentity, currentEntry)
            && (currentOwner === null || currentOwner.lockId === lockId)) {
            try {
              const expected = this.expectedEntry(lockPath);
              if (!expected || !directoryIdentityMatchesClaim(currentEntry, expected.identity)) {
                throw new Error("repository lock changed before publication rollback quarantine");
              }
              const claim = this.quarantineEntry(lockPath, "lock", expected);
              if (claim) this.enqueueCleanupClaim(claim, `lock:${repositoryRoot}:${lockId}`);
            } catch (cleanupError) {
              const code = errorCode(cleanupError);
              if (code !== "ENOENT" && code !== "EEXIST") {
                throw new AggregateError([error, cleanupError], "repository lock owner publication cleanup failed");
              }
            }
          }
          throw error;
        }
        if (errorCode(error) !== "EEXIST") throw error;
        const observedEntry = safeDirectoryStat(lockPath);
        const observedOwner = readDirectoryLockOwner(lockPath);
        if (observedEntry && Date.now() - observedEntry.mtimeMs > this.staleLockMs
          && canReclaimDirectoryLock(observedOwner, this.processIdentity)) {
          // Revalidate inode, timestamp, and process-start authority immediately before rename.
          const currentEntry = safeDirectoryStat(lockPath);
          const currentOwner = readDirectoryLockOwner(lockPath);
          if (currentEntry
            && sameDirectoryIdentity(observedEntry, currentEntry)
            && sameDirectoryLockOwner(observedOwner, currentOwner)
            && Date.now() - currentEntry.mtimeMs > this.staleLockMs) {
            try {
              const expected = this.expectedEntry(lockPath);
              if (!expected || !directoryIdentityMatchesClaim(currentEntry, expected.identity)) continue;
              const claim = this.quarantineEntry(lockPath, "lock", expected);
              if (claim) this.enqueueCleanupClaim(claim, `lock:${repositoryRoot}:stale`);
            } catch (renameError) {
              const code = errorCode(renameError);
              if (code !== "ENOENT" && code !== "EEXIST") throw renameError;
            }
            continue;
          }
        }
        if (Date.now() - startedAt >= this.lockTimeoutMs) {
          throw new WebError(503, "timed out waiting for repository lifecycle lock");
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

async function defaultGitLineRunner(
  args: readonly string[],
  options: RepositoryGitOptions,
  consume: (line: string) => void | Promise<void>,
): Promise<void> {
  await streamGitLines([...args], {
    cwd: options.cwd,
    token: options.token,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  }, consume);
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
    const worktreeIdentity = parseClaimedPathIdentity(value.worktreeIdentity);
    const identityIsValid = value.state === "preparing"
      ? value.worktreeIdentity === undefined || worktreeIdentity !== null
      : worktreeIdentity !== null;
    const commonIsValid = (
      value.formatVersion === FORMAT_VERSION
      && value.leaseId === leaseId
      && (value.state === "preparing"
        || value.state === "active-job"
        || value.state === "released-retained"
        || value.state === "cleanup-pending")
      && typeof value.createdAtMs === "number"
      && Number.isFinite(value.createdAtMs)
      && typeof value.updatedAtMs === "number"
      && Number.isFinite(value.updatedAtMs)
      && identityIsValid
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
        ...(worktreeIdentity ? { worktreeIdentity } : {}),
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
      return {
        ...value,
        oid: value.oid.toLowerCase(),
        ...(worktreeIdentity ? { worktreeIdentity } : {}),
      } as DetachedLeaseRecord;
    }
  } catch (error) {
    if (error instanceof WebError) throw error;
    throw new WebError(409, "repository worktree lease metadata is unreadable");
  }
  throw new WebError(409, "repository worktree lease metadata is incompatible");
}

function parseClaimedPathIdentity(value: unknown): ClaimedPathIdentity | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<ClaimedPathIdentity>;
  if (typeof candidate.dev !== "string" || candidate.dev.length === 0
    || typeof candidate.ino !== "string" || candidate.ino.length === 0
    || (candidate.kind !== "directory"
      && candidate.kind !== "file"
      && candidate.kind !== "symlink"
      && candidate.kind !== "other")) return null;
  return Object.freeze({ dev: candidate.dev, ino: candidate.ino, kind: candidate.kind });
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

function requireWorktreeIdentity(path: string): ClaimedPathIdentity {
  const claim = claimPathForCleanup(path);
  if (claim.identity.kind !== "directory") {
    throw new WebError(409, "repository worktree path is not a plain directory");
  }
  return claim.identity;
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

async function openDirectory(path: string): Promise<Awaited<ReturnType<typeof opendir>> | null> {
  try {
    return await opendir(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") return null;
    throw error;
  }
}

async function* plainDirectoryEntryNames(path: string): AsyncGenerator<string> {
  const handle = await openDirectory(path);
  if (!handle) return;
  let visited = 0;
  for await (const entry of handle) {
    if (entry.isDirectory() && !entry.isSymbolicLink()) yield entry.name;
    visited += 1;
    if (visited % CLEANUP_BATCH_SIZE === 0) await yieldToEventLoop();
  }
}

async function* directoryEntryNames(path: string): AsyncGenerator<string> {
  const handle = await openDirectory(path);
  if (!handle) return;
  let visited = 0;
  for await (const entry of handle) {
    yield entry.name;
    visited += 1;
    if (visited % CLEANUP_BATCH_SIZE === 0) await yieldToEventLoop();
  }
}

async function* leaseMetadataEntryIds(path: string): AsyncGenerator<string> {
  const handle = await openDirectory(path);
  if (!handle) return;
  let visited = 0;
  for await (const entry of handle) {
    if (entry.isFile() && !entry.isSymbolicLink() && entry.name.endsWith(".json")) {
      const leaseId = entry.name.slice(0, -5);
      if (SAFE_ID.test(leaseId)) yield leaseId;
    }
    visited += 1;
    if (visited % CLEANUP_BATCH_SIZE === 0) await yieldToEventLoop();
  }
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Run one operation under an already-acquired lock without losing either failure. */
async function runWithRepositoryLock<T>(
  release: RepositoryLockRelease,
  operation: () => T | Promise<T>,
  message: string,
): Promise<T> {
  let value!: T;
  let operationCompleted = false;
  let operationError: unknown;
  try {
    value = await operation();
    operationCompleted = true;
  } catch (error) {
    operationError = error;
  }

  let releaseError: unknown | null = null;
  try {
    releaseError = release();
  } catch (error) {
    // Release callbacks are designed to report instead of throw, but keep this boundary total so
    // an injected implementation cannot bypass aggregation or the caller's physical cleanup.
    releaseError = error;
  }

  const errors: unknown[] = [];
  if (!operationCompleted) errors.push(operationError);
  if (releaseError !== null) errors.push(releaseError);
  if (errors.length > 0) throwCollectedErrors(errors, message);
  return value;
}

function throwCollectedErrors(errors: readonly unknown[], message: string): never {
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, message);
  throw new Error(message);
}

function appendDistinctErrors(target: unknown[], error: unknown): void {
  if (error instanceof AggregateError) {
    for (const nested of error.errors) appendDistinctErrors(target, nested);
    return;
  }
  if (!target.includes(error)) target.push(error);
}

/** Preserve representative failures without letting an unbounded sweep build an O(N) inventory. */
class BoundedErrorCollector {
  private readonly errors: unknown[] = [];
  private omitted = 0;

  add(error: unknown): void {
    if (this.errors.length < MAX_REPORTED_CLEANUP_ERRORS) this.errors.push(error);
    else this.omitted += 1;
  }

  throwIfAny(message: string): void {
    if (this.errors.length === 0 && this.omitted === 0) return;
    const reported = this.omitted > 0
      ? [...this.errors, new Error(`${this.omitted} additional cleanup failures omitted`)]
      : this.errors;
    throwCollectedErrors(reported, message);
  }
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

function requirePrivateRetentionDirectory(path: string, repositoryRoot: string): void {
  createPrivateDirectory(path);
  const entry = lstatSync(path);
  const canonicalRoot = realpathSync(repositoryRoot);
  const canonical = realpathSync(path);
  if (!entry.isDirectory()
    || entry.isSymbolicLink()
    || (canonical !== canonicalRoot && !canonical.startsWith(`${canonicalRoot}${sep}`))) {
    throw new WebError(409, "repository source retention directory is unsafe");
  }
}

function readSourceRetention(
  path: string,
  repositoryDigest: string,
  leaseId: string,
  ownerDigest: string,
): number {
  try {
    const entry = lstatSync(path);
    if (!entry.isFile() || entry.isSymbolicLink()) return 0;
    const value = readJson(path) as Partial<SourceRetentionRecord>;
    if (value.formatVersion !== FORMAT_VERSION
      || value.repositoryDigest !== repositoryDigest
      || value.leaseId !== leaseId
      || value.ownerDigest !== ownerDigest
      || !Number.isSafeInteger(value.retainedUntilMs)
      || (value.retainedUntilMs as number) < 0) return 0;
    return value.retainedUntilMs as number;
  } catch {
    return 0;
  }
}

async function sourceRetentionDeadline(
  directory: string,
  repositoryDigest: string,
  leaseId: string,
  now: number,
): Promise<number> {
  if (!isPlainDirectory(directory)) return 0;
  let deadline = 0;
  const handle = await openDirectory(directory);
  if (!handle) return 0;
  let visited = 0;
  for await (const entry of handle) {
    visited += 1;
    if (visited % CLEANUP_BATCH_SIZE === 0) await yieldToEventLoop();
    const ownerMatch = /^([0-9a-f]{64})\.json$/.exec(entry.name);
    if (!entry.isFile() || entry.isSymbolicLink() || !ownerMatch) continue;
    const retainedUntilMs = readSourceRetention(
      join(directory, entry.name),
      repositoryDigest,
      leaseId,
      ownerMatch[1],
    );
    if (retainedUntilMs <= now) continue;
    deadline = Math.max(deadline, retainedUntilMs);
  }
  return deadline;
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

function requireDigest(value: string, label: string): string {
  if (typeof value !== "string" || !SAFE_ID.test(value)) {
    throw new WebError(400, `${label} is invalid`);
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

function positiveInteger(value: number | undefined, fallback: number, label: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result <= 0) {
    throw new WebError(500, `${label} must be a positive integer`);
  }
  return result;
}

function cleanupCandidateKey(candidate: CleanupCandidate): string {
  return `${candidate.repositoryDigest}:${candidate.leaseId}`;
}

function leaseCleanupOwnerKey(repositoryDigest: string, leaseId: string): string {
  return `lease:${repositoryDigest}:${leaseId}`;
}

function parseCleanupEntryName(
  name: string,
): { base: string; kind: RepositoryCleanupKind; identityDigest: string } | null {
  const parsed = parseCacheQuarantineEntryName(name, "meridian-cleanup");
  if (!parsed || !isRepositoryCleanupKind(parsed.kind)) return null;
  return {
    base: parsed.baseName,
    kind: parsed.kind,
    identityDigest: parsed.identityDigest,
  };
}

function isRepositoryCleanupKind(value: string): value is RepositoryCleanupKind {
  return value === "lock"
    || value === "worktree"
    || value === "metadata"
    || value === "retention"
    || value === "owner";
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

interface DirectoryLockOwner {
  readonly lockId: string;
  readonly pid?: number;
  readonly processIdentity?: string;
}

interface DirectoryIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly mtimeMs: number;
}

function lockOwnedBy(lockPath: string, lockId: string): boolean {
  return readDirectoryLockOwner(lockPath)?.lockId === lockId;
}

function readDirectoryLockOwner(lockPath: string): DirectoryLockOwner | null {
  try {
    const owner = readJson(join(lockPath, "owner.json")) as {
      lockId?: unknown;
      pid?: unknown;
      processIdentity?: unknown;
    };
    if (typeof owner.lockId !== "string") return null;
    return {
      lockId: owner.lockId,
      ...(Number.isSafeInteger(owner.pid) && (owner.pid as number) > 0 ? { pid: owner.pid as number } : {}),
      ...(typeof owner.processIdentity === "string" && owner.processIdentity.length > 0
        ? { processIdentity: owner.processIdentity }
        : {}),
    };
  } catch {
    return null;
  }
}

function safeDirectoryStat(path: string): DirectoryIdentity | null {
  try {
    const entry = lstatSync(path);
    if (!entry.isDirectory() || entry.isSymbolicLink()) return null;
    return { dev: entry.dev, ino: entry.ino, mtimeMs: entry.mtimeMs };
  } catch {
    return null;
  }
}

function sameDirectoryIdentity(left: DirectoryIdentity, right: DirectoryIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mtimeMs === right.mtimeMs;
}

function sameDirectoryInode(left: DirectoryIdentity, right: DirectoryIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function directoryIdentityMatchesClaim(
  directory: DirectoryIdentity,
  claim: ClaimedPathIdentity,
): boolean {
  return claim.kind === "directory"
    && claim.dev === String(directory.dev)
    && claim.ino === String(directory.ino);
}

function sameDirectoryLockOwner(
  left: DirectoryLockOwner | null,
  right: DirectoryLockOwner | null,
): boolean {
  return left?.lockId === right?.lockId
    && left?.pid === right?.pid
    && left?.processIdentity === right?.processIdentity;
}

function canReclaimDirectoryLock(
  owner: DirectoryLockOwner | null,
  processIdentity: ProcessIdentityResolver,
): boolean {
  if (owner?.pid === undefined || !processIsAlive(owner.pid)) return true;
  const actual = processIdentity(owner.pid);
  return owner.processIdentity !== undefined
    && !owner.processIdentity.startsWith("unverifiable:")
    && actual !== null
    && actual !== owner.processIdentity;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === "EPERM";
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
