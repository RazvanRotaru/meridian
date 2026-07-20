import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

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
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
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
