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
  graphProjectionReviewMetadataIdentityPreimage,
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
  type GraphProjectionReviewMetadata,
  type GraphProjectionReviewTestClassification,
} from "@meridian/core";

export const REVIEW_COMPARISON_CONTEXT_VERSION = 2 as const;
/**
 * Version of the effective projection bytes derived from one immutable comparison context.
 *
 * This is intentionally independent from the sidecar format version: changing which bounded graph
 * slice a cursor resolves to must invalidate projection identities even when the persisted context
 * schema itself is unchanged.
 */
export const REVIEW_PROJECTION_CONTENT_VERSION = 5 as const;
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
  readonly headContentId: string;
  readonly mergeBaseContentId: string;
  readonly analysisKey: string;
  readonly changedFiles: readonly ChangedFileManifestEntry[];
  /** Whole-manifest graph truth with HEAD precedence and merge-base fallback. */
  readonly testClassifications: readonly GraphProjectionReviewTestClassification[];
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

export interface ResolvedReviewOverviewRoute {
  readonly index: number;
  readonly graphPath: string | null;
}

export interface ResolvedReviewContextCursor {
  readonly facts: ReviewContextFacts;
  /** Exact server-owned path for a file coordinate; null for overview/page coordinates or absent sides. */
  readonly graphPath: string | null;
  /** Canonical current path which owns changed-since metadata. Unlike graphPath, this remains
   * present for a deleted HEAD file and is independent of rename routing on the comparison side. */
  readonly changedPath: string | null;
  /**
   * Deterministic, context-owned graph paths disclosed by this coordinate. File coordinates contain
   * at most one path; page coordinates contain only the already bounded manifest-page window.
   */
  readonly graphPaths: readonly string[];
  /** Canonical current paths whose changed-since facts belong to this bounded coordinate. */
  readonly changedPaths: readonly string[];
  /** Null for exact file coordinates; otherwise the exact bounded page membership to project. */
  readonly overviewRoutes: readonly ResolvedReviewOverviewRoute[] | null;
}

export function writeReviewComparisonContext(
  path: string,
  input: {
    readonly headSha: string;
    readonly mergeBaseSha: string;
    readonly headContentId: string;
    readonly mergeBaseContentId: string;
    readonly analysisKey: string;
    readonly changedFiles: readonly ChangedFileManifestEntry[];
    readonly testClassifications: readonly GraphProjectionReviewTestClassification[];
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
    .update(`review-projection-v${REVIEW_PROJECTION_CONTENT_VERSION}\0${graphContentId}\0${contextSha256}\0${side}`)
    .digest("hex");
}

/** Build the one immutable renderer metadata document shared by all review coordinates. */
export function reviewMetadataForContext(
  context: ReviewComparisonContext,
  contextId: string,
  headGraphId: string,
  mergeBaseGraphId: string,
): GraphProjectionReviewMetadata {
  if (!SHA256.test(contextId) || !headGraphId || !mergeBaseGraphId
    || headGraphId.includes("\0") || mergeBaseGraphId.includes("\0")) {
    throw new TypeError("review metadata capability identity is invalid");
  }
  const identity = {
    contextId,
    headGraphId,
    mergeBaseGraphId,
    headContentId: effectiveReviewProjectionContentId(context.headContentId, contextId, "head"),
    mergeBaseContentId: effectiveReviewProjectionContentId(
      context.mergeBaseContentId,
      contextId,
      "mergeBase",
    ),
  };
  return {
    version: 1,
    metadataId: createHash("sha256")
      .update(graphProjectionReviewMetadataIdentityPreimage(identity))
      .digest("hex"),
    ...identity,
    totalFiles: context.changedFiles.length,
    testClassifications: context.testClassifications,
  };
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
  const graphPath = reviewGraphPathForSide(entry, side);
  const indexed = indexedEntry(entry, index);
  return {
    graphPath,
    changedPath: entry.path,
    graphPaths: graphPath === null ? [] : [graphPath],
    changedPaths: [entry.path],
    overviewRoutes: null,
    facts: {
      contextId,
      // The graph capability replaces this sidecar identity with the graph-bound metadata digest.
      metadataId: contextId,
      side,
      totalFiles: context.changedFiles.length,
      statusCounts: context.statusCounts,
      pageCount: context.pages.length,
      page: null,
      selection: { index, entry: indexed, graphPath, graphMatched: false, isTest: null },
      overview: null,
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
  readonly headContentId: string;
  readonly mergeBaseContentId: string;
  readonly analysisKey: string;
  readonly changedFiles: readonly ChangedFileManifestEntry[];
  readonly testClassifications: readonly GraphProjectionReviewTestClassification[];
}): ReviewComparisonContext {
  const changedFiles = normalizePrPrepareChangedFiles(input.changedFiles);
  if (!changedFiles) throw new TypeError("review comparison context changed files are invalid");
  // Classification indexes refer to the caller's normalized manifest order. Bind each verdict to
  // its path before canonical sorting so semantically identical inputs cannot silently reassign a
  // verdict to a different file.
  const inputClassifications = canonicalTestClassifications(
    input.testClassifications,
    changedFiles.length,
  );
  const classificationByPath = new Map(inputClassifications.map((classification) => [
    changedFiles[classification.index]!.path,
    classification.isTest,
  ] as const));
  changedFiles.sort((left, right) => compareCanonicalPrPreparePaths(left.path, right.path));
  if (!COMMIT.test(input.headSha) || !COMMIT.test(input.mergeBaseSha)) {
    throw new TypeError("review comparison context revisions are invalid");
  }
  if (!SHA256.test(input.headContentId) || !SHA256.test(input.mergeBaseContentId)) {
    throw new TypeError("review comparison context graph content identities are invalid");
  }
  if (!input.analysisKey || input.analysisKey.includes("\0") || Buffer.byteLength(input.analysisKey) > 4_096) {
    throw new TypeError("review comparison context analysis key is invalid");
  }
  const testClassifications = changedFiles.flatMap((file, index) => {
    const isTest = classificationByPath.get(file.path);
    return isTest === undefined ? [] : [{ index, isTest }];
  });
  return {
    version: REVIEW_COMPARISON_CONTEXT_VERSION,
    headSha: input.headSha.toLowerCase(),
    mergeBaseSha: input.mergeBaseSha.toLowerCase(),
    headContentId: input.headContentId,
    mergeBaseContentId: input.mergeBaseContentId,
    analysisKey: input.analysisKey,
    changedFiles,
    testClassifications,
    statusCounts: statusCounts(changedFiles),
    pages: pageIndex(changedFiles),
  };
}

function normalizeReviewComparisonContext(value: unknown): ReviewComparisonContext | null {
  if (!record(value)
    || exactKeys(value, [
      "version", "headSha", "mergeBaseSha", "headContentId", "mergeBaseContentId", "analysisKey",
      "changedFiles", "testClassifications", "statusCounts", "pages",
    ]) === false
    || value.version !== REVIEW_COMPARISON_CONTEXT_VERSION
    || typeof value.headSha !== "string"
    || typeof value.mergeBaseSha !== "string"
    || typeof value.headContentId !== "string"
    || typeof value.mergeBaseContentId !== "string"
    || typeof value.analysisKey !== "string") return null;
  try {
    const canonical = canonicalReviewComparisonContext({
      headSha: value.headSha,
      mergeBaseSha: value.mergeBaseSha,
      headContentId: value.headContentId,
      mergeBaseContentId: value.mergeBaseContentId,
      analysisKey: value.analysisKey,
      changedFiles: value.changedFiles as ChangedFileManifestEntry[],
      testClassifications: value.testClassifications as GraphProjectionReviewTestClassification[],
    });
    return JSON.stringify(canonical) === JSON.stringify(value) ? canonical : null;
  } catch {
    return null;
  }
}

function canonicalTestClassifications(
  value: readonly GraphProjectionReviewTestClassification[],
  totalFiles: number,
): GraphProjectionReviewTestClassification[] {
  if (!Array.isArray(value)) {
    throw new TypeError("review comparison test classifications are invalid");
  }
  const classifications: GraphProjectionReviewTestClassification[] = [];
  let previous = -1;
  for (const entry of value) {
    if (!record(entry)
      || !exactKeys(entry, ["index", "isTest"])
      || !Number.isSafeInteger(entry.index)
      || Number(entry.index) <= previous
      || Number(entry.index) >= totalFiles
      || typeof entry.isTest !== "boolean") {
      throw new TypeError("review comparison test classifications are invalid");
    }
    previous = Number(entry.index);
    classifications.push({ index: previous, isTest: entry.isTest });
  }
  return classifications;
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
    headPathCount: page.reduce((count, entry) => count + Number(reviewGraphPathForSide(entry, "head") !== null), 0),
    mergeBasePathCount: page.reduce(
      (count, entry) => count + Number(reviewGraphPathForSide(entry, "mergeBase") !== null),
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
      changedPath: null,
      graphPaths: [],
      changedPaths: [],
      overviewRoutes: [],
      facts: {
        contextId,
        metadataId: contextId,
        side,
        totalFiles: 0,
        statusCounts: context.statusCounts,
        pageCount: 0,
        page: null,
        selection: null,
        overview: { entries: [] },
      },
    };
  }
  if (pageIndex >= context.pages.length) throw new RangeError("review page cursor is outside its context");
  const page = context.pages[pageIndex]!;
  const entries = context.changedFiles.slice(page.start, page.end);
  const overviewRoutes = entries.map((entry, offset) => ({
    index: page.start + offset,
    graphPath: reviewGraphPathForSide(entry, side),
  }));
  return {
    graphPath: null,
    changedPath: null,
    graphPaths: canonicalOverviewGraphPaths(entries, side),
    changedPaths: [],
    overviewRoutes,
    facts: {
      contextId,
      metadataId: contextId,
      side,
      totalFiles: context.changedFiles.length,
      statusCounts: context.statusCounts,
      pageCount: context.pages.length,
      page: {
        index: pageIndex,
        entries: entries.map((entry, offset) => indexedEntry(entry, page.start + offset)),
        statusCounts: page.statusCounts,
        previousCursor: pageIndex === 0 ? null : reviewPageCursor(pageIndex - 1),
        nextCursor: pageIndex + 1 >= context.pages.length ? null : reviewPageCursor(pageIndex + 1),
      },
      selection: null,
      // The bundle replaces each conservative placeholder after it checks its immutable overview
      // index and performs transactional response-budget admission.
      overview: {
        entries: overviewRoutes.map((route) => ({
          index: route.index,
          state: route.graphPath === null ? "absent" as const : "deferred" as const,
          // The comparison sidecar does not own graph classification. The bundle replaces this
          // conservative placeholder from its immutable hierarchy facts before publication.
          isTest: null,
        })),
      },
    },
  };
}

function canonicalOverviewGraphPaths(
  entries: readonly ChangedFileManifestEntry[],
  side: ReviewComparisonSide,
): string[] {
  const paths = new Set<string>();
  for (const entry of entries) {
    const path = reviewGraphPathForSide(entry, side);
    if (path !== null) paths.add(path);
  }
  return [...paths].sort(compareCanonicalPrPreparePaths);
}

export function reviewGraphPathForSide(
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
