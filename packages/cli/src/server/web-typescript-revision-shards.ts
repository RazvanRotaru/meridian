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
  REPOSITORY_ANALYSIS_POLICY,
  REPOSITORY_ANALYSIS_VERSION,
} from "../repository-analysis-contract";
import {
  typeScriptRevisionShardRuntimeFingerprint,
  type TypeScriptRevisionShardRuntimeProvenance,
} from "../typescript-revision-shard-runtime-fingerprint";
import { runGit } from "./git-exec";
import type { runRepositoryAnalysisChild } from "./repository-analysis-child";
import type { RepositoryWorkspaceLease } from "./web-repository-mirror";
import { typeScriptRevisionShardAuthority } from "./web-typescript-revision-shard-authority";
import {
  tryWithTypeScriptRevisionShardBuildLock,
  withTypeScriptRevisionShardBuildLock,
} from "./web-typescript-revision-shard-lock";
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
        | "not-owned-exact-workspace"
        | "runtime-provenance-unavailable";
    }
  | { kind: "enabled"; policy: TypeScriptRevisionShardPolicy };

type ExactWorkspace = Pick<RepositoryWorkspaceLease, "commit" | "isActive" | "repoDir">;

export type ServerTypeScriptRevisionShardAnalysisGroupTryResult<Result> =
  | { readonly kind: "admitted"; readonly value: Result }
  | { readonly kind: "unavailable" };

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
  runtimeFingerprint?: TypeScriptRevisionShardRuntimeProvenance;
  exactWorkspaces?: readonly ExactWorkspace[];
  /** Private request-scoped exchange; only admitted exact-revision pairs receive it. */
  pairCacheDir?: string;
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

  let runtime: TypeScriptRevisionShardRuntimeProvenance;
  try {
    runtime = inputs.runtimeFingerprint ?? typeScriptRevisionShardRuntimeFingerprint();
  } catch {
    return { kind: "fallback", reason: "runtime-provenance-unavailable" };
  }
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
      pairCacheDir: inputs.mode === "admitted" && inputs.pairCacheDir !== undefined
        ? resolve(inputs.pairCacheDir)
        : null,
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
  exactWorkspaces?: readonly ExactWorkspace[],
  pairCacheDir?: string,
): typeof runRepositoryAnalysisChild {
  return serverTypeScriptRevisionShardRunner(
    repositoryAnalysis,
    cacheRoot,
    mode,
    exactWorkspaces,
    undefined,
    pairCacheDir,
  );
}

/**
 * Hold the admitted cache's cross-process fence once around one memory-admitted analysis group.
 *
 * The persistent admitted cache is read-only: misses stay unadmitted and successful reads never
 * mutate it. One exact revision pair may exchange canonical misses through a separate ephemeral
 * directory that the caller owns and deletes after both workers settle. A caller that atomically
 * reserves multiple worker slots may therefore run those readers concurrently while this one
 * exclusive fence keeps retention, shadow writers, and other Meridian processes out. Shadow
 * remains per-child exclusive because it publishes admission evidence.
 */
export async function withServerTypeScriptRevisionShardAnalysisGroup<Result>(inputs: {
  repositoryAnalysis: typeof runRepositoryAnalysisChild;
  cacheRoot: string;
  mode?: TypeScriptRevisionShardMode;
  exactWorkspaces?: readonly ExactWorkspace[];
  pairCacheDir?: string;
  signal: AbortSignal;
  work(
    repositoryAnalysis: typeof runRepositoryAnalysisChild,
    signal: AbortSignal,
  ): Result | Promise<Result>;
}): Promise<Result> {
  const attempt = await runServerTypeScriptRevisionShardAnalysisGroup(inputs, false);
  if (attempt.kind !== "admitted") {
    throw new Error("blocking TypeScript revision-shard analysis did not acquire the build lock");
  }
  return attempt.value;
}

/**
 * Attempt an admitted analysis group without waiting while memory slots are reserved.
 *
 * An `unavailable` result means another process owns the cache fence. Callers must release their
 * current admission before retrying; the requested local slot count remains a caller policy.
 * Modes without this fence always return an `admitted` result.
 */
export async function tryWithServerTypeScriptRevisionShardAnalysisGroup<Result>(inputs: {
  repositoryAnalysis: typeof runRepositoryAnalysisChild;
  cacheRoot: string;
  mode?: TypeScriptRevisionShardMode;
  exactWorkspaces?: readonly ExactWorkspace[];
  pairCacheDir?: string;
  signal: AbortSignal;
  work(
    repositoryAnalysis: typeof runRepositoryAnalysisChild,
    signal: AbortSignal,
  ): Result | Promise<Result>;
}): Promise<ServerTypeScriptRevisionShardAnalysisGroupTryResult<Result>> {
  return runServerTypeScriptRevisionShardAnalysisGroup(inputs, true);
}

async function runServerTypeScriptRevisionShardAnalysisGroup<Result>(inputs: {
  repositoryAnalysis: typeof runRepositoryAnalysisChild;
  cacheRoot: string;
  mode?: TypeScriptRevisionShardMode;
  exactWorkspaces?: readonly ExactWorkspace[];
  pairCacheDir?: string;
  signal: AbortSignal;
  work(
    repositoryAnalysis: typeof runRepositoryAnalysisChild,
    signal: AbortSignal,
  ): Result | Promise<Result>;
}, skipIfBusy: boolean): Promise<ServerTypeScriptRevisionShardAnalysisGroupTryResult<Result>> {
  if (inputs.mode !== "admitted") {
    return {
      kind: "admitted",
      value: await inputs.work(
        withServerTypeScriptRevisionShards(
          inputs.repositoryAnalysis,
          inputs.cacheRoot,
          inputs.mode,
          inputs.exactWorkspaces,
          inputs.pairCacheDir,
        ),
        inputs.signal,
      ),
    };
  }
  const runWithLock = async (lockSignal: AbortSignal): Promise<Result> => inputs.work(
    serverTypeScriptRevisionShardRunner(
      inputs.repositoryAnalysis,
      inputs.cacheRoot,
      inputs.mode,
      inputs.exactWorkspaces,
      lockSignal,
      inputs.pairCacheDir,
    ),
    lockSignal,
  );
  if (skipIfBusy) {
    const attempted = await tryWithTypeScriptRevisionShardBuildLock(
      inputs.cacheRoot,
      inputs.signal,
      async (lockSignal) => ({
        kind: "admitted" as const,
        value: await runWithLock(lockSignal),
      }),
    );
    return attempted ?? { kind: "unavailable" };
  }
  return {
    kind: "admitted",
    value: await withTypeScriptRevisionShardBuildLock(
      inputs.cacheRoot,
      inputs.signal,
      runWithLock,
    ),
  };
}

function serverTypeScriptRevisionShardRunner(
  repositoryAnalysis: typeof runRepositoryAnalysisChild,
  cacheRoot: string,
  mode?: TypeScriptRevisionShardMode,
  exactWorkspaces?: readonly ExactWorkspace[],
  heldBuildLockSignal?: AbortSignal,
  pairCacheDir?: string,
): typeof runRepositoryAnalysisChild {
  if (mode === undefined) return repositoryAnalysis;
  return async (request, options) => {
    const executionSignal = combinedExecutionSignal(heldBuildLockSignal, options.signal);
    const decision = await serverTypeScriptRevisionShardDecision({
      cacheRoot,
      root: request.absoluteRoot,
      mode,
      exactWorkspaces,
      signal: executionSignal,
      pairCacheDir,
    });
    const execute = (signal: AbortSignal | undefined) => repositoryAnalysis(request, {
      ...options,
      signal,
      ...(decision.kind === "enabled"
        ? { typeScriptRevisionShards: decision.policy }
        : {}),
    });
    if (heldBuildLockSignal !== undefined) {
      return execute(executionSignal);
    }
    return decision.kind === "enabled"
      && (decision.policy.mode === "shadow" || decision.policy.mode === "admitted")
      ? withTypeScriptRevisionShardBuildLock(cacheRoot, options.signal, execute)
      : execute(options.signal);
  };
}

function combinedExecutionSignal(
  heldBuildLockSignal: AbortSignal | undefined,
  childSignal: AbortSignal | undefined,
): AbortSignal | undefined {
  if (heldBuildLockSignal === undefined || heldBuildLockSignal === childSignal) return childSignal;
  if (childSignal === undefined) return heldBuildLockSignal;
  return AbortSignal.any([heldBuildLockSignal, childSignal]);
}
