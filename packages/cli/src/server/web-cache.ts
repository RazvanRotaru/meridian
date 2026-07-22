import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { SCHEMA_VERSION } from "@meridian/core";
import {
  REPOSITORY_ANALYSIS_POLICY,
  REPOSITORY_ANALYSIS_VERSION,
} from "../repository-analysis-contract";
import { generatorVersion } from "../version";
import { resolveExtractionSubdir, sourceLabel } from "./clone";
import type { GenerateRequest } from "./web-request";
import type { PhaseAdmission } from "./web-analysis-coordinator";
import { checkoutFor } from "./web-cache-checkout";
import type { CachedCheckout } from "./web-cache-checkout";
import type { RepositoryMirror } from "./web-repository-mirror";
import { throwIfAborted } from "./web-cancellation";
import {
  isRepositoryAnalysisFacts,
  runRepositoryAnalysisChild,
  runRepositoryArtifactRestampChild,
  verifyRepositoryArtifactFile,
  type RepositoryAnalysisChildResult,
  type RepositoryAnalysisFacts,
} from "./repository-analysis-child";
import {
  verifiedArtifactFile,
  type VerifiedFileArtifactMaterial,
} from "./web-graph-store";
import {
  createStageDirectory,
  createPrivateDirectory,
  publishImmutable,
  readJson,
  removeEntry,
  writePrivateJson,
} from "./web-cache-storage";

export const CACHE_FORMAT_VERSION = 5;
export const ANALYSIS_VERSION = REPOSITORY_ANALYSIS_VERSION;
const SHA256 = /^[a-f0-9]{64}$/;
const SNAPSHOT_ID = /^[a-f0-9]{16}$/;

export interface CachedGraph {
  analysisKey: string;
  /** Compact worker facts only; the complete graph remains in `material.path`. */
  facts: RepositoryAnalysisFacts;
  material: VerifiedFileArtifactMaterial;
  /** Branch-neutral semantic extraction identity; never a claim about prepared artifact bytes. */
  snapshotDigest: string;
  cache: "hit" | "miss";
  checkout: CachedCheckout;
  sourceDir: string;
  target: string;
  warnings: string[];
}

export interface ArtifactMetadata {
  formatVersion: number;
  analysisVersion: number;
  repositoryKey: string;
  commit: string;
  analysisKey: string;
  /** SHA-256 of the exact branch-neutral bytes in artifact.json. */
  byteDigest: string;
  byteLength: number;
  /** Compact semantic identity used with selected-ref provenance for graph ids. */
  snapshotDigest: string;
  snapshotId: string;
  facts: RepositoryAnalysisFacts;
}

/** Mutable slot state. It selects one complete immutable generation and contains no graph data. */
export interface ArtifactCachePointer {
  formatVersion: number;
  repositoryKey: string;
  commit: string;
  analysisKey: string;
  snapshotDigest: string;
  snapshotId: string;
}

interface BranchArtifactMetadata {
  formatVersion: number;
  analysisVersion: number;
  repositoryKey: string;
  commit: string;
  analysisKey: string;
  neutralSnapshotDigest: string;
  neutralSnapshotId: string;
  branch: string;
  branchKey: string;
  byteDigest: string;
  byteLength: number;
  snapshotId: string;
  facts: RepositoryAnalysisFacts;
}

interface BranchArtifactCachePointer {
  formatVersion: number;
  repositoryKey: string;
  commit: string;
  analysisKey: string;
  neutralSnapshotDigest: string;
  neutralSnapshotId: string;
  branch: string;
  branchKey: string;
  snapshotId: string;
}

type RepositoryAnalysisRunner = typeof runRepositoryAnalysisChild;
type RepositoryArtifactRestampRunner = typeof runRepositoryArtifactRestampChild;
export async function cachedRemoteGraph(inputs: {
  cacheRoot: string;
  repositories: RepositoryMirror;
  request: GenerateRequest;
  cwd: string;
  token?: string;
  onClone(): void | Promise<void>;
  onExtract(): void | Promise<void>;
  signal?: AbortSignal;
  runPreparation: PhaseAdmission;
  runAnalysis: PhaseAdmission;
  repositoryAnalysis?: RepositoryAnalysisRunner;
  repositoryArtifactRestamp?: RepositoryArtifactRestampRunner;
}): Promise<CachedGraph> {
  prepareWebCache(inputs.cacheRoot);
  throwIfAborted(inputs.signal);
  const checkout = await checkoutFor(
    inputs.repositories,
    inputs.request,
    inputs.cwd,
    inputs.runPreparation,
    inputs.token,
    inputs.onClone,
    inputs.signal,
  );
  try {
    const sourceDir = resolveExtractionSubdir(checkout.repoDir, inputs.request.subdir);
    const analysisKey = webAnalysisKey(inputs.request);
    const artifactEntry = join(inputs.cacheRoot, "artifacts", checkout.repositoryKey, checkout.commit, analysisKey);
    const runAnalysis = inputs.runAnalysis;
    const repositoryArtifactRestamp = inputs.repositoryArtifactRestamp ?? runRepositoryArtifactRestampChild;
    const cached = inputs.request.refresh
      ? null
      : await readCachedArtifact(artifactEntry, checkout, analysisKey, inputs.signal);
    if (cached) {
      return resultFor(
        cached,
        "hit",
        checkout,
        sourceDir,
        analysisKey,
        artifactEntry,
        inputs.request,
        runAnalysis,
        repositoryArtifactRestamp,
        inputs.signal,
      );
    }

    await inputs.onExtract();
    throwIfAborted(inputs.signal);
    const target = sourceLabel(inputs.request.value, inputs.request.subdir);
    const repositoryAnalysis = inputs.repositoryAnalysis ?? runRepositoryAnalysisChild;
    const branch = checkout.branch;
    let ownedPrimaryStage: string | undefined;
    let ownedBranchStage: string | undefined;
    try {
      const analyzed = await runAnalysis(async () => {
        const primaryStage = createStageDirectory(dirname(artifactEntry));
        // Admission can discard a late success after cancellation, so ownership must escape now.
        ownedPrimaryStage = primaryStage;
        const primaryOutputPath = join(primaryStage, "artifact.json");
        const branchStage = branch === undefined
          ? undefined
          : createStageDirectory(join(artifactEntry, "branches"));
        ownedBranchStage = branchStage;
        const branchOutputPath = branchStage === undefined ? undefined : join(branchStage, "artifact.json");
        try {
          const result = await repositoryAnalysis({
            absoluteRoot: sourceDir,
            cwd: sourceDir,
            targetName: target,
            vcs: { repository: checkout.remoteUrl, commit: checkout.commit },
          }, {
            artifactOutputPath: primaryOutputPath,
            ...(branch === undefined || branchOutputPath === undefined ? {} : {
              branchVariant: { artifactOutputPath: branchOutputPath, branch },
            }),
            token: inputs.token,
            signal: inputs.signal,
          });
          return { branchStage, primaryStage, result };
        } catch (error) {
          removeEntry(primaryStage);
          if (branchStage !== undefined) removeEntry(branchStage);
          ownedPrimaryStage = undefined;
          ownedBranchStage = undefined;
          throw error;
        }
      });
      const { branchStage, primaryStage, result } = analyzed;
      throwIfAborted(inputs.signal);
      requireNeutralFacts(result, checkout);
      const published = publishArtifact(artifactEntry, primaryStage, result, checkout, analysisKey);
      if (branch === undefined) {
        return graphResult(published, "miss", checkout, sourceDir, analysisKey, inputs.request, published);
      }
      if (branchStage === undefined || result.branchVariant === null) {
        throw new Error("repository analysis child omitted its requested branch artifact");
      }
      requireBranchTarget(result.branchVariant.target, published.facts, branch);
      const prepared = publishBranchArtifact(
        artifactEntry,
        branchStage,
        result.branchVariant,
        published,
        checkout,
        analysisKey,
        branch,
      );
      return graphResult(prepared, "miss", checkout, sourceDir, analysisKey, inputs.request, published);
    } catch (error) {
      if (ownedPrimaryStage !== undefined) removeEntry(ownedPrimaryStage);
      if (ownedBranchStage !== undefined) removeEntry(ownedBranchStage);
      throw error;
    }
  } catch (error) {
    checkout.sourceLease.release();
    throw error;
  }
}

export function prepareWebCache(root: string): void {
  createPrivateDirectory(root);
}

export function webAnalysisKey(request: GenerateRequest): string {
  const settings = {
    formatVersion: CACHE_FORMAT_VERSION,
    analysisVersion: ANALYSIS_VERSION,
    schemaVersion: SCHEMA_VERSION,
    generatorVersion: generatorVersion(),
    subdir: request.subdir ?? "",
    policy: REPOSITORY_ANALYSIS_POLICY,
  };
  return createHash("sha256").update(JSON.stringify(settings)).digest("hex").slice(0, 24);
}

async function readCachedArtifact(
  entry: string,
  checkout: CachedCheckout,
  analysisKey: string,
  signal?: AbortSignal,
): Promise<CachedArtifact | null> {
  const resolved = resolveCachedArtifact(entry, checkout, analysisKey);
  if (!resolved) return null;
  const material = await verifyRepositoryArtifactFile(
    resolved.artifactPath,
    resolved.metadata.byteLength,
    resolved.metadata.byteDigest,
    resolved.metadata.facts.summary,
    signal,
  );
  if (material === null) return null;
  return {
    facts: resolved.metadata.facts,
    material,
    snapshotDigest: resolved.metadata.snapshotDigest,
    snapshotId: resolved.metadata.snapshotId,
  };
}

/** Resolve one exact immutable generation without loading its potentially large graph bytes. */
export function readCachedArtifactPointer(
  entry: string,
  checkout: CachedCheckout,
  analysisKey: string,
): ArtifactCachePointer | null {
  return resolveCachedArtifact(entry, checkout, analysisKey)?.pointer ?? null;
}

function resolveCachedArtifact(
  entry: string,
  checkout: CachedCheckout,
  analysisKey: string,
): { artifactPath: string; metadata: ArtifactMetadata; pointer: ArtifactCachePointer } | null {
  try {
    const pointer = readJson(join(entry, "metadata.json")) as Partial<ArtifactCachePointer>;
    if (!validArtifactCachePointer(pointer, checkout, analysisKey)) return null;
    const snapshot = join(entry, "snapshots", pointer.snapshotId);
    const metadata = readJson(join(snapshot, "metadata.json")) as Partial<ArtifactMetadata>;
    if (!validArtifactMetadata(metadata, checkout, analysisKey)
      || metadata.snapshotId !== pointer.snapshotId
      || metadata.snapshotDigest !== pointer.snapshotDigest) {
      return null;
    }
    const artifactPath = join(snapshot, "artifact.json");
    if (!existsSync(artifactPath)) return null;
    return { artifactPath, metadata, pointer };
  } catch {
    return null;
  }
}

export function validArtifactCachePointer(
  pointer: Partial<ArtifactCachePointer>,
  checkout: CachedCheckout,
  analysisKey: string,
): pointer is ArtifactCachePointer {
  return pointer.formatVersion === CACHE_FORMAT_VERSION
    && pointer.repositoryKey === checkout.repositoryKey
    && pointer.commit === checkout.commit
    && pointer.analysisKey === analysisKey
    && typeof pointer.snapshotDigest === "string" && SHA256.test(pointer.snapshotDigest)
    && typeof pointer.snapshotId === "string" && SNAPSHOT_ID.test(pointer.snapshotId);
}

export function validArtifactMetadata(
  metadata: Partial<ArtifactMetadata>,
  checkout: CachedCheckout,
  analysisKey: string,
): metadata is ArtifactMetadata {
  return metadata.formatVersion === CACHE_FORMAT_VERSION
    && metadata.analysisVersion === ANALYSIS_VERSION
    && metadata.repositoryKey === checkout.repositoryKey
    && metadata.commit === checkout.commit
    && metadata.analysisKey === analysisKey
    && typeof metadata.byteDigest === "string"
    && SHA256.test(metadata.byteDigest)
    && Number.isSafeInteger(metadata.byteLength) && (metadata.byteLength ?? 0) > 0
    && typeof metadata.snapshotDigest === "string"
    && SHA256.test(metadata.snapshotDigest)
    && metadata.snapshotDigest === metadata.byteDigest
    && typeof metadata.snapshotId === "string"
    && SNAPSHOT_ID.test(metadata.snapshotId)
    && isRepositoryAnalysisFacts(metadata.facts)
    && neutralFactsMatchCheckout(metadata.facts, checkout);
}

function publishArtifact(
  slot: string,
  stage: string,
  result: RepositoryAnalysisChildResult,
  checkout: CachedCheckout,
  analysisKey: string,
): CachedArtifact {
  const snapshotDigest = result.material.byteDigest;
  const snapshotId = randomBytes(8).toString("hex");
  writePrivateJson(join(stage, "metadata.json"), {
    formatVersion: CACHE_FORMAT_VERSION,
    analysisVersion: ANALYSIS_VERSION,
    repositoryKey: checkout.repositoryKey,
    commit: checkout.commit,
    analysisKey,
    byteDigest: result.material.byteDigest,
    byteLength: result.byteLength,
    snapshotDigest,
    snapshotId,
    facts: factsFromResult(result),
  } satisfies ArtifactMetadata);
  const snapshot = join(slot, "snapshots", snapshotId);
  if (!publishImmutable(stage, snapshot)) {
    throw new Error("artifact snapshot generation already exists");
  }
  writePrivateJson(join(slot, "metadata.json"), {
    formatVersion: CACHE_FORMAT_VERSION,
    repositoryKey: checkout.repositoryKey,
    commit: checkout.commit,
    analysisKey,
    snapshotDigest,
    snapshotId,
  } satisfies ArtifactCachePointer);
  return {
    facts: factsFromResult(result),
    material: verifiedMaterialAt(join(snapshot, "artifact.json"), result),
    snapshotDigest,
    snapshotId,
  };
}

async function resultFor(
  cached: CachedArtifact,
  cache: "hit" | "miss",
  checkout: CachedCheckout,
  sourceDir: string,
  analysisKey: string,
  entry: string,
  request: GenerateRequest,
  runAnalysis: PhaseAdmission,
  repositoryArtifactRestamp: RepositoryArtifactRestampRunner,
  signal?: AbortSignal,
): Promise<CachedGraph> {
  const prepared = await artifactForCheckout(
    cached,
    checkout,
    analysisKey,
    entry,
    runAnalysis,
    repositoryArtifactRestamp,
    signal,
  );
  return graphResult(prepared, cache, checkout, sourceDir, analysisKey, request, cached);
}

interface CachedArtifact {
  facts: RepositoryAnalysisFacts;
  material: VerifiedFileArtifactMaterial;
  snapshotDigest: string;
  snapshotId: string;
}

interface PreparedArtifact {
  facts: RepositoryAnalysisFacts;
  material: VerifiedFileArtifactMaterial;
}

/** Branch is request provenance, not extraction-cache identity; cached bytes are always neutral. */
async function artifactForCheckout(
  cached: CachedArtifact,
  checkout: CachedCheckout,
  analysisKey: string,
  entry: string,
  runAnalysis: PhaseAdmission,
  repositoryArtifactRestamp: RepositoryArtifactRestampRunner,
  signal?: AbortSignal,
): Promise<PreparedArtifact> {
  const branch = checkout.branch;
  if (branch === undefined) return cached;
  const existing = await readCachedBranchArtifact(entry, cached, checkout, analysisKey, branch, signal);
  if (existing !== null) return existing;

  let ownedStage: string | undefined;
  try {
    const analyzed = await runAnalysis(async () => {
      const stage = createStageDirectory(join(entry, "branches"));
      // Admission can discard a late success after cancellation, so ownership must escape now.
      ownedStage = stage;
      try {
        const result = await repositoryArtifactRestamp({
          inputArtifactPath: cached.material.path,
          expectedInputDigest: cached.material.byteDigest,
          branch,
        }, {
          artifactOutputPath: join(stage, "artifact.json"),
          signal,
        });
        return { result, stage };
      } catch (error) {
        removeEntry(stage);
        ownedStage = undefined;
        throw error;
      }
    });
    const { result, stage } = analyzed;
    throwIfAborted(signal);
    requireRestampResult(result, cached, branch);
    return publishBranchArtifact(entry, stage, result, cached, checkout, analysisKey, branch);
  } catch (error) {
    if (ownedStage !== undefined) removeEntry(ownedStage);
    throw error;
  }
}

function publishBranchArtifact(
  entry: string,
  stage: string,
  result: Pick<RepositoryAnalysisChildResult, "material" | "byteLength" | "summary" | "target">,
  neutral: CachedArtifact,
  checkout: CachedCheckout,
  analysisKey: string,
  branch: string,
): PreparedArtifact {
  const branchKey = branchCacheKey(branch);
  const snapshotId = randomBytes(8).toString("hex");
  const facts = { ...neutral.facts, summary: result.summary, target: result.target };
  const metadata: BranchArtifactMetadata = {
    formatVersion: CACHE_FORMAT_VERSION,
    analysisVersion: ANALYSIS_VERSION,
    repositoryKey: checkout.repositoryKey,
    commit: checkout.commit,
    analysisKey,
    neutralSnapshotDigest: neutral.snapshotDigest,
    neutralSnapshotId: neutral.snapshotId,
    branch,
    branchKey,
    byteDigest: result.material.byteDigest,
    byteLength: result.byteLength,
    snapshotId,
    facts,
  };
  writePrivateJson(join(stage, "metadata.json"), metadata);
  const branchSlot = join(entry, "branches", branchKey);
  const snapshot = join(branchSlot, "snapshots", snapshotId);
  if (!publishImmutable(stage, snapshot)) {
    throw new Error("branch artifact snapshot generation already exists");
  }
  writePrivateJson(join(branchSlot, "metadata.json"), {
    formatVersion: CACHE_FORMAT_VERSION,
    repositoryKey: checkout.repositoryKey,
    commit: checkout.commit,
    analysisKey,
    neutralSnapshotDigest: neutral.snapshotDigest,
    neutralSnapshotId: neutral.snapshotId,
    branch,
    branchKey,
    snapshotId,
  } satisfies BranchArtifactCachePointer);
  return {
    facts,
    material: verifiedMaterialAt(join(snapshot, "artifact.json"), result),
  };
}

async function readCachedBranchArtifact(
  entry: string,
  neutral: CachedArtifact,
  checkout: CachedCheckout,
  analysisKey: string,
  branch: string,
  signal?: AbortSignal,
): Promise<PreparedArtifact | null> {
  const branchKey = branchCacheKey(branch);
  const branchSlot = join(entry, "branches", branchKey);
  try {
    const pointer = readJson(join(branchSlot, "metadata.json")) as Partial<BranchArtifactCachePointer>;
    if (!validBranchPointer(pointer, neutral, checkout, analysisKey, branch, branchKey)) return null;
    const snapshot = join(branchSlot, "snapshots", pointer.snapshotId);
    const metadata = readJson(join(snapshot, "metadata.json")) as Partial<BranchArtifactMetadata>;
    if (!validBranchMetadata(metadata, neutral, checkout, analysisKey, branch, branchKey)
      || metadata.snapshotId !== pointer.snapshotId) return null;
    const material = await verifyRepositoryArtifactFile(
      join(snapshot, "artifact.json"),
      metadata.byteLength,
      metadata.byteDigest,
      metadata.facts.summary,
      signal,
    );
    return material === null ? null : { facts: metadata.facts, material };
  } catch {
    return null;
  }
}

function validBranchPointer(
  pointer: Partial<BranchArtifactCachePointer>,
  neutral: CachedArtifact,
  checkout: CachedCheckout,
  analysisKey: string,
  branch: string,
  branchKey: string,
): pointer is BranchArtifactCachePointer {
  return pointer.formatVersion === CACHE_FORMAT_VERSION
    && pointer.repositoryKey === checkout.repositoryKey
    && pointer.commit === checkout.commit
    && pointer.analysisKey === analysisKey
    && pointer.neutralSnapshotDigest === neutral.snapshotDigest
    && pointer.neutralSnapshotId === neutral.snapshotId
    && pointer.branch === branch
    && pointer.branchKey === branchKey
    && typeof pointer.snapshotId === "string" && SNAPSHOT_ID.test(pointer.snapshotId);
}

function validBranchMetadata(
  metadata: Partial<BranchArtifactMetadata>,
  neutral: CachedArtifact,
  checkout: CachedCheckout,
  analysisKey: string,
  branch: string,
  branchKey: string,
): metadata is BranchArtifactMetadata {
  return metadata.formatVersion === CACHE_FORMAT_VERSION
    && metadata.analysisVersion === ANALYSIS_VERSION
    && metadata.repositoryKey === checkout.repositoryKey
    && metadata.commit === checkout.commit
    && metadata.analysisKey === analysisKey
    && metadata.neutralSnapshotDigest === neutral.snapshotDigest
    && metadata.neutralSnapshotId === neutral.snapshotId
    && metadata.branch === branch
    && metadata.branchKey === branchKey
    && typeof metadata.byteDigest === "string" && SHA256.test(metadata.byteDigest)
    && Number.isSafeInteger(metadata.byteLength) && (metadata.byteLength ?? 0) > 0
    && typeof metadata.snapshotId === "string" && SNAPSHOT_ID.test(metadata.snapshotId)
    && isRepositoryAnalysisFacts(metadata.facts)
    && branchFactsMatchCheckout(metadata.facts, checkout, branch);
}

function neutralFactsMatchCheckout(facts: RepositoryAnalysisFacts, checkout: CachedCheckout): boolean {
  const vcs = facts.target.vcs;
  return vcs?.repository === checkout.remoteUrl
    && vcs.commit === checkout.commit
    && vcs.branch === undefined
    && facts.changedSinceBaseRef === null
    && facts.changedFiles.length === 0;
}

function branchFactsMatchCheckout(
  facts: RepositoryAnalysisFacts,
  checkout: CachedCheckout,
  branch: string,
): boolean {
  const vcs = facts.target.vcs;
  return vcs?.repository === checkout.remoteUrl
    && vcs.commit === checkout.commit
    && vcs.branch === branch
    && facts.changedSinceBaseRef === null
    && facts.changedFiles.length === 0;
}

function requireNeutralFacts(result: RepositoryAnalysisChildResult, checkout: CachedCheckout): void {
  if (!neutralFactsMatchCheckout(factsFromResult(result), checkout)) {
    throw new Error("repository analysis child returned invalid branch-neutral provenance");
  }
}

function requireBranchTarget(
  target: RepositoryAnalysisFacts["target"],
  neutral: RepositoryAnalysisFacts,
  branch: string,
): void {
  const vcs = neutral.target.vcs;
  if (vcs === undefined || !isDeepStrictEqual(target, {
    ...neutral.target,
    vcs: { ...vcs, branch },
  })) {
    throw new Error("repository analysis child returned invalid branch provenance");
  }
}

function requireRestampResult(
  result: RepositoryAnalysisChildResult,
  neutral: CachedArtifact,
  branch: string,
): void {
  requireBranchTarget(result.target, neutral.facts, branch);
  if (!isDeepStrictEqual(result.summary, neutral.facts.summary)
    || !isDeepStrictEqual(result.changedFiles, neutral.facts.changedFiles)
    || !isDeepStrictEqual(result.sourceFiles, neutral.facts.sourceFiles)
    || result.changedSinceBaseRef !== neutral.facts.changedSinceBaseRef) {
    throw new Error("repository artifact restamp changed extraction facts");
  }
}

function factsFromResult(result: RepositoryAnalysisChildResult): RepositoryAnalysisFacts {
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

function verifiedMaterialAt(
  path: string,
  result: Pick<RepositoryAnalysisChildResult, "material" | "summary">,
): VerifiedFileArtifactMaterial {
  return verifiedArtifactFile(path, result.material.byteDigest, result.summary);
}

function branchCacheKey(branch: string): string {
  return createHash("sha256").update(branch).digest("hex").slice(0, 24);
}

function graphResult(
  prepared: PreparedArtifact,
  cache: "hit" | "miss",
  checkout: CachedCheckout,
  sourceDir: string,
  analysisKey: string,
  request: GenerateRequest,
  neutral: CachedArtifact,
): CachedGraph {
  return {
    facts: prepared.facts,
    material: prepared.material,
    snapshotDigest: neutral.snapshotDigest,
    warnings: prepared.facts.warnings,
    cache,
    checkout,
    sourceDir,
    analysisKey,
    target: sourceLabel(request.value, request.subdir),
  };
}
