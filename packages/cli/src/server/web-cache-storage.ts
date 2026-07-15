import {
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
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

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
    rmSync(stage, { recursive: true, force: true });
    return false;
  }
}

export function removeEntry(path: string): void {
  rmSync(path, { recursive: true, force: true });
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

/**
 * Destructive maintenance primitive for an operator-controlled exclusive maintenance window.
 * Request handling intentionally never calls it: another Meridian process may own a worktree or
 * serve an immutable snapshot even when this process has no in-memory knowledge of that lease.
 */
export function pruneExpiredCache(root: string, now = Date.now()): void {
  pruneLeaves(join(root, "repositories"), 2, now, ["metadata.json"]);
  pruneLeaves(join(root, "artifacts"), 3, now, ["current.json"]);
  pruneLeaves(join(root, "pr-artifacts"), 6, now, ["current.json"]);
  pruneLeaves(join(root, "pr-base-artifacts"), 6, now, ["current.json"]);
  pruneLeaves(join(root, "pr-exact-lookups"), 6, now, ["current.json"]);
}

function pruneLeaves(base: string, depth: number, now: number, markers: string[]): void {
  for (const leaf of leafDirectories(base, depth)) {
    try {
      const marker = markers.map((name) => join(leaf, name)).find((path) => existsSync(path));
      if (!marker || now - statSync(marker).mtimeMs > CACHE_TTL_MS) {
        removeEntry(leaf);
      }
    } catch {
      removeEntry(leaf);
    }
  }
}

function leafDirectories(base: string, depth: number): string[] {
  if (depth === 0) {
    return [base];
  }
  if (!isPlainDirectory(base)) {
    return [];
  }
  return readdirSync(base).flatMap((name) => {
    const child = join(base, name);
    try {
      return isPlainDirectory(child)
        ? leafDirectories(child, depth - 1)
        : [];
    } catch {
      return [];
    }
  });
}

function isPlainDirectory(path: string): boolean {
  try {
    const entry = lstatSync(path);
    return entry.isDirectory() && !entry.isSymbolicLink();
  } catch {
    return false;
  }
}
