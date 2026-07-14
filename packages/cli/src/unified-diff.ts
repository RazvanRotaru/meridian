import type { ChangedDiffLine, ChangedLineSpan, LineRange } from "@meridian/core";
import { classifyChangedLineRun } from "./changed-line-kinds";

/**
 * One contiguous edit run in next-row cursor coordinates. For an empty side, `oldStart`/
 * `newStart` is the 1-based line immediately after that empty range (never the header's preceding
 * line coordinate). This makes base→HEAD mapping unambiguous at file start and deletion seams.
 */
export interface UnifiedDiffEdit {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
}

/** Canonical, body-derived representation shared by local git and GitHub patches. */
export interface ParsedUnifiedDiffBody {
  /** Tight HEAD-side additions, plus a one-line graph seam for a pure deletion. */
  ranges: LineRange[];
  /** Tight base-side deletions, plus a one-line graph seam for a pure insertion. */
  oldRanges: LineRange[];
  /** One entry per contiguous +/- edit run, never a context-padded hunk header. */
  edits: UnifiedDiffEdit[];
  /** Paintable rows that still exist in HEAD. Pure deletions deliberately emit no kind span. */
  kinds: ChangedLineSpan[];
  /** Exact +/- rows in patch order, with both base and HEAD coordinates. */
  diffLines: ChangedDiffLine[];
  added: number;
  deleted: number;
  /** False when a hunk body does not consume exactly the line counts declared by its header. */
  complete: boolean;
}

interface ActiveHunk {
  oldLines: number;
  newLines: number;
  oldCursor: number;
  newCursor: number;
  oldConsumed: number;
  newConsumed: number;
}

interface ActiveRun {
  oldCursor: number;
  newCursor: number;
  addedLines: number[];
  deletedLines: number[];
}

/**
 * Parse the body of one file's unified diff.
 *
 * Hunk headers are used only to seed/validate coordinates. Every renderable row, tight range,
 * line kind and edit mapping is derived from the +/- body, preventing U3 context from being
 * mistaken for changed code and keeping local `git diff -U0` and GitHub patches identical.
 */
export function parseUnifiedDiffBody(patch: string): ParsedUnifiedDiffBody {
  const ranges: LineRange[] = [];
  const oldRanges: LineRange[] = [];
  const edits: UnifiedDiffEdit[] = [];
  const kinds: ChangedLineSpan[] = [];
  const diffLines: ChangedDiffLine[] = [];
  let added = 0;
  let deleted = 0;
  let complete = true;
  let sawHunk = false;
  let hunk: ActiveHunk | null = null;
  let run: ActiveRun | null = null;
  let lastChangedRow: ChangedDiffLine | null = null;
  let markerCanAttach = false;

  const flushRun = () => {
    if (run === null) {
      return;
    }
    const addedLines = run.addedLines;
    const deletedLines = run.deletedLines;
    if (addedLines.length > 0) {
      ranges.push({ start: addedLines[0], end: addedLines[addedLines.length - 1] });
    } else if (deletedLines.length > 0) {
      const seam = Math.max(1, run.newCursor);
      ranges.push({ start: seam, end: seam });
    }
    if (deletedLines.length > 0) {
      oldRanges.push({ start: deletedLines[0], end: deletedLines[deletedLines.length - 1] });
    } else if (addedLines.length > 0) {
      // The base graph has no inserted rows. Anchor their impact to the next base line instead.
      const seam = Math.max(1, run.oldCursor);
      oldRanges.push({ start: seam, end: seam });
    }

    kinds.push(...classifyChangedLineRun(addedLines, deletedLines.length));

    edits.push({
      oldStart: deletedLines[0] ?? Math.max(1, run.oldCursor),
      oldLines: deletedLines.length,
      newStart: addedLines[0] ?? Math.max(1, run.newCursor),
      newLines: addedLines.length,
    });
    run = null;
  };

  const finishHunk = () => {
    flushRun();
    if (hunk !== null && (hunk.oldConsumed !== hunk.oldLines || hunk.newConsumed !== hunk.newLines)) {
      complete = false;
    }
    hunk = null;
  };

  const lines = patch.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    if (raw.startsWith("@@")) {
      finishHunk();
      lastChangedRow = null;
      markerCanAttach = false;
      sawHunk = true;
      const parsed = parseHunkHeader(raw);
      if (parsed === null) {
        complete = false;
        continue;
      }
      hunk = {
        oldLines: parsed.oldLines,
        newLines: parsed.newLines,
        // In an empty unified range, the header coordinate names the preceding line. The body
        // cursor is therefore one line later (`-0,0` / `+0,0` correctly start at line 1).
        oldCursor: parsed.oldStart + (parsed.oldLines === 0 ? 1 : 0),
        newCursor: parsed.newStart + (parsed.newLines === 0 ? 1 : 0),
        oldConsumed: 0,
        newConsumed: 0,
      };
      continue;
    }
    if (hunk === null) {
      continue;
    }
    if (raw.startsWith("\\")) {
      if (raw === "\\ No newline at end of file" && markerCanAttach && lastChangedRow !== null) {
        lastChangedRow.noNewline = true;
      }
      markerCanAttach = false;
      continue;
    }
    const marker = raw[0];
    if (marker === "+") {
      run ??= { oldCursor: hunk.oldCursor, newCursor: hunk.newCursor, addedLines: [], deletedLines: [] };
      const line = hunk.newCursor;
      run.addedLines.push(line);
      const row: ChangedDiffLine = { kind: "added", oldLine: null, newLine: line, beforeNewLine: line, text: raw.slice(1) };
      diffLines.push(row);
      lastChangedRow = row;
      markerCanAttach = true;
      hunk.newCursor += 1;
      hunk.newConsumed += 1;
      added += 1;
    } else if (marker === "-") {
      run ??= { oldCursor: hunk.oldCursor, newCursor: hunk.newCursor, addedLines: [], deletedLines: [] };
      const line = hunk.oldCursor;
      run.deletedLines.push(line);
      const row: ChangedDiffLine = {
        kind: "deleted",
        oldLine: line,
        newLine: null,
        beforeNewLine: Math.max(1, hunk.newCursor),
        text: raw.slice(1),
      };
      diffLines.push(row);
      lastChangedRow = row;
      markerCanAttach = true;
      hunk.oldCursor += 1;
      hunk.oldConsumed += 1;
      deleted += 1;
    } else if (marker === " ") {
      flushRun();
      lastChangedRow = null;
      markerCanAttach = false;
      hunk.oldCursor += 1;
      hunk.newCursor += 1;
      hunk.oldConsumed += 1;
      hunk.newConsumed += 1;
    } else if (!(raw === "" && index === lines.length - 1)) {
      // Unified body rows always carry a marker. A non-final bare line means the patch was cut or
      // malformed; retain any rows already parsed but prevent consumers from trusting completeness.
      complete = false;
      lastChangedRow = null;
      markerCanAttach = false;
    }
    if (hunk.oldConsumed > hunk.oldLines || hunk.newConsumed > hunk.newLines) {
      complete = false;
    }
  }
  finishHunk();
  if (patch.trim().length > 0 && !sawHunk) {
    complete = false;
  }
  return { ranges, oldRanges, edits, kinds, diffLines, added, deleted, complete };
}

interface HunkHeader {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
}

function parseHunkHeader(line: string): HunkHeader | null {
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
  if (!match) {
    return null;
  }
  const parsed = {
    oldStart: Number(match[1]),
    oldLines: match[2] === undefined ? 1 : Number(match[2]),
    newStart: Number(match[3]),
    newLines: match[4] === undefined ? 1 : Number(match[4]),
  };
  if (
    !Object.values(parsed).every(Number.isSafeInteger)
    || parsed.oldStart < 0
    || parsed.newStart < 0
    || parsed.oldLines < 0
    || parsed.newLines < 0
    || (parsed.oldLines > 0 && parsed.oldStart === 0)
    || (parsed.newLines > 0 && parsed.newStart === 0)
  ) {
    return null;
  }
  return parsed;
}
