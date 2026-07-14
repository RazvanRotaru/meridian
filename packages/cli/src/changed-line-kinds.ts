import type { ChangedLineSpan } from "@meridian/core";

/**
 * Classify one contiguous replacement run in HEAD coordinates. Deletions pair with additions in
 * order and any remaining additions are genuinely new. Excess deletions have no surviving HEAD
 * row to paint; their one-line graph seam is represented by `ranges`, not by a fabricated kind.
 */
export function classifyChangedLineRun(
  addedLines: readonly number[],
  deletedCount: number,
): ChangedLineSpan[] {
  const spans: ChangedLineSpan[] = [];
  const modifiedCount = Math.min(addedLines.length, deletedCount);
  appendSpan(spans, addedLines.slice(0, modifiedCount), "modified");
  appendSpan(spans, addedLines.slice(modifiedCount), "added");
  return spans;
}

function appendSpan(
  target: ChangedLineSpan[],
  lines: readonly number[],
  kind: ChangedLineSpan["kind"],
): void {
  if (lines.length > 0) {
    target.push({ start: lines[0], end: lines[lines.length - 1], kind });
  }
}
