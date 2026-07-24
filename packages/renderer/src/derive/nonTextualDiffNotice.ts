import type { PrChangedFile } from "../state/prTypes";

/**
 * Explain a changed file whose canonical manifest has no trustworthy textual body. Exact path
 * matches win; extraction-root prefixes may be joined only when a single longest suffix wins.
 */
export function nonTextualDiffNotice(
  sourceFile: string,
  files: readonly PrChangedFile[] | null | undefined,
): string | null {
  const file = reviewFileForSource(sourceFile, files ?? []);
  if (file === null || file.diffComplete !== false) return null;

  if (file.status === "renamed" && file.previousPath) {
    return `Renamed from ${file.previousPath}; Git reports no textual diff.`;
  }
  if (file.additions === 0 && file.deletions === 0) {
    return "Git reports this file changed, but no textual diff is available (for example, binary or mode-only).";
  }
  return "Git reports this file changed, but its complete textual diff is unavailable.";
}

function reviewFileForSource(
  sourceFile: string,
  files: readonly PrChangedFile[],
): PrChangedFile | null {
  const source = stripLeadingDotSegments(sourceFile);
  const exact = files.filter((file) => aliases(file).includes(source));
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return null;

  let bestLength = 0;
  let winner: PrChangedFile | null = null;
  let ambiguous = false;
  for (const file of files) {
    for (const alias of aliases(file)) {
      const length = source.endsWith(`/${alias}`)
        ? alias.length
        : alias.endsWith(`/${source}`) ? source.length : 0;
      if (length > bestLength) {
        bestLength = length;
        winner = file;
        ambiguous = false;
      } else if (length > 0 && length === bestLength && winner !== file) {
        ambiguous = true;
      }
    }
  }
  return bestLength > 0 && !ambiguous ? winner : null;
}

function aliases(file: PrChangedFile): string[] {
  return [...new Set([file.path, file.previousPath]
    .filter((path): path is string => path !== undefined)
    .map(stripLeadingDotSegments))];
}

function stripLeadingDotSegments(path: string): string {
  let stripped = path;
  while (stripped.startsWith("./")) stripped = stripped.slice(2);
  return stripped;
}
