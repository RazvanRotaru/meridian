import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  opendirSync,
  readFileSync,
  realpathSync,
  renameSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  claimPathForCleanup,
  removeClaimedPath,
  sameClaimedPathIdentity,
  type ClaimedPath,
  type ClaimedPathIdentity,
} from "./claimed-path-cleanup";

const LOCK_DIRECTORY = ".graph-capability-lifecycle.lock";
const CLEANUP_DIRECTORY = ".graph-capability-lifecycle-cleanup";
const OWNER_FILE = "owner.json";
const DEFAULT_STALE_MS = 10 * 60 * 1_000;
const HEARTBEAT_MS = 10_000;
const RETRY_MS = 15;
const DEFAULT_ACQUIRE_TIMEOUT_MS = 30_000;
const MAX_CLEANUP_RESIDUE_BATCH = 32;
const CLEANUP_RESIDUE_NAME = /^\.graph-capability-lifecycle\.lock\.(?:release-[0-9a-f]{48}|(?:stale|rollback|residue)-[0-9a-f]{24})$/;

interface HeldLifecycleLock {
  readonly path: string;
  readonly token: string;
  readonly entryIdentity: ClaimedPathIdentity;
  readonly ownerIdentity: ClaimedPathIdentity;
}

const heldLock = new AsyncLocalStorage<HeldLifecycleLock>();
const activeLocks = new Set<string>();
// A process-wide registry coordinates independent lock instances. Durable residue is still the
// source of truth across restart; this only prevents another instance in this process from
// re-claiming a path between its atomic rename and physical removal.
const activeCleanupClaims = new Set<string>();
export type ProcessIdentityResolver = (pid: number) => string | null;

export class CacheRootLifecycleLock {
  private readonly path: string;
  private readonly cleanupRoot: string;
  private readonly cleanupRootClaim: ClaimedPath;
  private readonly staleMs: number;
  private readonly acquireTimeoutMs: number;
  private readonly now: () => number;
  private readonly processIdentity: ProcessIdentityResolver;
  private readonly ownerProcessIdentity: string;
  private readonly beforePhysicalCleanup: (paths: readonly string[]) => Promise<void>;
  private readonly beforeOwnerWrite: (path: string) => void;
  private readonly beforeReleaseClaim: (path: string) => void;
  private readonly beforeStaleQuarantine: (path: string) => void;
  private readonly beforeResidueClaim: (paths: readonly string[]) => Promise<void>;

  constructor(cacheRoot: string, options: {
    staleMs?: number;
    acquireTimeoutMs?: number;
    now?: () => number;
    processIdentity?: ProcessIdentityResolver;
    /** Test seam after atomic quarantine and outside lock admission. */
    beforePhysicalCleanup?: (paths: readonly string[]) => Promise<void>;
    /** Test seam for exercising acquisition rollback after mkdir. */
    beforeOwnerWrite?: (path: string) => void;
    /** Test seam before the final identity/token revalidation for release quarantine. */
    beforeReleaseClaim?: (path: string) => void;
    /** Test seam after the final stale observation and before its atomic quarantine. */
    beforeStaleQuarantine?: (path: string) => void;
    /** Test seam after a bounded residue snapshot and before its atomic ownership rename. */
    beforeResidueClaim?: (paths: readonly string[]) => Promise<void>;
  } = {}) {
    const root = realpathSync(resolve(cacheRoot));
    this.path = join(root, LOCK_DIRECTORY);
    this.cleanupRoot = join(root, CLEANUP_DIRECTORY);
    try {
      mkdirSync(this.cleanupRoot, { mode: 0o700 });
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
    }
    this.cleanupRootClaim = claimPathForCleanup(this.cleanupRoot);
    if (this.cleanupRootClaim.identity.kind !== "directory") {
      throw new Error("cache-root lifecycle cleanup root is unsafe");
    }
    this.staleMs = positiveDuration(options.staleMs ?? DEFAULT_STALE_MS);
    this.acquireTimeoutMs = positiveDuration(options.acquireTimeoutMs ?? DEFAULT_ACQUIRE_TIMEOUT_MS);
    this.now = options.now ?? Date.now;
    this.processIdentity = options.processIdentity ?? resolveProcessIdentity;
    this.ownerProcessIdentity = this.processIdentity(process.pid)
      ?? `unverifiable:${process.pid}:${randomBytes(24).toString("hex")}`;
    this.beforePhysicalCleanup = options.beforePhysicalCleanup ?? (() => Promise.resolve());
    this.beforeOwnerWrite = options.beforeOwnerWrite ?? (() => undefined);
    this.beforeReleaseClaim = options.beforeReleaseClaim ?? (() => undefined);
    this.beforeStaleQuarantine = options.beforeStaleQuarantine ?? (() => undefined);
    this.beforeResidueClaim = options.beforeResidueClaim ?? (() => Promise.resolve());
  }

  /** Cross-process exclusive admission, reentrant for the current asynchronous call chain. */
  async runExclusive<T>(operation: () => Promise<T> | T, signal?: AbortSignal): Promise<T> {
    const current = heldLock.getStore();
    if (current?.path === this.path
      && activeLocks.has(activeLockKey(current.path, current.token))
      && this.isOwner(current)) return operation();
    // Cleanup is durable on disk and independent of canonical lock admission. Start one bounded
    // retry pass immediately, but retain and await its outcome before this call settles so no
    // unbounded background promise or unhandled rejection is created.
    const cleanupTasks: Array<Promise<unknown | null>> = [settle(this.cleanupResidueBatch())];
    let value!: T;
    let lifecycleFailed = false;
    let lifecycleError: unknown;
    try {
      value = await this.runAcquired(operation, signal, cleanupTasks);
    } catch (error) {
      lifecycleFailed = true;
      lifecycleError = error;
    }
    const cleanupErrors = (await Promise.all(cleanupTasks)).filter((error) => error !== null);
    const cleanupError = cleanupErrors.length === 0
      ? null
      : cleanupErrors.length === 1
        ? cleanupErrors[0]
        : new AggregateError(cleanupErrors, "multiple cache-root lifecycle cleanups failed");
    if (lifecycleFailed && cleanupError !== null) {
      throw new AggregateError(
        [lifecycleError, cleanupError],
        "cache-root lifecycle operation and residue cleanup both failed",
      );
    }
    if (lifecycleFailed) throw lifecycleError;
    if (cleanupError !== null) throw cleanupError;
    return value;
  }

  private async runAcquired<T>(
    operation: () => Promise<T> | T,
    signal: AbortSignal | undefined,
    cleanupTasks: Array<Promise<unknown | null>>,
  ): Promise<T> {
    const acquired = await this.acquire(signal, cleanupTasks);
    const activeKey = activeLockKey(this.path, acquired.token);
    activeLocks.add(activeKey);
    const heartbeat = setInterval(() => this.heartbeat(acquired), HEARTBEAT_MS);
    heartbeat.unref();
    let value!: T;
    let operationFailed = false;
    let operationError: unknown;
    try {
      value = await heldLock.run(acquired, operation);
    } catch (error) {
      operationFailed = true;
      operationError = error;
    } finally {
      clearInterval(heartbeat);
      // AsyncLocalStorage contexts may outlive this callback in detached work. Mark the token
      // inactive before releasing its filesystem path so those descendants must acquire normally.
      activeLocks.delete(activeKey);
    }
    let releaseFailed = false;
    let releaseError: unknown;
    try {
      await this.release(acquired);
    } catch (error) {
      releaseFailed = true;
      releaseError = error;
    }
    if (operationFailed && releaseFailed) {
      throw new AggregateError(
        [operationError, releaseError],
        "cache-root lifecycle operation and lock release both failed",
      );
    }
    if (operationFailed) throw operationError;
    if (releaseFailed) throw releaseError;
    return value;
  }

  private async acquire(
    signal: AbortSignal | undefined,
    cleanupTasks: Array<Promise<unknown | null>>,
  ): Promise<HeldLifecycleLock> {
    const token = randomBytes(24).toString("hex");
    const deadline = Date.now() + this.acquireTimeoutMs;
    while (true) {
      throwIfAborted(signal);
      if (Date.now() >= deadline) {
        throw new Error(`timed out acquiring cache-root lifecycle lock after ${this.acquireTimeoutMs}ms`);
      }
      let created: ClaimedPath;
      try {
        mkdirSync(this.path, { mode: 0o700 });
        created = claimPathForCleanup(this.path);
        if (created.identity.kind !== "directory") {
          throw new Error("cache-root lifecycle lock mkdir did not create a directory");
        }
      } catch (error) {
        if (!isAlreadyExists(error)) throw error;
        const stale = this.reclaimStaleLock();
        if (stale) cleanupTasks.push(settle(this.cleanupClaim(stale)));
        await abortableDelay(Math.min(RETRY_MS, Math.max(1, deadline - Date.now())), signal);
        continue;
      }
      try {
        this.beforeOwnerWrite(this.path);
        this.requireCurrentClaim(created, "acquisition owner write");
        writeFileSync(join(this.path, OWNER_FILE), `${JSON.stringify({
          token,
          pid: process.pid,
          processIdentity: this.ownerProcessIdentity,
          acquiredAtMs: this.now(),
        })}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
        const owner = claimPathForCleanup(join(this.path, OWNER_FILE));
        if (owner.identity.kind !== "file") {
          throw new Error("cache-root lifecycle owner record is unsafe");
        }
        this.requireCurrentClaim(created, "acquisition completion");
        return Object.freeze({
          path: this.path,
          token,
          entryIdentity: created.identity,
          ownerIdentity: owner.identity,
        });
      } catch (error) {
        let rollback: ClaimedPath | null = null;
        try {
          rollback = this.quarantineCreatedLock("rollback", created);
          if (rollback) await this.cleanupClaim(rollback);
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            "cache-root lifecycle acquisition and rollback cleanup both failed",
          );
        }
        throw error;
      }
    }
  }

  private reclaimStaleLock(): ClaimedPath | null {
    let entry;
    let observedClaim: ClaimedPath;
    try {
      entry = lstatSync(this.path);
      observedClaim = claimPathForCleanup(this.path);
    } catch {
      return null;
    }
    if (!entry.isDirectory() || entry.isSymbolicLink()
      || observedClaim.identity.kind !== "directory") {
      throw new Error("cache-root lifecycle lock path is unsafe");
    }
    if (this.now() - entry.mtimeMs < this.staleMs) return null;
    const observed = this.readOwner();
    if (observed?.pid !== undefined && processIsAlive(observed.pid)) {
      const liveIdentity = this.processIdentity(observed.pid);
      // A matching start/boot identity is the same paused owner and may never be age-stolen. If
      // this platform cannot verify identity, fail bounded acquisition rather than risking theft.
      if (observed.processIdentity === undefined
        || observed.processIdentity.startsWith("unverifiable:")
        || liveIdentity === null
        || liveIdentity === observed.processIdentity) return null;
    }
    // A dead owner's token and timestamp must still match immediately before quarantine. This
    // prevents stealing a replacement lock created after the first stale observation.
    let revalidated;
    try {
      revalidated = lstatSync(this.path);
    } catch {
      return null;
    }
    const current = this.readOwner();
    if (this.now() - revalidated.mtimeMs < this.staleMs
      || observed?.token !== current?.token
      || observed?.pid !== current?.pid
      || observed?.processIdentity !== current?.processIdentity
      || entry.mtimeMs !== revalidated.mtimeMs) return null;
    const finalClaim = claimPathForCleanup(this.path);
    if (!sameClaimedPathIdentity(finalClaim.identity, observedClaim.identity)) return null;
    this.beforeStaleQuarantine(this.path);
    this.requireCurrentClaim(this.cleanupRootClaim, "stale cleanup quarantine");
    const quarantine = this.cleanupPath("stale", randomBytes(12).toString("hex"));
    try {
      renameSync(this.path, quarantine);
    } catch {
      // Another contender or the live owner changed the lock first; retry normal acquisition.
      return null;
    }
    const claim = claimPathForCleanup(quarantine);
    if (!sameClaimedPathIdentity(claim.identity, finalClaim.identity)) {
      this.rejectUnsafeClaim(claim);
      throw new Error("cache-root lifecycle stale quarantine changed the final observed lock identity");
    }
    return claim;
  }

  private heartbeat(acquired: HeldLifecycleLock): void {
    if (!this.isOwner(acquired)) return;
    try {
      const now = new Date(this.now());
      utimesSync(this.path, now, now);
    } catch {
      // Losing the path cannot justify deleting another process's replacement lock in release().
    }
  }

  private async release(acquired: HeldLifecycleLock): Promise<void> {
    this.requireOwnedLock(acquired, "release observation");
    this.beforeReleaseClaim(this.path);
    // Token, lock inode/type, and owner inode/type are checked together immediately before the
    // atomic rename. A same-path replacement (even one copying the token bytes) is never claimed.
    this.requireOwnedLock(acquired, "release quarantine");
    this.requireCurrentClaim(this.cleanupRootClaim, "release cleanup quarantine");
    const quarantine = this.cleanupPath("release", acquired.token);
    renameSync(this.path, quarantine);
    const claim = claimPathForCleanup(quarantine);
    if (!sameClaimedPathIdentity(claim.identity, acquired.entryIdentity)) {
      this.rejectUnsafeClaim(claim);
      throw new Error("cache-root lifecycle release quarantine changed the owned lock identity");
    }
    await this.cleanupClaim(claim);
  }

  private quarantineCreatedLock(label: string, created: ClaimedPath): ClaimedPath | null {
    let current: ClaimedPath;
    try {
      current = claimPathForCleanup(this.path);
    } catch (error) {
      if (isErrnoCode(error, "ENOENT")) return null;
      throw error;
    }
    if (!sameClaimedPathIdentity(current.identity, created.identity)) {
      throw new Error("cache-root lifecycle acquisition path was replaced before rollback");
    }
    this.requireCurrentClaim(this.cleanupRootClaim, `${label} cleanup quarantine`);
    const quarantine = this.cleanupPath(label, randomBytes(12).toString("hex"));
    renameSync(this.path, quarantine);
    const claim = claimPathForCleanup(quarantine);
    if (!sameClaimedPathIdentity(claim.identity, created.identity)) {
      this.rejectUnsafeClaim(claim);
      throw new Error("cache-root lifecycle rollback quarantine changed the created lock identity");
    }
    return claim;
  }

  private async cleanupClaim(claim: ClaimedPath): Promise<void> {
    if (activeCleanupClaims.has(claim.path)) return;
    activeCleanupClaims.add(claim.path);
    try {
      await this.beforePhysicalCleanup(Object.freeze([claim.path]));
      await removeClaimedPath(claim);
    } catch (error) {
      let replacement: ClaimedPath | null = null;
      try {
        replacement = claimPathForCleanup(claim.path);
      } catch (inspectionError) {
        if (isErrnoCode(inspectionError, "ENOENT")) {
          // Another process may have atomically re-claimed this residue while physical cleanup
          // was in progress. The old capability is complete once its exact path is absent; the
          // new durable path is owned (or will be rediscovered after restart) by that scanner.
          return;
        }
        throw new AggregateError(
          [error, inspectionError],
          "cache-root lifecycle cleanup and replacement inspection both failed",
        );
      }
      if (replacement && !sameClaimedPathIdentity(replacement.identity, claim.identity)) {
        try {
          this.rejectUnsafeClaim(replacement);
        } catch (rejectionError) {
          throw new AggregateError(
            [error, rejectionError],
            "cache-root lifecycle cleanup and unsafe replacement rejection both failed",
          );
        }
      }
      throw error;
    } finally {
      activeCleanupClaims.delete(claim.path);
    }
  }

  private async cleanupResidueBatch(): Promise<void> {
    this.requireCurrentClaim(this.cleanupRootClaim, "residue scan");
    const directory = opendirSync(this.cleanupRoot);
    const claims: ClaimedPath[] = [];
    try {
      for (let scanned = 0; scanned < MAX_CLEANUP_RESIDUE_BATCH; scanned += 1) {
        const entry = directory.readSync();
        if (entry === null) break;
        if (!CLEANUP_RESIDUE_NAME.test(entry.name)) continue;
        const path = join(this.cleanupRoot, entry.name);
        if (activeCleanupClaims.has(path)) continue;
        try {
          claims.push(claimPathForCleanup(path));
        } catch (error) {
          if (!isErrnoCode(error, "ENOENT")) throw error;
        }
      }
    } finally {
      directory.closeSync();
    }
    if (claims.length > 0) {
      await this.beforeResidueClaim(Object.freeze(claims.map((claim) => claim.path)));
    }
    const errors: unknown[] = [];
    for (const candidate of claims) {
      try {
        const claim = this.reclaimCleanupResidue(candidate);
        if (claim) await this.cleanupClaim(claim);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(errors, "multiple cache-root lifecycle residue cleanups failed");
    }
  }

  private cleanupPath(label: string, suffix: string): string {
    return join(this.cleanupRoot, `${LOCK_DIRECTORY}.${label}-${suffix}`);
  }

  private reclaimCleanupResidue(candidate: ClaimedPath): ClaimedPath | null {
    const destination = this.cleanupPath("residue", randomBytes(12).toString("hex"));
    try {
      renameSync(candidate.path, destination);
    } catch (error) {
      if (isErrnoCode(error, "ENOENT")) return null;
      throw error;
    }
    const claim = claimPathForCleanup(destination);
    if (!sameClaimedPathIdentity(claim.identity, candidate.identity)) {
      this.rejectUnsafeClaim(claim);
      throw new Error("cache-root lifecycle residue changed during atomic re-claim");
    }
    return claim;
  }

  private rejectUnsafeClaim(claim: ClaimedPath): void {
    const rejected = this.cleanupPath("rejected", randomBytes(12).toString("hex"));
    renameSync(claim.path, rejected);
    const moved = claimPathForCleanup(rejected);
    if (!sameClaimedPathIdentity(moved.identity, claim.identity)) {
      throw new Error("cache-root lifecycle rejected quarantine changed identity");
    }
  }

  private requireCurrentClaim(expected: ClaimedPath, phase: string): void {
    let current: ClaimedPath;
    try {
      current = claimPathForCleanup(expected.path);
    } catch {
      throw new Error(`cache-root lifecycle lock changed during ${phase}`);
    }
    if (!sameClaimedPathIdentity(current.identity, expected.identity)) {
      throw new Error(`cache-root lifecycle lock changed during ${phase}`);
    }
  }

  private requireOwnedLock(acquired: HeldLifecycleLock, phase: string): void {
    let entry: ClaimedPath;
    let owner: ClaimedPath;
    try {
      entry = claimPathForCleanup(this.path);
      owner = claimPathForCleanup(join(this.path, OWNER_FILE));
    } catch {
      throw new Error(`cache-root lifecycle lock ownership changed before ${phase}`);
    }
    const record = this.readOwner();
    let finalEntry: ClaimedPath;
    let finalOwner: ClaimedPath;
    try {
      finalEntry = claimPathForCleanup(this.path);
      finalOwner = claimPathForCleanup(join(this.path, OWNER_FILE));
    } catch {
      throw new Error(`cache-root lifecycle lock ownership changed before ${phase}`);
    }
    if (!sameClaimedPathIdentity(entry.identity, acquired.entryIdentity)
      || !sameClaimedPathIdentity(owner.identity, acquired.ownerIdentity)
      || !sameClaimedPathIdentity(finalEntry.identity, acquired.entryIdentity)
      || !sameClaimedPathIdentity(finalOwner.identity, acquired.ownerIdentity)
      || record?.token !== acquired.token) {
      throw new Error(`cache-root lifecycle lock ownership changed before ${phase}`);
    }
  }

  private isOwner(acquired: HeldLifecycleLock): boolean {
    try {
      this.requireOwnedLock(acquired, "ownership check");
      return true;
    } catch {
      return false;
    }
  }

  private readOwner(): { token: string; pid?: number; processIdentity?: string } | null {
    try {
      const parsed = JSON.parse(readFileSync(join(this.path, OWNER_FILE), "utf8")) as {
        token?: unknown;
        pid?: unknown;
        processIdentity?: unknown;
      };
      if (typeof parsed.token !== "string") return null;
      return {
        token: parsed.token,
        ...(Number.isSafeInteger(parsed.pid) && (parsed.pid as number) > 0
          ? { pid: parsed.pid as number }
          : {}),
        ...(typeof parsed.processIdentity === "string" && parsed.processIdentity.length > 0
          ? { processIdentity: parsed.processIdentity }
          : {}),
      };
    } catch {
      return null;
    }
  }
}

function activeLockKey(path: string, token: string): string {
  return `${path}\0${token}`;
}

function positiveDuration(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError("cache-root lifecycle lock duration must be a positive safe integer");
  }
  return value;
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

function isErrnoCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && (error as { code?: unknown }).code === code;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

export function resolveProcessIdentity(pid: number): string | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  if (process.platform === "linux") {
    try {
      const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const afterCommand = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/);
      const startTicks = afterCommand[19]; // field 22; this array begins at field 3.
      return bootId && startTicks ? `linux:${bootId}:${startTicks}` : null;
    } catch {
      return null;
    }
  }
  if (process.platform === "darwin") {
    try {
      const started = execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], {
        encoding: "utf8",
        timeout: 1_000,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      return started ? `darwin:${started}` : null;
    } catch {
      return null;
    }
  }
  return null;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  if (signal.reason !== undefined) throw signal.reason;
  const error = new Error("cache-root lifecycle lock acquisition aborted");
  error.name = "AbortError";
  throw error;
}

function abortableDelay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolveDelay, rejectDelay) => {
    const timeout = setTimeout(finish, ms);
    const onAbort = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      try {
        throwIfAborted(signal);
      } catch (error) {
        rejectDelay(error);
      }
    };
    function finish() {
      signal?.removeEventListener("abort", onAbort);
      resolveDelay();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

async function settle(operation: Promise<void>): Promise<unknown | null> {
  try {
    await operation;
    return null;
  } catch (error) {
    return error;
  }
}
