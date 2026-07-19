import {
  isTestPath,
  type GraphProjectionReviewOverviewEntryState,
} from "@meridian/core";
import type { LoadedReviewProjection } from "../graph/graphProjectionClient";
import type { PreparedChangedFile } from "./prPreparation";

export interface PreparedReviewOverviewSideCoverage {
  readonly state: GraphProjectionReviewOverviewEntryState;
  readonly isTest: boolean | null;
}

/** One current bounded page of comparison metadata. Paths remain owned by the handoff manifest. */
export interface PreparedReviewOverviewCoverage {
  readonly contextId: string;
  readonly pageIndex: number;
  readonly entries: readonly {
    readonly index: number;
    readonly head: PreparedReviewOverviewSideCoverage;
    readonly mergeBase: PreparedReviewOverviewSideCoverage;
    /** HEAD truth wins; merge-base is the fallback when HEAD has no indexed graph path. */
    readonly isTest: boolean;
  }[];
}

/**
 * Complete graph-backed test truth for one immutable comparison manifest. This intentionally keeps
 * only stable manifest indexes and booleans: no graph path, node, index, source, or layout can leak
 * out of the current projection through this catalog.
 */
export interface PreparedReviewTestClassifications {
  readonly contextId: string;
  readonly entries: readonly {
    readonly index: number;
    readonly isTest: boolean;
  }[];
}

/** Read the one graph-free catalog shared by every coordinate in this immutable comparison. */
export function preparedReviewTestClassifications(
  projection: LoadedReviewProjection,
  changedFiles: readonly PreparedChangedFile[],
  cursor: string | null,
): PreparedReviewTestClassifications {
  assertPreparedReviewProjectionFacts(projection, changedFiles, cursor);
  const head = projection.head.review!;
  const metadata = projection.reviewMetadata;
  if (metadata.contextId !== head.contextId
    || metadata.metadataId !== head.metadataId
    || metadata.totalFiles !== changedFiles.length) {
    throw new Error("prepared review test classifications do not match their projection metadata");
  }
  for (const entry of metadata.testClassifications) {
    if (changedFiles[entry.index] === undefined) {
      throw new Error("prepared review test classification is outside its handoff manifest");
    }
  }
  return {
    contextId: head.contextId,
    entries: metadata.testClassifications,
  };
}

/**
 * Join the graph-free classification catalog back to the handoff paths. Path heuristics remain the
 * fallback for added/deleted/unmapped files which have no graph-backed verdict on either side.
 */
export function preparedReviewTestVerdicts(
  classifications: PreparedReviewTestClassifications | null,
  changedFiles: readonly PreparedChangedFile[],
): ReadonlyMap<string, boolean> {
  const verdicts = new Map<string, boolean>();
  for (const entry of classifications?.entries ?? []) {
    const file = changedFiles[entry.index];
    if (file === undefined) continue;
    verdicts.set(file.path, entry.isTest);
    if (file.status === "renamed" && file.previousPath !== undefined) {
      verdicts.set(file.previousPath, entry.isTest);
    }
  }
  return verdicts;
}

/** Bind every bounded page/selection fact back to its canonical prepared handoff manifest. */
export function assertPreparedReviewProjectionFacts(
  projection: LoadedReviewProjection,
  changedFiles: readonly PreparedChangedFile[],
  cursor: string | null,
): void {
  const head = projection.head.review;
  const mergeBase = projection.mergeBase.review;
  if (head === null || mergeBase === null
    || head.side !== "head" || mergeBase.side !== "mergeBase"
    || head.contextId !== mergeBase.contextId) {
    throw new Error("prepared review projection is missing its paired comparison context");
  }
  if (head.metadataId !== mergeBase.metadataId
    || projection.reviewMetadata.metadataId !== head.metadataId
    || projection.reviewMetadata.contextId !== head.contextId) {
    throw new Error("prepared review projection metadata identity is inconsistent");
  }
  for (const facts of [head, mergeBase]) {
    if (facts.totalFiles !== changedFiles.length) {
      throw new Error("prepared review projection file total does not match its handoff manifest");
    }
    const counts = { added: 0, modified: 0, deleted: 0, renamed: 0 };
    for (const file of changedFiles) counts[file.status] += 1;
    if (facts.statusCounts.added !== counts.added
      || facts.statusCounts.modified !== counts.modified
      || facts.statusCounts.deleted !== counts.deleted
      || facts.statusCounts.renamed !== counts.renamed) {
      throw new Error("prepared review projection status rollup does not match its handoff manifest");
    }
    for (const entry of facts.page?.entries ?? []) {
      if (!samePreparedReviewEntry(entry, changedFiles[entry.index])) {
        throw new Error("prepared review projection page does not match its handoff manifest index");
      }
    }
    if (facts.selection !== null
      && !samePreparedReviewEntry(facts.selection.entry, changedFiles[facts.selection.index])) {
      throw new Error("prepared review projection selection does not match its handoff manifest index");
    }
  }
  if ((head.page === null) !== (mergeBase.page === null)
    || head.page?.index !== mergeBase.page?.index
    || (head.overview === null) !== (mergeBase.overview === null)) {
    throw new Error("prepared review projection sides disagree on their bounded coordinate");
  }
  if (cursor?.startsWith("file:") === true) {
    const index = Number(cursor.slice("file:".length));
    if (!samePreparedReviewEntry(head.selection?.entry, changedFiles[index])
      || !samePreparedReviewEntry(mergeBase.selection?.entry, changedFiles[index])) {
      throw new Error("prepared review projection selected the wrong handoff file");
    }
  }
}

/**
 * Retain only the canonical facts for the current bounded overview page. Decoded nodes and paths
 * stay in their existing owners; exact-file coordinates deliberately return null.
 */
export function preparedReviewOverviewCoverage(
  projection: LoadedReviewProjection,
  changedFiles: readonly PreparedChangedFile[],
  cursor: string | null,
): PreparedReviewOverviewCoverage | null {
  assertPreparedReviewProjectionFacts(projection, changedFiles, cursor);
  const head = projection.head.review!;
  const mergeBase = projection.mergeBase.review!;
  if (head.overview === null || mergeBase.overview === null) return null;
  if (head.overview.entries.length !== mergeBase.overview.entries.length) {
    throw new Error("prepared review projection sides disagree on overview coverage");
  }
  const entries = head.overview.entries.map((headEntry, offset) => {
    const mergeBaseEntry = mergeBase.overview!.entries[offset]!;
    if (headEntry.index !== mergeBaseEntry.index) {
      throw new Error("prepared review projection sides disagree on overview coverage order");
    }
    const file = changedFiles[headEntry.index];
    if (file === undefined) {
      throw new Error("prepared review projection overview index is outside its handoff manifest");
    }
    return {
      index: headEntry.index,
      head: { state: headEntry.state, isTest: headEntry.isTest },
      mergeBase: { state: mergeBaseEntry.state, isTest: mergeBaseEntry.isTest },
      isTest: reviewFileTestVerdict(file.path, headEntry.isTest, mergeBaseEntry.isTest),
    };
  });
  return {
    contextId: head.contextId,
    pageIndex: head.page?.index ?? 0,
    entries,
  };
}

function reviewFileTestVerdict(
  path: string,
  head: boolean | null,
  mergeBase: boolean | null,
): boolean {
  if (isTestPath(path)) return true;
  if (head !== null) return head;
  if (mergeBase !== null) return mergeBase;
  return false;
}

function samePreparedReviewEntry(
  actual: { path: string; status: string; previousPath?: string } | undefined,
  expected: PreparedChangedFile | undefined,
): boolean {
  return actual !== undefined
    && expected !== undefined
    && actual.path === expected.path
    && actual.status === expected.status
    && actual.previousPath === expected.previousPath;
}
