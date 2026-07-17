import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  claimPathForCleanup,
  sameClaimedPathIdentity,
  type ClaimedPath,
  type ClaimedPathIdentity,
} from "./claimed-path-cleanup";

const QUARANTINE_SEGMENT = /^[a-z][a-z0-9-]{0,31}$/;

export interface CacheQuarantineDescriptor {
  /** Scanner-owned namespace, for example `meridian-cleanup` or `meridian-rejected`. */
  readonly namespace: string;
  /** Bounded semantic entry kind within the namespace. */
  readonly kind: string;
  /** Stable sibling path whose basename anchors restart parsing. */
  readonly basePath: string;
  /** Narrow deterministic race seam; production callers omit it. */
  readonly afterRename?: (quarantinePath: string) => void;
}

export interface ParsedCacheQuarantineEntry {
  readonly baseName: string;
  readonly namespace: string;
  readonly kind: string;
  readonly nonce: string;
  readonly identityDigest: string;
}

export function resolveWebCacheRoot(override = process.env.MERIDIAN_CACHE_DIR): string {
  if (override?.trim()) {
    return resolve(override.trim());
  }
  if (process.platform === "win32") {
    return join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "Meridian", "cache");
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Caches", "meridian");
  }
  return join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "meridian");
}

export function createPrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
}

export function createStageDirectory(parent: string): string {
  createPrivateDirectory(parent);
  return mkdtempSync(join(parent, ".stage-"));
}

export function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function writePrivateJson(path: string, value: unknown): void {
  createPrivateDirectory(dirname(path));
  // A process can publish multiple cache records concurrently. A PID-only temporary name lets
  // those writes trample each other before the final atomic rename, so include per-write entropy.
  const temporary = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

/** Publish a complete immutable directory. A racing publisher wins without corrupting either copy. */
export function publishImmutable(stage: string, destination: string): boolean {
  createPrivateDirectory(dirname(destination));
  try {
    renameSync(stage, destination);
    return true;
  } catch (error) {
    if (!existsSync(destination)) {
      throw error;
    }
    removeEntry(stage);
    return false;
  }
}

/**
 * Atomically move one exact cache entry out of its live namespace and capture cleanup authority.
 *
 * This is intentionally only the admission-side half of deletion. Callers release their lock
 * after this returns, then pass the claim to `removeClaimedPath` so recursive filesystem work is
 * asynchronous and cannot follow a same-path replacement.
 */
export function quarantineCacheEntry(
  path: string,
  expected: ClaimedPath,
  descriptor: CacheQuarantineDescriptor,
): ClaimedPath | null {
  if (expected.path !== path) {
    throw new Error(`cache quarantine claim is bound to a different path: ${path}`);
  }
  if (!QUARANTINE_SEGMENT.test(descriptor.namespace)
    || !QUARANTINE_SEGMENT.test(descriptor.kind)
    || dirname(descriptor.basePath) !== dirname(path)) {
    throw new Error("cache quarantine descriptor is invalid");
  }
  const nonce = randomBytes(16).toString("hex");
  const identityDigest = cacheEntryIdentityDigest(expected.identity);
  const quarantine = `${descriptor.basePath}.${descriptor.namespace}-${descriptor.kind}-${nonce}-${identityDigest}`;
  const parsed = parseCacheQuarantineEntryName(basename(quarantine), descriptor.namespace);
  if (!parsed
    || parsed.baseName !== basename(descriptor.basePath)
    || parsed.kind !== descriptor.kind
    || parsed.nonce !== nonce
    || parsed.identityDigest !== identityDigest) {
    throw new Error("cache quarantine path failed round-trip validation");
  }
  let observed: ClaimedPath;
  try {
    observed = claimPathForCleanup(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
  if (!sameClaimedPathIdentity(observed.identity, expected.identity)) {
    throw new Error(`cache entry changed before quarantine: ${path}`);
  }
  renameSync(path, quarantine);
  descriptor.afterRename?.(quarantine);
  let claimed: ClaimedPath;
  try {
    claimed = claimPathForCleanup(quarantine);
  } catch (error) {
    // Once the exact entry has left the live namespace, absence means another cleanup scanner
    // atomically acquired it (or already completed deletion). Either outcome is a successful
    // ownership handoff; only a still-present mismatched inode needs rejection below.
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
  if (!sameClaimedPathIdentity(expected.identity, claimed.identity)) {
    const rejected = `${descriptor.basePath}.meridian-rejected-${descriptor.kind}-${randomBytes(16).toString("hex")}-${cacheEntryIdentityDigest(claimed.identity)}`;
    try {
      renameSync(quarantine, rejected);
    } catch (rejectionError) {
      throw new AggregateError(
        [new Error(`cache entry changed during quarantine: ${path}`), rejectionError],
        "cache quarantine mismatch could not be preserved outside the cleanup namespace",
      );
    }
    throw new Error(`cache entry changed during quarantine and was preserved as rejected: ${path}`);
  }
  return claimed;
}

export function cacheEntryIdentityDigest(identity: ClaimedPathIdentity): string {
  return createHash("sha256").update(JSON.stringify([
    identity.dev,
    identity.ino,
    identity.kind,
  ])).digest("hex");
}

/** Parse a scanner-owned quarantine basename without granting deletion authority by itself. */
export function parseCacheQuarantineEntryName(
  name: string,
  namespace: string,
): ParsedCacheQuarantineEntry | null {
  if (!QUARANTINE_SEGMENT.test(namespace) || basename(name) !== name) return null;
  const escapedNamespace = namespace.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(
    `^(.+)\\.${escapedNamespace}-([a-z][a-z0-9-]{0,31})-([0-9a-f]{32})-([0-9a-f]{64})$`,
  ).exec(name);
  if (!match?.[1] || !match[2] || !match[3] || !match[4]) return null;
  return Object.freeze({
    baseName: match[1],
    namespace,
    kind: match[2],
    nonce: match[3],
    identityDigest: match[4],
  });
}

export function removeEntry(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch (error) {
    // Immutable graph generations are deliberately read-only. Lifecycle GC quarantines them first,
    // then grants only the owner the minimum permissions needed for physical reclamation.
    makeCacheEntryWritable(path);
    try {
      rmSync(path, { recursive: true, force: true });
    } catch {
      throw error;
    }
  }
}

function makeCacheEntryWritable(path: string): void {
  let root;
  try {
    root = lstatSync(path);
  } catch {
    return;
  }
  if (root.isSymbolicLink() || !root.isDirectory()) return;
  chmodSync(path, 0o700);
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) makeCacheEntryWritable(child);
    else if (entry.isFile()) chmodSync(child, 0o600);
  }
}

export function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function touchMetadata(path: string): void {
  try {
    const now = new Date();
    utimesSync(path, now, now);
  } catch {
    // A vanished entry will be treated as a miss by its caller.
  }
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  return String((error as { code?: unknown }).code);
}
