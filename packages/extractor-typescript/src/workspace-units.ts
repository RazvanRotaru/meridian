/**
 * Workspace partitioning for per-package extraction. A unit is one package's tree, loaded into
 * its own short-lived ts-morph project instead of one whole-workspace program — that is what
 * keeps memory bounded. `matchSpecifier` maps a bare `@scope/pkg[/sub]` import back to the unit
 * that will have analyzed its target (see cross-package-join.ts for the stitch).
 *
 * Two ways to derive units: `workspaceFromMemberDirs` uses the repo's declared manifest members
 * (the same scope the single-project path uses — no rest unit, out-of-member files excluded by
 * design), and `discoverWorkspaceUnits` scans package.json dirs (fallback for manifest-less
 * monorepos, with a rest unit for stray files).
 */

import { join } from "node:path";
import { relativeToRoot, toPosix } from "./paths";
import { dirExists, findPackageDirs, firstExisting, readPackageName, ENTRY_CANDIDATES } from "./workspace-paths";

export interface WorkspaceUnit {
  /** Workspace-root-relative POSIX dir; "" for the root/rest unit. */
  dir: string;
  /** npm package name; null for the rest unit or a nameless package.json. */
  name: string | null;
  /** Root-relative path of the file a bare `name` specifier resolves to, if any. */
  entryFile: string | null;
  /** Root-relative dir that `name/*` subpath specifiers resolve under. */
  sourceDir: string;
  /** Root-relative include globs claiming this unit's files. */
  include: string[];
  /** Root-relative exclude globs carving out nested units. */
  exclude: string[];
}

export interface SpecifierMatch {
  unit: WorkspaceUnit;
  /** Path under the unit's sourceDir, or null when the specifier is the bare package name. */
  subpath: string | null;
}

export interface Workspace {
  units: WorkspaceUnit[];
  matchSpecifier(specifier: string): SpecifierMatch | null;
  /** The declared member dirs (root-relative), when units came from manifests — passed to each
   * unit's project so the structural pass tags exactly these as npm-package boundaries (nested
   * package.jsons roll up). Undefined for the scan fallback, which tags by package.json presence. */
  memberPaths?: ReadonlySet<string>;
}

/**
 * Units from the repo's declared manifest members (absolute dirs from `manifestMemberDirs`).
 * No rest unit — anything outside a declared member is out of scope, matching the single-project
 * path. Member dirs are normalized to POSIX so they line up with the rest of the extractor.
 */
export function workspaceFromMemberDirs(root: string, memberAbsDirs: string[]): Workspace {
  const members = memberAbsDirs
    .map((abs) => ({ abs: toPosix(abs), rel: relativeToRoot(root, toPosix(abs)) }))
    .sort((left, right) => (left.rel < right.rel ? -1 : 1));
  const relDirs = members.map((member) => member.rel);
  const units = members.map((member) => packageUnit(root, member.abs, member.rel, relDirs));
  const memberPaths = new Set(relDirs);
  return { units, matchSpecifier: (specifier) => matchAgainst(units, specifier), memberPaths };
}

export function discoverWorkspaceUnits(root: string): Workspace {
  const packageDirs = findPackageDirs(root)
    .map((abs) => ({ abs, rel: relativeToRoot(root, abs) }))
    .sort((left, right) => (left.rel < right.rel ? -1 : 1));
  const relDirs = packageDirs.map((dir) => dir.rel);
  const units = packageDirs.map((dir) => packageUnit(root, dir.abs, dir.rel, relDirs));
  if (!relDirs.includes("")) {
    units.unshift(restUnit(relDirs));
  }
  return { units, matchSpecifier: (specifier) => matchAgainst(units, specifier) };
}

function packageUnit(root: string, abs: string, rel: string, allDirs: string[]): WorkspaceUnit {
  const sourceAbs = dirExists(join(abs, "src")) ? join(abs, "src") : abs;
  const entryAbs = firstExisting(abs, ENTRY_CANDIDATES);
  return {
    dir: rel,
    name: readPackageName(abs),
    entryFile: entryAbs === null ? null : relativeToRoot(root, entryAbs),
    sourceDir: relativeToRoot(root, sourceAbs),
    include: includeGlobs(rel),
    exclude: nestedDirs(rel, allDirs).map(subtreeGlob),
  };
}

/** The unit for files claimed by no package: everything except the (top-level) package trees. */
function restUnit(allDirs: string[]): WorkspaceUnit {
  const topLevel = allDirs.filter((dir) => !allDirs.some((other) => other !== dir && dir.startsWith(`${other}/`)));
  return {
    dir: "",
    name: null,
    entryFile: null,
    sourceDir: "",
    include: includeGlobs(""),
    exclude: topLevel.map(subtreeGlob),
  };
}

function includeGlobs(dir: string): string[] {
  const prefix = dir === "" ? "" : `${dir}/`;
  return [`${prefix}**/*.ts`, `${prefix}**/*.tsx`];
}

/** Dirs strictly inside `dir` — their trees belong to their own units, not this one. */
function nestedDirs(dir: string, allDirs: string[]): string[] {
  const prefix = dir === "" ? "" : `${dir}/`;
  return allDirs.filter((candidate) => candidate !== dir && candidate.startsWith(prefix));
}

function subtreeGlob(dir: string): string {
  return `${dir}/**`;
}

function matchAgainst(units: WorkspaceUnit[], specifier: string): SpecifierMatch | null {
  for (const unit of units) {
    const match = unit.name === null ? null : matchPackageSpecifier(unit.name, specifier);
    if (match !== null) {
      return { unit, subpath: match.subpath };
    }
  }
  return null;
}

/**
 * How an import specifier relates to a package `name`: the bare name (subpath null), a subpath
 * under it, or no match. The single source of truth for this rule, shared with the join
 * (cross-package-join.ts) so discovery and resolution never drift apart.
 */
export function matchPackageSpecifier(name: string, specifier: string): { subpath: string | null } | null {
  if (specifier === name) {
    return { subpath: null };
  }
  if (specifier.startsWith(`${name}/`)) {
    return { subpath: specifier.slice(name.length + 1) };
  }
  return null;
}
