/**
 * `generate`: source tree -> validated GraphArtifact on disk.
 *
 * The pipeline (select-extractor -> extract -> stamp header -> validate) lives in
 * `extract-pipeline` so `web` can share it; this command adds only the on-disk concerns:
 * resolving the tsconfig, writing atomically, and reporting. It fails closed — a validation
 * error throws before the write, so a downstream `view` never loads a half-formed graph.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ExtractOptions } from "@meridian/core";
import { resolveAgainst, resolveCwd } from "../paths";
import { extractToArtifact } from "../extract-pipeline";
import { writeJsonAtomic } from "../json-io";
import { Reporter } from "../reporter";
import type { GlobalOptions } from "../reporter";
import { reportGenerate } from "./generate-report";

export interface GenerateOptions extends GlobalOptions {
  out: string;
  lang?: string;
  depth: ExtractOptions["depth"];
  include?: string[];
  exclude?: string[];
  tsconfig?: string;
  includeExternal?: boolean;
  includeUnresolved?: boolean;
  excludeTests?: boolean;
  valueRefs?: boolean;
  changedSince?: string;
}

export async function runGenerate(path: string, options: GenerateOptions): Promise<void> {
  const reporter = new Reporter(options);
  const cwd = resolveCwd(options.cwd);
  const absoluteRoot = resolveAgainst(cwd, path);
  const outPath = resolveAgainst(cwd, options.out);
  const result = await extractToArtifact({
    absoluteRoot,
    cwd,
    language: options.lang,
    project: resolveTsConfig(absoluteRoot, options.tsconfig, cwd),
    include: options.include,
    exclude: options.exclude,
    depth: options.depth,
    includeExternal: options.includeExternal,
    includeUnresolved: options.includeUnresolved,
    excludeTests: options.excludeTests,
    valueRefs: options.valueRefs,
    changedSince: options.changedSince,
    materializeBoundary: true,
  });
  writeJsonAtomic(outPath, result.artifact);
  reportGenerate(reporter, {
    extractor: result.extractor,
    depth: String(options.depth),
    artifact: result.artifact,
    extraction: result.extraction,
    warnings: result.warnings,
    outPath,
  });
}

function resolveTsConfig(absoluteRoot: string, tsconfig: string | undefined, cwd: string): string | undefined {
  if (tsconfig) {
    return resolveAgainst(cwd, tsconfig);
  }
  const candidate = join(absoluteRoot, "tsconfig.json");
  return existsSync(candidate) ? candidate : undefined;
}
