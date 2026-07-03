/**
 * LOAD step: build a ts-morph `Project` (tsconfig-first, glob fallback) and select the
 * source files that belong to this extraction — under the root, no declarations, no
 * dependencies, honoring the exclude globs.
 */

import { isAbsolute } from "node:path";
import { Project, type SourceFile } from "ts-morph";
import type { ExtractOptions } from "@meridian/core";
import { DEFAULT_EXCLUDES, isExcluded } from "./glob";
import { absoluteRoot, relativeToRoot, isUnderRoot } from "./paths";

export interface LoadedProject {
  sourceFiles: SourceFile[];
  relativePathOf: (file: SourceFile) => string;
}

export function loadProject(options: ExtractOptions): LoadedProject {
  const root = absoluteRoot(options.root);
  const excludes = options.exclude ?? DEFAULT_EXCLUDES;
  const relativePathOf = (file: SourceFile) => relativeToRoot(root, file.getFilePath());
  const select = (project: Project) =>
    project.getSourceFiles().filter((file) => isSelectable(file, relativePathOf(file), excludes));

  if (options.project) {
    const fromConfig = select(fromTsConfig(options.project));
    // A solution-style tsconfig ("files": [] + references) loads ZERO sources; falling back
    // to the glob scan keeps monorepo roots extractable instead of writing an empty graph.
    if (fromConfig.length > 0) {
      return { sourceFiles: fromConfig, relativePathOf };
    }
  }
  return { sourceFiles: select(fromGlobs(root, options.include)), relativePathOf };
}

function fromTsConfig(tsConfigFilePath: string): Project {
  return new Project({ tsConfigFilePath });
}

function fromGlobs(root: string, include: string[] | undefined): Project {
  const project = new Project({ compilerOptions: { allowJs: true } });
  project.addSourceFilesAtPaths(include ? anchorToRoot(root, include) : defaultGlobs(root));
  return project;
}

// Include globs are relative to the project root, not the process cwd (ts-morph would
// otherwise resolve them against cwd and silently match nothing).
function anchorToRoot(root: string, include: string[]): string[] {
  return include.map((glob) => (isAbsolute(glob) ? glob : `${root}/${glob}`));
}

// Negations prune the walk itself — descending every node_modules/dist tree of a big
// monorepo just to filter the files out afterwards takes minutes and gigabytes.
function defaultGlobs(root: string): string[] {
  return [
    `${root}/**/*.ts`,
    `${root}/**/*.tsx`,
    `!${root}/**/node_modules/**`,
    `!${root}/**/dist/**`,
    `!${root}/**/build/**`,
    `!${root}/**/.venv/**`,
    `!${root}/**/static/**`,
    `!${root}/**/coverage/**`,
    `!${root}/**/out/**`,
  ];
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
