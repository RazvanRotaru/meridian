import { createHash, randomBytes } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { SCHEMA_VERSION } from "@meridian/core";
import {
  REPOSITORY_ANALYSIS_POLICY,
  REPOSITORY_ANALYSIS_VERSION,
} from "../repository-analysis";
import { generatorVersion } from "../version";
import { resolveExtractionSubdir, sourceLabel } from "./clone";
import type { GenerateRequest } from "./web-request";
import { checkoutFor } from "./web-cache-checkout";
import type { CachedCheckout } from "./web-cache-checkout";
import type { RepositoryMirrorStore } from "./repository-mirror";
import type {
  ExtractionWorkerResult,
  ExtractionWorkerRunner,
  SerializablePipelineRequest,
} from "./extraction-worker";
import type { InspectionGraphSummary } from "./inspection-snapshot-store";
import {
  GRAPH_PROJECTION_DIRECTORY,
  readGraphProjectionManifest,
} from "./graph-projection-bundle";
import {
  createStageDirectory,
  createPrivateDirectory,
  publishImmutable,
  readJson,
  removeEntry,
  touchMetadata,
  writePrivateJson,
} from "./web-cache-storage";

export const CACHE_FORMAT_VERSION = 3;
export const ANALYSIS_VERSION = REPOSITORY_ANALYSIS_VERSION;
const ARTIFACT_METADATA_FORMAT_VERSION = 3;
const preparedRoots = new Set<string>();
const ARTIFACT_CURRENT_FORMAT_VERSION = 1;
const GENERATION = /^[a-z0-9][a-z0-9-]{0,95}$/;

export interface CachedGraph {
  analysisKey: string;
  artifactPath: string;
  projectionDirectory: string;
  graphSummary: InspectionGraphSummary;
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
  graphSummary: InspectionGraphSummary;
  artifactBytes: number;
  artifactSha256: string;
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
  graphSummary: InspectionGraphSummary;
  warnings: string[];
}

export async function cachedRemoteGraph(inputs: {
  cacheRoot: string;
  request: GenerateRequest;
  cwd: string;
  token?: string;
  tokenIsExplicit?: boolean;
  repositoryMirrors?: RepositoryMirrorStore;
  runExtraction: ExtractionWorkerRunner;
  signal?: AbortSignal;
  /** Set by the bounded base/local lifecycle scheduler before entering this cache operation. */
  extractionAdmitted?: boolean;
  onClone(): void | Promise<void>;
  onExtract(): void | Promise<void>;
}): Promise<CachedGraph> {
  prepareWebCache(inputs.cacheRoot);
  const checkout = await checkoutFor(
    inputs.cacheRoot,
    inputs.request,
    inputs.cwd,
    inputs.token,
    inputs.onClone,
    inputs.tokenIsExplicit === true,
    inputs.repositoryMirrors,
    inputs.signal,
  );
  const sourceDir = resolveExtractionSubdir(checkout.repoDir, inputs.request.subdir);
  const analysisKey = webAnalysisKey(inputs.request);
  const artifactEntry = join(inputs.cacheRoot, "artifacts", checkout.repositoryKey, checkout.commit, analysisKey);
  if (!inputs.request.refresh) {
    const cached = readCachedArtifact(artifactEntry, checkout, analysisKey);
    if (cached) return resultFor(cached, "hit", checkout, sourceDir, analysisKey, inputs.request);
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
    // Branch is request provenance rather than graph identity. It is retained in the snapshot
    // descriptor, while this commit-addressed artifact stays shareable across equivalent refs.
    vcs: { repository: checkout.remoteUrl, commit: checkout.commit },
  };
  const published = await extractAndPublishArtifact(
    artifactEntry,
    extractionRequest,
    checkout,
    analysisKey,
    inputs,
  );
  return resultFor(published, "miss", checkout, sourceDir, analysisKey, inputs.request);
}

export function prepareWebCache(root: string): void {
  if (preparedRoots.has(root)) return;
  createPrivateDirectory(root);
  preparedRoots.add(root);
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
  return snapshotFromMetadata(cached.artifactPath, cached.generationId, cached.metadata);
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
    const manifest = readGraphProjectionManifest(join(active.directory, GRAPH_PROJECTION_DIRECTORY));
    if (statSync(artifactPath).size !== metadata.artifactBytes
      || !manifest
      || !sameGraphSummary(manifest.graphSummary, metadata.graphSummary)) return null;
    touchMetadata(join(active.directory, "metadata.json"));
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
    runExtraction: ExtractionWorkerRunner;
    token?: string;
    signal?: AbortSignal;
    extractionAdmitted?: boolean;
  },
): Promise<CachedArtifactSnapshot> {
  const generationId = newGenerationId();
  const generationDirectory = join(destination, "generations", generationId);
  const stage = createStageDirectory(join(destination, "generations"));
  const artifactPath = join(stage, "artifact.json");
  let generationPublished = false;
  let currentPublished = false;
  try {
    const extracted = await inputs.runExtraction(request, {
      artifactOutputPath: artifactPath,
      token: inputs.token,
      signal: inputs.signal,
      admitted: inputs.extractionAdmitted === true,
    });
    if (extracted.artifactPath !== artifactPath
      || extracted.projectionDirectory !== join(stage, GRAPH_PROJECTION_DIRECTORY)) {
      throw new Error("extraction wrote outside its cache stage");
    }
    writeArtifactMetadata(stage, checkout, analysisKey, extracted);
    if (!publishImmutable(stage, generationDirectory)) throw new Error("artifact cache generation collision");
    generationPublished = true;
    const verified = readCachedArtifactDirectory(generationDirectory, generationId, checkout, analysisKey);
    if (!verified) throw new Error("published artifact cache generation failed verification");
    writePrivateJson(join(destination, "current.json"), {
      formatVersion: ARTIFACT_CURRENT_FORMAT_VERSION,
      generationId,
    } satisfies ArtifactCurrentPointer);
    currentPublished = true;
    return verified;
  } catch (error) {
    if (generationPublished && !currentPublished) removeEntry(generationDirectory);
    removeEntry(stage);
    throw error;
  }
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
    const manifest = readGraphProjectionManifest(join(directory, GRAPH_PROJECTION_DIRECTORY));
    if (!validArtifactMetadata(metadata, checkout, analysisKey)
      || !existsSync(artifactPath)
      || statSync(artifactPath).size !== metadata.artifactBytes
      || !manifest
      || !sameGraphSummary(manifest.graphSummary, metadata.graphSummary)) return null;
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
    warnings: metadata.warnings,
  };
}

function activeArtifactGeneration(entry: string): { directory: string; generationId: string } | null {
  try {
    const current = readJson(join(entry, "current.json")) as Partial<ArtifactCurrentPointer>;
    if (current.formatVersion !== ARTIFACT_CURRENT_FORMAT_VERSION
      || typeof current.generationId !== "string" || !GENERATION.test(current.generationId)) return null;
    touchMetadata(join(entry, "current.json"));
    return { directory: join(entry, "generations", current.generationId), generationId: current.generationId };
  } catch {
    return null;
  }
}

function newGenerationId(): string {
  return `${Date.now().toString(36)}-${randomBytes(12).toString("hex")}`;
}

function resultFor(
  snapshot: CachedArtifactSnapshot,
  cache: "hit" | "miss",
  checkout: CachedCheckout,
  sourceDir: string,
  analysisKey: string,
  request: GenerateRequest,
): CachedGraph {
  return {
    ...snapshot,
    cache,
    checkout,
    sourceDir,
    analysisKey,
    target: sourceLabel(request.value, request.subdir),
  };
}

function validArtifactIntegrity(value: Partial<ArtifactMetadata>): boolean {
  return Number.isSafeInteger(value.artifactBytes) && (value.artifactBytes as number) > 0
    && typeof value.artifactSha256 === "string"
    && /^[0-9a-f]{64}$/.test(value.artifactSha256);
}

function validGraphSummary(value: unknown): value is InspectionGraphSummary {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const summary = value as Partial<InspectionGraphSummary>;
  return typeof summary.schemaVersion === "string"
    && typeof summary.generatedAt === "string"
    && Number.isSafeInteger(summary.nodeCount) && (summary.nodeCount as number) >= 0
    && Number.isSafeInteger(summary.edgeCount) && (summary.edgeCount as number) >= 0;
}

function sameGraphSummary(left: InspectionGraphSummary, right: InspectionGraphSummary): boolean {
  return left.schemaVersion === right.schemaVersion
    && left.generatedAt === right.generatedAt
    && left.nodeCount === right.nodeCount
    && left.edgeCount === right.edgeCount;
}
