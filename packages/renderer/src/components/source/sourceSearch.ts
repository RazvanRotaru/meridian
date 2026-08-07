export interface SourceSearchMatch {
  /** Absolute source coordinate. */
  line: number;
  /** One-based UTF-16 column, matching the source reader's DOM string coordinate. */
  column: number;
  length: number;
}

export interface SourceSearchResult {
  matches: SourceSearchMatch[];
  /** At least one additional occurrence exists beyond the bounded materialized result set. */
  truncated: boolean;
}

export const MAX_SOURCE_SEARCH_MATCHES = 5_000;

/** Case-insensitive literal search over the exact visible source slice. */
export function sourceSearchMatches(
  code: string,
  query: string,
  startLine: number,
  lineCount: number,
  hiddenLines: ReadonlySet<number> = EMPTY_LINES,
): SourceSearchResult {
  if (query.length === 0 || lineCount <= 0) return EMPTY_RESULT;
  const needle = new RegExp(escapeRegexLiteral(query), "giu");
  const lines = code.split("\n").slice(0, lineCount);
  const matches: SourceSearchMatch[] = [];
  for (let offset = 0; offset < lines.length; offset += 1) {
    const line = startLine + offset;
    if (hiddenLines.has(line)) continue;
    for (const match of lines[offset]!.matchAll(needle)) {
      if (matches.length === MAX_SOURCE_SEARCH_MATCHES) {
        return { matches, truncated: true };
      }
      matches.push({ line, column: (match.index ?? 0) + 1, length: match[0].length });
    }
  }
  return { matches, truncated: false };
}

export function nextSourceSearchIndex(
  current: number,
  matchCount: number,
  direction: 1 | -1,
): number {
  if (matchCount <= 0) return -1;
  if (current < 0 || current >= matchCount) return direction === 1 ? 0 : matchCount - 1;
  return (current + direction + matchCount) % matchCount;
}

/** Navigate from the result the UI currently resolves, even if state briefly retained an index
 * made stale by a query/source change. */
export function sourceSearchNavigationIndex(
  current: number,
  matchCount: number,
  direction: 1 | -1,
): number {
  const resolved = matchCount <= 0 ? -1 : current >= 0 && current < matchCount ? current : 0;
  return nextSourceSearchIndex(resolved, matchCount, direction);
}

export function shouldOpenSourceSearchFromShortcut(
  event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey" | "defaultPrevented">,
  blockingModalOpen: boolean,
): boolean {
  return !event.defaultPrevented
    && !blockingModalOpen
    && event.key.toLowerCase() === "f"
    && (event.metaKey || event.ctrlKey)
    && !event.altKey
    && !event.shiftKey;
}

function escapeRegexLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const EMPTY_LINES: ReadonlySet<number> = new Set<number>();
const EMPTY_RESULT: SourceSearchResult = { matches: [], truncated: false };
