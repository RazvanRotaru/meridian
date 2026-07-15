/**
 * Serializable messages shared by the extraction worker and its parent process.
 *
 * Credentials deliberately live beside (not inside) the pipeline request. This prevents a token
 * from accidentally becoming part of a cache key or persisted request snapshot when callers
 * reuse the serializable request type.
 */

import { changedFileManifestFromExtensions } from "@meridian/core";
import type { ChangedFileManifestEntry, ExtractOptions, GraphArtifact } from "@meridian/core";
import { CliError, EXIT } from "../errors";
import type { ExitCode } from "../errors";
import type { InspectionGraphSummary } from "./inspection-snapshot-store";

export const MAX_WORKER_ERROR_TEXT_BYTES = 4_000;
export const MAX_WORKER_ERROR_DETAILS = 64;
export const MAX_WORKER_CHANGED_FILES = 100_000;
export const MAX_WORKER_CHANGED_PATH_BYTES = 4_096;
export const MAX_WORKER_CHANGED_PATH_BYTES_TOTAL = 1024 * 1024;
export const MAX_WORKER_HINTED_FILES = 8;
export const MAX_WORKER_HINTED_PATH_BYTES_TOTAL = 32 * 1024;
export const MAX_WORKER_WARNINGS = 64;
export const MAX_WORKER_WARNING_BYTES = 4_000;
export const MAX_WORKER_WARNING_BYTES_TOTAL = 64 * 1024;

const SUPPORTED_HINT_EXTENSIONS = [
  [".ts", ".tsx"],
  [".py"],
] as const;

/** The function-valued `changedSinceGitExecutor` is intentionally absent. */
export interface SerializablePipelineRequest {
  absoluteRoot: string;
  cwd: string;
  language?: string;
  project?: string;
  include?: string[];
  exclude?: string[];
  depth?: ExtractOptions["depth"];
  includeExternal?: boolean;
  includeUnresolved?: boolean;
  materializeBoundary: boolean;
  excludeTests?: boolean;
  valueRefs?: boolean;
  changedSince?: string;
  changedSinceLabel?: string;
  changedSinceTimeoutMs?: number;
  hintedFiles?: string[];
  allowEmpty?: boolean;
  targetName?: string;
  vcs?: GraphArtifact["target"]["vcs"];
}

/**
 * The only successful value returned to the web parent. The complete graph remains in the
 * caller-owned file; IPC carries only bounded metadata needed by cache publication and responses.
 */
export interface ExtractionWorkerResult {
  readonly kind: "file";
  readonly artifactPath: string;
  readonly artifactBytes: number;
  readonly artifactSha256: string;
  readonly projectionDirectory: string;
  readonly graphSummary: InspectionGraphSummary;
  readonly changedFiles: ChangedFileManifestEntry[];
  /** Sorted populated-side source/manifest paths used to select extractors for an empty peer. */
  readonly hintedFiles: string[];
  readonly changedSinceBaseRef?: string;
  readonly vcsCommit?: string;
  warnings: string[];
}

export interface ExtractionWorkerRequestMessage {
  type: "extract";
  request: SerializablePipelineRequest;
  /** Parent-owned private staging path; the graph itself never crosses IPC. */
  artifactOutputPath: string;
  /** Ephemeral: sent over the private IPC channel, never argv, environment, disk, or logs. */
  token?: string;
}

interface ExtractionWorkerCliFailure {
  kind: "cli";
  exitCode: ExitCode;
  message: string;
  details: string[];
}

interface ExtractionWorkerInternalFailure {
  kind: "internal";
}

export type ExtractionWorkerFailure = ExtractionWorkerCliFailure | ExtractionWorkerInternalFailure;

export type ExtractionWorkerResponseMessage =
  | { type: "result"; result: ExtractionWorkerResult }
  | { type: "error"; error: ExtractionWorkerFailure };

/** Fail closed when a changed-since artifact omits or rewrites its canonical diff provenance. */
export function changedSinceWorkerMetadata(
  artifact: GraphArtifact,
  request: Pick<SerializablePipelineRequest, "changedSince" | "changedSinceLabel">,
): { changedFiles: ChangedFileManifestEntry[]; changedSinceBaseRef?: string } {
  if (!request.changedSince) return { changedFiles: [] };
  const changedFiles = changedFileManifestFromExtensions(artifact.extensions);
  const changedSince = artifact.extensions?.changedSince as { baseRef?: unknown } | undefined;
  const expectedBaseRef = request.changedSinceLabel ?? request.changedSince;
  if (changedFiles === null) {
    throw new CliError(EXIT.validation, "changed-since extraction did not produce a canonical file manifest");
  }
  if (!isChangedFileManifest(changedFiles)) {
    throw new CliError(EXIT.validation, "changed-since canonical file manifest exceeds worker metadata limits");
  }
  if (changedSince?.baseRef !== expectedBaseRef) {
    throw new CliError(EXIT.validation, "changed-since extraction produced mismatched base provenance");
  }
  return {
    changedFiles: [...changedFiles].sort((left, right) => left.path.localeCompare(right.path)),
    changedSinceBaseRef: expectedBaseRef,
  };
}

/** Keep only one canonical selector hint per supported extractor language. */
export function representativeHintedFiles(
  artifact: Pick<GraphArtifact, "nodes">,
  changedFiles: readonly ChangedFileManifestEntry[],
): string[] {
  const candidates = [...new Set([
    ...artifact.nodes.map((node) => node.location.file),
    ...changedFiles.map((file) => file.path),
  ].filter(safeManifestPath))].sort();
  const representatives = SUPPORTED_HINT_EXTENSIONS.flatMap((extensions) => {
    const match = candidates.find((file) => extensions.some((extension) => (
      file.toLowerCase().endsWith(extension)
    )));
    return match === undefined ? [] : [match];
  }).sort();
  return representatives.slice(0, MAX_WORKER_HINTED_FILES);
}

/** Bound warning IPC independently of extractor/repository size while preserving first occurrence order. */
export function boundedWorkerWarnings(warnings: readonly string[], token?: string): string[] {
  const bounded: string[] = [];
  const seen = new Set<string>();
  let totalBytes = 0;
  for (const warning of warnings) {
    if (bounded.length >= MAX_WORKER_WARNINGS) break;
    const sanitized = truncateUtf8(sanitizeWorkerText(warning, token), MAX_WORKER_WARNING_BYTES);
    if (seen.has(sanitized)) continue;
    const bytes = Buffer.byteLength(sanitized);
    if (totalBytes + bytes > MAX_WORKER_WARNING_BYTES_TOTAL) continue;
    seen.add(sanitized);
    bounded.push(sanitized);
    totalBytes += bytes;
  }
  return bounded;
}

/** Narrow an IPC value before the child lets it reach filesystem or extractor code. */
export function isExtractionWorkerRequest(value: unknown): value is ExtractionWorkerRequestMessage {
  if (!isRecord(value) || value.type !== "extract" || !isRecord(value.request)) return false;
  const request = value.request;
  return typeof request.absoluteRoot === "string"
    && typeof request.cwd === "string"
    && typeof request.materializeBoundary === "boolean"
    && (request.hintedFiles === undefined || isHintedFiles(request.hintedFiles))
    && typeof value.artifactOutputPath === "string"
    && (value.token === undefined || typeof value.token === "string");
}

/** Convert only the CLI's explicitly user-safe error carrier into an IPC response. */
export function extractionWorkerFailure(error: unknown, token?: string): ExtractionWorkerFailure {
  if (!(error instanceof CliError)) return { kind: "internal" };
  return {
    kind: "cli",
    exitCode: error.exitCode,
    message: sanitizeWorkerText(error.message, token),
    details: error.details
      .slice(0, MAX_WORKER_ERROR_DETAILS)
      .map((detail) => sanitizeWorkerText(detail, token)),
  };
}

/** Reconstruct the original safe `CliError` contract in the parent process. */
export function errorFromExtractionWorker(value: ExtractionWorkerFailure, token?: string): CliError {
  if (value.kind === "internal") {
    return new CliError(EXIT.internal, "extraction worker failed");
  }
  return new CliError(
    value.exitCode,
    sanitizeWorkerText(value.message, token),
    value.details
      .slice(0, MAX_WORKER_ERROR_DETAILS)
      .map((detail) => sanitizeWorkerText(detail, token)),
  );
}

/** Validate the trusted-but-fallible child protocol without re-validating the full graph. */
export function isExtractionWorkerResponse(value: unknown): value is ExtractionWorkerResponseMessage {
  if (!isRecord(value)) return false;
  if (value.type === "result") {
    return isExtractionWorkerResult(value.result);
  }
  if (value.type !== "error" || !isRecord(value.error)) return false;
  if (value.error.kind === "internal") return true;
  return value.error.kind === "cli"
    && isExitCode(value.error.exitCode)
    && typeof value.error.message === "string"
    && Array.isArray(value.error.details)
    && value.error.details.every((detail) => typeof detail === "string");
}

function isExtractionWorkerResult(value: unknown): value is ExtractionWorkerResult {
  if (!isRecord(value)
    || value.kind !== "file"
    || typeof value.artifactPath !== "string"
    || !Number.isSafeInteger(value.artifactBytes)
    || (value.artifactBytes as number) <= 0
    || typeof value.artifactSha256 !== "string"
    || !/^[0-9a-f]{64}$/.test(value.artifactSha256)
    || typeof value.projectionDirectory !== "string"
    || !isGraphSummary(value.graphSummary)
    || !isChangedFileManifest(value.changedFiles)
    || !isHintedFiles(value.hintedFiles)
    || (value.changedSinceBaseRef !== undefined && typeof value.changedSinceBaseRef !== "string")
    || (value.vcsCommit !== undefined && typeof value.vcsCommit !== "string")
    || !isWorkerWarnings(value.warnings)) {
    return false;
  }
  return true;
}

function isChangedFileManifest(value: unknown): value is ChangedFileManifestEntry[] {
  if (!Array.isArray(value) || value.length > MAX_WORKER_CHANGED_FILES) return false;
  const paths = new Set<string>();
  let totalBytes = 0;
  for (const entry of value) {
    if (!isChangedFileManifestEntry(entry) || paths.has(entry.path)) return false;
    paths.add(entry.path);
    totalBytes += Buffer.byteLength(entry.path);
    if (entry.previousPath !== undefined) totalBytes += Buffer.byteLength(entry.previousPath);
    if (totalBytes > MAX_WORKER_CHANGED_PATH_BYTES_TOTAL) return false;
  }
  return true;
}

function isHintedFiles(value: unknown): value is string[] {
  if (!Array.isArray(value) || value.length > MAX_WORKER_HINTED_FILES) return false;
  let totalBytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const file = value[index];
    if (!safeManifestPath(file) || (index > 0 && value[index - 1] >= file)) return false;
    totalBytes += Buffer.byteLength(file);
    if (totalBytes > MAX_WORKER_HINTED_PATH_BYTES_TOTAL) return false;
  }
  return true;
}

function isWorkerWarnings(value: unknown): value is string[] {
  if (!Array.isArray(value) || value.length > MAX_WORKER_WARNINGS) return false;
  let totalBytes = 0;
  for (const warning of value) {
    if (typeof warning !== "string" || Buffer.byteLength(warning) > MAX_WORKER_WARNING_BYTES) return false;
    totalBytes += Buffer.byteLength(warning);
    if (totalBytes > MAX_WORKER_WARNING_BYTES_TOTAL) return false;
  }
  return true;
}

function isGraphSummary(value: unknown): value is InspectionGraphSummary {
  return isRecord(value)
    && typeof value.schemaVersion === "string"
    && typeof value.generatedAt === "string"
    && Number.isSafeInteger(value.nodeCount)
    && (value.nodeCount as number) >= 0
    && Number.isSafeInteger(value.edgeCount)
    && (value.edgeCount as number) >= 0;
}

function isChangedFileManifestEntry(value: unknown): value is ChangedFileManifestEntry {
  if (!isRecord(value) || !safeManifestPath(value.path)) return false;
  if (value.status === "renamed") {
    return safeManifestPath(value.previousPath) && value.previousPath !== value.path;
  }
  return (value.status === "added" || value.status === "modified" || value.status === "deleted")
    && value.previousPath === undefined;
}

function safeManifestPath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.startsWith("/")
    || value.includes("\\") || value.includes("\0") || /^[A-Za-z]:/.test(value)
    || Buffer.byteLength(value) > MAX_WORKER_CHANGED_PATH_BYTES) return false;
  return value.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
}

/** Defense in depth: scrub both the raw token and common credential encodings/shapes. */
export function sanitizeWorkerText(value: string, token?: string): string {
  let scrubbed = value
    .replace(/AUTHORIZATION:\s*basic\s+\S+/gi, "AUTHORIZATION: basic ***")
    .replace(/https?:\/\/[^\s/@]+:[^\s/@]+@/gi, (match) => `${match.slice(0, match.indexOf("//") + 2)}***@`)
    .replace(/\b(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]{16,}\b/g, "***");
  if (token) {
    const encoded = Buffer.from(`x-access-token:${token}`, "utf8").toString("base64");
    scrubbed = scrubbed.split(token).join("***").split(encoded).join("***");
  }
  return truncateUtf8(scrubbed, MAX_WORKER_ERROR_TEXT_BYTES);
}

function truncateUtf8(value: string, maxBytes: number): string {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.byteLength <= maxBytes) return value;
  let truncated = encoded.subarray(0, maxBytes).toString("utf8");
  while (Buffer.byteLength(truncated) > maxBytes) truncated = truncated.slice(0, -1);
  return truncated;
}

function isExitCode(value: unknown): value is ExitCode {
  return typeof value === "number" && value !== EXIT.ok && Object.values(EXIT).includes(value as ExitCode);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
