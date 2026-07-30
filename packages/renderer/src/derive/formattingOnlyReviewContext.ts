import {
  changedDiffLinesFromExtensions,
  changedLineKindsFromExtensions,
  formattingOnlyEditsFromExtensions,
} from "@meridian/core";
import type {
  ChangedDiffLines,
  ChangedFile,
  ChangedLineKinds,
  GraphArtifact,
  ReviewContext,
} from "@meridian/core";
import { canonicalPrFiles } from "./canonicalPrFiles";
import { filterFormattingOnlyPrFiles } from "./formattingOnlyPrFiles";
import type { PrChangedFile } from "../state/prTypes";

/**
 * Apply prepared-artifact formatting proof to the artifact-carried review context.
 *
 * The proof lives beside the exact changedSince diff, not inside the public review contract. This
 * adapter keeps review identity/warnings intact while projecting only the proven semantic hunks.
 * Missing, stale, unsupported, or mismatched metadata leaves the original file visible.
 */
export function filterFormattingOnlyReviewContext(
  context: ReviewContext,
  artifact: Pick<GraphArtifact, "extensions">,
  enabled: boolean,
): ReviewContext {
  if (!enabled) {
    return context;
  }

  const canonical = canonicalPrFiles([], artifact);
  const rawByPath = new Map(canonical.map((file) => [file.path, file]));
  const effectiveByPath = new Map(
    filterFormattingOnlyPrFiles(canonical, true).map((file) => [file.path, file]),
  );
  let changed = false;
  const changedFiles: ChangedFile[] = [];

  for (const file of context.changedFiles) {
    const raw = rawByPath.get(file.path);
    if (
      raw === undefined
      || !sameStatus(file, raw)
      || !sameHunks(file.hunks, raw.hunks)
      || !raw.formattingOnlyEdits
      || raw.formattingOnlyEdits.length === 0
    ) {
      changedFiles.push(file);
      continue;
    }

    const effective = effectiveByPath.get(file.path);
    if (effective === undefined) {
      changed = true;
      continue;
    }
    if (effective === raw) {
      changedFiles.push(file);
      continue;
    }

    changed = true;
    const projected: ChangedFile = {
      path: file.path,
      status: file.status,
      ...(file.previousPath === undefined ? {} : { previousPath: file.previousPath }),
      ...(effective.hunks && effective.hunks.length > 0
        ? { hunks: effective.hunks.map(copyRange) }
        : {}),
    };
    changedFiles.push(projected);
  }

  return changed ? { ...context, changedFiles } : context;
}

/** Exact changed-line sources aligned with the effective artifact review projection. */
export function formattingAwareArtifactDiff(
  artifact: Pick<GraphArtifact, "extensions">,
  enabled: boolean,
): { kinds: ChangedLineKinds | null; diffLines: ChangedDiffLines | null } {
  const rawKinds = changedLineKindsFromExtensions(artifact.extensions);
  const rawDiffLines = changedDiffLinesFromExtensions(artifact.extensions);
  if (!enabled) {
    return { kinds: rawKinds, diffLines: rawDiffLines };
  }

  const proof = formattingOnlyEditsFromExtensions(artifact.extensions);
  if (proof === null || !Object.values(proof).some((edits) => edits.length > 0)) {
    return { kinds: rawKinds, diffLines: rawDiffLines };
  }
  const canonical = canonicalPrFiles([], artifact);
  // The strict reader can accept a well-formed but stale transaction; canonicalPrFiles binds it to
  // exact rows and drops every attachment on any mismatch.
  if (!canonical.some((file) => (file.formattingOnlyEdits?.length ?? 0) > 0)) {
    return { kinds: rawKinds, diffLines: rawDiffLines };
  }

  const kinds = Object.create(null) as ChangedLineKinds;
  const diffLines = Object.create(null) as ChangedDiffLines;
  for (const file of filterFormattingOnlyPrFiles(canonical, true)) {
    if (file.kinds && file.kinds.length > 0) {
      setOwn(kinds, file.path, file.kinds.map((span) => ({ ...span })));
    }
    if (file.diffLines && file.diffLines.length > 0) {
      setOwn(diffLines, file.path, file.diffLines.map((row) => ({ ...row })));
    }
  }
  return { kinds, diffLines };
}

function sameStatus(file: ChangedFile, proof: PrChangedFile): boolean {
  return file.status === (proof.status === "removed" ? "deleted" : proof.status);
}

function sameHunks(
  review: readonly { start: number; end: number }[] | undefined,
  proof: readonly { start: number; end: number }[] | undefined,
): boolean {
  if (review === undefined || proof === undefined) {
    return review === undefined && proof === undefined;
  }
  return review.length === proof.length
    && review.every((range, index) =>
      range.start === proof[index].start && range.end === proof[index].end);
}

function copyRange(range: { start: number; end: number }): { start: number; end: number } {
  return { start: range.start, end: range.end };
}

function setOwn<T>(record: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(record, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}
