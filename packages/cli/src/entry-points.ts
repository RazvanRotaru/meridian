/**
 * Resolving a project's declared application entry point(s) to SOURCE module node ids.
 *
 * Extractors are pure graph producers (ADR 0001), so entry-point discovery — which is
 * metadata ABOUT the artifact, not part of the graph — lives here in the CLI. We read the
 * `main`/`module`/`exports` fields from every `package.json`, which point at BUILD output
 * (`./out/main/main.js`), then map that back to the matching source module the extractor
 * actually emitted (`.../src/main.ts`). The renderer floats these to the top of its entry
 * picker so the true app entry is pinned ahead of any name heuristic.
 */

import { readdirSync, readFileSync } from "node:fs";
import { basename, extname, join, relative, resolve, sep } from "node:path";
import type { GraphNode, JsonValue, NodeId } from "@meridian/core";

/** Directories that only ever hold build output or vendored deps — never a source entry. */
const IGNORED_DIRS = new Set(["node_modules", "dist", "out", "build", "coverage", ".git", ".next", ".turbo"]);

/** package.json fields that name an entry, in the order we trust them. */
const ENTRY_FIELDS = ["main", "module"] as const;

interface PackageEntry {
  /** Absolute directory containing the package.json. */
  dir: string;
  /** Declared entry as a raw path (build-output-ish), e.g. `./out/main/main.js`. */
  entryPath: string;
}

/**
 * Best-first source module ids for the repo's declared entry points; `[]` when nothing
 * resolves. Never throws — a repo with no `main` field is a valid, common case.
 */
export function resolveEntryModules(rootDir: string, moduleNodes: GraphNode[]): NodeId[] {
  const resolved: NodeId[] = [];
  for (const pkg of findPackageEntries(rootDir)) {
    const entryBase = entryBasename(pkg.entryPath);
    const node = pickSourceModule(rootDir, pkg.dir, entryBase, moduleNodes);
    if (node) {
      resolved.push(node.id);
    }
  }
  return sortBestFirst(dedupe(resolved), moduleNodes);
}

/** Walk `rootDir` (skipping build/vendor dirs) collecting each package.json's declared entry. */
function findPackageEntries(rootDir: string): PackageEntry[] {
  const entries: PackageEntry[] = [];
  walk(rootDir, (dir) => {
    const entryPath = readEntryPath(join(dir, "package.json"));
    if (entryPath) {
      entries.push({ dir, entryPath });
    }
  });
  return entries;
}

/** Depth-first directory walk; `visit` is called once per directory (root included). */
function walk(dir: string, visit: (dir: string) => void): void {
  visit(dir);
  let children: import("node:fs").Dirent[];
  try {
    children = readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // unreadable dir: skip rather than fail the whole scan
  }
  for (const child of children) {
    // isDirectory() is false for symlinks, so we never follow them into a loop.
    if (child.isDirectory() && !IGNORED_DIRS.has(child.name)) {
      walk(join(dir, child.name), visit);
    }
  }
}

/** First trusted entry path from a package.json, or undefined if none/unreadable. */
function readEntryPath(packageJsonPath: string): string | undefined {
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(readFileSync(packageJsonPath, "utf8")) as Record<string, unknown>;
  } catch {
    return undefined; // absent or malformed: this dir simply declares no entry
  }
  for (const field of ENTRY_FIELDS) {
    if (typeof pkg[field] === "string") {
      return pkg[field] as string;
    }
  }
  return entryFromExports(pkg.exports);
}

/** Extract the "." entry from an `exports` map (string, or import/default/node object). */
function entryFromExports(exports: unknown): string | undefined {
  if (typeof exports === "string") {
    return exports;
  }
  if (!isRecord(exports)) {
    return undefined;
  }
  const dot = "." in exports ? exports["."] : exports;
  return firstStringValue(dot);
}

/** Depth-first search for the first string in a (possibly nested) exports condition value. */
function firstStringValue(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  for (const nested of Object.values(value)) {
    const found = firstStringValue(nested);
    if (found) {
      return found;
    }
  }
  return undefined;
}

/** `./out/main/main.js` -> `main`; `dist/index.js` -> `index`. */
function entryBasename(entryPath: string): string {
  const base = basename(entryPath);
  return base.slice(0, base.length - extname(base).length) || base;
}

/**
 * The source module inside `pkgDir` whose file basename matches the entry, preferring a
 * `src/` location, then the shortest path, then lexicographic — a deterministic pick.
 */
function pickSourceModule(rootDir: string, pkgDir: string, entryBase: string, moduleNodes: GraphNode[]): GraphNode | undefined {
  const candidates = moduleNodes.filter(
    (node) => isInside(pkgDir, resolve(rootDir, node.location.file)) && moduleBasename(node) === entryBase,
  );
  return candidates.sort((a, b) => compareCandidates(rootDir, pkgDir, a, b))[0];
}

function moduleBasename(node: GraphNode): string {
  return entryBasename(node.location.file);
}

/** src/-first, then fewest path segments, then lexicographic — total order for stable picks. */
function compareCandidates(rootDir: string, pkgDir: string, a: GraphNode, b: GraphNode): number {
  const srcRank = Number(hasSrcSegment(pkgDir, resolve(rootDir, b.location.file))) - Number(hasSrcSegment(pkgDir, resolve(rootDir, a.location.file)));
  if (srcRank !== 0) {
    return srcRank;
  }
  return compareByDepthThenName(a.location.file, b.location.file);
}

/** Final ordering: shallower resolved paths first (app entries), then lexicographic. */
function sortBestFirst(ids: NodeId[], moduleNodes: GraphNode[]): NodeId[] {
  const fileById = new Map(moduleNodes.map((node) => [node.id, node.location.file] as const));
  return [...ids].sort((a, b) => compareByDepthThenName(fileById.get(a) ?? a, fileById.get(b) ?? b));
}

function compareByDepthThenName(a: string, b: string): number {
  const depth = segmentCount(a) - segmentCount(b);
  return depth !== 0 ? depth : a.localeCompare(b);
}

function isInside(dir: string, file: string): boolean {
  const rel = relative(dir, file);
  return rel.length > 0 && !rel.startsWith("..") && !rel.startsWith(sep);
}

function hasSrcSegment(pkgDir: string, file: string): boolean {
  return relative(pkgDir, file).split(sep).includes("src");
}

function segmentCount(file: string): number {
  return file.split(/[\\/]/).length;
}

function dedupe(ids: NodeId[]): NodeId[] {
  return [...new Set(ids)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Convenience for the header builder: entryModules as a JSON extension value, or `null` if empty. */
export function entryModulesExtension(rootDir: string, moduleNodes: GraphNode[]): JsonValue | null {
  const ids = resolveEntryModules(rootDir, moduleNodes);
  return ids.length > 0 ? (ids as JsonValue) : null;
}
