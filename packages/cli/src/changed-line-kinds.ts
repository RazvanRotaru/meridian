import type { ChangedLineSpan } from "@meridian/core";

/**
 * Classify one contiguous replacement run in HEAD coordinates. Deletions pair with additions in
 * order; any remaining additions are genuinely new, while excess deletions paint the seam where
 * the removed lines used to sit. Both local git diffs and GitHub patches use this exact rule so the
 * immediate PR view and the prepared graph cannot disagree about added/modified/deleted nodes.
 */
export function classifyChangedLineRun(
  addedLines: readonly number[],
  deletedCount: number,
  seamLine: number,
): ChangedLineSpan[] {
  const spans: ChangedLineSpan[] = [];
  const modifiedCount = Math.min(addedLines.length, deletedCount);
  appendSpan(spans, addedLines.slice(0, modifiedCount), "modified");
  appendSpan(spans, addedLines.slice(modifiedCount), "added");
  if (deletedCount > addedLines.length) {
    const seam = Math.max(1, seamLine);
    spans.push({ start: seam, end: seam + 1, kind: "deleted" });
  }
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
