import type { GraphArtifact, GraphNode, NodeId } from "@meridian/core";

export const GRAPH_SYMBOL_SEARCH_VERSION = 1 as const;
export const MAX_GRAPH_SYMBOL_RESULTS = 40;

export type GraphSymbolSearchMode = "map" | "logic";
export type GraphSymbolSearchScope = "public" | "all" | "private";

export interface GraphSymbolSearchRequest {
  version: typeof GRAPH_SYMBOL_SEARCH_VERSION;
  query: string;
  mode: GraphSymbolSearchMode;
  scope: GraphSymbolSearchScope;
}

export interface GraphSymbolScopeCounts {
  public: number;
  all: number;
  private: number;
}

export interface GraphSymbolEntry {
  id: NodeId;
  displayName: string;
  qualifiedName: string;
  file: string;
  kind: string;
  isPrivateMethod: boolean;
  stepCount: number | null;
}

export interface GraphSymbolSearchResult {
  version: typeof GRAPH_SYMBOL_SEARCH_VERSION;
  graphId: string;
  contentId: string;
  mode: GraphSymbolSearchMode;
  scope: GraphSymbolSearchScope;
  scopeCounts: GraphSymbolScopeCounts;
  results: GraphSymbolEntry[];
}

const MAP_KINDS = new Set(["function", "method", "module", "package", "class", "interface", "object"]);
const LOGIC_KINDS = new Set(["function", "method", "module"]);

/** Local/test embedders search only their already-bounded active projection. Server sessions use
 * the immutable repository catalog through GraphProjectionDataSource.searchSymbols instead. */
export function collectSymbols(
  artifact: GraphArtifact,
  nodesById: ReadonlyMap<string, GraphNode>,
  mode: GraphSymbolSearchMode,
): GraphSymbolEntry[] {
  const flows = (artifact.extensions?.logicFlow ?? {}) as unknown as Record<string, unknown[]>;
  const kinds = mode === "map" ? MAP_KINDS : LOGIC_KINDS;
  const entries: GraphSymbolEntry[] = [];
  for (const node of nodesById.values()) {
    if (!kinds.has(node.kind)) continue;
    const steps = flows[node.id];
    entries.push({
      id: node.id,
      displayName: node.displayName,
      qualifiedName: node.qualifiedName,
      file: node.location?.file ?? "",
      kind: node.kind,
      isPrivateMethod: node.kind === "method" && node.displayName.startsWith("__"),
      stepCount: Array.isArray(steps)
        ? steps.filter((step) => (step as { kind?: string }).kind !== "exit").length
        : null,
    });
  }
  entries.sort(mode === "map" ? byName : byFlowThenName);
  return entries;
}

export function selectSymbolResults(
  symbols: readonly GraphSymbolEntry[],
  query: string,
  mode: GraphSymbolSearchMode,
  scope: GraphSymbolSearchScope,
): GraphSymbolEntry[] {
  const needle = query.trim().toLowerCase();
  const matched: GraphSymbolEntry[] = [];
  for (const entry of symbols) {
    if (!isEntryInScope(entry, scope)) continue;
    if (needle.length === 0) {
      if (mode === "logic" && entry.stepCount === null) continue;
    } else if (
      !entry.displayName.toLowerCase().includes(needle)
      && !entry.qualifiedName.toLowerCase().includes(needle)
    ) {
      continue;
    }
    matched.push(entry);
    if (matched.length >= MAX_GRAPH_SYMBOL_RESULTS) break;
  }
  return matched;
}

export function countSymbolScopes(symbols: readonly GraphSymbolEntry[]): GraphSymbolScopeCounts {
  const privateCount = symbols.reduce((count, entry) => count + Number(entry.isPrivateMethod), 0);
  return { public: symbols.length - privateCount, all: symbols.length, private: privateCount };
}

export function localSymbolSearch(
  artifact: GraphArtifact,
  nodesById: ReadonlyMap<string, GraphNode>,
  request: GraphSymbolSearchRequest,
  graphId = "local",
): GraphSymbolSearchResult {
  const symbols = collectSymbols(artifact, nodesById, request.mode);
  return {
    version: GRAPH_SYMBOL_SEARCH_VERSION,
    graphId,
    contentId: "local",
    mode: request.mode,
    scope: request.scope,
    scopeCounts: countSymbolScopes(symbols),
    results: selectSymbolResults(symbols, request.query, request.mode, request.scope),
  };
}

function byName(left: GraphSymbolEntry, right: GraphSymbolEntry): number {
  return left.displayName.localeCompare(right.displayName);
}

function byFlowThenName(left: GraphSymbolEntry, right: GraphSymbolEntry): number {
  return Number(right.stepCount !== null) - Number(left.stepCount !== null)
    || left.displayName.localeCompare(right.displayName);
}

function isEntryInScope(entry: GraphSymbolEntry, scope: GraphSymbolSearchScope): boolean {
  if (scope === "all") return true;
  return scope === "private" ? entry.isPrivateMethod : !entry.isPrivateMethod;
}
