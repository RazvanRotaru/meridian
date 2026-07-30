/** Strict, bounded messages for the disposable repository-analysis process. */

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
} from "node:crypto";
import { isAbsolute } from "node:path";
import {
  SCHEMA_VERSION,
  changedFileManifestFromExtensions,
  targetSchema,
  type ChangedFileManifestEntry,
  type ExtractionProgress,
  type ExtractionProgressActivity,
  type ExtractionProgressPhase,
  type GraphArtifact,
  type LanguageExtractor,
  type Target,
} from "@meridian/core";
import type {
  RevisionShardAdmissionCapability,
  RevisionShardAdmissionSigner,
  TypeScriptRevisionShardMode,
  TypeScriptRevisionShardPolicy,
} from "@meridian/extractor-typescript";
import { CliError, EXIT, type ExitCode } from "../errors";
import type { RepositoryAnalysisRequest } from "../repository-analysis-contract";
import type { WebGraphArtifactSummary } from "./web-graph-store";
import { syntheticSourceFiles } from "./synthetic-fingerprint";

export const MAX_REPOSITORY_WORKER_STDERR_BYTES = 8_000;
export const MAX_REPOSITORY_WORKER_CHANGED_FILES = 100_000;
export const MAX_REPOSITORY_WORKER_SOURCE_FILES = 100_000;
export const MAX_REPOSITORY_WORKER_SOURCE_PATH_BYTES_TOTAL = 8 * 1024 * 1024;
export const MAX_REPOSITORY_WORKER_EMPTY_SIDE_HINTS = 64;
export const MAX_REPOSITORY_WORKER_WARNINGS = 64;
export const MAX_REPOSITORY_WORKER_PROGRESS_EVENTS = 512;
export const MAX_REPOSITORY_ANALYSIS_EXECUTIONS = 8;

const MAX_PATH_BYTES = 4_096;
const MAX_PROGRESS_PATH_BYTES = 512;
const MIN_PROGRESS_INTERVAL_MS = 1_000;
const SUPPORTED_PROGRESS_LANGUAGE_COUNT = 2;
const REQUIRED_PROGRESS_EVENTS_PER_LANGUAGE = 6;
const RESERVED_ACTIVITY_PROGRESS_EVENTS = 256;
const RESERVED_INPUT_PROOF_CLEAR_EVENTS = 64;
const RESERVED_REQUIRED_PROGRESS_EVENTS =
  SUPPORTED_PROGRESS_LANGUAGE_COUNT * REQUIRED_PROGRESS_EVENTS_PER_LANGUAGE
  + RESERVED_ACTIVITY_PROGRESS_EVENTS
  + RESERVED_INPUT_PROOF_CLEAR_EVENTS;
const MAX_CHANGED_PATH_BYTES_TOTAL = 1024 * 1024;
const MAX_HINT_PATH_BYTES_TOTAL = 256 * 1024;
const MAX_WARNING_BYTES = 4_000;
const MAX_WARNING_BYTES_TOTAL = 64 * 1024;
const MAX_ERROR_TEXT_BYTES = 4_000;
const MAX_ERROR_DETAILS = 64;
const SHA256 = /^[a-f0-9]{64}$/;
const GIT_TREE_OID = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const ITEM_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Function-valued Git execution remains inside the worker and cannot cross IPC. */
export type SerializableRepositoryAnalysisRequest = Omit<
  RepositoryAnalysisRequest,
  "changedSinceGitExecutor" | "onExtractionProgress" | "typeScriptRevisionShards"
> & {
  changedSinceGitExecutor?: never;
  onExtractionProgress?: never;
  typeScriptRevisionShards?: never;
};

export interface NormalizedRepositoryAnalysisRequest {
  absoluteRoot: string;
  cwd: string;
  targetName: string | null;
  vcs: GraphArtifact["target"]["vcs"] | null;
  changedSince: string | null;
  changedSinceTimeoutMs: number | null;
  hintedFiles: string[];
  allowEmpty: boolean;
}

export interface RepositoryAnalysisWorkerRequestMessage {
  type: "analyze";
  id: string;
  request: NormalizedRepositoryAnalysisRequest;
  artifactOutputPath: string;
  /** Optional cold-cache derivative written from the same in-memory validated artifact. */
  branchVariant: { artifactOutputPath: string; branch: string } | null;
  /** PR-only bounded semantic/source fingerprints. Ordinary repository graphs omit the sidecar. */
  reviewFingerprints: ReviewFingerprintSelection | null;
  /** Optional PR revision coordinates used only to enrich non-semantic extraction observations. */
  progressContext: RepositoryAnalysisProgressContext | null;
  /** Server-owned immutable-shard capability; never accepted from an HTTP analysis body. */
  typeScriptRevisionShards: TypeScriptRevisionShardPolicy | null;
  /** Ephemeral credential: private IPC only, never argv, environment, or disk. */
  token?: string;
}

export interface RepositoryAnalysisProgressContext {
  version: 1;
  revision: {
    kind: "head" | "merge-base";
    /** Exact lowercase SHA-1 or SHA-256 Git object id. */
    commit: string;
    /** Extraction order within the HEAD/merge-base graph pair, not a Git commit-history walk. */
    execution: {
      current: number;
      total: number;
    };
  };
}

export interface RepositoryAnalysisProgressPosition {
  current: number;
  total: number;
  path: string;
  pathTruncated: boolean;
}

export interface RepositoryAnalysisProgress extends RepositoryAnalysisProgressContext {
  language: "typescript" | "python";
  phase: ExtractionProgressPhase;
  activity?: ExtractionProgressActivity;
  unit: RepositoryAnalysisProgressPosition | null;
  sourceFile: RepositoryAnalysisProgressPosition | null;
}

export type ReviewFingerprintSelection =
  | { mode: "changed" }
  | { mode: "files"; files: string[] }
  | { mode: "all" };

export interface RepositoryArtifactRestampWorkerRequestMessage {
  type: "restamp";
  id: string;
  inputArtifactPath: string;
  expectedInputDigest: string;
  artifactOutputPath: string;
  /** `null` removes branch provenance; a string sets it. */
  branch: string | null;
}

export type RepositoryAnalysisWorkerRequest =
  | RepositoryAnalysisWorkerRequestMessage
  | RepositoryArtifactRestampWorkerRequestMessage;

/** The graph itself stays in artifactPath; only bounded publication metadata crosses IPC. */
export interface RepositoryAnalysisWorkerFileResult {
  kind: "file";
  operation: RepositoryAnalysisWorkerRequest["type"];
  id: string;
  artifactPath: string;
  artifactBytes: number;
  artifactSha256: string;
  branchVariant: RepositoryAnalysisWorkerBranchVariantResult | null;
  graphSummary: WebGraphArtifactSummary;
  target: Target;
  changedFiles: ChangedFileManifestEntry[];
  /** One representative path per extractor selected for a potentially empty peer analysis. */
  emptySideHints: string[];
  /** Exact source-file set used by synthetic fingerprinting, never node or edge data. */
  sourceFiles: string[];
  changedSinceBaseRef: string | null;
  warnings: string[];
}

export interface RepositoryAnalysisWorkerBranchVariantResult {
  artifactPath: string;
  artifactBytes: number;
  artifactSha256: string;
  graphSummary: WebGraphArtifactSummary;
  target: Target;
}

/** Persistable compact facts for cache hits; deliberately excludes artifact bytes and paths. */
export interface RepositoryAnalysisFacts {
  summary: WebGraphArtifactSummary;
  target: Target;
  changedFiles: ChangedFileManifestEntry[];
  emptySideHints: string[];
  sourceFiles: string[];
  changedSinceBaseRef: string | null;
  warnings: string[];
}

interface RepositoryAnalysisWorkerCliFailure {
  kind: "cli";
  exitCode: ExitCode;
  message: string;
  details: string[];
}

interface RepositoryAnalysisWorkerInternalFailure {
  kind: "internal";
}

export type RepositoryAnalysisWorkerFailure =
  | RepositoryAnalysisWorkerCliFailure
  | RepositoryAnalysisWorkerInternalFailure;

export type RepositoryAnalysisWorkerResponse =
  | { type: "result"; result: RepositoryAnalysisWorkerFileResult }
  | { type: "error"; error: RepositoryAnalysisWorkerFailure }
  | { type: "progress"; id: string; progress: RepositoryAnalysisProgress };

export function normalizeRepositoryAnalysisRequest(
  request: SerializableRepositoryAnalysisRequest,
): NormalizedRepositoryAnalysisRequest {
  if (request.changedSinceGitExecutor !== undefined) {
    throw new TypeError("repository analysis child request cannot contain a Git executor");
  }
  if (request.onExtractionProgress !== undefined) {
    throw new TypeError("repository analysis child request cannot contain a progress callback");
  }
  if (request.typeScriptRevisionShards !== undefined) {
    throw new TypeError("repository analysis child request cannot contain a TypeScript shard policy");
  }
  const normalized: NormalizedRepositoryAnalysisRequest = {
    absoluteRoot: request.absoluteRoot,
    cwd: request.cwd,
    targetName: request.targetName ?? null,
    vcs: request.vcs ? { ...request.vcs } : null,
    changedSince: request.changedSince ?? null,
    changedSinceTimeoutMs: request.changedSinceTimeoutMs ?? null,
    hintedFiles: [...new Set(request.hintedFiles ?? [])].sort(),
    allowEmpty: request.allowEmpty ?? false,
  };
  if (!isNormalizedAnalysisRequest(normalized)) {
    throw new TypeError("repository analysis child request is invalid");
  }
  return normalized;
}

export function isRepositoryAnalysisWorkerRequest(
  value: unknown,
): value is RepositoryAnalysisWorkerRequest {
  if (!isRecord(value) || !ITEM_ID.test(asString(value.id))
    || !isAbsolute(asString(value.artifactOutputPath))) return false;
  if (value.type === "analyze") {
    const keys = value.token === undefined
      ? [
          "artifactOutputPath",
          "branchVariant",
          "id",
          "progressContext",
          "request",
          "reviewFingerprints",
          "typeScriptRevisionShards",
          "type",
        ]
      : [
          "artifactOutputPath",
          "branchVariant",
          "id",
          "progressContext",
          "request",
          "reviewFingerprints",
          "token",
          "typeScriptRevisionShards",
          "type",
        ];
    return hasExactKeys(value, keys)
      && isNormalizedAnalysisRequest(value.request)
      && isBranchVariantRequest(value.branchVariant, value.artifactOutputPath)
      && isReviewFingerprintSelection(value.reviewFingerprints)
      && (value.progressContext === null || isRepositoryAnalysisProgressContext(value.progressContext))
      && (value.typeScriptRevisionShards === null
        || isTypeScriptRevisionShardPolicy(value.typeScriptRevisionShards))
      && (value.token === undefined || isBoundedNonEmptyString(value.token));
  }
  return value.type === "restamp"
    && hasExactKeys(value, [
      "artifactOutputPath",
      "branch",
      "expectedInputDigest",
      "id",
      "inputArtifactPath",
      "type",
    ])
    && isAbsolute(asString(value.inputArtifactPath))
    && typeof value.expectedInputDigest === "string"
    && SHA256.test(value.expectedInputDigest)
    && (value.branch === null || isBoundedNonEmptyString(value.branch));
}

/**
 * Mirror the extractor's policy envelope at the private IPC boundary without evaluating the
 * extractor package in the long-lived web process. The worker validates it again before use.
 */
function isTypeScriptRevisionShardPolicy(
  value: unknown,
): value is TypeScriptRevisionShardPolicy {
  if (!isRecord(value) || !hasExactKeys(value, [
    "admission",
    "analysisPolicyFingerprint",
    "buildFingerprint",
    "cacheDir",
    "mode",
    "pairCacheDir",
    "runtimeFingerprint",
    "treeOid",
    "version",
  ])) return false;
  if (!isRecord(value.runtimeFingerprint) || !hasExactKeys(value.runtimeFingerprint, [
    "arch",
    "nodeVersion",
    "platform",
    "tsMorphVersion",
    "typescriptVersion",
  ])) return false;
  if (
    value.version !== 1
    || !isTypeScriptRevisionShardMode(value.mode)
    || !isAbsolute(asString(value.cacheDir))
    || Buffer.byteLength(value.cacheDir as string) > MAX_PATH_BYTES
    || (value.pairCacheDir !== null
      && (!isAbsolute(asString(value.pairCacheDir))
        || Buffer.byteLength(value.pairCacheDir as string) > MAX_PATH_BYTES))
    || (value.mode !== "admitted" && value.pairCacheDir !== null)
    || typeof value.treeOid !== "string"
    || !GIT_TREE_OID.test(value.treeOid)
    || typeof value.buildFingerprint !== "string"
    || !SHA256.test(value.buildFingerprint)
    || typeof value.analysisPolicyFingerprint !== "string"
    || !SHA256.test(value.analysisPolicyFingerprint)
    || !isModeAdmission(value.mode, value.admission)
  ) {
    return false;
  }
  return [
    value.runtimeFingerprint.nodeVersion,
    value.runtimeFingerprint.platform,
    value.runtimeFingerprint.arch,
    value.runtimeFingerprint.typescriptVersion,
    value.runtimeFingerprint.tsMorphVersion,
  ].every((part) => (
    typeof part === "string"
    && part.length > 0
    && Buffer.byteLength(part) <= 128
  ));
}

function isTypeScriptRevisionShardMode(value: unknown): value is TypeScriptRevisionShardMode {
  return value === "empty"
    || value === "shadow"
    || value === "admitted"
    || value === "verified-experimental";
}

function isModeAdmission(
  mode: TypeScriptRevisionShardMode,
  value: unknown,
): value is RevisionShardAdmissionCapability | null {
  if (mode === "shadow") {
    return isRevisionShardAdmissionCapability(value) && value.kind === "signer";
  }
  if (mode === "admitted") {
    return isRevisionShardAdmissionCapability(value) && value.kind === "verifier";
  }
  return value === null;
}

function isRevisionShardAdmissionCapability(
  value: unknown,
): value is RevisionShardAdmissionCapability {
  if (!isRecord(value) || (value.kind !== "signer" && value.kind !== "verifier")) {
    return false;
  }
  const expectedKeys = value.kind === "signer"
    ? ["keyId", "kind", "privateKeyPkcs8", "publicKeySpki", "version"]
    : ["keyId", "kind", "publicKeySpki", "version"];
  if (
    !hasExactKeys(value, expectedKeys)
    || value.version !== 1
    || typeof value.keyId !== "string"
    || !SHA256.test(value.keyId)
    || typeof value.publicKeySpki !== "string"
  ) {
    return false;
  }
  const publicDer = canonicalBase64(value.publicKeySpki);
  if (publicDer === null || publicDer.byteLength > 1024) return false;
  try {
    const publicKey = createPublicKey({ key: publicDer, format: "der", type: "spki" });
    if (
      publicKey.asymmetricKeyType !== "ed25519"
      || createHash("sha256").update(publicDer).digest("hex") !== value.keyId
    ) {
      return false;
    }
    if (value.kind === "signer") {
      return isMatchingAdmissionSigner(value as unknown as RevisionShardAdmissionSigner, publicKey);
    }
    return true;
  } catch {
    return false;
  }
}

function isMatchingAdmissionSigner(
  signer: RevisionShardAdmissionSigner,
  publicKey: ReturnType<typeof createPublicKey>,
): boolean {
  const privateDer = canonicalBase64(signer.privateKeyPkcs8);
  if (privateDer === null || privateDer.byteLength > 2048) return false;
  try {
    const privateKey = createPrivateKey({ key: privateDer, format: "der", type: "pkcs8" });
    const proof = Buffer.from("meridian.typescript-revision-shard-admission.keypair.v1", "utf8");
    return privateKey.asymmetricKeyType === "ed25519"
      && verify(null, proof, publicKey, sign(null, proof, privateKey));
  } catch {
    return false;
  }
}

function canonicalBase64(value: string): Buffer | null {
  if (
    value.length === 0
    || value.length > 4096
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    return null;
  }
  const bytes = Buffer.from(value, "base64");
  return bytes.toString("base64") === value ? bytes : null;
}

function isReviewFingerprintSelection(value: unknown): value is ReviewFingerprintSelection | null {
  if (value === null) return true;
  if (!isRecord(value)) return false;
  if (value.mode === "changed" || value.mode === "all") return hasExactKeys(value, ["mode"]);
  return value.mode === "files"
    && hasExactKeys(value, ["files", "mode"])
    && Array.isArray(value.files)
    && isBoundedPaths(value.files, MAX_REPOSITORY_WORKER_CHANGED_FILES, MAX_CHANGED_PATH_BYTES_TOTAL);
}

export function isRepositoryAnalysisWorkerResponse(
  value: unknown,
): value is RepositoryAnalysisWorkerResponse {
  if (!isRecord(value)) return false;
  if (value.type === "result") {
    return hasExactKeys(value, ["result", "type"]) && isWorkerFileResult(value.result);
  }
  if (value.type === "progress") {
    return hasExactKeys(value, ["id", "progress", "type"])
      && ITEM_ID.test(asString(value.id))
      && isRepositoryAnalysisProgress(value.progress);
  }
  if (value.type !== "error" || !hasExactKeys(value, ["error", "type"]) || !isRecord(value.error)) {
    return false;
  }
  if (value.error.kind === "internal") return hasExactKeys(value.error, ["kind"]);
  return value.error.kind === "cli"
    && hasExactKeys(value.error, ["details", "exitCode", "kind", "message"])
    && isExitCode(value.error.exitCode)
    && typeof value.error.message === "string"
    && Buffer.byteLength(value.error.message) <= MAX_ERROR_TEXT_BYTES
    && Array.isArray(value.error.details)
    && value.error.details.length <= MAX_ERROR_DETAILS
    && value.error.details.every((detail) => (
      typeof detail === "string" && Buffer.byteLength(detail) <= MAX_ERROR_TEXT_BYTES
    ));
}

export function isRepositoryAnalysisProgressContext(
  value: unknown,
): value is RepositoryAnalysisProgressContext {
  if (!isRecord(value) || !hasExactKeys(value, ["revision", "version"])
    || value.version !== 1 || !isRecord(value.revision)
    || !hasExactKeys(value.revision, ["commit", "execution", "kind"])
    || (value.revision.kind !== "head" && value.revision.kind !== "merge-base")
    || typeof value.revision.commit !== "string"
    || !GIT_TREE_OID.test(value.revision.commit)
    || !isRecord(value.revision.execution)
    || !hasExactKeys(value.revision.execution, ["current", "total"])) {
    return false;
  }
  const { current, total } = value.revision.execution;
  return Number.isSafeInteger(current)
    && Number.isSafeInteger(total)
    && (current as number) >= 1
    && (total as number) >= 1
    && (total as number) <= MAX_REPOSITORY_ANALYSIS_EXECUTIONS
    && (current as number) <= (total as number);
}

export function isRepositoryAnalysisProgress(
  value: unknown,
): value is RepositoryAnalysisProgress {
  const keys = isRecord(value) && value.activity !== undefined
    ? ["activity", "language", "phase", "revision", "sourceFile", "unit", "version"]
    : ["language", "phase", "revision", "sourceFile", "unit", "version"];
  return isRecord(value)
    && hasExactKeys(value, keys)
    && isRepositoryAnalysisProgressContext({ version: value.version, revision: value.revision })
    && (value.language === "typescript" || value.language === "python")
    && isExtractionProgressPhase(value.phase)
    && (value.activity === undefined || (
      value.phase === "relationships"
      && isExtractionProgressActivity(value.activity)
    ))
    && isProgressPosition(value.unit, true)
    && isProgressPosition(value.sourceFile, false)
    && (value.sourceFile === null || value.unit !== null);
}

/**
 * Enrich real extractor observations with immutable revision coordinates while bounding IPC.
 * File/unit observations are time-sampled; the first relationship and terminal stitch/finalize
 * phases are preserved. Observer failures are deliberately isolated from graph extraction.
 */
export function createRepositoryAnalysisProgressReporter(
  context: RepositoryAnalysisProgressContext,
  emit: (progress: RepositoryAnalysisProgress) => void,
  now: () => number = Date.now,
): (progress: ExtractionProgress) => void {
  if (!isRepositoryAnalysisProgressContext(context)) {
    throw new TypeError("repository analysis progress context is invalid");
  }
  let emitted = 0;
  let regularEmitted = 0;
  let activityEmitted = 0;
  let inputProofClearEmitted = 0;
  let lastEmittedAt = Number.NEGATIVE_INFINITY;
  const sawFirstSource = new Set<ExtractionProgress["language"]>();
  const sawFinalSource = new Set<ExtractionProgress["language"]>();
  const sawInputProof = new Set<ExtractionProgress["language"]>();
  const sawRelationships = new Set<ExtractionProgress["language"]>();
  const sawStitch = new Set<ExtractionProgress["language"]>();
  const sawFinalize = new Set<ExtractionProgress["language"]>();
  let previousActivityCoordinate: string | null = null;
  const inputProofSources = new Set<ExtractionProgress["language"]>();
  return (progress) => {
    if (!isRawExtractionProgress(progress)) return;
    const timestamp = now();
    const firstObservation = emitted === 0;
    const firstInputProof = progress.phase === "input-proof"
      && !sawInputProof.has(progress.language);
    const firstRelationship = progress.phase === "relationships"
      && !sawRelationships.has(progress.language);
    const firstStitch = progress.phase === "stitch"
      && !sawStitch.has(progress.language);
    const firstFinalize = progress.phase === "finalize"
      && !sawFinalize.has(progress.language);
    const firstSource = progress.sourceFile?.current === 1
      && progress.unit?.current === 1
      && !sawFirstSource.has(progress.language);
    const finalSource = progress.sourceFile !== null
      && progress.unit !== null
      && progress.sourceFile.current === progress.sourceFile.total
      && progress.unit.current === progress.unit.total
      && !sawFinalSource.has(progress.language);
    const activityCoordinate = progress.activity === undefined || progress.unit === null
      ? null
      : `${progress.language}\u0000${progress.unit.path}\u0000${progress.activity}`;
    const activityTransition = activityCoordinate !== null
      && activityCoordinate !== previousActivityCoordinate;
    previousActivityCoordinate = activityCoordinate;
    const clearsInputProofSource = progress.phase === "input-proof"
      && progress.sourceFile === null
      && inputProofSources.has(progress.language);
    const opensInputProofSource = progress.phase === "input-proof"
      && progress.sourceFile !== null
      && !inputProofSources.has(progress.language);
    // Never present a file unless capacity remains for the later explicit clear. Once the bounded
    // reservation is exhausted, unit/phase progress remains truthful without risking a stale path.
    if (
      opensInputProofSource
      && inputProofClearEmitted + inputProofSources.size >= RESERVED_INPUT_PROOF_CLEAR_EVENTS
    ) {
      return;
    }
    const requiredPhaseObservation = firstSource
      || finalSource
      || firstInputProof
      || firstRelationship
      || firstStitch
      || firstFinalize;
    const reservedActivityObservation = activityTransition
      && activityEmitted < RESERVED_ACTIVITY_PROGRESS_EVENTS;
    const reservedInputProofClear = clearsInputProofSource
      && inputProofClearEmitted < RESERVED_INPUT_PROOF_CLEAR_EVENTS;
    const regularCapacity = MAX_REPOSITORY_WORKER_PROGRESS_EVENTS
      - RESERVED_REQUIRED_PROGRESS_EVENTS;
    const sampledObservation = firstObservation
      || timestamp - lastEmittedAt >= MIN_PROGRESS_INTERVAL_MS;
    const capacityBucket = requiredPhaseObservation
      ? "phase"
      : reservedActivityObservation
        ? "activity"
        : reservedInputProofClear
          ? "input-proof-clear"
          : sampledObservation && regularEmitted < regularCapacity
            ? "regular"
            : null;
    if (capacityBucket === null || emitted >= MAX_REPOSITORY_WORKER_PROGRESS_EVENTS) {
      return;
    }
    if (firstSource) sawFirstSource.add(progress.language);
    if (finalSource) sawFinalSource.add(progress.language);
    if (firstInputProof) sawInputProof.add(progress.language);
    if (firstRelationship) sawRelationships.add(progress.language);
    if (firstStitch) sawStitch.add(progress.language);
    if (firstFinalize) sawFinalize.add(progress.language);
    const bounded: RepositoryAnalysisProgress = {
      version: 1,
      revision: {
        kind: context.revision.kind,
        commit: context.revision.commit,
        execution: { ...context.revision.execution },
      },
      language: progress.language,
      phase: progress.phase,
      ...(progress.activity === undefined ? {} : { activity: progress.activity }),
      unit: boundedProgressPosition(progress.unit),
      sourceFile: boundedProgressPosition(progress.sourceFile),
    };
    if (!isRepositoryAnalysisProgress(bounded)) return;
    emitted += 1;
    if (capacityBucket === "activity") activityEmitted += 1;
    if (capacityBucket === "input-proof-clear") inputProofClearEmitted += 1;
    if (capacityBucket === "regular") regularEmitted += 1;
    if (progress.phase === "input-proof" && progress.sourceFile !== null) {
      inputProofSources.add(progress.language);
    } else {
      inputProofSources.delete(progress.language);
    }
    lastEmittedAt = timestamp;
    try {
      const result = emit(bounded);
      sinkPromiseLike(result);
    } catch {
      // Progress is observational. A consumer cannot change or fail graph extraction.
    }
  };
}

export function isRepositoryAnalysisFacts(value: unknown): value is RepositoryAnalysisFacts {
  return isRecord(value)
    && hasExactKeys(value, [
      "changedFiles",
      "changedSinceBaseRef",
      "emptySideHints",
      "sourceFiles",
      "summary",
      "target",
      "warnings",
    ])
    && isGraphSummary(value.summary)
    && isTarget(value.target)
    && isChangedFiles(value.changedFiles)
    && isBoundedPaths(value.emptySideHints, MAX_REPOSITORY_WORKER_EMPTY_SIDE_HINTS, MAX_HINT_PATH_BYTES_TOTAL)
    && isBoundedPaths(value.sourceFiles, MAX_REPOSITORY_WORKER_SOURCE_FILES, MAX_REPOSITORY_WORKER_SOURCE_PATH_BYTES_TOTAL)
    && (value.changedSinceBaseRef === null || isBoundedNonEmptyString(value.changedSinceBaseRef))
    && isWarnings(value.warnings);
}

/** Canonical manifest and base provenance for the compact response. */
export function changedMetadataForWorker(
  artifact: GraphArtifact,
  expectedBaseRef?: string,
): { changedFiles: ChangedFileManifestEntry[]; changedSinceBaseRef: string | null } {
  const changedFiles = changedFileManifestFromExtensions(artifact.extensions);
  if (expectedBaseRef !== undefined) {
    const changedSince = artifact.extensions?.changedSince as { baseRef?: unknown } | undefined;
    if (changedFiles === null || changedSince?.baseRef !== expectedBaseRef) {
      throw new CliError(EXIT.validation, "repository analysis produced invalid changed-file provenance");
    }
    const sorted = sortChangedFiles(changedFiles);
    requireChangedFiles(sorted);
    return { changedFiles: sorted, changedSinceBaseRef: expectedBaseRef };
  }
  if (changedFiles === null) return { changedFiles: [], changedSinceBaseRef: null };
  const sorted = sortChangedFiles(changedFiles);
  requireChangedFiles(sorted);
  const baseRef = (artifact.extensions?.changedSince as { baseRef?: unknown } | undefined)?.baseRef;
  return {
    changedFiles: sorted,
    changedSinceBaseRef: typeof baseRef === "string" && baseRef.length > 0 ? baseRef : null,
  };
}

/**
 * One safe path per selected extractor is sufficient to select every populated-side language in
 * an intentionally empty peer. Returning all node paths would make IPC scale with graph size.
 */
export function emptySideHintsForWorker(
  artifact: Pick<GraphArtifact, "nodes">,
  changedFiles: readonly ChangedFileManifestEntry[],
  extractors: readonly Pick<LanguageExtractor, "extensions">[],
): string[] {
  const candidates = [...new Set([
    ...artifact.nodes.map((node) => node.location.file),
    ...changedFiles.flatMap((file) => [file.path, ...(file.previousPath ? [file.previousPath] : [])]),
  ].filter(safeLogicalPath))].sort();
  const hints = [...new Set(extractors.flatMap((extractor) => {
    const extensions = extractor.extensions.map((extension) => extension.toLowerCase());
    const match = candidates.find((file) => extensions.some((extension) => (
      file.toLowerCase().endsWith(extension)
    )));
    return match === undefined ? [] : [match];
  }))].sort();
  if (!isBoundedPaths(hints, MAX_REPOSITORY_WORKER_EMPTY_SIDE_HINTS, MAX_HINT_PATH_BYTES_TOTAL)) {
    throw new CliError(EXIT.validation, "repository analysis empty-side hints exceed worker limits");
  }
  return hints;
}

/** Match `syntheticSourceFingerprint`: exclude non-source node kinds, normalize, unique, sort. */
export function syntheticSourceFilesForWorker(
  artifact: GraphArtifact,
): string[] {
  const sourceFiles = syntheticSourceFiles(artifact);
  if (!isBoundedPaths(
    sourceFiles,
    MAX_REPOSITORY_WORKER_SOURCE_FILES,
    MAX_REPOSITORY_WORKER_SOURCE_PATH_BYTES_TOTAL,
  )) {
    throw new CliError(EXIT.validation, "repository analysis source-file metadata exceeds worker limits");
  }
  return sourceFiles;
}

export function boundedRepositoryWorkerWarnings(
  warnings: readonly string[],
  token?: string,
): string[] {
  const bounded: string[] = [];
  const seen = new Set<string>();
  let totalBytes = 0;
  for (const warning of warnings) {
    if (bounded.length >= MAX_REPOSITORY_WORKER_WARNINGS) break;
    const sanitized = truncateUtf8(sanitizeRepositoryWorkerText(warning, token), MAX_WARNING_BYTES);
    if (seen.has(sanitized)) continue;
    const bytes = Buffer.byteLength(sanitized);
    if (totalBytes + bytes > MAX_WARNING_BYTES_TOTAL) continue;
    seen.add(sanitized);
    bounded.push(sanitized);
    totalBytes += bytes;
  }
  return bounded;
}

export function repositoryAnalysisWorkerFailure(
  error: unknown,
  token?: string,
): RepositoryAnalysisWorkerFailure {
  if (!(error instanceof CliError)) return { kind: "internal" };
  return {
    kind: "cli",
    exitCode: error.exitCode,
    message: sanitizeRepositoryWorkerText(error.message, token),
    details: error.details.slice(0, MAX_ERROR_DETAILS).map((detail) => (
      sanitizeRepositoryWorkerText(detail, token)
    )),
  };
}

export function errorFromRepositoryAnalysisWorker(
  failure: RepositoryAnalysisWorkerFailure,
  token?: string,
): CliError {
  if (failure.kind === "internal") {
    return new CliError(EXIT.internal, "repository analysis failed in the isolated process");
  }
  return new CliError(
    failure.exitCode,
    sanitizeRepositoryWorkerText(failure.message, token),
    failure.details.map((detail) => sanitizeRepositoryWorkerText(detail, token)),
  );
}

export function sanitizeRepositoryWorkerText(value: string, token?: string): string {
  let scrubbed = value
    .replace(/AUTHORIZATION:\s*basic\s+\S+/gi, "AUTHORIZATION: basic ***")
    .replace(/https?:\/\/[^\s/@]+:[^\s/@]+@/gi, (match) => `${match.slice(0, match.indexOf("//") + 2)}***@`)
    .replace(/\b(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]{16,}\b/g, "***");
  if (token) {
    const encoded = Buffer.from(`x-access-token:${token}`, "utf8").toString("base64");
    scrubbed = scrubbed.split(token).join("***").split(encoded).join("***");
  }
  return truncateUtf8(scrubbed, MAX_ERROR_TEXT_BYTES);
}

function isRawExtractionProgress(value: unknown): value is ExtractionProgress {
  const keys = isRecord(value) && value.activity !== undefined
    ? ["activity", "language", "phase", "sourceFile", "unit"]
    : ["language", "phase", "sourceFile", "unit"];
  return isRecord(value)
    && hasExactKeys(value, keys)
    && (value.language === "typescript" || value.language === "python")
    && isExtractionProgressPhase(value.phase)
    && (value.activity === undefined || (
      value.phase === "relationships"
      && isExtractionProgressActivity(value.activity)
    ))
    && isRawProgressPosition(value.unit, true)
    && isRawProgressPosition(value.sourceFile, false)
    && (value.sourceFile === null || value.unit !== null);
}

function isExtractionProgressPhase(value: unknown): value is ExtractionProgressPhase {
  return value === "project-load"
    || value === "input-proof"
    || value === "structure"
    || value === "relationships"
    || value === "stitch"
    || value === "finalize";
}

function isExtractionProgressActivity(value: unknown): value is ExtractionProgressActivity {
  return value === "calls-and-types"
    || value === "imports"
    || value === "value-references"
    || value === "promise-discovery"
    || value === "promise-links"
    || value === "logic-flows"
    || value === "ports"
    || value === "exports";
}

function isRawProgressPosition(
  value: unknown,
  allowProjectRoot: boolean,
): boolean {
  return value === null || (
    isRecord(value)
    && hasExactKeys(value, ["current", "path", "total"])
    && validProgressIndex(value.current, value.total)
    && validProgressLogicalPath(value.path, allowProjectRoot, MAX_PATH_BYTES)
  );
}

function isProgressPosition(
  value: unknown,
  allowProjectRoot: boolean,
): value is RepositoryAnalysisProgressPosition | null {
  return value === null || (
    isRecord(value)
    && hasExactKeys(value, ["current", "path", "pathTruncated", "total"])
    && validProgressIndex(value.current, value.total)
    && validProgressLogicalPath(value.path, allowProjectRoot, MAX_PROGRESS_PATH_BYTES)
    && typeof value.pathTruncated === "boolean"
  );
}

function validProgressIndex(current: unknown, total: unknown): boolean {
  return Number.isSafeInteger(current)
    && Number.isSafeInteger(total)
    && (current as number) >= 1
    && (total as number) >= 1
    && (total as number) <= MAX_REPOSITORY_WORKER_SOURCE_FILES
    && (current as number) <= (total as number);
}

function validProgressLogicalPath(
  value: unknown,
  allowProjectRoot: boolean,
  maxBytes: number,
): value is string {
  if (allowProjectRoot && value === ".") return true;
  return typeof value === "string"
    && safeLogicalPath(value)
    && Buffer.byteLength(value) <= maxBytes;
}

function boundedProgressPosition(
  value: ExtractionProgress["unit"] | ExtractionProgress["sourceFile"],
): RepositoryAnalysisProgressPosition | null {
  if (value === null) return null;
  const path = truncateProgressPath(value.path);
  return {
    current: value.current,
    total: value.total,
    path: path.value,
    pathTruncated: path.truncated,
  };
}

function truncateProgressPath(value: string): { value: string; truncated: boolean } {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.byteLength <= MAX_PROGRESS_PATH_BYTES) {
    return { value, truncated: false };
  }
  const prefix = "…/";
  let bytes = Buffer.byteLength(prefix);
  let suffix = "";
  const codePoints = Array.from(value);
  for (let index = codePoints.length - 1; index >= 0; index -= 1) {
    const codePoint = codePoints[index];
    const codePointBytes = Buffer.byteLength(codePoint);
    if (bytes + codePointBytes > MAX_PROGRESS_PATH_BYTES) break;
    suffix = `${codePoint}${suffix}`;
    bytes += codePointBytes;
  }
  while (suffix.startsWith("/")) {
    suffix = suffix.slice(1);
  }
  return { value: `${prefix}${suffix}`, truncated: true };
}

function sinkPromiseLike(value: unknown): void {
  if (
    (typeof value !== "object" || value === null)
    && typeof value !== "function"
  ) {
    return;
  }
  try {
    if (typeof (value as { then?: unknown }).then === "function") {
      void Promise.resolve(value).catch(() => {});
    }
  } catch {
    // Progress observers cannot fail graph extraction.
  }
}

function isNormalizedAnalysisRequest(value: unknown): value is NormalizedRepositoryAnalysisRequest {
  if (!isRecord(value) || !hasExactKeys(value, [
    "absoluteRoot",
    "allowEmpty",
    "changedSince",
    "changedSinceTimeoutMs",
    "cwd",
    "hintedFiles",
    "targetName",
    "vcs",
  ])) return false;
  return isAbsolute(asString(value.absoluteRoot))
    && isAbsolute(asString(value.cwd))
    && (value.targetName === null || isBoundedNonEmptyString(value.targetName))
    && (value.vcs === null || isVcs(value.vcs))
    && (value.changedSince === null || isBoundedNonEmptyString(value.changedSince))
    && (value.changedSinceTimeoutMs === null || (
      Number.isSafeInteger(value.changedSinceTimeoutMs) && (value.changedSinceTimeoutMs as number) > 0
    ))
    && isBoundedPaths(value.hintedFiles, MAX_REPOSITORY_WORKER_SOURCE_FILES, MAX_REPOSITORY_WORKER_SOURCE_PATH_BYTES_TOTAL)
    && typeof value.allowEmpty === "boolean";
}

function isWorkerFileResult(value: unknown): value is RepositoryAnalysisWorkerFileResult {
  if (!isRecord(value) || !hasExactKeys(value, [
    "artifactBytes",
    "artifactPath",
    "artifactSha256",
    "branchVariant",
    "changedFiles",
    "changedSinceBaseRef",
    "emptySideHints",
    "graphSummary",
    "id",
    "kind",
    "operation",
    "sourceFiles",
    "target",
    "warnings",
  ])) return false;
  return value.kind === "file"
    && (value.operation === "analyze" || value.operation === "restamp")
    && ITEM_ID.test(asString(value.id))
    && isAbsolute(asString(value.artifactPath))
    && Number.isSafeInteger(value.artifactBytes)
    && (value.artifactBytes as number) > 0
    && typeof value.artifactSha256 === "string"
    && SHA256.test(value.artifactSha256)
    && (value.branchVariant === null || isBranchVariantResult(value.branchVariant))
    && isGraphSummary(value.graphSummary)
    && isTarget(value.target)
    && isChangedFiles(value.changedFiles)
    && isBoundedPaths(value.emptySideHints, MAX_REPOSITORY_WORKER_EMPTY_SIDE_HINTS, MAX_HINT_PATH_BYTES_TOTAL)
    && isBoundedPaths(value.sourceFiles, MAX_REPOSITORY_WORKER_SOURCE_FILES, MAX_REPOSITORY_WORKER_SOURCE_PATH_BYTES_TOTAL)
    && (value.changedSinceBaseRef === null || isBoundedNonEmptyString(value.changedSinceBaseRef))
    && isWarnings(value.warnings);
}

function isBranchVariantRequest(value: unknown, primaryPath: unknown): boolean {
  return value === null || (
    isRecord(value)
    && hasExactKeys(value, ["artifactOutputPath", "branch"])
    && isAbsolute(asString(value.artifactOutputPath))
    && value.artifactOutputPath !== primaryPath
    && isBoundedNonEmptyString(value.branch)
  );
}

function isBranchVariantResult(value: unknown): value is RepositoryAnalysisWorkerBranchVariantResult {
  return isRecord(value)
    && hasExactKeys(value, ["artifactBytes", "artifactPath", "artifactSha256", "graphSummary", "target"])
    && isAbsolute(asString(value.artifactPath))
    && Number.isSafeInteger(value.artifactBytes)
    && (value.artifactBytes as number) > 0
    && typeof value.artifactSha256 === "string"
    && SHA256.test(value.artifactSha256)
    && isGraphSummary(value.graphSummary)
    && isTarget(value.target);
}

function isGraphSummary(value: unknown): value is WebGraphArtifactSummary {
  return isRecord(value)
    && hasExactKeys(value, ["edgeCount", "generatedAt", "nodeCount", "schemaVersion"])
    && typeof value.schemaVersion === "string"
    && value.schemaVersion === SCHEMA_VERSION
    && typeof value.generatedAt === "string"
    && value.generatedAt.length > 0
    && Buffer.byteLength(value.generatedAt) <= MAX_PATH_BYTES
    && Number.isSafeInteger(value.nodeCount)
    && (value.nodeCount as number) >= 0
    && Number.isSafeInteger(value.edgeCount)
    && (value.edgeCount as number) >= 0;
}

function isTarget(value: unknown): value is Target {
  if (!isRecord(value)) return false;
  const expectedKeys = value.vcs === undefined
    ? value.version === undefined ? ["language", "name", "root"] : ["language", "name", "root", "version"]
    : value.version === undefined
      ? ["language", "name", "root", "vcs"]
      : ["language", "name", "root", "vcs", "version"];
  return hasExactKeys(value, expectedKeys)
    && isBoundedNonEmptyString(value.name)
    && isBoundedNonEmptyString(value.root)
    && isBoundedNonEmptyString(value.language)
    && (value.version === undefined || isBoundedNonEmptyString(value.version))
    && (value.vcs === undefined || isVcs(value.vcs))
    && targetSchema.safeParse(value).success;
}

function isVcs(value: unknown): value is NonNullable<Target["vcs"]> {
  if (!isRecord(value)) return false;
  const allowed = ["branch", "commit", "dirty", "repository"];
  if (Object.keys(value).some((key) => !allowed.includes(key))) return false;
  return (value.repository === undefined || isBoundedNonEmptyString(value.repository))
    && (value.commit === undefined || isBoundedNonEmptyString(value.commit))
    && (value.branch === undefined || isBoundedNonEmptyString(value.branch))
    && (value.dirty === undefined || typeof value.dirty === "boolean");
}

function requireChangedFiles(value: ChangedFileManifestEntry[]): void {
  if (!isChangedFiles(value)) {
    throw new CliError(EXIT.validation, "repository changed-file metadata exceeds worker limits");
  }
}

function isChangedFiles(value: unknown): value is ChangedFileManifestEntry[] {
  if (!Array.isArray(value) || value.length > MAX_REPOSITORY_WORKER_CHANGED_FILES) return false;
  const seen = new Set<string>();
  let previousPath: string | undefined;
  let bytes = 0;
  for (const entry of value) {
    if (!isRecord(entry) || !safeLogicalPath(entry.path) || seen.has(entry.path)) return false;
    if (previousPath !== undefined && previousPath.localeCompare(entry.path) >= 0) return false;
    seen.add(entry.path);
    previousPath = entry.path;
    if (entry.status === "renamed") {
      if (!safeLogicalPath(entry.previousPath) || entry.previousPath === entry.path
        || !hasExactKeys(entry, ["path", "previousPath", "status"])) return false;
      bytes += Buffer.byteLength(entry.previousPath);
    } else if ((entry.status !== "added" && entry.status !== "modified" && entry.status !== "deleted")
      || !hasExactKeys(entry, ["path", "status"])) return false;
    bytes += Buffer.byteLength(entry.path);
    if (bytes > MAX_CHANGED_PATH_BYTES_TOTAL) return false;
  }
  return true;
}

function isBoundedPaths(value: unknown, maxCount: number, maxBytes: number): value is string[] {
  if (!Array.isArray(value) || value.length > maxCount) return false;
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const path = value[index];
    if (!safeLogicalPath(path) || (index > 0 && value[index - 1] >= path)) return false;
    bytes += Buffer.byteLength(path);
    if (bytes > maxBytes) return false;
  }
  return true;
}

function isWarnings(value: unknown): value is string[] {
  if (!Array.isArray(value) || value.length > MAX_REPOSITORY_WORKER_WARNINGS) return false;
  let bytes = 0;
  for (const warning of value) {
    if (typeof warning !== "string" || Buffer.byteLength(warning) > MAX_WARNING_BYTES) return false;
    bytes += Buffer.byteLength(warning);
    if (bytes > MAX_WARNING_BYTES_TOTAL) return false;
  }
  return true;
}

function safeLogicalPath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.startsWith("/")
    || value.includes("\\") || value.includes("\0") || /^[A-Za-z]:/.test(value)
    || Buffer.byteLength(value) > MAX_PATH_BYTES) return false;
  return value.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
}

function sortChangedFiles(value: readonly ChangedFileManifestEntry[]): ChangedFileManifestEntry[] {
  return [...value].sort((left, right) => left.path.localeCompare(right.path));
}

function isBoundedNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= MAX_PATH_BYTES;
}

function isExitCode(value: unknown): value is ExitCode {
  return typeof value === "number" && value !== EXIT.ok && Object.values(EXIT).includes(value as ExitCode);
}

function truncateUtf8(value: string, maxBytes: number): string {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.byteLength <= maxBytes) return value;
  let truncated = encoded.subarray(0, maxBytes).toString("utf8");
  while (Buffer.byteLength(truncated) > maxBytes) truncated = truncated.slice(0, -1);
  return truncated;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
