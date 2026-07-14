/**
 * `generate`: source tree -> validated GraphArtifact on disk.
 *
 * The pipeline (select-extractor -> extract -> stamp header -> validate) lives in
 * `extract-pipeline` so `web` can share it; this command adds only the on-disk concerns:
 * writing atomically and reporting. It fails closed — a validation
 * error throws before the write, so a downstream `view` never loads a half-formed graph.
 */

import { resolveAgainst, resolveCwd } from "../paths";
import { readJsonFile, writeJsonAtomic } from "../json-io";
import { analyzeRepository } from "../repository-analysis";
import { Reporter } from "../reporter";
import type { GlobalOptions } from "../reporter";
import { reportGenerate } from "./generate-report";
import { attachIstanbulCoverage } from "../istanbul-coverage";
import { validateOrThrow } from "../validation";

export interface GenerateOptions extends GlobalOptions {
  out: string;
  lang?: string;
  changedSince?: string;
  testCoverage?: string;
}

export async function runGenerate(path: string, options: GenerateOptions): Promise<void> {
  const reporter = new Reporter(options);
  const cwd = resolveCwd(options.cwd);
  const absoluteRoot = resolveAgainst(cwd, path);
  const outPath = resolveAgainst(cwd, options.out);
  const result = await analyzeRepository({
    absoluteRoot,
    cwd,
    language: options.lang,
    changedSince: options.changedSince,
  });
  const validated = options.testCoverage
    ? validateOrThrow(
        attachIstanbulCoverage(
          result.artifact,
          readJsonFile(resolveAgainst(cwd, options.testCoverage)),
          absoluteRoot,
        ),
        "generated artifact with test coverage",
      )
    : { artifact: result.artifact, warnings: [] };
  writeJsonAtomic(outPath, validated.artifact);
  reportGenerate(reporter, {
    extractor: result.extractor,
    depth: "function",
    artifact: validated.artifact,
    extraction: result.extraction,
    warnings: options.testCoverage ? validated.warnings : result.warnings,
    outPath,
  });
}
