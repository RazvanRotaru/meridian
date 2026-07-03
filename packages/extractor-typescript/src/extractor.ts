/**
 * The TypeScript `LanguageExtractor`: tsconfig/glob -> structural pass -> id disambiguation
 * -> edge pass -> depth collapse -> stats. A pure graph producer; the CLI writes the
 * artifact header. The node-id language tag is `ts`; the artifact language tag is
 * `typescript`.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type {
  DetectionResult,
  ExtractOptions,
  ExtractionDiagnostic,
  ExtractionResult,
  LanguageExtractor,
  LanguageTag,
} from "@meridian/core";
import { loadProject } from "./project-loader";
import { buildStructure } from "./structural-pass";
import { assignFinalIds, buildGraphNodes } from "./finalize-nodes";
import { buildResolutionIndex } from "./resolution-index";
import { collectRawEdges } from "./edge-pass";
import { buildEdges, type EdgeBuildResult } from "./edge-build";
import { collapseToDepth } from "./depth-collapse";
import { buildStats } from "./stats";

const NODE_ID_LANGUAGE = "ts";

export class TypeScriptExtractor implements LanguageExtractor {
  readonly language: LanguageTag = "typescript";
  readonly displayName = "TypeScript";
  readonly extensions = [".ts", ".tsx"];

  async detect(root: string): Promise<DetectionResult> {
    const hasTsConfig = existsSync(join(root, "tsconfig.json"));
    return {
      matches: hasTsConfig,
      confidence: hasTsConfig ? 0.9 : 0,
      reason: hasTsConfig ? "found tsconfig.json" : "no tsconfig.json at root",
    };
  }

  async extract(options: ExtractOptions): Promise<ExtractionResult> {
    return runExtraction(options);
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
  appendDropDiagnostics(diagnostics, built);
  const stats = buildStats({
    files: loaded.sourceFiles.length,
    nodes: collapsed.nodes,
    edges: collapsed.edges,
    externalCallsDropped: built.externalCallsDropped,
    unresolvedCalls: built.unresolvedCalls,
  });
  return { language: "typescript", nodes: collapsed.nodes, edges: collapsed.edges, stats, diagnostics };
}

function appendDropDiagnostics(diagnostics: ExtractionDiagnostic[], built: EdgeBuildResult): void {
  if (built.externalCallsDropped > 0) {
    diagnostics.push({ severity: "warn", message: `dropped ${built.externalCallsDropped} external call edge(s)` });
  }
  if (built.unresolvedCalls > 0) {
    diagnostics.push({ severity: "warn", message: `${built.unresolvedCalls} unresolved call(s)` });
  }
}
