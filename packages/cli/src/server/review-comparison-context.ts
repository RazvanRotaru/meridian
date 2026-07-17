/**
 * Immutable, bounded comparison metadata shared by the two graph capabilities of one prepared PR.
 *
 * Graph generations remain independently reusable. This sidecar carries only the canonical
 * status-rich file inventory and deterministic page coordinates needed to project one current
 * review view at a time. It never embeds graph nodes, edges, source text, or browser state.
 */

import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  writeFileSync,
} from "node:fs";
import {
  compareCanonicalPrPreparePaths,
  isGraphProjectionReviewCursor,
  normalizePrPrepareChangedFiles,
  type ChangedFileManifestEntry,
  type ChangedFileManifestStatus,
  type GraphProjectionReviewFacts,
  type GraphProjectionReviewFile,
  type GraphProjectionReviewPageFacts,
  type GraphProjectionReviewSelectionFacts,
  type GraphProjectionReviewSide,
  type GraphProjectionReviewStatusCounts,
} from "@meridian/core";

export const REVIEW_COMPARISON_CONTEXT_VERSION = 1 as const;
export const REVIEW_COMPARISON_CONTEXT_FILE = "review-comparison-context.json";
export const MAX_REVIEW_COMPARISON_CONTEXT_BYTES = 8 * 1024 * 1024;
export const REVIEW_CONTEXT_PAGE_MAX_FILES = 64;
export const REVIEW_CONTEXT_PAGE_MAX_PATH_BYTES = 24 * 1024;

const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

export type ReviewComparisonSide = GraphProjectionReviewSide;
export type ReviewStatusCounts = GraphProjectionReviewStatusCounts;

export interface ReviewContextPageIndex {
  readonly start: number;
  readonly end: number;
  readonly pathBytes: number;
  readonly statusCounts: ReviewStatusCounts;
  readonly headPathCount: number;
  readonly mergeBasePathCount: number;
}

export interface ReviewComparisonContext {
  readonly version: typeof REVIEW_COMPARISON_CONTEXT_VERSION;
  readonly headSha: string;
  readonly mergeBaseSha: string;
  readonly analysisKey: string;
  readonly changedFiles: readonly ChangedFileManifestEntry[];
  readonly statusCounts: ReviewStatusCounts;
  readonly pages: readonly ReviewContextPageIndex[];
}

export interface ReviewComparisonContextReference {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
}

export type ReviewContextPageEntry = GraphProjectionReviewFile;
export type ReviewContextPageFacts = GraphProjectionReviewPageFacts;
export type ReviewContextSelectionFacts = GraphProjectionReviewSelectionFacts;
export type ReviewContextFacts = GraphProjectionReviewFacts;

export interface ResolvedReviewContextCursor {
  readonly facts: ReviewContextFacts;
  /** Exact server-owned path for a file coordinate; null for overview/page coordinates or absent sides. */
  readonly graphPath: string | null;
  /** File coordinates suppress the ordinary empty-path changed-set fallback, even on an absent side. */
  readonly fileSelected: boolean;
}

export function writeReviewComparisonContext(
  path: string,
  input: {
    readonly headSha: string;
    readonly mergeBaseSha: string;
    readonly analysisKey: string;
    readonly changedFiles: readonly ChangedFileManifestEntry[];
  },
): ReviewComparisonContextReference {
  const context = canonicalReviewComparisonContext(input);
  const serialized = `${JSON.stringify(context)}\n`;
  const bytes = Buffer.byteLength(serialized);
  if (bytes > MAX_REVIEW_COMPARISON_CONTEXT_BYTES) {
    throw new RangeError("review comparison context exceeds its bounded metadata limit");
  }
  writeFileSync(path, serialized, { encoding: "utf8", flag: "wx", mode: 0o600 });
  return {
    path,
    bytes,
    sha256: createHash("sha256").update(serialized).digest("hex"),
  };
}

export function readReviewComparisonContext(
  reference: ReviewComparisonContextReference,
): ReviewComparisonContext | null {
  if (!SHA256.test(reference.sha256)
    || !Number.isSafeInteger(reference.bytes)
    || reference.bytes <= 0
    || reference.bytes > MAX_REVIEW_COMPARISON_CONTEXT_BYTES) return null;
  let descriptor: number | undefined;
  try {
    const visible = lstatSync(reference.path, { bigint: true });
    if (!visible.isFile() || visible.isSymbolicLink() || Number(visible.size) !== reference.bytes) return null;
    if (typeof constants.O_NOFOLLOW !== "number") return null;
    descriptor = openSync(reference.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(descriptor, { bigint: true });
    if (!sameFileIdentity(visible, opened)) return null;
    const bytes = Buffer.allocUnsafe(reference.bytes);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const read = readSync(descriptor, bytes, offset, bytes.byteLength - offset, offset);
      if (read <= 0) return null;
      offset += read;
    }
    const after = fstatSync(descriptor, { bigint: true });
    const visibleAfter = lstatSync(reference.path, { bigint: true });
    if (!sameFileIdentity(opened, after) || !sameFileIdentity(opened, visibleAfter)) return null;
    if (createHash("sha256").update(bytes).digest("hex") !== reference.sha256) return null;
    const serialized = bytes.toString("utf8");
    const parsed = JSON.parse(serialized) as unknown;
    const context = normalizeReviewComparisonContext(parsed);
    if (context === null || serialized !== `${JSON.stringify(context)}\n`) return null;
    return context;
  } catch {
    return null;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function effectiveReviewProjectionContentId(
  graphContentId: string,
  contextSha256: string,
  side: ReviewComparisonSide,
): string {
  if (!SHA256.test(graphContentId) || !SHA256.test(contextSha256)) {
    throw new TypeError("review projection content identities must be SHA-256 digests");
  }
  return createHash("sha256")
    .update(`review-projection-v${REVIEW_COMPARISON_CONTEXT_VERSION}\0${graphContentId}\0${contextSha256}\0${side}`)
    .digest("hex");
}

export function resolveReviewContextCursor(
  context: ReviewComparisonContext,
  contextId: string,
  side: ReviewComparisonSide,
  cursor: string | null,
): ResolvedReviewContextCursor {
  if (!SHA256.test(contextId)) throw new TypeError("review comparison context id must be a SHA-256 digest");
  if (cursor === null) return pageCursor(context, contextId, side, 0);
  if (!isGraphProjectionReviewCursor(cursor)) throw new RangeError("review cursor is invalid");
  const separator = cursor.indexOf(":");
  const kind = cursor.slice(0, separator);
  const index = Number(cursor.slice(separator + 1));
  if (!Number.isSafeInteger(index)) throw new RangeError("review cursor is invalid");
  if (kind === "page") return pageCursor(context, contextId, side, index);
  if (index >= context.changedFiles.length) throw new RangeError("review file cursor is outside its context");
  const entry = context.changedFiles[index]!;
  const graphPath = graphPathForSide(entry, side);
  const indexed = indexedEntry(entry, index);
  return {
    graphPath,
    fileSelected: true,
    facts: {
      contextId,
      side,
      totalFiles: context.changedFiles.length,
      statusCounts: context.statusCounts,
      pageCount: context.pages.length,
      page: null,
      selection: { index, entry: indexed, graphPath, graphMatched: false },
    },
  };
}

export function reviewFileCursor(index: number): string {
  if (!Number.isSafeInteger(index) || index < 0 || index > 99_999) {
    throw new RangeError("review file index is outside its cursor range");
  }
  return `file:${index}`;
}

export function reviewPageCursor(index: number): string {
  if (!Number.isSafeInteger(index) || index < 0 || index > 99_999) {
    throw new RangeError("review page index is outside its cursor range");
  }
  return `page:${index}`;
}

function canonicalReviewComparisonContext(input: {
  readonly headSha: string;
  readonly mergeBaseSha: string;
  readonly analysisKey: string;
  readonly changedFiles: readonly ChangedFileManifestEntry[];
}): ReviewComparisonContext {
  const changedFiles = normalizePrPrepareChangedFiles(input.changedFiles);
  if (!changedFiles) throw new TypeError("review comparison context changed files are invalid");
  changedFiles.sort((left, right) => compareCanonicalPrPreparePaths(left.path, right.path));
  if (!COMMIT.test(input.headSha) || !COMMIT.test(input.mergeBaseSha)) {
    throw new TypeError("review comparison context revisions are invalid");
  }
  if (!input.analysisKey || input.analysisKey.includes("\0") || Buffer.byteLength(input.analysisKey) > 4_096) {
    throw new TypeError("review comparison context analysis key is invalid");
  }
  return {
    version: REVIEW_COMPARISON_CONTEXT_VERSION,
    headSha: input.headSha.toLowerCase(),
    mergeBaseSha: input.mergeBaseSha.toLowerCase(),
    analysisKey: input.analysisKey,
    changedFiles,
    statusCounts: statusCounts(changedFiles),
    pages: pageIndex(changedFiles),
  };
}

function normalizeReviewComparisonContext(value: unknown): ReviewComparisonContext | null {
  if (!record(value)
    || exactKeys(value, [
      "version", "headSha", "mergeBaseSha", "analysisKey", "changedFiles", "statusCounts", "pages",
    ]) === false
    || value.version !== REVIEW_COMPARISON_CONTEXT_VERSION
    || typeof value.headSha !== "string"
    || typeof value.mergeBaseSha !== "string"
    || typeof value.analysisKey !== "string") return null;
  try {
    const canonical = canonicalReviewComparisonContext({
      headSha: value.headSha,
      mergeBaseSha: value.mergeBaseSha,
      analysisKey: value.analysisKey,
      changedFiles: value.changedFiles as ChangedFileManifestEntry[],
    });
    return JSON.stringify(canonical) === JSON.stringify(value) ? canonical : null;
  } catch {
    return null;
  }
}

function pageIndex(files: readonly ChangedFileManifestEntry[]): ReviewContextPageIndex[] {
  const pages: ReviewContextPageIndex[] = [];
  let start = 0;
  let pathBytes = 0;
  for (let index = 0; index < files.length; index += 1) {
    const entryBytes = changedEntryPathBytes(files[index]!);
    if (index > start
      && (index - start >= REVIEW_CONTEXT_PAGE_MAX_FILES
        || pathBytes + entryBytes > REVIEW_CONTEXT_PAGE_MAX_PATH_BYTES)) {
      pages.push(pageRecord(files, start, index, pathBytes));
      start = index;
      pathBytes = 0;
    }
    pathBytes += entryBytes;
  }
  if (start < files.length) pages.push(pageRecord(files, start, files.length, pathBytes));
  return pages;
}

function pageRecord(
  files: readonly ChangedFileManifestEntry[],
  start: number,
  end: number,
  pathBytes: number,
): ReviewContextPageIndex {
  const page = files.slice(start, end);
  return {
    start,
    end,
    pathBytes,
    statusCounts: statusCounts(page),
    headPathCount: page.reduce((count, entry) => count + Number(graphPathForSide(entry, "head") !== null), 0),
    mergeBasePathCount: page.reduce(
      (count, entry) => count + Number(graphPathForSide(entry, "mergeBase") !== null),
      0,
    ),
  };
}

function pageCursor(
  context: ReviewComparisonContext,
  contextId: string,
  side: ReviewComparisonSide,
  pageIndex: number,
): ResolvedReviewContextCursor {
  if (context.pages.length === 0 && pageIndex === 0) {
    return {
      graphPath: null,
      fileSelected: false,
      facts: {
        contextId,
        side,
        totalFiles: 0,
        statusCounts: context.statusCounts,
        pageCount: 0,
        page: null,
        selection: null,
      },
    };
  }
  if (pageIndex >= context.pages.length) throw new RangeError("review page cursor is outside its context");
  const page = context.pages[pageIndex]!;
  return {
    graphPath: null,
    fileSelected: false,
    facts: {
      contextId,
      side,
      totalFiles: context.changedFiles.length,
      statusCounts: context.statusCounts,
      pageCount: context.pages.length,
      page: {
        index: pageIndex,
        entries: context.changedFiles.slice(page.start, page.end)
          .map((entry, offset) => indexedEntry(entry, page.start + offset)),
        statusCounts: page.statusCounts,
        previousCursor: pageIndex === 0 ? null : reviewPageCursor(pageIndex - 1),
        nextCursor: pageIndex + 1 >= context.pages.length ? null : reviewPageCursor(pageIndex + 1),
      },
      selection: null,
    },
  };
}

function graphPathForSide(
  entry: ChangedFileManifestEntry,
  side: ReviewComparisonSide,
): string | null {
  if (side === "head") return entry.status === "deleted" ? null : entry.path;
  if (entry.status === "added") return null;
  return entry.status === "renamed" ? entry.previousPath! : entry.path;
}

function indexedEntry(entry: ChangedFileManifestEntry, index: number): ReviewContextPageEntry {
  return entry.status === "renamed"
    ? { index, path: entry.path, status: entry.status, previousPath: entry.previousPath }
    : { index, path: entry.path, status: entry.status };
}

function statusCounts(files: readonly ChangedFileManifestEntry[]): ReviewStatusCounts {
  const counts: Record<ChangedFileManifestStatus, number> = {
    added: 0,
    modified: 0,
    deleted: 0,
    renamed: 0,
  };
  for (const file of files) counts[file.status] += 1;
  return counts;
}

function changedEntryPathBytes(entry: ChangedFileManifestEntry): number {
  return Buffer.byteLength(entry.path)
    + (entry.status === "renamed" ? Buffer.byteLength(entry.previousPath!) : 0);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  return actual.length === canonical.length && actual.every((key, index) => key === canonical[index]);
}

function sameFileIdentity(left: import("node:fs").BigIntStats, right: import("node:fs").BigIntStats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}
