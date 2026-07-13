export interface UnchangedCodeFold {
  startLine: number;
  endLine: number;
  lineCount: number;
}

interface UnchangedCodeFoldOptions {
  startLine: number;
  lineCount: number;
  focusLines: ReadonlySet<number>;
  contextLines?: number;
  minimumFoldLines?: number;
  minimumSourceLines?: number;
}

const DEFAULT_CONTEXT_LINES = 3;
const DEFAULT_MINIMUM_FOLD_LINES = 8;
const DEFAULT_MINIMUM_SOURCE_LINES = 24;

/** Fold large untouched gaps while preserving GitHub-style context around every important row. */
export function unchangedCodeFolds(options: UnchangedCodeFoldOptions): UnchangedCodeFold[] {
  const {
    startLine,
    lineCount,
    focusLines,
    contextLines = DEFAULT_CONTEXT_LINES,
    minimumFoldLines = DEFAULT_MINIMUM_FOLD_LINES,
    minimumSourceLines = DEFAULT_MINIMUM_SOURCE_LINES,
  } = options;
  if (lineCount < minimumSourceLines || focusLines.size === 0) return [];

  const endLine = startLine + lineCount - 1;
  const visibleRanges = mergedVisibleRanges(focusLines, startLine, endLine, contextLines);
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
  startLine: number,
  endLine: number,
  contextLines: number,
): Array<{ start: number; end: number }> {
  const ranges = [...focusLines]
    .filter((line) => line >= startLine && line <= endLine)
    .sort((a, b) => a - b)
    .map((line) => ({
      start: Math.max(startLine, line - contextLines),
      end: Math.min(endLine, line + contextLines),
    }));
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
