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
  unitInputFingerprintWithCatalogs,
  workspaceDigest,
  type UnitInputFingerprintProgressPosition,
} from "./fingerprints";
import {
  listGitTreeBlobs,
  revalidateAdmittedUnitInputsAtExactTree,
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
import { withEphemeralPairUnitLock } from "./ephemeral-pair-cache";
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
  type RevisionUnitManifest,
  type UnitInputFingerprint,
  unitFingerprint,
} from "./model";
import {
  buildRevisionRequestFingerprintV1,
  createRevisionManifestAdmissionReceipt,
  verifyRevisionManifestAdmissionReceipt,
  type RevisionManifestAdmissionReceipt,
} from "./exact-revision-manifest";
import { semanticExtractionDigest } from "./semantic-normalize";
import { decodeUnitExtraction, encodeUnitExtraction, type SerializedUnitExtraction } from "./shard-codec";
import {
  createSemanticRegionAdmissionReceipt,
  publishPendingSemanticRegionShard,
  publishSemanticRegionAdmissionReceipt,
  publishSemanticRegionContext,
  readSemanticRegionShard,
  type PendingSemanticRegionShard,
  type StoredSemanticRegionContextV2,
} from "./semantic-region-cache";
import {
  extractLoadedUnitWithSemanticRegions,
  type SemanticRegionExtractionEvidence,
  type SemanticRegionUnitExtraction,
} from "./semantic-region-extraction";
import { addressSemanticRegions } from "./semantic-region-inputs";
import {
  isCanonicalWorkspaceResolverTrace,
  traceCrossPackageResolver,
  workspaceResolverTraceMatches,
  type WorkspaceResolverTraceEntry,
} from "./workspace-resolver-trace";

const MAX_CANDIDATE_REFERENCE_BYTES = 4 * 1024 * 1024;
const MAX_ADMISSION_RECEIPT_BYTES = 64 * 1024;
const MAX_UNIT_SHARD_BYTES = 512 * 1024 * 1024;
const MAX_REVISION_MANIFEST_BYTES = 64 * 1024 * 1024;
const MAX_CANDIDATE_VARIANTS = 128;
const EXACT_REVISION_HERMETIC_POLICY_VERSION =
  "tracked-tree-direct-observation-revalidation-v1";
const SHA256_DIGEST = /^[a-f0-9]{64}$/;
const GIT_OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

export interface StoredUnitShard {
  version: typeof POC_SHARD_VERSION;
  key: string;
  addressKind: "input" | "input-and-output";
  baseInputKey: string;
  inputs: UnitInputFingerprint;
  /** Exact revision-wide workspace input used by the persisted semantic-plan context. */
  workspaceDigest: string;
  workspaceResolverTrace: WorkspaceResolverTraceEntry[];
  semanticPlan: StoredSemanticPlanManifestMetadata;
  extraction: SerializedUnitExtraction;
}

type StoredSemanticPlanManifestMetadata = Pick<
  RevisionUnitManifest,
  | "semanticPlanKind"
  | "semanticPlanReasons"
  | "semanticRegionContextDigest"
  | "semanticRegions"
>;

interface StoredUnitCandidateReference {
  version: typeof POC_SHARD_VERSION;
  baseInputKey: string;
  shardKey: string;
  workspaceDigest: string;
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
  requestKey: string;
  pendingShards: PendingUnitShard[];
  unitShards: RevisionUnitShardEvidence[];
  semanticRegionContexts: StoredSemanticRegionContextV2[];
  pendingSemanticRegions: PendingSemanticRegionShard[];
  semanticRegionEvidence: SemanticRegionExtractionEvidence[];
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

export interface StagedSemanticRegionEvidence {
  unitId: string;
  regionId: string;
  key: string;
  baseInputKey: string;
  payloadDigest: string;
  receipt: RevisionShardAdmissionReceipt;
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
  requestKey: string;
  units: StagedRevisionUnitEvidence[];
  semanticRegionContextKeys: string[];
  semanticRegions: StagedSemanticRegionEvidence[];
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
  /**
   * Private, request-scoped exchange shared only by the two exact PR revision workers.
   *
   * A miss is still computed by the canonical unit extractor. The complete input fingerprint and
   * observed resolver trace address its immutable contribution, while a per-input filesystem lock
   * ensures an identical simultaneous miss executes once. Nothing in this directory is admitted
   * to the persistent cache or survives the enclosing revision-pair request.
   */
  ephemeralPairCacheDir?: string;
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
  const pairCacheDir = cachePolicy.ephemeralPairCacheDir === undefined
    ? null
    : await prepareExternalCache(root, resolve(cachePolicy.ephemeralPairCacheDir));
  if (pairCacheDir === cacheDir) {
    throw new Error("ephemeral revision-pair cache must differ from the persistent shard cache");
  }
  const checkoutAndTreeInputStarted = process.hrtime.bigint();
  const checkout = await verifyCleanCheckoutAtTree(root, request.treeOid);
  const treeOid = checkout.expectedTreeOid;
  const treeInputs = await verifyGitTreeInputs(root, await listGitTreeBlobs(root, treeOid));
  const treeBlobs = treeInputs.regularBlobs
    .sort((left, right) => compareCanonicalStrings(left.path, right.path));
  // The exact tree is revision-wide. Rebuilding this same large path index in every fingerprint
  // subsection and for every workspace unit was pure overhead.
  const treeBlobIndex = new Map(treeBlobs.map((blob) => [blob.path, blob]));
  const checkoutAndTreeInputMs = elapsedMs(checkoutAndTreeInputStarted);
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
  const requestIdentity = buildRevisionRequestFingerprintV1({
    treeOid,
    supplementalFiles: supplementalFiles ?? [],
    policy,
    provenance,
    workspaceDigest: workspaceHash,
    hermeticPolicyVersion: EXACT_REVISION_HERMETIC_POLICY_VERSION,
  });
  let exactManifestLookupMs = 0;
  if (cachePolicy.requiredAdmission !== undefined) {
    const lookupStarted = process.hrtime.bigint();
    const exactManifestHit = await readAdmittedExactRevisionManifest({
      started,
      request,
      requestKey: requestIdentity.requestKey,
      root,
      cacheDir,
      treeOid,
      headCommitOid: checkout.headCommitOid,
      checkoutAndTreeInputMs,
      treeBlobs,
      workspace,
      workspaceHash,
      policy,
      provenance,
      options,
      resolver,
      progressReporter,
      admission: cachePolicy.requiredAdmission,
    });
    exactManifestLookupMs = elapsedMs(lookupStarted);
    if (exactManifestHit !== null) {
      exactManifestHit.metrics.profile.cacheLookupMs = exactManifestLookupMs;
      exactManifestHit.metrics.totalMs = elapsedMs(started);
      return exactManifestHit;
    }
  }
  const extractions: UnitExtraction[] = [];
  const manifestUnits: RevisionManifest["units"] = [];
  const pendingShards: PendingUnitShard[] = [];
  const unitShards: RevisionUnitShardEvidence[] = [];
  const semanticRegionContexts = new Map<string, StoredSemanticRegionContextV2>();
  const pendingSemanticRegions: PendingSemanticRegionShard[] = [];
  const semanticRegionEvidence: SemanticRegionExtractionEvidence[] = [];
  let fingerprintMs = 0;
  let unitExtractionMs = 0;
  let cacheLookupMs = exactManifestLookupMs;
  let semanticAddressingMs = 0;
  let postExtractionFingerprintMs = 0;
  let shardCodecMs = 0;
  let ephemeralPublicationMs = 0;
  let reusedUnits = 0;
  let reuseEligibleUnits = 0;
  let conservativelyRebuiltUnits = 0;
  let totalSourceBytes = 0;
  let reusedSourceBytes = 0;
  let totalSemanticRegions = 0;
  let reusedSemanticRegions = 0;
  let rebuiltSemanticRegions = 0;
  let semanticRegionSourceBytes = 0;
  let reusedSemanticRegionSourceBytes = 0;
  let semanticRegionFallbackUnits = 0;

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
    const reportProgramInputProgress = progressReporter === undefined
      ? undefined
      : (position: UnitInputFingerprintProgressPosition | null) => progressReporter({
          language: "typescript",
          phase: "input-proof",
          unit: progressUnit,
          sourceFile: position === null
            ? null
            : inputProofProgressPosition(root, position),
        });
    progressReporter?.({
      language: "typescript",
      phase: "input-proof",
      unit: progressUnit,
      sourceFile: null,
    });
    const fingerprinted = unitInputFingerprintWithCatalogs({
      root,
      unit,
      loaded,
      treeBlobs,
      treeBlobIndex,
      policy,
      provenance,
      onProgramInputProgress: reportProgramInputProgress,
    });
    const inputs = fingerprinted.fingerprint;
    const baseInputKey = canonicalJsonSha256(inputs);
    if (inputs.reuseEligibility.eligible) {
      reuseEligibleUnits += 1;
    } else {
      conservativelyRebuiltUnits += 1;
    }
    const sourceBytes = inputs.sourceBlobs.reduce((total, blob) => total + blob.byteSize, 0);
    totalSourceBytes += sourceBytes;
    fingerprintMs += elapsedMs(fingerprintStarted);
    let cached = null;
    if (inputs.reuseEligibility.eligible) {
      const cacheLookupStarted = process.hrtime.bigint();
      cached = await readUnitShardCandidate(
        cacheDir,
        baseInputKey,
        inputs,
        workspaceHash,
        resolver,
        root,
        cachePolicy.requiredAdmission,
      );
      cacheLookupMs += elapsedMs(cacheLookupStarted);
    }
    let cachedFromEphemeralPair = false;
    if (cached === null && inputs.reuseEligibility.eligible && pairCacheDir !== null) {
      const cacheLookupStarted = process.hrtime.bigint();
      cached = await readUnitShardCandidate(
        pairCacheDir,
        baseInputKey,
        inputs,
        workspaceHash,
        resolver,
        root,
      );
      cacheLookupMs += elapsedMs(cacheLookupStarted);
      cachedFromEphemeralPair = cached !== null;
    }

    let extraction: UnitExtraction;
    let shardKey = baseInputKey;
    let effectiveReuseEligibility = inputs.reuseEligibility;
    let pending: PendingUnitShard | null = null;
    let builtSemanticRegions: SemanticRegionUnitExtraction | null = null;
    const buildUnit = async (): Promise<{
      extraction: UnitExtraction;
      pending: PendingUnitShard;
      effectiveReuseEligibility: UnitInputFingerprint["reuseEligibility"];
      semanticRegions: SemanticRegionUnitExtraction;
    }> => {
      // Full-unit hits already carry the exact, cold-oracle-admitted semantic-plan manifest
      // metadata. Compiler observation is therefore miss work: recomputing it here before the
      // immutable shard lookup would add the dominant semantic-addressing cost to every warm hit.
      const semanticAddressingStarted = process.hrtime.bigint();
      const semanticRegionPlan = addressSemanticRegions({
        loaded,
        unitInputs: inputs,
        unitInputCatalogs: fingerprinted.catalogs,
        workspaceDigest: workspaceHash,
      });
      semanticAddressingMs += elapsedMs(semanticAddressingStarted);
      const semanticPlan = semanticPlanManifestMetadata(semanticRegionPlan);
      progressReporter?.({
        language: "typescript",
        phase: "structure",
        unit: progressUnit,
        sourceFile: null,
      });
      const extractionStarted = process.hrtime.bigint();
      const tracedResolver = traceCrossPackageResolver(resolver, root);
      const semanticRegions = await extractLoadedUnitWithSemanticRegions({
        unit,
        loaded,
        options,
        resolver: tracedResolver.resolver,
        depth: policy.depth,
        unitInputs: inputs,
        workspaceDigest: workspaceHash,
        addressedPlan: semanticRegionPlan,
        cache: {
          persistentCacheDir: cacheDir,
          pairCacheDir,
          requiredAdmission: cachePolicy.requiredAdmission,
        },
        progressUnit,
        progressReporter,
      });
      let builtExtraction = semanticRegions.extraction;
      unitExtractionMs += elapsedMs(extractionStarted);
      const postExtractionFingerprintStarted = process.hrtime.bigint();
      progressReporter?.({
        language: "typescript",
        phase: "input-proof",
        unit: progressUnit,
        sourceFile: null,
      });
      const inputsAfterExtraction = unitInputFingerprint({
        root,
        unit,
        loaded,
        treeBlobs,
        treeBlobIndex,
        policy,
        provenance,
        onProgramInputProgress: reportProgramInputProgress,
      });
      postExtractionFingerprintMs += elapsedMs(postExtractionFingerprintStarted);
      if (canonicalJson(inputsAfterExtraction) !== canonicalJson(inputs)) {
        throw new Error(`unit inputs changed during extraction: ${unit.dir || "."}`);
      }
      const shardCodecStarted = process.hrtime.bigint();
      const serialized = encodeUnitExtraction(builtExtraction);
      // Exercise the exact persisted representation even on a miss. A shadow comparison therefore
      // validates the codec before this shard can be admitted for a later revision.
      builtExtraction = decodeUnitExtraction(serialized);
      shardCodecMs += elapsedMs(shardCodecStarted);
      const workspaceResolverTrace = tracedResolver.snapshot();
      const traceReusable = tracedResolver.isReusable();
      let builtReuseEligibility = inputs.reuseEligibility;
      if (inputs.reuseEligibility.eligible && !traceReusable) {
        builtReuseEligibility = {
          eligible: false,
          reasons: ["non-reusable-workspace-resolver-trace"],
        };
        reuseEligibleUnits -= 1;
        conservativelyRebuiltUnits += 1;
      }
      const addressKind = inputs.reuseEligibility.eligible && traceReusable
        ? "input"
        : "input-and-output";
      const builtShardKey = addressKind === "input"
        ? reusableShardAddress(inputs, workspaceHash, workspaceResolverTrace)
        : nonReusableShardAddress(inputs, workspaceHash, workspaceResolverTrace, serialized);
      return {
        extraction: builtExtraction,
        effectiveReuseEligibility: builtReuseEligibility,
        semanticRegions,
        pending: {
          key: builtShardKey,
          value: {
            version: POC_SHARD_VERSION,
            key: builtShardKey,
            addressKind,
            baseInputKey,
            inputs,
            workspaceDigest: workspaceHash,
            workspaceResolverTrace,
            semanticPlan,
            extraction: serialized,
          },
        },
      };
    };

    if (cached === null && inputs.reuseEligibility.eligible && pairCacheDir !== null) {
      const pairResolution = await withEphemeralPairUnitLock(
        pairCacheDir,
        baseInputKey,
        async () => {
          const cacheLookupStarted = process.hrtime.bigint();
          const peer = await readUnitShardCandidate(
            pairCacheDir,
            baseInputKey,
            inputs,
            workspaceHash,
            resolver,
            root,
          );
          cacheLookupMs += elapsedMs(cacheLookupStarted);
          if (peer !== null) return { cached: peer, built: null };
          const built = await buildUnit();
          const publicationStarted = process.hrtime.bigint();
          await publishPendingUnitShard(pairCacheDir, built.pending);
          if (built.pending.value.addressKind === "input") {
            await publishCandidateReference(pairCacheDir, built.pending);
          }
          ephemeralPublicationMs += elapsedMs(publicationStarted);
          return { cached: null, built };
        },
      );
      cached = pairResolution.cached;
      if (pairResolution.built !== null) {
        extraction = pairResolution.built.extraction;
        pending = pairResolution.built.pending;
        effectiveReuseEligibility = pairResolution.built.effectiveReuseEligibility;
        builtSemanticRegions = pairResolution.built.semanticRegions;
        shardKey = pending.key;
      } else {
        extraction = cached!.extraction;
        shardKey = cached!.shardKey;
        cachedFromEphemeralPair = true;
      }
    } else if (cached !== null) {
      extraction = cached.extraction;
      shardKey = cached.shardKey;
    } else {
      const built = await buildUnit();
      extraction = built.extraction;
      pending = built.pending;
      effectiveReuseEligibility = built.effectiveReuseEligibility;
      builtSemanticRegions = built.semanticRegions;
      shardKey = pending.key;
    }
    if (cachedFromEphemeralPair) {
      // The request owner deletes the pair exchange as soon as both workers settle. Retain the
      // exact immutable shard envelope in the candidate so any later generic publication can copy
      // it, together with its deterministic candidate reference, into the durable target cache.
      pending = {
        key: cached!.shardKey,
        value: cached!.shard,
      };
    }
    if (builtSemanticRegions !== null) {
      if (builtSemanticRegions.context !== null) {
        semanticRegionContexts.set(
          builtSemanticRegions.context.key,
          builtSemanticRegions.context,
        );
      }
      pendingSemanticRegions.push(...builtSemanticRegions.pendingRegions);
      semanticRegionEvidence.push(...builtSemanticRegions.regionEvidence);
      totalSemanticRegions += builtSemanticRegions.metrics.totalRegions;
      reusedSemanticRegions += builtSemanticRegions.metrics.reusedRegions;
      rebuiltSemanticRegions += builtSemanticRegions.metrics.rebuiltRegions;
      semanticRegionSourceBytes += builtSemanticRegions.metrics.totalSourceBytes;
      reusedSemanticRegionSourceBytes += builtSemanticRegions.metrics.reusedSourceBytes;
      if (builtSemanticRegions.metrics.planKind === "whole-unit-fallback") {
        semanticRegionFallbackUnits += 1;
      }
    }
    if (pending !== null) {
      pendingShards.push(pending);
    }
    const storedShard = cached?.shard ?? pending?.value;
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
      baseInputKey: storedShard.baseInputKey,
      shardPayloadDigest: canonicalJsonSha256(storedShard),
      addressKind: storedShard.addressKind,
      sourceBlobs: inputs.sourceBlobs,
      reuseEligibility: effectiveReuseEligibility,
      ...storedShard.semanticPlan,
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
  const checkoutRevalidationStarted = process.hrtime.bigint();
  const verifiedAfter = await verifyCleanCheckoutAtTree(root, treeOid);
  const checkoutRevalidationMs = elapsedMs(checkoutRevalidationStarted);
  if (verifiedAfter.headCommitOid !== checkout.headCommitOid) {
    throw new Error("checkout commit changed during incremental extraction");
  }
  const semanticDigestStarted = process.hrtime.bigint();
  const normalizedResultDigest = semanticExtractionDigest(result);
  const semanticDigestMs = elapsedMs(semanticDigestStarted);
  const manifest: RevisionManifest = {
    version: POC_MANIFEST_VERSION,
    treeOid,
    workspaceDigest: workspaceHash,
    policy,
    provenance,
    units: manifestUnits,
    normalizedResultDigest,
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
    requestKey: requestIdentity.requestKey,
    pendingShards,
    unitShards,
    semanticRegionContexts: [...semanticRegionContexts.values()],
    pendingSemanticRegions,
    semanticRegionEvidence,
    measureCacheBytes: request.measureCacheBytes === true,
    metrics: {
      processId: process.pid,
      totalMs: elapsedMs(started),
      fingerprintMs,
      unitExtractionMs,
      stitchMs,
      profile: {
        checkoutAndTreeInputMs,
        cacheLookupMs,
        semanticAddressingMs,
        postExtractionFingerprintMs,
        shardCodecMs,
        ephemeralPublicationMs,
        semanticDigestMs,
        checkoutRevalidationMs,
      },
      semanticRegions: {
        totalRegions: totalSemanticRegions,
        reusedRegions: reusedSemanticRegions,
        rebuiltRegions: rebuiltSemanticRegions,
        reuseRatio: totalSemanticRegions === 0
          ? 0
          : reusedSemanticRegions / totalSemanticRegions,
        totalSourceBytes: semanticRegionSourceBytes,
        reusedSourceBytes: reusedSemanticRegionSourceBytes,
        byteReuseRatio: semanticRegionSourceBytes === 0
          ? 0
          : reusedSemanticRegionSourceBytes / semanticRegionSourceBytes,
        fallbackUnits: semanticRegionFallbackUnits,
      },
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

async function readAdmittedExactRevisionManifest(inputs: {
  started: bigint;
  request: RevisionExtractionRequest;
  requestKey: string;
  root: string;
  cacheDir: string;
  treeOid: string;
  headCommitOid: string;
  checkoutAndTreeInputMs: number;
  treeBlobs: UnitInputFingerprint["sourceBlobs"];
  workspace: NonNullable<ReturnType<typeof perPackageWorkspace>>;
  workspaceHash: string;
  policy: ReturnType<typeof analysisPolicy>;
  provenance: ReturnType<typeof extractorProvenance>;
  options: ReturnType<typeof extractOptions>;
  resolver: ReturnType<typeof createCrossPackageResolver>;
  progressReporter: ReturnType<typeof createExtractionProgressReporter>;
  admission: RevisionShardAdmissionCapability;
}): Promise<PendingRevisionExtraction | null> {
  try {
    const index = await readImmutableJsonCache<RevisionManifestAdmissionReceipt>(
      revisionManifestRequestIndexRoot(inputs.cacheDir, inputs.admission),
      inputs.requestKey,
      {
        trustedRoot: inputs.cacheDir,
        maxEntryBytes: MAX_ADMISSION_RECEIPT_BYTES,
      },
    );
    if (index === null) return null;
    const receipt = index.value;
    if (!verifyRevisionManifestAdmissionReceipt(inputs.admission, receipt, {
      requestKey: inputs.requestKey,
      treeOid: inputs.treeOid,
      manifestAddress: receipt.manifestAddress,
      manifestPayloadDigest: receipt.manifestPayloadDigest,
      normalizedResultDigest: receipt.normalizedResultDigest,
    })) {
      return null;
    }
    const manifestHit = await readImmutableJsonCache<RevisionManifest>(
      manifestRoot(inputs.cacheDir, inputs.treeOid),
      receipt.manifestAddress,
      {
        trustedRoot: inputs.cacheDir,
        maxEntryBytes: MAX_REVISION_MANIFEST_BYTES,
      },
    );
    if (
      manifestHit === null
      || manifestHit.payloadDigest !== receipt.manifestPayloadDigest
      || canonicalJsonSha256(manifestHit.value) !== receipt.manifestAddress
      || !isExactRevisionManifestForRequest(manifestHit.value, {
        treeOid: inputs.treeOid,
        workspaceHash: inputs.workspaceHash,
        policy: inputs.policy,
        provenance: inputs.provenance,
        normalizedResultDigest: receipt.normalizedResultDigest,
        expectedUnits: inputs.workspace.units.length,
      })
    ) {
      return null;
    }
    const manifest = manifestHit.value;
    const extractions: UnitExtraction[] = [];
    const unitShards: RevisionUnitShardEvidence[] = [];
    let totalSourceBytes = 0;
    for (const [index, manifestUnit] of manifest.units.entries()) {
      const workspaceUnit = inputs.workspace.units[index];
      if (
        workspaceUnit === undefined
        || manifestUnit.unitId !== (workspaceUnit.dir || ".")
        || manifestUnit.addressKind !== "input"
        || !manifestUnit.reuseEligibility.eligible
        || manifestUnit.semanticPlanKind !== "partitioned"
        || manifestUnit.semanticPlanReasons.length !== 0
      ) {
        return null;
      }
      const shardHit = await readImmutableJsonCache<StoredUnitShard>(
        shardRoot(inputs.cacheDir),
        manifestUnit.shardKey,
        {
          trustedRoot: inputs.cacheDir,
          maxEntryBytes: MAX_UNIT_SHARD_BYTES,
        },
      );
      if (shardHit === null) return null;
      const shard = shardHit.value;
      if (
        shardHit.payloadDigest !== manifestUnit.shardPayloadDigest
        || shard.version !== POC_SHARD_VERSION
        || shard.key !== manifestUnit.shardKey
        || shard.baseInputKey !== manifestUnit.baseInputKey
        || shard.addressKind !== "input"
        || shard.workspaceDigest !== inputs.workspaceHash
        || !isCanonicalStoredSemanticPlanManifestMetadata(shard.semanticPlan)
        || !storedSemanticPlanMatchesManifestUnit(shard.semanticPlan, manifestUnit)
        || canonicalJsonSha256(shard.inputs) !== shard.baseInputKey
        || storedShardAddress(shard) !== shard.key
        || canonicalJson(shard.inputs.unit) !== canonicalJson(unitFingerprint(workspaceUnit))
        || canonicalJson(shard.inputs.policy) !== canonicalJson(inputs.policy)
        || canonicalJson(shard.inputs.provenance) !== canonicalJson(inputs.provenance)
        || canonicalJson(shard.inputs.sourceBlobs) !== canonicalJson(manifestUnit.sourceBlobs)
        || canonicalJson(shard.inputs.reuseEligibility)
          !== canonicalJson(manifestUnit.reuseEligibility)
        || !isCanonicalWorkspaceResolverTrace(shard.workspaceResolverTrace)
        || !workspaceResolverTraceMatches(
          shard.workspaceResolverTrace,
          inputs.resolver,
          inputs.root,
        )
        || !revalidateAdmittedUnitInputsAtExactTree(
          inputs.root,
          shard.inputs,
          inputs.treeBlobs,
        )
      ) {
        return null;
      }
      const admission = await readImmutableJsonCache<RevisionShardAdmissionReceipt>(
        admissionRoot(inputs.cacheDir, inputs.admission),
        shard.key,
        {
          trustedRoot: inputs.cacheDir,
          maxEntryBytes: MAX_ADMISSION_RECEIPT_BYTES,
        },
      );
      if (admission === null || !verifyRevisionShardAdmissionReceipt(
        inputs.admission,
        admission.value,
        {
          shardKey: shard.key,
          baseInputKey: shard.baseInputKey,
          payloadDigest: shardHit.payloadDigest,
        },
      )) {
        return null;
      }
      let extraction: UnitExtraction;
      try {
        extraction = decodeUnitExtraction(shard.extraction);
      } catch {
        return null;
      }
      extractions.push(extraction);
      unitShards.push({
        unitId: manifestUnit.unitId,
        shardKey: manifestUnit.shardKey,
        value: shard,
      });
      totalSourceBytes += manifestUnit.sourceBlobs.reduce(
        (total, blob) => total + blob.byteSize,
        0,
      );
    }

    const stitchStarted = process.hrtime.bigint();
    const result = stitchUnitExtractions(
      extractions,
      inputs.options,
      inputs.policy.depth,
      inputs.progressReporter === undefined
        ? undefined
        : (phase) => inputs.progressReporter?.({
            language: "typescript",
            phase,
            unit: null,
            sourceFile: null,
          }),
    );
    const stitchMs = elapsedMs(stitchStarted);
    const checkoutRevalidationStarted = process.hrtime.bigint();
    const verifiedAfter = await verifyCleanCheckoutAtTree(inputs.root, inputs.treeOid);
    const checkoutRevalidationMs = elapsedMs(checkoutRevalidationStarted);
    if (verifiedAfter.headCommitOid !== inputs.headCommitOid) return null;
    if (unitShards.some((unit) => !revalidateAdmittedUnitInputsAtExactTree(
      inputs.root,
      unit.value.inputs,
      inputs.treeBlobs,
    ))) {
      return null;
    }
    const semanticDigestStarted = process.hrtime.bigint();
    const normalizedResultDigest = semanticExtractionDigest(result);
    const semanticDigestMs = elapsedMs(semanticDigestStarted);
    if (
      normalizedResultDigest !== manifest.normalizedResultDigest
      || normalizedResultDigest !== receipt.normalizedResultDigest
    ) {
      return null;
    }
    const totalUnits = manifest.units.length;
    return {
      result,
      manifest,
      root: inputs.root,
      treeOid: inputs.treeOid,
      headCommitOid: inputs.headCommitOid,
      manifestAddress: receipt.manifestAddress,
      requestKey: inputs.requestKey,
      pendingShards: [],
      unitShards,
      semanticRegionContexts: [],
      pendingSemanticRegions: [],
      semanticRegionEvidence: [],
      measureCacheBytes: inputs.request.measureCacheBytes === true,
      metrics: {
        processId: process.pid,
        totalMs: elapsedMs(inputs.started),
        fingerprintMs: 0,
        unitExtractionMs: 0,
        stitchMs,
        profile: {
          checkoutAndTreeInputMs: inputs.checkoutAndTreeInputMs,
          cacheLookupMs: 0,
          semanticAddressingMs: 0,
          postExtractionFingerprintMs: 0,
          shardCodecMs: 0,
          ephemeralPublicationMs: 0,
          semanticDigestMs,
          checkoutRevalidationMs,
        },
        semanticRegions: {
          totalRegions: 0,
          reusedRegions: 0,
          rebuiltRegions: 0,
          reuseRatio: 0,
          totalSourceBytes: 0,
          reusedSourceBytes: 0,
          byteReuseRatio: 0,
          fallbackUnits: 0,
        },
        totalUnits,
        reusedUnits: totalUnits,
        rebuiltUnits: 0,
        reuseRatio: totalUnits === 0 ? 0 : 1,
        totalSourceBytes,
        reusedSourceBytes: totalSourceBytes,
        byteReuseRatio: totalSourceBytes === 0 ? 0 : 1,
        reuseEligibleUnits: totalUnits,
        conservativelyRebuiltUnits: 0,
        peakRssBytes: peakRssBytes(),
        cacheBytes: inputs.request.measureCacheBytes === true
          ? directoryBytes(inputs.cacheDir)
          : null,
      },
    };
  } catch {
    return null;
  }
}

function isExactRevisionManifestForRequest(
  value: unknown,
  expected: {
    treeOid: string;
    workspaceHash: string;
    policy: ReturnType<typeof analysisPolicy>;
    provenance: ReturnType<typeof extractorProvenance>;
    normalizedResultDigest: string;
    expectedUnits: number;
  },
): value is RevisionManifest {
  if (!isExactRecord(value, [
    "normalizedResultDigest",
    "policy",
    "provenance",
    "treeOid",
    "units",
    "version",
    "workspaceDigest",
  ])) {
    return false;
  }
  if (
    value.version !== POC_MANIFEST_VERSION
    || value.treeOid !== expected.treeOid
    || typeof value.treeOid !== "string"
    || !GIT_OBJECT_ID.test(value.treeOid)
    || value.workspaceDigest !== expected.workspaceHash
    || !isSha256Digest(value.workspaceDigest)
    || value.normalizedResultDigest !== expected.normalizedResultDigest
    || !isSha256Digest(value.normalizedResultDigest)
    || canonicalJson(value.policy) !== canonicalJson(expected.policy)
    || canonicalJson(value.provenance) !== canonicalJson(expected.provenance)
    || !Array.isArray(value.units)
    || value.units.length !== expected.expectedUnits
  ) {
    return false;
  }

  const unitIds = new Set<string>();
  for (const unit of value.units) {
    if (
      !isExactRecord(unit, [
        "addressKind",
        "baseInputKey",
        "reuseEligibility",
        "semanticPlanKind",
        "semanticPlanReasons",
        "semanticRegionContextDigest",
        "semanticRegions",
        "shardKey",
        "shardPayloadDigest",
        "sourceBlobs",
        "unitId",
      ])
      || typeof unit.unitId !== "string"
      || unit.unitId.length === 0
      || unitIds.has(unit.unitId)
      || !isSha256Digest(unit.shardKey)
      || !isSha256Digest(unit.baseInputKey)
      || !isSha256Digest(unit.shardPayloadDigest)
      || !isSha256Digest(unit.semanticRegionContextDigest)
      || (unit.addressKind !== "input" && unit.addressKind !== "input-and-output")
      || !isReuseEligibility(unit.reuseEligibility)
      || (
        unit.semanticPlanKind !== "partitioned"
        && unit.semanticPlanKind !== "whole-unit-fallback"
      )
      || !Array.isArray(unit.semanticPlanReasons)
      || !unit.semanticPlanReasons.every((reason) => typeof reason === "string")
      || new Set(unit.semanticPlanReasons).size !== unit.semanticPlanReasons.length
      || !Array.isArray(unit.sourceBlobs)
      || !isCanonicalSourceBlobArray(unit.sourceBlobs)
      || !Array.isArray(unit.semanticRegions)
      || !isCanonicalSemanticRegionArray(unit.semanticRegions)
    ) {
      return false;
    }
    unitIds.add(unit.unitId);
  }
  return true;
}

function isCanonicalSourceBlobArray(value: unknown[]): boolean {
  const paths = new Set<string>();
  for (const blob of value) {
    if (
      !isExactRecord(blob, ["byteSize", "mode", "oid", "path"])
      || !isSafeRepoRelativePath(blob.path)
      || paths.has(blob.path)
      || typeof blob.oid !== "string"
      || !GIT_OBJECT_ID.test(blob.oid)
      || (blob.mode !== "100644" && blob.mode !== "100755")
      || typeof blob.byteSize !== "number"
      || !Number.isSafeInteger(blob.byteSize)
      || blob.byteSize < 0
    ) {
      return false;
    }
    paths.add(blob.path);
  }
  return true;
}

function isCanonicalSemanticRegionArray(value: unknown[]): boolean {
  const regionIds = new Set<string>();
  const plannedFiles = new Set<string>();
  for (const region of value) {
    if (
      !isExactRecord(region, ["files", "key", "regionId"])
      || typeof region.regionId !== "string"
      || region.regionId.length === 0
      || regionIds.has(region.regionId)
      || !isSha256Digest(region.key)
      || !Array.isArray(region.files)
      || region.files.length === 0
      || !region.files.every(isSafeRepoRelativePath)
      || new Set(region.files).size !== region.files.length
      || !isCanonicalSortedStringArray(region.files)
      || region.files.some((file) => plannedFiles.has(file))
    ) {
      return false;
    }
    regionIds.add(region.regionId);
    for (const file of region.files) plannedFiles.add(file);
  }
  return true;
}

function semanticPlanManifestMetadata(
  plan: ReturnType<typeof addressSemanticRegions>,
): StoredSemanticPlanManifestMetadata {
  return {
    semanticPlanKind: plan.plan.kind,
    semanticPlanReasons: [...plan.plan.reasons],
    semanticRegionContextDigest: plan.contextDigest,
    semanticRegions: plan.regions.map((region) => ({
      regionId: region.id,
      key: region.key,
      files: [...region.files],
    })),
  };
}

function isCanonicalStoredSemanticPlanManifestMetadata(
  value: unknown,
): value is StoredSemanticPlanManifestMetadata {
  if (!isExactRecord(value, [
    "semanticPlanKind",
    "semanticPlanReasons",
    "semanticRegionContextDigest",
    "semanticRegions",
  ])) {
    return false;
  }
  if (
    (
      value.semanticPlanKind !== "partitioned"
      && value.semanticPlanKind !== "whole-unit-fallback"
    )
    || !Array.isArray(value.semanticPlanReasons)
    || !value.semanticPlanReasons.every((reason) => typeof reason === "string")
    || !isCanonicalSortedStringArray(value.semanticPlanReasons)
    || (
      value.semanticPlanKind === "partitioned"
      && value.semanticPlanReasons.length !== 0
    )
    || (
      value.semanticPlanKind === "whole-unit-fallback"
      && value.semanticPlanReasons.length === 0
    )
    || !isSha256Digest(value.semanticRegionContextDigest)
    || !Array.isArray(value.semanticRegions)
    || !isCanonicalSemanticRegionArray(value.semanticRegions)
  ) {
    return false;
  }
  return true;
}

function storedSemanticPlanMatchesManifestUnit(
  semanticPlan: StoredSemanticPlanManifestMetadata,
  manifestUnit: RevisionUnitManifest,
): boolean {
  return canonicalJson(semanticPlan) === canonicalJson({
    semanticPlanKind: manifestUnit.semanticPlanKind,
    semanticPlanReasons: manifestUnit.semanticPlanReasons,
    semanticRegionContextDigest: manifestUnit.semanticRegionContextDigest,
    semanticRegions: manifestUnit.semanticRegions,
  });
}

function isCanonicalSortedStringArray(value: readonly string[]): boolean {
  return value.every((entry, index) => (
    index === 0 || compareCanonicalStrings(value[index - 1]!, entry) < 0
  ));
}

function isReuseEligibility(value: unknown): boolean {
  return isExactRecord(value, ["eligible", "reasons"])
    && typeof value.eligible === "boolean"
    && Array.isArray(value.reasons)
    && value.reasons.every((reason) => typeof reason === "string")
    && new Set(value.reasons).size === value.reasons.length;
}

function inputProofProgressPosition(
  root: string,
  position: UnitInputFingerprintProgressPosition,
): UnitInputFingerprintProgressPosition {
  const relative = relativeToRoot(root, position.path);
  const dependencyAt = position.path.lastIndexOf("/node_modules/");
  const path = relative !== ".." && !relative.startsWith("../")
    ? relative || basename(position.path)
    : dependencyAt >= 0
      ? position.path.slice(dependencyAt + 1)
      : `external/${basename(position.path)}`;
  return { current: position.current, total: position.total, path };
}

function isSafeRepoRelativePath(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && !isAbsolute(value)
    && !value.includes("\\")
    && value.split("/").every(
      (segment) => segment !== "" && segment !== "." && segment !== ".." && segment !== ".git",
    );
}

function isSha256Digest(value: unknown): value is string {
  return typeof value === "string" && SHA256_DIGEST.test(value);
}

function isExactRecord(
  value: unknown,
  expectedKeys: readonly string[],
): value is Record<string, unknown> {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).sort().join("\0")
      === [...expectedKeys].sort(compareCanonicalStrings).join("\0");
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
  for (const context of candidate.semanticRegionContexts) {
    await publishSemanticRegionContext(cacheDir, context);
  }
  for (const pending of candidate.pendingSemanticRegions) {
    await publishPendingSemanticRegionShard(cacheDir, pending);
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
    for (const context of candidate.semanticRegionContexts) {
      await publishSemanticRegionContext(cacheDir, context, true);
    }
    for (const pending of candidate.pendingSemanticRegions) {
      await publishPendingSemanticRegionShard(cacheDir, pending, signer);
    }
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
    const semanticRegions = candidate.semanticRegionEvidence.map(
      (region): StagedSemanticRegionEvidence => ({
        unitId: region.unitId,
        regionId: region.regionId,
        key: region.key,
        baseInputKey: region.baseInputKey,
        payloadDigest: region.payloadDigest,
        receipt: createSemanticRegionAdmissionReceipt(signer, region),
      }),
    );
    return {
      cacheDir,
      manifest: candidate.manifest,
      metrics: candidate.metrics,
      root: candidate.root,
      treeOid: candidate.treeOid,
      headCommitOid: candidate.headCommitOid,
      manifestAddress: candidate.manifestAddress,
      requestKey: candidate.requestKey,
      units,
      semanticRegionContextKeys: candidate.semanticRegionContexts.map((context) => context.key),
      semanticRegions,
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

async function assertStagedSemanticRegionParity(
  staged: StagedRevisionAdmission,
  coldCacheDirInput: string,
  cold: PendingRevisionExtraction,
): Promise<void> {
  const coldCacheDir = await prepareExternalCache(cold.root, resolve(coldCacheDirInput));
  const coldContextsByKey = coldEntryMultimap(
    cold.semanticRegionContexts,
    (context) => context.key,
  );
  for (const key of staged.semanticRegionContextKeys) {
    const coldContext = takeColdEntry(coldContextsByKey, key);
    if (coldContext === undefined) {
      throw new Error(`semantic-region context differs from the empty-cache cold oracle: ${key}`);
    }
    const exact = await exactRegularFilesEqual(
      immutableJsonCachePath(semanticRegionContextRoot(staged.cacheDir), key),
      immutableJsonCachePath(semanticRegionContextRoot(coldCacheDir), coldContext.key),
      MAX_UNIT_SHARD_BYTES,
    );
    if (!exact) {
      throw new Error(`semantic-region context differs from the empty-cache cold oracle: ${key}`);
    }
  }

  const coldRegionsByIdentity = coldEntryMultimap(
    cold.semanticRegionEvidence,
    semanticRegionParityIdentity,
  );
  for (const incrementalRegion of staged.semanticRegions) {
    const coldRegion = takeColdEntry(
      coldRegionsByIdentity,
      semanticRegionParityIdentity(incrementalRegion),
    );
    if (coldRegion === undefined) {
      throw new Error(
        `semantic-region identity differs from the empty-cache cold oracle: `
        + `${incrementalRegion.unitId}/${incrementalRegion.regionId}`,
      );
    }
    const exact = await exactRegularFilesEqual(
      immutableJsonCachePath(
        semanticRegionShardRoot(staged.cacheDir, incrementalRegion.baseInputKey),
        incrementalRegion.key,
      ),
      immutableJsonCachePath(
        semanticRegionShardRoot(coldCacheDir, coldRegion.baseInputKey),
        coldRegion.key,
      ),
      MAX_UNIT_SHARD_BYTES,
    );
    if (!exact) {
      throw new Error(
        `semantic-region shard differs from the empty-cache cold oracle: `
        + `${incrementalRegion.unitId}/${incrementalRegion.regionId}`,
      );
    }
  }
}

function semanticRegionParityIdentity(region: {
  unitId: string;
  regionId: string;
  key: string;
  baseInputKey: string;
  payloadDigest: string;
}): string {
  return canonicalJson({
    unitId: region.unitId,
    regionId: region.regionId,
    key: region.key,
    baseInputKey: region.baseInputKey,
    payloadDigest: region.payloadDigest,
  });
}

function coldEntryMultimap<T>(
  entries: readonly T[],
  identity: (entry: T) => string,
): Map<string, T[]> {
  const result = new Map<string, T[]>();
  for (const entry of entries) {
    const key = identity(entry);
    const matches = result.get(key);
    if (matches === undefined) {
      result.set(key, [entry]);
    } else {
      matches.push(entry);
    }
  }
  return result;
}

function takeColdEntry<T>(entries: Map<string, T[]>, identity: string): T | undefined {
  const matches = entries.get(identity);
  const match = matches?.pop();
  if (matches?.length === 0) entries.delete(identity);
  return match;
}

function semanticRegionFromStagedEvidence(
  staged: StagedSemanticRegionEvidence,
  cold: PendingRevisionExtraction,
) {
  const evidence = cold.semanticRegionEvidence.find((region) => (
    region.unitId === staged.unitId
    && region.regionId === staged.regionId
    && region.key === staged.key
  ));
  if (evidence === undefined) {
    throw new Error(
      `cold semantic-region evidence is missing: ${staged.unitId}/${staged.regionId}`,
    );
  }
  return {
    id: staged.regionId,
    files: evidence.value.contributions.files.map((file) => file.file)
      .sort(compareCanonicalStrings),
    dependencyRegionIds: evidence.value.inputs.dependencyRegionKeys
      .map((dependency) => dependency.regionId),
    key: staged.key,
    inputs: evidence.value.inputs,
  };
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
      || staged.requestKey !== cold.requestKey
    ) {
      throw new Error("staged revision identity differs from the empty-cache cold oracle");
    }
    if (
      cold.metrics.reusedUnits !== 0
      || cold.metrics.rebuiltUnits !== cold.metrics.totalUnits
      || cold.metrics.semanticRegions.reusedRegions !== 0
      || cold.metrics.semanticRegions.rebuiltRegions
        !== cold.metrics.semanticRegions.totalRegions
    ) {
      throw new Error("admission oracle was not extracted with an empty cache");
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
    await assertStagedSemanticRegionParity(staged, coldCacheDirInput, cold);

    const cacheDir = await prepareExternalCache(staged.root, resolve(cacheDirInput));
    const verified = await verifyCleanCheckoutAtTree(staged.root, staged.treeOid);
    if (verified.headCommitOid !== staged.headCommitOid) {
      throw new Error("checkout commit changed before incremental cache admission");
    }
    let exactRequestIndexEligible = staged.units.length === staged.manifest.units.length
      && staged.units.every((unit, index) => {
        const manifestUnit = staged.manifest.units[index];
        return unit.addressKind === "input"
          && unit.receipt !== null
          && manifestUnit !== undefined
          && manifestUnit.unitId === unit.unitId
          && manifestUnit.shardKey === unit.shardKey
          && manifestUnit.baseInputKey === unit.baseInputKey
          && manifestUnit.shardPayloadDigest === unit.payloadDigest
          && manifestUnit.addressKind === unit.addressKind
          && manifestUnit.semanticPlanKind === "partitioned"
          && manifestUnit.semanticPlanReasons.length === 0;
      });
    let exactTreeBlobs: UnitInputFingerprint["sourceBlobs"] | null = null;
    if (exactRequestIndexEligible) {
      try {
        const exactTree = await verifyGitTreeInputs(
          staged.root,
          await listGitTreeBlobs(staged.root, staged.treeOid),
        );
        exactTreeBlobs = exactTree.regularBlobs
          .sort((left, right) => compareCanonicalStrings(left.path, right.path));
      } catch {
        exactRequestIndexEligible = false;
      }
    }
    for (const unit of staged.units) {
      if (unit.receipt === null) {
        exactRequestIndexEligible = false;
        continue;
      }
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
        || shard.value.workspaceDigest !== staged.manifest.workspaceDigest
        || !isCanonicalStoredSemanticPlanManifestMetadata(shard.value.semanticPlan)
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
      if (
        exactRequestIndexEligible
        && (
          exactTreeBlobs === null
          || !revalidateAdmittedUnitInputsAtExactTree(
            staged.root,
            shard.value.inputs,
            exactTreeBlobs,
          )
        )
      ) {
        exactRequestIndexEligible = false;
      }
      await publishAdmissionReceipt(cacheDir, signer, unit.receipt);
    }
    for (const region of staged.semanticRegions) {
      const expected = semanticRegionFromStagedEvidence(region, cold);
      const hit = await readSemanticRegionShard(cacheDir, expected);
      if (
        hit === null
        || hit.key !== region.key
        || hit.baseInputKey !== region.baseInputKey
        || hit.payloadDigest !== region.payloadDigest
        || !verifyRevisionShardAdmissionReceipt(signer, region.receipt, {
          shardKey: region.key,
          baseInputKey: region.baseInputKey,
          payloadDigest: region.payloadDigest,
        })
      ) {
        throw new Error(
          `staged semantic-region shard changed before admission: `
          + `${region.unitId}/${region.regionId}`,
        );
      }
      await publishSemanticRegionAdmissionReceipt(cacheDir, signer, region.receipt);
    }
    const manifestWrite = await writeImmutableJsonCache(
      manifestRoot(cacheDir, staged.treeOid),
      staged.manifestAddress,
      staged.manifest,
      { trustedRoot: cacheDir },
    );
    if (exactRequestIndexEligible) {
      const manifestReceipt = createRevisionManifestAdmissionReceipt(signer, {
        requestKey: staged.requestKey,
        treeOid: staged.treeOid,
        manifestAddress: staged.manifestAddress,
        manifestPayloadDigest: manifestWrite.payloadDigest,
        normalizedResultDigest: staged.manifest.normalizedResultDigest,
      });
      await publishRevisionManifestRequestIndex(
        cacheDir,
        signer,
        staged.requestKey,
        manifestReceipt,
      );
    }
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
  workspaceDigest: string,
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
      || !isSha256Digest(reference.value.workspaceDigest)
      || !isCanonicalWorkspaceResolverTrace(reference.value.workspaceResolverTrace)
      || reusableShardAddress(
        inputs,
        reference.value.workspaceDigest,
        reference.value.workspaceResolverTrace,
      ) !== shardKey) {
      return null;
    }
    if (reference.value.workspaceDigest !== workspaceDigest) continue;
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
    || shard.workspaceDigest !== workspaceDigest
    || shard.workspaceDigest !== match.workspaceDigest
    || !shard.inputs.reuseEligibility.eligible
    || !isCanonicalStoredSemanticPlanManifestMetadata(shard.semanticPlan)
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
    ? reusableShardAddress(
        shard.inputs,
        shard.workspaceDigest,
        shard.workspaceResolverTrace,
      )
    : nonReusableShardAddress(
        shard.inputs,
        shard.workspaceDigest,
        shard.workspaceResolverTrace,
        shard.extraction,
      );
}

function reusableShardAddress(
  inputs: UnitInputFingerprint,
  workspaceDigest: string,
  workspaceResolverTrace: readonly WorkspaceResolverTraceEntry[],
): string {
  return canonicalJsonSha256({
    version: POC_SHARD_VERSION,
    kind: "reusable-unit-input",
    inputs,
    workspaceDigest,
    workspaceResolverTrace,
  });
}

function nonReusableShardAddress(
  inputs: UnitInputFingerprint,
  workspaceDigest: string,
  workspaceResolverTrace: readonly WorkspaceResolverTraceEntry[],
  extraction: SerializedUnitExtraction,
): string {
  return canonicalJsonSha256({
    version: POC_SHARD_VERSION,
    kind: "non-reusable-unit-output",
    inputs,
    workspaceDigest,
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

function semanticRegionContextRoot(cacheDir: string): string {
  return resolve(cacheDir, "semantic-region-contexts");
}

function semanticRegionShardRoot(cacheDir: string, contextDigest: string): string {
  return resolve(cacheDir, "semantic-region-shards", contextDigest);
}

function candidateRoot(cacheDir: string, baseInputKey: string): string {
  return resolve(cacheDir, "candidates", baseInputKey);
}

function manifestRoot(cacheDir: string, treeOid: string): string {
  return resolve(cacheDir, "manifests", treeOid);
}

function revisionManifestRequestIndexRoot(
  cacheDir: string,
  admission: RevisionShardAdmissionCapability,
): string {
  return resolve(cacheDir, "revision-manifest-admissions", admission.keyId);
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
    workspaceDigest: pending.value.workspaceDigest,
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

async function publishRevisionManifestRequestIndex(
  cacheDir: string,
  signer: RevisionShardAdmissionSigner,
  requestKey: string,
  receipt: RevisionManifestAdmissionReceipt,
): Promise<void> {
  if (
    receipt.requestKey !== requestKey
    || !verifyRevisionManifestAdmissionReceipt(signer, receipt, {
      requestKey,
      treeOid: receipt.treeOid,
      manifestAddress: receipt.manifestAddress,
      manifestPayloadDigest: receipt.manifestPayloadDigest,
      normalizedResultDigest: receipt.normalizedResultDigest,
    })
  ) {
    throw new Error("revision manifest request index receipt is invalid");
  }
  const root = revisionManifestRequestIndexRoot(cacheDir, signer);
  try {
    await writeImmutableJsonCache(root, requestKey, receipt, {
      trustedRoot: cacheDir,
    });
    return;
  } catch (error) {
    if (!isRepairableImmutableEntryError(error)) throw error;
    // A different signer-authenticated result for the same complete request fingerprint is an
    // oracle/determinism violation, not corrupt cache state. Preserve it for investigation.
    if (await hasValidRevisionManifestRequestIndex(cacheDir, signer, requestKey)) {
      throw error;
    }
  }
  await quarantineImmutableJsonCacheEntry(root, requestKey, {
    trustedRoot: cacheDir,
    quarantineRoot: repairTrashRoot(cacheDir),
  });
  await writeImmutableJsonCache(root, requestKey, receipt, {
    trustedRoot: cacheDir,
  });
}

async function hasValidRevisionManifestRequestIndex(
  cacheDir: string,
  signer: RevisionShardAdmissionSigner,
  requestKey: string,
): Promise<boolean> {
  try {
    const receipt = await readImmutableJsonCache<RevisionManifestAdmissionReceipt>(
      revisionManifestRequestIndexRoot(cacheDir, signer),
      requestKey,
      {
        trustedRoot: cacheDir,
        maxEntryBytes: MAX_ADMISSION_RECEIPT_BYTES,
      },
    );
    return receipt !== null
      && receipt.value.requestKey === requestKey
      && verifyRevisionManifestAdmissionReceipt(signer, receipt.value, {
        requestKey,
        treeOid: receipt.value.treeOid,
        manifestAddress: receipt.value.manifestAddress,
        manifestPayloadDigest: receipt.value.manifestPayloadDigest,
        normalizedResultDigest: receipt.value.normalizedResultDigest,
      });
  } catch {
    return false;
  }
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
    if (
      !isSha256Digest(shard.value.workspaceDigest)
      || !isCanonicalStoredSemanticPlanManifestMetadata(shard.value.semanticPlan)
      || storedShardAddress(shard.value) !== shardKey
    ) {
      return false;
    }
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
