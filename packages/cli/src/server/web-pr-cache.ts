import { createHash, randomBytes, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  REPOSITORY_ANALYSIS_POLICY,
  REPOSITORY_ANALYSIS_VERSION,
} from "../repository-analysis-contract";
import type { RepositoryAnalysisRequest } from "../repository-analysis-contract";
import {
  analysisRuntimeFingerprint,
  type AnalysisRuntimeFingerprint,
} from "../analysis-runtime-fingerprint";
import { generatorVersion } from "../version";
import { SCHEMA_VERSION } from "@meridian/core";
import type { ChangedFileManifestEntry } from "@meridian/core";
import type { TypeScriptRevisionShardMode } from "@meridian/extractor-typescript";
import { parseGitHubSource, resolveExtractionSubdir, sanitizeSubdir } from "./clone";
import { runGit } from "./git-exec";
import {
  isRepositoryAnalysisFacts,
  runRepositoryAnalysisChild,
  verifyRepositoryArtifactFile,
  type RepositoryAnalysisChildOptions,
  type RepositoryAnalysisChildResult,
  type RepositoryAnalysisFacts,
  type RepositoryAnalysisProgress,
} from "./repository-analysis-child";
import { isOperationCancelled, throwIfAborted } from "./web-cancellation";
import { prepareWebCache } from "./web-cache";
import {
  verifiedArtifactFile,
  type VerifiedFileArtifactMaterial,
} from "./web-graph-store";
import {
  createStageDirectory,
  publishImmutable,
  readJson,
  removeEntry,
  writePrivateJson,
} from "./web-cache-storage";
import { WebError } from "./web-error";
import type { PrAnalyzeRequest } from "./web-pr-request";
import type { ArtifactSource } from "./web-source";
import type { PhaseAdmission } from "./web-analysis-coordinator";
import {
  repositoryKeyFor,
  type ExpectedRemoteRef,
  type RepositoryMirror,
  type RepositoryWorkspaceLease,
} from "./web-repository-mirror";
import {
  canonicalPrRevisionIdentity,
  createPrRevisionArtifactStage,
  populatedPrHeadRevisionIdentity,
  publishPrRevisionArtifact,
  readPrRevisionArtifact,
  type CachedPrRevisionArtifact,
  type PrRevisionArtifactReference,
} from "./web-pr-revision-cache";
import { withServerTypeScriptRevisionShards } from "./web-typescript-revision-shards";

export type GitHubSource = Extract<ArtifactSource, { kind: "github" }>;
type PrStage =
  | "clone"
  | "checkout"
  | "extract"
  | "extract-head"
  | "extract-merge-base"
  | "reuse-head"
  | "reuse-merge-base";

interface PrExtractionProgress {
  execution: { current: number; total: number };
  onProgress?: (progress: RepositoryAnalysisProgress) => void;
}

const FORMAT_VERSION = 12;
const COMMIT = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;
const SHA256 = /^[a-f0-9]{64}$/;
const SNAPSHOT_ID = /^[a-f0-9]{16}$/;
const WORKSPACE_ID = /^[a-f0-9]{32}$/;
const GIT_TIMEOUT_MS = 300_000;

interface ResolvedPrRevisions {
  base: ExpectedRemoteRef;
  baseSha: string;
  head: ExpectedRemoteRef;
  headSha: string;
}

interface PrSnapshotMetadata {
  formatVersion: number;
  analysisVersion: number;
  repositoryKey: string;
  headSha: string;
  baseSha: string;
  mergeBaseSha: string;
  analysisKey: string;
  artifactDigest: string;
  artifactBytes: number;
  artifactFacts: RepositoryAnalysisFacts;
  headStorage: PrRevisionStorage;
  comparisonArtifactDigest: string;
  comparisonArtifactBytes: number;
  comparisonFacts: RepositoryAnalysisFacts;
  comparisonStorage: PrRevisionStorage;
  snapshotDigest: string;
  snapshotId: string;
  workspaceId: string;
  warnings: string[];
}

type PrRevisionStorage =
  | { kind: "snapshot" }
  | { kind: "shared"; reference: PrRevisionArtifactReference };

interface CompletedRevisionArtifact {
  facts: RepositoryAnalysisFacts;
  material: VerifiedFileArtifactMaterial;
  byteLength: number;
  storage: PrRevisionStorage;
}

/**
 * The revision/analysis slot contains only this small mutable pointer. Artifact bytes live below
 * the selected immutable snapshot; exact source workspaces are named by its validated workspaceId
 * and pinned separately when a graph descriptor is published.
 */
interface PrSnapshotPointer {
  formatVersion: number;
  repositoryKey: string;
  headSha: string;
  baseSha: string;
  analysisKey: string;
  snapshotDigest: string;
  snapshotId: string;
}

export interface CachedPrGraph {
  artifactFacts: RepositoryAnalysisFacts;
  artifactMaterial: VerifiedFileArtifactMaterial;
  baseSha: string;
  cache: "hit" | "miss";
  comparisonMaterial: VerifiedFileArtifactMaterial;
  comparisonFacts: RepositoryAnalysisFacts;
  comparisonSourceDir: string;
  comparisonSourceLease: RepositoryWorkspaceLease;
  headSha: string;
  mergeBaseSha: string;
  sourceDir: string;
  sourceLease: RepositoryWorkspaceLease;
  warnings: string[];
}

export async function cachedPrGraph(inputs: {
  cacheRoot: string;
  repositories: RepositoryMirror;
  source: GitHubSource;
  body: PrAnalyzeRequest;
  cwd: string;
  token?: string;
  refresh?: boolean;
  onStage(stage: PrStage): void | Promise<void>;
  onExtractionProgress?(progress: RepositoryAnalysisProgress): void;
  signal?: AbortSignal;
  runPreparation: PhaseAdmission;
  runAnalysis: PhaseAdmission;
  /** Server startup policy; no field in the PR analysis HTTP request can override it. */
  typeScriptRevisionShardMode?: TypeScriptRevisionShardMode;
  /** Explicit loopback-only opt-in for cross-pair exact revision artifact reuse. */
  experimentalPrRevisionCache?: boolean;
  repositoryAnalysis?: typeof runRepositoryAnalysisChild;
}): Promise<CachedPrGraph> {
  prepareWebCache(inputs.cacheRoot);
  throwIfAborted(inputs.signal);
  const remoteUrl = parseGitHubSource(`${inputs.source.owner}/${inputs.source.repo}`);
  const resolved = await remoteRevisions(remoteUrl, inputs.body, inputs.cwd, inputs.token, inputs.signal);
  const revisions = revisionCoordinates(resolved);
  const repositoryKey = repositoryKeyFor(remoteUrl);
  const analysisKey = prAnalysisKey(inputs.source, inputs.body);
  const entry = join(
    inputs.cacheRoot,
    "pr-artifacts",
    prCacheSlotKey(repositoryKey, revisions, analysisKey),
  );
  const cached = inputs.refresh ? null : await readCached(
    entry,
    inputs.cacheRoot,
    repositoryKey,
    revisions,
    analysisKey,
    inputs.source,
    inputs.body,
    remoteUrl,
    inputs.repositories,
    inputs.experimentalPrRevisionCache === true,
    inputs.signal,
  );
  if (cached) {
    return { ...cached, cache: "hit" };
  }
  return createCachedGraph(entry, repositoryKey, resolved, analysisKey, remoteUrl, inputs);
}

async function createCachedGraph(
  entry: string,
  repositoryKey: string,
  revisions: ResolvedPrRevisions,
  analysisKey: string,
  remoteUrl: string,
  inputs: Parameters<typeof cachedPrGraph>[0],
): Promise<CachedPrGraph> {
  let stage: string | undefined;
  let preparedWorkspace: Awaited<ReturnType<RepositoryMirror["preparePullRequest"]>> | undefined;
  let borrowedWorkspace: Pick<CachedPrGraph, "sourceLease" | "comparisonSourceLease"> | undefined;
  let retainWorkspace = false;
  try {
    const runPreparation = inputs.runPreparation;
    const prepared = await runPreparation(async (phaseSignal) => {
      const preparedStage = createStageDirectory(join(inputs.cacheRoot, "pr-staging"));
      // Admission can discard a late success after cancellation, so ownership must escape now.
      stage = preparedStage;
      try {
        await inputs.onStage("clone");
        throwIfAborted(phaseSignal);
        const workspace = await inputs.repositories.preparePullRequest({
          remoteUrl,
          base: revisions.base,
          head: revisions.head,
          token: inputs.token,
          signal: phaseSignal,
          onFetchComplete: () => inputs.onStage("checkout"),
        });
        preparedWorkspace = workspace;
        return {
          comparisonRepoDir: workspace.comparison.repoDir,
          mergeBaseSha: workspace.mergeBaseSha,
          repoDir: workspace.head.repoDir,
          stage: preparedStage,
          workspace,
        };
      } catch (error) {
        removeEntry(preparedStage);
        stage = undefined;
        throw error;
      }
    });
    const { comparisonRepoDir, mergeBaseSha, repoDir, stage: preparedStage, workspace } = prepared;
    const revisionCoords = revisionCoordinates(revisions);
    const roots = extractionRoots(repoDir, comparisonRepoDir, inputs.source.subdir);
    const comparisonRoot = roots.headMaterialized
      ? { root: roots.comparison, materialized: false }
      : resolveOrMaterializeComparisonRoot(comparisonRepoDir, inputs.source.subdir);
    const headIdentity = roots.headMaterialized
      ? null
      : populatedPrHeadRevisionIdentity({
          repositoryKey,
          repositoryUrl: remoteUrl,
          commit: revisionCoords.headSha,
          branch: inputs.body.headRef,
          changedSince: mergeBaseSha,
          targetName: `${inputs.source.owner}/${inputs.source.repo}`,
          subdir: inputs.source.subdir,
        });
    const comparisonIdentity = comparisonRoot.materialized
      ? null
      : canonicalPrRevisionIdentity({
          repositoryKey,
          repositoryUrl: remoteUrl,
          commit: mergeBaseSha,
          targetName: `${inputs.source.owner}/${inputs.source.repo}`,
          subdir: inputs.source.subdir,
        });
    const cachedHead = inputs.refresh
      || inputs.experimentalPrRevisionCache !== true
      || headIdentity === null
      ? null
      : await readPrRevisionArtifact({
          cacheRoot: inputs.cacheRoot,
          identity: headIdentity,
          signal: inputs.signal,
        });
    const cachedComparison = inputs.refresh
      || inputs.experimentalPrRevisionCache !== true
      || comparisonIdentity === null
      ? null
      : await readPrRevisionArtifact({
          cacheRoot: inputs.cacheRoot,
          identity: comparisonIdentity,
          signal: inputs.signal,
        });
    let headResult = cachedHead === null ? null : sharedRevisionArtifact(cachedHead);
    let comparisonResult = cachedComparison === null ? null : sharedRevisionArtifact(cachedComparison);
    if (headResult !== null) await inputs.onStage("reuse-head");
    if (comparisonResult !== null) await inputs.onStage("reuse-merge-base");
    throwIfAborted(inputs.signal);
    if (headResult === null || comparisonResult === null) {
      await inputs.onStage("extract");
      const runAnalysis = inputs.runAnalysis;
      const analyzed = await runAnalysis(async (phaseSignal) => {
        const artifactPath = join(preparedStage, "artifact.json");
        const comparisonArtifactPath = join(preparedStage, "comparison-artifact.json");
        const repositoryAnalysis = withServerTypeScriptRevisionShards(
          inputs.repositoryAnalysis ?? runRepositoryAnalysisChild,
          inputs.cacheRoot,
          inputs.typeScriptRevisionShardMode,
          [workspace.head, workspace.comparison],
        );
        if (roots.headMaterialized) {
          // A whole-subtree deletion has no HEAD files to detect. Analyze the populated comparison
          // first, then use its bounded per-extractor hints to select every applicable empty side.
          comparisonResult ??= await extractCanonicalComparisonArtifact({
            cacheRoot: inputs.cacheRoot,
            identity: comparisonIdentity!,
            publishSharedRevision: inputs.experimentalPrRevisionCache === true,
            artifactOutputPath: comparisonArtifactPath,
            repositoryAnalysis,
            root: roots.comparison,
            source: inputs.source,
            remoteUrl,
            mergeBaseSha,
            token: inputs.token,
            signal: phaseSignal,
            onStage: inputs.onStage,
            execution: { current: 1, total: 2 },
            onExtractionProgress: inputs.onExtractionProgress,
          });
          throwIfAborted(phaseSignal);
          await inputs.onStage("extract-head");
          headResult = localRevisionArtifact(await extractPrHead(
            repositoryAnalysis,
            roots.head,
            inputs.source,
            inputs.body,
            remoteUrl,
            revisionCoords,
            mergeBaseSha,
            artifactPath,
            inputs.token,
            emptySideAnalysis(comparisonResult!.facts),
            phaseSignal,
            {
              execution: { current: 2, total: 2 },
              onProgress: inputs.onExtractionProgress,
            },
          ));
        } else {
          headResult ??= await extractPopulatedHeadArtifact({
            cacheRoot: inputs.cacheRoot,
            identity: headIdentity!,
            publishSharedRevision: inputs.experimentalPrRevisionCache === true,
            artifactOutputPath: artifactPath,
            repositoryAnalysis,
            root: roots.head,
            source: inputs.source,
            body: inputs.body,
            remoteUrl,
            revisions: revisionCoords,
            mergeBaseSha,
            token: inputs.token,
            signal: phaseSignal,
            onStage: inputs.onStage,
            execution: { current: 1, total: 2 },
            onExtractionProgress: inputs.onExtractionProgress,
          });
          throwIfAborted(phaseSignal);
          // Normal two-sided analysis remains independently auto-detected. Only a materialized empty
          // comparison (a whole-subtree addition) inherits language hints from the populated HEAD.
          if (comparisonRoot.materialized) {
            await inputs.onStage("extract-merge-base");
            comparisonResult = localRevisionArtifact(await extractPrComparison(
              repositoryAnalysis,
              comparisonRoot.root,
              inputs.source,
              remoteUrl,
              mergeBaseSha,
              comparisonArtifactPath,
              inputs.token,
              phaseSignal,
              emptySideAnalysis(headResult.facts),
              comparisonFingerprintFiles(headResult.facts.changedFiles),
              {
                execution: { current: 2, total: 2 },
                onProgress: inputs.onExtractionProgress,
              },
            ));
          } else if (comparisonResult === null) {
            comparisonResult = await extractCanonicalComparisonArtifact({
              cacheRoot: inputs.cacheRoot,
              identity: comparisonIdentity!,
              publishSharedRevision: inputs.experimentalPrRevisionCache === true,
              artifactOutputPath: comparisonArtifactPath,
              repositoryAnalysis,
              root: comparisonRoot.root,
              source: inputs.source,
              remoteUrl,
              mergeBaseSha,
              token: inputs.token,
              signal: phaseSignal,
              onStage: inputs.onStage,
              execution: { current: 2, total: 2 },
              onExtractionProgress: inputs.onExtractionProgress,
            });
          }
        }
        throwIfAborted(phaseSignal);
        return { head: headResult, comparison: comparisonResult };
      });
      headResult = analyzed.head;
      comparisonResult = analyzed.comparison;
    }
    throwIfAborted(inputs.signal);
    if (headResult === null || comparisonResult === null) {
      throw new WebError(422, "PR analysis did not produce both exact revisions");
    }
    const head = headResult;
    const comparison = comparisonResult;
    const artifactFacts = head.facts;
    const comparisonFacts = comparison.facts;
    const warnings = uniqueWarnings(artifactFacts.warnings, comparisonFacts.warnings);
    requireExactArtifactCoordinates(
      artifactFacts,
      comparisonFacts,
      revisionCoords,
      mergeBaseSha,
      inputs.body.headRef,
      remoteUrl,
      `${inputs.source.owner}/${inputs.source.repo}`,
    );
    throwIfAborted(inputs.signal);
    const artifactDigest = head.material.byteDigest;
    const comparisonArtifactDigest = comparison.material.byteDigest;
    const snapshotDigest = prSnapshotDigest({
      formatVersion: FORMAT_VERSION,
      analysisVersion: REPOSITORY_ANALYSIS_VERSION,
      repositoryKey,
      ...revisionCoords,
      mergeBaseSha,
      analysisKey,
      artifactDigest,
      artifactBytes: head.byteLength,
      artifactFacts,
      headStorage: head.storage,
      comparisonArtifactDigest,
      comparisonArtifactBytes: comparison.byteLength,
      comparisonFacts,
      comparisonStorage: comparison.storage,
      workspaceId: workspace.workspaceId,
      warnings,
    });
    // A digest alone is insufficient as a generation key: a corrupt/poisoned old checkout can
    // have the same analyzed artifacts as its clean replacement. A unique immutable generation
    // keeps both paths alive and lets the pointer move without mutating either snapshot.
    const snapshotId = randomBytes(8).toString("hex");
    writePrivateJson(join(preparedStage, "metadata.json"), {
      formatVersion: FORMAT_VERSION,
      analysisVersion: REPOSITORY_ANALYSIS_VERSION,
      repositoryKey,
      ...revisionCoords,
      mergeBaseSha,
      analysisKey,
      artifactDigest,
      artifactBytes: head.byteLength,
      artifactFacts,
      headStorage: head.storage,
      comparisonArtifactDigest,
      comparisonArtifactBytes: comparison.byteLength,
      comparisonFacts,
      comparisonStorage: comparison.storage,
      snapshotDigest,
      snapshotId,
      workspaceId: workspace.workspaceId,
      warnings,
    } satisfies PrSnapshotMetadata);
    throwIfAborted(inputs.signal);
    const destination = join(entry, "snapshots", snapshotId);
    const wonPublication = publishImmutable(preparedStage, destination);
    const published = wonPublication
      ? publishedGeneratedSnapshot(
          destination,
          head,
          comparison,
          revisionCoords,
          mergeBaseSha,
          warnings,
          inputs.source,
          workspace,
        )
      : await readSnapshot(
          destination,
          inputs.cacheRoot,
          repositoryKey,
          revisionCoords,
          analysisKey,
          snapshotId,
          snapshotDigest,
          inputs.source,
          inputs.body,
          remoteUrl,
          inputs.repositories,
          inputs.experimentalPrRevisionCache === true,
          inputs.signal,
    );
    if (!published) throw new WebError(422, "cached PR analysis failed verification");
    if (!wonPublication) {
      // The existing generation's leases are already ours. Record them before asynchronous loser
      // cleanup so a cleanup failure cannot leak the borrowed workspace pins.
      borrowedWorkspace = published;
      await workspace.discard();
      preparedWorkspace = undefined;
    }
    throwIfAborted(inputs.signal);
    writeCurrentPointer(entry, {
      formatVersion: FORMAT_VERSION,
      repositoryKey,
      ...revisionCoords,
      analysisKey,
      snapshotDigest,
      snapshotId,
    });
    retainWorkspace = wonPublication;
    return { ...published, cache: "miss" };
  } catch (error) {
    if (stage !== undefined) removeEntry(stage);
    const cleanup: Array<Promise<unknown>> = [];
    if (preparedWorkspace !== undefined && !retainWorkspace) cleanup.push(preparedWorkspace.discard());
    if (borrowedWorkspace !== undefined) {
      cleanup.push(Promise.resolve().then(() => borrowedWorkspace!.sourceLease.release()));
      cleanup.push(Promise.resolve().then(() => borrowedWorkspace!.comparisonSourceLease.release()));
    }
    // Every cleanup owner settles independently; a failed Git rollback cannot strand winner leases
    // or replace the request's primary failure with a memoized discard rejection.
    await Promise.allSettled(cleanup);
    throw error;
  }
}

async function readCached(
  entry: string,
  cacheRoot: string,
  repositoryKey: string,
  revisions: { headSha: string; baseSha: string },
  analysisKey: string,
  source: GitHubSource,
  body: PrAnalyzeRequest,
  remoteUrl: string,
  repositories: RepositoryMirror,
  allowSharedRevisionArtifacts: boolean,
  signal?: AbortSignal,
): Promise<Omit<CachedPrGraph, "cache"> | null> {
  try {
    const pointer = readJson(join(entry, "metadata.json")) as Partial<PrSnapshotPointer>;
    if (!validPointer(pointer, repositoryKey, revisions, analysisKey)) return null;
    const cached = await readSnapshot(
      join(entry, "snapshots", pointer.snapshotId),
      cacheRoot,
      repositoryKey,
      revisions,
      analysisKey,
      pointer.snapshotId,
      pointer.snapshotDigest,
      source,
      body,
      remoteUrl,
      repositories,
      allowSharedRevisionArtifacts,
      signal,
    );
    if (!cached) return null;
    return cached;
  } catch (error) {
    if (isOperationCancelled(error)) throw error;
    return null;
  }
}

async function readSnapshot(
  snapshot: string,
  cacheRoot: string,
  repositoryKey: string,
  revisions: { headSha: string; baseSha: string },
  analysisKey: string,
  snapshotId: string,
  snapshotDigest: string,
  source: GitHubSource,
  body: PrAnalyzeRequest,
  remoteUrl: string,
  repositories: RepositoryMirror,
  allowSharedRevisionArtifacts: boolean,
  signal?: AbortSignal,
): Promise<Omit<CachedPrGraph, "cache"> | null> {
  let workspace: Awaited<ReturnType<RepositoryMirror["acquirePreparedPullRequest"]>> | undefined;
  try {
    const metadata = readJson(join(snapshot, "metadata.json")) as Partial<PrSnapshotMetadata>;
    if (!validSnapshotMetadata(
      metadata,
      repositoryKey,
      revisions,
      analysisKey,
      snapshotId,
      snapshotDigest,
    )) return null;
    if (
      !allowSharedRevisionArtifacts
      && (metadata.headStorage.kind === "shared"
        || metadata.comparisonStorage.kind === "shared")
    ) {
      return null;
    }
    requireExactArtifactCoordinates(
      metadata.artifactFacts,
      metadata.comparisonFacts,
      revisions,
      metadata.mergeBaseSha,
      body.headRef,
      remoteUrl,
      `${source.owner}/${source.repo}`,
    );
    // Hash each immutable file as a stream. A cache hit never parses either graph in this process.
    const artifactMaterial = metadata.headStorage.kind === "shared"
      ? (await readPrRevisionArtifact({
          cacheRoot,
          identity: populatedPrHeadRevisionIdentity({
            repositoryKey,
            repositoryUrl: remoteUrl,
            commit: revisions.headSha,
            branch: body.headRef,
            changedSince: metadata.mergeBaseSha,
            targetName: `${source.owner}/${source.repo}`,
            subdir: source.subdir,
          }),
          reference: metadata.headStorage.reference,
          expected: {
            artifactDigest: metadata.artifactDigest,
            artifactBytes: metadata.artifactBytes,
            artifactFacts: metadata.artifactFacts,
          },
          signal,
        }))?.material ?? null
      : await verifyRepositoryArtifactFile(
          join(snapshot, "artifact.json"),
          metadata.artifactBytes,
          metadata.artifactDigest,
          metadata.artifactFacts.summary,
          signal,
        );
    if (artifactMaterial === null) return null;
    throwIfAborted(signal);
    const comparisonMaterial = metadata.comparisonStorage.kind === "shared"
      ? (await readPrRevisionArtifact({
          cacheRoot,
          identity: canonicalPrRevisionIdentity({
            repositoryKey,
            repositoryUrl: remoteUrl,
            commit: metadata.mergeBaseSha,
            targetName: `${source.owner}/${source.repo}`,
            subdir: source.subdir,
          }),
          reference: metadata.comparisonStorage.reference,
          expected: {
            artifactDigest: metadata.comparisonArtifactDigest,
            artifactBytes: metadata.comparisonArtifactBytes,
            artifactFacts: metadata.comparisonFacts,
          },
          signal,
        }))?.material ?? null
      : await verifyRepositoryArtifactFile(
          join(snapshot, "comparison-artifact.json"),
          metadata.comparisonArtifactBytes,
          metadata.comparisonArtifactDigest,
          metadata.comparisonFacts.summary,
          signal,
        );
    if (comparisonMaterial === null) return null;
    throwIfAborted(signal);
    workspace = await repositories.acquirePreparedPullRequest({
      repositoryKey,
      remoteUrl,
      workspaceId: metadata.workspaceId,
      baseSha: revisions.baseSha,
      headSha: revisions.headSha,
      mergeBaseSha: metadata.mergeBaseSha,
      signal,
    });
    if (workspace === null) return null;
    const comparisonSourceDir = resolveExtractionSubdir(workspace.comparison.repoDir, source.subdir);
    return {
      artifactFacts: metadata.artifactFacts,
      artifactMaterial,
      comparisonFacts: metadata.comparisonFacts,
      comparisonMaterial,
      comparisonSourceDir,
      comparisonSourceLease: workspace.comparison,
      ...revisions,
      mergeBaseSha: metadata.mergeBaseSha,
      sourceDir: resolveExtractionSubdir(workspace.head.repoDir, source.subdir),
      sourceLease: workspace.head,
      warnings: metadata.warnings,
    };
  } catch (error) {
    workspace?.release();
    if (isOperationCancelled(error)) throw error;
    return null;
  }
}

function publishedGeneratedSnapshot(
  snapshot: string,
  head: CompletedRevisionArtifact,
  comparison: CompletedRevisionArtifact,
  revisions: { headSha: string; baseSha: string },
  mergeBaseSha: string,
  warnings: string[],
  source: GitHubSource,
  workspace: Awaited<ReturnType<RepositoryMirror["preparePullRequest"]>>,
): Omit<CachedPrGraph, "cache"> {
  const artifactPath = join(snapshot, "artifact.json");
  const comparisonArtifactPath = join(snapshot, "comparison-artifact.json");
  return {
    artifactFacts: head.facts,
    artifactMaterial: head.storage.kind === "shared"
      ? head.material
      : verifiedArtifactFile(
          artifactPath,
          head.material.byteDigest,
          head.facts.summary,
        ),
    comparisonFacts: comparison.facts,
    comparisonMaterial: comparison.storage.kind === "shared"
      ? comparison.material
      : verifiedArtifactFile(
          comparisonArtifactPath,
          comparison.material.byteDigest,
          comparison.facts.summary,
        ),
    comparisonSourceDir: resolveExtractionSubdir(workspace.comparison.repoDir, source.subdir),
    comparisonSourceLease: workspace.comparison,
    ...revisions,
    mergeBaseSha,
    sourceDir: resolveExtractionSubdir(workspace.head.repoDir, source.subdir),
    sourceLease: workspace.head,
    warnings,
  };
}

function requireExactArtifactCoordinates(
  artifact: RepositoryAnalysisFacts,
  comparisonArtifact: RepositoryAnalysisFacts,
  revisions: { headSha: string; baseSha: string },
  mergeBaseSha: string,
  headRef: string,
  remoteUrl: string,
  targetName: string,
): void {
  if (
    !exactHeadArtifactCoordinates(artifact, revisions, mergeBaseSha, headRef, remoteUrl, targetName)
    || comparisonArtifact.target.name !== targetName
    || comparisonArtifact.target.root !== "."
    || !exactVcsCoordinates(comparisonArtifact.target.vcs, {
      repository: remoteUrl,
      commit: mergeBaseSha,
    })
    || comparisonArtifact.changedSinceBaseRef !== null
    || comparisonArtifact.changedFiles.length !== 0
  ) {
    throw new WebError(422, "PR analysis did not match its exact HEAD and merge-base coordinates");
  }
}

function exactHeadArtifactCoordinates(
  artifact: RepositoryAnalysisFacts,
  revisions: { headSha: string; baseSha: string },
  mergeBaseSha: string,
  headRef: string,
  remoteUrl: string,
  targetName: string,
): boolean {
  return artifact.target.name === targetName
    && artifact.target.root === "."
    && exactVcsCoordinates(artifact.target.vcs, {
      repository: remoteUrl,
      commit: revisions.headSha,
      branch: headRef,
    })
    && artifact.changedSinceBaseRef === mergeBaseSha;
}

function exactVcsCoordinates(
  actual: RepositoryAnalysisFacts["target"]["vcs"],
  expected: { repository: string; commit: string; branch?: string },
): boolean {
  if (actual === undefined) return false;
  const actualKeys = Object.keys(actual).sort();
  const expectedKeys = Object.keys(expected).sort();
  return sameStringArray(actualKeys, expectedKeys)
    && actual.repository === expected.repository
    && actual.commit === expected.commit
    && actual.branch === expected.branch;
}

function analysisFacts(result: RepositoryAnalysisChildResult): RepositoryAnalysisFacts {
  return {
    summary: result.summary,
    target: result.target,
    changedFiles: result.changedFiles,
    emptySideHints: result.emptySideHints,
    sourceFiles: result.sourceFiles,
    changedSinceBaseRef: result.changedSinceBaseRef,
    warnings: result.warnings,
  };
}

function validPointer(
  value: Partial<PrSnapshotPointer>,
  repositoryKey: string,
  revisions: { headSha: string; baseSha: string },
  analysisKey: string,
): value is PrSnapshotPointer {
  return value.formatVersion === FORMAT_VERSION && value.repositoryKey === repositoryKey
    && value.headSha === revisions.headSha && value.baseSha === revisions.baseSha
    && value.analysisKey === analysisKey
    && typeof value.snapshotDigest === "string" && SHA256.test(value.snapshotDigest)
    && typeof value.snapshotId === "string" && SNAPSHOT_ID.test(value.snapshotId);
}

function validSnapshotMetadata(
  value: Partial<PrSnapshotMetadata>,
  repositoryKey: string,
  revisions: { headSha: string; baseSha: string },
  analysisKey: string,
  snapshotId: string,
  snapshotDigest: string,
): value is PrSnapshotMetadata {
  if (
    value.formatVersion !== FORMAT_VERSION || value.repositoryKey !== repositoryKey
    || value.analysisVersion !== REPOSITORY_ANALYSIS_VERSION
    || value.headSha !== revisions.headSha || value.baseSha !== revisions.baseSha
    || typeof value.mergeBaseSha !== "string" || !COMMIT.test(value.mergeBaseSha)
    || value.analysisKey !== analysisKey || !Array.isArray(value.warnings)
    || typeof value.artifactDigest !== "string" || !SHA256.test(value.artifactDigest)
    || !Number.isSafeInteger(value.artifactBytes) || (value.artifactBytes ?? 0) <= 0
    || !isRepositoryAnalysisFacts(value.artifactFacts)
    || !validRevisionStorage(value.headStorage)
    || typeof value.comparisonArtifactDigest !== "string" || !SHA256.test(value.comparisonArtifactDigest)
    || !Number.isSafeInteger(value.comparisonArtifactBytes) || (value.comparisonArtifactBytes ?? 0) <= 0
    || !isRepositoryAnalysisFacts(value.comparisonFacts)
    || !validRevisionStorage(value.comparisonStorage)
    || value.snapshotId !== snapshotId || value.snapshotDigest !== snapshotDigest
    || !SNAPSHOT_ID.test(value.snapshotId) || !SHA256.test(value.snapshotDigest)
    || typeof value.workspaceId !== "string" || !WORKSPACE_ID.test(value.workspaceId)
    || !value.warnings.every((warning) => typeof warning === "string")
    || !sameStringArray(
      value.warnings,
      uniqueWarnings(value.artifactFacts?.warnings ?? [], value.comparisonFacts?.warnings ?? []),
    )
  ) {
    return false;
  }
  return prSnapshotDigest(value as PrSnapshotMetadata) === snapshotDigest;
}

function prSnapshotDigest(value: Omit<PrSnapshotMetadata, "snapshotDigest" | "snapshotId">): string {
  return createHash("sha256").update(JSON.stringify({
    formatVersion: value.formatVersion,
    analysisVersion: value.analysisVersion,
    repositoryKey: value.repositoryKey,
    headSha: value.headSha,
    baseSha: value.baseSha,
    mergeBaseSha: value.mergeBaseSha,
    analysisKey: value.analysisKey,
    artifactDigest: value.artifactDigest,
    artifactBytes: value.artifactBytes,
    artifactFacts: value.artifactFacts,
    headStorage: value.headStorage,
    comparisonArtifactDigest: value.comparisonArtifactDigest,
    comparisonArtifactBytes: value.comparisonArtifactBytes,
    comparisonFacts: value.comparisonFacts,
    comparisonStorage: value.comparisonStorage,
    workspaceId: value.workspaceId,
    warnings: value.warnings,
  })).digest("hex");
}

function validRevisionStorage(value: unknown): value is PrRevisionStorage {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const storage = value as Record<string, unknown>;
  if (storage.kind === "snapshot") {
    return sameStringArray(Object.keys(storage).sort(), ["kind"]);
  }
  if (storage.kind !== "shared"
    || !sameStringArray(Object.keys(storage).sort(), ["kind", "reference"])) {
    return false;
  }
  const reference = storage.reference;
  if (reference === null || typeof reference !== "object" || Array.isArray(reference)) return false;
  const candidate = reference as Record<string, unknown>;
  return sameStringArray(
    Object.keys(candidate).sort(),
    ["artifactDigest", "inputDigest", "metadataDigest", "snapshotId"],
  )
    && typeof candidate.inputDigest === "string" && SHA256.test(candidate.inputDigest)
    && typeof candidate.artifactDigest === "string" && SHA256.test(candidate.artifactDigest)
    && typeof candidate.metadataDigest === "string" && SHA256.test(candidate.metadataDigest)
    && typeof candidate.snapshotId === "string" && SNAPSHOT_ID.test(candidate.snapshotId);
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/** Atomic pointer replacement with a per-writer temporary, safe for overlapping refreshes. */
function writeCurrentPointer(entry: string, pointer: PrSnapshotPointer): void {
  mkdirSync(entry, { recursive: true, mode: 0o700 });
  const destination = join(entry, "metadata.json");
  const temporary = join(entry, `.metadata-${process.pid}-${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, `${JSON.stringify(pointer, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, destination);
  } catch (error) {
    removeEntry(temporary);
    throw error;
  }
}

async function remoteRevisions(
  url: string,
  body: PrAnalyzeRequest,
  cwd: string,
  token?: string,
  signal?: AbortSignal,
): Promise<ResolvedPrRevisions> {
  const baseRef = `refs/heads/${body.baseRef}`;
  const headRef = `refs/pull/${body.prNumber}/head`;
  const output = await runGit(["ls-remote", "--exit-code", url, baseRef, headRef], {
    cwd,
    token,
    timeoutMs: GIT_TIMEOUT_MS,
    signal,
  });
  const rows = new Map(output.trim().split("\n").map((line) => {
    const [sha, ref] = line.trim().split(/\s+/, 2);
    return [ref, sha] as const;
  }));
  const baseSha = rows.get(baseRef);
  const headSha = rows.get(headRef);
  if (!baseSha || !headSha) throw new WebError(422, "pull request revisions were not found");
  const normalizedBase = requireCommit(baseSha);
  const normalizedHead = requireCommit(headSha);
  if (
    body.expectedHeadSha !== undefined
    && normalizedHead.toLowerCase() !== body.expectedHeadSha.toLowerCase()
  ) {
    throw new WebError(409, "the pull request head changed after it was selected; refresh and try again");
  }
  return {
    base: { remoteRef: baseRef, expectedSha: normalizedBase },
    baseSha: normalizedBase,
    head: { remoteRef: headRef, expectedSha: normalizedHead },
    headSha: normalizedHead,
  };
}

function revisionCoordinates(revisions: ResolvedPrRevisions): { headSha: string; baseSha: string } {
  return { headSha: revisions.headSha, baseSha: revisions.baseSha };
}

async function extractPrHead(
  repositoryAnalysis: typeof runRepositoryAnalysisChild,
  root: string,
  source: GitHubSource,
  body: PrAnalyzeRequest,
  remoteUrl: string,
  revisions: { headSha: string; baseSha: string },
  mergeBaseSha: string,
  artifactOutputPath: string,
  token?: string,
  analysis?: EmptySideAnalysis,
  signal?: AbortSignal,
  progress?: PrExtractionProgress,
): Promise<RepositoryAnalysisChildResult> {
  throwIfAborted(signal);
  return repositoryAnalysis(
    {
      absoluteRoot: root,
      cwd: root,
      targetName: `${source.owner}/${source.repo}`,
      // Pin the exact base used by comparison source. `--merge-base <sha>` remains deterministic
      // because this SHA is already an ancestor of HEAD, even for histories with several best bases.
      changedSince: mergeBaseSha,
      changedSinceTimeoutMs: GIT_TIMEOUT_MS,
      vcs: { repository: remoteUrl, commit: revisions.headSha, branch: body.headRef },
      ...analysis,
    },
    {
      artifactOutputPath,
      token,
      signal,
      reviewFingerprints: { mode: "changed" },
      ...revisionProgressOptions("head", revisions.headSha, progress),
    },
  );
}

async function extractPrComparison(
  repositoryAnalysis: typeof runRepositoryAnalysisChild,
  root: string,
  source: GitHubSource,
  remoteUrl: string,
  mergeBaseSha: string,
  artifactOutputPath: string,
  token?: string,
  signal?: AbortSignal,
  analysis?: EmptySideAnalysis,
  reviewFiles: string[] | null = null,
  progress?: PrExtractionProgress,
): Promise<RepositoryAnalysisChildResult> {
  throwIfAborted(signal);
  return repositoryAnalysis(
    {
      absoluteRoot: root,
      cwd: root,
      targetName: `${source.owner}/${source.repo}`,
      vcs: { repository: remoteUrl, commit: mergeBaseSha },
      ...analysis,
    },
    {
      artifactOutputPath,
      token,
      signal,
      reviewFingerprints: reviewFiles === null ? { mode: "all" } : { mode: "files", files: reviewFiles },
      ...revisionProgressOptions("merge-base", mergeBaseSha, progress),
    },
  );
}

async function extractPopulatedHeadArtifact(inputs: {
  cacheRoot: string;
  identity: ReturnType<typeof populatedPrHeadRevisionIdentity>;
  publishSharedRevision: boolean;
  artifactOutputPath: string;
  repositoryAnalysis: typeof runRepositoryAnalysisChild;
  root: string;
  source: GitHubSource;
  body: PrAnalyzeRequest;
  remoteUrl: string;
  revisions: { headSha: string; baseSha: string };
  mergeBaseSha: string;
  token?: string;
  signal?: AbortSignal;
  onStage(stage: PrStage): void | Promise<void>;
  execution: { current: number; total: number };
  onExtractionProgress?: (progress: RepositoryAnalysisProgress) => void;
}): Promise<CompletedRevisionArtifact> {
  await inputs.onStage("extract-head");
  if (!inputs.publishSharedRevision) {
    return localRevisionArtifact(await extractPrHead(
      inputs.repositoryAnalysis,
      inputs.root,
      inputs.source,
      inputs.body,
      inputs.remoteUrl,
      inputs.revisions,
      inputs.mergeBaseSha,
      inputs.artifactOutputPath,
      inputs.token,
      undefined,
      inputs.signal,
      {
        execution: inputs.execution,
        onProgress: inputs.onExtractionProgress,
      },
    ));
  }
  const stage = createPrRevisionArtifactStage(inputs.cacheRoot);
  try {
    const result = await extractPrHead(
      inputs.repositoryAnalysis,
      inputs.root,
      inputs.source,
      inputs.body,
      inputs.remoteUrl,
      inputs.revisions,
      inputs.mergeBaseSha,
      stage.artifactOutputPath,
      inputs.token,
      undefined,
      inputs.signal,
      {
        execution: inputs.execution,
        onProgress: inputs.onExtractionProgress,
      },
    );
    const published = await publishPrRevisionArtifact({
      cacheRoot: inputs.cacheRoot,
      identity: inputs.identity,
      stage,
      result,
      signal: inputs.signal,
    });
    return sharedRevisionArtifact(published);
  } catch (error) {
    removeEntry(stage.directory);
    throw error;
  }
}

async function extractCanonicalComparisonArtifact(inputs: {
  cacheRoot: string;
  identity: ReturnType<typeof canonicalPrRevisionIdentity>;
  publishSharedRevision: boolean;
  artifactOutputPath: string;
  repositoryAnalysis: typeof runRepositoryAnalysisChild;
  root: string;
  source: GitHubSource;
  remoteUrl: string;
  mergeBaseSha: string;
  token?: string;
  signal?: AbortSignal;
  onStage(stage: PrStage): void | Promise<void>;
  execution: { current: number; total: number };
  onExtractionProgress?: (progress: RepositoryAnalysisProgress) => void;
}): Promise<CompletedRevisionArtifact> {
  await inputs.onStage("extract-merge-base");
  if (!inputs.publishSharedRevision) {
    return localRevisionArtifact(await extractPrComparison(
      inputs.repositoryAnalysis,
      inputs.root,
      inputs.source,
      inputs.remoteUrl,
      inputs.mergeBaseSha,
      inputs.artifactOutputPath,
      inputs.token,
      inputs.signal,
      undefined,
      null,
      {
        execution: inputs.execution,
        onProgress: inputs.onExtractionProgress,
      },
    ));
  }
  const stage = createPrRevisionArtifactStage(inputs.cacheRoot);
  try {
    const result = await extractPrComparison(
      inputs.repositoryAnalysis,
      inputs.root,
      inputs.source,
      inputs.remoteUrl,
      inputs.mergeBaseSha,
      stage.artifactOutputPath,
      inputs.token,
      inputs.signal,
      undefined,
      null,
      {
        execution: inputs.execution,
        onProgress: inputs.onExtractionProgress,
      },
    );
    const published = await publishPrRevisionArtifact({
      cacheRoot: inputs.cacheRoot,
      identity: inputs.identity,
      stage,
      result,
      signal: inputs.signal,
    });
    return sharedRevisionArtifact(published);
  } catch (error) {
    removeEntry(stage.directory);
    throw error;
  }
}

function revisionProgressOptions(
  kind: RepositoryAnalysisProgress["revision"]["kind"],
  commit: string,
  progress: PrExtractionProgress | undefined,
): Pick<RepositoryAnalysisChildOptions, "progress"> | Record<string, never> {
  if (progress?.onProgress === undefined) return {};
  return {
    progress: {
      context: {
        version: 1,
        revision: {
          kind,
          commit,
          execution: { ...progress.execution },
        },
      },
      onProgress: progress.onProgress,
    },
  };
}

function sharedRevisionArtifact(
  artifact: CachedPrRevisionArtifact,
): CompletedRevisionArtifact {
  return {
    facts: artifact.facts,
    material: artifact.material,
    byteLength: artifact.byteLength,
    storage: { kind: "shared", reference: artifact.reference },
  };
}

function localRevisionArtifact(
  result: RepositoryAnalysisChildResult,
): CompletedRevisionArtifact {
  return {
    facts: analysisFacts(result),
    material: result.material,
    byteLength: result.byteLength,
    storage: { kind: "snapshot" },
  };
}

function comparisonFingerprintFiles(files: readonly ChangedFileManifestEntry[]): string[] {
  return [...new Set(files
    .filter((file) => file.status !== "added")
    .map((file) => file.previousPath ?? file.path))].sort();
}

type EmptySideAnalysis = Pick<RepositoryAnalysisRequest, "hintedFiles" | "allowEmpty"> & { allowEmpty: true };

type ExtractionRoots =
  | { head: string; headMaterialized: false; comparison: null }
  | { head: string; headMaterialized: true; comparison: string };

/**
 * Resolve the configured extraction root across both immutable revisions. A subdirectory missing
 * on exactly one side is a legitimate whole-subtree addition/deletion: materialize an empty,
 * untracked directory on that side so the regular extractor and merge-base diff pipeline can stay
 * unchanged. Missing on both sides remains the same user error as before.
 *
 * Both sides are resolved before revision-cache probes or memory-heavy analysis admission. This
 * prevents an unsafe comparison path from causing either artifact reuse or needless HEAD extraction.
 */
function extractionRoots(headRepo: string, comparisonRepo: string, subdir?: string): ExtractionRoots {
  const headCandidate = lexicalExtractionSubdir(headRepo, subdir);
  const comparisonCandidate = lexicalExtractionSubdir(comparisonRepo, subdir);
  const headExists = entryExists(headCandidate);
  const comparisonExists = entryExists(comparisonCandidate);

  if (headExists) {
    return { head: resolveExtractionSubdir(headRepo, subdir), headMaterialized: false, comparison: null };
  }
  if (!comparisonExists) {
    // Retain the public error and, importantly, do not turn an arbitrary typo into a writable path.
    resolveExtractionSubdir(headRepo, subdir);
    throw new WebError(400, "source subfolder was not found in the repository");
  }

  // Validate the side that proves this is a deletion before creating anything in HEAD. A file or
  // escaping symlink is not evidence that the configured extraction directory existed.
  const comparison = resolveExtractionSubdir(comparisonRepo, subdir);
  return {
    head: materializeEmptyExtractionRoot(headRepo, subdir),
    headMaterialized: true,
    comparison,
  };
}

/** Resolve comparison normally, or create its empty pre-image for a whole-subtree addition. */
function resolveOrMaterializeComparisonRoot(
  comparisonRepo: string,
  subdir?: string,
): { root: string; materialized: boolean } {
  const candidate = lexicalExtractionSubdir(comparisonRepo, subdir);
  return entryExists(candidate)
    ? { root: resolveExtractionSubdir(comparisonRepo, subdir), materialized: false }
    : { root: materializeEmptyExtractionRoot(comparisonRepo, subdir), materialized: true };
}

/** One representative source path per selected extractor preserves every populated-side language. */
function emptySideAnalysis(facts: Pick<RepositoryAnalysisFacts, "emptySideHints">): EmptySideAnalysis {
  return {
    allowEmpty: true,
    hintedFiles: facts.emptySideHints,
  };
}

/**
 * Create only the absent suffix of an already-sanitized repository-relative path. Before recursive
 * mkdir can follow any existing parent symlink/junction, resolve the nearest existing ancestor
 * through the same canonical containment gate used on cache hits. The final directory is resolved
 * again after creation, closing both traversal and symlink-escape paths without weakening support
 * for a safe in-repository symlink parent.
 */
function materializeEmptyExtractionRoot(repoDir: string, subdir?: string): string {
  const canonicalRepoDir = sanitizeSubdir(repoDir);
  const candidate = lexicalExtractionSubdir(repoDir, subdir);
  if (entryExists(candidate)) {
    return resolveExtractionSubdir(repoDir, subdir);
  }
  let ancestor = dirname(candidate);
  while (!entryExists(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) {
      throw new WebError(400, "source subfolder was not found in the repository");
    }
    ancestor = parent;
  }
  // `relative` is safe here because lexicalExtractionSubdir already proved candidate is contained.
  // Use the canonical root as both paths may differ only by an OS alias (for example /var and
  // /private/var on macOS); mixing those spellings would manufacture a false lexical escape.
  // resolveExtractionSubdir additionally rejects a file, dangling link, or canonical escape.
  resolveExtractionSubdir(canonicalRepoDir, relative(canonicalRepoDir, ancestor));
  mkdirSync(candidate, { recursive: true, mode: 0o700 });
  return resolveExtractionSubdir(repoDir, subdir);
}

/** Resolve a repository-relative candidate without requiring its final suffix to exist. The clone
 * helper intentionally validates only existing directories; whole-subtree additions/deletions need
 * the lexical path first so the nearest existing ancestor can be checked before materialization. */
function lexicalExtractionSubdir(repoDir: string, subdir?: string): string {
  const root = sanitizeSubdir(repoDir);
  const clean = subdir?.trim();
  const candidate = clean ? resolve(root, clean) : root;
  const rel = relative(root, candidate);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new WebError(400, "source subfolder escapes the repository");
  }
  return candidate;
}

/** lstat (rather than stat) distinguishes an absent suffix from a dangling/malicious link entry. */
function entryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return false;
    }
    throw error;
  }
}

function uniqueWarnings(...groups: string[][]): string[] {
  return [...new Set(groups.flat())];
}

export function prAnalysisKey(
  source: GitHubSource,
  body: PrAnalyzeRequest,
  runtimeFingerprint: AnalysisRuntimeFingerprint = analysisRuntimeFingerprint(),
): string {
  return createHash("sha256").update(JSON.stringify({
    formatVersion: FORMAT_VERSION,
    analysisVersion: REPOSITORY_ANALYSIS_VERSION,
    schemaVersion: SCHEMA_VERSION,
    generatorVersion: generatorVersion(),
    analysisRuntimeFingerprint: runtimeFingerprint,
    subdir: source.subdir ?? "",
    headRef: body.headRef,
    policy: REPOSITORY_ANALYSIS_POLICY,
  })).digest("hex").slice(0, 24);
}

/**
 * Keep the cache path bounded even for Git's 64-character object format. Full revision provenance
 * remains in the pointer and immutable snapshot metadata, where every cache read validates it.
 */
function prCacheSlotKey(
  repositoryKey: string,
  revisions: { headSha: string; baseSha: string },
  analysisKey: string,
): string {
  return createHash("sha256").update(JSON.stringify({
    formatVersion: FORMAT_VERSION,
    repositoryKey,
    headSha: revisions.headSha,
    baseSha: revisions.baseSha,
    analysisKey,
  })).digest("hex").slice(0, 24);
}

function requireCommit(value: string): string {
  if (!COMMIT.test(value)) throw new WebError(422, "git returned an invalid commit id");
  return value.toLowerCase();
}
