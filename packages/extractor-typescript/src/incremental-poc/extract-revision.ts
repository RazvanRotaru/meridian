import {
  lstat,
  mkdir,
  realpath,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  resolve,
} from "node:path";
import type { ExtractionResult } from "@meridian/core";
import { absoluteRoot, relativeToRoot } from "../paths";
import {
  createCrossPackageResolver,
  extractLoadedUnit,
  stitchUnitExtractions,
  type UnitExtraction,
} from "../extract-per-package";
import { perPackageWorkspace } from "../extractor";
import { loadUnitProject } from "../project-loader";
import { createExtractionProgressReporter } from "../progress";
import {
  createRevisionShardAdmissionReceipt,
  verifyRevisionShardAdmissionReceipt,
  type RevisionShardAdmissionCapability,
  type RevisionShardAdmissionReceipt,
  type RevisionShardAdmissionSigner,
} from "./admission";
import {
  canonicalJson,
  canonicalJsonSha256,
  compareCanonicalStrings,
} from "./canonical-json";
import {
  analysisPolicy,
  extractOptions,
  extractorProvenance,
  unitInputFingerprint,
  workspaceDigest,
} from "./fingerprints";
import {
  listGitTreeBlobs,
  verifyCleanCheckoutAtTree,
  verifyGitTreeInputs,
} from "./git-tree";
import {
  ImmutableCacheCollisionError,
  ImmutableCacheCorruptionError,
  immutableJsonCachePath,
  listImmutableJsonCacheAddresses,
  quarantineImmutableJsonCacheEntry,
  readImmutableJsonCache,
  writeImmutableJsonCache,
} from "./immutable-cache";
import {
  disposeExtractionDifferentialEvidence,
  comparePersistedExtractionEvidence,
  persistExtractionDifferentialEvidence,
  type PersistedExtractionDifferentialEvidence,
} from "./differential-evidence";
import {
  assertExtractionDifferential,
  type DifferentialReport,
} from "./differential";
import { exactRegularFilesEqual } from "./exact-file-parity";
import { directoryBytes, elapsedMs, peakRssBytes } from "./metrics";
import {
  POC_SHARD_VERSION,
  POC_MANIFEST_VERSION,
  type RevisionExtractionRequest,
  type RevisionExtractionRun,
  type RevisionManifest,
  type UnitInputFingerprint,
} from "./model";
import { semanticExtractionDigest } from "./semantic-normalize";
import { decodeUnitExtraction, encodeUnitExtraction, type SerializedUnitExtraction } from "./shard-codec";
import {
  isCanonicalWorkspaceResolverTrace,
  traceCrossPackageResolver,
  workspaceResolverTraceMatches,
  type WorkspaceResolverTraceEntry,
} from "./workspace-resolver-trace";

const MAX_CANDIDATE_REFERENCE_BYTES = 4 * 1024 * 1024;
const MAX_ADMISSION_RECEIPT_BYTES = 64 * 1024;
const MAX_UNIT_SHARD_BYTES = 512 * 1024 * 1024;
const MAX_CANDIDATE_VARIANTS = 128;

export interface StoredUnitShard {
  version: typeof POC_SHARD_VERSION;
  key: string;
  addressKind: "input" | "input-and-output";
  baseInputKey: string;
  inputs: UnitInputFingerprint;
  workspaceResolverTrace: WorkspaceResolverTraceEntry[];
  extraction: SerializedUnitExtraction;
}

interface StoredUnitCandidateReference {
  version: typeof POC_SHARD_VERSION;
  baseInputKey: string;
  shardKey: string;
  workspaceResolverTrace: WorkspaceResolverTraceEntry[];
}

export interface PendingUnitShard {
  key: string;
  value: StoredUnitShard;
}

export interface RevisionUnitShardEvidence {
  unitId: string;
  shardKey: string;
  value: StoredUnitShard;
}

export interface PendingRevisionExtraction {
  result: ExtractionResult;
  manifest: RevisionManifest;
  metrics: RevisionExtractionRun["metrics"];
  root: string;
  treeOid: string;
  headCommitOid: string;
  manifestAddress: string;
  pendingShards: PendingUnitShard[];
  unitShards: RevisionUnitShardEvidence[];
  measureCacheBytes: boolean;
}

export interface StagedRevisionUnitEvidence {
  unitId: string;
  shardKey: string;
  baseInputKey: string;
  payloadDigest: string;
  addressKind: StoredUnitShard["addressKind"];
  receipt: RevisionShardAdmissionReceipt | null;
}

/**
 * Disk-backed exact semantic evidence retained between the incremental and cold phases of
 * authenticated shadow admission. Complete graphs and in-memory serialized unit contributions
 * are deliberately absent.
 */
export interface StagedRevisionAdmission {
  cacheDir: string;
  manifest: RevisionManifest;
  metrics: RevisionExtractionRun["metrics"];
  root: string;
  treeOid: string;
  headCommitOid: string;
  manifestAddress: string;
  units: StagedRevisionUnitEvidence[];
  measureCacheBytes: boolean;
  semanticEvidence: PersistedExtractionDifferentialEvidence;
}

export async function extractRevisionWithCache(
  request: RevisionExtractionRequest,
): Promise<RevisionExtractionRun> {
  const pending = await extractRevisionCandidate(request);
  return publishRevisionCandidate(request.cacheDir, pending);
}

export interface RevisionShardCacheReadPolicy {
  /** When present, only a shard authenticated by the cold-oracle admission key may be reused. */
  requiredAdmission?: RevisionShardAdmissionCapability;
}

/**
 * Build a revision using admitted immutable shards, but do not publish any newly computed shard or
 * manifest. Differential callers keep this candidate quarantined until a cold oracle agrees.
 */
export async function extractRevisionCandidate(
  request: RevisionExtractionRequest,
  cachePolicy: RevisionShardCacheReadPolicy = {},
): Promise<PendingRevisionExtraction> {
  const started = process.hrtime.bigint();
  const root = absoluteRoot(request.root);
  const cacheDir = await prepareExternalCache(root, resolve(request.cacheDir));
  const checkout = await verifyCleanCheckoutAtTree(root, request.treeOid);
  const treeOid = checkout.expectedTreeOid;
  const treeInputs = await verifyGitTreeInputs(root, await listGitTreeBlobs(root, treeOid));
  const treeBlobs = treeInputs.regularBlobs
    .sort((left, right) => compareCanonicalStrings(left.path, right.path));
  const policy = analysisPolicy(request.options);
  const supplementalFiles = exactSupplementalFiles(request.supplementalFiles, treeBlobs);
  const options = extractOptions(root, policy, {
    supplementalFiles,
    onProgress: request.onProgress,
  });
  const workspace = perPackageWorkspace(options);
  if (workspace === null) {
    throw new Error("incremental extraction POC requires an automatically discovered multi-package workspace");
  }

  const provenance = extractorProvenance(request);
  const workspaceHash = workspaceDigest(workspace);
  const resolver = createCrossPackageResolver(workspace, root);
  const progressReporter = createExtractionProgressReporter(options);
  const extractions: UnitExtraction[] = [];
  const manifestUnits: RevisionManifest["units"] = [];
  const pendingShards: PendingUnitShard[] = [];
  const unitShards: RevisionUnitShardEvidence[] = [];
  let fingerprintMs = 0;
  let unitExtractionMs = 0;
  let reusedUnits = 0;
  let reuseEligibleUnits = 0;
  let conservativelyRebuiltUnits = 0;
  let totalSourceBytes = 0;
  let reusedSourceBytes = 0;

  for (const [unitIndex, unit] of workspace.units.entries()) {
    const progressUnit = {
      current: unitIndex + 1,
      total: workspace.units.length,
      path: unit.dir || ".",
    };
    progressReporter?.({
      language: "typescript",
      phase: "project-load",
      unit: progressUnit,
      sourceFile: null,
    });
    const fingerprintStarted = process.hrtime.bigint();
    const loaded = loadUnitProject(root, unit, options, workspace.memberPaths);
    const inputs = unitInputFingerprint({
      root,
      unit,
      loaded,
      treeBlobs,
      policy,
      provenance,
    });
    const baseInputKey = canonicalJsonSha256(inputs);
    if (inputs.reuseEligibility.eligible) {
      reuseEligibleUnits += 1;
    } else {
      conservativelyRebuiltUnits += 1;
    }
    const sourceBytes = inputs.sourceBlobs.reduce((total, blob) => total + blob.byteSize, 0);
    totalSourceBytes += sourceBytes;
    fingerprintMs += elapsedMs(fingerprintStarted);
    const cached = inputs.reuseEligibility.eligible
      ? await readUnitShardCandidate(
          cacheDir,
          baseInputKey,
          inputs,
          resolver,
          root,
          cachePolicy.requiredAdmission,
        )
      : null;
    let extraction: UnitExtraction;
    let shardKey = baseInputKey;
    let effectiveReuseEligibility = inputs.reuseEligibility;
    if (cached !== null) {
      extraction = cached.extraction;
      shardKey = cached.shardKey;
    } else {
      progressReporter?.({
        language: "typescript",
        phase: "structure",
        unit: progressUnit,
        sourceFile: null,
      });
      const extractionStarted = process.hrtime.bigint();
      const tracedResolver = traceCrossPackageResolver(resolver, root);
      extraction = extractLoadedUnit(
        unit,
        loaded,
        options,
        tracedResolver.resolver,
        policy.depth,
        progressUnit,
        progressReporter,
      );
      unitExtractionMs += elapsedMs(extractionStarted);
      const inputsAfterExtraction = unitInputFingerprint({
        root,
        unit,
        loaded,
        treeBlobs,
        policy,
        provenance,
      });
      if (canonicalJson(inputsAfterExtraction) !== canonicalJson(inputs)) {
        throw new Error(`unit inputs changed during extraction: ${unit.dir || "."}`);
      }
      const serialized = encodeUnitExtraction(extraction);
      // Exercise the exact persisted representation even on a miss. A shadow comparison therefore
      // validates the codec before this shard can be admitted for a later revision.
      extraction = decodeUnitExtraction(serialized);
      const workspaceResolverTrace = tracedResolver.snapshot();
      const traceReusable = tracedResolver.isReusable();
      if (inputs.reuseEligibility.eligible && !traceReusable) {
        effectiveReuseEligibility = {
          eligible: false,
          reasons: ["non-reusable-workspace-resolver-trace"],
        };
        reuseEligibleUnits -= 1;
        conservativelyRebuiltUnits += 1;
      }
      const addressKind = inputs.reuseEligibility.eligible && traceReusable
        ? "input"
        : "input-and-output";
      shardKey = addressKind === "input"
        ? reusableShardAddress(inputs, workspaceResolverTrace)
        : nonReusableShardAddress(inputs, workspaceResolverTrace, serialized);
      pendingShards.push({
        key: shardKey,
        value: {
          version: POC_SHARD_VERSION,
          key: shardKey,
          addressKind,
          baseInputKey,
          inputs,
          workspaceResolverTrace,
          extraction: serialized,
        },
      });
    }
    const storedShard = cached?.shard ?? pendingShards.at(-1)?.value;
    if (storedShard === undefined || storedShard.key !== shardKey) {
      throw new Error(`unit shard evidence was not captured: ${unit.dir || "."}`);
    }
    unitShards.push({
      unitId: unit.dir || ".",
      shardKey,
      value: storedShard,
    });
    if (cached !== null) {
      reusedUnits += 1;
      reusedSourceBytes += sourceBytes;
    }
    extractions.push(extraction);
    manifestUnits.push({
      unitId: unit.dir || ".",
      shardKey,
      sourceBlobs: inputs.sourceBlobs,
      reuseEligibility: effectiveReuseEligibility,
    });
  }

  const stitchStarted = process.hrtime.bigint();
  const result = stitchUnitExtractions(
    extractions,
    options,
    policy.depth,
    progressReporter === undefined
      ? undefined
      : (phase) => progressReporter({
          language: "typescript",
          phase,
          unit: null,
          sourceFile: null,
        }),
  );
  const stitchMs = elapsedMs(stitchStarted);
  const verifiedAfter = await verifyCleanCheckoutAtTree(root, treeOid);
  if (verifiedAfter.headCommitOid !== checkout.headCommitOid) {
    throw new Error("checkout commit changed during incremental extraction");
  }
  const manifest: RevisionManifest = {
    version: POC_MANIFEST_VERSION,
    treeOid,
    workspaceDigest: workspaceHash,
    policy,
    provenance,
    units: manifestUnits,
    normalizedResultDigest: semanticExtractionDigest(result),
  };
  const manifestAddress = canonicalJsonSha256(manifest);
  const totalUnits = workspace.units.length;
  return {
    result,
    manifest,
    root,
    treeOid,
    headCommitOid: checkout.headCommitOid,
    manifestAddress,
    pendingShards,
    unitShards,
    measureCacheBytes: request.measureCacheBytes === true,
    metrics: {
      processId: process.pid,
      totalMs: elapsedMs(started),
      fingerprintMs,
      unitExtractionMs,
      stitchMs,
      totalUnits,
      reusedUnits,
      rebuiltUnits: totalUnits - reusedUnits,
      reuseRatio: totalUnits === 0 ? 0 : reusedUnits / totalUnits,
      totalSourceBytes,
      reusedSourceBytes,
      byteReuseRatio: totalSourceBytes === 0 ? 0 : reusedSourceBytes / totalSourceBytes,
      reuseEligibleUnits,
      conservativelyRebuiltUnits,
      peakRssBytes: peakRssBytes(),
      cacheBytes: request.measureCacheBytes === true ? directoryBytes(cacheDir) : null,
    },
  };
}

/** Publish only after the candidate's caller has completed any required semantic oracle. */
export async function publishRevisionCandidate(
  cacheDirInput: string,
  candidate: PendingRevisionExtraction,
): Promise<RevisionExtractionRun> {
  const cacheDir = await prepareExternalCache(candidate.root, resolve(cacheDirInput));
  const verified = await verifyCleanCheckoutAtTree(candidate.root, candidate.treeOid);
  if (verified.headCommitOid !== candidate.headCommitOid) {
    throw new Error("checkout commit changed before incremental cache publication");
  }
  for (const pending of candidate.pendingShards) {
    await publishPendingUnitShard(cacheDir, pending);
    if (pending.value.addressKind === "input") {
      await publishCandidateReference(cacheDir, pending);
    }
  }
  const manifestWrite = await writeImmutableJsonCache(
    manifestRoot(cacheDir, candidate.treeOid),
    candidate.manifestAddress,
    candidate.manifest,
    { trustedRoot: cacheDir },
  );
  return {
    result: candidate.result,
    manifest: candidate.manifest,
    manifestPath: manifestWrite.path,
    metrics: {
      ...candidate.metrics,
      cacheBytes: candidate.measureCacheBytes ? directoryBytes(cacheDir) : null,
    },
  };
}

/**
 * Persist immutable bytes without making them reusable.
 *
 * No admission receipt or revision manifest is written here. A process failure can therefore
 * leave only unadmitted content-addressed data, which admitted mode must ignore. The caller may
 * release the complete incremental graph and unit objects before constructing the cold oracle.
 */
export async function stageRevisionCandidateForAdmission(
  cacheDirInput: string,
  candidate: PendingRevisionExtraction,
  signer: RevisionShardAdmissionSigner,
): Promise<StagedRevisionAdmission> {
  const cacheDir = await prepareExternalCache(candidate.root, resolve(cacheDirInput));
  const verified = await verifyCleanCheckoutAtTree(candidate.root, candidate.treeOid);
  if (verified.headCommitOid !== candidate.headCommitOid) {
    throw new Error("checkout commit changed before incremental cache staging");
  }
  const semanticEvidence = persistExtractionDifferentialEvidence(candidate.result);
  try {
    for (const pending of candidate.pendingShards) {
      await publishPendingUnitShard(cacheDir, pending, signer);
      if (pending.value.addressKind === "input") {
        await publishCandidateReference(cacheDir, pending, signer);
      }
    }
    const units = candidate.unitShards.map((unit): StagedRevisionUnitEvidence => {
      const payloadDigest = canonicalJsonSha256(unit.value);
      return {
        unitId: unit.unitId,
        shardKey: unit.shardKey,
        baseInputKey: unit.value.baseInputKey,
        payloadDigest,
        addressKind: unit.value.addressKind,
        receipt: unit.value.addressKind === "input"
          ? createRevisionShardAdmissionReceipt(signer, {
              shardKey: unit.shardKey,
              baseInputKey: unit.value.baseInputKey,
              payloadDigest,
            })
          : null,
      };
    });
    return {
      cacheDir,
      manifest: candidate.manifest,
      metrics: candidate.metrics,
      root: candidate.root,
      treeOid: candidate.treeOid,
      headCommitOid: candidate.headCommitOid,
      manifestAddress: candidate.manifestAddress,
      units,
      measureCacheBytes: candidate.measureCacheBytes,
      semanticEvidence,
    };
  } catch (error) {
    disposeExtractionDifferentialEvidence(semanticEvidence);
    throw error;
  }
}

/** Require exact ordered unit identities and literal canonical shard-envelope bytes. */
async function assertStagedRevisionUnitParity(
  staged: StagedRevisionAdmission,
  coldCacheDirInput: string,
  cold: PendingRevisionExtraction,
): Promise<void> {
  if (staged.units.length !== cold.unitShards.length) {
    throw new Error("incremental unit shards differ from the empty-cache cold oracle");
  }
  const coldCacheDir = await prepareExternalCache(cold.root, resolve(coldCacheDirInput));
  for (const [index, incrementalUnit] of staged.units.entries()) {
    const coldUnit = cold.unitShards[index];
    if (
      coldUnit === undefined
      || incrementalUnit.unitId !== coldUnit.unitId
      || incrementalUnit.shardKey !== coldUnit.shardKey
      || incrementalUnit.baseInputKey !== coldUnit.value.baseInputKey
      || incrementalUnit.addressKind !== coldUnit.value.addressKind
    ) {
      throw new Error(
        `incremental unit shard differs from the empty-cache cold oracle: ${incrementalUnit.unitId}`,
      );
    }
    const exact = await exactRegularFilesEqual(
      immutableJsonCachePath(shardRoot(staged.cacheDir), incrementalUnit.shardKey),
      immutableJsonCachePath(shardRoot(coldCacheDir), coldUnit.shardKey),
      MAX_UNIT_SHARD_BYTES,
    );
    if (!exact) {
      throw new Error(
        `incremental unit shard differs from the empty-cache cold oracle: ${incrementalUnit.unitId}`,
      );
    }
  }
}

/** Idempotently release private shadow evidence after success or any pre-publication failure. */
export function discardStagedRevisionAdmissionEvidence(
  staged: StagedRevisionAdmission,
): void {
  try {
    disposeExtractionDifferentialEvidence(staged.semanticEvidence);
  } catch (error) {
    if (filesystemErrorCode(error) !== "ENOENT") throw error;
  }
}

export interface StagedRevisionAdmissionPublication {
  run: RevisionExtractionRun;
  differential: DifferentialReport;
}

/**
 * Prove exact cold-oracle parity and immediately make the same staged bytes reusable.
 *
 * Receipt publication is intentionally inseparable from the semantic, manifest, and unit-shard
 * comparisons. Generic candidate publication has no admission capability.
 */
export async function publishStagedRevisionAdmission(
  cacheDirInput: string,
  staged: StagedRevisionAdmission,
  signer: RevisionShardAdmissionSigner,
  coldCacheDirInput: string,
  cold: PendingRevisionExtraction,
): Promise<StagedRevisionAdmissionPublication> {
  try {
    if (
      staged.root !== cold.root
      || staged.treeOid !== cold.treeOid
      || staged.headCommitOid !== cold.headCommitOid
    ) {
      throw new Error("staged revision identity differs from the empty-cache cold oracle");
    }
    const differential = await comparePersistedExtractionEvidence(
      staged.semanticEvidence,
      cold.result,
    );
    assertExtractionDifferential(differential);
    if (canonicalJson(staged.manifest) !== canonicalJson(cold.manifest)) {
      throw new Error("tree-bound revision manifests disagree after semantic differential parity");
    }
    await assertStagedRevisionUnitParity(staged, coldCacheDirInput, cold);

    const cacheDir = await prepareExternalCache(staged.root, resolve(cacheDirInput));
    const verified = await verifyCleanCheckoutAtTree(staged.root, staged.treeOid);
    if (verified.headCommitOid !== staged.headCommitOid) {
      throw new Error("checkout commit changed before incremental cache admission");
    }
    for (const unit of staged.units) {
      if (unit.receipt === null) continue;
      const shard = await readImmutableJsonCache<StoredUnitShard>(
        shardRoot(cacheDir),
        unit.shardKey,
        {
          trustedRoot: cacheDir,
          maxEntryBytes: MAX_UNIT_SHARD_BYTES,
        },
      );
      if (
        shard === null
        || shard.value.key !== unit.shardKey
        || shard.value.baseInputKey !== unit.baseInputKey
        || shard.value.addressKind !== "input"
        || shard.payloadDigest !== unit.payloadDigest
        || storedShardAddress(shard.value) !== unit.shardKey
        || !verifyRevisionShardAdmissionReceipt(signer, unit.receipt, {
          shardKey: unit.shardKey,
          baseInputKey: unit.baseInputKey,
          payloadDigest: unit.payloadDigest,
        })
      ) {
        throw new Error(`staged unit shard changed before admission: ${unit.unitId}`);
      }
      await publishAdmissionReceipt(cacheDir, signer, unit.receipt);
    }
    const manifestWrite = await writeImmutableJsonCache(
      manifestRoot(cacheDir, staged.treeOid),
      staged.manifestAddress,
      staged.manifest,
      { trustedRoot: cacheDir },
    );
    return {
      run: {
        result: cold.result,
        manifest: staged.manifest,
        manifestPath: manifestWrite.path,
        metrics: {
          ...staged.metrics,
          cacheBytes: staged.measureCacheBytes ? directoryBytes(cacheDir) : null,
        },
      },
      differential,
    };
  } finally {
    discardStagedRevisionAdmissionEvidence(staged);
  }
}

async function readUnitShardCandidate(
  cacheDir: string,
  baseInputKey: string,
  inputs: UnitInputFingerprint,
  resolver: ReturnType<typeof createCrossPackageResolver>,
  root: string,
  requiredAdmission?: RevisionShardAdmissionCapability,
): Promise<{ shardKey: string; extraction: UnitExtraction; shard: StoredUnitShard } | null> {
  const shardKeys = await candidateShardKeys(cacheDir, baseInputKey);
  if (shardKeys === null) return null;
  let match: StoredUnitCandidateReference | null = null;
  for (const shardKey of shardKeys) {
    let reference;
    try {
      reference = await readImmutableJsonCache<StoredUnitCandidateReference>(
        candidateRoot(cacheDir, baseInputKey),
        shardKey,
        {
          trustedRoot: cacheDir,
          maxEntryBytes: MAX_CANDIDATE_REFERENCE_BYTES,
        },
      );
    } catch {
      return null;
    }
    if (reference === null
      || reference.value.version !== POC_SHARD_VERSION
      || reference.value.baseInputKey !== baseInputKey
      || reference.value.shardKey !== shardKey
      || !isCanonicalWorkspaceResolverTrace(reference.value.workspaceResolverTrace)
      || reusableShardAddress(inputs, reference.value.workspaceResolverTrace) !== shardKey) {
      return null;
    }
    if (!workspaceResolverTraceMatches(
      reference.value.workspaceResolverTrace,
      resolver,
      root,
    )) {
      continue;
    }
    if (match !== null && match.shardKey !== shardKey) {
      return null;
    }
    match = reference.value;
  }
  if (match === null) return null;

  let hit;
  try {
    hit = await readImmutableJsonCache<StoredUnitShard>(
      shardRoot(cacheDir),
      match.shardKey,
      {
        trustedRoot: cacheDir,
        maxEntryBytes: MAX_UNIT_SHARD_BYTES,
      },
    );
  } catch (error) {
    if (requiredAdmission === undefined) throw error;
    return null;
  }
  if (hit === null) return null;
  const shard = hit.value;
  if (shard.version !== POC_SHARD_VERSION
    || shard.key !== match.shardKey
    || shard.addressKind !== "input"
    || shard.baseInputKey !== baseInputKey
    || !shard.inputs.reuseEligibility.eligible
    || !isCanonicalWorkspaceResolverTrace(shard.workspaceResolverTrace)
    || canonicalJson(shard.workspaceResolverTrace) !== canonicalJson(match.workspaceResolverTrace)
    || storedShardAddress(shard) !== match.shardKey
    || canonicalJsonSha256(shard.inputs) !== baseInputKey
    || canonicalJson(shard.inputs) !== canonicalJson(inputs)) {
    if (requiredAdmission === undefined) {
      throw new Error(`immutable unit shard identity mismatch: ${match.shardKey}`);
    }
    return null;
  }
  if (requiredAdmission !== undefined) {
    let receipt;
    try {
      receipt = await readImmutableJsonCache<RevisionShardAdmissionReceipt>(
        admissionRoot(cacheDir, requiredAdmission),
        match.shardKey,
        {
          trustedRoot: cacheDir,
          maxEntryBytes: MAX_ADMISSION_RECEIPT_BYTES,
        },
      );
    } catch {
      return null;
    }
    if (receipt === null || !verifyRevisionShardAdmissionReceipt(
      requiredAdmission,
      receipt.value,
      {
        shardKey: match.shardKey,
        baseInputKey,
        payloadDigest: hit.payloadDigest,
      },
    )) {
      return null;
    }
  }
  let extraction: UnitExtraction;
  try {
    extraction = decodeUnitExtraction(shard.extraction);
  } catch (error) {
    if (requiredAdmission === undefined) throw error;
    return null;
  }
  return {
    shardKey: match.shardKey,
    extraction,
    shard,
  };
}

function storedShardAddress(shard: StoredUnitShard): string {
  return shard.addressKind === "input"
    ? reusableShardAddress(shard.inputs, shard.workspaceResolverTrace)
    : nonReusableShardAddress(
        shard.inputs,
        shard.workspaceResolverTrace,
        shard.extraction,
      );
}

function reusableShardAddress(
  inputs: UnitInputFingerprint,
  workspaceResolverTrace: readonly WorkspaceResolverTraceEntry[],
): string {
  return canonicalJsonSha256({
    version: POC_SHARD_VERSION,
    kind: "reusable-unit-input",
    inputs,
    workspaceResolverTrace,
  });
}

function nonReusableShardAddress(
  inputs: UnitInputFingerprint,
  workspaceResolverTrace: readonly WorkspaceResolverTraceEntry[],
  extraction: SerializedUnitExtraction,
): string {
  return canonicalJsonSha256({
    version: POC_SHARD_VERSION,
    kind: "non-reusable-unit-output",
    inputs,
    workspaceResolverTrace,
    extraction,
  });
}

async function candidateShardKeys(
  cacheDir: string,
  baseInputKey: string,
): Promise<string[] | null> {
  try {
    return await listImmutableJsonCacheAddresses(
      candidateRoot(cacheDir, baseInputKey),
      {
        trustedRoot: cacheDir,
        maxAddresses: MAX_CANDIDATE_VARIANTS,
      },
    );
  } catch {
    return null;
  }
}

async function prepareExternalCache(root: string, cacheDir: string): Promise<string> {
  const missingSegments: string[] = [];
  let ancestor = cacheDir;
  for (;;) {
    try {
      await lstat(ancestor);
      break;
    } catch (error) {
      if (filesystemErrorCode(error) !== "ENOENT") throw error;
      const parent = dirname(ancestor);
      if (parent === ancestor) throw error;
      missingSegments.unshift(basename(ancestor));
      ancestor = parent;
    }
  }
  const canonicalAncestor = await realpath(ancestor);
  requireOutsideCheckout(root, resolve(canonicalAncestor, ...missingSegments));
  await mkdir(cacheDir, { recursive: true });
  const canonicalCache = await realpath(cacheDir);
  requireOutsideCheckout(root, canonicalCache);
  return canonicalCache;
}

function requireOutsideCheckout(root: string, cacheDir: string): void {
  const relative = relativeToRoot(root, cacheDir);
  if (relative !== ".." && !relative.startsWith("../")) {
    throw new Error("incremental POC cache must be outside the exact-tree checkout");
  }
}

function exactSupplementalFiles(
  requested: readonly string[] | undefined,
  treeBlobs: readonly { path: string }[],
): string[] | undefined {
  if (requested === undefined || requested.length === 0) return undefined;
  const trackedPaths = new Set(treeBlobs.map((blob) => blob.path));
  const normalized = new Set<string>();
  for (const path of requested) {
    // Canonical workspace scope only consults TypeScript paths. Non-TypeScript changed paths are
    // not scope hints; any file actually observed by the compiler/config resolver is fingerprinted
    // through the unit's explicit program, config, manifest, and lookup inputs.
    if (!/\.tsx?$/.test(path)) continue;
    if (
      path.length === 0
      || isAbsolute(path)
      || path.includes("\\")
      || path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
    ) {
      throw new Error(`supplemental file is not an exact root-relative Git path: ${path}`);
    }
    if (!trackedPaths.has(path)) {
      throw new Error(`supplemental file is not a regular blob in the exact Git tree: ${path}`);
    }
    normalized.add(path);
  }
  return normalized.size === 0
    ? undefined
    : [...normalized].sort(compareCanonicalStrings);
}

function shardRoot(cacheDir: string): string {
  return resolve(cacheDir, "shards");
}

function candidateRoot(cacheDir: string, baseInputKey: string): string {
  return resolve(cacheDir, "candidates", baseInputKey);
}

function manifestRoot(cacheDir: string, treeOid: string): string {
  return resolve(cacheDir, "manifests", treeOid);
}

function admissionRoot(
  cacheDir: string,
  admission: RevisionShardAdmissionCapability,
): string {
  return resolve(cacheDir, "admissions", admission.keyId);
}

async function publishPendingUnitShard(
  cacheDir: string,
  pending: PendingUnitShard,
  signer?: RevisionShardAdmissionSigner,
): Promise<void> {
  try {
    await writeImmutableJsonCache<StoredUnitShard>(
      shardRoot(cacheDir),
      pending.key,
      pending.value,
      { trustedRoot: cacheDir },
    );
    return;
  } catch (error) {
    if (signer === undefined || !isRepairableImmutableEntryError(error)) throw error;
    if (await hasValidAdmissionForStoredShard(cacheDir, signer, pending.key)) {
      throw error;
    }
  }
  await quarantineImmutableJsonCacheEntry(
    shardRoot(cacheDir),
    pending.key,
    {
      trustedRoot: cacheDir,
      quarantineRoot: repairTrashRoot(cacheDir),
    },
  );
  await quarantineImmutableJsonCacheEntry(
    admissionRoot(cacheDir, signer!),
    pending.key,
    {
      trustedRoot: cacheDir,
      quarantineRoot: repairTrashRoot(cacheDir),
    },
  );
  await writeImmutableJsonCache<StoredUnitShard>(
    shardRoot(cacheDir),
    pending.key,
    pending.value,
    { trustedRoot: cacheDir },
  );
}

async function publishCandidateReference(
  cacheDir: string,
  pending: PendingUnitShard,
  signer?: RevisionShardAdmissionSigner,
): Promise<void> {
  const root = candidateRoot(cacheDir, pending.value.baseInputKey);
  const value: StoredUnitCandidateReference = {
    version: POC_SHARD_VERSION,
    baseInputKey: pending.value.baseInputKey,
    shardKey: pending.key,
    workspaceResolverTrace: pending.value.workspaceResolverTrace,
  };
  try {
    await writeImmutableJsonCache(root, pending.key, value, { trustedRoot: cacheDir });
    return;
  } catch (error) {
    if (signer === undefined || !isRepairableImmutableEntryError(error)) throw error;
  }
  await quarantineImmutableJsonCacheEntry(root, pending.key, {
    trustedRoot: cacheDir,
    quarantineRoot: repairTrashRoot(cacheDir),
  });
  await writeImmutableJsonCache(root, pending.key, value, { trustedRoot: cacheDir });
}

async function publishAdmissionReceipt(
  cacheDir: string,
  signer: RevisionShardAdmissionSigner,
  receipt: RevisionShardAdmissionReceipt,
): Promise<void> {
  const root = admissionRoot(cacheDir, signer);
  try {
    await writeImmutableJsonCache(root, receipt.shardKey, receipt, {
      trustedRoot: cacheDir,
    });
    return;
  } catch (error) {
    if (!isRepairableImmutableEntryError(error)) throw error;
  }
  await quarantineImmutableJsonCacheEntry(root, receipt.shardKey, {
    trustedRoot: cacheDir,
    quarantineRoot: repairTrashRoot(cacheDir),
  });
  await writeImmutableJsonCache(root, receipt.shardKey, receipt, {
    trustedRoot: cacheDir,
  });
}

async function hasValidAdmissionForStoredShard(
  cacheDir: string,
  signer: RevisionShardAdmissionSigner,
  shardKey: string,
): Promise<boolean> {
  try {
    const shard = await readImmutableJsonCache<StoredUnitShard>(
      shardRoot(cacheDir),
      shardKey,
      { trustedRoot: cacheDir, maxEntryBytes: MAX_UNIT_SHARD_BYTES },
    );
    if (shard === null) return false;
    const receipt = await readImmutableJsonCache<RevisionShardAdmissionReceipt>(
      admissionRoot(cacheDir, signer),
      shardKey,
      { trustedRoot: cacheDir, maxEntryBytes: MAX_ADMISSION_RECEIPT_BYTES },
    );
    return receipt !== null && verifyRevisionShardAdmissionReceipt(
      signer,
      receipt.value,
      {
        shardKey,
        baseInputKey: shard.value.baseInputKey,
        payloadDigest: shard.payloadDigest,
      },
    );
  } catch {
    return false;
  }
}

function isRepairableImmutableEntryError(error: unknown): boolean {
  return error instanceof ImmutableCacheCollisionError
    || error instanceof ImmutableCacheCorruptionError;
}

function repairTrashRoot(cacheDir: string): string {
  return resolve(cacheDir, ".retention-trash", "repair");
}

function filesystemErrorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;
}
