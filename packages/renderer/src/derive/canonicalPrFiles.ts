/**
 * Complete the bounded GitHub PR-file response from the prepared artifact's exact local Git
 * transaction. GitHub detail remains useful for commentable U3 ranges and discussion metadata,
 * but the manifest is authoritative for which files changed; it includes entries beyond the API
 * cap as well as binary, mode-only, renamed, and fully deleted paths.
 */

import {
  changedDiffLinesFromExtensions,
  changedFileManifestFromExtensions,
  changedLineKindsFromExtensions,
  changedLineStatsFromExtensions,
  changedRangesFromExtensions,
  formattingOnlyEditsFromExtensions,
} from "@meridian/core";
import type {
  ChangedDiffLine,
  FormattingOnlyEdit,
  FormattingOnlyRow,
  GraphArtifact,
  LineRange,
} from "@meridian/core";
import type { PrChangedFile, PrFileStatus } from "../state/prTypes";
import {
  exactPrDiffMetadata,
  type ExactPrDiffMetadata,
} from "./formattingOnlyPrFiles";

/**
 * Return `githubFiles` unchanged when paired with an older/malformed artifact. Once a valid
 * manifest exists, return exactly its paths in Git order and join any available GitHub detail onto
 * them. This all-or-nothing boundary prevents a capped response from silently defining review
 * completeness.
 */
export function canonicalPrFiles(
  githubFiles: readonly PrChangedFile[],
  artifact: Pick<GraphArtifact, "extensions">,
): PrChangedFile[] {
  const manifest = changedFileManifestFromExtensions(artifact.extensions);
  if (manifest === null) {
    return [...githubFiles];
  }

  const rawByPath = new Map(githubFiles.map((file) => [file.path, file]));
  const ranges = changedRangesFromExtensions(artifact.extensions);
  const stats = changedLineStatsFromExtensions(artifact.extensions);
  const kinds = changedLineKindsFromExtensions(artifact.extensions);
  const diffLines = changedDiffLinesFromExtensions(artifact.extensions);
  const exactByPath = new Map<string, ExactPrDiffMetadata | null>();
  for (const entry of manifest) {
    const rows = ownValue(diffLines, entry.path);
    exactByPath.set(entry.path, rows === undefined ? null : exactPrDiffMetadata(rows));
  }
  const formattingOnlyEdits = verifiedFormattingOnlyEdits(
    formattingOnlyEditsFromExtensions(artifact.extensions),
    exactByPath,
    stats,
    ranges,
    kinds,
  );

  return manifest.map((entry) => {
    // Git paths are opaque byte-derived identities. In particular, `a\\b.ts` and `a/b.ts` are
    // distinct files on GitHub; normalization belongs only in the separate graph-join layer.
    const path = entry.path;
    const raw = rawByPath.get(path);
    const rows = ownValue(diffLines, path);
    const delta = ownValue(stats, path);
    const fileRanges = ownValue(ranges, path);
    const fileKinds = ownValue(kinds, path);
    const exact = exactByPath.get(path) ?? null;
    const exactBody = canonicalBodyIsExact(exact, delta, fileRanges, fileKinds, ranges, kinds);
    const formattingProof = ownValue(formattingOnlyEdits, path);
    const file: PrChangedFile = {
      ...(raw ?? {}),
      path,
      status: prStatus(entry.status),
      additions: delta?.added ?? (rows ? countRows(rows, "added") : raw?.additions ?? 0),
      deletions: delta?.deleted ?? (rows ? countRows(rows, "deleted") : raw?.deletions ?? 0),
    };

    if (entry.status === "renamed") {
      file.previousPath = entry.previousPath!;
    } else {
      delete file.previousPath;
    }
    if (exact !== null) {
      file.hunks = exact.hunks;
      file.oldHunks = exact.oldHunks;
      file.edits = exact.edits;
      file.kinds = exact.kinds;
      file.diffLines = entry.nonTextualChanges === true
        ? exact.diffLines.map(withoutSourceCommentFacts)
        : mergeSourceCommentFacts(exact.diffLines, raw?.diffLines);
    } else {
      if (fileRanges !== undefined) file.hunks = fileRanges.map(copyRange);
      if (fileKinds !== undefined) file.kinds = fileKinds.map((span) => ({ ...span }));
    }
    if (rows !== undefined && exact === null) {
      file.diffLines = entry.nonTextualChanges === true
        ? rows.map(withoutSourceCommentFacts)
        : mergeSourceCommentFacts(rows, raw?.diffLines);
      file.oldHunks = deletedRanges(rows);
    }
    if (formattingProof !== undefined) {
      file.formattingOnlyEdits = formattingProof.map((edit) => ({
        oldStart: edit.oldStart,
        oldLines: edit.oldLines,
        newStart: edit.newStart,
        newLines: edit.newLines,
      }));
    } else {
      delete file.formattingOnlyEdits;
    }
    if (exactBody) {
      file.diffComplete = true;
    } else {
      // The manifest still proves the file transaction, but without exact local rows and totals a
      // GitHub body (even when present) must not silently become the prepared review's authority.
      // This covers binary/mode-only/empty changes, pure renames, and incomplete API patches.
      file.diffComplete = false;
    }
    return file;
  });
}

function withoutSourceCommentFacts(row: ChangedDiffLine): ChangedDiffLine {
  const {
    sourceCommentOnly: _sourceCommentOnly,
    sourceCommentLineOnly: _sourceCommentLineOnly,
    ...plain
  } = row;
  return plain;
}

/**
 * Prepared local diffs are intentionally U0, while GitHub supplies U3 lexical context. Preserve a
 * GitHub proof only when every canonical row agrees exactly; local coordinates/text remain the
 * authority and any capped, stale, or otherwise divergent patch fails open.
 */
function mergeSourceCommentFacts(
  canonical: readonly ChangedDiffLine[],
  github: readonly ChangedDiffLine[] | undefined,
): ChangedDiffLine[] {
  const copied = canonical.map((row) => ({ ...row }));
  if (
    github === undefined
    || github.length !== copied.length
    || !github.every((row, index) => sameDiffRow(row, copied[index]))
  ) {
    return copied;
  }
  github.forEach((row, index) => {
    if (row.sourceCommentOnly === true) copied[index].sourceCommentOnly = true;
    if (row.sourceCommentLineOnly === true) copied[index].sourceCommentLineOnly = true;
  });
  return copied;
}

function sameDiffRow(left: ChangedDiffLine, right: ChangedDiffLine): boolean {
  return left.kind === right.kind
    && left.oldLine === right.oldLine
    && left.newLine === right.newLine
    && left.beforeNewLine === right.beforeNewLine
    && left.text === right.text
    && left.noNewline === right.noNewline;
}

function prStatus(status: "added" | "modified" | "deleted" | "renamed"): PrFileStatus {
  return status === "deleted" ? "removed" : status;
}

function countRows(rows: readonly ChangedDiffLine[], kind: ChangedDiffLine["kind"]): number {
  return rows.filter((row) => row.kind === kind).length;
}

function deletedRanges(rows: readonly ChangedDiffLine[]): LineRange[] {
  const lines = [...new Set(rows
    .filter((row): row is ChangedDiffLine & { oldLine: number } => row.kind === "deleted" && row.oldLine !== null)
    .map((row) => row.oldLine))].sort((left, right) => left - right);
  const ranges: LineRange[] = [];
  for (const line of lines) {
    const last = ranges.at(-1);
    if (last && line === last.end + 1) last.end = line;
    else ranges.push({ start: line, end: line });
  }
  return ranges;
}

function copyRange(range: LineRange): LineRange {
  return { start: range.start, end: range.end };
}

function sameRanges(left: readonly LineRange[], right: readonly LineRange[]): boolean {
  return left.length === right.length
    && left.every((range, index) => range.start === right[index].start && range.end === right[index].end);
}

function sameKinds(
  left: readonly { start: number; end: number; kind: string }[],
  right: readonly { start: number; end: number; kind: string }[],
): boolean {
  return left.length === right.length
    && left.every((span, index) =>
      span.start === right[index].start
      && span.end === right[index].end
      && span.kind === right[index].kind);
}

function verifiedFormattingOnlyEdits(
  proof: Readonly<Record<string, readonly FormattingOnlyEdit[]>> | null,
  exactByPath: ReadonlyMap<string, ExactPrDiffMetadata | null>,
  stats: ReturnType<typeof changedLineStatsFromExtensions>,
  ranges: ReturnType<typeof changedRangesFromExtensions>,
  kinds: ReturnType<typeof changedLineKindsFromExtensions>,
): Readonly<Record<string, readonly FormattingOnlyEdit[]>> | null {
  if (proof === null) {
    return null;
  }
  for (const [path, edits] of Object.entries(proof)) {
    const exact = exactByPath.get(path) ?? null;
    if (!canonicalBodyIsExact(
      exact,
      ownValue(stats, path),
      ownValue(ranges, path),
      ownValue(kinds, path),
      ranges,
      kinds,
    )) {
      return null;
    }
    const runs = new Map(exact.runs.map((run) => [editKey(run.edit), run]));
    for (const edit of edits) {
      const run = edit.path === path ? runs.get(editKey(edit)) : undefined;
      if (
        run === undefined
        || !sameBoundRows(edit.oldRows, run.rows, "deleted")
        || !sameBoundRows(edit.newRows, run.rows, "added")
      ) {
        return null;
      }
    }
  }
  return proof;
}

function canonicalBodyIsExact(
  exact: ExactPrDiffMetadata | null,
  delta: { added: number; deleted: number } | undefined,
  fileRanges: readonly LineRange[] | undefined,
  fileKinds: readonly { start: number; end: number; kind: string }[] | undefined,
  ranges: ReturnType<typeof changedRangesFromExtensions>,
  kinds: ReturnType<typeof changedLineKindsFromExtensions>,
): exact is ExactPrDiffMetadata {
  return exact !== null && delta !== undefined
    && exact.additions === delta.added
    && exact.deletions === delta.deleted
    && (ranges === null || (fileRanges !== undefined && sameRanges(exact.hunks, fileRanges)))
    && (kinds === null || (
      fileKinds === undefined ? exact.kinds.length === 0 : sameKinds(exact.kinds, fileKinds)
    ));
}

function sameBoundRows(
  expected: readonly FormattingOnlyRow[],
  rows: readonly ChangedDiffLine[],
  kind: ChangedDiffLine["kind"],
): boolean {
  const matching = rows.filter((row) => row.kind === kind);
  return expected.length === matching.length
    && expected.every((row, index) =>
      row.text === matching[index].text
      && row.noNewline === (matching[index].noNewline === true));
}

function editKey(edit: Pick<FormattingOnlyEdit, "oldStart" | "oldLines" | "newStart" | "newLines">): string {
  return `${edit.oldStart}:${edit.oldLines}:${edit.newStart}:${edit.newLines}`;
}

function ownValue<T>(record: Readonly<Record<string, T>> | null, path: string): T | undefined {
  return record !== null && Object.hasOwn(record, path) ? record[path] : undefined;
}
