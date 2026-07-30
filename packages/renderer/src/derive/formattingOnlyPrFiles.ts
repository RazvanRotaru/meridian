import type { ChangedDiffLine, ChangedLineSpan, LineRange } from "@meridian/core";
import type { LineEdit, PrChangedFile } from "../state/prTypes";

export interface ExactEditRun {
  edit: LineEdit;
  rows: readonly ChangedDiffLine[];
}

export interface ExactPrDiffMetadata {
  hunks: LineRange[];
  oldHunks: LineRange[];
  edits: LineEdit[];
  kinds: ChangedLineSpan[];
  diffLines: ChangedDiffLine[];
  additions: number;
  deletions: number;
  runs: readonly ExactEditRun[];
}

/**
 * Remove only complete edit runs backed by the prepared artifact's formatting proof.
 *
 * The returned files are an effective review projection. Callers retain the unfiltered array for
 * source previews, GitHub comment anchors, and restoring the toggle. Unsupported file operations,
 * incomplete bodies, stale structural metadata, and proof/run mismatches all fail open.
 */
export function filterFormattingOnlyPrFiles(
  files: readonly PrChangedFile[],
  enabled: boolean,
): PrChangedFile[] {
  if (!enabled) {
    return [...files];
  }

  const filtered: PrChangedFile[] = [];
  for (const file of files) {
    const effective = withoutProvenFormattingRuns(file);
    if (effective !== null) {
      filtered.push(effective);
    }
  }
  return filtered;
}

/**
 * Reconstruct the canonical structural metadata from exact ordered +/- rows.
 *
 * With `expectedEdits`, every row must be consumed by those runs exactly. Without it, edit
 * boundaries are inferred conservatively from cursor discontinuities; this is used only at the
 * prepared-artifact boundary where the complete diff still contains every run.
 */
export function exactPrDiffMetadata(
  diffLines: readonly ChangedDiffLine[],
  expectedEdits?: readonly LineEdit[],
): ExactPrDiffMetadata | null {
  const runs = expectedEdits === undefined
    ? inferEditRuns(diffLines)
    : runsForExpectedEdits(diffLines, expectedEdits);
  if (runs === null || runs.length === 0) {
    return null;
  }
  return metadataFromRuns(runs);
}

function withoutProvenFormattingRuns(file: PrChangedFile): PrChangedFile | null {
  const proofs = file.formattingOnlyEdits;
  if (
    file.status !== "modified"
    || file.diffComplete !== true
    || !Array.isArray(proofs)
    || proofs.length === 0
    || !Array.isArray(file.hunks)
    || !Array.isArray(file.oldHunks)
    || !Array.isArray(file.edits)
    || file.edits.length === 0
    || !Array.isArray(file.kinds)
    || !Array.isArray(file.diffLines)
    || file.diffLines.length === 0
  ) {
    return file;
  }

  const complete = exactPrDiffMetadata(file.diffLines, file.edits);
  if (
    complete === null
    || complete.additions !== file.additions
    || complete.deletions !== file.deletions
    || !sameRanges(complete.hunks, file.hunks)
    || !sameRanges(complete.oldHunks, file.oldHunks)
    || !sameEdits(complete.edits, file.edits)
    || !sameKinds(complete.kinds, file.kinds)
  ) {
    return file;
  }

  const runByEdit = new Map(complete.runs.map((run) => [editKey(run.edit), run]));
  const proofKeys = new Set<string>();
  for (const proof of proofs) {
    if (!isLineEdit(proof)) {
      return file;
    }
    const key = editKey(proof);
    if (proofKeys.has(key) || !runByEdit.has(key)) {
      return file;
    }
    proofKeys.add(key);
  }

  const retained = complete.runs.filter((run) => !proofKeys.has(editKey(run.edit)));
  if (retained.length === 0) {
    return null;
  }
  const effective = metadataFromRuns(retained);
  return {
    ...file,
    additions: effective.additions,
    deletions: effective.deletions,
    hunks: effective.hunks,
    oldHunks: effective.oldHunks,
    edits: effective.edits,
    kinds: effective.kinds,
    diffLines: effective.diffLines,
    formattingOnlyEdits: proofs.map(copyEdit),
  };
}

function inferEditRuns(rows: readonly ChangedDiffLine[]): ExactEditRun[] | null {
  const runs: ExactEditRun[] = [];
  let active: MutableEditRun | null = null;
  let lineDelta = 0;

  for (const row of rows) {
    if (!isChangedDiffLine(row)) {
      return null;
    }
    if (active !== null && acceptsRow(active, row)) {
      active.rows.push(row);
      advanceRun(active, row);
      continue;
    }
    if (active !== null) {
      const completed = completeRun(active);
      if (completed === null) {
        return null;
      }
      runs.push(completed);
      lineDelta += completed.edit.newLines - completed.edit.oldLines;
    }
    active = startRun(row, lineDelta);
    if (active === null) {
      return null;
    }
  }

  if (active !== null) {
    const completed = completeRun(active);
    if (completed === null) {
      return null;
    }
    runs.push(completed);
  }
  return orderedDistinctRuns(runs.map((run) => run.edit)) ? runs : null;
}

function runsForExpectedEdits(
  rows: readonly ChangedDiffLine[],
  edits: readonly LineEdit[],
): ExactEditRun[] | null {
  if (edits.length === 0 || !edits.every(isLineEdit) || !orderedDistinctRuns(edits)) {
    return null;
  }

  const runs: ExactEditRun[] = [];
  let rowIndex = 0;
  for (const edit of edits) {
    const active: MutableEditRun = {
      edit: { oldStart: edit.oldStart, oldLines: 0, newStart: edit.newStart, newLines: 0 },
      deleted: 0,
      added: 0,
      rows: [],
    };
    while (active.deleted < edit.oldLines || active.added < edit.newLines) {
      const row = rows[rowIndex];
      if (row === undefined || !isChangedDiffLine(row) || !acceptsExpectedRow(active, edit, row)) {
        return null;
      }
      active.rows.push(row);
      advanceRun(active, row);
      rowIndex += 1;
    }
    const completed = completeRun(active);
    if (completed === null) {
      return null;
    }
    runs.push(completed);
  }
  return rowIndex === rows.length ? runs : null;
}

interface MutableEditRun {
  edit: LineEdit;
  deleted: number;
  added: number;
  rows: ChangedDiffLine[];
}

function startRun(row: ChangedDiffLine, lineDelta: number): MutableEditRun | null {
  if (row.kind === "deleted") {
    const edit = {
      oldStart: row.oldLine!,
      oldLines: 0,
      newStart: row.beforeNewLine,
      newLines: 0,
    };
    if (edit.newStart - edit.oldStart !== lineDelta) {
      return null;
    }
    const run = { edit, deleted: 0, added: 0, rows: [row] };
    advanceRun(run, row);
    return run;
  }

  const oldStart = row.newLine! - lineDelta;
  if (!isPositiveLine(oldStart)) {
    return null;
  }
  const run = {
    edit: { oldStart, oldLines: 0, newStart: row.newLine!, newLines: 0 },
    deleted: 0,
    added: 0,
    rows: [row],
  };
  advanceRun(run, row);
  return run;
}

function acceptsRow(run: MutableEditRun, row: ChangedDiffLine): boolean {
  return row.kind === "deleted"
    ? row.oldLine === run.edit.oldStart + run.deleted
      && row.beforeNewLine === run.edit.newStart + run.added
    : row.newLine === run.edit.newStart + run.added;
}

function acceptsExpectedRow(run: MutableEditRun, expected: LineEdit, row: ChangedDiffLine): boolean {
  if (row.kind === "deleted") {
    return run.deleted < expected.oldLines
      && row.oldLine === run.edit.oldStart + run.deleted
      && row.beforeNewLine === run.edit.newStart + run.added;
  }
  return run.added < expected.newLines
    && row.newLine === run.edit.newStart + run.added;
}

function advanceRun(run: MutableEditRun, row: ChangedDiffLine): void {
  if (row.kind === "deleted") {
    run.deleted += 1;
    run.edit.oldLines = run.deleted;
  } else {
    run.added += 1;
    run.edit.newLines = run.added;
  }
}

function completeRun(run: MutableEditRun): ExactEditRun | null {
  if (
    run.rows.length === 0
    || run.edit.oldLines !== run.deleted
    || run.edit.newLines !== run.added
    || (run.deleted === 0 && run.added === 0)
    || !isLineEdit(run.edit)
  ) {
    return null;
  }
  return { edit: copyEdit(run.edit), rows: [...run.rows] };
}

function metadataFromRuns(runs: readonly ExactEditRun[]): ExactPrDiffMetadata {
  const hunks: LineRange[] = [];
  const oldHunks: LineRange[] = [];
  const edits: LineEdit[] = [];
  const kinds: ChangedLineSpan[] = [];
  const diffLines: ChangedDiffLine[] = [];
  let additions = 0;
  let deletions = 0;

  for (const run of runs) {
    const edit = run.edit;
    edits.push(copyEdit(edit));
    hunks.push(edit.newLines > 0
      ? { start: edit.newStart, end: edit.newStart + edit.newLines - 1 }
      : { start: edit.newStart, end: edit.newStart });
    oldHunks.push(edit.oldLines > 0
      ? { start: edit.oldStart, end: edit.oldStart + edit.oldLines - 1 }
      : { start: edit.oldStart, end: edit.oldStart });

    const modified = Math.min(edit.oldLines, edit.newLines);
    if (modified > 0) {
      kinds.push({
        start: edit.newStart,
        end: edit.newStart + modified - 1,
        kind: "modified",
      });
    }
    if (edit.newLines > modified) {
      kinds.push({
        start: edit.newStart + modified,
        end: edit.newStart + edit.newLines - 1,
        kind: "added",
      });
    }

    additions += edit.newLines;
    deletions += edit.oldLines;
    diffLines.push(...run.rows.map(copyDiffLine));
  }
  return { hunks, oldHunks, edits, kinds, diffLines, additions, deletions, runs };
}

/** Separate parser runs have at least one unchanged row between them on both sides. */
function orderedDistinctRuns(edits: readonly LineEdit[]): boolean {
  for (let index = 1; index < edits.length; index += 1) {
    const previous = edits[index - 1];
    const current = edits[index];
    if (
      current.oldStart <= previous.oldStart + previous.oldLines
      || current.newStart <= previous.newStart + previous.newLines
    ) {
      return false;
    }
  }
  return true;
}

function sameRanges(left: readonly LineRange[], right: readonly LineRange[]): boolean {
  return left.length === right.length
    && left.every((range, index) => range.start === right[index].start && range.end === right[index].end);
}

function sameEdits(left: readonly LineEdit[], right: readonly LineEdit[]): boolean {
  return left.length === right.length
    && left.every((edit, index) => editKey(edit) === editKey(right[index]));
}

function sameKinds(left: readonly ChangedLineSpan[], right: readonly ChangedLineSpan[]): boolean {
  return left.length === right.length
    && left.every((span, index) =>
      span.start === right[index].start
      && span.end === right[index].end
      && span.kind === right[index].kind);
}

function isLineEdit(value: unknown): value is LineEdit {
  const edit = value as Partial<LineEdit> | null;
  return isPositiveLine(edit?.oldStart)
    && isNonNegativeCount(edit?.oldLines)
    && isPositiveLine(edit?.newStart)
    && isNonNegativeCount(edit?.newLines)
    && (edit.oldLines > 0 || edit.newLines > 0)
    && edit.oldStart + edit.oldLines <= Number.MAX_SAFE_INTEGER
    && edit.newStart + edit.newLines <= Number.MAX_SAFE_INTEGER;
}

function isChangedDiffLine(value: unknown): value is ChangedDiffLine {
  const row = value as Partial<ChangedDiffLine> | null;
  if (
    (row?.kind !== "added" && row?.kind !== "deleted")
    || !isPositiveLine(row.beforeNewLine)
    || typeof row.text !== "string"
    || (row.noNewline !== undefined && typeof row.noNewline !== "boolean")
  ) {
    return false;
  }
  return row.kind === "added"
    ? row.oldLine === null
      && isPositiveLine(row.newLine)
      && row.beforeNewLine === row.newLine
    : isPositiveLine(row.oldLine) && row.newLine === null;
}

function isPositiveLine(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function isNonNegativeCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function editKey(edit: LineEdit): string {
  return `${edit.oldStart}:${edit.oldLines}:${edit.newStart}:${edit.newLines}`;
}

function copyEdit(edit: LineEdit): LineEdit {
  return {
    oldStart: edit.oldStart,
    oldLines: edit.oldLines,
    newStart: edit.newStart,
    newLines: edit.newLines,
  };
}

function copyDiffLine(row: ChangedDiffLine): ChangedDiffLine {
  return { ...row };
}
