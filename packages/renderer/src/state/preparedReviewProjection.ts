import type { LoadedReviewProjection } from "../graph/graphProjectionClient";
import type { PreparedChangedFile } from "./prPreparation";

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
  if (cursor?.startsWith("file:") === true) {
    const index = Number(cursor.slice("file:".length));
    if (!samePreparedReviewEntry(head.selection?.entry, changedFiles[index])
      || !samePreparedReviewEntry(mergeBase.selection?.entry, changedFiles[index])) {
      throw new Error("prepared review projection selected the wrong handoff file");
    }
  }
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
