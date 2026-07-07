/**
 * LOAD step: build a ts-morph `Project` (tsconfig-first, glob fallback) and select the
 * source files that belong to this extraction — under the root, no declarations, no
 * dependencies, honoring the exclude globs.
 */

import { isAbsolute } from "node:path";
import { Project, ts, type SourceFile } from "ts-morph";
import type { ExtractOptions } from "@meridian/core";
import { DEFAULT_EXCLUDES, isExcluded } from "./glob";
import { absoluteRoot, relativeToRoot, isUnderRoot } from "./paths";
import { discoverWorkspacePaths } from "./workspace-paths";

export interface LoadedProject {
  sourceFiles: SourceFile[];
  relativePathOf: (file: SourceFile) => string;
  /** Absolute extraction root — the structural pass joins package paths onto it to spot package.json. */
  root: string;
}

export function loadProject(options: ExtractOptions): LoadedProject {
  const root = absoluteRoot(options.root);
  const project = options.project ? fromTsConfig(options.project) : fromGlobs(root, options.include);
  const excludes = options.exclude ?? DEFAULT_EXCLUDES;
  const relativePathOf = (file: SourceFile) => relativeToRoot(root, file.getFilePath());
  const sourceFiles = project
    .getSourceFiles()
    .filter((file) => isSelectable(file, relativePathOf(file), excludes));
  return { sourceFiles, relativePathOf, root };
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
