import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
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
  artifactSummary,
  materializeValidatedArtifact,
  verifiedArtifactFile,
  type VerifiedFileArtifactMaterial,
  type WebGraphArtifactMaterial,
} from "./web-graph-store";
import {
  createStageDirectory,
  createPrivateDirectory,
  publishImmutable,
  readJson,
  removeEntry,
  writePrivateJson,
} from "./web-cache-storage";

export const CACHE_FORMAT_VERSION = 4;
export const ANALYSIS_VERSION = REPOSITORY_ANALYSIS_VERSION;
const SHA256 = /^[a-f0-9]{64}$/;
const SNAPSHOT_ID = /^[a-f0-9]{16}$/;

export interface CachedGraph {
  analysisKey: string;
  artifact: GraphArtifact;
  /** Exact prepared bytes, either an already-verified cache file or one branch-restamped buffer. */
  material: WebGraphArtifactMaterial;
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
  /** Compact semantic identity used with selected-ref provenance for graph ids. */
  snapshotDigest: string;
  snapshotId: string;
  warnings: string[];
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
  const cached = inputs.request.refresh ? null : readCachedArtifact(artifactEntry, checkout, analysisKey);
  if (cached) {
    return resultFor(cached, "hit", checkout, sourceDir, analysisKey, inputs.request);
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
  return resultFor(published, "miss", checkout, sourceDir, analysisKey, inputs.request);
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
): CachedArtifact | null {
  const resolved = resolveCachedArtifact(entry, checkout, analysisKey);
  if (!resolved) return null;
  try {
    const artifactBytes = readFileSync(resolved.artifactPath);
    if (sha256(artifactBytes) !== resolved.metadata.byteDigest) {
      return null;
    }
    const { artifact, warnings } = validateOrThrow(JSON.parse(artifactBytes.toString("utf8")), "cached artifact");
    if (artifact.target.vcs?.commit !== checkout.commit || artifact.target.vcs.branch !== undefined) {
      return null;
    }
    return {
      artifact,
      material: verifiedArtifactFile(
        resolved.artifactPath,
        resolved.metadata.byteDigest,
        artifactSummary(artifact),
      ),
      snapshotDigest: resolved.metadata.snapshotDigest,
      warnings: resolved.metadata.warnings.length > 0 ? resolved.metadata.warnings : warnings,
    };
  } catch {
    return null;
  }
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
    && typeof metadata.snapshotDigest === "string"
    && SHA256.test(metadata.snapshotDigest)
    && metadata.snapshotDigest === metadata.byteDigest
    && typeof metadata.snapshotId === "string"
    && SNAPSHOT_ID.test(metadata.snapshotId)
    && Array.isArray(metadata.warnings)
    && metadata.warnings.every((warning) => typeof warning === "string");
}

function publishArtifact(
  slot: string,
  artifact: GraphArtifact,
  warnings: string[],
  checkout: CachedCheckout,
  analysisKey: string,
): CachedArtifact {
  const stage = createStageDirectory(dirname(slot));
  try {
    const branchNeutralArtifact = withoutBranchProvenance(artifact);
    if (branchNeutralArtifact.target.vcs?.commit !== checkout.commit) {
      throw new Error("generated artifact commit does not match its immutable checkout");
    }
    const serialized = materializeValidatedArtifact(branchNeutralArtifact);
    const artifactPath = join(stage, "artifact.json");
    writeFileSync(artifactPath, serialized.bytes, { flag: "wx", mode: 0o600 });
    const snapshotDigest = serialized.byteDigest;
    // The semantic digest remains branch-neutral and stable. A compact random generation token is
    // still required because corrupt recovery may recreate identical bytes without being allowed
    // to replace the old path another process is serving.
    const snapshotId = randomBytes(8).toString("hex");
    writePrivateJson(join(stage, "metadata.json"), {
      formatVersion: CACHE_FORMAT_VERSION,
      analysisVersion: ANALYSIS_VERSION,
      repositoryKey: checkout.repositoryKey,
      commit: checkout.commit,
      analysisKey,
      byteDigest: serialized.byteDigest,
      snapshotDigest,
      snapshotId,
      warnings,
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
      artifact: branchNeutralArtifact,
      material: verifiedArtifactFile(
        join(snapshot, "artifact.json"),
        serialized.byteDigest,
        serialized.summary,
      ),
      snapshotDigest,
      warnings,
    };
  } catch (error) {
    removeEntry(stage);
    throw error;
  }
}

function resultFor(
  cached: CachedArtifact,
  cache: "hit" | "miss",
  checkout: CachedCheckout,
  sourceDir: string,
  analysisKey: string,
  request: GenerateRequest,
): CachedGraph {
  const prepared = artifactForCheckout(cached, checkout);
  return {
    artifact: prepared.artifact,
    material: prepared.material,
    snapshotDigest: cached.snapshotDigest,
    warnings: cached.warnings,
    cache,
    checkout,
    sourceDir,
    analysisKey,
    target: sourceLabel(request.value, request.subdir),
  };
}

interface CachedArtifact {
  artifact: GraphArtifact;
  material: VerifiedFileArtifactMaterial;
  snapshotDigest: string;
  warnings: string[];
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Branch is request provenance, not extraction-cache identity; cached bytes are always neutral. */
function artifactForCheckout(
  cached: CachedArtifact,
  checkout: CachedCheckout,
): { artifact: GraphArtifact; material: WebGraphArtifactMaterial } {
  if (!checkout.branch) {
    return { artifact: cached.artifact, material: cached.material };
  }
  const vcs = cached.artifact.target.vcs;
  if (!vcs) throw new Error("cached remote artifact has no VCS coordinates");
  const artifact = {
    ...cached.artifact,
    target: { ...cached.artifact.target, vcs: { ...vcs, branch: checkout.branch } },
  };
  return { artifact, material: materializeValidatedArtifact(artifact) };
}

function withoutBranchProvenance(artifact: GraphArtifact): GraphArtifact {
  const vcs = artifact.target.vcs;
  if (!vcs || vcs.branch === undefined) return artifact;
  const { branch: _branch, ...branchNeutralVcs } = vcs;
  return { ...artifact, target: { ...artifact.target, vcs: branchNeutralVcs } };
}
