/**
 * The Python `LanguageExtractor`: detect a Python tree, run the stdlib ast analyzer, then map
 * its modules/nodes/edges onto the `@meridian/core` graph model. A pure graph producer; the
 * CLI writes the artifact header. The node-id language tag is `py`; the artifact tag `python`.
 */

import { existsSync, readdirSync, type Dirent } from "node:fs";
import { join } from "node:path";
import type {
  DetectionResult,
  ExtractOptions,
  ExtractionDiagnostic,
  ExtractionResult,
  LanguageExtractor,
  LanguageTag,
} from "@meridian/core";
import { runPythonAnalyzer } from "./analyzer";
import { buildNodes } from "./nodes";
import { buildEdges, type EdgeResult } from "./edges";
import { buildStats } from "./stats";
import type { AnalyzeOutput } from "./types";

const MAX_DETECT_DEPTH = 5;
const DETECT_SKIP_DIRS = new Set(["__pycache__", "node_modules", "site-packages", "venv", "worktrees", "dist", "build", "out"]);

export class PythonExtractor implements LanguageExtractor {
  readonly language: LanguageTag = "python";
  readonly displayName = "Python (ast)";
  readonly extensions = [".py"];

  async detect(root: string): Promise<DetectionResult> {
    return detectPython(root);
  }

  async extract(options: ExtractOptions): Promise<ExtractionResult> {
    return runExtraction(options);
  }
}

export function createPythonExtractor(): PythonExtractor {
  return new PythonExtractor();
}

function detectPython(root: string): DetectionResult {
  if (existsSync(join(root, "pyproject.toml")) || existsSync(join(root, "setup.py"))) {
    return { matches: true, confidence: 0.9, reason: "found pyproject.toml/setup.py" };
  }
  if (containsPythonFile(root, MAX_DETECT_DEPTH)) {
    return { matches: true, confidence: 0.6, reason: "found a .py file" };
  }
  return { matches: false, confidence: 0, reason: "no .py file or pyproject.toml/setup.py" };
}

function containsPythonFile(directory: string, depth: number): boolean {
  if (depth < 0) return false;
  const entries = readEntries(directory);
  if (entries.some((entry) => entry.isFile() && entry.name.endsWith(".py"))) return true;
  return entries.some(
    (entry) =>
      entry.isDirectory() &&
      !DETECT_SKIP_DIRS.has(entry.name) &&
      !entry.name.startsWith(".") &&
      containsPythonFile(join(directory, entry.name), depth - 1),
  );
}

function readEntries(directory: string): Dirent[] {
  try {
    return readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
}

function runExtraction(options: ExtractOptions): ExtractionResult {
  const output = runPythonAnalyzer(options);
  const index = buildNodes(output);
  const built = buildEdges(output, index, options);
  const stats = buildStats({
    files: output.modules.length,
    nodes: built.nodes,
    edges: built.edges,
    externalCallsDropped: built.externalCallsDropped,
    unresolvedCalls: built.unresolvedCalls,
  });
  const diagnostics = diagnosticsOf(output, built);
  if (index.renamed > 0) {
    diagnostics.push({ severity: "warn", message: `${index.renamed} colliding node id(s) disambiguated with ~n ordinals` });
  }
  return { language: "python", nodes: built.nodes, edges: built.edges, stats, diagnostics };
}

function diagnosticsOf(output: AnalyzeOutput, built: EdgeResult): ExtractionDiagnostic[] {
  const diagnostics: ExtractionDiagnostic[] = output.diagnostics.map((message) => ({ severity: "warn", message }));
  if (built.externalCallsDropped > 0) {
    diagnostics.push({ severity: "warn", message: `dropped ${built.externalCallsDropped} external edge(s)` });
  }
  if (built.unresolvedCalls > 0) {
    diagnostics.push({ severity: "warn", message: `${built.unresolvedCalls} unresolved call(s)` });
  }
  return diagnostics;
}
