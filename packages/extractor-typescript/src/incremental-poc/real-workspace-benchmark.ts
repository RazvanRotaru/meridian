import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { extractRevisionWithCache } from "./extract-revision";

const [rootInput, treeOid, cacheDirInput, benchmarkVersion = "local-source"] =
  process.argv.slice(2);

if (rootInput === undefined || treeOid === undefined || cacheDirInput === undefined) {
  throw new Error(
    "usage: tsx real-workspace-benchmark.ts <root> <tree-oid> <cache-dir> [benchmark-version]",
  );
}

const root = resolve(rootInput);
const cacheDir = resolve(cacheDirInput);
const analysisPolicyVersion = createHash("sha256")
  .update(JSON.stringify({
    version: 1,
    depth: "function",
    includeExternal: true,
    includeUnresolved: false,
    emitImportEdges: true,
    valueRefs: true,
  }))
  .digest("hex");

process.stderr.write(
  `extracting ${treeOid} from ${root} with cache ${cacheDir} in process ${process.pid}\n`,
);

const run = await extractRevisionWithCache({
  root,
  treeOid,
  cacheDir,
  extractorVersion: `real-workspace-benchmark:${benchmarkVersion}`,
  analysisPolicyVersion,
  options: {
    depth: "function",
    includeExternal: true,
    includeUnresolved: false,
    valueRefs: true,
  },
});

const eligibilityReasonCounts = new Map<string, number>();
const units = run.manifest.units.map((unit) => {
  for (const reason of unit.reuseEligibility.reasons) {
    eligibilityReasonCounts.set(reason, (eligibilityReasonCounts.get(reason) ?? 0) + 1);
  }
  return {
    unitId: unit.unitId,
    sourceFiles: unit.sourceBlobs.length,
    sourceBytes: unit.sourceBlobs.reduce((total, blob) => total + blob.byteSize, 0),
    eligible: unit.reuseEligibility.eligible,
    reasons: unit.reuseEligibility.reasons,
  };
});

process.stdout.write(`${JSON.stringify({
  version: 1,
  root,
  treeOid,
  cacheDir,
  benchmarkVersion,
  normalizedResultDigest: run.manifest.normalizedResultDigest,
  manifestPath: run.manifestPath,
  metrics: run.metrics,
  eligibilityReasonCounts: Object.fromEntries(
    [...eligibilityReasonCounts].sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0),
  ),
  units,
}, null, 2)}\n`);
