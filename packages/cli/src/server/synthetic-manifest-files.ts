import { readdirSync, realpathSync, statSync } from "node:fs";
import { posix, relative, resolve } from "node:path";
import { SyntheticExecutionError } from "./synthetic-error";

export const SYNTHETIC_MANIFEST_NAME = "meridian.synthetic.json";

const MAX_SCAN_DEPTH = 8;
const MAX_SCANNED_DIRECTORIES = 4_096;
const MAX_MANIFESTS = 64;
const IGNORED_DIRECTORIES = new Set([
  ".git", ".hg", ".svn", ".next", ".cache",
  "node_modules", "dist", "build", "out", "coverage",
]);

export interface SyntheticManifestFile {
  absolutePath: string;
  /** POSIX path relative to the selected source root. */
  logicalPath: string;
  /** POSIX directory relative to the selected source root; empty for the root manifest. */
  logicalDirectory: string;
}

/** Discover repository-owned manifests without following links or walking unbounded trees. */
export function discoverSyntheticManifestFiles(sourceRoot: string): SyntheticManifestFile[] {
  let root: string;
  try {
    root = realpathSync.native(resolve(sourceRoot));
    if (!statSync(root).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new SyntheticExecutionError("invalid-request", 400, "Synthetic execution source root is unavailable.");
  }

  const manifests: SyntheticManifestFile[] = [];
  const pending: Array<{ directory: string; depth: number }> = [{ directory: root, depth: 0 }];
  let scanned = 0;
  try {
    while (pending.length > 0) {
      const current = pending.pop()!;
      scanned += 1;
      if (scanned > MAX_SCANNED_DIRECTORIES) {
        throw new SyntheticExecutionError("invalid-manifest", 400, "Synthetic manifest discovery exceeded its directory limit.");
      }
      const entries = readdirSync(current.directory, { withFileTypes: true })
        .sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        const absolutePath = resolve(current.directory, entry.name);
        if (entry.isFile() && entry.name === SYNTHETIC_MANIFEST_NAME) {
          const logicalPath = normalize(relative(root, absolutePath));
          const logicalDirectory = posix.dirname(logicalPath);
          manifests.push({
            absolutePath,
            logicalPath,
            logicalDirectory: logicalDirectory === "." ? "" : logicalDirectory,
          });
          if (manifests.length > MAX_MANIFESTS) {
            throw new SyntheticExecutionError("invalid-manifest", 400, "Too many synthetic execution manifests were found.");
          }
          continue;
        }
        if (
          entry.isDirectory()
          && current.depth < MAX_SCAN_DEPTH
          && !IGNORED_DIRECTORIES.has(entry.name)
        ) pending.push({ directory: absolutePath, depth: current.depth + 1 });
      }
    }
  } catch (error) {
    if (error instanceof SyntheticExecutionError) throw error;
    throw new SyntheticExecutionError("invalid-manifest", 400, "Synthetic execution manifests could not be discovered.");
  }
  return manifests.sort((left, right) => left.logicalPath.localeCompare(right.logicalPath));
}

function normalize(path: string): string {
  return path.replaceAll("\\", "/");
}
