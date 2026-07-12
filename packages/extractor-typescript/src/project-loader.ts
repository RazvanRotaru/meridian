/**
 * LOAD step: build a ts-morph `Project` (tsconfig-first, glob fallback) and select the
 * source files that belong to this extraction — under the root, no declarations, no
 * dependencies, honoring the exclude globs.
 */

import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { Project, ts, type SourceFile } from "ts-morph";
import type { ExtractOptions } from "@meridian/core";
import { DEFAULT_EXCLUDES, isExcluded } from "./glob";
import { absoluteRoot, relativeToRoot, isUnderRoot } from "./paths";
import { discoverWorkspacePaths } from "./workspace-paths";
import { manifestMemberDirs } from "./workspace-scope";

export interface LoadedProject {
  sourceFiles: SourceFile[];
  relativePathOf: (file: SourceFile) => string;
  /** Absolute extraction root — the structural pass joins package paths onto it to spot package.json. */
  root: string;
  /** Declared member dirs (root-relative), when manifest-driven scope applies — the overview's
   * package boundaries. Undefined for a plain package, where any package.json dir is a boundary. */
  memberPaths?: ReadonlySet<string>;
}

export function loadProject(options: ExtractOptions): LoadedProject {
  const root = absoluteRoot(options.root);
  const excludes = options.exclude ?? DEFAULT_EXCLUDES;
  const relativePathOf = (file: SourceFile) => relativeToRoot(root, file.getFilePath());
  const select = (project: Project) =>
    project.getSourceFiles().filter((file) => isSelectable(file, relativePathOf(file), excludes));

  // Manifest-driven scope: extract exactly the member projects the repo declares (solution-tsconfig
  // `references` + package.json `workspaces`), which are ALSO the overview's npm-package boundaries.
  // Skipped for an explicit `--include` (the author's own scope).
  // Member dirs come from manifest paths (relative to the tsconfig / package.json); canonicalize
  // them the same way as `root` (realpath) so globbed file paths and `relativeToRoot` line up even
  // when the caller passed an un-realpathed root (e.g. a `/var` → `/private/var` symlink on macOS).
  const rawMembers = options.include ? null : manifestMemberDirs(root, options.project);
  const memberDirs = rawMembers ? rawMembers.map(absoluteRoot) : null;
  if (memberDirs) {
    const globs = memberDirs.flatMap((dir) => [`${dir}/**/*.ts`, `${dir}/**/*.tsx`]);
    const memberPaths = new Set(memberDirs.map((dir) => relativeToRoot(root, dir)));
    return { sourceFiles: select(fromGlobs(root, globs)), relativePathOf, root, memberPaths };
  }

  if (options.project) {
    const fromConfig = select(fromTsConfig(options.project));
    // A solution-style tsconfig with no usable references loads ZERO sources; fall back to the glob
    // scan so a monorepo root stays extractable instead of writing an empty graph.
    if (fromConfig.length > 0) {
      return { sourceFiles: fromConfig, relativePathOf, root };
    }
  }
  return { sourceFiles: select(fromGlobs(root, options.include)), relativePathOf, root };
}

function fromTsConfig(tsConfigFilePath: string): Project {
  return new Project({ tsConfigFilePath });
}

// No explicit tsconfig: load by glob, but seed ts-morph with the workspace's own package
// aliases so cross-package `@scope/pkg` imports resolve to source (not built node_modules
// `.d.ts`), giving the same in-project graph a tsconfig would. Single-package repos discover
// no aliases and keep the original plain-glob behaviour.
function fromGlobs(root: string, include: string[] | undefined): Project {
  const project = new Project({ compilerOptions: globCompilerOptions(root) });
  project.addSourceFilesAtPaths(include ? anchorToRoot(root, include) : defaultGlobs(root));
  return project;
}

function globCompilerOptions(root: string): ts.CompilerOptions {
  const { baseUrl, paths } = discoverWorkspacePaths(root);
  if (Object.keys(paths).length === 0) {
    return { allowJs: true };
  }
  return { allowJs: true, baseUrl, paths, moduleResolution: ts.ModuleResolutionKind.NodeJs };
}

/**
 * Per-package mode: load ONE workspace unit into its own project. A package-local tsconfig supplies
 * its aliases/compiler options, but files are still added only from the bounded unit globs; we do
 * not synthesize whole-workspace aliases here. Cross-package imports remain pending for the join.
 * Paths stay relative to the WORKSPACE root, so node ids match whole-program extraction.
 */
export function loadUnitProject(
  root: string,
  unit: { dir: string; include: string[]; exclude: string[] },
  options: ExtractOptions,
  memberPaths?: ReadonlySet<string>,
): LoadedProject {
  const project = unitProject(root, unit.dir);
  const excludes = [...(options.exclude ?? DEFAULT_EXCLUDES), ...unit.exclude];
  // Feed the excludes to the globber as NEGATIONS, not just a post-filter: otherwise ts-morph
  // parses every matched file (node_modules, dist, and — for the rest unit — sibling packages)
  // into this project before we drop them, which is the whole-workspace memory blow-up the
  // per-package mode exists to avoid. isSelectable still runs as a cheap safety net.
  project.addSourceFilesAtPaths([...anchorToRoot(root, unit.include), ...negations(root, excludes)]);
  const relativePathOf = (file: SourceFile) => relativeToRoot(root, file.getFilePath());
  const sourceFiles = project.getSourceFiles().filter((file) => isSelectable(file, relativePathOf(file), excludes));
  // memberPaths (manifest mode) makes the structural pass tag exactly the declared members as
  // package boundaries; undefined (scan fallback) tags by package.json presence, as before.
  return memberPaths ? { sourceFiles, relativePathOf, root, memberPaths } : { sourceFiles, relativePathOf, root };
}

function unitProject(root: string, unitDir: string): Project {
  const unitConfig = join(root, unitDir, "tsconfig.json");
  const rootConfig = join(root, "tsconfig.json");
  const tsConfigFilePath = existsSync(unitConfig) ? unitConfig : existsSync(rootConfig) ? rootConfig : null;
  if (tsConfigFilePath === null) {
    return new Project({ compilerOptions: { allowJs: true } });
  }
  // Read compiler options only. Source ownership remains the unit globs below, and skipping the
  // tsconfig file-add phase also skips ts-morph's recursive dependency loading. Package config
  // wins; otherwise a root/shared config still supplies aliases to every bounded unit.
  return new Project({ tsConfigFilePath, skipAddingFilesFromTsConfig: true });
}

// Exclude globs as anchored `!` negations. Bare patterns (`**/node_modules/**`) anchor under
// root; already-anchored ones are passed through — fast-glob needs one consistent base.
function negations(root: string, excludes: string[]): string[] {
  return excludes.map((glob) => `!${isAbsolute(glob) ? glob : `${root}/${glob}`}`);
}

// Include globs are relative to the project root, not the process cwd (ts-morph would
// otherwise resolve them against cwd and silently match nothing).
function anchorToRoot(root: string, include: string[]): string[] {
  return include.map((glob) => (isAbsolute(glob) ? glob : `${root}/${glob}`));
}

function defaultGlobs(root: string): string[] {
  return [`${root}/**/*.ts`, `${root}/**/*.tsx`];
}

function isSelectable(file: SourceFile, relativePath: string, excludes: string[]): boolean {
  if (!isUnderRoot(relativePath) || file.getFilePath().includes("/node_modules/")) {
    return false;
  }
  if (file.isDeclarationFile()) {
    return false;
  }
  return !isExcluded(relativePath, excludes);
}
