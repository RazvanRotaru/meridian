export interface UnchangedCodeFold {
  startLine: number;
  endLine: number;
  lineCount: number;
}

interface UnchangedCodeFoldOptions {
  startLine: number;
  lineCount: number;
  focusLines: ReadonlySet<number>;
  /** HEAD-side gaps immediately before this line. A deletion gap gets three rows before and three
   * after, so its source window is asymmetric: [gap - context, gap + context - 1]. */
  focusGaps?: ReadonlySet<number>;
  contextLines?: number;
  minimumFoldLines?: number;
  minimumSourceLines?: number;
}

const DEFAULT_CONTEXT_LINES = 3;
// GitHub's hunk contract is exact: anything outside the three context rows is collapsed, even a
// one-line gap between hunks or a short leading/trailing gap. Callers may still opt into a coarser
// threshold, but review source uses these lossless defaults.
const DEFAULT_MINIMUM_FOLD_LINES = 1;
const DEFAULT_MINIMUM_SOURCE_LINES = 1;

/** Fold large untouched gaps while preserving GitHub-style context around every important row. */
export function unchangedCodeFolds(options: UnchangedCodeFoldOptions): UnchangedCodeFold[] {
  const {
    startLine,
    lineCount,
    focusLines,
    focusGaps = EMPTY_FOCUS_GAPS,
    contextLines = DEFAULT_CONTEXT_LINES,
    minimumFoldLines = DEFAULT_MINIMUM_FOLD_LINES,
    minimumSourceLines = DEFAULT_MINIMUM_SOURCE_LINES,
  } = options;
  if (lineCount < minimumSourceLines || (focusLines.size === 0 && focusGaps.size === 0)) return [];

  const endLine = startLine + lineCount - 1;
  const visibleRanges = mergedVisibleRanges(focusLines, focusGaps, startLine, endLine, contextLines);
  if (visibleRanges.length === 0) return [];

  const folds: UnchangedCodeFold[] = [];
  let nextHiddenLine = startLine;
  for (const range of visibleRanges) {
    addFold(folds, nextHiddenLine, range.start - 1, minimumFoldLines);
    nextHiddenLine = range.end + 1;
  }
  addFold(folds, nextHiddenLine, endLine, minimumFoldLines);
  return folds;
}

function mergedVisibleRanges(
  focusLines: ReadonlySet<number>,
  focusGaps: ReadonlySet<number>,
  startLine: number,
  endLine: number,
  contextLines: number,
): Array<{ start: number; end: number }> {
  const ranges = [
    ...[...focusLines]
      .filter((line) => line >= startLine && line <= endLine)
      .map((line) => ({
        start: Math.max(startLine, line - contextLines),
        end: Math.min(endLine, line + contextLines),
      })),
    ...[...focusGaps]
      .filter((gap) => gap >= startLine && gap <= endLine + 1)
      .map((gap) => ({
        start: Math.max(startLine, gap - contextLines),
        end: Math.min(endLine, gap + contextLines - 1),
      })),
  ].sort((left, right) => left.start - right.start || left.end - right.end);
  const merged: Array<{ start: number; end: number }> = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (!previous || range.start > previous.end + 1) {
      merged.push(range);
    } else {
      previous.end = Math.max(previous.end, range.end);
    }
  }
  return merged;
}

const EMPTY_FOCUS_GAPS: ReadonlySet<number> = new Set<number>();

function addFold(
  folds: UnchangedCodeFold[],
  startLine: number,
  endLine: number,
  minimumFoldLines: number,
): void {
  const lineCount = endLine - startLine + 1;
  if (lineCount >= minimumFoldLines) folds.push({ startLine, endLine, lineCount });
}

export function unchangedCodeFoldKey(fold: UnchangedCodeFold): string {
  return `${fold.startLine}:${fold.endLine}`;
}
