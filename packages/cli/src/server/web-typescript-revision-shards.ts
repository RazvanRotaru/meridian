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
  RevisionShardAdmissionCapability,
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
import type { RepositoryWorkspaceLease } from "./web-repository-mirror";
import { typeScriptRevisionShardAuthority } from "./web-typescript-revision-shard-authority";
import { withTypeScriptRevisionShardBuildLock } from "./web-typescript-revision-shard-lock";
import { isOperationCancelled, throwIfAborted } from "./web-cancellation";

const GIT_TREE_OID = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const TYPESCRIPT_REVISION_SHARD_MODES = [
  "empty",
  "shadow",
  "admitted",
  "verified-experimental",
] as const satisfies readonly TypeScriptRevisionShardMode[];

export type ServerTypeScriptRevisionShardDecision =
  | { kind: "disabled" }
  | {
      kind: "fallback";
      reason:
        | "not-exact-git-root"
        | "git-identity-unavailable"
        | "not-owned-exact-workspace";
    }
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
  exactWorkspaces?: readonly Pick<
    RepositoryWorkspaceLease,
    "commit" | "isActive" | "repoDir"
  >[];
}): Promise<ServerTypeScriptRevisionShardDecision> {
  if (inputs.mode === undefined) return { kind: "disabled" };
  throwIfAborted(inputs.signal);

  let output: string;
  try {
    output = await runGit(["rev-parse", "--show-toplevel", "HEAD", "HEAD^{tree}"], {
      cwd: inputs.root,
      signal: inputs.signal,
    });
  } catch (error) {
    if (isOperationCancelled(error) || inputs.signal?.aborted) throw error;
    return { kind: "fallback", reason: "git-identity-unavailable" };
  }
  const [gitRootText, headCommitText, treeOidText, ...extra] = output.trim().split(/\r?\n/);
  const headCommit = headCommitText?.trim().toLowerCase();
  const treeOid = treeOidText?.trim().toLowerCase();
  if (extra.length > 0 || gitRootText === undefined || headCommit === undefined
    || treeOid === undefined || !GIT_TREE_OID.test(headCommit) || !GIT_TREE_OID.test(treeOid)) {
    return { kind: "fallback", reason: "git-identity-unavailable" };
  }
  try {
    const canonicalRoot = realpathSync.native(resolve(inputs.root));
    if (canonicalRoot !== realpathSync.native(resolve(gitRootText))) {
      return { kind: "fallback", reason: "not-exact-git-root" };
    }
    if (inputs.mode === "shadow" || inputs.mode === "admitted") {
      const owned = inputs.exactWorkspaces?.find((workspace) => (
        workspace.isActive()
        && workspace.commit.toLowerCase() === headCommit
        && realpathSync.native(resolve(workspace.repoDir)) === canonicalRoot
      ));
      if (owned === undefined) {
        return { kind: "fallback", reason: "not-owned-exact-workspace" };
      }
    }
  } catch {
    return { kind: "fallback", reason: "git-identity-unavailable" };
  }

  const runtime = inputs.runtimeFingerprint ?? analysisRuntimeFingerprint();
  let admission: RevisionShardAdmissionCapability | null = null;
  if (inputs.mode === "shadow" || inputs.mode === "admitted") {
    const authority = await typeScriptRevisionShardAuthority(inputs.cacheRoot);
    admission = inputs.mode === "shadow" ? authority.signer : authority.verifier;
  }
  return {
    kind: "enabled",
    policy: {
      version: 1,
      mode: inputs.mode,
      admission,
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
    case "admitted":
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
  exactWorkspaces?: readonly Pick<
    RepositoryWorkspaceLease,
    "commit" | "isActive" | "repoDir"
  >[],
): typeof runRepositoryAnalysisChild {
  if (mode === undefined) return repositoryAnalysis;
  return async (request, options) => {
    const decision = await serverTypeScriptRevisionShardDecision({
      cacheRoot,
      root: request.absoluteRoot,
      mode,
      exactWorkspaces,
      signal: options.signal,
    });
    const execute = (signal: AbortSignal | undefined) => repositoryAnalysis(request, {
      ...options,
      signal,
      ...(decision.kind === "enabled"
        ? { typeScriptRevisionShards: decision.policy }
        : {}),
    });
    return decision.kind === "enabled"
      && (decision.policy.mode === "shadow" || decision.policy.mode === "admitted")
      ? withTypeScriptRevisionShardBuildLock(cacheRoot, options.signal, execute)
      : execute(options.signal);
  };
}
