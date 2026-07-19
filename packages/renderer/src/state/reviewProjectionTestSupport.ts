import {
  collectTestIds,
  compareCanonicalPrPreparePaths,
  normalizePrPrepareChangedFiles,
  type ChangedFileManifestEntry,
  type GraphArtifact,
  type GraphProjectionReviewFacts,
  type GraphProjectionReviewFile,
  type GraphProjectionReviewMetadata,
  type GraphProjectionReviewSide,
  type GraphProjectionReviewStatusCounts,
} from "@meridian/core";
import type { GraphProjectionRequest } from "../graph/graphProjectionClient";

export const TEST_REVIEW_CONTEXT_ID = "c".repeat(64);
export const TEST_REVIEW_METADATA_ID = "d".repeat(64);
const PAGE_MAX_FILES = 64;
const PAGE_MAX_PATH_BYTES = 24 * 1024;

/**
 * Strict comparison facts for renderer data-source fixtures.
 *
 * These fixtures deliberately follow the real v9 page/file contract: canonical manifest order,
 * byte-bounded pages, side-specific rename/deletion routing, exact overview coverage, and
 * graphMatched derived from the actual projected artifact. Tests cannot accidentally keep
 * exercising a removed transport shape while pretending to represent a prepared comparison.
 */
export function reviewProjectionFactsForTest(
  value: unknown,
  request: GraphProjectionRequest,
  side: GraphProjectionReviewSide,
  artifact: GraphArtifact,
  /** Complete immutable graph used for full-manifest classification when `artifact` is a slice. */
  classificationArtifact: GraphArtifact = artifact,
): GraphProjectionReviewFacts {
  const normalized = normalizePrPrepareChangedFiles(value);
  if (normalized === null) throw new Error("invalid changed-file fixture");
  const files = normalized.sort((left, right) => compareCanonicalPrPreparePaths(left.path, right.path));
  const pages = reviewPages(files);
  const statusCounts = countStatuses(files);
  const testIds = collectTestIds([...classificationArtifact.nodes]);
  const testClassifications = files.flatMap((entry, index) => {
    const representative = reviewRepresentative(entry, side, classificationArtifact);
    return representative === undefined
      ? []
      : [{ index, isTest: testIds.has(representative.id) }];
  });
  const testClassificationByIndex = new Map(
    testClassifications.map((classification) => [classification.index, classification.isTest] as const),
  );
  const common = {
    contextId: TEST_REVIEW_CONTEXT_ID,
    metadataId: TEST_REVIEW_METADATA_ID,
    side,
    totalFiles: files.length,
    statusCounts,
    pageCount: pages.length,
  } as const;
  const cursor = request.reviewCursor;
  if (cursor === null || cursor.startsWith("page:")) {
    const pageIndex = cursor === null ? 0 : Number(cursor.slice("page:".length));
    if (pages.length === 0 && pageIndex === 0) {
      return { ...common, page: null, selection: null, overview: { entries: [] } };
    }
    const page = pages[pageIndex];
    if (page === undefined) throw new Error("review page fixture cursor is outside its manifest");
    const entries = files.slice(page.start, page.end).map((entry, offset) => indexed(entry, page.start + offset));
    return {
      ...common,
      page: {
        index: pageIndex,
        entries,
        statusCounts: page.statusCounts,
        previousCursor: pageIndex === 0 ? null : `page:${pageIndex - 1}`,
        nextCursor: pageIndex + 1 === pages.length ? null : `page:${pageIndex + 1}`,
      },
      selection: null,
      overview: {
        entries: entries.map((entry) => {
          const graphPath = graphPathForSide(entry, side);
          const isTest = testClassificationByIndex.get(entry.index);
          const included = reviewRepresentative(entry, side, artifact) !== undefined;
          return {
            index: entry.index,
            state: graphPath === null
              ? "absent" as const
              : isTest === undefined
                ? "unmapped" as const
                : included
                  ? "included" as const
                  : isTest && !request.includeTests
                    ? "filtered" as const
                    : "deferred" as const,
            isTest: isTest ?? null,
          };
        }),
      },
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
    selection: {
      index,
      entry: indexed(entry, index),
      graphPath,
      graphMatched,
      isTest: testClassificationByIndex.get(index) ?? null,
    },
    overview: null,
  };
}

/** Whole-manifest comparison metadata for strict renderer fixtures. */
export function reviewProjectionMetadataForTest(
  value: unknown,
  headGraphId: string,
  mergeBaseGraphId: string,
  headArtifact: GraphArtifact,
  mergeBaseArtifact: GraphArtifact = headArtifact,
): GraphProjectionReviewMetadata {
  const normalized = normalizePrPrepareChangedFiles(value);
  if (normalized === null) throw new Error("invalid changed-file fixture");
  const files = normalized.sort((left, right) => compareCanonicalPrPreparePaths(left.path, right.path));
  const byIndex = new Map<number, boolean>();
  for (const [side, artifact] of [
    ["mergeBase", mergeBaseArtifact],
    ["head", headArtifact],
  ] as const) {
    const testIds = collectTestIds([...artifact.nodes]);
    for (let index = 0; index < files.length; index += 1) {
      const representative = reviewRepresentative(files[index]!, side, artifact);
      if (representative !== undefined) byIndex.set(index, testIds.has(representative.id));
    }
  }
  return {
    version: 1,
    metadataId: TEST_REVIEW_METADATA_ID,
    contextId: TEST_REVIEW_CONTEXT_ID,
    headGraphId,
    mergeBaseGraphId,
    headContentId: "a".repeat(64),
    mergeBaseContentId: "b".repeat(64),
    totalFiles: files.length,
    testClassifications: [...byIndex]
      .sort(([left], [right]) => left - right)
      .map(([index, isTest]) => ({ index, isTest })),
  };
}

function reviewRepresentative(
  entry: ChangedFileManifestEntry,
  side: GraphProjectionReviewSide,
  artifact: GraphArtifact,
): GraphArtifact["nodes"][number] | undefined {
  const graphPath = graphPathForSide(entry, side);
  if (graphPath === null) return undefined;
  return artifact.nodes
    .filter((node) => node.location?.file.replace(/\\/g, "/") === graphPath)
    .sort((left, right) => (
      Number(right.kind === "module") - Number(left.kind === "module")
      || left.id.localeCompare(right.id)
    ))[0];
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
