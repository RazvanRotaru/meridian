/**
 * Expand one target-derived compiler observation transcript for diagnostics.
 *
 * Usage:
 *   tsx semantic-compiler-observation-report.ts \
 *     <root> <tree-oid> <unit-id> <portable-source-address> [supplemental-files-json]
 */

import { resolve } from "node:path";
import { perPackageWorkspace } from "../extractor";
import { loadUnitProject } from "../project-loader";
import { analysisPolicy, extractOptions } from "./fingerprints";
import { verifyCleanCheckoutAtTree } from "./git-tree";
import { loadBenchmarkSupplementalFiles } from "./real-workspace-benchmark-input";
import { inspectSemanticCompilerObservation } from "./semantic-compiler-observations";

const [
  rootInput,
  treeOid,
  unitId,
  sourceAddress,
  supplementalFilesJsonPath,
] = process.argv.slice(2);
if (
  rootInput === undefined
  || treeOid === undefined
  || unitId === undefined
  || sourceAddress === undefined
  || process.argv.slice(2).length > 5
) {
  throw new Error(
    "usage: tsx semantic-compiler-observation-report.ts "
    + "<root> <tree-oid> <unit-id> <portable-source-address> "
    + "[supplemental-files-json]",
  );
}

const root = resolve(rootInput);
await verifyCleanCheckoutAtTree(root, treeOid);
const supplementalFiles = loadBenchmarkSupplementalFiles(
  supplementalFilesJsonPath === undefined
    ? null
    : resolve(supplementalFilesJsonPath),
);
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
const workspace = perPackageWorkspace(options);
if (workspace === null) {
  throw new Error("compiler-observation report requires a package workspace");
}
const unit = workspace.units.find((candidate) => (candidate.dir || ".") === unitId);
if (unit === undefined) throw new Error(`workspace unit is absent: ${unitId}`);
const loaded = loadUnitProject(root, unit, options, workspace.memberPaths);
process.stdout.write(`${JSON.stringify(
  inspectSemanticCompilerObservation(loaded, sourceAddress),
  null,
  2,
)}\n`);
