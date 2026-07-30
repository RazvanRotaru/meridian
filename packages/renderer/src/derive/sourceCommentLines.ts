import type { ChangedDiffLine } from "@meridian/core";

export { sourceCommentOnlyLines } from "@meridian/core";

/** Remove every proven comment-only edit row from the canonical diff projection. */
export function withoutSourceCommentDiffLines(
  lines: readonly ChangedDiffLine[],
  addedCommentOnlyLines: ReadonlySet<number>,
): readonly ChangedDiffLine[] {
  if (
    lines.length === 0
    || (addedCommentOnlyLines.size === 0 && !lines.some((line) => line.sourceCommentOnly === true))
  ) {
    return lines;
  }

  const kept = lines.filter((line) => !(
    line.sourceCommentOnly === true
    || (
      line.kind === "added"
      && line.newLine !== null
      && addedCommentOnlyLines.has(line.newLine)
    )
  ));
  const changed = kept.length !== lines.length;
  return changed ? kept : lines;
}
