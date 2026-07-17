import { createHash, randomBytes } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { SCHEMA_VERSION } from "@meridian/core";
import {
  REPOSITORY_ANALYSIS_POLICY,
  REPOSITORY_ANALYSIS_VERSION,
} from "../repository-analysis";
import { generatorVersion } from "../version";
import { sanitizeSubdir, sourceLabel } from "./repository-source";
import type { GenerateRequest } from "./web-request";
import { checkoutFor } from "./web-cache-checkout";
import type { CachedCheckout, RepositoryMirrorPreparer } from "./web-cache-checkout";
import type {
  ExtractionWorkerResult,
  ExtractionWorkerRunner,
  SerializablePipelineRequest,
} from "./extraction-worker";
import type { GraphGenerationSummary } from "./graph-generation-contract";
import { GRAPH_PROJECTION_DIRECTORY } from "./graph-projection-bundle";
import {
  createPrivateDirectory,
  readJson,
  touchMetadata,
  writePrivateJson,
} from "./web-cache-storage";
import {
  finalizedGenerationDirectory,
  repositoryArtifactEntry,
} from "./graph-cache-layout";
import {
  freezeGraphGenerationDirectory,
  sealGraphGeneration,
  verifyExistingGraphGeneration,
  type VerifiedGraphGeneration,
} from "./graph-generation-verifier";
import type {
  GraphGenerationLease,
  GraphGenerationLifecycle,
} from "./graph-generation-lifecycle";
import { withOwnershipCleanup } from "./ownership-cleanup";

export const CACHE_FORMAT_VERSION = 3;
export const ANALYSIS_VERSION = REPOSITORY_ANALYSIS_VERSION;
const ARTIFACT_METADATA_FORMAT_VERSION = 5;
const ARTIFACT_CURRENT_FORMAT_VERSION = 1;
const GENERATION = /^[a-z0-9][a-z0-9-]{0,95}$/;

export interface CachedGraph {
  analysisKey: string;
  artifactPath: string;
  projectionDirectory: string;
  graphSummary: GraphGenerationSummary;
  verifiedGeneration: VerifiedGraphGeneration;
  generationLease: GraphGenerationLease;
  cache: "hit" | "miss";
  checkout: CachedCheckout;
  sourceDir: string;
  generationId: string;
  target: string;
  warnings: string[];
}

interface ArtifactCurrentPointer {
  formatVersion: number;
  generationId: string;
}

interface ArtifactMetadataIdentity {
  formatVersion: number;
  analysisVersion: number;
  repositoryKey: string;
  commit: string;
  analysisKey: string;
  warnings: string[];
}

export interface ArtifactMetadata extends ArtifactMetadataIdentity {
  formatVersion: typeof ARTIFACT_METADATA_FORMAT_VERSION;
  graphSummary: GraphGenerationSummary;
  artifactBytes: number;
  artifactSha256: string;
  projectionBytes: number;
  projectionSha256: string;
  projectionContentId: string;
}

export interface CachedArtifactProbe {
  artifactPath: string;
  directory: string;
  generationId: string;
  metadata: ArtifactMetadata;
}

interface CachedArtifactSnapshot {
  artifactPath: string;
  projectionDirectory: string;
  generationId: string;
  graphSummary: GraphGenerationSummary;
  artifactBytes: number;
  artifactSha256: string;
  projectionBytes: number;
  projectionSha256: string;
  projectionContentId: string;
  warnings: string[];
}

export async function cachedRemoteGraph(inputs: {
  cacheRoot: string;
  request: GenerateRequest;
  cwd: string;
  token?: string;
  tokenIsExplicit?: boolean;
  repositoryMirrors: RepositoryMirrorPreparer;
  runExtraction: ExtractionWorkerRunner;
  generationLifecycle: GraphGenerationLifecycle;
  signal?: AbortSignal;
  /** Set by the bounded base/local lifecycle scheduler before entering this cache operation. */
  extractionAdmitted?: boolean;
  onPrepareSource(): void | Promise<void>;
  onExtract(): void | Promise<void>;
}): Promise<CachedGraph> {
  prepareWebCache(inputs.cacheRoot);
  const checkout = await checkoutFor(
    inputs.cacheRoot,
    inputs.request,
    inputs.cwd,
    inputs.repositoryMirrors,
    inputs.token,
    inputs.onPrepareSource,
    inputs.tokenIsExplicit === true,
    inputs.signal,
  );
  const operationSignal = inputs.signal
    ? AbortSignal.any([inputs.signal, checkout.sourceOperation.signal])
    : checkout.sourceOperation.signal;
  const operationInputs = { ...inputs, signal: operationSignal };
  let generationLease: GraphGenerationLease | undefined;
  try {
    const sourceDir = sanitizeSubdir(checkout.repoDir, inputs.request.subdir);
    const analysisKey = webAnalysisKey(inputs.request);
    const artifactEntry = repositoryArtifactEntry(
      inputs.cacheRoot,
      checkout.repositoryKey,
      checkout.commit,
      analysisKey,
    );
    if (!inputs.request.refresh) {
      let cached: CachedArtifactSnapshot | null = null;
      await inputs.generationLifecycle.runExclusive(async () => {
        cached = readCachedArtifact(artifactEntry, checkout, analysisKey);
        if (cached) {
          generationLease = await inputs.generationLifecycle.acquire(
            dirname(cached.artifactPath),
            { purpose: "cache-read", signal: operationSignal },
          );
        }
      }, operationSignal);
      if (cached) {
        try {
          const verified = await verifyCachedGraphGeneration(
            inputs.cacheRoot,
            cached,
            checkout.commit,
            operationSignal,
          );
          return resultFor(
            cached,
            verified,
            generationLease as GraphGenerationLease,
            "hit",
            checkout,
            sourceDir,
            analysisKey,
            inputs.request,
          );
        } catch (error) {
          const validationLease = generationLease;
          generationLease = undefined;
          if (operationSignal.aborted) {
            await withOwnershipCleanup(
              () => { throw operationSignal.reason ?? error; },
              [() => validationLease?.release()],
              "cached graph validation",
            );
          } else {
            // Corruption itself is an intentional cache miss; failure to release the stale read
            // lease is not. Surface only the mandatory ownership failure in that path.
            await withOwnershipCleanup(
              () => undefined,
              [() => validationLease?.release()],
              "cached graph validation",
            );
          }
          // Corrupt immutable bytes are a cache miss. A fresh generation gets a new identity and the
          // lifecycle authority later quarantines the now-unreachable corrupt generation.
        }
      }
    }

    await inputs.onExtract();
    const target = sourceLabel(inputs.request.value, inputs.request.subdir);
    const extractionRequest: SerializablePipelineRequest = {
      absoluteRoot: sourceDir,
      cwd: sourceDir,
      depth: REPOSITORY_ANALYSIS_POLICY.depth,
      includeExternal: REPOSITORY_ANALYSIS_POLICY.includeExternal,
      includeUnresolved: REPOSITORY_ANALYSIS_POLICY.includeUnresolved,
      materializeBoundary: REPOSITORY_ANALYSIS_POLICY.materializeBoundary,
      excludeTests: REPOSITORY_ANALYSIS_POLICY.excludeTests,
      valueRefs: REPOSITORY_ANALYSIS_POLICY.valueRefs,
      targetName: target,
      vcs: { repository: checkout.remoteUrl, commit: checkout.commit },
    };
    const published = await extractAndPublishArtifact(
      artifactEntry,
      extractionRequest,
      checkout,
      analysisKey,
      operationInputs,
    );
    return resultFor(
      published,
      published.verifiedGeneration,
      published.generationLease,
      "miss",
      checkout,
      sourceDir,
      analysisKey,
      inputs.request,
    );
  } catch (error) {
    return withOwnershipCleanup(
      () => { throw error; },
      [
        () => generationLease?.release(),
        () => checkout.sourceOperation.release(),
      ],
      "remote graph cache operation",
    );
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

function readCachedArtifact(
  entry: string,
  checkout: CachedCheckout,
  analysisKey: string,
): CachedArtifactSnapshot | null {
  const cached = probeCachedArtifact(entry, checkout, analysisKey);
  if (!cached) return null;
  return snapshotFromMetadata(
    cached.artifactPath,
    cached.generationId,
    cached.metadata,
  );
}

/** Metadata-only probe used by `/api/cache/status`; it never parses the potentially large graph. */
export function probeCachedArtifact(
  entry: string,
  checkout: CachedCheckout,
  analysisKey: string,
): CachedArtifactProbe | null {
  const active = activeArtifactGeneration(entry);
  if (!active) return null;
  try {
    const metadata = readJson(join(active.directory, "metadata.json")) as Partial<ArtifactMetadata>;
    const artifactPath = join(active.directory, "artifact.json");
    if (!validArtifactMetadata(metadata, checkout, analysisKey) || !existsSync(artifactPath)) return null;
    if (statSync(artifactPath).size !== metadata.artifactBytes) return null;
    return { ...active, artifactPath, metadata };
  } catch {
    return null;
  }
}

export function validArtifactMetadata(
  metadata: Partial<ArtifactMetadata>,
  checkout: CachedCheckout,
  analysisKey: string,
): metadata is ArtifactMetadata {
  return validArtifactIdentity(metadata, checkout, analysisKey)
    && metadata.formatVersion === ARTIFACT_METADATA_FORMAT_VERSION
    && validGraphSummary(metadata.graphSummary)
    && validArtifactIntegrity(metadata);
}

function validArtifactIdentity(
  metadata: Partial<ArtifactMetadata>,
  checkout: CachedCheckout,
  analysisKey: string,
): boolean {
  return metadata.formatVersion === ARTIFACT_METADATA_FORMAT_VERSION
    && metadata.analysisVersion === ANALYSIS_VERSION
    && metadata.repositoryKey === checkout.repositoryKey
    && metadata.commit === checkout.commit
    && metadata.analysisKey === analysisKey
    && Array.isArray(metadata.warnings)
    && metadata.warnings.every((warning) => typeof warning === "string");
}

async function extractAndPublishArtifact(
  destination: string,
  request: SerializablePipelineRequest,
  checkout: CachedCheckout,
  analysisKey: string,
  inputs: {
    cacheRoot: string;
    runExtraction: ExtractionWorkerRunner;
    token?: string;
    signal?: AbortSignal;
    extractionAdmitted?: boolean;
    generationLifecycle: GraphGenerationLifecycle;
  },
): Promise<CachedArtifactSnapshot & {
  verifiedGeneration: VerifiedGraphGeneration;
  generationLease: GraphGenerationLease;
}> {
  const generationId = newGenerationId();
  const generationDirectory = finalizedGenerationDirectory(destination, generationId);
  createPrivateDirectory(dirname(generationDirectory));
  const stage = await inputs.generationLifecycle.reserveStage(inputs.signal);
  const artifactPath = join(stage.directory, "artifact.json");
  let generationLease: GraphGenerationLease | undefined;
  let result: (CachedArtifactSnapshot & {
    verifiedGeneration: VerifiedGraphGeneration;
    generationLease: GraphGenerationLease;
  }) | undefined;
  let operationFailed = false;
  let operationError: unknown;
  try {
    const extracted = await inputs.runExtraction(request, {
      artifactOutputPath: artifactPath,
      token: inputs.token,
      signal: inputs.signal,
      admitted: inputs.extractionAdmitted === true,
    });
    if (extracted.artifactPath !== artifactPath
      || extracted.projectionDirectory !== join(stage.directory, GRAPH_PROJECTION_DIRECTORY)) {
      throw new Error("extraction wrote outside its cache stage");
    }
    writeArtifactMetadata(stage.directory, checkout, analysisKey, extracted);
    await sealGraphGeneration({
      cacheRoot: inputs.cacheRoot,
      stage,
      artifactPath: extracted.artifactPath,
      projectionDirectory: extracted.projectionDirectory,
      artifactBytes: extracted.artifactBytes,
      artifactSha256: extracted.artifactSha256,
      projectionBytes: extracted.projectionBytes,
      projectionSha256: extracted.projectionSha256,
      projectionContentId: extracted.projectionContentId,
      graphSummary: extracted.graphSummary,
      revision: { kind: "git", commit: checkout.commit },
    }, inputs.signal);
    generationLease = await inputs.generationLifecycle.acquire(generationDirectory, {
      purpose: "publication",
      allowMissing: true,
      signal: inputs.signal,
    });
    if (!await stage.publish(generationLease, inputs.signal)) {
      throw new Error("artifact cache generation collision");
    }
    freezeGraphGenerationDirectory(inputs.cacheRoot, generationDirectory);
    const verified = readCachedArtifactDirectory(generationDirectory, generationId, checkout, analysisKey);
    if (!verified) throw new Error("published artifact cache generation failed verification");
    const verifiedGeneration = await verifyCachedGraphGeneration(
      inputs.cacheRoot,
      verified,
      checkout.commit,
      inputs.signal,
    );
    await inputs.generationLifecycle.runExclusive(() => {
      writePrivateJson(join(destination, "current.json"), {
        formatVersion: ARTIFACT_CURRENT_FORMAT_VERSION,
        generationId,
      } satisfies ArtifactCurrentPointer);
    }, inputs.signal);
    result = { ...verified, verifiedGeneration, generationLease };
  } catch (error) {
    // A published-but-unaliased generation is intentionally left for lifecycle GC. Removing it
    // directly would bypass publication leases and the collector's quarantine/owner journal.
    operationFailed = true;
    operationError = error;
  }

  const cleanupErrors: unknown[] = [];
  try {
    await stage.release();
  } catch (error) {
    cleanupErrors.push(error);
  }
  if (operationFailed || cleanupErrors.length > 0) {
    if (operationFailed) cleanupErrors.unshift(operationError);
    if (generationLease) {
      try {
        await generationLease.release();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (cleanupErrors.length === 1) throw cleanupErrors[0];
    throw new AggregateError(cleanupErrors, "artifact generation and lifecycle cleanup failed");
  }
  return result!;
}

function writeArtifactMetadata(
  directory: string,
  checkout: CachedCheckout,
  analysisKey: string,
  extracted: ExtractionWorkerResult,
): void {
  writePrivateJson(join(directory, "metadata.json"), {
    formatVersion: ARTIFACT_METADATA_FORMAT_VERSION,
    analysisVersion: ANALYSIS_VERSION,
    repositoryKey: checkout.repositoryKey,
    commit: checkout.commit,
    analysisKey,
    graphSummary: extracted.graphSummary,
    artifactBytes: extracted.artifactBytes,
    artifactSha256: extracted.artifactSha256,
    projectionBytes: extracted.projectionBytes,
    projectionSha256: extracted.projectionSha256,
    projectionContentId: extracted.projectionContentId,
    warnings: extracted.warnings,
  } satisfies ArtifactMetadata);
}

function readCachedArtifactDirectory(
  directory: string,
  generationId: string,
  checkout: CachedCheckout,
  analysisKey: string,
): CachedArtifactSnapshot | null {
  try {
    const metadata = readJson(join(directory, "metadata.json")) as Partial<ArtifactMetadata>;
    const artifactPath = join(directory, "artifact.json");
    if (!validArtifactMetadata(metadata, checkout, analysisKey)
      || !existsSync(artifactPath)
      || statSync(artifactPath).size !== metadata.artifactBytes) return null;
    return snapshotFromMetadata(artifactPath, generationId, metadata);
  } catch {
    return null;
  }
}

function snapshotFromMetadata(
  artifactPath: string,
  generationId: string,
  metadata: ArtifactMetadata,
): CachedArtifactSnapshot {
  return {
    artifactPath,
    projectionDirectory: join(dirname(artifactPath), GRAPH_PROJECTION_DIRECTORY),
    generationId,
    graphSummary: metadata.graphSummary,
    artifactBytes: metadata.artifactBytes,
    artifactSha256: metadata.artifactSha256,
    projectionBytes: metadata.projectionBytes,
    projectionSha256: metadata.projectionSha256,
    projectionContentId: metadata.projectionContentId,
    warnings: metadata.warnings,
  };
}

function activeArtifactGeneration(entry: string): { directory: string; generationId: string } | null {
  try {
    const current = readJson(join(entry, "current.json")) as Partial<ArtifactCurrentPointer>;
    if (current.formatVersion !== ARTIFACT_CURRENT_FORMAT_VERSION
      || typeof current.generationId !== "string" || !GENERATION.test(current.generationId)) return null;
    touchMetadata(join(entry, "current.json"));
    return {
      directory: finalizedGenerationDirectory(entry, current.generationId),
      generationId: current.generationId,
    };
  } catch {
    return null;
  }
}

function newGenerationId(): string {
  return `${Date.now().toString(36)}-${randomBytes(12).toString("hex")}`;
}

function resultFor(
  snapshot: CachedArtifactSnapshot,
  verifiedGeneration: VerifiedGraphGeneration,
  generationLease: GraphGenerationLease,
  cache: "hit" | "miss",
  checkout: CachedCheckout,
  sourceDir: string,
  analysisKey: string,
  request: GenerateRequest,
): CachedGraph {
  return {
    ...snapshot,
    verifiedGeneration,
    generationLease,
    cache,
    checkout,
    sourceDir,
    analysisKey,
    target: sourceLabel(request.value, request.subdir),
  };
}

function verifyCachedGraphGeneration(
  cacheRoot: string,
  snapshot: CachedArtifactSnapshot,
  vcsCommit: string,
  signal: AbortSignal | undefined,
): Promise<VerifiedGraphGeneration> {
  return verifyExistingGraphGeneration({
    cacheRoot,
    artifactPath: snapshot.artifactPath,
    projectionDirectory: snapshot.projectionDirectory,
    artifactBytes: snapshot.artifactBytes,
    artifactSha256: snapshot.artifactSha256,
    projectionBytes: snapshot.projectionBytes,
    projectionSha256: snapshot.projectionSha256,
    projectionContentId: snapshot.projectionContentId,
    graphSummary: snapshot.graphSummary,
    revision: { kind: "git", commit: vcsCommit },
  }, signal);
}

function validArtifactIntegrity(value: Partial<ArtifactMetadata>): boolean {
  return Number.isSafeInteger(value.artifactBytes) && (value.artifactBytes as number) > 0
    && typeof value.artifactSha256 === "string"
    && /^[0-9a-f]{64}$/.test(value.artifactSha256)
    && Number.isSafeInteger(value.projectionBytes) && (value.projectionBytes as number) > 0
    && typeof value.projectionSha256 === "string" && /^[0-9a-f]{64}$/.test(value.projectionSha256)
    && typeof value.projectionContentId === "string" && /^[0-9a-f]{64}$/.test(value.projectionContentId);
}

function validGraphSummary(value: unknown): value is GraphGenerationSummary {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const summary = value as Partial<GraphGenerationSummary>;
  return typeof summary.schemaVersion === "string"
    && typeof summary.generatedAt === "string"
    && Number.isSafeInteger(summary.nodeCount) && (summary.nodeCount as number) >= 0
    && Number.isSafeInteger(summary.edgeCount) && (summary.edgeCount as number) >= 0;
}
