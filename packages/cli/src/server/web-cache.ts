import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { SCHEMA_VERSION } from "@meridian/core";
import type { GraphArtifact } from "@meridian/core";
import {
  analyzeRepository,
  REPOSITORY_ANALYSIS_POLICY,
  REPOSITORY_ANALYSIS_VERSION,
} from "../repository-analysis";
import { validateOrThrow } from "../validation";
import { generatorVersion } from "../version";
import { resolveExtractionSubdir, sourceLabel } from "./clone";
import type { GenerateRequest } from "./web-request";
import { checkoutFor } from "./web-cache-checkout";
import type { CachedCheckout } from "./web-cache-checkout";
import {
  createStageDirectory,
  createPrivateDirectory,
  publishImmutable,
  pruneExpiredCache,
  readJson,
  removeEntry,
  touchMetadata,
  writePrivateJson,
} from "./web-cache-storage";

export const CACHE_FORMAT_VERSION = 2;
export const ANALYSIS_VERSION = REPOSITORY_ANALYSIS_VERSION;
const preparedRoots = new Set<string>();

export interface CachedGraph {
  analysisKey: string;
  artifact: GraphArtifact;
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
  warnings: string[];
}

export async function cachedRemoteGraph(inputs: {
  cacheRoot: string;
  request: GenerateRequest;
  cwd: string;
  token?: string;
  onClone(): void | Promise<void>;
  onExtract(): void | Promise<void>;
}): Promise<CachedGraph> {
  prepareWebCache(inputs.cacheRoot);
  const checkout = await checkoutFor(inputs.cacheRoot, inputs.request, inputs.cwd, inputs.token, inputs.onClone);
  const sourceDir = resolveExtractionSubdir(checkout.repoDir, inputs.request.subdir);
  const analysisKey = webAnalysisKey(inputs.request);
  const artifactEntry = join(inputs.cacheRoot, "artifacts", checkout.repositoryKey, checkout.commit, analysisKey);
  if (inputs.request.refresh) {
    removeEntry(artifactEntry);
  } else {
    const cached = readCachedArtifact(artifactEntry, checkout, analysisKey);
    if (cached) {
      return resultFor(cached.artifact, cached.warnings, "hit", checkout, sourceDir, analysisKey, inputs.request);
    }
    removeEntry(artifactEntry);
  }

  await inputs.onExtract();
  const target = sourceLabel(inputs.request.value, inputs.request.subdir);
  const { artifact, warnings } = await analyzeRepository({
    absoluteRoot: sourceDir,
    cwd: sourceDir,
    targetName: target,
    vcs: { repository: checkout.remoteUrl, commit: checkout.commit, branch: checkout.branch },
  });
  const published = publishArtifact(artifactEntry, artifact, warnings, checkout, analysisKey);
  return resultFor(published.artifact, published.warnings, "miss", checkout, sourceDir, analysisKey, inputs.request);
}

export function prepareWebCache(root: string): void {
  if (preparedRoots.has(root)) {
    return;
  }
  createPrivateDirectory(root);
  pruneExpiredCache(root);
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
): { artifact: GraphArtifact; warnings: string[] } | null {
  try {
    const metadata = readJson(join(entry, "metadata.json")) as Partial<ArtifactMetadata>;
    if (!validArtifactMetadata(metadata, checkout, analysisKey)) {
      return null;
    }
    const { artifact, warnings } = validateOrThrow(readJson(join(entry, "artifact.json")), "cached artifact");
    if (artifact.target.vcs?.commit !== checkout.commit) {
      return null;
    }
    touchMetadata(join(entry, "metadata.json"));
    return { artifact, warnings: metadata.warnings.length > 0 ? metadata.warnings : warnings };
  } catch {
    return null;
  }
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
    && Array.isArray(metadata.warnings)
    && metadata.warnings.every((warning) => typeof warning === "string");
}

function publishArtifact(
  destination: string,
  artifact: GraphArtifact,
  warnings: string[],
  checkout: CachedCheckout,
  analysisKey: string,
): { artifact: GraphArtifact; warnings: string[] } {
  const stage = createStageDirectory(dirname(destination));
  try {
    writePrivateJson(join(stage, "artifact.json"), artifact);
    writePrivateJson(join(stage, "metadata.json"), {
      formatVersion: CACHE_FORMAT_VERSION,
      analysisVersion: ANALYSIS_VERSION,
      repositoryKey: checkout.repositoryKey,
      commit: checkout.commit,
      analysisKey,
      warnings,
    } satisfies ArtifactMetadata);
    return publishImmutable(stage, destination)
      ? { artifact, warnings }
      : (readCachedArtifact(destination, checkout, analysisKey) ?? { artifact, warnings });
  } catch (error) {
    removeEntry(stage);
    throw error;
  }
}

function resultFor(
  artifact: GraphArtifact,
  warnings: string[],
  cache: "hit" | "miss",
  checkout: CachedCheckout,
  sourceDir: string,
  analysisKey: string,
  request: GenerateRequest,
): CachedGraph {
  return {
    artifact: artifactForCheckout(artifact, checkout),
    warnings,
    cache,
    checkout,
    sourceDir,
    analysisKey,
    target: sourceLabel(request.value, request.subdir),
  };
}

/** Branch is request provenance, not graph identity; restamp it when commits are shared by refs. */
function artifactForCheckout(artifact: GraphArtifact, checkout: CachedCheckout): GraphArtifact {
  if (!artifact.target.vcs) return artifact;
  const { branch: _cachedBranch, ...vcs } = artifact.target.vcs;
  const stampedVcs = checkout.branch ? { ...vcs, branch: checkout.branch } : vcs;
  return { ...artifact, target: { ...artifact.target, vcs: stampedVcs } };
}
