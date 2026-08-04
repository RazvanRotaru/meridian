import type { CompactGraphSymbolEntry, NodeId } from "@meridian/core";

export const MAX_GRAPH_SYMBOL_SEARCH_ROWS = 40;

export type GraphSymbolSearchScope = "public" | "all" | "private";

export interface GraphSymbolSearchScopeCounts {
  public: number;
  all: number;
  private: number;
}

/** A palette-ready row. Repository entries become loaded only when the current bounded graph owns
 * their canonical file; loaded rows can override every display/ranking field from the compact index. */
export interface GraphSymbolSearchEntry extends CompactGraphSymbolEntry {
  isLoaded: boolean;
}

export interface GraphSymbolSearchQuery {
  query: string;
  isMap: boolean;
  scope: GraphSymbolSearchScope;
}

export interface GraphSymbolSearchQueryResult {
  results: GraphSymbolSearchEntry[];
  counts: GraphSymbolSearchScopeCounts;
}

export interface RepositoryGraphSymbolSearchIndex {
  /** Replace only the bounded loaded overrides for the active lens. Repository order is immutable. */
  synchronize(
    loaded: readonly GraphSymbolSearchEntry[],
    isMap: boolean,
  ): GraphSymbolSearchScopeCounts;
  query(request: GraphSymbolSearchQuery): GraphSymbolSearchQueryResult;
}

const MAP_KINDS = new Set([
  "function",
  "method",
  "module",
  "package",
  "class",
  "interface",
  "typeAlias",
  "object",
]);
const LOGIC_KINDS = new Set(["function", "method", "module"]);

/** Build the exact ranked inventory off the UI thread. Map insertion order deliberately matches the
 * legacy merge: indexed rows establish canonical order, loaded rows replace in place, and loaded-only
 * rows append. Stable Array.sort then preserves the old tie behavior. */
export function mergeGraphSymbolSearchEntries(
  indexed: readonly CompactGraphSymbolEntry[],
  loaded: readonly GraphSymbolSearchEntry[],
  isMap: boolean,
): GraphSymbolSearchEntry[] {
  const kinds = isMap ? MAP_KINDS : LOGIC_KINDS;
  const merged = new Map<NodeId, GraphSymbolSearchEntry>();
  for (const entry of indexed) {
    if (!kinds.has(entry.kind)) continue;
    merged.set(entry.id, { ...entry, isLoaded: false });
  }
  for (const entry of loaded) {
    if (!kinds.has(entry.kind)) continue;
    merged.set(entry.id, entry);
  }
  const entries = [...merged.values()];
  entries.sort(isMap ? byName : byFlowThenName);
  return entries;
}

/** Build repository ranking once, at background-index acceptance. One numeric order array retains
 * repository object references; there is no second 500k-entry object graph or id map. Later palette
 * opens keep only loaded overrides, and queries materialize `isLoaded:false` on at most 40 rows. */
export function createRepositoryGraphSymbolSearchIndex(
  indexed: readonly CompactGraphSymbolEntry[],
): RepositoryGraphSymbolSearchIndex {
  const repositoryOrder = Array.from({ length: indexed.length }, (_, index) => index);
  repositoryOrder.sort((left, right) => (
    compareRank(indexed[left]!, indexed[right]!, true) || left - right
  ));
  const baseCounts = {
    map: countsForKinds(indexed, MAP_KINDS),
    logic: countsForKinds(indexed, LOGIC_KINDS),
  };

  let synchronizedForMap: boolean | null = null;
  let synchronizedLoaded: readonly GraphSymbolSearchEntry[] = [];
  let loadedIds = new Set<NodeId>();
  let loadedRanked: RankedLoadedEntry[] = [];
  let counts: GraphSymbolSearchScopeCounts = { public: 0, all: 0, private: 0 };

  return {
    synchronize(loaded, isMap) {
      if (synchronizedForMap === isMap && sameLoadedEntries(synchronizedLoaded, loaded)) {
        return { ...counts };
      }
      synchronizedForMap = isMap;
      synchronizedLoaded = [...loaded];
      loadedIds = new Set<NodeId>();
      loadedRanked = [];
      counts = { ...(isMap ? baseCounts.map : baseCounts.logic) };
      const kinds = isMap ? MAP_KINDS : LOGIC_KINDS;
      const unmatched = new Map<NodeId, { entry: GraphSymbolSearchEntry; ordinal: number }>();
      for (let loadedIndex = 0; loadedIndex < loaded.length; loadedIndex += 1) {
        const entry = loaded[loadedIndex]!;
        loadedIds.add(entry.id);
        const existing = unmatched.get(entry.id);
        unmatched.set(entry.id, { entry, ordinal: existing?.ordinal ?? loadedIndex });
      }
      // A bounded loaded-overrides map is the only id map. Scan immutable repository references to
      // apply exact count/ordinal deltas, deleting matches so loaded-only rows remain afterward.
      for (let repositoryIndex = 0; repositoryIndex < indexed.length && unmatched.size > 0; repositoryIndex += 1) {
        const base = indexed[repositoryIndex]!;
        const override = unmatched.get(base.id);
        if (override === undefined) continue;
        unmatched.delete(base.id);
        if (kinds.has(base.kind)) adjustCount(counts, base.isPrivateMethod, -1);
        if (kinds.has(override.entry.kind)) {
          adjustCount(counts, override.entry.isPrivateMethod, 1);
          loadedRanked.push({ entry: override.entry, ordinal: repositoryIndex });
        }
      }
      for (const { entry, ordinal } of unmatched.values()) {
        if (!kinds.has(entry.kind)) continue;
        adjustCount(counts, entry.isPrivateMethod, 1);
        loadedRanked.push({ entry, ordinal: indexed.length + ordinal });
      }
      loadedRanked.sort((left, right) => compareLoaded(left, right, isMap));
      return { ...counts };
    },
    query(request) {
      if (synchronizedForMap !== request.isMap) {
        throw new Error("graph symbol search is not synchronized for this view");
      }
      const needle = request.query.trim().toLowerCase();
      const results: GraphSymbolSearchEntry[] = [];
      let loadedCursor = 0;
      let baseCursor = 0;
      let logicPhase: 0 | 1 = 0;
      const nextBase = (): { entry: CompactGraphSymbolEntry; ordinal: number } | null => {
        while (true) {
          while (baseCursor < repositoryOrder.length) {
            const ordinal = repositoryOrder[baseCursor++]!;
            const entry = indexed[ordinal]!;
            if (loadedIds.has(entry.id)) continue;
            if (request.isMap) {
              if (MAP_KINDS.has(entry.kind)) return { entry, ordinal };
              continue;
            }
            if (!LOGIC_KINDS.has(entry.kind)) continue;
            const flowBearing = entry.stepCount !== null;
            if ((logicPhase === 0) === flowBearing) return { entry, ordinal };
          }
          // An empty Logic query intentionally lists flow-bearing symbols only.
          if (request.isMap || logicPhase === 1 || needle.length === 0) return null;
          logicPhase = 1;
          baseCursor = 0;
        }
      };
      let baseEntry = nextBase();
      while (results.length < MAX_GRAPH_SYMBOL_SEARCH_ROWS) {
        const loadedEntry = loadedRanked[loadedCursor];
        if (baseEntry === null && loadedEntry === undefined) break;

        let candidate: CompactGraphSymbolEntry;
        let candidateLoaded = false;
        if (
          loadedEntry !== undefined
          && (
            baseEntry === null
            || compareLoadedToIndexed(
              loadedEntry,
              baseEntry.entry,
              baseEntry.ordinal,
              request.isMap,
            ) <= 0
          )
        ) {
          candidate = loadedEntry.entry;
          candidateLoaded = true;
          loadedCursor += 1;
        } else {
          candidate = baseEntry!.entry;
          baseEntry = nextBase();
        }
        if (!isEntryInScope(candidate, request.scope)) continue;
        if (!needle) {
          if (!request.isMap && candidate.stepCount === null) continue;
        } else if (
          !candidate.displayName.toLowerCase().includes(needle)
          && !candidate.qualifiedName.toLowerCase().includes(needle)
        ) {
          continue;
        }
        results.push(candidateLoaded
          ? candidate as GraphSymbolSearchEntry
          : { ...candidate, isLoaded: false });
      }
      return { results, counts: { ...counts } };
    },
  };
}

/** Query an already-ranked inventory. Only the worker calls this for a repository-wide index; the
 * renderer fallback uses it for the currently loaded bounded graph. */
export function queryRankedGraphSymbols(
  symbols: readonly GraphSymbolSearchEntry[],
  request: GraphSymbolSearchQuery,
): GraphSymbolSearchQueryResult {
  const counts = countGraphSymbolSearchScopes(symbols);
  const needle = request.query.trim().toLowerCase();
  const results: GraphSymbolSearchEntry[] = [];
  for (const entry of symbols) {
    if (!isEntryInScope(entry, request.scope)) continue;
    if (!needle) {
      if (!request.isMap && entry.stepCount === null) continue;
    } else if (
      !entry.displayName.toLowerCase().includes(needle)
      && !entry.qualifiedName.toLowerCase().includes(needle)
    ) {
      continue;
    }
    results.push(entry);
    if (results.length === MAX_GRAPH_SYMBOL_SEARCH_ROWS) break;
  }
  return { results, counts };
}

export function countGraphSymbolSearchScopes(
  symbols: readonly GraphSymbolSearchEntry[],
): GraphSymbolSearchScopeCounts {
  let privateCount = 0;
  for (const entry of symbols) privateCount += Number(entry.isPrivateMethod);
  return {
    public: symbols.length - privateCount,
    all: symbols.length,
    private: privateCount,
  };
}

function isEntryInScope(entry: CompactGraphSymbolEntry, scope: GraphSymbolSearchScope): boolean {
  if (scope === "all") return true;
  return scope === "private" ? entry.isPrivateMethod : !entry.isPrivateMethod;
}

function byName(left: GraphSymbolSearchEntry, right: GraphSymbolSearchEntry): number {
  return left.displayName.localeCompare(right.displayName);
}

function byFlowThenName(left: GraphSymbolSearchEntry, right: GraphSymbolSearchEntry): number {
  const flowRank = Number(right.stepCount !== null) - Number(left.stepCount !== null);
  return flowRank || byName(left, right);
}

interface RankedLoadedEntry {
  entry: GraphSymbolSearchEntry;
  ordinal: number;
}

function compareLoaded(left: RankedLoadedEntry, right: RankedLoadedEntry, isMap: boolean): number {
  return compareRank(left.entry, right.entry, isMap) || left.ordinal - right.ordinal;
}

function compareLoadedToIndexed(
  loaded: RankedLoadedEntry,
  indexed: CompactGraphSymbolEntry,
  indexedOrdinal: number,
  isMap: boolean,
): number {
  return compareRank(loaded.entry, indexed, isMap) || loaded.ordinal - indexedOrdinal;
}

function compareRank(
  left: CompactGraphSymbolEntry,
  right: CompactGraphSymbolEntry,
  isMap: boolean,
): number {
  const flowRank = isMap ? 0 : Number(right.stepCount !== null) - Number(left.stepCount !== null);
  return flowRank || left.displayName.localeCompare(right.displayName);
}

function countsForKinds(
  indexed: readonly CompactGraphSymbolEntry[],
  kinds: ReadonlySet<string>,
): GraphSymbolSearchScopeCounts {
  let privateCount = 0;
  let total = 0;
  for (const entry of indexed) {
    if (!kinds.has(entry.kind)) continue;
    total += 1;
    privateCount += Number(entry.isPrivateMethod);
  }
  return { public: total - privateCount, all: total, private: privateCount };
}

function adjustCount(counts: GraphSymbolSearchScopeCounts, privateMethod: boolean, delta: 1 | -1): void {
  counts.all += delta;
  if (privateMethod) counts.private += delta;
  else counts.public += delta;
}

function sameLoadedEntries(
  left: readonly GraphSymbolSearchEntry[],
  right: readonly GraphSymbolSearchEntry[],
): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index]!;
    const b = right[index]!;
    if (
      a.id !== b.id
      || a.fileId !== b.fileId
      || a.displayName !== b.displayName
      || a.qualifiedName !== b.qualifiedName
      || a.kind !== b.kind
      || a.file !== b.file
      || a.isPrivateMethod !== b.isPrivateMethod
      || a.stepCount !== b.stepCount
      || a.isLoaded !== b.isLoaded
    ) return false;
  }
  return true;
}
