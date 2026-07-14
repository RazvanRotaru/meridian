/** Load, instrument, and emit one complete TypeScript project into an isolated temp tree. */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { GraphArtifact, SyntheticExecutionManifestEntry } from "@meridian/core";
import { Project, ts } from "ts-morph";
import { SyntheticExecutionError } from "./synthetic-error";
import { instrumentationTransformer } from "./synthetic-instrumentation";
import { callableCandidates, reachableCallableIds } from "./synthetic-reachability";

export interface CompilationResult {
  entryModule: string;
  nodeNames: Record<string, string>;
  warnings: string[];
}

export function compileInstrumentedProject(
  sourceRoot: string,
  outputRoot: string,
  artifact: GraphArtifact,
  scenario: SyntheticExecutionManifestEntry,
): CompilationResult {
  const modulePath = resolveWithin(sourceRoot, scenario.invoke.module);
  if (!existsSync(modulePath)) {
    throw new SyntheticExecutionError("unsupported-scenario", 422, "Synthetic scenario entry module was not found.");
  }
  const project = loadProject(sourceRoot, outputRoot, modulePath);
  const syntaxErrors = [
    ...project.getConfigFileParsingDiagnostics(),
    ...project.getProgram().getSyntacticDiagnostics(),
  ].filter((diagnostic) => diagnostic.getCategory() === ts.DiagnosticCategory.Error);
  if (syntaxErrors.length > 0) {
    throw new SyntheticExecutionError("compile-failed", 422, "TypeScript project has syntax or configuration errors.");
  }

  const reachable = reachableCallableIds(artifact, scenario.rootId);
  const instrumented = new Set<string>();
  let emitted;
  try {
    emitted = project.emitToMemory({
      customTransformers: {
        before: [instrumentationTransformer(sourceRoot, callableCandidates(artifact, reachable), instrumented)],
      },
    });
  } catch {
    throw new SyntheticExecutionError("compile-failed", 422, "TypeScript instrumentation failed.");
  }
  if (emitted.getEmitSkipped()) {
    throw new SyntheticExecutionError("compile-failed", 422, "TypeScript project could not be emitted.");
  }
  for (const file of emitted.getFiles()) {
    const outputPath = resolve(file.filePath);
    if (!isWithin(outputRoot, outputPath)) {
      throw new SyntheticExecutionError("compile-failed", 422, "TypeScript emit escaped the isolated output directory.");
    }
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, file.text, "utf8");
  }
  writeFileSync(join(outputRoot, "package.json"), JSON.stringify({ type: "module", private: true }), "utf8");

  if (!instrumented.has(scenario.rootId)) {
    throw new SyntheticExecutionError(
      "unsupported-scenario",
      422,
      "Synthetic scenario root has no supported executable body (constructors and generators are not supported in the POC).",
    );
  }
  const entryModule = emittedModulePath(scenario.invoke.module);
  if (!existsSync(join(outputRoot, entryModule))) {
    throw new SyntheticExecutionError("compile-failed", 422, "Synthetic scenario entry module was not emitted.");
  }
  return {
    entryModule,
    nodeNames: Object.fromEntries(
      artifact.nodes.filter((node) => instrumented.has(node.id)).map((node) => [node.id, node.qualifiedName]),
    ),
    warnings: [...reachable]
      .filter((id) => !instrumented.has(id) && id !== scenario.rootId)
      .slice(0, 128)
      .map((id) => `Static callable was not instrumented: ${artifact.nodes.find((node) => node.id === id)?.qualifiedName ?? id}`),
  };
}

function loadProject(sourceRoot: string, outputRoot: string, modulePath: string): Project {
  const tsconfig = nearestTsConfig(sourceRoot, modulePath);
  const compilerOptions: ts.CompilerOptions = {
    rootDir: sourceRoot,
    outDir: outputRoot,
    module: ts.ModuleKind.ESNext,
    noEmit: false,
    noEmitOnError: false,
    declaration: false,
    declarationMap: false,
    sourceMap: false,
    inlineSourceMap: false,
    inlineSources: false,
    incremental: false,
    composite: false,
  };
  try {
    const project = tsconfig !== null
      ? new Project({ tsConfigFilePath: tsconfig, compilerOptions })
      : new Project({ compilerOptions: { ...compilerOptions, target: ts.ScriptTarget.ES2022 } });
    if (tsconfig === null) {
      project.addSourceFilesAtPaths([
        `${sourceRoot}/**/*.ts`,
        `${sourceRoot}/**/*.tsx`,
        `!${sourceRoot}/**/*.d.ts`,
        `!${sourceRoot}/**/node_modules/**`,
        `!${sourceRoot}/**/{dist,build,out,coverage}/**`,
      ]);
    }
    if (!project.getSourceFile(modulePath)) project.addSourceFileAtPath(modulePath);
    return project;
  } catch {
    throw new SyntheticExecutionError("compile-failed", 422, "TypeScript project could not be loaded for synthetic execution.");
  }
}

function nearestTsConfig(sourceRoot: string, modulePath: string): string | null {
  const root = resolve(sourceRoot);
  let current = dirname(resolve(modulePath));
  while (isWithin(root, current)) {
    const candidate = join(current, "tsconfig.json");
    if (existsSync(candidate)) return candidate;
    if (current === root) break;
    current = dirname(current);
  }
  return null;
}

function resolveWithin(root: string, path: string): string {
  const candidate = resolve(root, path);
  if (!isWithin(root, candidate)) {
    throw new SyntheticExecutionError("invalid-manifest", 400, "Synthetic scenario module escapes the source root.");
  }
  return candidate;
}

function isWithin(root: string, candidate: string): boolean {
  const relativePath = relative(resolve(root), resolve(candidate));
  return relativePath === "" || (!relativePath.startsWith(`..${sep}`) && relativePath !== ".." && !isAbsolute(relativePath));
}

function emittedModulePath(modulePath: string): string {
  const normalized = modulePath.replaceAll("\\", "/");
  const extension = extname(normalized).toLowerCase();
  const emittedExtension = extension === ".mts" ? ".mjs" : extension === ".cts" ? ".cjs" : ".js";
  return `${normalized.slice(0, -extension.length)}${emittedExtension}`;
}
