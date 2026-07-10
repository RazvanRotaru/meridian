/**
 * Mapping a node's BASE-graph span to where it sits in the PR HEAD file, from the PR's per-hunk
 * old/new spans. The graph stays the base clone (the instant overlay), but the code panel fetches
 * the head file — so a node located at base lines [s,e] must be sliced from the head at its shifted
 * position. Each hunk before a line shifts it by (newLines − oldLines); a line inside a hunk maps
 * onto the hunk's new side. Pure functions, 1-based inclusive, so they unit-test without a store.
 */

import type { ChangedLineKind, ChangedLineSpan } from "@meridian/core";
import type { LineEdit } from "./prTypes";

/** A base (old-side) line number → its line number in the PR head file, given the hunk spans. */
export function mapBaseLineToHead(line: number, edits: readonly LineEdit[]): number {
  let delta = 0;
  for (const edit of edits) {
    const oldEnd = edit.oldStart + Math.max(edit.oldLines, 1) - 1;
    if (oldEnd < line) {
      delta += edit.newLines - edit.oldLines; // hunk lies fully before the line — accumulate its shift
    } else if (edit.oldStart <= line) {
      // Inside the hunk: map onto the new side, clamped so a shrunk hunk can't overshoot its range.
      const maxNew = edit.newStart + Math.max(edit.newLines - 1, 0);
      return Math.min(edit.newStart + (line - edit.oldStart), maxNew);
    } else {
      break; // edits are in file order; this hunk (and the rest) are past the line
    }
  }
  return line + delta;
}

/** The head span of a node whose base span is [baseStart, baseEnd]. */
export function headSpanFor(baseStart: number, baseEnd: number, edits: readonly LineEdit[]): { start: number; end: number } {
  const start = mapBaseLineToHead(baseStart, edits);
  const end = Math.max(start, mapBaseLineToHead(baseEnd, edits));
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
