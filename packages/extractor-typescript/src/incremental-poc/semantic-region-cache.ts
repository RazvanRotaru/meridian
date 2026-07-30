/**
 * Immutable storage boundary for experimental semantic-region contributions.
 *
 * Common compiler/configuration/provenance inputs are stored once as an addressed context. Each
 * region shard stores its exact local inputs, recursive provider keys, and codec-normalized file
 * contributions. Admitted reads additionally require the same cold-oracle Ed25519 receipt used by
 * complete unit shards. A missing/malformed/unadmitted entry is a conservative miss.
 */

import { resolve } from "node:path";
import type {
  UnitFileContributionV1,
  UnitSemanticFileContributionV1,
} from "../unit-contributions";
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
  sha256Hex,
} from "./canonical-json";
import {
  ImmutableCacheCollisionError,
  ImmutableCacheCorruptionError,
  quarantineImmutableJsonCacheEntry,
  readImmutableJsonCache,
  writeImmutableJsonCache,
} from "./immutable-cache";
import type {
  AddressedSemanticRegion,
  SemanticRegionContextV2,
  SemanticRegionInputV2,
} from "./semantic-region-inputs";
import {
  decodeSemanticRegionContributions,
  encodeSemanticRegionContributions,
  SemanticRegionLimitError,
  MAX_SEMANTIC_REGION_CONTRIBUTION_BYTES,
  MAX_SEMANTIC_REGION_FILES,
  SEMANTIC_REGION_CONTRIBUTION_CODEC_VERSION,
  type SerializedSemanticRegionContributionsV3,
} from "./semantic-region-codec";

export const SEMANTIC_REGION_CACHE_VERSION = 6 as const;
const MAX_SEMANTIC_REGION_CONTEXT_BYTES = 128 * 1024 * 1024;
const MAX_SEMANTIC_REGION_SHARD_BYTES =
  MAX_SEMANTIC_REGION_CONTRIBUTION_BYTES + 64 * 1024 * 1024;
const MAX_SEMANTIC_REGION_RECEIPT_BYTES = 64 * 1024;
const IMMUTABLE_JSON_CACHE_FORMAT = "meridian.incremental-poc.immutable-json.v1";

export interface SemanticRegionCacheLimits {
  /** Test/host override may narrow, but never raise, the production ceilings. */
  readonly maxContextEntryBytes?: number;
  readonly maxShardEntryBytes?: number;
  readonly maxContributionBytes?: number;
  readonly maxRegionFiles?: number;
}

export interface StoredSemanticRegionContextV2 {
  version: typeof SEMANTIC_REGION_CACHE_VERSION;
  key: string;
  context: SemanticRegionContextV2;
}

export interface StoredSemanticRegionShardV2 {
  version: typeof SEMANTIC_REGION_CACHE_VERSION;
  codecVersion: typeof SEMANTIC_REGION_CONTRIBUTION_CODEC_VERSION;
  key: string;
  contextDigest: string;
  inputs: SemanticRegionInputV2;
  contributions: SerializedSemanticRegionContributionsV3;
}

export interface PendingSemanticRegionShard {
  key: string;
  baseInputKey: string;
  value: StoredSemanticRegionShardV2;
}

export interface SemanticRegionShardHit {
  key: string;
  baseInputKey: string;
  value: StoredSemanticRegionShardV2;
  files: readonly UnitSemanticFileContributionV1[];
  payloadDigest: string;
}

export function semanticRegionContextRecord(
  context: SemanticRegionContextV2,
  expectedDigest?: string,
  limits: SemanticRegionCacheLimits = {},
): StoredSemanticRegionContextV2 {
  const key = canonicalJsonSha256(context);
  if (expectedDigest !== undefined && key !== expectedDigest) {
    throw new Error("semantic-region context digest differs from its complete inputs");
  }
  const record: StoredSemanticRegionContextV2 = {
    version: SEMANTIC_REGION_CACHE_VERSION,
    key,
    context,
  };
  assertCacheEntryFits(
    record.key,
    record,
    resolvedCacheLimits(limits).maxContextEntryBytes,
    "cache-context-entry-bytes",
  );
  return record;
}

export async function publishSemanticRegionContext(
  cacheDir: string,
  record: StoredSemanticRegionContextV2,
  repair = false,
  limits: SemanticRegionCacheLimits = {},
): Promise<void> {
  requireStoredContext(record, record.key);
  const maxEntryBytes = resolvedCacheLimits(limits).maxContextEntryBytes;
  assertCacheEntryFits(
    record.key,
    record,
    maxEntryBytes,
    "cache-context-entry-bytes",
  );
  const root = semanticRegionContextRoot(cacheDir);
  try {
    await writeImmutableJsonCache(root, record.key, record, {
      trustedRoot: cacheDir,
      maxEntryBytes,
    });
    return;
  } catch (error) {
    if (!repair || !isRepairableImmutableEntryError(error)) throw error;
  }
  await quarantineImmutableJsonCacheEntry(root, record.key, {
    trustedRoot: cacheDir,
    quarantineRoot: repairTrashRoot(cacheDir),
  });
  await writeImmutableJsonCache(root, record.key, record, {
    trustedRoot: cacheDir,
    maxEntryBytes,
  });
}

export async function semanticRegionContextMatches(
  cacheDir: string,
  context: SemanticRegionContextV2,
  expectedDigest: string,
  limits: SemanticRegionCacheLimits = {},
): Promise<boolean> {
  const current = semanticRegionContextRecord(context, expectedDigest, limits);
  const maxEntryBytes = resolvedCacheLimits(limits).maxContextEntryBytes;
  try {
    const hit = await readImmutableJsonCache<unknown>(
      semanticRegionContextRoot(cacheDir),
      expectedDigest,
      {
        trustedRoot: cacheDir,
        maxEntryBytes,
      },
    );
    if (hit === null) return false;
    requireStoredContext(hit.value, expectedDigest);
    return canonicalJson((hit.value as StoredSemanticRegionContextV2).context)
      === canonicalJson(current.context);
  } catch {
    return false;
  }
}

export function createPendingSemanticRegionShard(
  region: AddressedSemanticRegion,
  files: readonly UnitFileContributionV1[],
  limits: SemanticRegionCacheLimits = {},
): PendingSemanticRegionShard {
  const resolvedLimits = resolvedCacheLimits(limits);
  const contributions = encodeSemanticRegionContributions(files, {
    maxBytes: resolvedLimits.maxContributionBytes,
    maxFiles: resolvedLimits.maxRegionFiles,
  });
  requireRegionMembership(region, contributions.files);
  const value: StoredSemanticRegionShardV2 = {
    version: SEMANTIC_REGION_CACHE_VERSION,
    codecVersion: SEMANTIC_REGION_CONTRIBUTION_CODEC_VERSION,
    key: region.key,
    contextDigest: region.inputs.contextDigest,
    inputs: region.inputs,
    contributions,
  };
  requireStoredRegion(value, region);
  assertCacheEntryFits(
    region.key,
    value,
    resolvedLimits.maxShardEntryBytes,
    "cache-shard-entry-bytes",
  );
  return {
    key: region.key,
    baseInputKey: region.inputs.contextDigest,
    value,
  };
}

export async function publishPendingSemanticRegionShard(
  cacheDir: string,
  pending: PendingSemanticRegionShard,
  signer?: RevisionShardAdmissionSigner,
  limits: SemanticRegionCacheLimits = {},
): Promise<{ payloadDigest: string }> {
  if (
    pending.key !== pending.value.key
    || pending.baseInputKey !== pending.value.contextDigest
  ) {
    throw new Error("pending semantic-region shard identity is incoherent");
  }
  const maxEntryBytes = resolvedCacheLimits(limits).maxShardEntryBytes;
  assertCacheEntryFits(
    pending.key,
    pending.value,
    maxEntryBytes,
    "cache-shard-entry-bytes",
  );
  const root = semanticRegionShardRoot(cacheDir, pending.baseInputKey);
  let written;
  try {
    written = await writeImmutableJsonCache(
      root,
      pending.key,
      pending.value,
      { trustedRoot: cacheDir, maxEntryBytes },
    );
  } catch (error) {
    if (signer === undefined || !isRepairableImmutableEntryError(error)) throw error;
    if (await hasValidAdmissionForStoredSemanticRegion(cacheDir, signer, pending)) {
      throw error;
    }
    await quarantineImmutableJsonCacheEntry(root, pending.key, {
      trustedRoot: cacheDir,
      quarantineRoot: repairTrashRoot(cacheDir),
    });
    await quarantineImmutableJsonCacheEntry(
      semanticRegionAdmissionRoot(cacheDir, signer),
      pending.key,
      {
        trustedRoot: cacheDir,
        quarantineRoot: repairTrashRoot(cacheDir),
      },
    );
    written = await writeImmutableJsonCache(
      root,
      pending.key,
      pending.value,
      { trustedRoot: cacheDir, maxEntryBytes },
    );
  }
  return { payloadDigest: written.payloadDigest };
}

export async function readSemanticRegionShard(
  cacheDir: string,
  region: AddressedSemanticRegion,
  requiredAdmission?: RevisionShardAdmissionCapability,
  limits: SemanticRegionCacheLimits = {},
): Promise<SemanticRegionShardHit | null> {
  const resolvedLimits = resolvedCacheLimits(limits);
  let admittedPayloadDigest: string | null = null;
  if (requiredAdmission !== undefined) {
    let receipt;
    try {
      receipt = await readImmutableJsonCache<unknown>(
        semanticRegionAdmissionRoot(cacheDir, requiredAdmission),
        region.key,
        {
          trustedRoot: cacheDir,
          maxEntryBytes: MAX_SEMANTIC_REGION_RECEIPT_BYTES,
        },
      );
    } catch {
      return null;
    }
    if (receipt === null) return null;
    admittedPayloadDigest = authenticatedReceiptPayloadDigest(
      requiredAdmission,
      receipt.value,
      region,
    );
    if (admittedPayloadDigest === null) return null;
  }

  let hit;
  try {
    hit = await readImmutableJsonCache<unknown>(
      semanticRegionShardRoot(cacheDir, region.inputs.contextDigest),
      region.key,
      {
        trustedRoot: cacheDir,
        maxEntryBytes: resolvedLimits.maxShardEntryBytes,
      },
    );
  } catch (error) {
    if (requiredAdmission !== undefined) return null;
    throw error;
  }
  if (hit === null) return null;

  let value: StoredSemanticRegionShardV2;
  let contributions: SerializedSemanticRegionContributionsV3;
  try {
    value = requireStoredRegion(hit.value, region);
    contributions = decodeSemanticRegionContributions(value.contributions, {
      maxBytes: resolvedLimits.maxContributionBytes,
      maxFiles: resolvedLimits.maxRegionFiles,
    });
    requireRegionMembership(region, contributions.files);
  } catch (error) {
    if (requiredAdmission !== undefined) return null;
    throw error;
  }

  if (
    admittedPayloadDigest !== null
    && hit.payloadDigest !== admittedPayloadDigest
  ) return null;

  return {
    key: region.key,
    baseInputKey: region.inputs.contextDigest,
    value: { ...value, contributions },
    // Imports are never admitted from cache. The canonical target import pass replaces this
    // transport placeholder before either contributions or the graph can materialize.
    files: contributions.files.map((file) => ({ ...file, importEdges: [] })),
    payloadDigest: hit.payloadDigest,
  };
}

function authenticatedReceiptPayloadDigest(
  admission: RevisionShardAdmissionCapability,
  value: unknown,
  region: AddressedSemanticRegion,
): string | null {
  if (
    !isRecord(value)
    || typeof value.payloadDigest !== "string"
    || !/^[a-f0-9]{64}$/.test(value.payloadDigest)
  ) return null;
  return verifyRevisionShardAdmissionReceipt(admission, value, {
    shardKey: region.key,
    baseInputKey: region.inputs.contextDigest,
    payloadDigest: value.payloadDigest,
  })
    ? value.payloadDigest
    : null;
}

export function createSemanticRegionAdmissionReceipt(
  signer: RevisionShardAdmissionSigner,
  evidence: Pick<SemanticRegionShardHit, "key" | "baseInputKey" | "payloadDigest">,
): RevisionShardAdmissionReceipt {
  return createRevisionShardAdmissionReceipt(signer, {
    shardKey: evidence.key,
    baseInputKey: evidence.baseInputKey,
    payloadDigest: evidence.payloadDigest,
  });
}

export async function publishSemanticRegionAdmissionReceipt(
  cacheDir: string,
  signer: RevisionShardAdmissionSigner,
  receipt: RevisionShardAdmissionReceipt,
): Promise<void> {
  const root = semanticRegionAdmissionRoot(cacheDir, signer);
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

async function hasValidAdmissionForStoredSemanticRegion(
  cacheDir: string,
  signer: RevisionShardAdmissionSigner,
  pending: PendingSemanticRegionShard,
): Promise<boolean> {
  try {
    const shard = await readImmutableJsonCache<unknown>(
      semanticRegionShardRoot(cacheDir, pending.baseInputKey),
      pending.key,
      { trustedRoot: cacheDir, maxEntryBytes: MAX_SEMANTIC_REGION_SHARD_BYTES },
    );
    if (shard === null) return false;
    const receipt = await readImmutableJsonCache<unknown>(
      semanticRegionAdmissionRoot(cacheDir, signer),
      pending.key,
      { trustedRoot: cacheDir, maxEntryBytes: MAX_SEMANTIC_REGION_RECEIPT_BYTES },
    );
    return receipt !== null && verifyRevisionShardAdmissionReceipt(
      signer,
      receipt.value,
      {
        shardKey: pending.key,
        baseInputKey: pending.baseInputKey,
        payloadDigest: shard.payloadDigest,
      },
    );
  } catch {
    return false;
  }
}

function requireStoredContext(
  value: unknown,
  expectedDigest: string,
): StoredSemanticRegionContextV2 {
  if (
    !isRecord(value)
    || !hasExactKeys(value, ["context", "key", "version"])
    || value.version !== SEMANTIC_REGION_CACHE_VERSION
    || value.key !== expectedDigest
    || !isRecord(value.context)
    || canonicalJsonSha256(value.context) !== expectedDigest
  ) {
    throw new Error("invalid semantic-region context payload");
  }
  return value as unknown as StoredSemanticRegionContextV2;
}

function requireStoredRegion(
  value: unknown,
  expected: AddressedSemanticRegion,
): StoredSemanticRegionShardV2 {
  if (
    !isRecord(value)
    || !hasExactKeys(value, [
      "codecVersion",
      "contextDigest",
      "contributions",
      "inputs",
      "key",
      "version",
    ])
    || value.version !== SEMANTIC_REGION_CACHE_VERSION
    || value.codecVersion !== SEMANTIC_REGION_CONTRIBUTION_CODEC_VERSION
    || value.key !== expected.key
    || value.contextDigest !== expected.inputs.contextDigest
    || !isRecord(value.inputs)
    || semanticRegionAddress(value.inputs as unknown as SemanticRegionInputV2) !== expected.key
    || canonicalJson(value.inputs) !== canonicalJson(expected.inputs)
  ) {
    throw new Error("invalid semantic-region shard identity");
  }
  return value as unknown as StoredSemanticRegionShardV2;
}

function semanticRegionAddress(inputs: SemanticRegionInputV2): string {
  return canonicalJsonSha256({
    kind: "typescript-semantic-region-input",
    inputs,
  });
}

function requireRegionMembership(
  region: AddressedSemanticRegion,
  files: readonly Pick<UnitFileContributionV1, "file">[],
): void {
  const expected = [...region.files].sort(compareCanonicalStrings);
  const actual = files.map((file) => file.file).sort(compareCanonicalStrings);
  if (
    expected.length !== actual.length
    || expected.some((file, index) => file !== actual[index])
  ) {
    throw new Error(`semantic-region contribution membership differs from ${region.id}`);
  }
}

function semanticRegionContextRoot(cacheDir: string): string {
  return resolve(cacheDir, "semantic-region-contexts");
}

function semanticRegionShardRoot(cacheDir: string, contextDigest: string): string {
  return resolve(cacheDir, "semantic-region-shards", contextDigest);
}

function semanticRegionAdmissionRoot(
  cacheDir: string,
  admission: RevisionShardAdmissionCapability,
): string {
  return resolve(cacheDir, "admissions", admission.keyId);
}

interface ResolvedSemanticRegionCacheLimits {
  maxContextEntryBytes: number;
  maxShardEntryBytes: number;
  maxContributionBytes: number;
  maxRegionFiles: number;
}

function resolvedCacheLimits(
  limits: SemanticRegionCacheLimits,
): ResolvedSemanticRegionCacheLimits {
  return {
    maxContextEntryBytes: narrowedLimit(
      limits.maxContextEntryBytes,
      MAX_SEMANTIC_REGION_CONTEXT_BYTES,
      "semantic-region context entry byte limit",
    ),
    maxShardEntryBytes: narrowedLimit(
      limits.maxShardEntryBytes,
      MAX_SEMANTIC_REGION_SHARD_BYTES,
      "semantic-region shard entry byte limit",
    ),
    maxContributionBytes: narrowedLimit(
      limits.maxContributionBytes,
      MAX_SEMANTIC_REGION_CONTRIBUTION_BYTES,
      "semantic-region contribution byte limit",
    ),
    maxRegionFiles: narrowedCountLimit(
      limits.maxRegionFiles,
      MAX_SEMANTIC_REGION_FILES,
      "semantic-region file-count limit",
    ),
  };
}

function narrowedLimit(
  value: number | undefined,
  hardLimit: number,
  label: string,
): number {
  if (value === undefined) return hardLimit;
  if (!Number.isSafeInteger(value) || value <= 0 || value > hardLimit) {
    throw new TypeError(`${label} must narrow the ${hardLimit}-byte hard limit`);
  }
  return value;
}

function narrowedCountLimit(
  value: number | undefined,
  hardLimit: number,
  label: string,
): number {
  if (value === undefined) return hardLimit;
  if (!Number.isSafeInteger(value) || value <= 0 || value > hardLimit) {
    throw new TypeError(`${label} must narrow the ${hardLimit} hard limit`);
  }
  return value;
}

function assertCacheEntryFits(
  address: string,
  value: unknown,
  maxEntryBytes: number,
  boundary: "cache-context-entry-bytes" | "cache-shard-entry-bytes",
): void {
  const canonicalValue = canonicalJson(value);
  const payloadDigest = sha256Hex(canonicalValue);
  // Mirror immutable-cache.ts's canonical envelope exactly so a value accepted for publication is
  // guaranteed to be readable under the same boundary. Keep the format literal versioned there
  // and here; a format change must update the semantic cache schema as well.
  const bytes = Buffer.byteLength(
    `{"address":${JSON.stringify(address)},`
    + `"format":${JSON.stringify(IMMUTABLE_JSON_CACHE_FORMAT)},`
    + `"payloadDigest":${JSON.stringify(payloadDigest)},`
    + `"value":${canonicalValue}}`,
    "utf8",
  );
  if (bytes > maxEntryBytes) {
    throw new SemanticRegionLimitError(boundary, maxEntryBytes, bytes);
  }
}

function isRepairableImmutableEntryError(error: unknown): boolean {
  return error instanceof ImmutableCacheCollisionError
    || error instanceof ImmutableCacheCorruptionError;
}

function repairTrashRoot(cacheDir: string): string {
  return resolve(cacheDir, ".retention-trash", "repair");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort(compareCanonicalStrings);
  const sortedExpected = [...expected].sort(compareCanonicalStrings);
  return actual.length === sortedExpected.length
    && actual.every((key, index) => key === sortedExpected[index]);
}
