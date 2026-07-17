/**
 * Runtime-neutral wire contract shared by the PR preparation producer and renderer.
 *
 * Keep transport shape and bounds here so a value accepted for publication cannot be rejected by
 * the browser for following a different interpretation of protocol v1.
 */

import type { ChangedFileManifestEntry, ChangedFileManifestStatus } from "./changed-detection";

export const PR_PREPARE_PROTOCOL_VERSION = 1 as const;
/** Maximum UTF-8 bytes for one serialized record including its trailing NDJSON newline. */
export const PR_PREPARE_MAX_LINE_BYTES = 2 * 1024 * 1024;
/** A prepared pair combines at most two 64-warning worker results. */
export const PR_PREPARE_MAX_WARNINGS = 128;
export const PR_PREPARE_MAX_WARNING_BYTES = 4_000;
export const PR_PREPARE_MAX_WARNING_BYTES_TOTAL = 128 * 1024;
export const PR_PREPARE_MAX_CHANGED_FILES = 100_000;
export const PR_PREPARE_MAX_CHANGED_PATH_BYTES = 4_096;
export const PR_PREPARE_MAX_CHANGED_PATH_BYTES_TOTAL = 1024 * 1024;

/**
 * Runtime-neutral path order used anywhere a changed-file coordinate becomes persistent identity.
 *
 * UTF-8 preserves Unicode scalar order. Walking scalars avoids allocating encoded byte arrays for
 * every comparison in a potentially 100k-entry sort while matching bytewise UTF-8 ordering for
 * valid paths. Lone surrogate code units are compared as U+FFFD, matching TextEncoder, with a
 * deterministic UTF-16 tie-break so distinct JavaScript strings never compare equal.
 */
export function compareCanonicalPrPreparePaths(left: string, right: string): number {
  let leftOffset = 0;
  let rightOffset = 0;
  while (leftOffset < left.length && rightOffset < right.length) {
    const leftScalar = utf8ScalarAt(left, leftOffset);
    const rightScalar = utf8ScalarAt(right, rightOffset);
    if (leftScalar.value !== rightScalar.value) return leftScalar.value - rightScalar.value;
    leftOffset += leftScalar.width;
    rightOffset += rightScalar.width;
  }
  if (leftOffset !== left.length || rightOffset !== right.length) {
    return leftOffset === left.length ? -1 : 1;
  }
  return left < right ? -1 : left > right ? 1 : 0;
}

export const PR_PREPARE_STAGES = [
  "resolve",
  "git",
  "extract-head",
  "extract-merge-base",
  "publish",
] as const;

export type PrPrepareStage = typeof PR_PREPARE_STAGES[number];
export type PrPrepareTimings = Partial<Record<PrPrepareStage, number>>;

export const PR_PREPARE_V1_FIELDS = {
  progress: ["version", "type", "stage", "elapsedMs"],
  done: [
    "version", "type", "headSha", "baseSha", "mergeBaseSha", "changedFiles",
    "head", "mergeBase", "cache", "timings", "warnings", "handoff",
  ],
  error: ["version", "type", "message"],
  handoffDocument: [
    "version", "request", "headSha", "baseSha", "mergeBaseSha", "changedFiles",
    "head", "mergeBase", "cache", "timings", "warnings",
  ],
  request: ["owner", "repo", "prNumber", "baseRef", "headRef"],
  requestWithSubdir: ["owner", "repo", "subdir", "prNumber", "baseRef", "headRef"],
  descriptor: [
    "graphId", "manifestUrl", "projectionUrl", "searchUrl", "sourceUrl", "metaUrl", "graphSummary",
  ],
  graphSummary: ["schemaVersion", "generatedAt", "nodeCount", "edgeCount"],
  changedFile: ["path", "status"],
  renamedChangedFile: ["path", "status", "previousPath"],
  handoffLink: ["id", "url", "viewUrl"],
} as const satisfies Record<string, readonly string[]>;

const PR_PREPARE_STAGE_SET: ReadonlySet<string> = new Set(PR_PREPARE_STAGES);

export function isPrPrepareStage(value: unknown): value is PrPrepareStage {
  return typeof value === "string" && PR_PREPARE_STAGE_SET.has(value);
}

export function isPrPrepareElapsedMs(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function hasExactPrPrepareFields(
  value: unknown,
  fields: readonly string[],
): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value);
  return actual.length === fields.length
    && fields.every((field) => Object.prototype.hasOwnProperty.call(value, field));
}

/** Normalize only the five named stage timings. Missing stages represent work skipped on a hit. */
export function normalizePrPrepareTimings(value: unknown): PrPrepareTimings | null {
  if (!isRecord(value)) return null;
  const timings: PrPrepareTimings = {};
  for (const [key, elapsedMs] of Object.entries(value)) {
    if (!isPrPrepareStage(key) || !isPrPrepareElapsedMs(elapsedMs)) return null;
    timings[key] = elapsedMs;
  }
  return timings;
}

/** Warning bounds are part of v1 and are identical at publication and consumption boundaries. */
export function normalizePrPrepareWarnings(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > PR_PREPARE_MAX_WARNINGS) return null;
  const warnings: string[] = [];
  let totalBytes = 0;
  for (const warning of value) {
    if (typeof warning !== "string" || warning.includes("\0")) return null;
    const bytes = utf8ByteLength(warning);
    totalBytes += bytes;
    if (bytes > PR_PREPARE_MAX_WARNING_BYTES
      || totalBytes > PR_PREPARE_MAX_WARNING_BYTES_TOTAL) return null;
    warnings.push(warning);
  }
  return warnings;
}

/** Canonical status-rich changed-file manifest shared by publication and browser routing. */
export function normalizePrPrepareChangedFiles(value: unknown): ChangedFileManifestEntry[] | null {
  if (!Array.isArray(value) || value.length > PR_PREPARE_MAX_CHANGED_FILES) return null;
  const files: ChangedFileManifestEntry[] = [];
  const seen = new Set<string>();
  let pathBytes = 0;
  for (const entry of value) {
    if (!isRecord(entry) || !isChangedFileStatus(entry.status)) return null;
    const renamed = entry.status === "renamed";
    if (!hasExactPrPrepareFields(
      entry,
      renamed ? PR_PREPARE_V1_FIELDS.renamedChangedFile : PR_PREPARE_V1_FIELDS.changedFile,
    ) || !isChangedPath(entry.path) || seen.has(entry.path)) return null;
    seen.add(entry.path);
    pathBytes += utf8ByteLength(entry.path);
    if (renamed) {
      if (!isChangedPath(entry.previousPath) || entry.previousPath === entry.path) return null;
      pathBytes += utf8ByteLength(entry.previousPath);
      files.push({ path: entry.path, status: "renamed", previousPath: entry.previousPath });
    } else {
      files.push({ path: entry.path, status: entry.status });
    }
    if (pathBytes > PR_PREPARE_MAX_CHANGED_PATH_BYTES_TOTAL) return null;
  }
  return files;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isChangedFileStatus(value: unknown): value is ChangedFileManifestStatus {
  return value === "added" || value === "modified" || value === "deleted" || value === "renamed";
}

function isChangedPath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.startsWith("/")
    || value.includes("\\") || value.includes("\0") || /^[A-Za-z]:/.test(value)
    || utf8ByteLength(value) > PR_PREPARE_MAX_CHANGED_PATH_BYTES) return false;
  return value.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function utf8ScalarAt(value: string, offset: number): { value: number; width: 1 | 2 } {
  const first = value.charCodeAt(offset);
  if (first >= 0xd800 && first <= 0xdbff && offset + 1 < value.length) {
    const second = value.charCodeAt(offset + 1);
    if (second >= 0xdc00 && second <= 0xdfff) {
      return {
        value: 0x10000 + ((first - 0xd800) << 10) + (second - 0xdc00),
        width: 2,
      };
    }
  }
  if (first >= 0xd800 && first <= 0xdfff) return { value: 0xfffd, width: 1 };
  return { value: first, width: 1 };
}
