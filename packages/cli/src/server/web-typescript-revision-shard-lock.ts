import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  futimesSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { OperationCancelledError } from "./web-cancellation";
import { WebError } from "./web-error";

const LOCK_FORMAT_VERSION = 1 as const;
const SHARD_ROOT = "typescript-revision-shards-v1";
const LOCKS_ROOT = "build-locks-v1";
const LOCK_DIRECTORY = "global.lock";
const OWNER_FILE = "owner.json";
const RECOVERY_CLAIM_FILE = "global.recovery.json";
const HOST_FILE = "host-v1.json";
const MAX_METADATA_BYTES = 4 * 1024;
const STALE_LOCK_MS = 15 * 60_000;
const HEARTBEAT_MS = Math.max(10, Math.min(30_000, Math.floor(STALE_LOCK_MS / 3)));
const RETRY_MS = 50;
const PROCESS_STARTED_AT_MS = Math.max(0, Math.floor(performance.timeOrigin));

interface LockOwner {
  formatVersion: typeof LOCK_FORMAT_VERSION;
  host: string;
  nonce: string;
  pid: number;
  processStartedAtMs: number;
}

interface RecoveryClaimOwner extends LockOwner {
  kind: "recovery-claim";
}

interface HostOwner {
  formatVersion: typeof LOCK_FORMAT_VERSION;
  host: string;
}

interface LockTopology {
  lockDirectory: string;
  locksRoot: string;
  recoveryClaim: string;
}

interface PrivateMetadata<Value> {
  device: number;
  inode: number;
  mtimeMs: number;
  rawDigest: string;
  size: number;
  value: Value | null;
}

interface LockSnapshot {
  directoryDevice: number;
  directoryInode: number;
  directoryMtimeMs: number;
  owner: PrivateMetadata<LockOwner> | null;
}

interface ContendedLock {
  disposition: "fresh" | "live-owner" | "recoverable";
  snapshot: LockSnapshot;
}

/** @internal Tight deterministic race seam; production callers never provide it. */
export interface TypeScriptRevisionShardBuildLockTestHooks {
  afterRecoverableObservation?(): void | Promise<void>;
  afterRecoveryClaimEstablished?(): void;
  afterOwnerEstablished?(): void | Promise<void>;
}

export class TypeScriptRevisionShardBuildLockOwnershipLostError extends WebError {
  constructor() {
    super(503, "TypeScript revision-shard build lock ownership was lost");
    this.name = "TypeScriptRevisionShardBuildLockOwnershipLostError";
  }
}

/**
 * Serialize memory-intensive TypeScript shard builds across all Meridian processes using one
 * host-local cache root. The callback receives a signal that is aborted both for caller
 * cancellation and when the filesystem nonce fence is lost.
 */
export async function withTypeScriptRevisionShardBuildLock<Result>(
  cacheRootInput: string,
  sourceSignal: AbortSignal | undefined,
  work: (signal: AbortSignal) => Result | Promise<Result>,
  testHooks?: TypeScriptRevisionShardBuildLockTestHooks,
): Promise<Result> {
  return (await withBuildLock(cacheRootInput, sourceSignal, work, false, testHooks))!;
}

/** Attempt one background maintenance operation without ever queueing behind an active build. */
export async function tryWithTypeScriptRevisionShardBuildLock<Result>(
  cacheRootInput: string,
  sourceSignal: AbortSignal | undefined,
  work: (signal: AbortSignal) => Result | Promise<Result>,
): Promise<Result | undefined> {
  return withBuildLock(cacheRootInput, sourceSignal, work, true);
}

async function withBuildLock<Result>(
  cacheRootInput: string,
  sourceSignal: AbortSignal | undefined,
  work: (signal: AbortSignal) => Result | Promise<Result>,
  skipIfBusy: boolean,
  testHooks?: TypeScriptRevisionShardBuildLockTestHooks,
): Promise<Result | undefined> {
  throwForSignal(sourceSignal);
  const topology = prepareLockTopology(cacheRootInput);
  const owner = await acquireLock(topology, sourceSignal, skipIfBusy, testHooks);
  if (owner === null) return undefined;
  const workController = new AbortController();
  let ownershipLoss: TypeScriptRevisionShardBuildLockOwnershipLostError | undefined;

  const abortForSource = () => {
    if (!workController.signal.aborted) {
      workController.abort(cancellationReason(sourceSignal));
    }
  };
  const loseOwnership = () => {
    ownershipLoss ??= new TypeScriptRevisionShardBuildLockOwnershipLostError();
    if (!workController.signal.aborted) workController.abort(ownershipLoss);
  };

  sourceSignal?.addEventListener("abort", abortForSource, { once: true });
  if (sourceSignal?.aborted) abortForSource();
  const heartbeat = setInterval(() => {
    if (!renewOwner(topology.lockDirectory, owner)) loseOwnership();
  }, HEARTBEAT_MS);
  heartbeat.unref();

  let result!: Result;
  let workFailed = false;
  let workError: unknown;
  try {
    throwForSignal(workController.signal);
    result = await work(workController.signal);
    throwForSignal(workController.signal);
    if (!renewOwner(topology.lockDirectory, owner)) {
      loseOwnership();
      throw ownershipLoss;
    }
  } catch (error) {
    workFailed = true;
    workError = error;
  } finally {
    clearInterval(heartbeat);
    sourceSignal?.removeEventListener("abort", abortForSource);
  }

  try {
    if (!releaseOwnedLock(topology, owner) && !workFailed) {
      loseOwnership();
      throw ownershipLoss;
    }
  } catch (error) {
    if (!workFailed) throw error;
  }

  if (workFailed) throw workError;
  return result;
}

async function acquireLock(
  topology: LockTopology,
  signal: AbortSignal | undefined,
  skipIfBusy: boolean,
  testHooks?: TypeScriptRevisionShardBuildLockTestHooks,
): Promise<LockOwner | null> {
  const owner: LockOwner = {
    formatVersion: LOCK_FORMAT_VERSION,
    host: hostname(),
    nonce: randomUUID(),
    pid: process.pid,
    processStartedAtMs: PROCESS_STARTED_AT_MS,
  };

  while (true) {
    throwForSignal(signal);
    if (!await waitForRecoveryClaim(topology, signal, skipIfBusy)) return null;

    let created = false;
    try {
      mkdirSync(topology.lockDirectory, { mode: 0o700 });
      created = true;
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }
    if (created) {
      // A process can be suspended after mkdir while a reclaimer quarantines that empty
      // generation. Never clean up by pathname after a failed owner write: that path may already
      // name a replacement generation.
      writeExclusivePrivateJson(join(topology.lockDirectory, OWNER_FILE), owner);
      if (!renewOwner(topology.lockDirectory, owner)) {
        releaseOwnedLock(topology, owner);
        throw new TypeScriptRevisionShardBuildLockOwnershipLostError();
      }
      await testHooks?.afterOwnerEstablished?.();
      let claimState: ReturnType<typeof recoveryClaimState>;
      try {
        claimState = recoveryClaimState(topology);
      } catch (error) {
        if (!releaseOwnedLock(topology, owner)) {
          throw new TypeScriptRevisionShardBuildLockOwnershipLostError();
        }
        throw error;
      }
      if (claimState === "missing") return owner;
      if (!releaseOwnedLock(topology, owner)) {
        throw new TypeScriptRevisionShardBuildLockOwnershipLostError();
      }
      if (skipIfBusy) return null;
      await waitForRecoveryClaim(topology, signal, false);
      continue;
    }

    const state = inspectContendedLock(topology.lockDirectory);
    if (state === "missing") continue;
    if (state.disposition === "recoverable") {
      await testHooks?.afterRecoverableObservation?.();
      const recovered = recoverContendedLock(topology, testHooks);
      if (recovered === "recovered" || recovered === "retry") continue;
      if (recovered === "claim-busy") {
        if (skipIfBusy) return null;
        await waitForRecoveryClaim(topology, signal, false);
        continue;
      }
      if (recovered === "live-owner") {
        throw new WebError(503, "TypeScript revision-shard build owner is unresponsive; retry");
      }
      if (skipIfBusy) return null;
      await abortableDelay(RETRY_MS, signal);
      continue;
    }
    if (skipIfBusy) return null;
    if (state.disposition === "live-owner") {
      throw new WebError(503, "TypeScript revision-shard build owner is unresponsive; retry");
    }
    await abortableDelay(RETRY_MS, signal);
  }
}

function prepareLockTopology(cacheRootInput: string): LockTopology {
  const cacheRoot = resolve(cacheRootInput);
  mkdirSync(cacheRoot, { recursive: true, mode: 0o700 });
  requireRealDirectory(cacheRoot, false);

  const shardRoot = join(cacheRoot, SHARD_ROOT);
  mkdirOnePrivate(shardRoot);
  const locksRoot = join(shardRoot, LOCKS_ROOT);
  mkdirOnePrivate(locksRoot);
  assertHostLocal(locksRoot);
  return {
    lockDirectory: join(locksRoot, LOCK_DIRECTORY),
    locksRoot,
    recoveryClaim: join(locksRoot, RECOVERY_CLAIM_FILE),
  };
}

function assertHostLocal(locksRoot: string): void {
  const marker = join(locksRoot, HOST_FILE);
  const value: HostOwner = {
    formatVersion: LOCK_FORMAT_VERSION,
    host: hostname(),
  };
  const temporary = join(locksRoot, `.${HOST_FILE}.${process.pid}.${randomUUID()}.tmp`);
  writeExclusivePrivateJson(temporary, value);
  try {
    try {
      linkSync(temporary, marker);
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }
  } finally {
    unlinkSync(temporary);
  }

  const stored = readPrivateMetadata(marker, isHostOwner).value;
  if (stored === null || stored.formatVersion !== LOCK_FORMAT_VERSION) {
    throw new Error("TypeScript revision-shard build lock host marker is invalid");
  }
  if (stored.host !== hostname()) {
    throw new Error("TypeScript revision-shard build locks require a host-local cache");
  }
}

function inspectContendedLock(
  lockDirectory: string,
): "missing" | ContendedLock {
  const snapshot = lockSnapshot(lockDirectory);
  if (snapshot === null) return "missing";
  const owner = snapshot.owner?.value ?? null;
  if (owner !== null && owner.host !== hostname()) {
    throw new Error("TypeScript revision-shard build lock belongs to another host");
  }
  const heartbeatMtimeMs = snapshot.owner?.mtimeMs ?? snapshot.directoryMtimeMs;
  if (owner !== null && !processOwnerIsLive(owner)) {
    return { disposition: "recoverable", snapshot };
  }
  if (owner !== null && Date.now() - heartbeatMtimeMs >= STALE_LOCK_MS) {
    // A delayed heartbeat can be caused by a blocked event loop. PID reuse also cannot be
    // distinguished portably, so liveness always wins over age.
    return { disposition: "live-owner", snapshot };
  }
  return {
    disposition: Date.now() - heartbeatMtimeMs < STALE_LOCK_MS ? "fresh" : "recoverable",
    snapshot,
  };
}

function lockSnapshot(lockDirectory: string): LockSnapshot | null {
  let first: Stats;
  try {
    first = requireLockDirectory(lockDirectory);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
  let entries: string[];
  try {
    entries = readdirSync(lockDirectory);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
  if (entries.some((entry) => entry !== OWNER_FILE)) {
    throw new Error("TypeScript revision-shard build lock has unsafe contents");
  }

  let owner: PrivateMetadata<LockOwner> | null;
  try {
    owner = readPrivateMetadata(join(lockDirectory, OWNER_FILE), isLockOwner);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
    owner = null;
  }
  let second: Stats;
  try {
    second = requireLockDirectory(lockDirectory);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
  if (first.dev !== second.dev || first.ino !== second.ino) return null;
  return {
    directoryDevice: second.dev,
    directoryInode: second.ino,
    directoryMtimeMs: second.mtimeMs,
    owner,
  };
}

async function waitForRecoveryClaim(
  topology: LockTopology,
  signal: AbortSignal | undefined,
  skipIfBusy: boolean,
): Promise<boolean> {
  while (true) {
    throwForSignal(signal);
    const state = recoveryClaimState(topology);
    if (state === "missing") return true;
    if (skipIfBusy) return false;
    if (state === "abandoned" || state === "unresponsive") {
      throw new WebError(
        503,
        "TypeScript revision-shard recovery was interrupted; manual cache repair is required",
      );
    }
    await abortableDelay(RETRY_MS, signal);
  }
}

function recoveryClaimState(
  topology: LockTopology,
): "missing" | "active" | "unresponsive" | "abandoned" {
  let metadata: PrivateMetadata<RecoveryClaimOwner>;
  try {
    metadata = readPrivateMetadata(topology.recoveryClaim, isRecoveryClaimOwner);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return "missing";
    throw error;
  }
  const claim = metadata.value;
  if (claim === null) {
    throw new WebError(
      503,
      "TypeScript revision-shard recovery claim is invalid; manual cache repair is required",
    );
  }
  if (claim.host !== hostname()) {
    throw new Error("TypeScript revision-shard recovery claim belongs to another host");
  }
  if (!processOwnerIsLive(claim)) return "abandoned";
  return Date.now() - metadata.mtimeMs >= STALE_LOCK_MS ? "unresponsive" : "active";
}

function recoverContendedLock(
  topology: LockTopology,
  testHooks?: TypeScriptRevisionShardBuildLockTestHooks,
): "recovered" | "retry" | "fresh" | "live-owner" | "claim-busy" {
  const claim: RecoveryClaimOwner = {
    formatVersion: LOCK_FORMAT_VERSION,
    host: hostname(),
    kind: "recovery-claim",
    nonce: randomUUID(),
    pid: process.pid,
    processStartedAtMs: PROCESS_STARTED_AT_MS,
  };
  try {
    writeExclusivePrivateJson(topology.recoveryClaim, claim);
  } catch (error) {
    if (errorCode(error) === "EEXIST") return "claim-busy";
    // A failed create/write/fsync can leave partial evidence. Do not guess whether it is ours.
    throw error;
  }
  const established = readPrivateMetadata(
    topology.recoveryClaim,
    isRecoveryClaimOwner,
  ).value;
  if (!sameRecoveryClaim(established, claim)) {
    throw new WebError(
      503,
      "TypeScript revision-shard recovery claim could not be fenced",
    );
  }
  let releaseClaim = true;
  try {
    testHooks?.afterRecoveryClaimEstablished?.();
    const current = inspectContendedLock(topology.lockDirectory);
    if (current === "missing") return "retry";
    if (current.disposition !== "recoverable") return current.disposition;

    const stale = join(topology.locksRoot, `.stale-${randomUUID()}`);
    try {
      renameSync(topology.lockDirectory, stale);
    } catch (error) {
      if (errorCode(error) === "ENOENT" || errorCode(error) === "EEXIST") return "retry";
      throw error;
    }

    const moved = lockSnapshot(stale);
    if (moved === null || !sameLockSnapshot(moved, current.snapshot)) {
      if (!restoreMovedLock(topology, stale, moved)) {
        releaseClaim = false;
        throw new WebError(
          503,
          "TypeScript revision-shard recovery lost its exact generation; recovery remains fenced",
        );
      }
      return "retry";
    }
    removeLockDirectory(stale);
    return "recovered";
  } finally {
    if (releaseClaim && !releaseOwnedRecoveryClaim(topology, claim)) {
      throw new WebError(
        503,
        "TypeScript revision-shard recovery claim ownership was lost",
      );
    }
  }
}

function restoreMovedLock(
  topology: LockTopology,
  stale: string,
  moved: LockSnapshot | null,
): boolean {
  if (moved === null) return false;
  try {
    lstatSync(topology.lockDirectory);
    return false;
  } catch (error) {
    if (errorCode(error) !== "ENOENT") return false;
  }
  try {
    renameSync(stale, topology.lockDirectory);
  } catch {
    return false;
  }
  const restored = lockSnapshot(topology.lockDirectory);
  return restored !== null && sameLockSnapshot(restored, moved);
}

function sameLockSnapshot(left: LockSnapshot, right: LockSnapshot): boolean {
  return left.directoryDevice === right.directoryDevice
    && left.directoryInode === right.directoryInode
    && samePrivateMetadata(left.owner, right.owner);
}

function samePrivateMetadata(
  left: PrivateMetadata<LockOwner> | null,
  right: PrivateMetadata<LockOwner> | null,
): boolean {
  return left === null
    ? right === null
    : right !== null
      && left.device === right.device
      && left.inode === right.inode
      && left.mtimeMs === right.mtimeMs
      && left.rawDigest === right.rawDigest
      && left.size === right.size;
}

function releaseOwnedRecoveryClaim(
  topology: LockTopology,
  expected: RecoveryClaimOwner,
): boolean {
  let current: RecoveryClaimOwner | null;
  try {
    current = readPrivateMetadata(
      topology.recoveryClaim,
      isRecoveryClaimOwner,
    ).value;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
  if (!sameRecoveryClaim(current, expected)) return false;
  try {
    unlinkSync(topology.recoveryClaim);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
}

function renewOwner(lockDirectory: string, expected: LockOwner): boolean {
  let descriptor: number | undefined;
  try {
    requireLockDirectory(lockDirectory);
    descriptor = openSync(
      join(lockDirectory, OWNER_FILE),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    const entry = fstatSync(descriptor);
    requirePrivateRegularFile(entry);
    if (entry.size < 1 || entry.size > MAX_METADATA_BYTES) return false;
    const current = parseMetadata(readFileSync(descriptor, "utf8"), isLockOwner);
    if (!sameOwner(current, expected)) return false;
    const now = new Date();
    futimesSync(descriptor, now, now);
    return true;
  } catch {
    return false;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function releaseOwnedLock(topology: LockTopology, expected: LockOwner): boolean {
  let current: LockOwner | null;
  try {
    requireLockDirectory(topology.lockDirectory);
    current = readPrivateMetadata(
      join(topology.lockDirectory, OWNER_FILE),
      isLockOwner,
    ).value;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
  if (!sameOwner(current, expected)) return false;

  const released = join(topology.locksRoot, `.released-${randomUUID()}`);
  try {
    renameSync(topology.lockDirectory, released);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
  const movedOwner = readPrivateMetadata(join(released, OWNER_FILE), isLockOwner).value;
  if (!sameOwner(movedOwner, expected)) {
    try {
      renameSync(released, topology.lockDirectory);
    } catch {
      // Do not delete an object whose exact nonce fence cannot be proven.
    }
    throw new TypeScriptRevisionShardBuildLockOwnershipLostError();
  }
  removeLockDirectory(released);
  return true;
}

function mkdirOnePrivate(path: string): void {
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
  }
  requireRealDirectory(path, true);
}

function requireLockDirectory(path: string) {
  return requireRealDirectory(path, true);
}

function requireRealDirectory(path: string, makePrivate: boolean) {
  let entry = lstatSync(path);
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new Error("TypeScript revision-shard build lock path is not a real directory");
  }
  if ((entry.mode & 0o077) !== 0) {
    if (!makePrivate) return entry;
    chmodSync(path, 0o700);
    entry = lstatSync(path);
    if (!entry.isDirectory() || entry.isSymbolicLink() || (entry.mode & 0o077) !== 0) {
      throw new Error("could not make TypeScript revision-shard build lock path private");
    }
  }
  return entry;
}

function writeExclusivePrivateJson(path: string, value: unknown): void {
  const descriptor = openSync(
    path,
    constants.O_WRONLY
      | constants.O_CREAT
      | constants.O_EXCL
      | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(descriptor, `${JSON.stringify(value)}\n`, "utf8");
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function readPrivateMetadata<Value>(
  path: string,
  validate: (value: unknown) => value is Value,
): PrivateMetadata<Value> {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const entry = fstatSync(descriptor);
    requirePrivateRegularFile(entry);
    if (entry.size < 1 || entry.size > MAX_METADATA_BYTES) {
      return {
        device: entry.dev,
        inode: entry.ino,
        mtimeMs: entry.mtimeMs,
        rawDigest: "",
        size: entry.size,
        value: null,
      };
    }
    const input = readFileSync(descriptor, "utf8");
    return {
      device: entry.dev,
      inode: entry.ino,
      mtimeMs: entry.mtimeMs,
      rawDigest: createHash("sha256").update(input).digest("hex"),
      size: entry.size,
      value: parseMetadata(input, validate),
    };
  } finally {
    closeSync(descriptor);
  }
}

function parseMetadata<Value>(
  input: string,
  validate: (value: unknown) => value is Value,
): Value | null {
  try {
    const value: unknown = JSON.parse(input);
    return validate(value) ? value : null;
  } catch {
    return null;
  }
}

function requirePrivateRegularFile(entry: Stats): void {
  if (!entry.isFile() || entry.isSymbolicLink() || (entry.mode & 0o077) !== 0) {
    throw new Error("TypeScript revision-shard build lock metadata is not a private regular file");
  }
}

function removeLockDirectory(path: string): void {
  const entry = lstatSync(path);
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new Error("refusing to remove an unsafe TypeScript revision-shard build lock");
  }
  const entries = readdirSync(path);
  for (const child of entries) {
    if (child !== OWNER_FILE) {
      throw new Error("refusing to remove a TypeScript revision-shard build lock with unsafe contents");
    }
    const childPath = join(path, child);
    const childEntry = lstatSync(childPath);
    if (!childEntry.isFile() || childEntry.isSymbolicLink()) {
      throw new Error("refusing to remove unsafe TypeScript revision-shard build lock metadata");
    }
    unlinkSync(childPath);
  }
  rmdirSync(path);
}

function isLockOwner(value: unknown): value is LockOwner {
  if (!isRecord(value)) return false;
  return exactKeys(value, ["formatVersion", "host", "nonce", "pid", "processStartedAtMs"])
    && value.formatVersion === LOCK_FORMAT_VERSION
    && typeof value.host === "string"
    && value.host.length > 0
    && value.host.length <= 255
    && typeof value.nonce === "string"
    && value.nonce.length > 0
    && value.nonce.length <= 255
    && Number.isSafeInteger(value.pid)
    && (value.pid as number) > 0
    && Number.isSafeInteger(value.processStartedAtMs)
    && (value.processStartedAtMs as number) >= 0;
}

function isRecoveryClaimOwner(value: unknown): value is RecoveryClaimOwner {
  if (!isRecord(value)) return false;
  return exactKeys(
    value,
    ["formatVersion", "host", "kind", "nonce", "pid", "processStartedAtMs"],
  )
    && value.kind === "recovery-claim"
    && isLockOwner({
      formatVersion: value.formatVersion,
      host: value.host,
      nonce: value.nonce,
      pid: value.pid,
      processStartedAtMs: value.processStartedAtMs,
    });
}

function isHostOwner(value: unknown): value is HostOwner {
  if (!isRecord(value)) return false;
  return exactKeys(value, ["formatVersion", "host"])
    && value.formatVersion === LOCK_FORMAT_VERSION
    && typeof value.host === "string"
    && value.host.length > 0
    && value.host.length <= 255;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function sameOwner(
  left: LockOwner | null,
  right: LockOwner,
): boolean {
  return left?.formatVersion === right.formatVersion
    && left.host === right.host
    && left.nonce === right.nonce
    && left.pid === right.pid
    && left.processStartedAtMs === right.processStartedAtMs;
}

function sameRecoveryClaim(
  left: RecoveryClaimOwner | null,
  right: RecoveryClaimOwner,
): boolean {
  return left?.kind === right.kind && sameOwner(left, right);
}

function processOwnerIsLive(owner: Pick<LockOwner, "pid" | "processStartedAtMs">): boolean {
  if (owner.pid === process.pid) {
    return owner.processStartedAtMs === PROCESS_STARTED_AT_MS;
  }
  return processIsLive(owner.pid);
}

function processIsLive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) !== "ESRCH";
  }
}

function throwForSignal(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw cancellationReason(signal);
}

function cancellationReason(signal: AbortSignal | undefined): Error {
  return signal?.reason instanceof Error
    ? signal.reason
    : new OperationCancelledError();
}

function abortableDelay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  throwForSignal(signal);
  return new Promise((resolveDelay, rejectDelay) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolveDelay();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      rejectDelay(cancellationReason(signal));
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;
}
