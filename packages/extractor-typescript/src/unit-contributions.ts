/**
 * Phase-laned, file-ordered plain-data contributions for one TypeScript workspace unit.
 *
 * This is the isolated seam used by the semantic-region POC. The ordinary per-package extractor
 * remains the cold oracle. A cache may replace only the explicitly semantic file lanes below;
 * materialization always replays the cold phase schedule rather than concatenating complete files
 * because edge, call-site, diagnostic, and flow order is part of the serialized artifact.
 *
 * Promise correlation and port correlation remain whole-unit lanes in V1. They are still computed
 * by the canonical passes while the short-lived Project is alive.
 */

import type {
  ExtractOptions,
  ExtractionDepth,
  ExtractionDiagnostic,
  ExtractionProgressActivity,
  ExtractionProgressPosition,
  GraphNode,
  LogicFlows,
  Port,
} from "@meridian/core";
import type { PendingReexport, UnitSummary } from "./cross-package-join";
import {
  collectRawEdgeContributions,
  type RawEdge,
  type RawEdgeFileContribution,
} from "./edge-pass";
import type { CrossPackageResolver } from "./edge-resolve";
import { moduleIdsByRelPath, moduleSourcesById, NODE_ID_LANGUAGE } from "./extract-common";
import type { UnitExtraction } from "./extract-per-package";
import { survivorIdsAtDepth } from "./extraction-depth";
import { buildGraphNodes, assignFinalIds } from "./finalize-nodes";
import { buildLogicFlows } from "./flow-pass";
import { collectImportEdges } from "./import-pass";
import {
  implementationMembers,
  type ImplementationMember,
} from "./implementation-edges";
import { buildUnitSummary } from "./export-summary";
import { collectPorts } from "./ports-pass";
import { collectPromiseResources } from "./promise-resource-pass";
import type { LoadedProject } from "./project-loader";
import {
  createRelationshipFileProgress,
  type ExtractionProgressReporter,
} from "./progress";
import { buildResolutionIndex } from "./resolution-index";
import { buildStructure } from "./structural-pass";
import {
  collectValueRefContributions,
  type ValueRefFileContribution,
} from "./value-ref-pass";
import type { WorkspaceUnit } from "./workspace-units";

export const UNIT_CONTRIBUTION_SET_VERSION = 1 as const;

export interface UnitFileSummaryContributionV1 {
  /** Map insertion order as observed by the cold checker pass. */
  readonly exports: readonly (readonly [string, string])[];
  readonly moduleId: string;
  readonly pendingReexports: readonly PendingReexport[];
}

export interface UnitFileContributionV1 {
  readonly file: string;
  /** Module then declarations, in the structural pass's exact intra-file order. */
  readonly structuralNodes: readonly GraphNode[];
  /** Calls/new/type/JSX/composition relationships for this file. */
  readonly behaviouralEdges: readonly RawEdge[];
  /** Extends/implements relationships; cold extraction emits these after every behavioural file. */
  readonly inheritanceEdges: readonly RawEdge[];
  readonly importEdges: readonly RawEdge[];
  readonly valueReferenceEdges: readonly RawEdge[];
  readonly implementationMembers: readonly ImplementationMember[];
  /** Object insertion order within this file matches descriptor order. */
  readonly flows: readonly (readonly [string, LogicFlows[string]])[];
  readonly diagnostics: {
    readonly behavioural: readonly ExtractionDiagnostic[];
    readonly inheritance: readonly ExtractionDiagnostic[];
    readonly valueReferences: readonly ExtractionDiagnostic[];
  };
  readonly summary: UnitFileSummaryContributionV1;
}

/**
 * The semantic lanes merged per file. `importEdges` is present in the in-memory canonical set, but
 * the semantic-region codec deliberately omits it and target materialization always uses the
 * freshly collected import pass.
 */
export type UnitSemanticFileContributionV1 = Pick<
  UnitFileContributionV1,
  | "file"
  | "behaviouralEdges"
  | "inheritanceEdges"
  | "importEdges"
  | "valueReferenceEdges"
  | "diagnostics"
  | "summary"
>;

export interface UnitContributionSetV1 {
  readonly version: typeof UNIT_CONTRIBUTION_SET_VERSION;
  /** Exact target-program order. Region identity must not use this ordinal. */
  readonly fileOrder: readonly string[];
  /** All synthesized ancestors, in depth/name order, before every module. */
  readonly packageNodes: readonly GraphNode[];
  readonly files: readonly UnitFileContributionV1[];
  /** Whole-unit fixed-point correlation retained as one lane in V1. */
  readonly promiseLane: {
    readonly nodes: readonly GraphNode[];
    readonly edges: readonly RawEdge[];
  };
  /** Direct plus message-dispatch/RPC correlation, in the current three-lane order. */
  readonly portsLane: readonly Port[];
  readonly summary: Pick<UnitSummary, "dir" | "name" | "entryFile" | "sourceDir">;
}

/**
 * Execute the existing canonical passes into V1 contributions. This deliberately does not consult
 * or publish a cache; callers can differential-check it against extractLoadedUnit.
 */
export function extractLoadedUnitContributions(
  unit: WorkspaceUnit,
  loaded: LoadedProject,
  options: ExtractOptions,
  resolver: CrossPackageResolver,
  depth: ExtractionDepth,
  progressUnit?: ExtractionProgressPosition,
  progressReporter?: ExtractionProgressReporter,
  reusedSemanticFiles: ReadonlyMap<string, UnitSemanticFileContributionV1> = new Map(),
): UnitContributionSetV1 {
  const fileOrder = loaded.sourceFiles.map(loaded.relativePathOf);
  requireReusableSemanticFiles(fileOrder, reusedSemanticFiles);
  const selectedFiles = new Set(
    fileOrder.filter((file) => !reusedSemanticFiles.has(file)),
  );
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

  const relationshipContributions = collectRawEdgeContributions(
    loaded,
    descriptors,
    index,
    moduleByFilePath,
    resolver,
    relationshipProgress("calls-and-types"),
    selectedFiles,
  );
  // Imports are the canonical workspace-boundary observation pass. Keep this cheap lane fresh for
  // every target file so a mixed region hit/miss records the same resolver trace as an empty-cache
  // build; cached behavioural/value/export lanes may otherwise omit observations from hit files.
  const imports = collectImportEdges(
    loaded,
    moduleByFilePath,
    index,
    resolver,
    relationshipProgress("imports"),
  );
  const valueReferenceContributions = options.valueRefs
    ? collectValueRefContributions(
        loaded,
        index,
        moduleByFilePath,
        resolver,
        relationshipProgress("value-references"),
        selectedFiles,
      )
    : fileOrder
        .filter((file) => selectedFiles.has(file))
        .map((file): ValueRefFileContribution => ({
          file,
          edges: [],
          diagnostics: [],
        }));
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
  const flows = buildLogicFlows(
    descriptors,
    index,
    survivorIdsAtDepth(descriptors, depth),
    moduleSourcesById(loaded, moduleByFilePath),
    promiseResources.flowIds,
    relationshipProgress("logic-flows"),
  );
  const ports = collectPorts(
    loaded,
    index,
    moduleByFilePath,
    undefined,
    relationshipProgress("ports"),
  );
  const summary = buildUnitSummary(
    unit,
    loaded,
    index,
    moduleIdsByRelPath(loaded, moduleByFilePath),
    resolver,
    relationshipProgress("exports"),
    selectedFiles,
  );
  const semanticFiles = mergeSemanticFileContributions({
    fileOrder,
    reusedSemanticFiles,
    relationshipContributions,
    imports,
    valueReferenceContributions,
    summary,
    moduleIds: moduleIdsByRelPath(loaded, moduleByFilePath),
  });
  const completeSummary: UnitSummary = {
    dir: summary.dir,
    name: summary.name,
    entryFile: summary.entryFile,
    sourceDir: summary.sourceDir,
    exportsByFile: new Map(semanticFiles.map((file) => [
      file.file,
      new Map(file.summary.exports),
    ])),
    moduleIdByRelPath: new Map(semanticFiles.map((file) => [
      file.file,
      file.summary.moduleId,
    ])),
    pendingReexports: semanticFiles.flatMap((file) => file.summary.pendingReexports),
  };

  return createUnitContributionSetV1({
    fileOrder,
    structuralNodes: buildGraphNodes(descriptors),
    relationships: [
      ...semanticFiles.flatMap((file) => file.behaviouralEdges),
      ...semanticFiles.flatMap((file) => file.inheritanceEdges),
    ],
    imports: semanticFiles.flatMap((file) => file.importEdges),
    valueReferences: semanticFiles.flatMap((file) => file.valueReferenceEdges),
    implementationMembers: implementationMembers(descriptors),
    flows,
    ports,
    promiseNodes: promiseResources.nodes,
    promiseEdges: promiseResources.edges,
    diagnostics: {
      behavioural: semanticFiles.map((file) => ({
        file: file.file,
        diagnostics: file.diagnostics.behavioural,
      })),
      inheritance: semanticFiles.map((file) => ({
        file: file.file,
        diagnostics: file.diagnostics.inheritance,
      })),
      valueReferences: semanticFiles.map((file) => ({
        file: file.file,
        diagnostics: file.diagnostics.valueReferences,
      })),
    },
    summary: completeSummary,
  });
}

function mergeSemanticFileContributions(inputs: {
  fileOrder: readonly string[];
  reusedSemanticFiles: ReadonlyMap<string, UnitSemanticFileContributionV1>;
  relationshipContributions: {
    behavioural: readonly RawEdgeFileContribution[];
    inheritance: readonly RawEdgeFileContribution[];
  };
  imports: readonly RawEdge[];
  valueReferenceContributions: readonly ValueRefFileContribution[];
  summary: UnitSummary;
  moduleIds: ReadonlyMap<string, string>;
}): UnitSemanticFileContributionV1[] {
  const behavioural = edgeContributionsByFile(
    inputs.fileOrder,
    inputs.relationshipContributions.behavioural,
    "behavioural",
  );
  const inheritance = edgeContributionsByFile(
    inputs.fileOrder,
    inputs.relationshipContributions.inheritance,
    "inheritance",
  );
  const importEdges = groupByFile(
    inputs.fileOrder,
    inputs.imports,
    (edge) => edge.callSite.file,
    "import edge",
  );
  const valueReferences = edgeContributionsByFile(
    inputs.fileOrder,
    inputs.valueReferenceContributions,
    "value-reference",
  );
  const pendingReexports = groupByFile(
    inputs.fileOrder,
    inputs.summary.pendingReexports,
    (entry) => entry.file,
    "pending re-export",
  );

  return inputs.fileOrder.map((file) => {
    const currentModuleId = inputs.moduleIds.get(file);
    if (currentModuleId === undefined) {
      throw new Error(`current module id is missing selected file: ${file}`);
    }
    const reused = inputs.reusedSemanticFiles.get(file);
    if (reused !== undefined) {
      if (reused.summary.moduleId !== currentModuleId) {
        throw new Error(`reused semantic module id differs from target structure: ${file}`);
      }
      return {
        ...reused,
        importEdges: importEdges.get(file)!,
      };
    }
    const exports = inputs.summary.exportsByFile.get(file);
    if (exports === undefined) {
      throw new Error(`fresh semantic summary is missing selected file: ${file}`);
    }
    const behaviouralFile = behavioural.get(file);
    const inheritanceFile = inheritance.get(file);
    const valueReferenceFile = valueReferences.get(file);
    if (
      behaviouralFile === undefined
      || inheritanceFile === undefined
      || valueReferenceFile === undefined
    ) {
      throw new Error(`fresh semantic passes are missing selected file: ${file}`);
    }
    return {
      file,
      behaviouralEdges: behaviouralFile.edges,
      inheritanceEdges: inheritanceFile.edges,
      importEdges: importEdges.get(file)!,
      valueReferenceEdges: valueReferenceFile.edges,
      diagnostics: {
        behavioural: behaviouralFile.diagnostics,
        inheritance: inheritanceFile.diagnostics,
        valueReferences: valueReferenceFile.diagnostics,
      },
      summary: {
        exports: [...exports],
        moduleId: currentModuleId,
        pendingReexports: pendingReexports.get(file)!,
      },
    };
  });
}

function edgeContributionsByFile<T extends {
  file: string;
  edges: readonly RawEdge[];
  diagnostics: readonly ExtractionDiagnostic[];
}>(
  fileOrder: readonly string[],
  contributions: readonly T[],
  label: string,
): Map<string, T> {
  const selected = new Set(fileOrder);
  const byFile = new Map<string, T>();
  for (const contribution of contributions) {
    if (!selected.has(contribution.file)) {
      throw new Error(`${label} contribution belongs to an unselected file: ${contribution.file}`);
    }
    if (byFile.has(contribution.file)) {
      throw new Error(`duplicate ${label} contribution: ${contribution.file}`);
    }
    byFile.set(contribution.file, contribution);
  }
  return byFile;
}

function requireReusableSemanticFiles(
  fileOrder: readonly string[],
  reused: ReadonlyMap<string, UnitSemanticFileContributionV1>,
): void {
  const selected = new Set(fileOrder);
  for (const [file, contribution] of reused) {
    if (!selected.has(file)) {
      throw new Error(`reused semantic contribution is outside the target unit: ${file}`);
    }
    if (contribution.file !== file) {
      throw new Error(`reused semantic contribution key does not match its file: ${file}`);
    }
  }
}

interface UnitContributionInputs {
  fileOrder: readonly string[];
  structuralNodes: readonly GraphNode[];
  relationships: readonly RawEdge[];
  imports: readonly RawEdge[];
  valueReferences: readonly RawEdge[];
  implementationMembers: readonly ImplementationMember[];
  flows: LogicFlows;
  ports: readonly Port[];
  promiseNodes: readonly GraphNode[];
  promiseEdges: readonly RawEdge[];
  diagnostics: {
    behavioural: readonly FileDiagnosticContribution[];
    inheritance: readonly FileDiagnosticContribution[];
    valueReferences: readonly FileDiagnosticContribution[];
  };
  summary: UnitSummary;
}

interface FileDiagnosticContribution {
  file: string;
  diagnostics: readonly ExtractionDiagnostic[];
}

/** Partition a cold pass result without changing any intra-phase order. */
export function createUnitContributionSetV1(
  input: UnitContributionInputs,
): UnitContributionSetV1 {
  const fileOrder = checkedFileOrder(input.fileOrder);
  const fileSet = new Set(fileOrder);
  const packageNodes = input.structuralNodes.filter((node) => node.kind === "package");
  const structuralNodes = groupByFile(
    fileOrder,
    input.structuralNodes.filter((node) => node.kind !== "package"),
    (node) => node.location.file,
    "structural node",
  );
  const behaviouralEdges = groupByFile(
    fileOrder,
    input.relationships.filter((edge) => !isInheritanceEdge(edge)),
    (edge) => edge.callSite.file,
    "behavioural edge",
  );
  const inheritanceEdges = groupByFile(
    fileOrder,
    input.relationships.filter(isInheritanceEdge),
    (edge) => edge.callSite.file,
    "inheritance edge",
  );
  const importEdges = groupByFile(
    fileOrder,
    input.imports,
    (edge) => edge.callSite.file,
    "import edge",
  );
  const valueReferenceEdges = groupByFile(
    fileOrder,
    input.valueReferences,
    (edge) => edge.callSite.file,
    "value-reference edge",
  );
  const members = groupByFile(
    fileOrder,
    input.implementationMembers,
    (member) => member.callSite.file,
    "implementation member",
  );

  const fileByNodeId = new Map<string, string>();
  for (const node of input.structuralNodes) {
    if (node.kind !== "package") fileByNodeId.set(node.id, node.location.file);
  }
  const flowEntries = groupByFile(
    fileOrder,
    Object.entries(input.flows),
    ([nodeId]) => fileByNodeId.get(nodeId) ?? "",
    "logic flow",
  );
  const pendingReexports = groupByFile(
    fileOrder,
    input.summary.pendingReexports,
    (entry) => entry.file,
    "pending re-export",
  );
  const behaviouralDiagnostics = diagnosticContributionsByFile(
    fileOrder,
    input.diagnostics.behavioural,
    "behavioural diagnostic",
  );
  const inheritanceDiagnostics = diagnosticContributionsByFile(
    fileOrder,
    input.diagnostics.inheritance,
    "inheritance diagnostic",
  );
  const valueReferenceDiagnostics = diagnosticContributionsByFile(
    fileOrder,
    input.diagnostics.valueReferences,
    "value-reference diagnostic",
  );

  const files = fileOrder.map((file): UnitFileContributionV1 => {
    const exports = input.summary.exportsByFile.get(file);
    const moduleId = input.summary.moduleIdByRelPath.get(file);
    if (exports === undefined || moduleId === undefined) {
      throw new Error(`unit summary is missing selected file: ${file}`);
    }
    return {
      file,
      structuralNodes: structuralNodes.get(file)!,
      behaviouralEdges: behaviouralEdges.get(file)!,
      inheritanceEdges: inheritanceEdges.get(file)!,
      importEdges: importEdges.get(file)!,
      valueReferenceEdges: valueReferenceEdges.get(file)!,
      implementationMembers: members.get(file)!,
      flows: flowEntries.get(file)!,
      diagnostics: {
        behavioural: behaviouralDiagnostics.get(file)!,
        inheritance: inheritanceDiagnostics.get(file)!,
        valueReferences: valueReferenceDiagnostics.get(file)!,
      },
      summary: {
        exports: [...exports],
        moduleId,
        pendingReexports: pendingReexports.get(file)!,
      },
    };
  });
  for (const file of input.summary.exportsByFile.keys()) {
    if (!fileSet.has(file)) throw new Error(`unit summary contains an unselected file: ${file}`);
  }
  for (const file of input.summary.moduleIdByRelPath.keys()) {
    if (!fileSet.has(file)) throw new Error(`unit summary contains an unselected module: ${file}`);
  }

  return {
    version: UNIT_CONTRIBUTION_SET_VERSION,
    fileOrder,
    packageNodes,
    files,
    promiseLane: {
      nodes: [...input.promiseNodes],
      edges: [...input.promiseEdges],
    },
    portsLane: [...input.ports],
    summary: {
      dir: input.summary.dir,
      name: input.summary.name,
      entryFile: input.summary.entryFile,
      sourceDir: input.summary.sourceDir,
    },
  };
}

/**
 * Replay the per-package cold schedule exactly. Evaluation/cache order is irrelevant; only the
 * target fileOrder and these explicit phase lanes control materialized array/object order.
 */
export function materializeUnitContributionSetV1(
  contributions: UnitContributionSetV1,
): UnitExtraction {
  if (contributions.version !== UNIT_CONTRIBUTION_SET_VERSION) {
    throw new Error(`unsupported unit contribution set version: ${String(contributions.version)}`);
  }
  const fileOrder = checkedFileOrder(contributions.fileOrder);
  if (contributions.files.length !== fileOrder.length) {
    throw new Error("unit contribution file count does not match fileOrder");
  }
  for (const [index, file] of contributions.files.entries()) {
    if (file.file !== fileOrder[index]) {
      throw new Error(`unit contribution file order mismatch at ${index + 1}`);
    }
  }

  const flows: LogicFlows = {};
  for (const file of contributions.files) {
    for (const [nodeId, steps] of file.flows) {
      if (Object.prototype.hasOwnProperty.call(flows, nodeId)) {
        throw new Error(`duplicate logic flow contribution: ${nodeId}`);
      }
      flows[nodeId] = steps;
    }
  }

  return {
    nodes: [
      ...contributions.packageNodes,
      ...contributions.files.flatMap((file) => file.structuralNodes),
      ...contributions.promiseLane.nodes,
    ],
    rawEdges: [
      ...contributions.files.flatMap((file) => file.behaviouralEdges),
      ...contributions.files.flatMap((file) => file.inheritanceEdges),
      ...contributions.files.flatMap((file) => file.importEdges),
      ...contributions.files.flatMap((file) => file.valueReferenceEdges),
      ...contributions.promiseLane.edges,
    ],
    implementationMembers: contributions.files.flatMap((file) => file.implementationMembers),
    flows,
    ports: [...contributions.portsLane],
    summary: {
      ...contributions.summary,
      exportsByFile: new Map(contributions.files.map((file) => [
        file.file,
        new Map(file.summary.exports),
      ])),
      moduleIdByRelPath: new Map(contributions.files.map((file) => [
        file.file,
        file.summary.moduleId,
      ])),
      pendingReexports: contributions.files.flatMap((file) => file.summary.pendingReexports),
    },
    diagnostics: [
      ...contributions.files.flatMap((file) => file.diagnostics.behavioural),
      ...contributions.files.flatMap((file) => file.diagnostics.inheritance),
      ...contributions.files.flatMap((file) => file.diagnostics.valueReferences),
    ],
    files: contributions.files.length,
  };
}

/**
 * Overlay only cache-eligible semantic lanes onto a contribution set whose target-wide structure,
 * imports, flows, Promise resources, ports, ordering, and summary metadata were freshly computed.
 * Import edges never come from the region codec and never replace the target revision's fresh pass.
 */
export function replaceUnitSemanticFileContributions(
  contributions: UnitContributionSetV1,
  replacements: ReadonlyMap<string, UnitSemanticFileContributionV1>,
): UnitContributionSetV1 {
  requireReusableSemanticFiles(contributions.fileOrder, replacements);
  const targetNodeIds = new Set([
    ...contributions.packageNodes,
    ...contributions.files.flatMap((file) => file.structuralNodes),
    ...contributions.promiseLane.nodes,
  ].map((node) => node.id));
  return {
    ...contributions,
    files: contributions.files.map((current) => {
      const replacement = replacements.get(current.file);
      if (replacement === undefined) return current;
      if (replacement.summary.moduleId !== current.summary.moduleId) {
        throw new Error(
          `semantic replacement module id differs from target structure: ${current.file}`,
        );
      }
      const structuralIds = new Set(current.structuralNodes.map((node) => node.id));
      for (const edge of [
        ...replacement.behaviouralEdges,
        ...replacement.inheritanceEdges,
        ...replacement.valueReferenceEdges,
      ]) {
        if (
          edge.callSite.file !== current.file
          || !structuralIds.has(edge.source)
        ) {
          throw new Error(
            `semantic replacement edge source differs from target structure: ${edge.source}`,
          );
        }
        if (
          edge.resolution.resolution === "resolved"
          && (
            edge.resolution.resolvedTarget === null
            || !targetNodeIds.has(edge.resolution.resolvedTarget)
          )
        ) {
          throw new Error(
            `semantic replacement edge target differs from target structure: `
            + `${edge.resolution.resolvedTarget ?? "<missing>"}`,
          );
        }
      }
      for (const [exportedName, targetId] of replacement.summary.exports) {
        if (!targetNodeIds.has(targetId)) {
          throw new Error(
            `semantic replacement export target differs from target structure: `
            + `${exportedName} -> ${targetId}`,
          );
        }
      }
      for (const pending of replacement.summary.pendingReexports) {
        if (pending.file !== current.file) {
          throw new Error(
            `semantic replacement pending re-export differs from target file: ${pending.file}`,
          );
        }
      }
      return {
        ...current,
        behaviouralEdges: [...replacement.behaviouralEdges],
        inheritanceEdges: [...replacement.inheritanceEdges],
        valueReferenceEdges: [...replacement.valueReferenceEdges],
        diagnostics: {
          behavioural: [...replacement.diagnostics.behavioural],
          inheritance: [...replacement.diagnostics.inheritance],
          valueReferences: [...replacement.diagnostics.valueReferences],
        },
        summary: {
          exports: replacement.summary.exports.map(([name, id]) => [name, id] as const),
          moduleId: replacement.summary.moduleId,
          pendingReexports: [...replacement.summary.pendingReexports],
        },
      };
    }),
  };
}

function diagnosticContributionsByFile(
  fileOrder: readonly string[],
  contributions: readonly FileDiagnosticContribution[],
  label: string,
): Map<string, ExtractionDiagnostic[]> {
  const byFile = new Map(fileOrder.map((file) => [file, [] as ExtractionDiagnostic[]]));
  const seen = new Set<string>();
  for (const contribution of contributions) {
    const target = byFile.get(contribution.file);
    if (target === undefined) {
      throw new Error(`${label} belongs to an unselected file: ${contribution.file}`);
    }
    if (seen.has(contribution.file)) {
      throw new Error(`duplicate ${label} contribution: ${contribution.file}`);
    }
    seen.add(contribution.file);
    target.push(...contribution.diagnostics);
  }
  for (const file of fileOrder) {
    if (!seen.has(file)) {
      throw new Error(`${label} contribution is missing selected file: ${file}`);
    }
  }
  return byFile;
}

function checkedFileOrder(fileOrder: readonly string[]): string[] {
  const result = [...fileOrder];
  const seen = new Set<string>();
  for (const file of result) {
    if (file.length === 0 || seen.has(file)) {
      throw new Error(`invalid unit contribution file order entry: ${file}`);
    }
    seen.add(file);
  }
  return result;
}

function groupByFile<T>(
  fileOrder: readonly string[],
  values: readonly T[],
  fileOf: (value: T) => string,
  label: string,
): Map<string, T[]> {
  const grouped = new Map(fileOrder.map((file) => [file, [] as T[]]));
  for (const value of values) {
    const file = fileOf(value);
    const entries = grouped.get(file);
    if (entries === undefined) {
      throw new Error(`${label} belongs to an unselected file: ${file || "<unknown>"}`);
    }
    entries.push(value);
  }
  return grouped;
}

function isInheritanceEdge(edge: RawEdge): boolean {
  return edge.kind === "extends" || edge.kind === "implements";
}
