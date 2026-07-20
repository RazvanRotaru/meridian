import {
  compareCanonicalPrPreparePaths,
  normalizePrPrepareChangedFiles,
  type ChangedFileManifestEntry,
  type GraphArtifact,
  type GraphProjectionReviewFacts,
  type GraphProjectionReviewFile,
  type GraphProjectionReviewSide,
  type GraphProjectionReviewStatusCounts,
} from "@meridian/core";
import type { GraphProjectionRequest } from "../graph/graphProjectionClient";

const TEST_CONTEXT_ID = "c".repeat(64);
const PAGE_MAX_FILES = 64;
const PAGE_MAX_PATH_BYTES = 24 * 1024;

/**
 * Strict comparison facts for renderer data-source fixtures.
 *
 * These fixtures deliberately follow the real v6 page/file contract: canonical manifest order,
 * byte-bounded pages, side-specific rename/deletion routing, and graphMatched derived from the
 * actual projected artifact. Tests cannot accidentally keep exercising the removed path-replay
 * shape while pretending to represent a prepared comparison capability.
 */
export function reviewProjectionFactsForTest(
  value: unknown,
  request: GraphProjectionRequest,
  side: GraphProjectionReviewSide,
  artifact: GraphArtifact,
): GraphProjectionReviewFacts {
  const normalized = normalizePrPrepareChangedFiles(value);
  if (normalized === null) throw new Error("invalid changed-file fixture");
  const files = normalized.sort((left, right) => compareCanonicalPrPreparePaths(left.path, right.path));
  const pages = reviewPages(files);
  const statusCounts = countStatuses(files);
  const common = {
    contextId: TEST_CONTEXT_ID,
    side,
    totalFiles: files.length,
    statusCounts,
    pageCount: pages.length,
  } as const;
  const cursor = request.reviewCursor;
  if (cursor === null || cursor.startsWith("page:")) {
    const pageIndex = cursor === null ? 0 : Number(cursor.slice("page:".length));
    if (pages.length === 0 && pageIndex === 0) {
      return { ...common, page: null, selection: null };
    }
    const page = pages[pageIndex];
    if (page === undefined) throw new Error("review page fixture cursor is outside its manifest");
    return {
      ...common,
      page: {
        index: pageIndex,
        entries: files.slice(page.start, page.end).map((entry, offset) => indexed(entry, page.start + offset)),
        statusCounts: page.statusCounts,
        previousCursor: pageIndex === 0 ? null : `page:${pageIndex - 1}`,
        nextCursor: pageIndex + 1 === pages.length ? null : `page:${pageIndex + 1}`,
      },
      selection: null,
    };
  }
  if (!cursor.startsWith("file:")) throw new Error("invalid review fixture cursor");
  const index = Number(cursor.slice("file:".length));
  const entry = files[index];
  if (entry === undefined) throw new Error("review file fixture cursor is outside its manifest");
  const graphPath = graphPathForSide(entry, side);
  const graphMatched = graphPath !== null && artifact.nodes.some((node) => (
    node.location?.file.replace(/\\/g, "/") === graphPath
  ));
  return {
    ...common,
    page: null,
    selection: { index, entry: indexed(entry, index), graphPath, graphMatched },
  };
}

/** Extract the canonical changed-since manifest carried by a prepared fixture artifact. */
export function preparedArtifactReviewFilesForTest(
  artifact: GraphArtifact,
  explicitFallback?: unknown,
): ChangedFileManifestEntry[] {
  const changedSince = artifact.extensions?.changedSince;
  const manifest = typeof changedSince === "object" && changedSince !== null && !Array.isArray(changedSince)
    ? (changedSince as { manifest?: unknown }).manifest
    : undefined;
  const normalized = normalizePrPrepareChangedFiles(manifest)
    ?? normalizePrPrepareChangedFiles(explicitFallback);
  if (normalized === null) throw new Error("prepared fixture artifact is missing its canonical changedSince manifest");
  return normalized.sort((left, right) => compareCanonicalPrPreparePaths(left.path, right.path));
}

interface TestPage {
  start: number;
  end: number;
  statusCounts: GraphProjectionReviewStatusCounts;
}

function reviewPages(files: readonly ChangedFileManifestEntry[]): TestPage[] {
  const pages: TestPage[] = [];
  let start = 0;
  let pathBytes = 0;
  for (let index = 0; index < files.length; index += 1) {
    const entryBytes = filePathBytes(files[index]!);
    if (index > start && (index - start >= PAGE_MAX_FILES || pathBytes + entryBytes > PAGE_MAX_PATH_BYTES)) {
      pages.push({ start, end: index, statusCounts: countStatuses(files.slice(start, index)) });
      start = index;
      pathBytes = 0;
    }
    pathBytes += entryBytes;
  }
  if (start < files.length) {
    pages.push({ start, end: files.length, statusCounts: countStatuses(files.slice(start)) });
  }
  return pages;
}

function indexed(entry: ChangedFileManifestEntry, index: number): GraphProjectionReviewFile {
  return entry.status === "renamed"
    ? { index, path: entry.path, status: entry.status, previousPath: renamedPreviousPath(entry) }
    : { index, path: entry.path, status: entry.status };
}

function graphPathForSide(entry: ChangedFileManifestEntry, side: GraphProjectionReviewSide): string | null {
  if (side === "head") return entry.status === "deleted" ? null : entry.path;
  if (entry.status === "added") return null;
  return entry.status === "renamed" ? renamedPreviousPath(entry) : entry.path;
}

function renamedPreviousPath(entry: ChangedFileManifestEntry): string {
  if (typeof entry.previousPath !== "string") throw new Error("renamed review fixture is missing previousPath");
  return entry.previousPath;
}

function countStatuses(files: readonly ChangedFileManifestEntry[]): GraphProjectionReviewStatusCounts {
  const counts: Record<ChangedFileManifestEntry["status"], number> = {
    added: 0,
    modified: 0,
    deleted: 0,
    renamed: 0,
  };
  for (const file of files) counts[file.status] += 1;
  return counts;
}

function filePathBytes(file: ChangedFileManifestEntry): number {
  const encoder = new TextEncoder();
  return encoder.encode(file.path).byteLength
    + (file.status === "renamed" ? encoder.encode(renamedPreviousPath(file)).byteLength : 0);
}
