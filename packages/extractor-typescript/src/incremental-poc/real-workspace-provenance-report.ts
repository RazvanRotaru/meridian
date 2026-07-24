import { builtinModules } from "node:module";
import { resolve } from "node:path";
import { perPackageWorkspace } from "../extractor";
import { loadUnitProject } from "../project-loader";
import {
  analysisPolicy,
  extractOptions,
  extractorProvenance,
  unitInputFingerprint,
} from "./fingerprints";
import {
  listGitTreeBlobs,
  verifyCleanCheckoutAtTree,
  verifyGitTreeInputs,
} from "./git-tree";
import type {
  ModuleResolutionFingerprint,
  RevisionExtractionRequest,
  TypeReferenceResolutionFingerprint,
} from "./model";

const [rootInput, treeOid, benchmarkVersion = "local-source"] = process.argv.slice(2);
if (rootInput === undefined || treeOid === undefined) {
  throw new Error(
    "usage: tsx real-workspace-provenance-report.ts <root> <tree-oid> [benchmark-version]",
  );
}

const root = resolve(rootInput);
const checkout = await verifyCleanCheckoutAtTree(root, treeOid);
const treeInputs = await verifyGitTreeInputs(
  root,
  await listGitTreeBlobs(root, checkout.expectedTreeOid),
);
const treeBlobs = treeInputs.regularBlobs;
const policy = analysisPolicy({
  depth: "function",
  includeExternal: true,
  includeUnresolved: false,
  emitImportEdges: true,
  valueRefs: true,
});
const options = extractOptions(root, policy);
const workspace = perPackageWorkspace(options);
if (workspace === null) {
  throw new Error("provenance report requires an automatically discovered multi-package workspace");
}
const request: RevisionExtractionRequest = {
  root,
  treeOid,
  cacheDir: resolve(root, "..", "unused-provenance-report-cache"),
  extractorVersion: `real-workspace-provenance:${benchmarkVersion}`,
  analysisPolicyVersion: "real-workspace-provenance-v1",
};
const provenance = extractorProvenance(request);
const workspaceNames = workspace.units
  .map((unit) => unit.name)
  .filter((name): name is string => name !== null)
  .sort(compareStrings);
const builtinNames = new Set(
  builtinModules.flatMap((name) => [name, name.startsWith("node:") ? name.slice(5) : `node:${name}`]),
);

const reports = [];
for (const unit of workspace.units) {
  process.stderr.write(`fingerprinting ${unit.dir || "."}\n`);
  const loaded = loadUnitProject(root, unit, options, workspace.memberPaths);
  const inputs = unitInputFingerprint({
    root,
    unit,
    loaded,
    treeBlobs,
    policy,
    provenance,
  });
  const unresolvedModules = inputs.moduleResolutions.filter((entry) => entry.target === null);
  const unresolvedTypeReferences = inputs.typeReferenceResolutions.filter(
    (entry) => entry.target === null,
  );
  const resolvedExternalModules = inputs.moduleResolutions.filter(isExternalResolution);
  const resolvedExternalTypeReferences =
    inputs.typeReferenceResolutions.filter(isExternalResolution);
  const externalProgramInputs = inputs.programInputs.filter(
    (input) => input.trackedBlobOid === null && !input.isDefaultLibrary,
  );
  const resolutionLookupInputs = {
    count: inputs.resolutionLookupInputs.length,
    uniqueAddresses: new Set(inputs.resolutionLookupInputs.map((input) => input.address)).size,
    failedLookups: inputs.resolutionLookupInputs.filter(
      (input) => input.purpose === "failed-lookup",
    ).length,
    affectingLocations: inputs.resolutionLookupInputs.filter(
      (input) => input.purpose === "affecting",
    ).length,
    absent: inputs.resolutionLookupInputs.filter((input) => input.state === "absent").length,
    files: inputs.resolutionLookupInputs.filter((input) => input.state === "file").length,
    directories: inputs.resolutionLookupInputs.filter(
      (input) => input.state === "directory",
    ).length,
    symlinks: inputs.resolutionLookupInputs.filter((input) => input.state === "symlink").length,
    other: inputs.resolutionLookupInputs.filter((input) => input.state === "other").length,
  };
  reports.push({
    unitId: unit.dir || ".",
    unitName: unit.name,
    reuseEligibility: inputs.reuseEligibility,
    unresolvedModules: summarizeUnresolved(unresolvedModules, workspaceNames, builtinNames),
    unresolvedTypeReferences:
      summarizeUnresolved(unresolvedTypeReferences, workspaceNames, builtinNames),
    resolutionLookupInputs,
    resolvedExternalModules: summarizeResolvedExternal(resolvedExternalModules),
    resolvedExternalTypeReferences:
      summarizeResolvedExternal(resolvedExternalTypeReferences),
    externalProgramInputs: {
      count: externalProgramInputs.length,
      addresses: uniqueSorted(externalProgramInputs.map((input) => input.address)),
    },
  });
}

process.stdout.write(`${JSON.stringify({
  version: 1,
  commitOid: checkout.headCommitOid,
  treeOid: checkout.expectedTreeOid,
  workspaceNames,
  totals: {
    units: reports.length,
    unresolvedModules: sum(reports, (report) => report.unresolvedModules.count),
    unresolvedTypeReferences:
      sum(reports, (report) => report.unresolvedTypeReferences.count),
    resolutionLookupInputs:
      sum(reports, (report) => report.resolutionLookupInputs.count),
    unitSummedUniqueResolutionLookupAddresses:
      sum(reports, (report) => report.resolutionLookupInputs.uniqueAddresses),
    resolvedExternalModules:
      sum(reports, (report) => report.resolvedExternalModules.count),
    resolvedExternalTypeReferences:
      sum(reports, (report) => report.resolvedExternalTypeReferences.count),
    externalProgramInputs:
      sum(reports, (report) => report.externalProgramInputs.count),
  },
  units: reports,
}, null, 2)}\n`);

type Resolution =
  | ModuleResolutionFingerprint
  | TypeReferenceResolutionFingerprint;

function summarizeUnresolved(
  resolutions: readonly Resolution[],
  packageNames: readonly string[],
  builtins: ReadonlySet<string>,
): {
  count: number;
  uniqueSpecifiers: number;
  byCategory: Record<SpecifierCategory, { count: number; specifiers: string[] }>;
} {
  const categories: Record<SpecifierCategory, string[]> = {
    relative: [],
    "node-builtin": [],
    "workspace-alias": [],
    bare: [],
  };
  for (const resolution of resolutions) {
    categories[classifySpecifier(resolution.specifier, packageNames, builtins)]
      .push(resolution.specifier);
  }
  return {
    count: resolutions.length,
    uniqueSpecifiers: uniqueSorted(resolutions.map((entry) => entry.specifier)).length,
    byCategory: {
      relative: categoryReport(categories.relative),
      "node-builtin": categoryReport(categories["node-builtin"]),
      "workspace-alias": categoryReport(categories["workspace-alias"]),
      bare: categoryReport(categories.bare),
    },
  };
}

function summarizeResolvedExternal(resolutions: readonly Resolution[]): {
  count: number;
  specifiers: string[];
  targets: string[];
} {
  return {
    count: resolutions.length,
    specifiers: uniqueSorted(resolutions.map((entry) => entry.specifier)),
    targets: uniqueSorted(
      resolutions.flatMap((entry) => entry.target === null ? [] : [entry.target.address]),
    ),
  };
}

function categoryReport(specifiers: readonly string[]): {
  count: number;
  specifiers: string[];
} {
  return { count: specifiers.length, specifiers: uniqueSorted(specifiers) };
}

type SpecifierCategory = "relative" | "node-builtin" | "workspace-alias" | "bare";

function classifySpecifier(
  specifier: string,
  packageNames: readonly string[],
  builtins: ReadonlySet<string>,
): SpecifierCategory {
  if (builtins.has(specifier)) return "node-builtin";
  if (specifier.startsWith(".") || specifier.startsWith("/")) return "relative";
  if (packageNames.some((name) => specifier === name || specifier.startsWith(`${name}/`))) {
    return "workspace-alias";
  }
  return "bare";
}

function isExternalResolution(resolution: Resolution): boolean {
  return resolution.target !== null && resolution.target.trackedBlobOid === null;
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareStrings);
}

function sum<T>(values: readonly T[], select: (value: T) => number): number {
  return values.reduce((total, value) => total + select(value), 0);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
