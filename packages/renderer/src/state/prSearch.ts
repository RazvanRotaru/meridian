import type { PrSummary, PrsTab } from "./prTypes";

export interface PrSearchCacheEntry {
  numbers: number[];
  hasMore: boolean;
}

/** Search identity is case-insensitive and ignores surrounding whitespace across both PR surfaces. */
export function normalizePrSearchQuery(query: string): string {
  return query.trim().toLowerCase();
}

export function prSearchCacheKey(tab: PrsTab, query: string): string {
  return `${tab}\0${normalizePrSearchQuery(query)}`;
}

/** One shared local vocabulary for loaded and remotely discovered PR summaries. */
export function matchesPrSearchQuery(pr: PrSummary, query: string): boolean {
  const normalized = normalizePrSearchQuery(query);
  const exactNumber = /^#?([1-9]\d*)$/.exec(normalized);
  if (exactNumber) {
    const number = Number(exactNumber[1]);
    return Number.isSafeInteger(number) && pr.number === number;
  }
  // A leading "#" remains optional for non-numeric arbitrary text on both PR surfaces.
  const needle = normalized.replace(/^#/, "");
  if (needle === "") {
    return true;
  }
  return String(pr.number).includes(needle)
    || pr.title.toLowerCase().includes(needle)
    || pr.author.toLowerCase().includes(needle)
    || pr.headRef.toLowerCase().includes(needle)
    || pr.baseRef.toLowerCase().includes(needle)
    || (pr.body?.toLowerCase().includes(needle) ?? false);
}

/** Preserve already-visible queue order, then append genuinely new priority-search hits. */
export function mergePrSearchResults(
  local: readonly PrSummary[],
  remote: readonly PrSummary[],
): PrSummary[] {
  const merged = [...local];
  const seen = new Set(local.map((pr) => pr.number));
  for (const pr of remote) {
    if (!seen.has(pr.number)) {
      seen.add(pr.number);
      merged.push(pr);
    }
  }
  return merged;
}

/** Landing-compatible wrapping ArrowUp/ArrowDown navigation, keyed by PR number for stable appends. */
export function nextPrSearchResult(
  numbers: readonly number[],
  active: number | null,
  direction: 1 | -1,
): number | null {
  if (numbers.length === 0) {
    return null;
  }
  const current = active === null ? -1 : numbers.indexOf(active);
  if (current < 0) {
    return direction === 1 ? numbers[0]! : numbers[numbers.length - 1]!;
  }
  return numbers[(current + direction + numbers.length) % numbers.length]!;
}
