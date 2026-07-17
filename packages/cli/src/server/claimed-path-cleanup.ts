/**
 * Identity-bound, asynchronous removal for paths already claimed into a private quarantine.
 *
 * Callers must atomically rename an entry into their quarantine while holding the relevant
 * lifecycle lock, then capture the returned claim before releasing admission. Removal never
 * follows a symbolic link and revalidates the claimed inode and type before every destructive
 * operation. Recursive filesystem work uses promise-based APIs so a large tree cannot monopolize
 * the Node event loop.
 */

import { constants, lstatSync, mkdtempSync, renameSync, type BigIntStats } from "node:fs";
import {
  lstat,
  open,
  opendir,
  rmdir,
  unlink,
} from "node:fs/promises";
import { dirname, join } from "node:path";

const DIRECTORY_READ_BUFFER_SIZE = 32;

export type ClaimedPathKind = "directory" | "file" | "symlink" | "other";

export interface ClaimedPathIdentity {
  readonly dev: string;
  readonly ino: string;
  readonly kind: ClaimedPathKind;
}

export interface ClaimedPath {
  readonly path: string;
  readonly identity: ClaimedPathIdentity;
}

export interface MoveClaimedPathOptions {
  readonly source: string;
  readonly expected: ClaimedPath;
  readonly destination: string;
  /** Non-scannable preservation path used only if an external race changes the moved inode. */
  readonly rejected: string;
  readonly label: string;
  /** Test seam after the atomic rename and before destination identity is claimed. */
  readonly afterRename?: (destination: string) => void;
}

export interface RemoveClaimedPathHooks {
  /** Adversarial seam after validation and before the exact inode is claimed privately. */
  readonly beforePrivateClaim?: (path: string) => void;
  /** Adversarial seam after the exact inode is private and the public quarantine name is free. */
  readonly afterPrivateClaim?: (claim: ClaimedPath) => void;
}

/** Capture the inode and entry type immediately after an atomic quarantine rename. */
export function claimPathForCleanup(path: string): ClaimedPath {
  return Object.freeze({
    path,
    identity: identityFor(lstatSync(path, { bigint: true })),
  });
}

/**
 * Verify that a claim still names the same entry. Missing entries are treated as already removed;
 * a path reused for another inode is an invariant violation and is never touched.
 */
export async function claimedPathIsCurrent(claim: ClaimedPath): Promise<boolean> {
  const current = await readIdentity(claim.path);
  if (current === null) return false;
  if (!sameClaimedPathIdentity(current, claim.identity)) {
    throw new Error(`quarantine cleanup claim was replaced: ${claim.path}`);
  }
  return true;
}

/** Remove one exact claimed tree without following symlinks. */
export async function removeClaimedPath(
  claim: ClaimedPath,
  signal?: AbortSignal,
  hooks: RemoveClaimedPathHooks = {},
): Promise<void> {
  throwIfAborted(signal);
  if (!await claimedPathIsCurrent(claim)) return;
  hooks.beforePrivateClaim?.(claim.path);
  throwIfAborted(signal);

  // Node does not expose unlinkat(2). Move the exact validated inode into a newly created 0700
  // namespace first, and perform every path-based unlink/rmdir only beneath that private claim.
  // A replacement of the public quarantine name before/during the rename is either left in place
  // or moved to the rejected slot by moveClaimedPath; it is never passed to unlink/rmdir.
  const removalRoot = mkdtempSync(join(dirname(claim.path), ".meridian-removal-"));
  const removalRootClaim = claimPathForCleanup(removalRoot);
  const privateClaim = moveClaimedPath({
    source: claim.path,
    expected: claim,
    destination: join(removalRoot, "claimed"),
    rejected: join(removalRoot, "rejected-replacement"),
    label: "quarantine cleanup claim",
  });
  hooks.afterPrivateClaim?.(privateClaim);
  throwIfAborted(signal);
  await removeExactEntry(privateClaim.path, privateClaim.identity, signal);
  await removeExactEntry(removalRootClaim.path, removalRootClaim.identity, signal);
}

export function sameClaimedPathIdentity(
  left: ClaimedPathIdentity,
  right: ClaimedPathIdentity,
): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.kind === right.kind;
}

/**
 * Move one exact inode under a caller-held ownership lock, then prove the destination still names
 * that inode. A raced replacement is preserved outside cleanup scanning and is never deleted.
 */
export function moveClaimedPath(options: MoveClaimedPathOptions): ClaimedPath {
  if (options.expected.path !== options.source
    || options.destination === options.source
    || options.rejected === options.source
    || options.rejected === options.destination) {
    throw new Error(`${options.label} cleanup move is invalid`);
  }
  const before = claimPathForCleanup(options.source);
  if (!sameClaimedPathIdentity(before.identity, options.expected.identity)) {
    throw new Error(`${options.label} changed before quarantine`);
  }
  renameSync(options.source, options.destination);
  options.afterRename?.(options.destination);
  const moved = claimPathForCleanup(options.destination);
  if (sameClaimedPathIdentity(moved.identity, options.expected.identity)) return moved;
  try {
    renameSync(options.destination, options.rejected);
    const preserved = claimPathForCleanup(options.rejected);
    if (!sameClaimedPathIdentity(preserved.identity, moved.identity)) {
      throw new Error(`${options.label} replacement changed while being preserved`);
    }
  } catch (error) {
    throw new AggregateError(
      [new Error(`${options.label} changed during quarantine`), error],
      `${options.label} mismatch could not be preserved`,
    );
  }
  throw new Error(`${options.label} changed during quarantine and was preserved`);
}

function identityFor(stats: BigIntStats): ClaimedPathIdentity {
  return Object.freeze({
    dev: stats.dev.toString(),
    ino: stats.ino.toString(),
    kind: stats.isSymbolicLink()
      ? "symlink"
      : stats.isDirectory()
        ? "directory"
        : stats.isFile()
          ? "file"
          : "other",
  });
}

async function readIdentity(path: string): Promise<ClaimedPathIdentity | null> {
  try {
    return identityFor(await lstat(path, { bigint: true }));
  } catch (error) {
    if (isErrnoCode(error, "ENOENT")) return null;
    throw error;
  }
}

async function requireCurrent(path: string, expected: ClaimedPathIdentity): Promise<void> {
  const current = await readIdentity(path);
  if (current === null || !sameClaimedPathIdentity(current, expected)) {
    throw new Error(`quarantine cleanup claim changed during removal: ${path}`);
  }
}

async function removeExactEntry(
  path: string,
  identity: ClaimedPathIdentity,
  signal: AbortSignal | undefined,
): Promise<void> {
  throwIfAborted(signal);
  await requireCurrent(path, identity);
  if (identity.kind !== "directory") {
    // unlink removes the link itself. It does not dereference a symbolic link.
    await requireCurrent(path, identity);
    throwIfAborted(signal);
    await unlink(path);
    return;
  }

  // Descriptor directories are published read-only. Change mode through an O_NOFOLLOW file
  // descriptor so a concurrent path replacement cannot redirect chmod outside quarantine.
  const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
  const directoryOnly = "O_DIRECTORY" in constants ? constants.O_DIRECTORY : 0;
  const handle = await open(path, constants.O_RDONLY | noFollow | directoryOnly);
  try {
    const opened = identityFor(await handle.stat({ bigint: true }));
    if (!sameClaimedPathIdentity(opened, identity)) {
      throw new Error(`quarantine cleanup claim changed before directory open: ${path}`);
    }
    await handle.chmod(0o700);
  } finally {
    await handle.close();
  }

  // Keep wide directories bounded as well as deep ones. `opendir` exposes a cursor backed by a
  // fixed-size native buffer instead of allocating every sibling name at once. Yield after each
  // buffer so a very wide checkout cannot monopolize the event loop during finalization.
  const directory = await opendir(path, { bufferSize: DIRECTORY_READ_BUFFER_SIZE });
  let entriesSinceYield = 0;
  for await (const entry of directory) {
    throwIfAborted(signal);
    // Directory iteration is read-only, but child access is path-based. Revalidate before using
    // each returned name so a directory replaced by a symlink cannot redirect traversal.
    await requireCurrent(path, identity);
    const childPath = join(path, entry.name);
    const childIdentity = await readIdentity(childPath);
    if (childIdentity === null) continue;
    await removeExactEntry(childPath, childIdentity, signal);
    entriesSinceYield += 1;
    if (entriesSinceYield === DIRECTORY_READ_BUFFER_SIZE) {
      entriesSinceYield = 0;
      await yieldToEventLoop();
    }
  }
  await requireCurrent(path, identity);
  throwIfAborted(signal);
  await rmdir(path);
}

async function yieldToEventLoop(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function isErrnoCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && (error as { code?: unknown }).code === code;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  if (signal.reason !== undefined) throw signal.reason;
  const error = new Error("quarantine cleanup aborted");
  error.name = "AbortError";
  throw error;
}
