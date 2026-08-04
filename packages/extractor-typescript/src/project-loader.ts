/**
 * LOAD step: build a ts-morph `Project` (tsconfig-first, glob fallback) and select the
 * source files that belong to this extraction — under the root, no declarations, no
 * dependencies, honoring the exclude globs.
 */

import { existsSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { Project, ts, type ResolutionHostFactory, type SourceFile } from "ts-morph";
import type { ExtractOptions } from "@meridian/core";
import { DEFAULT_EXCLUDES, isExcluded } from "./glob";
import { absoluteRoot, relativeToRoot, isUnderRoot, toPosix } from "./paths";
import { discoverWorkspacePaths } from "./workspace-paths";
import { manifestMemberDirs } from "./workspace-scope";

export interface LoadedProject {
  /** Short-lived compiler owner. It must not escape the extraction/fingerprinting call. */
  project: Project;
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
  const rawMembers = options.include ? null : manifestMemberDirs(root, options.project, options.supplementalFiles);
  const memberDirs = rawMembers ? rawMembers.map(absoluteRoot) : null;
  if (memberDirs) {
    const globs = memberDirs.flatMap((dir) => [`${dir}/**/*.ts`, `${dir}/**/*.tsx`]);
    const memberPaths = new Set(memberDirs.map((dir) => relativeToRoot(root, dir)));
    const project = fromGlobs(root, globs, false, excludes);
    return { project, sourceFiles: select(project), relativePathOf, root, memberPaths };
  }

  if (options.project) {
    const project = fromTsConfig(options.project);
    const fromConfig = select(project);
    // A solution-style tsconfig with no usable references loads ZERO sources; fall back to the glob
    // scan so a monorepo root stays extractable instead of writing an empty graph.
    if (fromConfig.length > 0) {
      return { project, sourceFiles: fromConfig, relativePathOf, root };
    }
  }
  const project = fromGlobs(root, options.include, options.include !== undefined, excludes);
  return { project, sourceFiles: select(project), relativePathOf, root };
}

function fromTsConfig(tsConfigFilePath: string): Project {
  return new Project({ tsConfigFilePath });
}

// No explicit tsconfig: load by glob, but seed ts-morph with the workspace's own package
// aliases so cross-package `@scope/pkg` imports resolve to source (not built node_modules
// `.d.ts`), giving the same in-project graph a tsconfig would. Single-package repos discover
// no aliases and keep the original plain-glob behaviour.
function fromGlobs(
  root: string,
  include: string[] | undefined,
  boundedInclude: boolean,
  excludes: string[],
): Project {
  const selectedFiles = new Set<string>();
  const project = new Project({
    compilerOptions: globCompilerOptions(root),
    ...(boundedInclude ? { resolutionHost: boundedIncludeResolutionHost(root, selectedFiles) } : {}),
  });
  const globs = include ? anchorToRoot(root, include) : defaultGlobs(root);
  if (!boundedInclude) {
    project.addSourceFilesAtPaths(globs);
    return project;
  }

  // Populate the resolution boundary before ts-morph can ask the host to resolve anything. The
  // returned files are reconciled after add so the set ultimately contains exactly the source
  // files that both matched the caller's include and survive the loader's normal selection rules.
  const matchedFiles = project.getFileSystem().globSync(globs);
  for (const filePath of matchedFiles) {
    const canonical = absoluteRoot(filePath);
    if (isSelectablePath(canonical, relativeToRoot(root, canonical), excludes)) {
      selectedFiles.add(canonical);
    }
  }
  const selected = project.addSourceFilesAtPaths(matchedFiles);
  selectedFiles.clear();
  for (const sourceFile of selected) {
    if (isSelectable(sourceFile, relativeToRoot(root, sourceFile.getFilePath()), excludes)) {
      selectedFiles.add(absoluteRoot(sourceFile.getFilePath()));
    }
  }
  return project;
}

/**
 * An explicit include is one bounded compiler program assembled from files that may belong to
 * different nested projects. Resolve each import with its importer's nearest tsconfig, but admit an
 * in-workspace target only when the caller selected that exact file. This keeps partial extraction
 * semantically aligned with the topology selector without letting compiler dependency discovery
 * widen the bounded file set.
 */
function boundedIncludeResolutionHost(
  root: string,
  selectedFiles: ReadonlySet<string>,
): ResolutionHostFactory {
  return (moduleResolutionHost, getCompilerOptions) => {
    const nearestConfigByDirectory = new Map<string, string | null>();
    const optionsByConfig = new Map<string, ts.CompilerOptions | null>();
    return {
      resolveModuleNames(
        moduleNames,
        containingFile,
        _reusedNames,
        redirectedReference,
        _options,
        containingSourceFile,
      ) {
        const importerOptions = nearestCompilerOptions(
          root,
          containingFile,
          nearestConfigByDirectory,
          optionsByConfig,
        );
        return moduleNames.map((specifier, index) => {
          if (importerOptions !== null) {
            const primary = selectedModuleResolution(
              root,
              selectedFiles,
              resolveModuleForImporter(
                specifier,
                index,
                containingFile,
                containingSourceFile,
                importerOptions,
                moduleResolutionHost,
                redirectedReference,
              ),
            );
            if (primary.kind !== "missing") {
              return primary.kind === "selected" ? primary.module : undefined;
            }
          }
          const fallbackOptions = getCompilerOptions();
          const fallback = selectedModuleResolution(
            root,
            selectedFiles,
            resolveModuleForImporter(
              specifier,
              index,
              containingFile,
              containingSourceFile,
              fallbackOptions,
              moduleResolutionHost,
              redirectedReference,
            ),
          );
          return fallback.kind === "selected" ? fallback.module : undefined;
        });
      },
    };
  };
}

function resolveModuleForImporter(
  specifier: string,
  index: number,
  containingFile: string,
  containingSourceFile: ts.SourceFile | undefined,
  compilerOptions: ts.CompilerOptions,
  moduleResolutionHost: ts.ModuleResolutionHost,
  redirectedReference: ts.ResolvedProjectReference | undefined,
): ts.ResolvedModuleFull | undefined {
  const resolutionMode = containingSourceFile === undefined
    ? undefined
    : ts.getModeForResolutionAtIndex(containingSourceFile, index, compilerOptions);
  return ts.resolveModuleName(
    specifier,
    containingFile,
    compilerOptions,
    moduleResolutionHost,
    undefined,
    redirectedReference,
    resolutionMode,
  ).resolvedModule;
}

type SelectedModuleResolution =
  | { kind: "selected"; module: ts.ResolvedModuleFull }
  | { kind: "blocked" }
  | { kind: "missing" };

function selectedModuleResolution(
  root: string,
  selectedFiles: ReadonlySet<string>,
  resolved: ts.ResolvedModuleFull | undefined,
): SelectedModuleResolution {
  if (resolved === undefined) return { kind: "missing" };
  const portable = toPosix(resolved.resolvedFileName);
  const canonical = absoluteRoot(portable);
  if (isWithinRoot(canonical, root)) {
    if (isDeclarationFilePath(canonical)) return { kind: "selected", module: resolved };
    return selectedFiles.has(canonical)
      ? { kind: "selected", module: resolved }
      : { kind: "blocked" };
  }
  if (
    resolved.isExternalLibraryImport
    || portable.includes("/node_modules/")
    || isDeclarationFilePath(portable)
  ) {
    return { kind: "selected", module: resolved };
  }
  return { kind: "blocked" };
}

function nearestCompilerOptions(
  root: string,
  containingFile: string,
  nearestConfigByDirectory: Map<string, string | null>,
  optionsByConfig: Map<string, ts.CompilerOptions | null>,
): ts.CompilerOptions | null {
  const directory = absoluteRoot(dirname(containingFile));
  let configPath = nearestConfigByDirectory.get(directory);
  if (configPath === undefined) {
    const visited: string[] = [];
    let current = directory;
    configPath = null;
    while (isWithinRoot(current, root)) {
      visited.push(current);
      const known = nearestConfigByDirectory.get(current);
      if (known !== undefined) {
        configPath = known;
        break;
      }
      const candidate = join(current, "tsconfig.json");
      if (existsSync(candidate)) {
        configPath = candidate;
        break;
      }
      if (current === root) break;
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
    for (const visitedDirectory of visited) nearestConfigByDirectory.set(visitedDirectory, configPath);
  }
  if (configPath === null) return null;
  const cached = optionsByConfig.get(configPath);
  if (cached !== undefined) return cached;
  const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: () => undefined,
  });
  const options = parsed?.options ?? null;
  optionsByConfig.set(configPath, options);
  return options;
}

function isWithinRoot(path: string, root: string): boolean {
  return path === root || isUnderRoot(relativeToRoot(root, path));
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
  return memberPaths
    ? { project, sourceFiles, relativePathOf, root, memberPaths }
    : { project, sourceFiles, relativePathOf, root };
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
  if (file.isDeclarationFile()) {
    return false;
  }
  return isSelectablePath(file.getFilePath(), relativePath, excludes);
}

function isSelectablePath(filePath: string, relativePath: string, excludes: string[]): boolean {
  if (!isUnderRoot(relativePath) || toPosix(filePath).includes("/node_modules/")) {
    return false;
  }
  if (isDeclarationFilePath(filePath)) return false;
  return !isExcluded(relativePath, excludes);
}

function isDeclarationFilePath(filePath: string): boolean {
  return /\.d\.[cm]?ts$/u.test(toPosix(filePath));
}
