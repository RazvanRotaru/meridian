/**
 * The TypeScript `LanguageExtractor`: tsconfig/glob -> structural pass -> id disambiguation
 * -> edge pass -> depth collapse -> stats. A pure graph producer; the CLI writes the
 * artifact header. The node-id language tag is `ts`; the artifact language tag is
 * `typescript`.
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
import { loadProject } from "./project-loader";
import { buildStructure } from "./structural-pass";
import { assignFinalIds, buildGraphNodes } from "./finalize-nodes";
import { buildResolutionIndex } from "./resolution-index";
import { collectRawEdges } from "./edge-pass";
import { collectImportEdges } from "./import-pass";
import { buildEdges } from "./edge-build";
import { collapseToDepth } from "./depth-collapse";
import { buildLogicFlows } from "./flow-pass";
import { collectPorts } from "./ports-pass";
import { buildStats } from "./stats";
import {
  NODE_ID_LANGUAGE,
  appendDropDiagnostics,
  moduleIdsByRelPath,
  moduleSourcesById,
  portsWithin,
} from "./extract-common";
import { extractPerPackage } from "./extract-per-package";
import { absoluteRoot } from "./paths";
import { discoverWorkspaceUnits, workspaceFromMemberDirs, type Workspace } from "./workspace-units";
import { manifestMemberDirs } from "./workspace-scope";

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
  const workspace = multiPackageWorkspace(options);
  if (workspace) {
    return extractPerPackage(options, workspace);
  }
  return runSingleProjectExtraction(options);
}

/**
 * Route multi-package workspaces to per-package extraction: one bounded project per package
 * instead of one whole-workspace program, the difference between a flat memory profile and heap
 * exhaustion on a large monorepo. Boundaries come from the repo's declared manifest members when
 * present (the SAME scope the single-project path uses); otherwise from a package.json scan, so
 * manifest-less monorepos still get the memory bound. `null` = stay on the single-project path.
 */
function multiPackageWorkspace(options: ExtractOptions): Workspace | null {
  if (options.project || options.include) {
    return null; // an explicit program definition wins; the caller asked for exactly that scope
  }
  const root = absoluteRoot(options.root);
  const memberDirs = manifestMemberDirs(root, undefined);
  if (memberDirs && memberDirs.length >= 2) {
    return workspaceFromMemberDirs(root, memberDirs);
  }
  const scanned = discoverWorkspaceUnits(root);
  return scanned.units.filter((unit) => unit.name !== null).length >= 2 ? scanned : null;
}

function runSingleProjectExtraction(options: ExtractOptions): ExtractionResult {
  const loaded = loadProject(options);
  const diagnostics: ExtractionDiagnostic[] = [];
  const { descriptors, moduleByFilePath } = buildStructure(loaded, NODE_ID_LANGUAGE);
  assignFinalIds(descriptors);
  const index = buildResolutionIndex(descriptors);
  const behavioural = collectRawEdges(loaded, descriptors, index, moduleByFilePath, diagnostics);
  const imports = collectImportEdges(loaded, moduleByFilePath);
  const built = buildEdges([...behavioural, ...imports], options);
  const collapsed = collapseToDepth(buildGraphNodes(descriptors), built.edges, options.depth ?? "function");
  const keepIds = new Set(collapsed.nodes.map((node) => node.id));
  const flows = buildLogicFlows(descriptors, index, keepIds, moduleSourcesById(loaded, moduleByFilePath));
  const ports = portsWithin(collectPorts(loaded, index, moduleByFilePath), keepIds, moduleIdsByRelPath(loaded, moduleByFilePath));
  appendDropDiagnostics(diagnostics, built);
  const stats = buildStats({
    files: loaded.sourceFiles.length,
    nodes: collapsed.nodes,
    edges: collapsed.edges,
    externalCallsDropped: built.externalCallsDropped,
    unresolvedCalls: built.unresolvedCalls,
  });
  const result: ExtractionResult = { language: "typescript", nodes: collapsed.nodes, edges: collapsed.edges, stats, diagnostics, flows };
  if (ports.length > 0) {
    result.ports = ports;
  }
  return result;
}
