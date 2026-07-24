/**
 * Per-package extraction: the memory-bounded mode for multi-package workspaces. Each unit is
 * loaded into its own short-lived ts-morph project and analyzed with the ordinary passes;
 * only plain data (nodes, raw edges, flows, ports, an export summary) survives the loop, so
 * peak memory is one package's program instead of the whole workspace's. Cross-package
 * references leave the loop as pending refs; the join stitches them against the summaries,
 * and the shared tail (aggregate -> collapse -> ports -> stats) runs once, globally.
 */

import { DEPTH_RANK, rankOfKind } from "@meridian/core";
import type {
  ExtractOptions,
  ExtractionDiagnostic,
  ExtractionDepth,
  ExtractionProgressActivity,
  ExtractionProgressPosition,
  ExtractionResult,
  GraphNode,
  LogicFlows,
  Port,
} from "@meridian/core";
import { joinCrossPackageEdges, type UnitSummary } from "./cross-package-join";
import { buildEdges } from "./edge-build";
import { collectRawEdges, type RawEdge } from "./edge-pass";
import type { NodeDescriptor } from "./model";
import type { CrossPackageResolver } from "./edge-resolve";
import { buildUnitSummary } from "./export-summary";
import {
  NODE_ID_LANGUAGE,
  appendDropDiagnostics,
  moduleIdsByRelPath,
  moduleSourcesById,
  portsWithin,
} from "./extract-common";
import { assignFinalIds, buildGraphNodes } from "./finalize-nodes";
import { buildLogicFlows } from "./flow-pass";
import { collectImportEdges } from "./import-pass";
import { collectValueRefEdges } from "./value-ref-pass";
import { collapseToDepth } from "./depth-collapse";
import { collectPorts } from "./ports-pass";
import { collectPromiseResources } from "./promise-resource-pass";
import { loadUnitProject, type LoadedProject } from "./project-loader";
import { buildResolutionIndex } from "./resolution-index";
import { buildStats } from "./stats";
import { buildStructure } from "./structural-pass";
import {
  deriveImplementedByEdges,
  implementationMembers,
  type ImplementationMember,
} from "./implementation-edges";
import { absoluteRoot, isUnderRoot, relativeToRoot, toPosix } from "./paths";
import { discoverWorkspaceUnits, type Workspace, type WorkspaceUnit } from "./workspace-units";
import { dirname, resolve } from "node:path";
import {
  createExtractionProgressReporter,
  createRelationshipFileProgress,
  type ExtractionProgressReporter,
} from "./progress";

/** Everything a unit contributes once its project has been dropped — plain data only. */
export interface UnitExtraction {
  nodes: GraphNode[];
  rawEdges: RawEdge[];
  implementationMembers: ImplementationMember[];
  flows: LogicFlows;
  ports: Port[];
  summary: UnitSummary;
  diagnostics: ExtractionDiagnostic[];
  files: number;
}

export function extractPerPackage(
  options: ExtractOptions,
  workspace?: Workspace,
): ExtractionResult {
  const progressReporter = createExtractionProgressReporter(options);
  const root = absoluteRoot(options.root);
  const resolved = workspace ?? discoverWorkspaceUnits(root);
  const resolver = createCrossPackageResolver(resolved, root);
  const depth = options.depth ?? "function";
  const units = resolved.units.map((unit, index) => extractUnit(
    unit,
    root,
    options,
    resolver,
    depth,
    resolved.memberPaths,
    { current: index + 1, total: resolved.units.length, path: unit.dir || "." },
    progressReporter,
  ));
  return stitchUnitExtractions(
    units,
    options,
    depth,
    progressReporter === undefined
      ? undefined
      : (phase) => progressReporter({
          language: "typescript",
          phase,
          unit: null,
          sourceFile: null,
        }),
  );
}

/**
 * The rest-of-workspace view handed to each unit's passes: a bare specifier matches a sibling
 * package by name; a relative specifier that escapes the unit is resolved to its target file's
 * workspace-relative base path (extension dropped) so the join can stitch it by path. A
 * relative import staying inside the unit, or one escaping the workspace, resolves normally /
 * is left alone here.
 */
export function createCrossPackageResolver(workspace: Workspace, root: string): CrossPackageResolver {
  return {
    matches: (specifier) => workspace.matchSpecifier(specifier) !== null,
    resolveRelative: (fromFileAbsPath, specifier) => {
      if (!specifier.startsWith(".")) {
        return null;
      }
      const targetAbs = toPosix(resolve(dirname(fromFileAbsPath), specifier));
      return crossUnitFile(workspace, root, fromFileAbsPath, targetAbs);
    },
    resolveFile: (fromFileAbsPath, targetFileAbsPath) =>
      crossUnitFile(workspace, root, fromFileAbsPath, targetFileAbsPath),
  };
}

function crossUnitFile(
  workspace: Workspace,
  root: string,
  fromFileAbsPath: string,
  targetFileAbsPath: string,
): string | null {
  if (toPosix(targetFileAbsPath).includes("/node_modules/")) {
    return null;
  }
  const from = relativeToRoot(root, absoluteRoot(fromFileAbsPath));
  const target = relativeToRoot(root, absoluteRoot(targetFileAbsPath));
  if (!isUnderRoot(from) || !isUnderRoot(target)) {
    return null;
  }
  const sourceUnit = unitContaining(workspace, from);
  const targetUnit = unitContaining(workspace, target);
  return sourceUnit !== null && targetUnit !== null && sourceUnit !== targetUnit ? target : null;
}

function unitContaining(workspace: Workspace, file: string): WorkspaceUnit | null {
  let match: WorkspaceUnit | null = null;
  for (const unit of workspace.units) {
    if ((unit.dir === "" || file.startsWith(`${unit.dir}/`)) && (match === null || unit.dir.length > match.dir.length)) {
      match = unit;
    }
  }
  return match;
}

/** Analyze one unit in isolation; every ts-morph reference dies when this returns. */
function extractUnit(
  unit: WorkspaceUnit,
  root: string,
  options: ExtractOptions,
  resolver: CrossPackageResolver,
  depth: ExtractionDepth,
  memberPaths: ReadonlySet<string> | undefined,
  progressUnit: ExtractionProgressPosition,
  progressReporter: ExtractionProgressReporter | undefined,
): UnitExtraction {
  progressReporter?.({
    language: "typescript",
    phase: "project-load",
    unit: progressUnit,
    sourceFile: null,
  });
  const loaded = loadUnitProject(root, unit, options, memberPaths);
  progressReporter?.({
    language: "typescript",
    phase: "structure",
    unit: progressUnit,
    sourceFile: null,
  });
  return extractLoadedUnit(
    unit,
    loaded,
    options,
    resolver,
    depth,
    progressUnit,
    progressReporter,
  );
}

/** POC seam: consume one already-loaded short-lived project and return only immutable plain data. */
export function extractLoadedUnit(
  unit: WorkspaceUnit,
  loaded: LoadedProject,
  options: ExtractOptions,
  resolver: CrossPackageResolver,
  depth: ExtractionDepth,
  progressUnit?: ExtractionProgressPosition,
  progressReporter?: ExtractionProgressReporter,
): UnitExtraction {
  const diagnostics: ExtractionDiagnostic[] = [];
  const { descriptors, moduleByFilePath } = buildStructure(
    loaded,
    NODE_ID_LANGUAGE,
    progressReporter === undefined || progressUnit === undefined
      ? undefined
      : (sourceFile, current, total) => progressReporter({
          language: "typescript",
          phase: "structure",
          unit: progressUnit,
          sourceFile: { current, total, path: loaded.relativePathOf(sourceFile) },
        }),
  );
  assignFinalIds(descriptors);
  const index = buildResolutionIndex(descriptors, moduleByFilePath, loaded.root);
  if (progressReporter !== undefined && progressUnit !== undefined) {
    progressReporter({
      language: "typescript",
      phase: "relationships",
      unit: progressUnit,
      sourceFile: null,
    });
  }
  const relationshipProgress = (activity: ExtractionProgressActivity) =>
    createRelationshipFileProgress(progressReporter, progressUnit, activity);
  const behavioural = collectRawEdges(
    loaded,
    descriptors,
    index,
    moduleByFilePath,
    diagnostics,
    resolver,
    relationshipProgress("calls-and-types"),
  );
  const imports = collectImportEdges(
    loaded,
    moduleByFilePath,
    index,
    resolver,
    relationshipProgress("imports"),
  );
  const valueRefs = options.valueRefs
    ? collectValueRefEdges(
        loaded,
        index,
        moduleByFilePath,
        diagnostics,
        resolver,
        relationshipProgress("value-references"),
      )
    : [];
  const promiseResources = collectPromiseResources(
    loaded,
    index,
    moduleByFilePath,
    resolver,
    {
      discovery: relationshipProgress("promise-discovery"),
      links: relationshipProgress("promise-links"),
    },
  );
  const keepIds = survivorIdsAtDepth(descriptors, depth);
  const flows = buildLogicFlows(
    descriptors,
    index,
    keepIds,
    moduleSourcesById(loaded, moduleByFilePath),
    promiseResources.flowIds,
    relationshipProgress("logic-flows"),
  );
  const moduleIds = moduleIdsByRelPath(loaded, moduleByFilePath);
  return {
    nodes: [...buildGraphNodes(descriptors), ...promiseResources.nodes],
    rawEdges: [...behavioural, ...imports, ...valueRefs, ...promiseResources.edges],
    implementationMembers: implementationMembers(descriptors),
    flows,
    ports: collectPorts(
      loaded,
      index,
      moduleByFilePath,
      undefined,
      relationshipProgress("ports"),
    ),
    summary: buildUnitSummary(
      unit,
      loaded,
      index,
      moduleIds,
      resolver,
      relationshipProgress("exports"),
    ),
    diagnostics,
    files: loaded.sourceFiles.length,
  };
}

/** Join pending refs across summaries, then run the ordinary global tail of the pipeline. */
export function stitchUnitExtractions(
  units: UnitExtraction[],
  options: ExtractOptions,
  depth: ExtractionDepth,
  onPhase?: (phase: "stitch" | "finalize") => void,
): ExtractionResult {
  onPhase?.("stitch");
  const summaries = units.map((unit) => unit.summary);
  const joined = joinCrossPackageEdges(
    units.flatMap((unit) => unit.rawEdges),
    summaries,
  );
  const nodes = dedupeSharedAncestors(units.flatMap((unit) => unit.nodes));
  const implementedBy = deriveImplementedByEdges(
    joined,
    nodes,
    units.flatMap((unit) => unit.implementationMembers),
  );
  onPhase?.("finalize");
  const built = buildEdges([...joined, ...implementedBy], options);
  const collapsed = collapseToDepth(nodes, built.edges, depth);
  const keepIds = new Set(collapsed.nodes.map((node) => node.id));
  const moduleIds = new Map(summaries.flatMap((summary) => [...summary.moduleIdByRelPath]));
  const ports = portsWithin(
    units.flatMap((unit) => unit.ports),
    keepIds,
    moduleIds,
  );
  const diagnostics = units.flatMap((unit) => unit.diagnostics);
  appendDropDiagnostics(diagnostics, built);
  const stats = buildStats({
    files: units.reduce((total, unit) => total + unit.files, 0),
    nodes: collapsed.nodes,
    edges: collapsed.edges,
    externalCallsDropped: built.externalCallsDropped,
    unresolvedCalls: built.unresolvedCalls,
  });
  const flows = Object.assign({}, ...units.map((unit) => unit.flows)) as LogicFlows;
  const result: ExtractionResult = { language: "typescript", nodes: collapsed.nodes, edges: collapsed.edges, stats, diagnostics, flows };
  if (ports.length > 0) {
    result.ports = ports;
  }
  return result;
}

/**
 * Units that share an ancestor directory each synthesize the same `package` node for it
 * (identically — same id, same fields, same fs-derived tags). Keep the first; parent-before-
 * child order survives because a kept parent always precedes any later unit's children.
 */
function dedupeSharedAncestors(nodes: GraphNode[]): GraphNode[] {
  const seen = new Set<string>();
  return nodes.filter((node) => {
    if (seen.has(node.id)) {
      return false;
    }
    seen.add(node.id);
    return true;
  });
}

/** Which of this unit's nodes survive the depth collapse — a per-node rank test, so it can
 * run per unit (flows need it) and still agree exactly with the global collapse. */
export function survivorIdsAtDepth(descriptors: NodeDescriptor[], depth: ExtractionDepth): Set<string> {
  const maxRank = DEPTH_RANK[depth];
  return new Set(descriptors.filter((descriptor) => rankOfKind(descriptor.kind) <= maxRank).map((descriptor) => descriptor.finalId));
}
