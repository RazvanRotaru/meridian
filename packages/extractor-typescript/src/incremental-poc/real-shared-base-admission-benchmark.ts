/**
 * Disposable real-workspace benchmark for authenticated shared-base reuse.
 *
 * The measured PR-head extraction runs in a fresh process after a base shadow run has admitted
 * immutable shards. An optional cold-head oracle runs only after the measurement, in another
 * fresh process and empty cache. Cross-process parity compares literal canonical category bytes;
 * semantic digests are diagnostic rather than the equality predicate.
 *
 * Usage:
 *   tsx real-shared-base-admission-benchmark.ts \
 *     <base-root> <base-tree-oid> <base-supplemental-json|-> \
 *     <head-root> <head-tree-oid> <head-supplemental-json|-> \
 *     <cache-dir> [benchmark-version] [--cold-head]
 */

import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type RevisionShardAdmissionSigner,
  type RevisionShardAdmissionVerifier,
  isRevisionShardAdmissionCapability,
} from "./admission";
import {
  DIFFERENTIAL_CATEGORIES,
  type DifferentialMismatch,
  type DifferentialReport,
} from "./differential";
import {
  disposeExtractionDifferentialEvidence,
  persistExtractionDifferentialEvidence,
  type PersistedExtractionDifferentialEvidence,
} from "./differential-evidence";
import { extractRevisionDifferential } from "./differential-revision";
import { exactRegularFilesEqual } from "./exact-file-parity";
import { extractRevisionCandidate } from "./extract-revision";
import { directoryBytes, elapsedMs, peakRssBytes } from "./metrics";
import type {
  RevisionExtractionMetrics,
  RevisionExtractionRequest,
  RevisionManifest,
} from "./model";
import { loadBenchmarkSupplementalFiles } from "./real-workspace-benchmark-input";

const OBJECT_OID = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const MAX_WORKER_OUTPUT_BYTES = 256 * 1024 * 1024;
const ANALYSIS_POLICY_VERSION = createHash("sha256")
  .update(JSON.stringify({
    version: 1,
    depth: "function",
    includeExternal: true,
    includeUnresolved: false,
    emitImportEdges: true,
    valueRefs: true,
  }))
  .digest("hex");

interface BenchmarkArguments {
  baseRoot: string;
  baseTreeOid: string;
  baseSupplementalJson: string | null;
  headRoot: string;
  headTreeOid: string;
  headSupplementalJson: string | null;
  cacheDir: string;
  benchmarkVersion: string;
  coldHead: boolean;
}

interface AdmissionAuthority {
  signer: RevisionShardAdmissionSigner;
  verifier: RevisionShardAdmissionVerifier;
}

interface BaseShadowWorkerRequest {
  kind: "base-shadow";
  request: RevisionExtractionRequest;
  signer: RevisionShardAdmissionSigner;
}

interface HeadWorkerRequest {
  kind: "admitted-head" | "cold-head";
  request: RevisionExtractionRequest;
  verifier: RevisionShardAdmissionVerifier | null;
  persistEvidence: boolean;
}

type WorkerRequest = BaseShadowWorkerRequest | HeadWorkerRequest;

interface BaseShadowWorkerReport {
  kind: "base-shadow";
  processId: number;
  wallMs: number;
  processPeakRssBytes: number;
  cacheBytesAfter: number;
  manifest: RevisionManifest;
  candidateMetrics: RevisionExtractionMetrics;
  coldOracleMetrics: RevisionExtractionMetrics;
  differential: DifferentialReport;
}

interface HeadWorkerReport {
  kind: "admitted-head" | "cold-head";
  processId: number;
  wallMs: number;
  extractionWallMs: number;
  evidenceMs: number;
  processPeakRssBytes: number;
  cacheBytesAfter: number;
  manifest: RevisionManifest;
  metrics: RevisionExtractionMetrics;
  unitExecution: {
    reusedUnitIds: string[];
    rebuiltUnitIds: string[];
  };
  evidence: PersistedExtractionDifferentialEvidence | null;
}

if (process.argv[2] === "--worker") {
  await runWorker(process.argv[3]);
} else {
  await runBenchmark(process.argv.slice(2));
}

async function runBenchmark(args: readonly string[]): Promise<void> {
  const started = process.hrtime.bigint();
  const inputs = parseArguments(args);
  const baseSupplemental = loadBenchmarkSupplementalFiles(inputs.baseSupplementalJson);
  const headSupplemental = loadBenchmarkSupplementalFiles(inputs.headSupplementalJson);
  const extractorVersion =
    `real-shared-base-admission-benchmark:${inputs.benchmarkVersion}`;
  const authority = admissionAuthority();
  const requestRoot = mkdtempSync(join(tmpdir(), "meridian-real-admission-benchmark-"));
  const evidenceToDispose: PersistedExtractionDifferentialEvidence[] = [];
  let coldCacheDir: string | null = null;

  try {
    const cacheBytesBefore = directoryBytes(inputs.cacheDir);
    const baseRequest = revisionRequest({
      root: inputs.baseRoot,
      treeOid: inputs.baseTreeOid,
      cacheDir: inputs.cacheDir,
      extractorVersion,
      supplementalFiles: baseSupplemental.paths,
    });
    process.stderr.write(
      `shadow-admitting base tree ${inputs.baseTreeOid} into ${inputs.cacheDir}\n`,
    );
    const base = runWorkerProcess<BaseShadowWorkerReport>(
      requestRoot,
      "base-shadow",
      { kind: "base-shadow", request: baseRequest, signer: authority.signer },
    );
    if (!base.differential.equal) {
      throw new Error("base shadow admission returned without exact cold-oracle parity");
    }
    const cacheBytesAfterBase = directoryBytes(inputs.cacheDir);

    const headRequest = revisionRequest({
      root: inputs.headRoot,
      treeOid: inputs.headTreeOid,
      cacheDir: inputs.cacheDir,
      extractorVersion,
      supplementalFiles: headSupplemental.paths,
    });
    process.stderr.write(
      `measuring admitted head tree ${inputs.headTreeOid} in a fresh process\n`,
    );
    const head = runWorkerProcess<HeadWorkerReport>(
      requestRoot,
      "admitted-head",
      {
        kind: "admitted-head",
        request: headRequest,
        verifier: authority.verifier,
        persistEvidence: inputs.coldHead,
      },
    );
    if (head.evidence !== null) evidenceToDispose.push(head.evidence);
    const cacheBytesAfterHead = directoryBytes(inputs.cacheDir);
    const reuse = reuseSummary(
      base.manifest,
      head.manifest,
      head.metrics,
      head.unitExecution,
    );

    let cold:
      | {
          report: HeadWorkerReport;
          parity: DifferentialReport & { comparison: "exact-canonical-category-bytes" };
        }
      | null = null;
    if (inputs.coldHead) {
      coldCacheDir = mkdtempSync(join(tmpdir(), "meridian-real-admission-cold-head-"));
      process.stderr.write(
        `running post-measurement cold oracle for head tree ${inputs.headTreeOid}\n`,
      );
      const coldReport = runWorkerProcess<HeadWorkerReport>(
        requestRoot,
        "cold-head",
        {
          kind: "cold-head",
          request: { ...headRequest, cacheDir: coldCacheDir },
          verifier: null,
          persistEvidence: true,
        },
      );
      if (coldReport.evidence === null || head.evidence === null) {
        throw new Error("cold-head parity worker did not persist exact semantic evidence");
      }
      evidenceToDispose.push(coldReport.evidence);
      cold = {
        report: coldReport,
        parity: {
          ...(await compareExactEvidence(head.evidence, coldReport.evidence)),
          comparison: "exact-canonical-category-bytes",
        },
      };
    }

    const report = {
      version: 2,
      benchmark: "authenticated-shared-base-reuse",
      inputs: {
        base: {
          root: inputs.baseRoot,
          treeOid: inputs.baseTreeOid,
          supplementalFiles: {
            sourcePath: baseSupplemental.sourcePath,
            count: baseSupplemental.paths.length,
            digest: baseSupplemental.digest,
          },
        },
        head: {
          root: inputs.headRoot,
          treeOid: inputs.headTreeOid,
          supplementalFiles: {
            sourcePath: headSupplemental.sourcePath,
            count: headSupplemental.paths.length,
            digest: headSupplemental.digest,
          },
        },
        cacheDir: inputs.cacheDir,
        benchmarkVersion: inputs.benchmarkVersion,
        extractorVersion,
        analysisPolicyVersion: ANALYSIS_POLICY_VERSION,
      },
      executionModel: {
        authenticatedAdmissionKeyId: authority.verifier.keyId,
        baseAndHeadProcessesDiffer: base.processId !== head.processId,
        fullGraphsLoadedConcurrentlyAcrossRevisions: false,
        measuredHeadIncludesColdHeadExtraction: false,
        coldHeadRequested: inputs.coldHead,
        baseSignerRequestRemovedBeforeHead: true,
        coldHeadUsesEmptyMeridianCacheButWarmOsPageCache: inputs.coldHead,
        measurementNotes: [
          "metrics.totalMs is extraction time-to-action and excludes benchmark evidence serialization",
          "workerWallMs includes benchmark-only cache sizing and report construction",
          "base process peak covers candidate and cold-oracle phases in one shadow worker",
          "semantic-region reuse across the revision includes regions covered by exact full-unit hits",
        ],
      },
      cacheBytes: {
        before: cacheBytesBefore,
        afterBaseAdmission: cacheBytesAfterBase,
        baseAdmissionDelta: cacheBytesAfterBase - cacheBytesBefore,
        afterMeasuredHead: cacheBytesAfterHead,
        measuredHeadDelta: cacheBytesAfterHead - cacheBytesAfterBase,
      },
      baseAdmission: {
        processId: base.processId,
        wallMs: base.wallMs,
        processPeakRssBytes: base.processPeakRssBytes,
        semanticDigest: base.manifest.normalizedResultDigest,
        candidateMetrics: base.candidateMetrics,
        coldOracleMetrics: base.coldOracleMetrics,
        oracleParity: {
          ...base.differential,
          comparison: "exact-canonical-category-bytes",
        },
      },
      measuredHead: {
        processId: head.processId,
        semanticDigest: head.manifest.normalizedResultDigest,
        totalMs: head.metrics.totalMs,
        workerWallMs: head.wallMs,
        extractionWallMs: head.extractionWallMs,
        postMeasurementEvidenceMs: head.evidenceMs,
        peakRssBytes: head.metrics.peakRssBytes,
        processPeakRssBytesAfterEvidence: head.processPeakRssBytes,
        phaseTimes: {
          fingerprintMs: head.metrics.fingerprintMs,
          unitExtractionMs: head.metrics.unitExtractionMs,
          stitchMs: head.metrics.stitchMs,
          ...head.metrics.profile,
        },
        reuse,
        metrics: head.metrics,
      },
      postMeasurementColdOracle: cold === null
        ? {
            checked: false,
            reason: "pass --cold-head to require an exact clean-cache head comparison",
          }
        : {
            checked: true,
            processId: cold.report.processId,
            semanticDigest: cold.report.manifest.normalizedResultDigest,
            totalMs: cold.report.metrics.totalMs,
            workerWallMs: cold.report.wallMs,
            peakRssBytes: cold.report.metrics.peakRssBytes,
            metrics: cold.report.metrics,
            parity: cold.parity,
          },
      orchestrationTotalMs: elapsedMs(started),
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (cold !== null && !cold.parity.equal) process.exitCode = 1;
  } finally {
    for (const evidence of evidenceToDispose) {
      try {
        disposeExtractionDifferentialEvidence(evidence);
      } catch {
        // Preserve the primary benchmark result or failure.
      }
    }
    if (coldCacheDir !== null) rmSync(coldCacheDir, { recursive: true, force: true });
    rmSync(requestRoot, { recursive: true, force: true });
  }
}

async function runWorker(requestPath: string | undefined): Promise<void> {
  if (requestPath === undefined || !isAbsolute(requestPath)) {
    throw new Error("benchmark worker requires an absolute request path");
  }
  const input = JSON.parse(
    await import("node:fs/promises").then(({ readFile }) => readFile(requestPath, "utf8")),
  ) as WorkerRequest;
  const started = process.hrtime.bigint();

  if (input.kind === "base-shadow") {
    requireSigner(input.signer);
    const result = await extractRevisionDifferential(input.request, {
      admissionSigner: input.signer,
    });
    const report: BaseShadowWorkerReport = {
      kind: "base-shadow",
      processId: process.pid,
      wallMs: elapsedMs(started),
      processPeakRssBytes: peakRssBytes(),
      cacheBytesAfter: directoryBytes(input.request.cacheDir),
      manifest: result.incremental.manifest,
      candidateMetrics: result.incremental.metrics,
      coldOracleMetrics: result.cold.metrics,
      differential: result.differential,
    };
    process.stdout.write(`${JSON.stringify(report)}\n`);
    return;
  }

  if (input.kind !== "admitted-head" && input.kind !== "cold-head") {
    throw new TypeError("unknown real admission benchmark worker kind");
  }
  if (input.kind === "admitted-head") {
    requireVerifier(input.verifier);
  } else if (input.verifier !== null) {
    throw new TypeError("cold-head worker must not receive an admission verifier");
  }
  const extractionStarted = process.hrtime.bigint();
  const candidate = await extractRevisionCandidate(
    input.request,
    input.kind === "admitted-head"
      ? { requiredAdmission: input.verifier! }
      : {},
  );
  const extractionWallMs = elapsedMs(extractionStarted);
  const evidenceStarted = process.hrtime.bigint();
  const evidence = input.persistEvidence
    ? persistExtractionDifferentialEvidence(candidate.result)
    : null;
  const evidenceMs = elapsedMs(evidenceStarted);
  if (
    evidence !== null
    && evidence.digest !== candidate.manifest.normalizedResultDigest
  ) {
    disposeExtractionDifferentialEvidence(evidence);
    throw new Error("persisted semantic evidence digest differs from the revision manifest");
  }
  const pendingShardValues = new Set(
    candidate.pendingShards.map((pending) => pending.value),
  );
  const unitExecution = candidate.unitShards.reduce<HeadWorkerReport["unitExecution"]>(
    (summary, unit) => {
      const target = pendingShardValues.has(unit.value)
        ? summary.rebuiltUnitIds
        : summary.reusedUnitIds;
      target.push(unit.unitId);
      return summary;
    },
    { reusedUnitIds: [], rebuiltUnitIds: [] },
  );
  const report: HeadWorkerReport = {
    kind: input.kind,
    processId: process.pid,
    wallMs: elapsedMs(started),
    extractionWallMs,
    evidenceMs,
    processPeakRssBytes: peakRssBytes(),
    cacheBytesAfter: directoryBytes(input.request.cacheDir),
    manifest: candidate.manifest,
    metrics: candidate.metrics,
    unitExecution,
    evidence,
  };
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

function runWorkerProcess<Report>(
  requestRoot: string,
  label: string,
  request: WorkerRequest,
): Report {
  const requestPath = join(requestRoot, `${label}.json`);
  writeFileSync(requestPath, JSON.stringify(request), {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  const worker = fileURLToPath(import.meta.url);
  const result = (() => {
    try {
      return spawnSync(
        process.execPath,
        ["--import", "tsx", worker, "--worker", requestPath],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          maxBuffer: MAX_WORKER_OUTPUT_BYTES,
        },
      );
    } finally {
      // In particular, remove the private base signer before the verifier-only head child starts.
      rmSync(requestPath, { force: true });
    }
  })();
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${label} worker failed: ${result.stderr.trim() || `exit ${result.status}`}`,
    );
  }
  try {
    return JSON.parse(result.stdout) as Report;
  } catch (cause) {
    throw new Error(`${label} worker returned invalid JSON`, { cause });
  }
}

async function compareExactEvidence(
  incremental: PersistedExtractionDifferentialEvidence,
  cold: PersistedExtractionDifferentialEvidence,
): Promise<DifferentialReport> {
  const mismatches: DifferentialMismatch[] = [];
  for (const category of DIFFERENTIAL_CATEGORIES) {
    const incrementalCategory = incremental.categories[category];
    const coldCategory = cold.categories[category];
    if (await exactRegularFilesEqual(incrementalCategory.path, coldCategory.path)) {
      continue;
    }
    mismatches.push({
      category,
      incrementalDigest: incrementalCategory.digest,
      coldDigest: coldCategory.digest,
      message: [
        `${category} differ`,
        `(incremental ${incrementalCategory.description},`,
        `sha256=${incrementalCategory.digest};`,
        `cold ${coldCategory.description}, sha256=${coldCategory.digest})`,
      ].join(" "),
    });
  }
  return {
    equal: mismatches.length === 0,
    incrementalDigest: incremental.digest,
    coldDigest: cold.digest,
    mismatches,
  };
}

function reuseSummary(
  base: RevisionManifest,
  head: RevisionManifest,
  metrics: RevisionExtractionMetrics,
  unitExecution: HeadWorkerReport["unitExecution"],
) {
  const baseUnits = new Map(base.units.map((unit) => [unit.unitId, unit]));
  const fullUnitHitIds = new Set(unitExecution.reusedUnitIds);
  const fullUnitHits = head.units.filter((unit) => fullUnitHitIds.has(unit.unitId));
  const fullUnitCoveredRegions = fullUnitHits.reduce(
    (total, unit) => total + unit.semanticRegions.length,
    0,
  );
  const totalManifestRegions = head.units.reduce(
    (total, unit) => total + unit.semanticRegions.length,
    0,
  );
  const effectiveReusedRegions =
    fullUnitCoveredRegions + metrics.semanticRegions.reusedRegions;
  const effectiveMeasuredRegions =
    fullUnitCoveredRegions + metrics.semanticRegions.totalRegions;
  const baseRegionKeys = new Set(
    base.units.flatMap((unit) => unit.semanticRegions.map((region) => region.key)),
  );
  const sharedManifestRegionKeys = head.units.reduce(
    (total, unit) => total + unit.semanticRegions.filter(
      (region) => baseRegionKeys.has(region.key),
    ).length,
    0,
  );

  if (
    fullUnitHits.length !== metrics.reusedUnits
    || unitExecution.rebuiltUnitIds.length !== metrics.rebuiltUnits
  ) {
    throw new Error(
      `admitted unit execution identities disagree with aggregate metrics`,
    );
  }
  for (const unit of fullUnitHits) {
    if (baseUnits.get(unit.unitId)?.shardKey !== unit.shardKey) {
      throw new Error(`admitted unit hit was not present in the shadow-admitted base: ${unit.unitId}`);
    }
  }
  if (effectiveMeasuredRegions !== totalManifestRegions) {
    throw new Error(
      `semantic-region metrics do not cover the head manifest `
      + `(${effectiveMeasuredRegions} measured, ${totalManifestRegions} manifest)`,
    );
  }
  if (effectiveReusedRegions > sharedManifestRegionKeys) {
    throw new Error("reported semantic-region hits exceed shared base region keys");
  }

  return {
    units: {
      total: metrics.totalUnits,
      reused: metrics.reusedUnits,
      rebuilt: metrics.rebuiltUnits,
      reuseRatio: metrics.reuseRatio,
      byteReuseRatio: metrics.byteReuseRatio,
      fullUnitHitIds: [...fullUnitHitIds].sort(compareNames),
      rebuiltUnitIds: [...unitExecution.rebuiltUnitIds].sort(compareNames),
    },
    semanticRegions: {
      totalAcrossRevision: totalManifestRegions,
      effectiveReusedAcrossRevision: effectiveReusedRegions,
      effectiveRebuiltAcrossRevision: totalManifestRegions - effectiveReusedRegions,
      effectiveReuseRatioAcrossRevision: totalManifestRegions === 0
        ? 0
        : effectiveReusedRegions / totalManifestRegions,
      coveredByFullUnitHits: fullUnitCoveredRegions,
      sharedBaseRegionKeys: sharedManifestRegionKeys,
      physicalRegionShardsWithinRebuiltUnits: metrics.semanticRegions,
    },
  };
}

function revisionRequest(inputs: {
  root: string;
  treeOid: string;
  cacheDir: string;
  extractorVersion: string;
  supplementalFiles: readonly string[];
}): RevisionExtractionRequest {
  return {
    root: inputs.root,
    treeOid: inputs.treeOid,
    cacheDir: inputs.cacheDir,
    extractorVersion: inputs.extractorVersion,
    analysisPolicyVersion: ANALYSIS_POLICY_VERSION,
    measureCacheBytes: true,
    ...(inputs.supplementalFiles.length === 0
      ? {}
      : { supplementalFiles: [...inputs.supplementalFiles] }),
    options: {
      depth: "function",
      includeExternal: true,
      includeUnresolved: false,
      valueRefs: true,
    },
  };
}

function parseArguments(args: readonly string[]): BenchmarkArguments {
  if (args.length < 7 || args.length > 9) {
    throw new Error(
      "usage: tsx real-shared-base-admission-benchmark.ts "
      + "<base-root> <base-tree-oid> <base-supplemental-json|-> "
      + "<head-root> <head-tree-oid> <head-supplemental-json|-> "
      + "<cache-dir> [benchmark-version] [--cold-head]",
    );
  }
  const [
    baseRootInput,
    baseTreeInput,
    baseSupplementalInput,
    headRootInput,
    headTreeInput,
    headSupplementalInput,
    cacheInput,
    ...optional
  ] = args;
  if (
    baseRootInput === undefined
    || headRootInput === undefined
    || cacheInput === undefined
    || baseSupplementalInput === undefined
    || headSupplementalInput === undefined
  ) {
    throw new Error("benchmark arguments are incomplete");
  }
  const coldHead = optional.includes("--cold-head");
  if (optional.filter((value) => value === "--cold-head").length > 1) {
    throw new TypeError("--cold-head may be specified only once");
  }
  const versionInputs = optional.filter((value) => value !== "--cold-head");
  if (versionInputs.length > 1) {
    throw new TypeError("benchmark accepts at most one benchmark version");
  }
  const benchmarkVersion = versionInputs[0] ?? "local-source";
  if (
    benchmarkVersion.length === 0
    || benchmarkVersion.includes("\0")
    || Buffer.byteLength(benchmarkVersion) > 256
  ) {
    throw new TypeError("benchmark version must be a non-empty string of at most 256 bytes");
  }
  const baseTreeOid = requireTreeOid(baseTreeInput);
  const headTreeOid = requireTreeOid(headTreeInput);
  const baseRoot = resolve(baseRootInput);
  const headRoot = resolve(headRootInput);
  const cacheDir = resolve(cacheInput);
  return {
    baseRoot,
    baseTreeOid,
    baseSupplementalJson: supplementalPath(baseSupplementalInput),
    headRoot,
    headTreeOid,
    headSupplementalJson: supplementalPath(headSupplementalInput),
    cacheDir,
    benchmarkVersion,
    coldHead,
  };
}

function supplementalPath(value: string): string | null {
  if (value === "-") return null;
  if (!isAbsolute(value)) {
    throw new TypeError("supplemental-files JSON paths must be absolute or '-'");
  }
  return value;
}

function requireTreeOid(value: string | undefined): string {
  const oid = value?.trim().toLowerCase() ?? "";
  if (!OBJECT_OID.test(oid)) {
    throw new TypeError("benchmark tree OIDs must be Git SHA-1 or SHA-256 object ids");
  }
  return oid;
}

function admissionAuthority(): AdmissionAuthority {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicDer = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  const keyId = createHash("sha256").update(publicDer).digest("hex");
  return {
    signer: {
      version: 1,
      kind: "signer",
      keyId,
      publicKeySpki: publicDer.toString("base64"),
      privateKeyPkcs8: (
        privateKey.export({ format: "der", type: "pkcs8" }) as Buffer
      ).toString("base64"),
    },
    verifier: {
      version: 1,
      kind: "verifier",
      keyId,
      publicKeySpki: publicDer.toString("base64"),
    },
  };
}

function requireSigner(value: unknown): asserts value is RevisionShardAdmissionSigner {
  if (!isRevisionShardAdmissionCapability(value) || value.kind !== "signer") {
    throw new TypeError("base shadow worker requires an admission signer");
  }
}

function requireVerifier(value: unknown): asserts value is RevisionShardAdmissionVerifier {
  if (!isRevisionShardAdmissionCapability(value) || value.kind !== "verifier") {
    throw new TypeError("admitted head worker requires a verifier-only admission capability");
  }
}

function compareNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
