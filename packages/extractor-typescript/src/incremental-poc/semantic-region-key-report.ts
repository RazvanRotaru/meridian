/**
 * Disposable, read-only semantic-region addressing report.
 *
 * This harness stops after exact-tree verification, workspace discovery, compiler loading,
 * fingerprinting, and semantic-region addressing. It never extracts graph contributions and never
 * reads or writes a revision cache.
 *
 * Usage:
 *   pnpm --dir packages/extractor-typescript exec tsx \
 *     src/incremental-poc/semantic-region-key-report.ts \
 *     <root> <tree-oid> [supplemental-files-json-or-dash] [unit-id]
 */

import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { perPackageWorkspace } from "../extractor";
import { loadUnitProject } from "../project-loader";
import {
  analysisPolicy,
  extractOptions,
  extractorProvenance,
  unitInputFingerprintWithCatalogs,
  workspaceDigest,
} from "./fingerprints";
import { canonicalJson } from "./canonical-json";
import { collectSemanticCompilerObservations } from "./semantic-compiler-observations";
import {
  listGitTreeBlobs,
  verifyCleanCheckoutAtTree,
  verifyGitTreeInputs,
} from "./git-tree";
import type { RevisionExtractionRequest } from "./model";
import { loadBenchmarkSupplementalFiles } from "./real-workspace-benchmark-input";
import {
  addressSemanticRegions,
} from "./semantic-region-inputs";

const REPORT_VERSION = 4 as const;
const IMPLEMENTATION_VERSION =
  "semantic-region-key-report-v4-compiler-observations";
const [rootInput, treeOid, supplementalFilesJsonPath, unitIdFilter] =
  process.argv.slice(2);
if (
  rootInput === undefined
  || treeOid === undefined
  || process.argv.slice(2).length > 4
) {
  throw new Error(
    "usage: tsx semantic-region-key-report.ts "
    + "<root> <tree-oid> [supplemental-files-json-or-dash] [unit-id]",
  );
}

const reportStarted = performance.now();
let peakRssBytes = currentPeakRssBytes();
const root = resolve(rootInput);
const supplementalFiles = loadBenchmarkSupplementalFiles(
  supplementalFilesJsonPath === undefined || supplementalFilesJsonPath === "-"
    ? null
    : resolve(supplementalFilesJsonPath),
);

const checkoutStarted = performance.now();
const checkout = await verifyCleanCheckoutAtTree(root, treeOid);
const checkoutVerificationMs = elapsed(checkoutStarted);
samplePeakRss();

const treeStarted = performance.now();
const verifiedTree = await verifyGitTreeInputs(
  root,
  await listGitTreeBlobs(root, checkout.expectedTreeOid),
);
const treeVerificationMs = elapsed(treeStarted);
const treeBlobs = verifiedTree.regularBlobs;
const treeBlobIndex = new Map(treeBlobs.map((blob) => [blob.path, blob]));
samplePeakRss();

const policy = analysisPolicy({
  depth: "function",
  includeExternal: true,
  includeUnresolved: false,
  emitImportEdges: true,
  valueRefs: true,
});
const options = extractOptions(root, policy, {
  supplementalFiles: supplementalFiles.paths.length === 0
    ? undefined
    : [...supplementalFiles.paths],
});
const workspaceStarted = performance.now();
const workspace = perPackageWorkspace(options);
const workspaceDiscoveryMs = elapsed(workspaceStarted);
if (workspace === null) {
  throw new Error(
    "semantic-region key report requires an automatically discovered package workspace",
  );
}
const exactWorkspaceDigest = workspaceDigest(workspace);
const reportUnits = unitIdFilter === undefined
  ? workspace.units
  : workspace.units.filter((unit) => (unit.dir || ".") === unitIdFilter);
if (reportUnits.length === 0) {
  throw new Error(`semantic-region key report unit is absent: ${unitIdFilter}`);
}
const request: RevisionExtractionRequest = {
  root,
  treeOid: checkout.expectedTreeOid,
  cacheDir: resolve(root, "..", "unused-semantic-region-key-report-cache"),
  extractorVersion: IMPLEMENTATION_VERSION,
  analysisPolicyVersion: IMPLEMENTATION_VERSION,
  supplementalFiles: supplementalFiles.paths.length === 0
    ? undefined
    : [...supplementalFiles.paths],
  options: {
    depth: policy.depth,
    exclude: policy.exclude,
    includeExternal: policy.includeExternal,
    includeUnresolved: policy.includeUnresolved,
    emitImportEdges: policy.emitImportEdges,
    valueRefs: policy.valueRefs,
  },
};
const provenance = extractorProvenance(request);
samplePeakRss();

const unitReports = [];
for (const [unitIndex, unit] of reportUnits.entries()) {
  const unitId = unit.dir || ".";
  process.stderr.write(
    `addressing unit ${unitIndex + 1}/${reportUnits.length}: ${unitId}\n`,
  );
  const unitStarted = performance.now();

  const loadStarted = performance.now();
  const loaded = loadUnitProject(root, unit, options, workspace.memberPaths);
  const compilerLoadMs = elapsed(loadStarted);
  samplePeakRss();
  process.stderr.write(
    `loaded unit ${unitIndex + 1}/${reportUnits.length}: ${unitId} `
    + `(${rounded(compilerLoadMs)} ms)\n`,
  );

  const fingerprintStarted = performance.now();
  const fingerprinted = unitInputFingerprintWithCatalogs({
    root,
    unit,
    loaded,
    treeBlobs,
    treeBlobIndex,
    policy,
    provenance,
  });
  const inputs = fingerprinted.fingerprint;
  const fingerprintMs = elapsed(fingerprintStarted);
  samplePeakRss();
  process.stderr.write(
    `fingerprinted unit ${unitIndex + 1}/${reportUnits.length}: ${unitId} `
    + `(${rounded(fingerprintMs)} ms)\n`,
  );

  const compilerObservationStarted = performance.now();
  const compilerObservations = collectSemanticCompilerObservations(
    loaded,
    new Set(loaded.sourceFiles.map(
      (sourceFile) => `repo:${loaded.relativePathOf(sourceFile)}`,
    )),
  );
  const compilerObservationMs = elapsed(compilerObservationStarted);
  samplePeakRss();
  process.stderr.write(
    `observed unit ${unitIndex + 1}/${reportUnits.length}: ${unitId} `
    + `(${rounded(compilerObservationMs)} ms; `
    + `${compilerObservations.files.length} selected sources)\n`,
  );

  const addressingStarted = performance.now();
  let addressingBreakdown:
    | {
        prepareProgramMs: number;
        collectObservationsMs: number;
        contextMs: number;
        addressFilesMs: number;
      }
    | undefined;
  const addressed = addressSemanticRegions({
    loaded,
    unitInputs: inputs,
    workspaceDigest: exactWorkspaceDigest,
    compilerObservations,
    unitInputCatalogs: fingerprinted.catalogs,
    onTiming: (timing) => {
      addressingBreakdown = timing;
    },
  });
  const addressingMs = elapsed(addressingStarted);
  samplePeakRss();
  process.stderr.write(
    `addressed unit ${unitIndex + 1}/${reportUnits.length}: ${unitId} `
    + `(${rounded(addressingMs)} ms; ${addressed.regions.length} regions)\n`,
  );

  const regions = addressed.regions.map((region) => ({
    id: region.id,
    key: region.key,
    files: [...region.files],
    selectedFileCount: region.files.length,
    programComponentNodeCount:
      region.inputs.programComponent.componentInput.nodes.length,
    dependencyRegionIds: [...region.dependencyRegionIds],
  }));
  const largestSelectedRegionFiles = regions.reduce(
    (largest, region) => Math.max(largest, region.selectedFileCount),
    0,
  );
  const largestProgramComponentNodes = regions.reduce(
    (largest, region) => Math.max(largest, region.programComponentNodeCount),
    0,
  );
  const unitInputCanonicalBytes = Buffer.byteLength(canonicalJson(inputs));
  unitReports.push({
    unitId,
    unitName: unit.name,
    sourceFiles: inputs.sourceBlobs.length,
    sourceBytes: inputs.sourceBlobs.reduce(
      (total, blob) => total + blob.byteSize,
      0,
    ),
    programInputs: inputs.programInputs.length,
    resolutionLookupProofs: inputs.resolutionLookupProofs.length,
    resolutionLookupProofReferences:
      inputs.programInputs.length
      + inputs.moduleResolutions.length
      + inputs.typeReferenceResolutions.length,
    unitInputCanonicalBytes,
    resolutionLookupInputs: inputs.resolutionLookupInputs.length,
    resolutionLookupInputReferences:
      inputs.resolutionLookupProofs.reduce(
        (total, proof) => total + proof.resolutionLookupInputKeys.length,
        inputs.unattributedResolutionLookupInputKeys.length,
      ),
    reuseEligibility: inputs.reuseEligibility,
    planKind: addressed.plan.kind,
    fallbackReasons: [...addressed.plan.reasons],
    contextDigest: addressed.contextDigest,
    contextRemainder: {
      programInputs: addressed.context.unattributedProgramInputs.length,
      filesystemInputs: addressed.context.unattributedFilesystemInputs.length,
      moduleResolutions:
        addressed.context.unattributedModuleResolutions.length,
      typeReferenceResolutions:
        addressed.context.unattributedTypeReferenceResolutions.length,
      resolutionLookupInputs:
        addressed.context.unattributedResolutionLookupInputs.length,
    },
    totalRegions: regions.length,
    largestSelectedRegionFiles,
    largestProgramComponentNodes,
    compilerObservations,
    regions,
    timings: {
      compilerLoadMs: rounded(compilerLoadMs),
      fingerprintMs: rounded(fingerprintMs),
      compilerObservationMs: rounded(compilerObservationMs),
      addressingMs: rounded(addressingMs),
      addressingBreakdown: addressingBreakdown === undefined
        ? null
        : {
            prepareProgramMs: rounded(addressingBreakdown.prepareProgramMs),
            collectObservationsMs: rounded(
              addressingBreakdown.collectObservationsMs,
            ),
            contextMs: rounded(addressingBreakdown.contextMs),
            addressFilesMs: rounded(addressingBreakdown.addressFilesMs),
          },
      totalMs: rounded(elapsed(unitStarted)),
    },
    peakRssBytesAfterUnit: currentPeakRssBytes(),
  });
}

samplePeakRss();
process.stdout.write(`${JSON.stringify({
  version: REPORT_VERSION,
  implementationVersion: IMPLEMENTATION_VERSION,
  root,
  commitOid: checkout.headCommitOid,
  treeOid: checkout.expectedTreeOid,
  supplementalFiles,
  workspaceDigest: exactWorkspaceDigest,
  policy,
  provenance,
  exactTreeInputs: {
    regularBlobs: verifiedTree.regularBlobs.length,
    symlinks: verifiedTree.symlinks.length,
  },
  totals: {
    units: unitReports.length,
    sourceFiles: sum(unitReports, (unit) => unit.sourceFiles),
    sourceBytes: sum(unitReports, (unit) => unit.sourceBytes),
    regions: sum(unitReports, (unit) => unit.totalRegions),
    fallbackUnits: unitReports.filter(
      (unit) => unit.planKind === "whole-unit-fallback",
    ).length,
    largestSelectedRegionFiles: max(
      unitReports.map((unit) => unit.largestSelectedRegionFiles),
    ),
    largestProgramComponentNodes: max(
      unitReports.map((unit) => unit.largestProgramComponentNodes),
    ),
  },
  timings: {
    checkoutVerificationMs: rounded(checkoutVerificationMs),
    treeVerificationMs: rounded(treeVerificationMs),
    workspaceDiscoveryMs: rounded(workspaceDiscoveryMs),
    compilerLoadMs: rounded(sum(unitReports, (unit) => unit.timings.compilerLoadMs)),
    fingerprintMs: rounded(sum(unitReports, (unit) => unit.timings.fingerprintMs)),
    compilerObservationMs: rounded(
      sum(unitReports, (unit) => unit.timings.compilerObservationMs),
    ),
    addressingMs: rounded(sum(unitReports, (unit) => unit.timings.addressingMs)),
    totalMs: rounded(elapsed(reportStarted)),
  },
  peakRssBytes,
  units: unitReports,
}, null, 2)}\n`);

function samplePeakRss(): void {
  peakRssBytes = Math.max(peakRssBytes, currentPeakRssBytes());
}

function currentPeakRssBytes(): number {
  return Math.max(
    process.memoryUsage().rss,
    process.resourceUsage().maxRSS * 1024,
  );
}

function elapsed(started: number): number {
  return performance.now() - started;
}

function rounded(value: number): number {
  return Math.round(value * 100) / 100;
}

function sum<T>(values: readonly T[], select: (value: T) => number): number {
  return values.reduce((total, value) => total + select(value), 0);
}

function max(values: readonly number[]): number {
  return values.reduce((largest, value) => Math.max(largest, value), 0);
}
