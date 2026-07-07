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
      entry.name !== "node_modules" &&
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
  const output = runPythonAnalyzer(options.root);
  const index = buildNodes(output);
  const built = buildEdges(output, index, options);
  const { nodes, renamed } = disambiguateIds(built.nodes);
  const stats = buildStats({
    files: output.modules.length,
    nodes,
    edges: built.edges,
    externalCallsDropped: built.externalCallsDropped,
    unresolvedCalls: built.unresolvedCalls,
  });
  const diagnostics = diagnosticsOf(output, built);
  if (renamed > 0) {
    diagnostics.push({ severity: "warn", message: `${renamed} colliding node id(s) disambiguated with ~n ordinals` });
  }
  return { language: "python", nodes, edges: built.edges, stats, diagnostics };
}

/**
 * Same-id collisions (a method defined twice under conditionals, a `chat.py` module beside a
 * `chat/` package) get the grammar's `~n` ordinal, mirroring the TS extractor's disambiguation.
 * The FIRST occurrence keeps the bare id, so edges and parentIds — which reference the bare
 * string — keep resolving; `generate` would otherwise fail closed on a duplicate-id error.
 */
function disambiguateIds(nodes: ExtractionResult["nodes"]): { nodes: ExtractionResult["nodes"]; renamed: number } {
  const seen = new Map<string, number>();
  let renamed = 0;
  const result = nodes.map((node) => {
    const count = seen.get(node.id) ?? 0;
    seen.set(node.id, count + 1);
    if (count === 0) {
      return node;
    }
    renamed += 1;
    return { ...node, id: `${node.id}~${count}` };
  });
  return { nodes: result, renamed };
}

function diagnosticsOf(output: AnalyzeOutput, built: EdgeResult): ExtractionDiagnostic[] {
  const diagnostics: ExtractionDiagnostic[] = output.diagnostics.map((message) => ({ severity: "warn", message }));
  if (built.externalCallsDropped > 0) {
    diagnostics.push({ severity: "warn", message: `dropped ${built.externalCallsDropped} external call edge(s)` });
  }
  if (built.unresolvedCalls > 0) {
    diagnostics.push({ severity: "warn", message: `${built.unresolvedCalls} unresolved call(s)` });
  }
  return diagnostics;
}
