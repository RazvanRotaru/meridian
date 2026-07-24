/**
 * Server ownership boundary for revision-safe TypeScript shard execution.
 *
 * The HTTP request contributes no fields here. The web server resolves the exact local Git tree,
 * chooses the cache directory, and stamps build/runtime/policy provenance before private IPC.
 */

import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import type {
  TypeScriptRevisionShardMode,
  TypeScriptRevisionShardPolicy,
} from "@meridian/extractor-typescript";
import { SCHEMA_VERSION } from "@meridian/core";
import {
  analysisRuntimeFingerprint,
  type AnalysisRuntimeFingerprint,
} from "../analysis-runtime-fingerprint";
import {
  REPOSITORY_ANALYSIS_POLICY,
  REPOSITORY_ANALYSIS_VERSION,
} from "../repository-analysis-contract";
import { runGit } from "./git-exec";
import type { runRepositoryAnalysisChild } from "./repository-analysis-child";
import { isOperationCancelled, throwIfAborted } from "./web-cancellation";

const GIT_TREE_OID = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const TYPESCRIPT_REVISION_SHARD_MODES = [
  "empty",
  "shadow",
  "verified-experimental",
] as const satisfies readonly TypeScriptRevisionShardMode[];

export type ServerTypeScriptRevisionShardDecision =
  | { kind: "disabled" }
  | { kind: "fallback"; reason: "not-exact-git-root" | "git-identity-unavailable" }
  | { kind: "enabled"; policy: TypeScriptRevisionShardPolicy };

export function parseTypeScriptRevisionShardMode(value: string): TypeScriptRevisionShardMode {
  if ((TYPESCRIPT_REVISION_SHARD_MODES as readonly string[]).includes(value)) {
    return value as TypeScriptRevisionShardMode;
  }
  throw new TypeError(
    `TypeScript incremental mode must be one of: ${TYPESCRIPT_REVISION_SHARD_MODES.join(", ")}`,
  );
}

export async function serverTypeScriptRevisionShardDecision(inputs: {
  cacheRoot: string;
  root: string;
  mode?: TypeScriptRevisionShardMode;
  signal?: AbortSignal;
  runtimeFingerprint?: AnalysisRuntimeFingerprint;
}): Promise<ServerTypeScriptRevisionShardDecision> {
  if (inputs.mode === undefined) return { kind: "disabled" };
  throwIfAborted(inputs.signal);

  let output: string;
  try {
    output = await runGit(["rev-parse", "--show-toplevel", "HEAD^{tree}"], {
      cwd: inputs.root,
      signal: inputs.signal,
    });
  } catch (error) {
    if (isOperationCancelled(error) || inputs.signal?.aborted) throw error;
    return { kind: "fallback", reason: "git-identity-unavailable" };
  }
  const [gitRootText, treeOidText, ...extra] = output.trim().split(/\r?\n/);
  const treeOid = treeOidText?.trim().toLowerCase();
  if (extra.length > 0 || gitRootText === undefined || treeOid === undefined
    || !GIT_TREE_OID.test(treeOid)) {
    return { kind: "fallback", reason: "git-identity-unavailable" };
  }
  try {
    if (realpathSync.native(resolve(inputs.root)) !== realpathSync.native(resolve(gitRootText))) {
      return { kind: "fallback", reason: "not-exact-git-root" };
    }
  } catch {
    return { kind: "fallback", reason: "git-identity-unavailable" };
  }

  const runtime = inputs.runtimeFingerprint ?? analysisRuntimeFingerprint();
  return {
    kind: "enabled",
    policy: {
      version: 1,
      mode: inputs.mode,
      cacheDir: resolve(
        inputs.cacheRoot,
        "typescript-revision-shards-v1",
        cacheNamespace(inputs.mode),
      ),
      treeOid,
      buildFingerprint: runtime.buildFingerprint,
      analysisPolicyFingerprint: createHash("sha256").update(JSON.stringify({
        version: 1,
        repositoryAnalysisVersion: REPOSITORY_ANALYSIS_VERSION,
        schemaVersion: SCHEMA_VERSION,
        policy: REPOSITORY_ANALYSIS_POLICY,
      })).digest("hex"),
      runtimeFingerprint: {
        nodeVersion: runtime.nodeVersion,
        platform: runtime.platform,
        arch: runtime.arch,
        typescriptVersion: runtime.typescriptVersion,
        tsMorphVersion: runtime.tsMorphVersion,
      },
    },
  };
}

function cacheNamespace(mode: TypeScriptRevisionShardMode): string {
  switch (mode) {
    case "empty":
      return "empty";
    case "shadow":
      return "shadow-admitted";
    case "verified-experimental":
      return "verified-experimental";
  }
}

/**
 * Preserve the child function's public signature while adding only a server-selected capability.
 * Unsupported subdirectory/materialized roots use the ordinary canonical extractor.
 */
export function withServerTypeScriptRevisionShards(
  repositoryAnalysis: typeof runRepositoryAnalysisChild,
  cacheRoot: string,
  mode?: TypeScriptRevisionShardMode,
): typeof runRepositoryAnalysisChild {
  if (mode === undefined) return repositoryAnalysis;
  return async (request, options) => {
    const decision = await serverTypeScriptRevisionShardDecision({
      cacheRoot,
      root: request.absoluteRoot,
      mode,
      signal: options.signal,
    });
    return repositoryAnalysis(request, {
      ...options,
      ...(decision.kind === "enabled"
        ? { typeScriptRevisionShards: decision.policy }
        : {}),
    });
  };
}
