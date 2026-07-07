/**
 * The TypeScript `LanguageExtractor`: tsconfig/glob -> structural pass -> id disambiguation
 * -> edge pass -> depth collapse -> stats. A pure graph producer; the CLI writes the
 * artifact header. The node-id language tag is `ts`; the artifact language tag is
 * `typescript`.
 */

import { existsSync, readdirSync, type Dirent } from "node:fs";
import { join } from "node:path";
import type { SourceFile } from "ts-morph";
import type {
  DetectionResult,
  ExtractOptions,
  ExtractionDiagnostic,
  ExtractionResult,
  LanguageExtractor,
  LanguageTag,
} from "@meridian/core";
import type { NodeDescriptor } from "./model";
import { loadProject, type LoadedProject } from "./project-loader";
import { buildStructure } from "./structural-pass";
import { assignFinalIds, buildGraphNodes } from "./finalize-nodes";
import { buildResolutionIndex } from "./resolution-index";
import { collectRawEdges } from "./edge-pass";
import { buildEdges, type EdgeBuildResult } from "./edge-build";
import { collapseToDepth } from "./depth-collapse";
import { buildLogicFlows } from "./flow-pass";
import { buildStats } from "./stats";

const NODE_ID_LANGUAGE = "ts";
const MAX_DETECT_DEPTH = 5;

export class TypeScriptExtractor implements LanguageExtractor {
  readonly language: LanguageTag = "typescript";
  readonly displayName = "TypeScript";
  readonly extensions = [".ts", ".tsx"];

  async detect(root: string): Promise<DetectionResult> {
    return detectTypeScript(root);
  }

  async extract(options: ExtractOptions): Promise<ExtractionResult> {
    return runExtraction(options);
  }
}

// Mirrors the Python extractor's detection: a marker file at root, else a bounded scan for
// sources — so pointing at a subfolder of a project (no tsconfig there) still detects.
function detectTypeScript(root: string): DetectionResult {
  if (existsSync(join(root, "tsconfig.json"))) {
    return { matches: true, confidence: 0.9, reason: "found tsconfig.json" };
  }
  if (containsTypeScriptFile(root, MAX_DETECT_DEPTH)) {
    return { matches: true, confidence: 0.6, reason: "found a .ts/.tsx file" };
  }
  return { matches: false, confidence: 0, reason: "no tsconfig.json or .ts/.tsx file under root" };
}

function containsTypeScriptFile(directory: string, depth: number): boolean {
  if (depth < 0) return false;
  const entries = readEntries(directory);
  if (entries.some((entry) => entry.isFile() && isTypeScriptSource(entry.name))) return true;
  return entries.some(
    (entry) =>
      entry.isDirectory() &&
      entry.name !== "node_modules" &&
      !entry.name.startsWith(".") &&
      containsTypeScriptFile(join(directory, entry.name), depth - 1),
  );
}

function isTypeScriptSource(name: string): boolean {
  return (name.endsWith(".ts") || name.endsWith(".tsx")) && !name.endsWith(".d.ts");
}

function readEntries(directory: string): Dirent[] {
  try {
    return readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
}

export function createTypeScriptExtractor(): TypeScriptExtractor {
  return new TypeScriptExtractor();
}

async function runExtraction(options: ExtractOptions): Promise<ExtractionResult> {
  const loaded = loadProject(options);
  const diagnostics: ExtractionDiagnostic[] = [];
  const { descriptors, moduleByFilePath } = buildStructure(loaded, NODE_ID_LANGUAGE);
  assignFinalIds(descriptors);
  const index = buildResolutionIndex(descriptors);
  const rawEdges = collectRawEdges(loaded, descriptors, index, moduleByFilePath, diagnostics);
  const built = buildEdges(rawEdges, options);
  const collapsed = collapseToDepth(buildGraphNodes(descriptors), built.edges, options.depth ?? "function");
  const keepIds = new Set(collapsed.nodes.map((node) => node.id));
  const flows = buildLogicFlows(descriptors, index, keepIds, moduleSourcesById(loaded, moduleByFilePath));
  appendDropDiagnostics(diagnostics, built);
  const stats = buildStats({
    files: loaded.sourceFiles.length,
    nodes: collapsed.nodes,
    edges: collapsed.edges,
    externalCallsDropped: built.externalCallsDropped,
    unresolvedCalls: built.unresolvedCalls,
  });
  return { language: "typescript", nodes: collapsed.nodes, edges: collapsed.edges, stats, diagnostics, flows };
}

// Key each surviving module's SourceFile by its node id, so the flow pass can chart the
// module's load-time top-level statements. Descriptors carry no SourceFile; we match by path.
function moduleSourcesById(
  loaded: LoadedProject,
  moduleByFilePath: Map<string, NodeDescriptor>,
): Map<string, SourceFile> {
  const byId = new Map<string, SourceFile>();
  for (const sourceFile of loaded.sourceFiles) {
    const moduleNode = moduleByFilePath.get(sourceFile.getFilePath());
    if (moduleNode) {
      byId.set(moduleNode.finalId, sourceFile);
    }
  }
  return byId;
}

function appendDropDiagnostics(diagnostics: ExtractionDiagnostic[], built: EdgeBuildResult): void {
  if (built.externalCallsDropped > 0) {
    diagnostics.push({ severity: "warn", message: `dropped ${built.externalCallsDropped} external call edge(s)` });
  }
  if (built.unresolvedCalls > 0) {
    diagnostics.push({ severity: "warn", message: `${built.unresolvedCalls} unresolved call(s)` });
  }
}
