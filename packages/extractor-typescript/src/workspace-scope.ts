/**
 * DETERMINISTIC extraction scope from the repo's OWN manifests.
 *
 * WHY this exists: pointing meridian at a monorepo used to yield three different graphs for the
 * same repo. A root `tsconfig.json` that is *solution-style* (only `references`, `"files": []` — it
 * compiles nothing, it just wires sub-projects together) makes ts-morph load ZERO files → a silent
 * empty graph. A plain glob on the repo instead swallows everything — scripts, build tooling, `dist`,
 * generated bundles — a noisy, sometimes un-parseable tree.
 *
 * The fix: derive the member projects the way the repo itself declares them — the solution
 * tsconfig's `references` and every package.json `workspaces` field (recursively) — and extract
 * exactly those directories. Same repo, same scope, wherever you point (root or subdir). Everything
 * outside a declared member is out of scope by construction, so root-level scripts/tools/QA never
 * enter the graph. Discovery is bounded and deterministic (sorted, no clock/rng).
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { ts } from "ts-morph";

const SKIP_DIRS = new Set(["node_modules", "dist", "build", "out", "coverage", ".git"]);

/**
 * The absolute directory of every member project the repo's manifests declare (sorted), or `null`
 * when the target is a plain single package (no solution tsconfig, no workspaces). This SAME set is
 * both the extraction scope and the overview's package boundaries — so a package.json nested inside a
 * member (e.g. a scaffolding `generator/` under an app) is NOT its own boundary; its files roll up to
 * the declared member that contains it.
 */
export function manifestMemberDirs(root: string, projectPath: string | undefined): string[] | null {
  const roots = discoverMemberRoots(root, projectPath);
  return roots === null ? null : [...roots].sort();
}

/**
 * Absolute `**​/*.ts(x)` globs for every declared member, or `null` for a plain single package — the
 * caller then keeps its ordinary behaviour (explicit tsconfig, or a whole-tree glob).
 */
export function manifestScopeGlobs(root: string, projectPath: string | undefined): string[] | null {
  const dirs = manifestMemberDirs(root, projectPath);
  return dirs === null ? null : dirs.flatMap((dir) => [`${dir}/**/*.ts`, `${dir}/**/*.tsx`]);
}

/** The member directories to extract, or `null` when no manifest declares a multi-project scope. */
function discoverMemberRoots(root: string, projectPath: string | undefined): Set<string> | null {
  const seeds = solutionReferenceDirs(projectPath ?? defaultTsConfig(root));
  const hasWorkspaces = workspacesOf(root).length > 0;
  if (seeds === null && !hasWorkspaces) {
    return null; // plain package — nothing manifest-driven to scope to.
  }
  const members = new Set<string>();
  for (const seed of seeds ?? [root]) {
    expandMember(seed, members, new Set());
  }
  return members;
}

/** A seed dir contributes either its workspace members (recursively) or itself as a leaf project. */
function expandMember(dir: string, members: Set<string>, seen: Set<string>): void {
  if (seen.has(dir) || !dirExists(dir)) {
    return;
  }
  seen.add(dir);
  const workspaces = workspacesOf(dir);
  if (workspaces.length === 0) {
    members.add(dir); // a leaf project: has sources, declares no sub-workspaces.
    return;
  }
  for (const memberDir of resolveWorkspaceGlobs(dir, workspaces)) {
    expandMember(memberDir, members, seen);
  }
}

/**
 * Reference dirs of a solution-style tsconfig (`references` present, no own `files`/`include`), or
 * `null` when the tsconfig is absent or a normal compilable project (honour it as-is upstream).
 */
function solutionReferenceDirs(tsConfigPath: string | undefined): string[] | null {
  if (!tsConfigPath || !existsSync(tsConfigPath)) {
    return null;
  }
  const config = readTsConfig(tsConfigPath);
  const references = Array.isArray(config.references) ? config.references : [];
  if (references.length === 0 || compilesOwnSources(config)) {
    return null;
  }
  const base = dirname(tsConfigPath);
  return references
    .map((ref) => (typeof ref?.path === "string" ? ref.path : null))
    .filter((path): path is string => path !== null)
    .map((path) => referenceDir(base, path));
}

/** A tsconfig that lists its own `files` or `include` brings sources itself — not a pure solution. */
function compilesOwnSources(config: { files?: unknown; include?: unknown }): boolean {
  const files = Array.isArray(config.files) ? config.files : [];
  const include = Array.isArray(config.include) ? config.include : [];
  return files.length > 0 || include.length > 0;
}

/** A reference `path` may point at a tsconfig file or its containing directory — return the dir. */
function referenceDir(base: string, refPath: string): string {
  const absolute = isAbsolute(refPath) ? refPath : resolve(base, refPath);
  return absolute.endsWith(".json") ? dirname(absolute) : absolute;
}

/** The `workspaces` package-name globs declared by a dir's package.json (npm array or pnpm object). */
function workspacesOf(dir: string): string[] {
  const pkg = readPackageJson(dir);
  if (pkg === null) {
    return [];
  }
  if (Array.isArray(pkg.workspaces)) {
    return pkg.workspaces.filter((entry): entry is string => typeof entry === "string");
  }
  const packages = (pkg.workspaces as { packages?: unknown })?.packages;
  return Array.isArray(packages) ? packages.filter((entry): entry is string => typeof entry === "string") : [];
}

/** Resolve workspace globs against their root dir. Literal names hit directly; a trailing `*` lists. */
function resolveWorkspaceGlobs(rootDir: string, globs: string[]): string[] {
  const dirs = new Set<string>();
  for (const glob of globs) {
    for (const dir of resolveOneGlob(rootDir, glob)) {
      dirs.add(dir);
    }
  }
  return [...dirs];
}

function resolveOneGlob(rootDir: string, glob: string): string[] {
  const star = glob.indexOf("*");
  if (star === -1) {
    const dir = join(rootDir, glob);
    return dirExists(dir) ? [dir] : [];
  }
  // Support the common `prefix/*` form: list the parent and keep dirs matching the segment pattern.
  const parent = join(rootDir, glob.slice(0, star).replace(/\/$/, ""));
  const suffix = glob.slice(star + 1);
  return readDirs(parent)
    .filter((name) => suffix === "" || name.endsWith(suffix.replace(/^\//, "")))
    .map((name) => join(parent, name));
}

function defaultTsConfig(root: string): string | undefined {
  const candidate = join(root, "tsconfig.json");
  return existsSync(candidate) ? candidate : undefined;
}

function readTsConfig(path: string): { references?: { path?: string }[]; files?: unknown; include?: unknown } {
  // ts.readConfigFile tolerates comments / trailing commas that plain JSON.parse would reject.
  const parsed = ts.readConfigFile(path, ts.sys.readFile);
  return (parsed.config as { references?: { path?: string }[]; files?: unknown; include?: unknown }) ?? {};
}

function readPackageJson(dir: string): { workspaces?: unknown } | null {
  try {
    return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { workspaces?: unknown };
  } catch {
    return null;
  }
}

function readDirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !SKIP_DIRS.has(entry.name) && !entry.name.startsWith("."))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function dirExists(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
