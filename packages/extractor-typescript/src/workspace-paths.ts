/**
 * Auto-discover a workspace's package aliases so a plain `generate <monorepo>` resolves
 * cross-package imports (`@scope/pkg` -> that package's own source) WITHOUT a hand-written
 * tsconfig. Every package.json under the root contributes a ts `paths` entry mapping its
 * declared `name` (and `name/*`) to its source, exactly like the aliases a monorepo's
 * tsconfig would carry — so the import graph is the same whether or not the caller happens
 * to point at a tsconfig.
 *
 * WHY this exists: without these aliases, ts-morph can only resolve relative imports; bare
 * cross-package specifiers fall back to node_modules (built `.d.ts`, not source) and drop out
 * of the in-project graph. That made the same repo yield wildly different graphs depending on
 * how it was invoked. Discovery is bounded, deterministic (sorted, no clock/rng), and skips
 * node_modules/build output.
 */

import { readFileSync, readdirSync, statSync, type Dirent } from "node:fs";
import { join } from "node:path";
import { relativeToRoot } from "./paths";

const MAX_DEPTH = 6;
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "out", "coverage", ".git"]);
export const ENTRY_CANDIDATES = ["src/index.ts", "src/index.tsx", "index.ts", "index.tsx"];

export interface WorkspacePaths {
  baseUrl: string;
  paths: Record<string, string[]>;
}

/** ts `paths` for every in-project package.json `name` under `root` (empty when none found). */
export function discoverWorkspacePaths(root: string): WorkspacePaths {
  const paths: Record<string, string[]> = {};
  for (const packageDir of findPackageDirs(root).sort()) {
    addPackageAliases(paths, root, packageDir);
  }
  return { baseUrl: root, paths };
}

/** Map a package's declared name to its source: `name` -> entry file, `name/*` -> source dir. */
function addPackageAliases(paths: Record<string, string[]>, root: string, packageDir: string): void {
  const name = readPackageName(packageDir);
  if (name === null) {
    return;
  }
  const entry = firstExisting(packageDir, ENTRY_CANDIDATES);
  const sourceDir = dirExists(join(packageDir, "src")) ? join(packageDir, "src") : packageDir;
  if (entry !== null) {
    paths[name] = [relativeToRoot(root, entry)];
  }
  paths[`${name}/*`] = [`${relativeToRoot(root, sourceDir)}/*`];
}

/** Absolute dirs holding a package.json, bounded and skipping dependency/build trees. */
export function findPackageDirs(root: string): string[] {
  const found: string[] = [];
  walk(root, MAX_DEPTH, found);
  return found;
}

function walk(dir: string, depth: number, found: string[]): void {
  if (depth < 0) {
    return;
  }
  const entries = readEntries(dir);
  if (entries.some((entry) => entry.isFile() && entry.name === "package.json")) {
    found.push(dir);
  }
  for (const entry of entries) {
    if (entry.isDirectory() && !SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".")) {
      walk(join(dir, entry.name), depth - 1, found);
    }
  }
}

export function readPackageName(packageDir: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as { name?: unknown };
    return typeof parsed.name === "string" && parsed.name.length > 0 ? parsed.name : null;
  } catch {
    return null; // an unreadable / malformed package.json simply contributes no alias
  }
}

export function firstExisting(packageDir: string, candidates: string[]): string | null {
  for (const candidate of candidates) {
    const absolute = join(packageDir, candidate);
    if (fileExists(absolute)) {
      return absolute;
    }
  }
  return null;
}

function readEntries(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function fileExists(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function dirExists(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
