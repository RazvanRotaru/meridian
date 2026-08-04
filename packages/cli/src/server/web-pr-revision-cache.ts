/**
 * Immutable cache for exact PR revision artifacts under a strict process-scoped provenance
 * envelope.
 *
 * The accepted profiles are deliberately narrower than the pair cache in web-pr-cache.ts:
 *
 * - a populated, branch-neutral comparison root with no changed-since annotations and full-revision
 *   review fingerprints; or
 * - a populated HEAD root whose exact merge base, branch, and changed-review fingerprint policy are
 *   part of its identity.
 *
 * Hinted/materialized empty-side analyses have additional semantic inputs and must never enter this
 * cache.
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  REVIEW_FINGERPRINT_VERSION,
  SCHEMA_VERSION,
} from "@meridian/core";
import {
  REPOSITORY_ANALYSIS_POLICY,
  REPOSITORY_ANALYSIS_VERSION,
} from "../repository-analysis-contract";
import {
  analysisRuntimeFingerprint,
  type AnalysisRuntimeFingerprint,
} from "../analysis-runtime-fingerprint";
import { generatorVersion } from "../version";
import {
  isRepositoryAnalysisFacts,
  verifyRepositoryArtifactFile,
  type RepositoryAnalysisChildResult,
  type RepositoryAnalysisFacts,
} from "./repository-analysis-child";
import { isOperationCancelled, throwIfAborted } from "./web-cancellation";
import {
  createStageDirectory,
  publishImmutable,
  readJson,
  removeEntry,
  writePrivateJson,
} from "./web-cache-storage";
import {
  verifiedArtifactFile,
  type VerifiedFileArtifactMaterial,
} from "./web-graph-store";

const FORMAT_VERSION = 2;
const SHA256 = /^[a-f0-9]{64}$/;
const SNAPSHOT_ID = /^[a-f0-9]{16}$/;

export interface CanonicalPrRevisionIdentity {
  formatVersion: 2;
  role: "comparison";
  analysisVersion: number;
  schemaVersion: string;
  generatorVersion: string;
  analysisRuntimeFingerprint: AnalysisRuntimeFingerprint;
  repositoryKey: string;
  repositoryUrl: string;
  commit: string;
  targetName: string;
  subdir: string;
  policy: typeof REPOSITORY_ANALYSIS_POLICY;
  analysis: {
    changedSince: null;
    allowEmpty: false;
    hintedFiles: [];
    reviewFingerprints: {
      mode: "all";
      version: number;
      algorithm: "sha256-source-bytes";
    };
  };
}

export interface PopulatedPrHeadRevisionIdentity {
  formatVersion: 2;
  role: "head";
  analysisVersion: number;
  schemaVersion: string;
  generatorVersion: string;
  analysisRuntimeFingerprint: AnalysisRuntimeFingerprint;
  repositoryKey: string;
  repositoryUrl: string;
  commit: string;
  branch: string;
  targetName: string;
  subdir: string;
  policy: typeof REPOSITORY_ANALYSIS_POLICY;
  analysis: {
    changedSince: string;
    allowEmpty: false;
    hintedFiles: [];
    reviewFingerprints: {
      mode: "changed";
      version: number;
      algorithm: "sha256-source-bytes";
    };
  };
}

export type PrRevisionArtifactIdentity =
  | CanonicalPrRevisionIdentity
  | PopulatedPrHeadRevisionIdentity;

export interface PrRevisionArtifactReference {
  inputDigest: string;
  artifactDigest: string;
  snapshotId: string;
  metadataDigest: string;
}

export interface CachedPrRevisionArtifact {
  reference: PrRevisionArtifactReference;
  facts: RepositoryAnalysisFacts;
  material: VerifiedFileArtifactMaterial;
  byteLength: number;
}

export interface PrRevisionArtifactStage {
  directory: string;
  artifactOutputPath: string;
}

interface PrRevisionArtifactMetadata extends PrRevisionArtifactReference {
  formatVersion: number;
  input: PrRevisionArtifactIdentity;
  artifactBytes: number;
  artifactFacts: RepositoryAnalysisFacts;
}

interface PrRevisionArtifactPointer extends PrRevisionArtifactReference {
  formatVersion: number;
}

export function canonicalPrRevisionIdentity(inputs: {
  repositoryKey: string;
  repositoryUrl: string;
  commit: string;
  targetName: string;
  subdir?: string;
  runtimeFingerprint?: AnalysisRuntimeFingerprint;
}): CanonicalPrRevisionIdentity {
  return {
    formatVersion: FORMAT_VERSION,
    role: "comparison",
    analysisVersion: REPOSITORY_ANALYSIS_VERSION,
    schemaVersion: SCHEMA_VERSION,
    generatorVersion: generatorVersion(),
    analysisRuntimeFingerprint: inputs.runtimeFingerprint ?? analysisRuntimeFingerprint(),
    repositoryKey: inputs.repositoryKey,
    repositoryUrl: inputs.repositoryUrl,
    commit: inputs.commit,
    targetName: inputs.targetName,
    subdir: inputs.subdir ?? "",
    policy: REPOSITORY_ANALYSIS_POLICY,
    analysis: {
      changedSince: null,
      allowEmpty: false,
      hintedFiles: [],
      reviewFingerprints: {
        mode: "all",
        version: REVIEW_FINGERPRINT_VERSION,
        algorithm: "sha256-source-bytes",
      },
    },
  };
}

export function populatedPrHeadRevisionIdentity(inputs: {
  repositoryKey: string;
  repositoryUrl: string;
  commit: string;
  branch: string;
  changedSince: string;
  targetName: string;
  subdir?: string;
  runtimeFingerprint?: AnalysisRuntimeFingerprint;
}): PopulatedPrHeadRevisionIdentity {
  return {
    formatVersion: FORMAT_VERSION,
    role: "head",
    analysisVersion: REPOSITORY_ANALYSIS_VERSION,
    schemaVersion: SCHEMA_VERSION,
    generatorVersion: generatorVersion(),
    analysisRuntimeFingerprint: inputs.runtimeFingerprint ?? analysisRuntimeFingerprint(),
    repositoryKey: inputs.repositoryKey,
    repositoryUrl: inputs.repositoryUrl,
    commit: inputs.commit,
    branch: inputs.branch,
    targetName: inputs.targetName,
    subdir: inputs.subdir ?? "",
    policy: REPOSITORY_ANALYSIS_POLICY,
    analysis: {
      changedSince: inputs.changedSince,
      allowEmpty: false,
      hintedFiles: [],
      reviewFingerprints: {
        mode: "changed",
        version: REVIEW_FINGERPRINT_VERSION,
        algorithm: "sha256-source-bytes",
      },
    },
  };
}

export function createPrRevisionArtifactStage(cacheRoot: string): PrRevisionArtifactStage {
  const directory = createStageDirectory(join(cacheRoot, "pr-revision-staging"));
  return {
    directory,
    artifactOutputPath: join(directory, "artifact.json"),
  };
}

export async function readPrRevisionArtifact(inputs: {
  cacheRoot: string;
  identity: PrRevisionArtifactIdentity;
  reference?: PrRevisionArtifactReference;
  expected?: {
    artifactDigest: string;
    artifactBytes: number;
    artifactFacts: RepositoryAnalysisFacts;
  };
  signal?: AbortSignal;
}): Promise<CachedPrRevisionArtifact | null> {
  try {
    const inputDigest = digestJson(inputs.identity);
    const reference = inputs.reference ?? readCurrentReference(inputs.cacheRoot, inputDigest);
    if (reference === null || reference.inputDigest !== inputDigest) return null;
    const cached = await readReferencedArtifact(
      inputs.cacheRoot,
      inputs.identity,
      reference,
      inputs.signal,
    );
    if (cached === null) return null;
    if (inputs.expected !== undefined && (
      cached.reference.artifactDigest !== inputs.expected.artifactDigest
      || cached.byteLength !== inputs.expected.artifactBytes
      || !isDeepStrictEqual(cached.facts, inputs.expected.artifactFacts)
    )) {
      return null;
    }
    return cached;
  } catch (error) {
    if (isOperationCancelled(error)) throw error;
    return null;
  }
}

export async function publishPrRevisionArtifact(inputs: {
  cacheRoot: string;
  identity: PrRevisionArtifactIdentity;
  stage: PrRevisionArtifactStage;
  result: RepositoryAnalysisChildResult;
  signal?: AbortSignal;
}): Promise<CachedPrRevisionArtifact> {
  try {
    throwIfAborted(inputs.signal);
    if (resolve(inputs.result.material.path) !== resolve(inputs.stage.artifactOutputPath)) {
      throw new Error("PR revision artifact was written outside its owned stage");
    }
    if (!Number.isSafeInteger(inputs.result.byteLength) || inputs.result.byteLength <= 0) {
      throw new Error("PR revision artifact byte length is invalid");
    }
    const facts = analysisFacts(inputs.result);
    requireRevisionFacts(facts, inputs.identity);
    const inputDigest = digestJson(inputs.identity);
    const artifactDigest = inputs.result.material.byteDigest;
    const snapshotId = randomBytes(8).toString("hex");
    const metadataWithoutDigest = {
      formatVersion: FORMAT_VERSION,
      input: inputs.identity,
      inputDigest,
      artifactDigest,
      artifactBytes: inputs.result.byteLength,
      artifactFacts: facts,
      snapshotId,
    };
    const metadataDigest = digestJson(metadataWithoutDigest);
    const reference: PrRevisionArtifactReference = {
      inputDigest,
      artifactDigest,
      snapshotId,
      metadataDigest,
    };
    writePrivateJson(join(inputs.stage.directory, "metadata.json"), {
      ...metadataWithoutDigest,
      metadataDigest,
    } satisfies PrRevisionArtifactMetadata);
    throwIfAborted(inputs.signal);
    const destination = objectPath(inputs.cacheRoot, reference);
    const wonPublication = publishImmutable(inputs.stage.directory, destination);
    const published = wonPublication
      ? {
          reference,
          facts,
          material: verifiedArtifactFile(
            join(destination, "artifact.json"),
            artifactDigest,
            facts.summary,
          ),
          byteLength: inputs.result.byteLength,
        }
      : await readReferencedArtifact(
          inputs.cacheRoot,
          inputs.identity,
          reference,
          inputs.signal,
        );
    if (published === null) {
      throw new Error("PR revision artifact failed immutable publication verification");
    }
    throwIfAborted(inputs.signal);
    writeCurrentReference(inputs.cacheRoot, published.reference);
    return published;
  } catch (error) {
    removeEntry(inputs.stage.directory);
    throw error;
  }
}

async function readReferencedArtifact(
  cacheRoot: string,
  identity: PrRevisionArtifactIdentity,
  reference: PrRevisionArtifactReference,
  signal?: AbortSignal,
): Promise<CachedPrRevisionArtifact | null> {
  if (!validReference(reference) || reference.inputDigest !== digestJson(identity)) return null;
  const snapshot = objectPath(cacheRoot, reference);
  const metadata = readJson(join(snapshot, "metadata.json")) as Partial<PrRevisionArtifactMetadata>;
  if (!validMetadata(metadata, identity, reference)) return null;
  requireRevisionFacts(metadata.artifactFacts, identity);
  const material = await verifyRepositoryArtifactFile(
    join(snapshot, "artifact.json"),
    metadata.artifactBytes,
    metadata.artifactDigest,
    metadata.artifactFacts.summary,
    signal,
  );
  if (material === null) return null;
  return {
    reference,
    facts: metadata.artifactFacts,
    material,
    byteLength: metadata.artifactBytes,
  };
}

function readCurrentReference(cacheRoot: string, inputDigest: string): PrRevisionArtifactReference | null {
  const pointer = readJson(pointerPath(cacheRoot, inputDigest)) as Partial<PrRevisionArtifactPointer>;
  return validPointer(pointer, inputDigest)
    ? {
        inputDigest: pointer.inputDigest,
        artifactDigest: pointer.artifactDigest,
        snapshotId: pointer.snapshotId,
        metadataDigest: pointer.metadataDigest,
      }
    : null;
}

function validPointer(
  value: Partial<PrRevisionArtifactPointer>,
  inputDigest: string,
): value is PrRevisionArtifactPointer {
  return value.formatVersion === FORMAT_VERSION
    && value.inputDigest === inputDigest
    && validReference(value);
}

function validReference(value: Partial<PrRevisionArtifactReference>): value is PrRevisionArtifactReference {
  return typeof value.inputDigest === "string" && SHA256.test(value.inputDigest)
    && typeof value.artifactDigest === "string" && SHA256.test(value.artifactDigest)
    && typeof value.snapshotId === "string" && SNAPSHOT_ID.test(value.snapshotId)
    && typeof value.metadataDigest === "string" && SHA256.test(value.metadataDigest);
}

function validMetadata(
  value: Partial<PrRevisionArtifactMetadata>,
  identity: PrRevisionArtifactIdentity,
  reference: PrRevisionArtifactReference,
): value is PrRevisionArtifactMetadata {
  if (
    value.formatVersion !== FORMAT_VERSION
    || !isDeepStrictEqual(value.input, identity)
    || value.inputDigest !== reference.inputDigest
    || value.artifactDigest !== reference.artifactDigest
    || value.snapshotId !== reference.snapshotId
    || value.metadataDigest !== reference.metadataDigest
    || !Number.isSafeInteger(value.artifactBytes) || (value.artifactBytes ?? 0) <= 0
    || !isRepositoryAnalysisFacts(value.artifactFacts)
  ) {
    return false;
  }
  return digestJson({
    formatVersion: value.formatVersion,
    input: value.input,
    inputDigest: value.inputDigest,
    artifactDigest: value.artifactDigest,
    artifactBytes: value.artifactBytes,
    artifactFacts: value.artifactFacts,
    snapshotId: value.snapshotId,
  }) === value.metadataDigest;
}

function requireRevisionFacts(
  facts: RepositoryAnalysisFacts,
  identity: PrRevisionArtifactIdentity,
): void {
  const vcs = facts.target.vcs;
  const commonMismatch =
    facts.summary.schemaVersion !== identity.schemaVersion
    || facts.target.name !== identity.targetName
    || facts.target.root !== "."
    || vcs === undefined
    || vcs.repository !== identity.repositoryUrl
    || vcs.commit !== identity.commit;
  const profileMismatch = identity.role === "comparison"
    ? !sameStringArray(Object.keys(vcs ?? {}).sort(), ["commit", "repository"])
      || facts.changedSinceBaseRef !== null
      || facts.changedFiles.length !== 0
    : !sameStringArray(Object.keys(vcs ?? {}).sort(), ["branch", "commit", "repository"])
      || vcs?.branch !== identity.branch
      || facts.changedSinceBaseRef !== identity.analysis.changedSince;
  if (commonMismatch || profileMismatch) {
    throw new Error("PR revision artifact did not match its declared input identity");
  }
}

function analysisFacts(result: RepositoryAnalysisChildResult): RepositoryAnalysisFacts {
  return {
    summary: result.summary,
    target: result.target,
    changedFiles: result.changedFiles,
    initialGraphSeedFiles: result.initialGraphSeedFiles,
    emptySideHints: result.emptySideHints,
    sourceFiles: result.sourceFiles,
    changedSinceBaseRef: result.changedSinceBaseRef,
    warnings: result.warnings,
  };
}

function writeCurrentReference(cacheRoot: string, reference: PrRevisionArtifactReference): void {
  const destination = pointerPath(cacheRoot, reference.inputDigest);
  mkdirSync(join(cacheRoot, "pr-revision-artifacts", "inputs", reference.inputDigest), {
    recursive: true,
    mode: 0o700,
  });
  const temporary = `${destination}.${process.pid}-${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify({
      formatVersion: FORMAT_VERSION,
      ...reference,
    } satisfies PrRevisionArtifactPointer, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    renameSync(temporary, destination);
  } catch (error) {
    removeEntry(temporary);
    throw error;
  }
}

function pointerPath(cacheRoot: string, inputDigest: string): string {
  return join(cacheRoot, "pr-revision-artifacts", "inputs", inputDigest, "metadata.json");
}

function objectPath(cacheRoot: string, reference: PrRevisionArtifactReference): string {
  return join(
    cacheRoot,
    "pr-revision-artifacts",
    "objects",
    reference.artifactDigest,
    reference.snapshotId,
  );
}

function digestJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
