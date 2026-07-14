/**
 * Mapping a node's BASE-graph span to where it sits in the PR HEAD file, from the PR's per-hunk
 * old/new spans. The graph stays the base clone (the instant overlay), but the code panel fetches
 * the head file — so a node located at base lines [s,e] must be sliced from the head at its shifted
 * position. Each hunk before a line shifts it by (newLines − oldLines); a line inside a hunk maps
 * onto the hunk's new side. Pure functions, 1-based inclusive, so they unit-test without a store.
 */

import type { ChangedLineKind, ChangedLineSpan } from "@meridian/core";
import type { LineEdit } from "./prTypes";

/** A base (old-side) line number → its line number in the PR head file, given exact contiguous
 * edit runs. Insertions shift the base line at their cursor; replacements map deleted base rows
 * onto the surviving new run; pure deletions map to their HEAD seam. */
export function mapBaseLineToHead(line: number, edits: readonly LineEdit[]): number {
  let delta = 0;
  for (const edit of edits) {
    if (line < edit.oldStart) {
      break;
    }
    if (edit.oldLines === 0) {
      // `oldStart` is the next base row: an insertion immediately precedes it.
      delta += edit.newLines;
      continue;
    }
    const oldEndExclusive = edit.oldStart + edit.oldLines;
    if (line >= oldEndExclusive) {
      delta += edit.newLines - edit.oldLines;
      continue;
    }
    if (edit.newLines === 0) {
      return Math.max(1, edit.newStart);
    }
    return edit.newStart + Math.min(line - edit.oldStart, edit.newLines - 1);
  }
  return Math.max(1, line + delta);
}

/** The head span of a node whose base span is [baseStart, baseEnd]. */
export function headSpanFor(baseStart: number, baseEnd: number, edits: readonly LineEdit[]): { start: number; end: number } {
  let start = mapBaseLineToHead(baseStart, edits);
  let end = Math.max(start, mapBaseLineToHead(baseEnd, edits));
  // Endpoint mapping alone misses extra new rows in a replacement and insertions immediately before
  // a node's first base row. Expand to every exact new-side run owned by the base span.
  for (const edit of edits) {
    const overlaps = edit.oldLines === 0
      ? edit.oldStart >= baseStart && edit.oldStart <= baseEnd
      : edit.oldStart <= baseEnd && edit.oldStart + edit.oldLines - 1 >= baseStart;
    if (!overlaps || edit.newLines === 0) {
      continue;
    }
    start = Math.min(start, edit.newStart);
    end = Math.max(end, edit.newStart + edit.newLines - 1);
  }
  return { start, end };
}

/** Head-relative change kinds that fall within [start, end], as a per-line map for the code panel. */
export function headKindsWithin(kinds: readonly ChangedLineSpan[], start: number, end: number): Map<number, ChangedLineKind> {
  const map = new Map<number, ChangedLineKind>();
  for (const span of kinds) {
    for (let line = Math.max(span.start, start); line <= Math.min(span.end, end); line += 1) {
      map.set(line, span.kind);
    }
  }
  return map;
}
