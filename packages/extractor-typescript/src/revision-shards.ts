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
import { extractRevisionDifferential } from "./incremental-poc/differential-revision";
import { extractRevisionWithCache } from "./incremental-poc/extract-revision";

export const TYPESCRIPT_REVISION_SHARD_MODES = [
  "empty",
  "shadow",
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
  /** Exact full Git tree object id, never a branch, abbreviated id, or mutable ref. */
  treeOid: string;
  /** Build-time digest over extractor, schema, compiler configuration, and lock inputs. */
  buildFingerprint: string;
  /** Digest of the fixed repository-analysis policy and its version. */
  analysisPolicyFingerprint: string;
  /** Stable runtime coordinates; process nonces are intentionally not reusable provenance. */
  runtimeFingerprint: TypeScriptRevisionShardRuntimeFingerprint;
}

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
  value: TypeScriptRevisionShardPolicy,
): TypeScriptRevisionShardPolicy {
  if (!hasExactKeys(value, [
    "analysisPolicyFingerprint",
    "buildFingerprint",
    "cacheDir",
    "mode",
    "runtimeFingerprint",
    "treeOid",
    "version",
  ])
    || !hasExactKeys(value.runtimeFingerprint, [
      "arch",
      "nodeVersion",
      "platform",
      "tsMorphVersion",
      "typescriptVersion",
    ])
    || value.version !== 1
    || !TYPESCRIPT_REVISION_SHARD_MODES.includes(value.mode)
    || !isAbsolute(value.cacheDir)
    || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(value.treeOid)
    || !/^[a-f0-9]{64}$/.test(value.buildFingerprint)
    || !/^[a-f0-9]{64}$/.test(value.analysisPolicyFingerprint)
    || !validRuntimeFingerprint(value.runtimeFingerprint)) {
    throw new TypeError("invalid TypeScript revision-shard policy");
  }
  return value;
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
    // The semantic oracle is the exact shard pipeline with an empty cache. Serving the cold result
    // keeps shadow mode safe even though candidate shards are exercised and compared.
    return (await extractRevisionDifferential(request)).cold.result;
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
