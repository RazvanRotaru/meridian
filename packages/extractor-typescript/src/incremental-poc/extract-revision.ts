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
  listImmutableJsonCacheAddresses,
  readImmutableJsonCache,
  writeImmutableJsonCache,
} from "./immutable-cache";
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

export interface PendingRevisionExtraction {
  result: ExtractionResult;
  manifest: RevisionManifest;
  metrics: RevisionExtractionRun["metrics"];
  root: string;
  treeOid: string;
  headCommitOid: string;
  manifestAddress: string;
  pendingShards: PendingUnitShard[];
}

export async function extractRevisionWithCache(
  request: RevisionExtractionRequest,
): Promise<RevisionExtractionRun> {
  const pending = await extractRevisionCandidate(request);
  return publishRevisionCandidate(request.cacheDir, pending);
}

/**
 * Build a revision using admitted immutable shards, but do not publish any newly computed shard or
 * manifest. Differential callers keep this candidate quarantined until a cold oracle agrees.
 */
export async function extractRevisionCandidate(
  request: RevisionExtractionRequest,
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
      cacheBytes: directoryBytes(cacheDir),
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
    await writeImmutableJsonCache<StoredUnitShard>(
      shardRoot(cacheDir),
      pending.key,
      pending.value,
      { trustedRoot: cacheDir },
    );
    if (pending.value.addressKind === "input") {
      await writeImmutableJsonCache<StoredUnitCandidateReference>(
        candidateRoot(cacheDir, pending.value.baseInputKey),
        pending.key,
        {
          version: POC_SHARD_VERSION,
          baseInputKey: pending.value.baseInputKey,
          shardKey: pending.key,
          workspaceResolverTrace: pending.value.workspaceResolverTrace,
        },
        { trustedRoot: cacheDir },
      );
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
      cacheBytes: directoryBytes(cacheDir),
    },
  };
}

async function readUnitShardCandidate(
  cacheDir: string,
  baseInputKey: string,
  inputs: UnitInputFingerprint,
  resolver: ReturnType<typeof createCrossPackageResolver>,
  root: string,
): Promise<{ shardKey: string; extraction: UnitExtraction } | null> {
  const shardKeys = await candidateShardKeys(cacheDir, baseInputKey);
  let match: StoredUnitCandidateReference | null = null;
  for (const shardKey of shardKeys) {
    const reference = await readImmutableJsonCache<StoredUnitCandidateReference>(
      candidateRoot(cacheDir, baseInputKey),
      shardKey,
      { trustedRoot: cacheDir },
    );
    if (reference === null
      || reference.value.version !== POC_SHARD_VERSION
      || reference.value.baseInputKey !== baseInputKey
      || reference.value.shardKey !== shardKey
      || !isCanonicalWorkspaceResolverTrace(reference.value.workspaceResolverTrace)
      || reusableShardAddress(inputs, reference.value.workspaceResolverTrace) !== shardKey) {
      throw new Error(`immutable unit candidate identity mismatch: ${shardKey}`);
    }
    if (!workspaceResolverTraceMatches(
      reference.value.workspaceResolverTrace,
      resolver,
      root,
    )) {
      continue;
    }
    if (match !== null && match.shardKey !== shardKey) {
      throw new Error(`multiple immutable unit candidates match base input: ${baseInputKey}`);
    }
    match = reference.value;
  }
  if (match === null) return null;

  const hit = await readImmutableJsonCache<StoredUnitShard>(
    shardRoot(cacheDir),
    match.shardKey,
    { trustedRoot: cacheDir },
  );
  if (hit === null) {
    throw new Error(`immutable unit candidate points to a missing shard: ${match.shardKey}`);
  }
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
    throw new Error(`immutable unit shard identity mismatch: ${match.shardKey}`);
  }
  return {
    shardKey: match.shardKey,
    extraction: decodeUnitExtraction(shard.extraction),
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
): Promise<string[]> {
  return listImmutableJsonCacheAddresses(
    candidateRoot(cacheDir, baseInputKey),
    { trustedRoot: cacheDir },
  );
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

function filesystemErrorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;
}
