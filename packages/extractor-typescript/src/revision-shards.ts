/**
 * Opt-in execution policy for the revision-safe TypeScript shard pipeline.
 *
 * This is deliberately an extractor capability rather than a request-facing feature. The web
 * server owns the cache root, exact Git tree, and provenance fields and transfers the resulting
 * value over its private worker protocol.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { ExtractOptions, ExtractionResult } from "@meridian/core";
import {
  isRevisionShardAdmissionCapability,
  type RevisionShardAdmissionCapability,
  type RevisionShardAdmissionSigner,
  type RevisionShardAdmissionVerifier,
} from "./incremental-poc/admission";
import { extractRevisionDifferential } from "./incremental-poc/differential-revision";
import {
  extractRevisionCandidate,
  extractRevisionWithCache,
} from "./incremental-poc/extract-revision";
import type { AnalysisPolicyFingerprint } from "./incremental-poc/model";

export const TYPESCRIPT_REVISION_SHARD_MODES = [
  "empty",
  "shadow",
  "admitted",
  "verified-experimental",
] as const;

export type TypeScriptRevisionShardMode = typeof TYPESCRIPT_REVISION_SHARD_MODES[number];

export interface TypeScriptRevisionShardRuntimeFingerprint {
  nodeVersion: string;
  platform: string;
  arch: string;
  typescriptVersion: string;
  tsMorphVersion: string;
}

export interface TypeScriptRevisionShardPolicy {
  version: 1;
  mode: TypeScriptRevisionShardMode;
  /** Server-owned persistent root, always outside the exact-revision checkout. */
  cacheDir: string;
  /**
   * Optional server-owned, request-scoped exchange for one exact PR revision pair.
   *
   * Its contents are never admitted to the persistent cache and are deleted after both workers
   * settle. Complete unit fingerprints plus observed resolver traces remain the reuse boundary.
   */
  pairCacheDir: string | null;
  /** Exact full Git tree object id, never a branch, abbreviated id, or mutable ref. */
  treeOid: string;
  /** Digest over the exact executable extractor and its declared runtime dependency closure. */
  buildFingerprint: string;
  /** Digest of the fixed repository-analysis policy and its version. */
  analysisPolicyFingerprint: string;
  /**
   * Private server capability used only to authenticate cold-oracle admission receipts. It is
   * absent from cache identity and null for modes that neither issue nor consume admissions.
   */
  admission: RevisionShardAdmissionCapability | null;
  /** Stable runtime coordinates; process nonces are intentionally not reusable provenance. */
  runtimeFingerprint: TypeScriptRevisionShardRuntimeFingerprint;
}

/**
 * Closed provenance boundary for values supplied by the CLI bridge.
 *
 * `root` is bound to the verified exact Git checkout; `project` and `include` disable shards;
 * `supplementalFiles` is normalized into the exact revision request; and `onProgress` is
 * observation-only. Every other ExtractOptions field is copied into `analysisPolicy()` and thus
 * every unit fingerprint. Adding a new ExtractOptions field without classifying it here is a
 * compile-time error rather than a manual version-bump obligation.
 */
type RevisionShardRoutedExtractOption =
  | "root"
  | "project"
  | "include"
  | "supplementalFiles"
  | "onProgress";
type RevisionShardFingerprintedExtractOption =
  | "depth"
  | "exclude"
  | "includeExternal"
  | "includeUnresolved"
  | "emitImportEdges"
  | "valueRefs";
type UnaccountedRevisionShardExtractOption = Exclude<
  keyof ExtractOptions,
  RevisionShardRoutedExtractOption | RevisionShardFingerprintedExtractOption
>;
type UnknownRevisionShardExtractOption = Exclude<
  RevisionShardRoutedExtractOption | RevisionShardFingerprintedExtractOption,
  keyof ExtractOptions
>;
type MissingRevisionShardPolicyField = Exclude<
  RevisionShardFingerprintedExtractOption,
  keyof AnalysisPolicyFingerprint
>;
type UnknownRevisionShardPolicyField = Exclude<
  keyof AnalysisPolicyFingerprint,
  RevisionShardFingerprintedExtractOption
>;
const ALL_REVISION_SHARD_EXTRACT_OPTIONS_ARE_ACCOUNTED_FOR:
  Record<UnaccountedRevisionShardExtractOption, never> = {};
const ALL_CLASSIFIED_REVISION_SHARD_OPTIONS_EXIST:
  Record<UnknownRevisionShardExtractOption, never> = {};
const ALL_FINGERPRINTED_OPTIONS_ARE_POLICY_FIELDS:
  Record<MissingRevisionShardPolicyField | UnknownRevisionShardPolicyField, never> = {};
void ALL_REVISION_SHARD_EXTRACT_OPTIONS_ARE_ACCOUNTED_FOR;
void ALL_CLASSIFIED_REVISION_SHARD_OPTIONS_EXIST;
void ALL_FINGERPRINTED_OPTIONS_ARE_POLICY_FIELDS;

export type TypeScriptRevisionShardDecision =
  | { useShards: true }
  | {
      useShards: false;
      reason:
        | "explicit-project"
        | "explicit-include"
        | "single-project-or-unsupported-workspace";
    };

/**
 * Keep fallback decisions pure and inspectable. A fallback invokes the ordinary canonical
 * extractor; it never mutates or partially consumes the shard cache.
 */
export function typeScriptRevisionShardDecision(
  options: ExtractOptions,
  hasPerPackageWorkspace: boolean,
): TypeScriptRevisionShardDecision {
  if (options.project !== undefined) {
    return { useShards: false, reason: "explicit-project" };
  }
  if (options.include !== undefined) {
    return { useShards: false, reason: "explicit-include" };
  }
  if (!hasPerPackageWorkspace) {
    return { useShards: false, reason: "single-project-or-unsupported-workspace" };
  }
  return { useShards: true };
}

export function requireTypeScriptRevisionShardPolicy(
  value: unknown,
): TypeScriptRevisionShardPolicy {
  if (!isTypeScriptRevisionShardPolicy(value)) {
    throw new TypeError("invalid TypeScript revision-shard policy");
  }
  return value;
}

export function isTypeScriptRevisionShardPolicy(
  value: unknown,
): value is TypeScriptRevisionShardPolicy {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const policy = value as TypeScriptRevisionShardPolicy;
  return hasExactKeys(policy, [
    "admission",
    "analysisPolicyFingerprint",
    "buildFingerprint",
    "cacheDir",
    "mode",
    "pairCacheDir",
    "runtimeFingerprint",
    "treeOid",
    "version",
  ])
    && hasExactKeys(policy.runtimeFingerprint, [
      "arch",
      "nodeVersion",
      "platform",
      "tsMorphVersion",
      "typescriptVersion",
    ])
    && policy.version === 1
    && TYPESCRIPT_REVISION_SHARD_MODES.includes(policy.mode)
    && isAbsolute(policy.cacheDir)
    && Buffer.byteLength(policy.cacheDir) <= 4_096
    && (policy.pairCacheDir === null
      || (isAbsolute(policy.pairCacheDir) && Buffer.byteLength(policy.pairCacheDir) <= 4_096))
    && (policy.mode === "admitted" || policy.pairCacheDir === null)
    && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(policy.treeOid)
    && /^[a-f0-9]{64}$/.test(policy.buildFingerprint)
    && /^[a-f0-9]{64}$/.test(policy.analysisPolicyFingerprint)
    && validAdmission(policy.mode, policy.admission)
    && validRuntimeFingerprint(policy.runtimeFingerprint);
}

function hasExactKeys(
  value: unknown,
  expected: readonly string[],
): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length
    && actual.every((key, index) => key === sortedExpected[index]);
}

export async function extractTypeScriptRevisionWithPolicy(
  options: ExtractOptions,
  policyInput: TypeScriptRevisionShardPolicy,
): Promise<ExtractionResult> {
  const policy = requireTypeScriptRevisionShardPolicy(policyInput);
  const request = {
    root: options.root,
    treeOid: policy.treeOid,
    cacheDir: policy.cacheDir,
    extractorVersion: extractorVersion(policy),
    analysisPolicyVersion: policy.analysisPolicyFingerprint,
    supplementalFiles: options.supplementalFiles,
    onProgress: options.onProgress,
    options: {
      depth: options.depth,
      exclude: options.exclude,
      includeExternal: options.includeExternal,
      includeUnresolved: options.includeUnresolved,
      emitImportEdges: options.emitImportEdges,
      valueRefs: options.valueRefs,
    },
  };

  if (policy.mode === "verified-experimental") {
    return (await extractRevisionWithCache(request)).result;
  }
  if (policy.mode === "shadow") {
    // Shadow compares both the complete graph and every serialized unit contribution, publishes
    // authenticated admissions only after parity, and continues serving the cold oracle.
    return (await extractRevisionDifferential(request, {
      admissionSigner: policy.admission as RevisionShardAdmissionSigner,
    })).cold.result;
  }
  if (policy.mode === "admitted") {
    // A receipt proves that this exact immutable shard matched an empty-cache cold extraction.
    // Misses are computed by the canonical pipeline and deliberately remain unpublished until a
    // later shadow run admits them.
    return (await extractRevisionCandidate(request, {
      requiredAdmission: policy.admission as RevisionShardAdmissionVerifier,
      ...(policy.pairCacheDir === null
        ? {}
        : { ephemeralPairCacheDir: policy.pairCacheDir }),
    })).result;
  }

  const emptyRunsRoot = resolve(policy.cacheDir, "empty-runs");
  mkdirSync(emptyRunsRoot, { recursive: true, mode: 0o700 });
  const emptyCache = mkdtempSync(join(emptyRunsRoot, "run-"));
  try {
    return (await extractRevisionWithCache({ ...request, cacheDir: emptyCache })).result;
  } finally {
    rmSync(emptyCache, { recursive: true, force: true });
  }
}

function validAdmission(
  mode: TypeScriptRevisionShardMode,
  value: RevisionShardAdmissionCapability | null,
): boolean {
  if (mode === "shadow") {
    return isRevisionShardAdmissionCapability(value) && value.kind === "signer";
  }
  if (mode === "admitted") {
    return isRevisionShardAdmissionCapability(value) && value.kind === "verifier";
  }
  return value === null;
}

function extractorVersion(policy: TypeScriptRevisionShardPolicy): string {
  return JSON.stringify({
    formatVersion: 1,
    buildFingerprint: policy.buildFingerprint,
    runtimeFingerprint: {
      nodeVersion: policy.runtimeFingerprint.nodeVersion,
      platform: policy.runtimeFingerprint.platform,
      arch: policy.runtimeFingerprint.arch,
      typescriptVersion: policy.runtimeFingerprint.typescriptVersion,
      tsMorphVersion: policy.runtimeFingerprint.tsMorphVersion,
    },
  });
}

function validRuntimeFingerprint(
  value: TypeScriptRevisionShardRuntimeFingerprint,
): boolean {
  return value !== null
    && typeof value === "object"
    && [
      value.nodeVersion,
      value.platform,
      value.arch,
      value.typescriptVersion,
      value.tsMorphVersion,
    ].every((part) => typeof part === "string" && part.length > 0 && part.length <= 128);
}
