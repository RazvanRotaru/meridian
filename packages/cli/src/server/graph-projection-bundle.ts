/**
 * Disk-backed, view-scoped graph projections.
 *
 * Extraction already has to own the complete GraphArtifact, but the long-lived web process does
 * not.  The extraction child writes this immutable bundle beside artifact.json.  Later requests
 * read only the hash indexes and data pages needed by the current view.  A byte-and-entry bounded
 * LRU accelerates nearby/back navigation without turning the bundle into correctness state.
 */

import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join, resolve } from "node:path";
import {
  GRAPH_PROJECTION_PROTOCOL_VERSION,
  GRAPH_PROJECTION_REQUEST_FIELDS,
  buildReachabilityProjection,
  collectTestIds,
  deriveGraphStructure,
  graphProjectionIdentityPreimage,
  isGraphProjectionReviewCursor,
  parseGraphModuleOverview,
  parseReachabilityProjectionFacts,
  type GraphArtifact,
  type GraphEdge,
  type GraphHierarchyFact,
  type GraphModuleOverview,
  type GraphNode,
  type GraphRepositorySummary,
  type JsonValue,
  type LogicFlows,
  type ReachabilityPaintFacts,
  type ReachabilityProjectionFacts,
} from "@meridian/core";
import type { SerializedServiceTopologyV1 } from "@meridian/design-metrics";
import { jsonEncodedByteLength } from "./bounded-json";
import { graphSummaryFor, type GraphGenerationSummary } from "./graph-generation-contract";
import {
  encodeServiceTopologySidecar,
  isServiceTopologySidecarDescriptor,
  readServiceTopologySidecar,
  serviceTopologySidecarPath,
  writeServiceTopologySidecar,
  type ServiceTopologySidecarDescriptor,
} from "./service-topology-sidecar";
import {
  effectiveReviewProjectionContentId,
  resolveReviewContextCursor,
  type ReviewComparisonContext,
  type ReviewComparisonSide,
  type ReviewContextFacts,
} from "./review-comparison-context";

export const GRAPH_PROJECTION_DIRECTORY = "graph-projections";
export const GRAPH_PROJECTION_FORMAT_VERSION = GRAPH_PROJECTION_PROTOCOL_VERSION;
export const GRAPH_SYMBOL_SEARCH_VERSION = 1;
const MANIFEST_FILE = "manifest.json";
const MODULE_OVERVIEW_ROOTS_FILE = "module-overview-roots.ndjson";
const MODULE_OVERVIEW_ROOTS_WITHOUT_TESTS_FILE = "module-overview-roots-without-tests.ndjson";
const MODULE_OVERVIEW_FILE = "module-overview.json";
const MODULE_OVERVIEW_WITHOUT_TESTS_FILE = "module-overview-without-tests.json";
const UI_ENTRY_IDS_FILE = "ui-entry-ids.ndjson";
const UI_ENTRY_IDS_WITHOUT_TESTS_FILE = "ui-entry-ids-without-tests.ndjson";
const REACHABILITY_SUMMARY_FILE = "reachability-summary.json";
const SHARD_COUNT = 256;
const NODE_PAGE_ENTRIES = 192;
const ID_PAGE_ENTRIES = 512;
const EDGE_PAGE_ENTRIES = 128;
const SYMBOL_PAGE_ENTRIES = 256;
const DEFAULT_CACHE_BYTES = 32 * 1024 * 1024;
const DEFAULT_CACHE_ENTRIES = 96;
const DEFAULT_MAX_NODES = 5_000;
const DEFAULT_MAX_EDGES = 20_000;
const DEFAULT_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_FOCUS_IDS = 32;
const MAX_EXPANDED_IDS = 512;
const MAX_EXTRA_IDS = 128;
const MAX_CAUSAL_IDS = 2_000;
const MAX_ID_BYTES = 2_048;
const MAX_CAUSAL_IDS_BYTES = 256 * 1024;
const MAX_FILE_PATHS = 512;
const MAX_REQUEST_FILE_PATH_BYTES = 2_048;
const MAX_INDEXED_FILE_PATH_BYTES = 4_096;
const MAX_FILE_PATHS_BYTES = 48 * 1024;
const MAX_EXTENSION_LABEL_BYTES = 2_048;
const MAX_SYMBOL_FIELD_BYTES = 2_048;
const MAX_SYMBOL_QUERY_BYTES = 256;
const MAX_SYMBOL_SEARCH_RESULTS = 40;
const PROJECTION_QUERY_YIELD_INTERVAL = 64;
const GRAPH_PROJECTION_REQUEST_KEYS = new Set<string>(GRAPH_PROJECTION_REQUEST_FIELDS);
const GRAPH_PROJECTION_MANIFEST_KEYS = [
  "formatVersion",
  "contentId",
  "graphSummary",
  "repositorySummary",
  "header",
  "shardCount",
  "roots",
  "moduleOverviewRoots",
  "uiEntryIds",
  "changed",
  "symbols",
  "filePathCount",
  "extensions",
  "facts",
] as const;
const GRAPH_SYMBOL_SEARCH_REQUEST_KEYS = new Set(["version", "query", "mode", "scope"]);
const MAP_SYMBOL_KINDS = new Set(["function", "method", "module", "package", "class", "interface", "object"]);
const LOGIC_SYMBOL_KINDS = new Set(["function", "method", "module"]);
const PROJECTION_CODE_ANCHOR_KINDS = new Set([
  "module",
  "namespace",
  "class",
  "interface",
  "object",
  "enum",
  "typeAlias",
  "function",
  "method",
]);
const PROJECTION_BOUNDARY_EDGE_KINDS = new Set([
  "registers",
  "binds",
  "provides",
  "injects",
  "owns",
  "aliases",
  "calls",
  "references",
  "imports",
  "extends",
  "implements",
  "implementedBy",
  "instantiates",
  "renders",
  "sends",
  "handles",
  "createsPromise",
  "returnsPromise",
  "awaitsPromise",
  "resolvesPromise",
  "rejectsPromise",
]);

export type GraphProjectionView =
  | "modules"
  | "service"
  | "ui"
  | "logic"
  | "review";

export interface GraphProjectionRequest {
  version: typeof GRAPH_PROJECTION_FORMAT_VERSION;
  view: GraphProjectionView;
  /** Canonical extraction-root-relative POSIX paths used by the review projection. */
  filePaths: readonly string[];
  /** Opaque file/page coordinate resolved only from a capability-bound comparison context. */
  reviewCursor: string | null;
  focusIds: readonly string[];
  expandedIds: readonly string[];
  extraIds: readonly string[];
  causalIds: readonly string[];
  serviceExpandedLeadIds: readonly string[];
  /** Containment levels disclosed below the seed/focus. */
  depth: number;
  includeTests: boolean;
  includeReachability: boolean;
  maxNodes: number;
  maxEdges: number;
  maxResponseBytes: number;
}

export interface CanonicalGraphProjectionRequest {
  version: typeof GRAPH_PROJECTION_FORMAT_VERSION;
  view: GraphProjectionView;
  filePaths: string[];
  reviewCursor: string | null;
  focusIds: string[];
  expandedIds: string[];
  extraIds: string[];
  causalIds: string[];
  serviceExpandedLeadIds: string[];
  depth: number;
  includeTests: boolean;
  includeReachability: boolean;
  maxNodes: number;
  maxEdges: number;
  maxResponseBytes: number;
}

/** One source of truth for the public manifest and every server-side default activation. */
export function defaultGraphProjectionRequest(): CanonicalGraphProjectionRequest {
  return {
    version: GRAPH_PROJECTION_FORMAT_VERSION,
    view: "modules",
    filePaths: [],
    reviewCursor: null,
    focusIds: [],
    expandedIds: [],
    extraIds: [],
    causalIds: [],
    serviceExpandedLeadIds: [],
    depth: 1,
    includeTests: false,
    includeReachability: false,
    maxNodes: DEFAULT_MAX_NODES,
    maxEdges: DEFAULT_MAX_EDGES,
    maxResponseBytes: DEFAULT_MAX_RESPONSE_BYTES,
  };
}

interface SliceRef {
  offset: number;
  length: number;
}

interface PagedIds {
  count: number;
  refs: SliceRef[];
}

export type GraphSymbolSearchMode = "map" | "logic";
export type GraphSymbolSearchScope = "public" | "all" | "private";

export interface GraphSymbolEntry {
  id: string;
  displayName: string;
  qualifiedName: string;
  file: string;
  kind: string;
  isPrivateMethod: boolean;
  stepCount: number | null;
}

export interface GraphSymbolSearchScopeCounts {
  public: number;
  all: number;
  private: number;
}

export interface GraphSymbolSearchRequest {
  version: typeof GRAPH_SYMBOL_SEARCH_VERSION;
  query: string;
  mode: GraphSymbolSearchMode;
  scope: GraphSymbolSearchScope;
}

export interface CanonicalGraphSymbolSearchRequest extends GraphSymbolSearchRequest {
  query: string;
}

export interface GraphSymbolSearchResult {
  version: typeof GRAPH_SYMBOL_SEARCH_VERSION;
  contentId: string;
  mode: GraphSymbolSearchMode;
  scope: GraphSymbolSearchScope;
  scopeCounts: GraphSymbolSearchScopeCounts;
  results: GraphSymbolEntry[];
}

interface GraphSymbolCatalogManifest extends PagedIds {
  scopeCounts: GraphSymbolSearchScopeCounts;
}

interface GraphHeader {
  schemaVersion: string;
  generatedAt: string;
  generator: GraphArtifact["generator"];
  target: GraphArtifact["target"];
  telemetry?: GraphArtifact["telemetry"];
}

export interface GraphProjectionManifest {
  formatVersion: typeof GRAPH_PROJECTION_FORMAT_VERSION;
  contentId: string;
  graphSummary: GraphGenerationSummary;
  /** Constant-size, whole-repository counts safe to expose in the public transport manifest. */
  repositorySummary: GraphRepositorySummary;
  header: GraphHeader;
  shardCount: typeof SHARD_COUNT;
  roots: PagedIds;
  /** Disk-only identity pages. Public manifests expose only repositorySummary. */
  moduleOverviewRoots: {
    all: PagedIds;
    withoutTests: PagedIds;
  };
  uiEntryIds: {
    all: PagedIds;
    withoutTests: PagedIds;
  };
  changed: PagedIds;
  symbols: Record<GraphSymbolSearchMode, GraphSymbolCatalogManifest>;
  filePathCount: number;
  extensions: {
    entryModuleCount: number;
    changedPathCount: number;
    changedMetaBytes: number;
    flowCount: number;
  };
  facts: {
    moduleOverviewBytes: number;
    moduleOverviewWithoutTestsBytes: number;
    serviceTopology: ServiceTopologySidecarDescriptor;
    reachabilitySummaryBytes: number;
  };
}

interface NodeShardIndex {
  pages: SliceRef[];
  byId: Record<string, number>;
}

interface StoredHierarchyFact {
  all: GraphHierarchyFact;
  /** Null means collectTestIds classified this node out of the test-hidden graph. */
  withoutTests: GraphHierarchyFact | null;
  /** Complete-revision paint facts co-paged by identity; never hydrated as a full-graph map. */
  reachability: {
    leaf: ReachabilityPaintFacts["leaves"][string] | null;
    container: ReachabilityPaintFacts["containers"][string] | null;
  };
}

type ReachabilitySummarySidecar = Pick<ReachabilityProjectionFacts, "summary" | "worstRows">;

interface HierarchyShardIndex {
  pages: SliceRef[];
}

interface AdjacencyIndexEntry {
  count: number;
  refs: SliceRef[];
}

type AdjacencyShardIndex = Record<string, AdjacencyIndexEntry>;
type FlowShardIndex = Record<string, SliceRef>;
type EntryModuleShardIndex = Record<string, number>;
type ChangedPathShardIndex = Record<string, SliceRef>;

type ChangedFileManifestStatus = "added" | "modified" | "deleted" | "renamed";

interface ChangedFileManifestEntry {
  path: string;
  status: ChangedFileManifestStatus;
  previousPath?: string;
}

interface ChangedPathRecord {
  files?: JsonValue;
  stats?: JsonValue;
  kinds?: JsonValue;
  diffLines?: JsonValue;
  manifests?: ChangedFileManifestEntry[];
}

export interface GraphProjectionChangedSinceMeta {
  baseRef?: string;
  source?: string;
}

interface ProjectedChangedSince extends GraphProjectionChangedSinceMeta {
  files?: Record<string, JsonValue>;
  stats?: Record<string, JsonValue>;
  kinds?: Record<string, JsonValue>;
  diffLines?: Record<string, JsonValue>;
  manifest?: ChangedFileManifestEntry[];
}

interface ChangedPathLookup {
  record: ChangedPathRecord | null;
  encodedBytes: number;
  overBudget: boolean;
  unavailable: boolean;
}

type AdjacencyCategory = "children" | "out-edges" | "in-edges" | "file-nodes";

export interface GraphProjectionCompleteness {
  complete: boolean;
  reasons: string[];
  omittedNodes: number;
  omittedEdges: number;
}

export interface GraphProjectionResult {
  version: typeof GRAPH_PROJECTION_FORMAT_VERSION;
  contentId: string;
  projectionId: string;
  request: CanonicalGraphProjectionRequest;
  artifact: GraphArtifact;
  hierarchy: {
    /** Present only for a repository-overview modules request; always bounded by this response. */
    moduleOverviewRootIds: string[];
    /** Exact structural facts for every returned artifact node. */
    nodes: Record<string, GraphHierarchyFact>;
  };
  viewFacts: {
    moduleOverview: GraphModuleOverview | null;
    service: SerializedServiceTopologyV1 | null;
    review: ReviewContextFacts | null;
  };
  analysis: {
    reachability: ReachabilityProjectionFacts | null;
  };
  completeness: GraphProjectionCompleteness;
  /** Conservative default weight for the browser's inactive-projection LRU. */
  residentBytes: number;
}

/** Internal context attached to a comparison-specific graph capability. */
export interface GraphProjectionReviewContext {
  readonly context: ReviewComparisonContext;
  /** Digest verified while reading the immutable context sidecar. */
  readonly contextId: string;
  readonly side: ReviewComparisonSide;
}

export interface GraphProjectionQueryOptions {
  readonly review?: GraphProjectionReviewContext;
}

export interface GraphProjectionBundleOptions {
  maxCacheBytes?: number;
  maxCacheEntries?: number;
  /**
   * Optional process-owned cache shared by multiple immutable projection bundles.
   * Supplying a cache transfers the memory-budget ownership to that coordinator.
   */
  pageCache?: GraphProjectionPageCache;
}

export interface GraphProjectionCacheStats {
  /** Conservative decoded-heap liability currently retained by parsed cache entries. */
  residentBytes: number;
  entries: number;
  /** Namespace identities retained by the cache; always bounded by entries. */
  trackedNamespaces: number;
  hits: number;
  misses: number;
  evictions: number;
  oversizeSkips: number;
}

/** Bounded cache contract for parsed projection indexes and pages. */
export interface GraphProjectionPageCache {
  get<Value>(namespace: string, key: string): Value | undefined;
  set(namespace: string, key: string, value: unknown, residentBytes: number): void;
  /** A namespace scopes current residency; hit/miss/eviction counters are aggregate-only. */
  stats(namespace?: string): GraphProjectionCacheStats;
  deleteNamespace(namespace: string): void;
}

export interface BoundedGraphProjectionPageCacheOptions {
  maxBytes: number;
  maxEntries: number;
}

/** Write a complete immutable query bundle into an empty/caller-owned directory. */
export function writeGraphProjectionBundle(bundleRoot: string, artifact: GraphArtifact): GraphProjectionManifest {
  const root = resolve(bundleRoot);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  for (const category of [
    "nodes",
    "hierarchy",
    "children",
    "out-edges",
    "in-edges",
    "file-nodes",
    "flows",
    "entry-modules",
    "changed-paths",
  ]) {
    mkdirSync(join(root, category), { recursive: true, mode: 0o700 });
  }

  const contentHash = createHash("sha256");
  contentHash.update(JSON.stringify({
    schemaVersion: artifact.schemaVersion,
    generatedAt: artifact.generatedAt,
    generator: artifact.generator,
    target: artifact.target,
    telemetry: artifact.telemetry,
  }));

  // Extraction already owns the complete node array here. Derive both structural universes once,
  // persist them as immutable shards, then let the long-lived server read only current-view facts.
  const allStructure = deriveGraphStructure(artifact.nodes, artifact.edges);
  const testIds = collectTestIds([...artifact.nodes]);
  const withoutTestNodes = artifact.nodes.filter((node) => !testIds.has(node.id));
  const withoutTestEdges = artifact.edges.filter(
    (edge) => !testIds.has(edge.source) && !testIds.has(edge.target),
  );
  const withoutTestsStructure = deriveGraphStructure(
    withoutTestNodes,
    withoutTestEdges,
  );
  const reachability = buildReachabilityProjection(artifact.nodes, artifact.edges);

  const nodesByShard = buckets<GraphNode[]>(() => []);
  const childrenByShard = buckets<Map<string, string[]>>(() => new Map());
  const fileNodesByShard = buckets<Map<string, string[]>>(() => new Map());
  const indexedFilePaths = new Set<string>();
  const roots: string[] = [];
  const changed: string[] = [];
  for (const node of artifact.nodes) {
    contentHash.update("\0n\0").update(JSON.stringify(node));
    nodesByShard[shardOf(node.id)]!.push(node);
    const parent = node.parentId ?? null;
    if (parent === null) {
      roots.push(node.id);
    } else {
      append(childrenByShard[shardOf(parent)]!, parent, node.id);
    }
    const filePath = storedFilePath(node.location?.file);
    if (filePath !== null) {
      indexedFilePaths.add(filePath);
      append(fileNodesByShard[shardOf(filePath)]!, filePath, node.id);
    }
    if (node.tags?.includes("changed")) changed.push(node.id);
  }

  for (let shard = 0; shard < SHARD_COUNT; shard += 1) {
    writeNodeShard(root, shard, nodesByShard[shard]!);
    writeAdjacencyShard(root, "children", shard, childrenByShard[shard]!, ID_PAGE_ENTRIES);
    writeAdjacencyShard(root, "file-nodes", shard, fileNodesByShard[shard]!, ID_PAGE_ENTRIES);
  }
  writeHierarchyShards(
    root,
    artifact.nodes,
    allStructure.hierarchyById,
    withoutTestsStructure.hierarchyById,
    reachability,
  );

  const outByShard = buckets<Map<string, GraphEdge[]>>(() => new Map());
  const inByShard = buckets<Map<string, GraphEdge[]>>(() => new Map());
  for (const edge of artifact.edges) {
    contentHash.update("\0e\0").update(JSON.stringify(edge));
    append(outByShard[shardOf(edge.source)]!, edge.source, edge);
    append(inByShard[shardOf(edge.target)]!, edge.target, edge);
  }
  for (let shard = 0; shard < SHARD_COUNT; shard += 1) {
    writeAdjacencyShard(root, "out-edges", shard, outByShard[shard]!, EDGE_PAGE_ENTRIES);
    writeAdjacencyShard(root, "in-edges", shard, inByShard[shard]!, EDGE_PAGE_ENTRIES);
  }

  // Projection transport has an allowlist. Open-ended artifact extensions are deliberately not
  // persisted here, so a projection reader can never hydrate an unrelated extension by accident.
  const extensions = artifact.extensions ?? {};
  const entryModules = knownEntryModules(extensions.entryModules);
  const logicFlows = knownLogicFlows(extensions.logicFlow);
  const changedSince = knownChangedSince(extensions.changedSince);
  contentHash.update("\0entry-modules\0").update(JSON.stringify(entryModules));
  contentHash.update("\0logic-flows\0").update(JSON.stringify(logicFlows));
  contentHash.update("\0changed-meta\0").update(JSON.stringify(changedSince.meta));
  for (const [path, record] of [...changedSince.records].sort(([left], [right]) => left.localeCompare(right))) {
    contentHash.update("\0changed-path\0").update(path).update("\0").update(JSON.stringify(record));
  }
  const entryModuleCount = writeEntryModuleShards(root, entryModules);
  const flowCount = writeFlowShards(root, logicFlows);
  const changedPathCount = writeChangedPathShards(root, changedSince.records);
  const changedMetaBytes = writeJson(join(root, "changed-meta.json"), changedSince.meta);
  const rootPages = writeListPages(root, "roots.ndjson", roots);
  const moduleOverviewRootPages = writeListPages(
    root,
    MODULE_OVERVIEW_ROOTS_FILE,
    [...allStructure.moduleOverviewRootIds],
  );
  const moduleOverviewRootPagesWithoutTests = writeListPages(
    root,
    MODULE_OVERVIEW_ROOTS_WITHOUT_TESTS_FILE,
    [...withoutTestsStructure.moduleOverviewRootIds],
  );
  const nodeIds = new Set(artifact.nodes.map((node) => node.id));
  const uiEntryIds = [...new Set(artifact.edges.flatMap((edge) => edge.kind === "renders"
    ? [edge.source, edge.target].filter((id) => nodeIds.has(id))
    : []))].sort();
  const uiEntryIdsWithoutTests = uiEntryIds.filter((id) => !testIds.has(id));
  const uiEntryPages = writeListPages(root, UI_ENTRY_IDS_FILE, uiEntryIds);
  const uiEntryPagesWithoutTests = writeListPages(
    root,
    UI_ENTRY_IDS_WITHOUT_TESTS_FILE,
    uiEntryIdsWithoutTests,
  );
  const moduleOverviewBytes = writeJson(join(root, MODULE_OVERVIEW_FILE), allStructure.moduleOverview);
  const moduleOverviewWithoutTestsBytes = writeJson(
    join(root, MODULE_OVERVIEW_WITHOUT_TESTS_FILE),
    withoutTestsStructure.moduleOverview,
  );
  const serviceTopology = encodeServiceTopologySidecar(artifact);
  contentHash.update("\0service-topology\0").update(serviceTopology.payload);
  writeServiceTopologySidecar(root, serviceTopology);
  const reachabilitySummaryBytes = writeJson(join(root, REACHABILITY_SUMMARY_FILE), {
    summary: reachability.summary,
    worstRows: reachability.worstRows,
  });
  const changedPages = writeListPages(root, "changed.ndjson", changed);
  const symbols = writeSymbolCatalogs(root, artifact.nodes, logicFlows);

  const header: GraphHeader = {
    schemaVersion: artifact.schemaVersion,
    generatedAt: artifact.generatedAt,
    generator: artifact.generator,
    target: artifact.target,
    ...(artifact.telemetry ? { telemetry: artifact.telemetry } : {}),
  };
  const manifest: GraphProjectionManifest = {
    formatVersion: GRAPH_PROJECTION_FORMAT_VERSION,
    contentId: contentHash.digest("hex"),
    graphSummary: graphSummaryFor(artifact),
    repositorySummary: allStructure.repositorySummary,
    header,
    shardCount: SHARD_COUNT,
    roots: { count: roots.length, refs: rootPages },
    moduleOverviewRoots: {
      all: { count: allStructure.moduleOverviewRootIds.length, refs: moduleOverviewRootPages },
      withoutTests: {
        count: withoutTestsStructure.moduleOverviewRootIds.length,
        refs: moduleOverviewRootPagesWithoutTests,
      },
    },
    uiEntryIds: {
      all: { count: uiEntryIds.length, refs: uiEntryPages },
      withoutTests: { count: uiEntryIdsWithoutTests.length, refs: uiEntryPagesWithoutTests },
    },
    changed: { count: changed.length, refs: changedPages },
    symbols,
    filePathCount: indexedFilePaths.size,
    extensions: { entryModuleCount, changedPathCount, changedMetaBytes, flowCount },
    facts: {
      moduleOverviewBytes,
      moduleOverviewWithoutTestsBytes,
      serviceTopology: serviceTopology.descriptor,
      reachabilitySummaryBytes,
    },
  };
  writeJson(join(root, MANIFEST_FILE), manifest);
  return manifest;
}

export function readGraphProjectionManifest(bundleRoot: string): GraphProjectionManifest | null {
  try {
    const root = resolve(bundleRoot);
    const path = join(root, MANIFEST_FILE);
    if (statSync(path).size > 256 * 1024) return null;
    const raw = readFileSync(path, "utf8");
    const value = JSON.parse(raw) as Partial<GraphProjectionManifest>;
    if (!hasExactKeys(value, GRAPH_PROJECTION_MANIFEST_KEYS)
      || value.formatVersion !== GRAPH_PROJECTION_FORMAT_VERSION
      || typeof value.contentId !== "string"
      || !/^[0-9a-f]{64}$/.test(value.contentId)
      || value.shardCount !== SHARD_COUNT
      || !isSummary(value.graphSummary)
      || !isRepositorySummary(value.repositorySummary)
      || !isHeader(value.header)
      || !isPagedIds(value.roots)
      || !isModuleOverviewRoots(value.moduleOverviewRoots)
      || !isModuleOverviewRoots(value.uiEntryIds)
      || !isPagedIds(value.changed)
      || !isSymbolCatalogs(value.symbols)
      || !isNonNegativeInteger(value.filePathCount)
      || !isExtensionManifest(value.extensions)
      || !isFactManifest(value.facts)) return null;
    const manifest = value as GraphProjectionManifest;
    return requiredFactSidecarsMatchManifest(root, manifest.facts) ? manifest : null;
  } catch {
    return null;
  }
}

/** Read only the bounded changed-since provenance used to bind a cached projection to its side. */
export function readGraphProjectionChangedSinceMeta(
  bundleRoot: string,
): GraphProjectionChangedSinceMeta | null {
  try {
    const path = join(resolve(bundleRoot), "changed-meta.json");
    if (statSync(path).size > 8 * 1024) return null;
    return validatedChangedMeta(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return null;
  }
}

export class GraphProjectionBundle {
  readonly manifest: GraphProjectionManifest;
  private readonly root: string;
  private readonly cache: GraphProjectionPageCache;
  private readonly ownedCache: BoundedGraphProjectionPageCache | null;

  constructor(bundleRoot: string, options: GraphProjectionBundleOptions = {}) {
    this.root = resolve(bundleRoot);
    const manifest = readGraphProjectionManifest(this.root);
    if (!manifest) throw new Error("graph projection manifest is unavailable or invalid");
    this.manifest = manifest;
    if (options.pageCache !== undefined
      && (options.maxCacheBytes !== undefined || options.maxCacheEntries !== undefined)) {
      throw new TypeError("pageCache cannot be combined with per-bundle cache limits");
    }
    if (options.pageCache !== undefined) {
      this.ownedCache = null;
      this.cache = options.pageCache;
    } else {
      this.ownedCache = new BoundedGraphProjectionPageCache({
        maxBytes: positiveOrZero(options.maxCacheBytes, DEFAULT_CACHE_BYTES, "maxCacheBytes"),
        maxEntries: positiveOrZero(options.maxCacheEntries, DEFAULT_CACHE_ENTRIES, "maxCacheEntries"),
      });
      this.cache = this.ownedCache;
    }
  }

  cacheStats(): GraphProjectionCacheStats {
    return this.ownedCache?.stats() ?? this.cache.stats(this.root);
  }

  clearMemoryCache(): void {
    if (this.ownedCache) this.ownedCache.clear();
    else this.cache.deleteNamespace(this.root);
  }

  /** Public identity for this physical bundle under an optional logical review capability. */
  contentIdFor(options: GraphProjectionQueryOptions = {}): string {
    const review = options.review;
    return review === undefined
      ? this.manifest.contentId
      : effectiveReviewProjectionContentId(
          this.manifest.contentId,
          review.contextId,
          review.side,
        );
  }

  async query(
    input: GraphProjectionRequest,
    signal?: AbortSignal,
    options: GraphProjectionQueryOptions = {},
  ): Promise<GraphProjectionResult> {
    const request = canonicalizeGraphProjectionRequest(input);
    const review = resolveReviewQuery(request, options.review);
    const contentId = this.contentIdFor(options);
    const reviewGraphPaths = review?.graphPath === null || review?.graphPath === undefined
      ? []
      : [review.graphPath];
    const graphRoutingPaths = review === null ? request.filePaths : reviewGraphPaths;
    // Graph-side presence and canonical diff ownership are separate coordinates. A deleted file has
    // no HEAD graph path, while its exact diffLines/stats remain authored by the HEAD bundle under
    // the current manifest path. Likewise, a renamed base graph routes through previousPath without
    // changing which canonical row owns its review metadata.
    const changedRoutingPaths = review === null
      ? request.filePaths
      : review.changedPath === null
        ? []
        : [review.changedPath];
    const cancellation = new ProjectionQueryCancellation(signal);
    let pendingYield = cancellation.checkpoint(true);
    if (pendingYield !== null) await pendingYield;
    const projectionId = createHash("sha256")
      .update(graphProjectionIdentityPreimage(contentId, request))
      .digest("hex");
    const reasons = new Set<string>();
    let omittedNodes = 0;
    let omittedEdges = 0;
    let retainedBytes = projectionEnvelopeReserveBytes(
      contentId,
      projectionId,
      request,
      this.manifest.header,
      review?.facts ?? null,
    );
    if (retainedBytes > request.maxResponseBytes) {
      throw new GraphProjectionRequestError(413, "graph projection response budget cannot hold its request envelope");
    }
    const needsModuleOverview = request.focusIds.length === 0
      && (request.view === "modules" || request.view === "ui");
    const requiredFacts = [
      needsModuleOverview
        ? {
            label: "module overview",
            bytes: request.includeTests
              ? this.manifest.facts.moduleOverviewBytes
              : this.manifest.facts.moduleOverviewWithoutTestsBytes,
          }
        : null,
      request.view === "service"
        ? { label: "service topology", bytes: this.manifest.facts.serviceTopology.bytes }
        : null,
      request.includeReachability
        ? { label: "reachability summary", bytes: this.manifest.facts.reachabilitySummaryBytes }
        : null,
    ].filter((fact): fact is { label: string; bytes: number } => fact !== null);
    let requiredFactBytes = retainedBytes;
    for (const fact of requiredFacts) {
      pendingYield = cancellation.checkpoint();
      if (pendingYield !== null) await pendingYield;
      requiredFactBytes += fact.bytes + 32;
      if (requiredFactBytes > request.maxResponseBytes) {
        throw new GraphProjectionRequestError(
          413,
          `graph projection response budget cannot hold its ${fact.label}`,
        );
      }
    }
    const moduleOverview = needsModuleOverview
      ? this.moduleOverview(request.includeTests)
      : null;
    const service = request.view === "service" ? this.serviceTopology() : null;
    const reachabilitySummary = request.includeReachability ? this.reachabilitySummary() : null;
    // These values are parsed from canonical JSON sidecars whose exact encoded sizes are in the
    // manifest. Reuse those sizes rather than serializing a potentially large service topology a
    // second time merely for admission accounting; the final complete-response guard remains the
    // authoritative safety check.
    retainedBytes = requiredFactBytes;
    const nodes = new Map<string, GraphNode>();
    const hierarchyNodes = Object.create(null) as Record<string, GraphHierarchyFact>;
    const reachabilityLeaves: Record<string, ReachabilityPaintFacts["leaves"][string]> = {};
    const reachabilityContainers: Record<string, ReachabilityPaintFacts["containers"][string]> = {};

    const addNode = (id: string): boolean => {
      cancellation.throwIfAborted();
      if (nodes.has(id)) return true;
      const node = this.node(id);
      if (!node) {
        omittedNodes += 1;
        reasons.add("projection-data-unavailable");
        return false;
      }
      const storedFact = this.hierarchyFact(id);
      if (!storedFact) {
        omittedNodes += 1;
        reasons.add("projection-data-unavailable");
        return false;
      }
      const hierarchyFact = request.includeTests ? storedFact.all : storedFact.withoutTests;
      if (hierarchyFact === null) return false;
      const parentId = node.parentId ?? null;
      if (parentId !== null && !nodes.has(parentId) && !addNode(parentId)) return false;
      // Every returned node carries one exact structural fact. Charge both together before either
      // is published so a byte-limited response remains a closed, strictly decodable projection.
      const reachabilityFact = request.includeReachability ? storedFact.reachability : null;
      const reachabilityBytes = reachabilityFact === null
        ? 0
        : jsonBytes(id) * 2
          + (reachabilityFact.leaf === null ? 0 : jsonBytes(reachabilityFact.leaf))
          + (reachabilityFact.container === null ? 0 : jsonBytes(reachabilityFact.container))
          + 16;
      const bytes = jsonBytes(node) + jsonBytes(id) + jsonBytes(hierarchyFact) + reachabilityBytes + 48;
      if (nodes.size >= request.maxNodes || retainedBytes + bytes > request.maxResponseBytes) {
        omittedNodes += 1;
        reasons.add(nodes.size >= request.maxNodes ? "node-limit" : "byte-limit");
        return false;
      }
      nodes.set(id, node);
      hierarchyNodes[id] = hierarchyFact;
      if (reachabilityFact?.leaf !== null && reachabilityFact?.leaf !== undefined) {
        reachabilityLeaves[id] = reachabilityFact.leaf;
      }
      if (reachabilityFact?.container !== null && reachabilityFact?.container !== undefined) {
        reachabilityContainers[id] = reachabilityFact.container;
      }
      retainedBytes += bytes;
      return true;
    };

    const seeds = new Set<string>([
      ...request.focusIds,
      ...request.extraIds,
      ...request.causalIds,
    ]);
    const boundarySeedCandidates = new Set<string>(seeds);
    if (service !== null) {
      const expandedLeads = new Set(request.serviceExpandedLeadIds);
      for (const cluster of service.clusters) {
        pendingYield = cancellation.checkpoint();
        if (pendingYield !== null) await pendingYield;
        seeds.add(cluster.leadId);
        if (expandedLeads.has(cluster.leadId)) {
          for (const memberId of cluster.memberIds) {
            pendingYield = cancellation.checkpoint();
            if (pendingYield !== null) await pendingYield;
            seeds.add(memberId);
          }
          expandedLeads.delete(cluster.leadId);
        }
      }
      // A stale topology selector is an explicit data miss, not permission to broaden the view.
      for (const staleLeadId of expandedLeads) {
        pendingYield = cancellation.checkpoint();
        if (pendingYield !== null) await pendingYield;
        seeds.add(staleLeadId);
      }
    }
    const uiEntries = request.view === "ui" && request.focusIds.length === 0
      ? (request.includeTests ? this.manifest.uiEntryIds.all : this.manifest.uiEntryIds.withoutTests)
      : null;
    const moduleOverviewRequested = request.focusIds.length === 0
      && (request.view === "modules" || (request.view === "ui" && uiEntries?.count === 0));
    const moduleOverviewRootCandidates: string[] = [];
    if (moduleOverviewRequested) {
      const list = request.includeTests
        ? this.manifest.moduleOverviewRoots.all
        : this.manifest.moduleOverviewRoots.withoutTests;
      const path = request.includeTests
        ? MODULE_OVERVIEW_ROOTS_FILE
        : MODULE_OVERVIEW_ROOTS_WITHOUT_TESTS_FILE;
      let visited = 0;
      let stoppedAtLimit = false;
      for (const id of this.readIdPages(path, list.refs)) {
        pendingYield = cancellation.checkpoint();
        if (pendingYield !== null) await pendingYield;
        visited += 1;
        const identityBytes = jsonBytes(id) + 1;
        if (seeds.size >= request.maxNodes || retainedBytes + identityBytes > request.maxResponseBytes) {
          omittedNodes += Math.max(1, list.count - visited + 1);
          reasons.add(seeds.size >= request.maxNodes ? "node-limit" : "byte-limit");
          stoppedAtLimit = true;
          break;
        }
        retainedBytes += identityBytes;
        moduleOverviewRootCandidates.push(id);
        seeds.add(id);
        boundarySeedCandidates.add(id);
      }
      if (!stoppedAtLimit && visited !== list.count) {
        throw new GraphProjectionDataError(`${path} does not match its manifest count`);
      }
    }
    if (uiEntries !== null && uiEntries.count > 0) {
      const path = request.includeTests ? UI_ENTRY_IDS_FILE : UI_ENTRY_IDS_WITHOUT_TESTS_FILE;
      let visited = 0;
      let stoppedAtLimit = false;
      for (const id of this.readIdPages(path, uiEntries.refs)) {
        pendingYield = cancellation.checkpoint();
        if (pendingYield !== null) await pendingYield;
        visited += 1;
        const identityBytes = jsonBytes(id) + 1;
        if (seeds.size >= request.maxNodes || retainedBytes + identityBytes > request.maxResponseBytes) {
          omittedNodes += Math.max(1, uiEntries.count - visited + 1);
          reasons.add(seeds.size >= request.maxNodes ? "node-limit" : "byte-limit");
          stoppedAtLimit = true;
          break;
        }
        retainedBytes += identityBytes;
        seeds.add(id);
      }
      if (!stoppedAtLimit && visited !== uiEntries.count) {
        throw new GraphProjectionDataError(`${path} does not match its manifest count`);
      }
    }
    if (request.view === "review") {
      for (const filePath of graphRoutingPaths) {
        pendingYield = cancellation.checkpoint();
        if (pendingYield !== null) await pendingYield;
        const entry = this.adjacencyEntry("file-nodes", filePath);
        if (!entry) continue;
        let visited = 0;
        for (const id of this.readAdjacencyPages<string>("file-nodes", filePath, entry.refs)) {
          pendingYield = cancellation.checkpoint();
          if (pendingYield !== null) await pendingYield;
          visited += 1;
          if (seeds.has(id)) continue;
          if (seeds.size >= request.maxNodes) {
            omittedNodes += 1;
            reasons.add("node-limit");
            continue;
          }
          seeds.add(id);
          boundarySeedCandidates.add(id);
        }
        if (visited !== entry.count) {
          throw new GraphProjectionDataError(`file-nodes for ${filePath} does not match its index count`);
        }
      }
    }
    // An explicit path query that has no nodes is still a complete empty projection (for example,
    // a deleted path on HEAD). Never broaden it to every changed node as an implicit fallback.
    if (!moduleOverviewRequested
      && seeds.size === 0
      && graphRoutingPaths.length === 0
      && review === null
      && request.view !== "service"
      && request.view !== "ui") {
      const list = request.view === "review" ? this.manifest.changed : this.manifest.roots;
      let visited = 0;
      let stoppedAtLimit = false;
      for (const id of this.readIdPages(request.view === "review" ? "changed.ndjson" : "roots.ndjson", list.refs)) {
        pendingYield = cancellation.checkpoint();
        if (pendingYield !== null) await pendingYield;
        visited += 1;
        seeds.add(id);
        boundarySeedCandidates.add(id);
        if (seeds.size >= request.maxNodes) {
          omittedNodes += Math.max(0, list.count - seeds.size);
          if (list.count > seeds.size) reasons.add("node-limit");
          stoppedAtLimit = true;
          break;
        }
      }
      if (!stoppedAtLimit && visited !== list.count) {
        throw new GraphProjectionDataError("projection root list does not match its manifest count");
      }
    }
    for (const id of seeds) {
      pendingYield = cancellation.checkpoint();
      if (pendingYield !== null) await pendingYield;
      addNode(id);
    }
    const boundaryAnchorIds = new Set<string>();
    const markBoundaryAnchor = (id: string): void => {
      if (PROJECTION_CODE_ANCHOR_KINDS.has(nodes.get(id)?.kind ?? "")) boundaryAnchorIds.add(id);
    };
    for (const id of boundarySeedCandidates) {
      pendingYield = cancellation.checkpoint();
      if (pendingYield !== null) await pendingYield;
      markBoundaryAnchor(id);
    }
    const focusAncestorIds = new Set<string>();
    for (const focusId of request.focusIds) {
      pendingYield = cancellation.checkpoint();
      if (pendingYield !== null) await pendingYield;
      const seen = new Set<string>([focusId]);
      let parentId = nodes.get(focusId)?.parentId ?? null;
      while (parentId !== null && !seen.has(parentId)) {
        pendingYield = cancellation.checkpoint();
        if (pendingYield !== null) await pendingYield;
        seen.add(parentId);
        focusAncestorIds.add(parentId);
        parentId = nodes.get(parentId)?.parentId ?? null;
      }
    }

    const disclose = async (
      parents: Iterable<string>,
      depth: number,
      collectBoundaryAnchors = false,
    ): Promise<void> => {
      let frontier = [...parents];
      for (let level = 0; level < depth && frontier.length > 0; level += 1) {
        pendingYield = cancellation.checkpoint();
        if (pendingYield !== null) await pendingYield;
        const next: string[] = [];
        for (const parentId of frontier) {
          pendingYield = cancellation.checkpoint();
          if (pendingYield !== null) await pendingYield;
          const entry = this.adjacencyEntry("children", parentId);
          if (!entry) continue;
          let visited = 0;
          let stoppedAtLimit = false;
          for (const child of this.readAdjacencyPages<string>("children", parentId, entry.refs)) {
            pendingYield = cancellation.checkpoint();
            if (pendingYield !== null) await pendingYield;
            visited += 1;
            if (addNode(child)) {
              next.push(child);
              if (collectBoundaryAnchors) markBoundaryAnchor(child);
            }
            if (nodes.size >= request.maxNodes) {
              stoppedAtLimit = true;
              break;
            }
          }
          if (visited < entry.count) {
            omittedNodes += entry.count - visited;
            if (stoppedAtLimit) reasons.add("node-limit");
            else throw new GraphProjectionDataError(`children for ${parentId} does not match its index count`);
          } else if (visited > entry.count) {
            throw new GraphProjectionDataError(`children for ${parentId} exceeds its index count`);
          }
          if (nodes.size >= request.maxNodes) break;
        }
        frontier = next;
      }
    };
    // Every breadcrumb ancestor discloses its direct-child cohort. This keeps sibling navigation
    // available without a whole-subtree preload; the focused node's own depth remains explicit.
    await disclose(focusAncestorIds, 1);
    const implicitTopologyRoot = request.focusIds.length === 0
      && (request.view === "service" || request.view === "ui");
    await disclose(seeds, request.depth, !implicitTopologyRoot && request.view !== "service");
    for (const id of request.expandedIds) {
      pendingYield = cancellation.checkpoint();
      if (pendingYield !== null) await pendingYield;
      markBoundaryAnchor(id);
    }
    await disclose(request.expandedIds, 1, true);

    const boundaryEdgeIds = new Set<string>();
    // One typed boundary hop from the fixed original anchor set. Partners never become new
    // traversal anchors, so this cannot turn into a hidden multi-hop walk through the repository.
    for (const id of [...boundaryAnchorIds]) {
      pendingYield = cancellation.checkpoint();
      if (pendingYield !== null) await pendingYield;
      for (const category of ["out-edges", "in-edges"] as const) {
        pendingYield = cancellation.checkpoint();
        if (pendingYield !== null) await pendingYield;
        for (const edge of this.adjacency<GraphEdge>(category, id)) {
          pendingYield = cancellation.checkpoint();
          if (pendingYield !== null) await pendingYield;
          if (!PROJECTION_BOUNDARY_EDGE_KINDS.has(edge.kind)) continue;
          boundaryEdgeIds.add(edge.id);
          const peer = edge.source === id ? edge.target : edge.source;
          if (nodes.has(peer)) continue;
          const unresolvedTarget = peer === edge.target && (edge.resolution === "external" || edge.resolution === "unresolved");
          if (!unresolvedTarget || this.node(peer) !== null) addNode(peer);
        }
      }
    }

    const flows: LogicFlows = {};
    const flowIds = new Set<string>([...request.expandedIds, ...request.causalIds]);
    if (request.view === "logic") {
      for (const id of request.focusIds.length > 0 ? request.focusIds : [...seeds]) flowIds.add(id);
    }
    if (flowIds.size > 0) {
      for (const id of flowIds) {
        pendingYield = cancellation.checkpoint();
        if (pendingYield !== null) await pendingYield;
        const flow = this.flow(id);
        if (!flow) continue;
        const flowBytes = jsonBytes(flow) + jsonBytes(id) + 48;
        if (retainedBytes + flowBytes > request.maxResponseBytes) {
          reasons.add("extension-byte-limit");
          continue;
        }
        flows[id] = flow;
        retainedBytes += flowBytes;
        for (const target of flowTargets(flow)) {
          pendingYield = cancellation.checkpoint();
          if (pendingYield !== null) await pendingYield;
          addNode(target);
        }
      }
    }

    const edges: GraphEdge[] = [];
    const edgeIds = new Set<string>();
    for (const source of nodes.keys()) {
      pendingYield = cancellation.checkpoint();
      if (pendingYield !== null) await pendingYield;
      for (const edge of this.adjacency<GraphEdge>("out-edges", source)) {
        pendingYield = cancellation.checkpoint();
        if (pendingYield !== null) await pendingYield;
        const representedTarget = nodes.has(edge.target)
          || (boundaryEdgeIds.has(edge.id)
            && (edge.resolution === "external" || edge.resolution === "unresolved"));
        if (!representedTarget || edgeIds.has(edge.id)) continue;
        const bytes = jsonBytes(edge) + 1;
        if (edges.length >= request.maxEdges || retainedBytes + bytes > request.maxResponseBytes) {
          omittedEdges += 1;
          reasons.add(edges.length >= request.maxEdges ? "edge-limit" : "byte-limit");
          continue;
        }
        edgeIds.add(edge.id);
        edges.push(edge);
        retainedBytes += bytes;
      }
    }

    let extensions: Record<string, JsonValue> | undefined;
    const entryModules = this.selectedEntryModules(nodes.keys());
    if (entryModules.length > 0) {
      const entryModuleBytes = jsonBytes(entryModules) + 32;
      if (retainedBytes + entryModuleBytes <= request.maxResponseBytes) {
        (extensions ??= {}).entryModules = entryModules;
        retainedBytes += entryModuleBytes;
      } else {
        reasons.add("extension-byte-limit");
      }
    }
    if (request.view === "review") {
      const projected: ProjectedChangedSince = {};
      let estimatedBytes = 128;
      if (this.manifest.extensions.changedMetaBytes > 0
        && this.manifest.extensions.changedMetaBytes <= request.maxResponseBytes - retainedBytes) {
        const rawMeta = this.readJson<unknown>("changed-meta.json");
        const meta = validatedChangedMeta(rawMeta);
        if (meta) {
          if (meta.baseRef !== undefined) projected.baseRef = meta.baseRef;
          if (meta.source !== undefined) projected.source = meta.source;
          estimatedBytes += jsonBytes(meta);
        } else {
          reasons.add("projection-data-unavailable");
        }
      } else if (this.manifest.extensions.changedMetaBytes > 2) {
        reasons.add("extension-byte-limit");
      }

      const relevantPaths = new Set(changedRoutingPaths);
      if (relevantPaths.size === 0) {
        for (const node of nodes.values()) {
          pendingYield = cancellation.checkpoint();
          if (pendingYield !== null) await pendingYield;
          const filePath = storedFilePath(node.location?.file);
          if (filePath !== null) relevantPaths.add(filePath);
        }
      }
      const manifestPaths = new Set<string>();
      for (const filePath of [...relevantPaths].sort()) {
        pendingYield = cancellation.checkpoint();
        if (pendingYield !== null) await pendingYield;
        const pathOverhead = (jsonBytes(filePath) * 4) + 256;
        const remaining = request.maxResponseBytes - retainedBytes - estimatedBytes - pathOverhead;
        const lookup = this.changedPath(filePath, remaining);
        if (lookup.overBudget) {
          reasons.add("extension-byte-limit");
          continue;
        }
        if (lookup.unavailable) {
          reasons.add("projection-data-unavailable");
          continue;
        }
        const record = lookup.record;
        if (!record) continue;
        estimatedBytes += lookup.encodedBytes + pathOverhead;
        if (record.files !== undefined) (projected.files ??= {})[filePath] = record.files;
        if (record.stats !== undefined) (projected.stats ??= {})[filePath] = record.stats;
        if (record.kinds !== undefined) (projected.kinds ??= {})[filePath] = record.kinds;
        if (record.diffLines !== undefined) (projected.diffLines ??= {})[filePath] = record.diffLines;
        for (const entry of record.manifests ?? []) {
          pendingYield = cancellation.checkpoint();
          if (pendingYield !== null) await pendingYield;
          if (manifestPaths.has(entry.path)) continue;
          manifestPaths.add(entry.path);
          (projected.manifest ??= []).push(entry);
        }
      }
      if (Object.keys(projected).length > 0) {
        const changedBytes = jsonBytes(projected) + 32;
        if (retainedBytes + changedBytes <= request.maxResponseBytes) {
          (extensions ??= {}).changedSince = projected as unknown as JsonValue;
          retainedBytes += changedBytes;
        } else {
          reasons.add("extension-byte-limit");
        }
      }
    }
    if (Object.keys(flows).length > 0) {
      (extensions ??= {}).logicFlow = flows as unknown as JsonValue;
    }

    const artifact: GraphArtifact = {
      ...this.manifest.header,
      nodes: [...nodes.values()],
      edges,
      ...(extensions && Object.keys(extensions).length > 0 ? { extensions } : {}),
    };
    const completeness: GraphProjectionCompleteness = {
      complete: reasons.size === 0,
      reasons: [...reasons].sort(),
      omittedNodes,
      omittedEdges,
    };
    const hierarchy = {
      moduleOverviewRootIds: moduleOverviewRootCandidates.filter((id) => nodes.has(id)),
      nodes: hierarchyNodes,
    };
    const reviewFacts = review === null
      ? null
      : review.facts.selection === null
        ? review.facts
        : {
            ...review.facts,
            selection: {
              ...review.facts.selection,
              graphMatched: review.graphPath !== null
                && [...nodes.values()].some((node) => storedFilePath(node.location?.file) === review.graphPath),
            },
          };
    const viewFacts = { moduleOverview, service, review: reviewFacts };
    const analysis = {
      reachability: reachabilitySummary === null
        ? null
        : {
            ...reachabilitySummary,
            leaves: reachabilityLeaves,
            containers: reachabilityContainers,
          },
    };
    pendingYield = cancellation.checkpoint(true);
    if (pendingYield !== null) await pendingYield;
    const baseResult = {
      version: GRAPH_PROJECTION_FORMAT_VERSION,
      contentId,
      projectionId,
      request,
      artifact,
      hierarchy,
      viewFacts,
      analysis,
      completeness,
    };
    const baseResultBytes = jsonBytes(baseResult);
    const residentBytes = Math.min(Number.MAX_SAFE_INTEGER, baseResultBytes * 3);
    const result: GraphProjectionResult = {
      version: GRAPH_PROJECTION_FORMAT_VERSION,
      contentId,
      projectionId,
      request,
      artifact,
      hierarchy,
      viewFacts,
      analysis,
      completeness,
      residentBytes,
    };
    const resultBytes = baseResultBytes + Buffer.byteLength(`,"residentBytes":${residentBytes}`, "utf8");
    if (resultBytes > request.maxResponseBytes) {
      throw new Error("graph projection response exceeded its reserved byte budget");
    }
    cancellation.throwIfAborted();
    return result;
  }

  /** Search the extraction-authored compact catalog without hydrating graph nodes or indexes. Catalog
   * pages share the projection reader's byte/entry-bounded LRU; yielding between page batches lets a
   * disconnected HTTP subscriber cancel a worst-case rare substring scan. */
  async search(
    input: GraphSymbolSearchRequest,
    signal?: AbortSignal,
    options: GraphProjectionQueryOptions = {},
  ): Promise<GraphSymbolSearchResult> {
    const request = canonicalizeGraphSymbolSearchRequest(input);
    const contentId = this.contentIdFor(options);
    const catalog = this.manifest.symbols[request.mode];
    const needle = request.query.toLowerCase();
    const results: GraphSymbolEntry[] = [];
    for (let pageIndex = 0; pageIndex < catalog.refs.length; pageIndex += 1) {
      signal?.throwIfAborted();
      if (pageIndex > 0 && pageIndex % 8 === 0) {
        await new Promise<void>((resolveYield) => setImmediate(resolveYield));
        signal?.throwIfAborted();
      }
      const page = this.readPage<unknown>(
        `symbols-${request.mode}.ndjson`,
        catalog.refs[pageIndex]!,
      );
      if (!Array.isArray(page) || !page.every(isGraphSymbolEntry)) {
        throw new Error(`graph symbol catalog page ${pageIndex} is unavailable or invalid`);
      }
      for (const entry of page) {
        if (!isSymbolInScope(entry, request.scope)) continue;
        if (needle.length === 0) {
          if (request.mode === "logic" && entry.stepCount === null) continue;
        } else if (
          !entry.displayName.toLowerCase().includes(needle)
          && !entry.qualifiedName.toLowerCase().includes(needle)
        ) {
          continue;
        }
        results.push(entry);
        if (results.length === MAX_SYMBOL_SEARCH_RESULTS) {
          return {
            version: GRAPH_SYMBOL_SEARCH_VERSION,
            contentId,
            mode: request.mode,
            scope: request.scope,
            scopeCounts: catalog.scopeCounts,
            results,
          };
        }
      }
    }
    signal?.throwIfAborted();
    return {
      version: GRAPH_SYMBOL_SEARCH_VERSION,
      contentId,
      mode: request.mode,
      scope: request.scope,
      scopeCounts: catalog.scopeCounts,
      results,
    };
  }

  private node(id: string): GraphNode | null {
    const shard = shardName(id);
    const index = this.readJson<NodeShardIndex>(join("nodes", `${shard}.index.json`));
    const page = index?.byId[id];
    const ref = page === undefined ? undefined : index?.pages[page];
    if (!ref) return null;
    const nodes = this.readPage<unknown>(join("nodes", `${shard}.ndjson`), ref);
    if (!Array.isArray(nodes)) {
      throw new GraphProjectionDataError(`node page for ${id} is malformed`);
    }
    return (nodes as GraphNode[]).find((node) => node?.id === id) ?? null;
  }

  private hierarchyFact(id: string): StoredHierarchyFact | null {
    const shard = shardName(id);
    const nodeIndex = this.readJson<NodeShardIndex>(join("nodes", `${shard}.index.json`));
    const hierarchyIndex = this.readJson<HierarchyShardIndex>(join("hierarchy", `${shard}.index.json`));
    const page = nodeIndex?.byId[id];
    const ref = page === undefined ? undefined : hierarchyIndex?.pages[page];
    if (!ref) return null;
    const entries = this.readPage<unknown>(join("hierarchy", `${shard}.ndjson`), ref);
    if (!Array.isArray(entries)
      || entries.some((entry) => !Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string")) {
      throw new GraphProjectionDataError(`hierarchy page for ${id} is malformed`);
    }
    const fact = (entries as Array<[string, unknown]>).find(([candidate]) => candidate === id)?.[1];
    if (fact === undefined) return null;
    if (!isStoredHierarchyFact(fact)) {
      throw new GraphProjectionDataError(`hierarchy fact for ${id} is malformed`);
    }
    return fact;
  }

  private moduleOverview(includeTests: boolean): GraphModuleOverview {
    const path = includeTests ? MODULE_OVERVIEW_FILE : MODULE_OVERVIEW_WITHOUT_TESTS_FILE;
    const expectedBytes = includeTests
      ? this.manifest.facts.moduleOverviewBytes
      : this.manifest.facts.moduleOverviewWithoutTestsBytes;
    return this.readRequiredFact(path, expectedBytes, parseGraphModuleOverview);
  }

  private serviceTopology(): SerializedServiceTopologyV1 {
    const key = "fact:service-topology";
    const cached = this.cache.get<SerializedServiceTopologyV1>(this.root, key);
    if (cached !== undefined) return cached;
    try {
      const topology = readServiceTopologySidecar(this.root, this.manifest.facts.serviceTopology);
      const bytes = this.manifest.facts.serviceTopology.bytes;
      this.cache.set(this.root, key, topology, parsedCacheResidentBytes(bytes));
      return topology;
    } catch (error) {
      throw new GraphProjectionDataError("service topology sidecar is invalid", { cause: error });
    }
  }

  private reachabilitySummary(): ReachabilitySummarySidecar {
    const raw = this.readRequiredFact(
      REACHABILITY_SUMMARY_FILE,
      this.manifest.facts.reachabilitySummaryBytes,
      (value) => value,
    );
    const parsed = parseReachabilityProjectionFacts({
      ...(raw as Record<string, unknown>),
      leaves: {},
      containers: {},
    });
    return { summary: parsed.summary, worstRows: parsed.worstRows };
  }

  private readRequiredFact<Value>(
    path: string,
    expectedBytes: number,
    parse: (value: unknown) => Value,
  ): Value {
    const absolute = join(this.root, path);
    try {
      if (statSync(absolute).size !== expectedBytes) {
        throw new GraphProjectionDataError(`${path} does not match its manifest byte size`);
      }
      const raw = this.readJson<unknown>(path);
      if (raw === null) throw new GraphProjectionDataError(`${path} is unavailable`);
      return parse(raw);
    } catch (error) {
      if (error instanceof GraphProjectionDataError) throw error;
      throw new GraphProjectionDataError(`${path} is invalid`, { cause: error });
    }
  }

  private flow(id: string): LogicFlows[string] | null {
    const shard = shardName(id);
    const index = this.readJson<FlowShardIndex>(join("flows", `${shard}.index.json`));
    const ref = index?.[id];
    if (!ref) return null;
    const flow = this.readPage<unknown>(join("flows", `${shard}.ndjson`), ref);
    if (!Array.isArray(flow)) {
      throw new GraphProjectionDataError(`logic flow for ${id} is malformed`);
    }
    return flow as LogicFlows[string];
  }

  private selectedEntryModules(ids: Iterable<string>): string[] {
    if (this.manifest.extensions.entryModuleCount === 0) return [];
    const idsByShard = new Map<string, string[]>();
    for (const id of ids) append(idsByShard, shardName(id), id);
    const selected: Array<[number, string]> = [];
    for (const [shard, shardIds] of idsByShard) {
      const index = this.readJson<EntryModuleShardIndex>(join("entry-modules", `${shard}.json`));
      if (!index) continue;
      for (const id of shardIds) {
        const ordinal = index[id];
        if (Number.isSafeInteger(ordinal) && ordinal >= 0) selected.push([ordinal, id]);
      }
    }
    selected.sort(([left], [right]) => left - right);
    return selected.map(([, id]) => id);
  }

  private changedPath(filePath: string, maxBytes: number): ChangedPathLookup {
    const shard = shardName(filePath);
    const index = this.readJson<ChangedPathShardIndex>(join("changed-paths", `${shard}.index.json`));
    const ref = index?.[filePath];
    if (!ref) return { record: null, encodedBytes: 0, overBudget: false, unavailable: false };
    if (!safeRef(ref)) return { record: null, encodedBytes: 0, overBudget: false, unavailable: true };
    if (maxBytes < ref.length) {
      return { record: null, encodedBytes: ref.length, overBudget: true, unavailable: false };
    }
    const record = validatedChangedPathRecord(
      this.readPage<unknown>(join("changed-paths", `${shard}.ndjson`), ref),
    );
    if (!record) {
      return { record: null, encodedBytes: ref.length, overBudget: false, unavailable: true };
    }
    return { record, encodedBytes: ref.length, overBudget: false, unavailable: false };
  }

  private adjacencyEntry(category: AdjacencyCategory, id: string): AdjacencyIndexEntry | null {
    const shard = shardName(id);
    const index = this.readJson<AdjacencyShardIndex>(join(category, `${shard}.index.json`));
    return index?.[id] ?? null;
  }

  private *adjacency<Value>(category: "out-edges" | "in-edges", id: string): Generator<Value> {
    const entry = this.adjacencyEntry(category, id);
    if (!entry) return;
    let visited = 0;
    for (const value of this.readAdjacencyPages<Value>(category, id, entry.refs)) {
      visited += 1;
      yield value;
    }
    if (visited !== entry.count) {
      throw new GraphProjectionDataError(`${category} for ${id} does not match its index count`);
    }
  }

  private *readAdjacencyPages<Value>(
    category: AdjacencyCategory,
    id: string,
    refs: readonly SliceRef[],
  ): Generator<Value> {
    const path = join(category, `${shardName(id)}.ndjson`);
    for (const ref of refs) {
      const page = this.readPage<unknown>(path, ref);
      if (!Array.isArray(page)) {
        throw new GraphProjectionDataError(`${path} contains a malformed adjacency page`);
      }
      for (const value of page) yield value as Value;
    }
  }

  private *readIdPages(path: string, refs: readonly SliceRef[]): Generator<string> {
    for (const ref of refs) {
      const page = this.readPage<unknown>(path, ref);
      if (!Array.isArray(page) || page.some((id) => typeof id !== "string")) {
        throw new GraphProjectionDataError(`${path} contains a malformed id page`);
      }
      yield* page as string[];
    }
  }

  private readJson<Value>(path: string): Value | null {
    const key = `json:${path}`;
    const cached = this.cache.get<Value>(this.root, key);
    if (cached !== undefined) return cached;
    const absolute = join(this.root, path);
    if (!existsSync(absolute)) return null;
    try {
      const size = statSync(absolute).size;
      if (size > DEFAULT_MAX_RESPONSE_BYTES) {
        throw new GraphProjectionDataError(`${path} exceeds the projection index limit`);
      }
      const raw = readFileSync(absolute);
      const value = JSON.parse(raw.toString("utf8")) as Value;
      if (value === null) throw new GraphProjectionDataError(`${path} contains null instead of an index`);
      this.cache.set(this.root, key, value, parsedCacheResidentBytes(raw.byteLength));
      return value;
    } catch (error) {
      if (error instanceof GraphProjectionDataError) throw error;
      throw new GraphProjectionDataError(`${path} is unavailable or invalid`, { cause: error });
    }
  }

  private readPage<Value>(path: string, ref: SliceRef): Value {
    const key = `page:${path}:${ref.offset}:${ref.length}`;
    const cached = this.cache.get<Value>(this.root, key);
    if (cached !== undefined) return cached;
    if (!safeRef(ref)) throw new GraphProjectionDataError(`${path} contains an invalid page reference`);
    const absolute = join(this.root, path);
    let descriptor: number | undefined;
    try {
      descriptor = openSync(absolute, "r");
      const buffer = Buffer.allocUnsafe(ref.length);
      const read = readSync(descriptor, buffer, 0, ref.length, ref.offset);
      if (read !== ref.length) {
        throw new GraphProjectionDataError(`${path} ended before its referenced page`);
      }
      const value = JSON.parse(buffer.toString("utf8")) as Value;
      this.cache.set(this.root, key, value, parsedCacheResidentBytes(buffer.byteLength));
      return value;
    } catch (error) {
      if (error instanceof GraphProjectionDataError) throw error;
      throw new GraphProjectionDataError(`${path} contains an unavailable or invalid page`, { cause: error });
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  }
}

class GraphProjectionDataError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(`graph projection bundle data is unavailable: ${message}`, options);
    this.name = "GraphProjectionDataError";
  }
}

/**
 * Cheap synchronous abort checks with an occasional event-loop yield for HTTP disconnects.
 * No signal means no yield or promise allocation, preserving extraction/test throughput.
 */
class ProjectionQueryCancellation {
  private operations = 0;

  constructor(private readonly signal: AbortSignal | undefined) {}

  throwIfAborted(): void {
    this.signal?.throwIfAborted();
  }

  checkpoint(force = false): Promise<void> | null {
    this.throwIfAborted();
    if (this.signal === undefined) return null;
    this.operations += 1;
    if (!force && this.operations % PROJECTION_QUERY_YIELD_INTERVAL !== 0) return null;
    return new Promise<void>((resolveYield) => setImmediate(resolveYield))
      .then(() => this.throwIfAborted());
  }
}

export function canonicalizeGraphProjectionRequest(input: GraphProjectionRequest): CanonicalGraphProjectionRequest {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new GraphProjectionRequestError(400, "graph projection request must be an object");
  }
  const actualKeys = Object.keys(input).sort();
  const expectedKeys = [...GRAPH_PROJECTION_REQUEST_KEYS].sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
    throw new GraphProjectionRequestError(400, `graph projection request fields do not match the v${GRAPH_PROJECTION_FORMAT_VERSION} contract`);
  }
  if (input.version !== GRAPH_PROJECTION_FORMAT_VERSION) {
    throw new GraphProjectionRequestError(400, `graph projection request version must be ${GRAPH_PROJECTION_FORMAT_VERSION}`);
  }
  const views: readonly GraphProjectionView[] = ["modules", "service", "ui", "logic", "review"];
  if (!views.includes(input.view)) throw new GraphProjectionRequestError(400, "unknown graph projection view");
  if (typeof input.includeTests !== "boolean") {
    throw new GraphProjectionRequestError(400, "includeTests must be a boolean");
  }
  if (typeof input.includeReachability !== "boolean") {
    throw new GraphProjectionRequestError(400, "includeReachability must be a boolean");
  }
  const filePaths = normalizedFilePaths(input.filePaths);
  const reviewCursor = normalizedReviewCursor(input.reviewCursor);
  if (filePaths.length > 0 && input.view !== "review") {
    throw new GraphProjectionRequestError(400, "filePaths are supported only by the review view");
  }
  if (reviewCursor !== null && input.view !== "review") {
    throw new GraphProjectionRequestError(400, "reviewCursor is supported only by the review view");
  }
  return {
    version: GRAPH_PROJECTION_FORMAT_VERSION,
    view: input.view,
    filePaths,
    reviewCursor,
    focusIds: normalizedIds(input.focusIds, MAX_FOCUS_IDS, "focusIds"),
    expandedIds: normalizedIds(input.expandedIds, MAX_EXPANDED_IDS, "expandedIds"),
    extraIds: normalizedIds(input.extraIds, MAX_EXTRA_IDS, "extraIds"),
    causalIds: normalizedIds(
      input.causalIds,
      MAX_CAUSAL_IDS,
      "causalIds",
      MAX_CAUSAL_IDS_BYTES,
    ),
    serviceExpandedLeadIds: normalizedIds(
      input.serviceExpandedLeadIds,
      MAX_EXPANDED_IDS,
      "serviceExpandedLeadIds",
    ),
    depth: requiredBoundedInteger(input.depth, 0, 4, "depth"),
    includeTests: input.includeTests,
    includeReachability: input.includeReachability,
    maxNodes: requiredBoundedInteger(input.maxNodes, 1, DEFAULT_MAX_NODES, "maxNodes"),
    maxEdges: requiredBoundedInteger(input.maxEdges, 0, DEFAULT_MAX_EDGES, "maxEdges"),
    maxResponseBytes: requiredBoundedInteger(
      input.maxResponseBytes,
      64 * 1024,
      DEFAULT_MAX_RESPONSE_BYTES,
      "maxResponseBytes",
    ),
  };
}

function normalizedReviewCursor(value: unknown): string | null {
  if (value === null) return null;
  if (!isGraphProjectionReviewCursor(value)) {
    throw new GraphProjectionRequestError(400, "reviewCursor is not a canonical comparison coordinate");
  }
  return value;
}

function resolveReviewQuery(
  request: CanonicalGraphProjectionRequest,
  review: GraphProjectionReviewContext | undefined,
): ReturnType<typeof resolveReviewContextCursor> | null {
  if (review === undefined) {
    if (request.reviewCursor !== null) {
      throw new GraphProjectionRequestError(400, "reviewCursor requires comparison capability context");
    }
    return null;
  }
  if (request.view !== "review") {
    throw new GraphProjectionRequestError(400, "comparison capability context requires the review view");
  }
  if (request.filePaths.length > 0) {
    throw new GraphProjectionRequestError(400, "comparison capability context does not accept caller-owned file paths");
  }
  try {
    return resolveReviewContextCursor(
      review.context,
      review.contextId,
      review.side,
      request.reviewCursor,
    );
  } catch (error) {
    throw new GraphProjectionRequestError(
      400,
      error instanceof Error ? error.message : "review cursor is invalid",
    );
  }
}

export function canonicalizeGraphSymbolSearchRequest(
  input: GraphSymbolSearchRequest,
): CanonicalGraphSymbolSearchRequest {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new GraphSymbolSearchRequestError(400, "graph symbol search request must be an object");
  }
  const unknownKey = Object.keys(input).find((key) => !GRAPH_SYMBOL_SEARCH_REQUEST_KEYS.has(key));
  if (unknownKey !== undefined) {
    throw new GraphSymbolSearchRequestError(400, `unknown graph symbol search request field: ${unknownKey}`);
  }
  if (input.version !== GRAPH_SYMBOL_SEARCH_VERSION) {
    throw new GraphSymbolSearchRequestError(400, `graph symbol search version must be ${GRAPH_SYMBOL_SEARCH_VERSION}`);
  }
  if (typeof input.query !== "string" || input.query.includes("\0")) {
    throw new GraphSymbolSearchRequestError(400, "graph symbol search query must be a string without null bytes");
  }
  const query = input.query.trim();
  if (Buffer.byteLength(query, "utf8") > MAX_SYMBOL_QUERY_BYTES) {
    throw new GraphSymbolSearchRequestError(413, `graph symbol search query exceeds ${MAX_SYMBOL_QUERY_BYTES} bytes`);
  }
  if (input.mode !== "map" && input.mode !== "logic") {
    throw new GraphSymbolSearchRequestError(400, "graph symbol search mode must be 'map' or 'logic'");
  }
  if (input.scope !== "public" && input.scope !== "all" && input.scope !== "private") {
    throw new GraphSymbolSearchRequestError(400, "unknown graph symbol search scope");
  }
  return { version: GRAPH_SYMBOL_SEARCH_VERSION, query, mode: input.mode, scope: input.scope };
}

export class GraphProjectionRequestError extends Error {
  constructor(readonly status: 400 | 413, message: string) {
    super(message);
    this.name = "GraphProjectionRequestError";
  }
}

export class GraphSymbolSearchRequestError extends Error {
  constructor(readonly status: 400 | 413, message: string) {
    super(message);
    this.name = "GraphSymbolSearchRequestError";
  }
}

function writeNodeShard(root: string, shard: number, nodes: GraphNode[]): void {
  if (nodes.length === 0) return;
  const dataPath = join(root, "nodes", `${hex(shard)}.ndjson`);
  const pages: SliceRef[] = [];
  const byId: Record<string, number> = {};
  const writer = openLineWriter(dataPath);
  try {
    for (let offset = 0; offset < nodes.length; offset += NODE_PAGE_ENTRIES) {
      const page = nodes.slice(offset, offset + NODE_PAGE_ENTRIES);
      const pageNumber = pages.length;
      const ref = appendJsonLine(writer, page);
      pages.push(ref);
      for (const node of page) byId[node.id] = pageNumber;
    }
  } finally {
    closeSync(writer.descriptor);
  }
  writeJson(join(root, "nodes", `${hex(shard)}.index.json`), { pages, byId } satisfies NodeShardIndex);
}

function writeHierarchyShards(
  root: string,
  nodes: readonly GraphNode[],
  all: ReadonlyMap<string, GraphHierarchyFact>,
  withoutTests: ReadonlyMap<string, GraphHierarchyFact>,
  reachability: ReachabilityPaintFacts,
): void {
  const byShard = buckets<Array<[string, StoredHierarchyFact]>>();
  for (const node of nodes) {
    const allFact = all.get(node.id);
    if (!allFact) {
      throw new TypeError(`cannot publish graph projection hierarchy: missing fact for ${node.id}`);
    }
    byShard[shardOf(node.id)]!.push([
      node.id,
      {
        all: allFact,
        withoutTests: withoutTests.get(node.id) ?? null,
        reachability: {
          leaf: reachability.leaves[node.id] ?? null,
          container: reachability.containers[node.id] ?? null,
        },
      },
    ]);
  }
  for (let shard = 0; shard < SHARD_COUNT; shard += 1) {
    const entries = byShard[shard]!;
    if (entries.length === 0) continue;
    const writer = openLineWriter(join(root, "hierarchy", `${hex(shard)}.ndjson`));
    const pages: SliceRef[] = [];
    try {
      for (let offset = 0; offset < entries.length; offset += NODE_PAGE_ENTRIES) {
        pages.push(appendJsonLine(writer, entries.slice(offset, offset + NODE_PAGE_ENTRIES)));
      }
    } finally {
      closeSync(writer.descriptor);
    }
    writeJson(
      join(root, "hierarchy", `${hex(shard)}.index.json`),
      { pages } satisfies HierarchyShardIndex,
    );
  }
}

function writeAdjacencyShard<Value>(
  root: string,
  category: AdjacencyCategory,
  shard: number,
  values: Map<string, Value[]>,
  pageEntries: number,
): void {
  if (values.size === 0) return;
  const writer = openLineWriter(join(root, category, `${hex(shard)}.ndjson`));
  const index: AdjacencyShardIndex = {};
  try {
    for (const [key, list] of values) {
      const refs: SliceRef[] = [];
      for (let offset = 0; offset < list.length; offset += pageEntries) {
        refs.push(appendJsonLine(writer, list.slice(offset, offset + pageEntries)));
      }
      index[key] = { count: list.length, refs };
    }
  } finally {
    closeSync(writer.descriptor);
  }
  writeJson(join(root, category, `${hex(shard)}.index.json`), index);
}

function writeEntryModuleShards(root: string, entryModules: readonly string[]): number {
  const byShard = buckets<EntryModuleShardIndex>(() => ({}));
  entryModules.forEach((id, ordinal) => {
    byShard[shardOf(id)]![id] = ordinal;
  });
  for (let shard = 0; shard < SHARD_COUNT; shard += 1) {
    const index = byShard[shard]!;
    if (Object.keys(index).length === 0) continue;
    writeJson(join(root, "entry-modules", `${hex(shard)}.json`), index);
  }
  return entryModules.length;
}

function writeChangedPathShards(root: string, records: ReadonlyMap<string, ChangedPathRecord>): number {
  const byShard = buckets<Array<[string, ChangedPathRecord]>>();
  for (const entry of records) byShard[shardOf(entry[0])]!.push(entry);
  for (let shard = 0; shard < SHARD_COUNT; shard += 1) {
    const entries = byShard[shard]!.sort(([left], [right]) => left.localeCompare(right));
    if (entries.length === 0) continue;
    const writer = openLineWriter(join(root, "changed-paths", `${hex(shard)}.ndjson`));
    const index: ChangedPathShardIndex = {};
    try {
      for (const [filePath, record] of entries) index[filePath] = appendJsonLine(writer, record);
    } finally {
      closeSync(writer.descriptor);
    }
    writeJson(join(root, "changed-paths", `${hex(shard)}.index.json`), index);
  }
  return records.size;
}

function writeFlowShards(root: string, flows: LogicFlows): number {
  const byShard = buckets<Array<[string, LogicFlows[string]]>>();
  for (const [id, flow] of Object.entries(flows)) byShard[shardOf(id)]!.push([id, flow]);
  for (let shard = 0; shard < SHARD_COUNT; shard += 1) {
    const entries = byShard[shard]!;
    if (entries.length === 0) continue;
    const writer = openLineWriter(join(root, "flows", `${hex(shard)}.ndjson`));
    const index: FlowShardIndex = {};
    try {
      for (const [id, flow] of entries) index[id] = appendJsonLine(writer, flow);
    } finally {
      closeSync(writer.descriptor);
    }
    writeJson(join(root, "flows", `${hex(shard)}.index.json`), index);
  }
  return Object.keys(flows).length;
}

function writeListPages(root: string, filename: string, ids: string[]): SliceRef[] {
  if (ids.length === 0) {
    writeFileSync(join(root, filename), "", { mode: 0o600 });
    return [];
  }
  const writer = openLineWriter(join(root, filename));
  const refs: SliceRef[] = [];
  try {
    for (let offset = 0; offset < ids.length; offset += ID_PAGE_ENTRIES) {
      refs.push(appendJsonLine(writer, ids.slice(offset, offset + ID_PAGE_ENTRIES)));
    }
  } finally {
    closeSync(writer.descriptor);
  }
  return refs;
}

function writeSymbolCatalogs(
  root: string,
  nodes: readonly GraphNode[],
  flows: LogicFlows,
): Record<GraphSymbolSearchMode, GraphSymbolCatalogManifest> {
  const map: GraphSymbolEntry[] = [];
  const logic: GraphSymbolEntry[] = [];
  for (const node of nodes) {
    if (!MAP_SYMBOL_KINDS.has(node.kind)) continue;
    const entry = graphSymbolEntry(node, flows[node.id]);
    map.push(entry);
    if (LOGIC_SYMBOL_KINDS.has(node.kind)) logic.push(entry);
  }
  map.sort((left, right) => left.displayName.localeCompare(right.displayName));
  logic.sort((left, right) => {
    const flowRank = Number(right.stepCount !== null) - Number(left.stepCount !== null);
    return flowRank || left.displayName.localeCompare(right.displayName);
  });
  return {
    map: writeSymbolCatalog(root, "map", map),
    logic: writeSymbolCatalog(root, "logic", logic),
  };
}

function writeSymbolCatalog(
  root: string,
  mode: GraphSymbolSearchMode,
  entries: readonly GraphSymbolEntry[],
): GraphSymbolCatalogManifest {
  const refs = writeRecordPages(root, `symbols-${mode}.ndjson`, entries, SYMBOL_PAGE_ENTRIES);
  const privateCount = entries.reduce((count, entry) => count + Number(entry.isPrivateMethod), 0);
  return {
    count: entries.length,
    refs,
    scopeCounts: {
      public: entries.length - privateCount,
      all: entries.length,
      private: privateCount,
    },
  };
}

function writeRecordPages<Value>(
  root: string,
  filename: string,
  values: readonly Value[],
  pageEntries: number,
): SliceRef[] {
  if (values.length === 0) {
    writeFileSync(join(root, filename), "", { mode: 0o600 });
    return [];
  }
  const writer = openLineWriter(join(root, filename));
  const refs: SliceRef[] = [];
  try {
    for (let offset = 0; offset < values.length; offset += pageEntries) {
      refs.push(appendJsonLine(writer, values.slice(offset, offset + pageEntries)));
    }
  } finally {
    closeSync(writer.descriptor);
  }
  return refs;
}

function graphSymbolEntry(node: GraphNode, flow: LogicFlows[string] | undefined): GraphSymbolEntry {
  const file = node.location?.file ?? "";
  for (const [label, value, maxBytes] of [
    ["id", node.id, MAX_SYMBOL_FIELD_BYTES],
    ["displayName", node.displayName, MAX_SYMBOL_FIELD_BYTES],
    ["qualifiedName", node.qualifiedName, MAX_SYMBOL_FIELD_BYTES],
    ["file", file, MAX_INDEXED_FILE_PATH_BYTES],
    ["kind", node.kind, MAX_SYMBOL_FIELD_BYTES],
  ] as const) {
    if (typeof value !== "string" || value.includes("\0") || Buffer.byteLength(value, "utf8") > maxBytes) {
      throw new TypeError(`cannot publish graph symbol catalog: ${label} is invalid or exceeds ${maxBytes} bytes`);
    }
  }
  return {
    id: node.id,
    displayName: node.displayName,
    qualifiedName: node.qualifiedName,
    file,
    kind: node.kind,
    isPrivateMethod: node.kind === "method" && node.displayName.startsWith("__"),
    stepCount: Array.isArray(flow)
      ? flow.filter((step) => (step as { kind?: unknown }).kind !== "exit").length
      : null,
  };
}

interface LineWriter {
  descriptor: number;
  offset: number;
}

function openLineWriter(path: string): LineWriter {
  return { descriptor: openSync(path, "wx", 0o600), offset: 0 };
}

function appendJsonLine(writer: LineWriter, value: unknown): SliceRef {
  const buffer = Buffer.from(JSON.stringify(value), "utf8");
  const offset = writer.offset;
  writeSync(writer.descriptor, buffer);
  writeSync(writer.descriptor, Buffer.from("\n"));
  writer.offset += buffer.byteLength + 1;
  return { offset, length: buffer.byteLength };
}

function writeJson(path: string, value: unknown): number {
  const buffer = Buffer.from(JSON.stringify(value), "utf8");
  writeFileSync(path, buffer, { flag: "wx", mode: 0o600 });
  return buffer.byteLength;
}

function buckets<Value>(factory: () => Value = () => [] as unknown as Value): Value[] {
  return Array.from({ length: SHARD_COUNT }, factory);
}

function append<Value>(map: Map<string, Value[]>, key: string, value: Value): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function shardOf(id: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < id.length; index += 1) {
    hash ^= id.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash & 0xff;
}

function shardName(id: string): string {
  return hex(shardOf(id));
}

function hex(value: number): string {
  return value.toString(16).padStart(2, "0");
}

function normalizedIds(
  values: readonly string[],
  limit: number,
  label: string,
  maxTotalBytes = Number.MAX_SAFE_INTEGER,
): string[] {
  if (!Array.isArray(values) || values.length > limit) {
    throw new GraphProjectionRequestError(413, `${label} exceeds its limit`);
  }
  const result = new Set<string>();
  let totalBytes = 0;
  for (const value of values) {
    if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value) > MAX_ID_BYTES || value.includes("\0")) {
      throw new GraphProjectionRequestError(400, `${label} contains an invalid graph id`);
    }
    totalBytes += Buffer.byteLength(value, "utf8");
    if (totalBytes > maxTotalBytes) {
      throw new GraphProjectionRequestError(413, `${label} exceeds its byte limit`);
    }
    result.add(value);
  }
  return [...result].sort();
}

function normalizedFilePaths(values: readonly string[]): string[] {
  if (!Array.isArray(values) || values.length > MAX_FILE_PATHS) {
    throw new GraphProjectionRequestError(413, "filePaths exceeds its limit");
  }
  let totalBytes = 0;
  const result = new Set<string>();
  for (const value of values) {
    const canonical = storedFilePath(value);
    if (typeof value !== "string"
      || Buffer.byteLength(value) > MAX_REQUEST_FILE_PATH_BYTES
      || canonical === null
      || canonical !== value) {
      throw new GraphProjectionRequestError(400, "filePaths contains a non-canonical file path");
    }
    totalBytes += Buffer.byteLength(value);
    if (totalBytes > MAX_FILE_PATHS_BYTES) {
      throw new GraphProjectionRequestError(413, "filePaths exceeds its byte limit");
    }
    result.add(value);
  }
  return [...result].sort();
}

/** Normalize extractor paths for the disk index; request paths must already equal this form. */
function storedFilePath(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) return null;
  const normalized = value.replace(/\\/g, "/");
  if (Buffer.byteLength(normalized) > MAX_INDEXED_FILE_PATH_BYTES
    || normalized.startsWith("/")
    || /^[A-Za-z]:/.test(normalized)
    || normalized.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    return null;
  }
  return normalized;
}

function knownEntryModules(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const result = new Set<string>();
  for (const id of value) {
    if (typeof id === "string" && id.length > 0 && !id.includes("\0") && Buffer.byteLength(id) <= MAX_ID_BYTES) {
      result.add(id);
    }
  }
  return [...result];
}

function knownLogicFlows(value: unknown): LogicFlows {
  if (!isJsonObject(value)) return {};
  const result: LogicFlows = {};
  for (const [id, flow] of Object.entries(value)) {
    if (id.length === 0 || id.includes("\0") || Buffer.byteLength(id) > MAX_ID_BYTES || !Array.isArray(flow)) continue;
    result[id] = flow as unknown as LogicFlows[string];
  }
  return result;
}

function knownChangedSince(value: unknown): {
  meta: GraphProjectionChangedSinceMeta;
  records: Map<string, ChangedPathRecord>;
} {
  if (value === undefined) return { meta: {}, records: new Map() };
  if (!isJsonObject(value)) invalidChangedSince("must be an object");
  const meta = validatedChangedMeta(value) ?? {};
  if (value.baseRef !== undefined && meta.baseRef === undefined) invalidChangedSince("baseRef is invalid");
  if (value.source !== undefined && meta.source === undefined) invalidChangedSince("source is invalid");
  const records = new Map<string, ChangedPathRecord>();
  const changed = value;
  const recordFor = (filePath: string): ChangedPathRecord => {
    const current = records.get(filePath);
    if (current) return current;
    const created: ChangedPathRecord = {};
    records.set(filePath, created);
    return created;
  };
  const copyMap = (field: "files" | "stats" | "kinds" | "diffLines"): void => {
    if (changed[field] === undefined) return;
    if (!isJsonObject(changed[field])) invalidChangedSince(`${field} must be an object`);
    const source = changed[field];
    for (const [rawPath, payload] of Object.entries(source)) {
      const filePath = storedFilePath(rawPath);
      const sanitized = sanitizeChangedField(field, payload);
      if (filePath === null) invalidChangedSince(`${field} contains a non-canonical file path`);
      if (sanitized === null) invalidChangedSince(`${field}.${rawPath} is malformed`);
      recordFor(filePath)[field] = sanitized;
    }
  };
  copyMap("files");
  copyMap("stats");
  copyMap("kinds");
  copyMap("diffLines");

  const manifest = changed.manifest === undefined ? [] : canonicalChangedManifest(changed.manifest);
  if (manifest === null) invalidChangedSince("manifest is malformed");
  for (const entry of manifest) {
    const filePath = storedFilePath(entry.path);
    if (filePath === null) continue;
    appendManifest(recordFor(filePath), entry);
    if (entry.previousPath !== undefined) {
      const previousPath = storedFilePath(entry.previousPath);
      if (previousPath !== null) appendManifest(recordFor(previousPath), entry);
    }
  }
  return { meta, records };
}

function invalidChangedSince(reason: string): never {
  throw new TypeError(`cannot publish graph projection bundle: extensions.changedSince ${reason}`);
}

function appendManifest(record: ChangedPathRecord, entry: ChangedFileManifestEntry): void {
  const manifests = (record.manifests ??= []);
  if (!manifests.some((candidate) => candidate.path === entry.path)) manifests.push(entry);
}

function validatedChangedMeta(value: unknown): GraphProjectionChangedSinceMeta | null {
  if (!isJsonObject(value)) return null;
  if ((value.baseRef !== undefined && !boundedExtensionLabel(value.baseRef))
    || (value.source !== undefined && !boundedExtensionLabel(value.source))) return null;
  const meta: GraphProjectionChangedSinceMeta = {};
  if (boundedExtensionLabel(value.baseRef)) meta.baseRef = value.baseRef;
  if (boundedExtensionLabel(value.source)) meta.source = value.source;
  return meta;
}

function boundedExtensionLabel(value: unknown): value is string {
  return typeof value === "string" && !value.includes("\0") && Buffer.byteLength(value) <= MAX_EXTENSION_LABEL_BYTES;
}

function validatedChangedPathRecord(value: unknown): ChangedPathRecord | null {
  if (!isJsonObject(value)) return null;
  const record: ChangedPathRecord = {};
  for (const field of ["files", "stats", "kinds", "diffLines"] as const) {
    if (value[field] === undefined) continue;
    const sanitized = sanitizeChangedField(field, value[field]);
    if (sanitized === null) return null;
    record[field] = sanitized;
  }
  if (value.manifests !== undefined) {
    const manifests = canonicalChangedManifest(value.manifests);
    if (manifests === null) return null;
    record.manifests = manifests;
  }
  return record;
}

function sanitizeChangedField(
  field: "files" | "stats" | "kinds" | "diffLines",
  value: unknown,
): JsonValue | null {
  if (field === "stats") {
    if (!isJsonObject(value)
      || !nonNegativeNumber(value.added)
      || !nonNegativeNumber(value.deleted)) return null;
    return { added: value.added, deleted: value.deleted };
  }
  if (!Array.isArray(value)) return null;
  if (field === "files") {
    if (!value.every(isLineRange)) return null;
    return value.map((range) => ({ start: range.start, end: range.end }));
  }
  if (field === "kinds") {
    if (!value.every(isChangedLineSpan)) return null;
    return value.map((span) => ({
      start: span.start,
      end: span.end,
      kind: span.kind,
    }));
  }
  if (!value.every(isChangedDiffLine)) return null;
  return value.map((line) => ({
    kind: line.kind,
    oldLine: line.oldLine,
    newLine: line.newLine,
    beforeNewLine: line.beforeNewLine,
    text: line.text,
    ...(line.noNewline === true ? { noNewline: true } : {}),
  }));
}

function canonicalChangedManifest(value: unknown): ChangedFileManifestEntry[] | null {
  if (!Array.isArray(value)) return null;
  const result: ChangedFileManifestEntry[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (!isJsonObject(raw)
      || typeof raw.path !== "string"
      || storedFilePath(raw.path) !== raw.path
      || !isChangedFileStatus(raw.status)
      || seen.has(raw.path)) return null;
    const entry: ChangedFileManifestEntry = { path: raw.path, status: raw.status };
    if (raw.status === "renamed") {
      if (typeof raw.previousPath !== "string"
        || storedFilePath(raw.previousPath) !== raw.previousPath
        || raw.previousPath === raw.path) return null;
      entry.previousPath = raw.previousPath;
    } else if (raw.previousPath !== undefined) {
      return null;
    }
    seen.add(entry.path);
    result.push(entry);
  }
  return result;
}

function isChangedFileStatus(value: unknown): value is ChangedFileManifestStatus {
  return value === "added" || value === "modified" || value === "deleted" || value === "renamed";
}

function isLineRange(value: unknown): value is { start: number; end: number } {
  return isJsonObject(value)
    && positiveLine(value.start)
    && positiveLine(value.end)
    && value.start <= value.end;
}

function isChangedLineSpan(value: unknown): value is { start: number; end: number; kind: "added" | "modified" | "deleted" } {
  if (!isLineRange(value)) return false;
  const kind = (value as { kind?: unknown }).kind;
  return kind === "added" || kind === "modified" || kind === "deleted";
}

function isChangedDiffLine(value: unknown): value is {
  kind: "added" | "deleted";
  oldLine: number | null;
  newLine: number | null;
  beforeNewLine: number;
  text: string;
  noNewline?: boolean;
} {
  if (!isJsonObject(value)
    || (value.kind !== "added" && value.kind !== "deleted")
    || !positiveLine(value.beforeNewLine)
    || typeof value.text !== "string"
    || (value.noNewline !== undefined && typeof value.noNewline !== "boolean")) return false;
  return value.kind === "added"
    ? value.oldLine === null && positiveLine(value.newLine) && value.beforeNewLine === value.newLine
    : positiveLine(value.oldLine) && value.newLine === null;
}

function positiveLine(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1;
}

function nonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isJsonObject(value: unknown): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredBoundedInteger(value: number, min: number, max: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new GraphProjectionRequestError(400, `${label} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function positiveOrZero(value: number | undefined, fallback: number, label: string): number {
  const effective = value ?? fallback;
  if (!Number.isSafeInteger(effective) || effective < 0) throw new RangeError(`${label} must be a non-negative safe integer`);
  return effective;
}

/** Match projection-response accounting: parsed JSON is charged at 3x its encoded bytes. */
function parsedCacheResidentBytes(encodedBytes: number): number {
  if (!isNonNegativeInteger(encodedBytes)) {
    throw new TypeError("encoded cache bytes must be a non-negative safe integer");
  }
  return Math.min(
    Number.MAX_SAFE_INTEGER,
    Math.max(encodedBytes * 3, encodedBytes + 1_024),
  );
}

function jsonBytes(value: unknown): number {
  return jsonEncodedByteLength(value);
}

function projectionEnvelopeReserveBytes(
  contentId: string,
  projectionId: string,
  request: CanonicalGraphProjectionRequest,
  header: GraphHeader,
  review: ReviewContextFacts | null,
): number {
  return jsonBytes({
    version: GRAPH_PROJECTION_FORMAT_VERSION,
    contentId,
    projectionId,
    request,
    artifact: { ...header, nodes: [], edges: [] },
    hierarchy: { moduleOverviewRootIds: [], nodes: {} },
    viewFacts: { moduleOverview: null, service: null, review },
    analysis: { reachability: null },
    completeness: {
      complete: false,
      reasons: [
        "byte-limit",
        "edge-limit",
        "extension-byte-limit",
        "node-limit",
        "projection-data-unavailable",
      ],
      omittedNodes: Number.MAX_SAFE_INTEGER,
      omittedEdges: Number.MAX_SAFE_INTEGER,
    },
    residentBytes: Number.MAX_SAFE_INTEGER,
  });
}

function flowTargets(value: unknown): string[] {
  const targets = new Set<string>();
  const visit = (candidate: unknown): void => {
    if (Array.isArray(candidate)) {
      candidate.forEach(visit);
      return;
    }
    if (!candidate || typeof candidate !== "object") return;
    for (const [key, child] of Object.entries(candidate)) {
      if (key === "target" && typeof child === "string") targets.add(child);
      else visit(child);
    }
  };
  visit(value);
  return [...targets];
}

function safeRef(value: SliceRef): boolean {
  return Number.isSafeInteger(value.offset) && value.offset >= 0
    && Number.isSafeInteger(value.length) && value.length > 0 && value.length <= DEFAULT_MAX_RESPONSE_BYTES;
}

function hasExactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const canonicalExpected = [...expected].sort();
  return actual.length === canonicalExpected.length
    && actual.every((key, index) => key === canonicalExpected[index]);
}

function isSummary(value: unknown): value is GraphGenerationSummary {
  if (!value || typeof value !== "object") return false;
  const summary = value as Partial<GraphGenerationSummary>;
  return hasExactKeys(summary, ["schemaVersion", "generatedAt", "nodeCount", "edgeCount"])
    && typeof summary.schemaVersion === "string"
    && typeof summary.generatedAt === "string"
    && Number.isSafeInteger(summary.nodeCount) && (summary.nodeCount ?? -1) >= 0
    && Number.isSafeInteger(summary.edgeCount) && (summary.edgeCount ?? -1) >= 0;
}

function isRepositorySummary(value: unknown): value is GraphRepositorySummary {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const summary = value as Partial<GraphRepositorySummary>;
  return hasExactKeys(summary, ["overviewPackageCount", "sourceFileCount", "testSourceFileCount"])
    && Number.isSafeInteger(summary.overviewPackageCount) && (summary.overviewPackageCount ?? -1) >= 0
    && Number.isSafeInteger(summary.sourceFileCount) && (summary.sourceFileCount ?? -1) >= 0
    && Number.isSafeInteger(summary.testSourceFileCount) && (summary.testSourceFileCount ?? -1) >= 0
    && (summary.testSourceFileCount ?? Number.MAX_SAFE_INTEGER) <= (summary.sourceFileCount ?? -1);
}

function isModuleOverviewRoots(
  value: unknown,
): value is GraphProjectionManifest["moduleOverviewRoots"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const roots = value as Partial<GraphProjectionManifest["moduleOverviewRoots"]>;
  return hasExactKeys(roots, ["all", "withoutTests"])
    && isPagedIds(roots.all) && isPagedIds(roots.withoutTests);
}

function isStoredHierarchyFact(value: unknown): value is StoredHierarchyFact {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join("\0") !== "all\0reachability\0withoutTests") return false;
  return isGraphHierarchyFact(record.all)
    && (record.withoutTests === null || isGraphHierarchyFact(record.withoutTests))
    && isStoredReachabilityFact(record.reachability);
}

function isStoredReachabilityFact(value: unknown): value is StoredHierarchyFact["reachability"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join("\0") !== "container\0leaf") return false;
  try {
    parseReachabilityProjectionFacts({
      summary: {
        callables: 0,
        covered: 0,
        indirect: 0,
        uncovered: 0,
        percent: 0,
        testNodes: 0,
        unresolvedFromTests: 0,
      },
      worstRows: [],
      leaves: record.leaf === null ? {} : { fact: record.leaf },
      containers: record.container === null ? {} : { fact: record.container },
    });
    return true;
  } catch {
    return false;
  }
}

function isGraphHierarchyFact(value: unknown): value is GraphHierarchyFact {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const fact = value as Record<string, unknown>;
  if (Object.keys(fact).some((key) => key !== "isTest"
      && key !== "childKindCounts"
      && key !== "descendantSourceFileCount"
      && key !== "ownedSourceFileCount")
    || typeof fact.isTest !== "boolean"
    || !isNonNegativeInteger(fact.descendantSourceFileCount)
    || !isNonNegativeInteger(fact.ownedSourceFileCount)
    || !fact.childKindCounts || typeof fact.childKindCounts !== "object"
    || Array.isArray(fact.childKindCounts)) return false;
  return Object.entries(fact.childKindCounts as Record<string, unknown>)
    .every(([kind, count]) => kind.length > 0 && !kind.includes("\0")
      && Number.isSafeInteger(count) && Number(count) > 0);
}

function isHeader(value: unknown): value is GraphHeader {
  if (!value || typeof value !== "object") return false;
  const header = value as Partial<GraphHeader>;
  const keys = Object.hasOwn(header, "telemetry")
    ? ["schemaVersion", "generatedAt", "generator", "target", "telemetry"]
    : ["schemaVersion", "generatedAt", "generator", "target"];
  return hasExactKeys(header, keys)
    && typeof header.schemaVersion === "string"
    && typeof header.generatedAt === "string"
    && typeof header.generator === "object" && header.generator !== null
    && typeof header.target === "object" && header.target !== null;
}

function isPagedIds(value: unknown): value is PagedIds {
  if (!value || typeof value !== "object") return false;
  const paged = value as Partial<PagedIds>;
  return hasExactKeys(paged, ["count", "refs"])
    && isNonNegativeInteger(paged.count)
    && Array.isArray(paged.refs) && paged.refs.every((ref) => safeRef(ref as SliceRef));
}

function isExtensionManifest(value: unknown): value is GraphProjectionManifest["extensions"] {
  if (!value || typeof value !== "object") return false;
  const extension = value as Partial<GraphProjectionManifest["extensions"]>;
  return hasExactKeys(extension, ["entryModuleCount", "changedPathCount", "changedMetaBytes", "flowCount"])
    && isNonNegativeInteger(extension.entryModuleCount)
    && isNonNegativeInteger(extension.changedPathCount)
    && isNonNegativeInteger(extension.changedMetaBytes)
    && isNonNegativeInteger(extension.flowCount);
}

function isFactManifest(value: unknown): value is GraphProjectionManifest["facts"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const facts = value as Partial<GraphProjectionManifest["facts"]>;
  return Object.keys(value).sort().join("\0")
      === "moduleOverviewBytes\0moduleOverviewWithoutTestsBytes\0reachabilitySummaryBytes\0serviceTopology"
    && isPositiveSafeInteger(facts.moduleOverviewBytes)
    && isPositiveSafeInteger(facts.moduleOverviewWithoutTestsBytes)
    && isServiceTopologySidecarDescriptor(facts.serviceTopology)
    && isPositiveSafeInteger(facts.reachabilitySummaryBytes);
}

function requiredFactSidecarsMatchManifest(
  bundleRoot: string,
  facts: GraphProjectionManifest["facts"],
): boolean {
  return isRegularFileWithBytes(join(bundleRoot, MODULE_OVERVIEW_FILE), facts.moduleOverviewBytes)
    && isRegularFileWithBytes(
      join(bundleRoot, MODULE_OVERVIEW_WITHOUT_TESTS_FILE),
      facts.moduleOverviewWithoutTestsBytes,
    )
    && isRegularFileWithBytes(
      join(bundleRoot, REACHABILITY_SUMMARY_FILE),
      facts.reachabilitySummaryBytes,
    )
    && isRegularFileWithBytes(
      serviceTopologySidecarPath(bundleRoot),
      facts.serviceTopology.bytes,
    );
}

function isRegularFileWithBytes(path: string, expectedBytes: number): boolean {
  const entry = lstatSync(path);
  return entry.isFile() && !entry.isSymbolicLink() && entry.size === expectedBytes;
}

function isSymbolCatalogs(value: unknown): value is GraphProjectionManifest["symbols"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const catalogs = value as Partial<GraphProjectionManifest["symbols"]>;
  return hasExactKeys(catalogs, ["map", "logic"])
    && isSymbolCatalogManifest(catalogs.map) && isSymbolCatalogManifest(catalogs.logic);
}

function isSymbolCatalogManifest(value: unknown): value is GraphSymbolCatalogManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !hasExactKeys(value, ["count", "refs", "scopeCounts"])) return false;
  const catalog = value as Partial<GraphSymbolCatalogManifest>;
  if (!isPagedIds({ count: catalog.count, refs: catalog.refs })) return false;
  const scopeCounts = catalog.scopeCounts;
  return isGraphSymbolScopeCounts(scopeCounts) && scopeCounts.all === catalog.count
    && scopeCounts.public + scopeCounts.private === scopeCounts.all;
}

function isGraphSymbolScopeCounts(value: unknown): value is GraphSymbolSearchScopeCounts {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const counts = value as Partial<GraphSymbolSearchScopeCounts>;
  return hasExactKeys(counts, ["public", "all", "private"])
    && isNonNegativeInteger(counts.public)
    && isNonNegativeInteger(counts.all)
    && isNonNegativeInteger(counts.private);
}

function isGraphSymbolEntry(value: unknown): value is GraphSymbolEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Partial<GraphSymbolEntry>;
  return boundedSymbolField(entry.id)
    && boundedSymbolField(entry.displayName)
    && boundedSymbolField(entry.qualifiedName)
    && boundedSymbolField(entry.file, MAX_INDEXED_FILE_PATH_BYTES)
    && boundedSymbolField(entry.kind)
    && typeof entry.isPrivateMethod === "boolean"
    && (entry.stepCount === null || isNonNegativeInteger(entry.stepCount));
}

function boundedSymbolField(value: unknown, maxBytes = MAX_SYMBOL_FIELD_BYTES): value is string {
  return typeof value === "string" && !value.includes("\0")
    && Buffer.byteLength(value, "utf8") <= maxBytes;
}

function isSymbolInScope(entry: GraphSymbolEntry, scope: GraphSymbolSearchScope): boolean {
  if (scope === "all") return true;
  return scope === "private" ? entry.isPrivateMethod : !entry.isPrivateMethod;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

interface ResidentEntry {
  namespace: string;
  value: unknown;
  residentBytes: number;
}

/**
 * One byte-and-entry LRU for parsed data across any number of immutable bundles.
 * Bundle roots are part of the key so identically named shard pages cannot collide.
 */
export class BoundedGraphProjectionPageCache implements GraphProjectionPageCache {
  private readonly entries = new Map<string, ResidentEntry>();
  private residentBytes = 0;
  private hits = 0;
  private misses = 0;
  private evictions = 0;
  private oversizeSkips = 0;

  private readonly maxBytes: number;
  private readonly maxEntries: number;

  constructor(options: BoundedGraphProjectionPageCacheOptions) {
    this.maxBytes = positiveOrZero(options.maxBytes, 0, "maxBytes");
    this.maxEntries = positiveOrZero(options.maxEntries, 0, "maxEntries");
  }

  get<Value>(namespace: string, key: string): Value | undefined {
    const cacheKey = namespacedCacheKey(namespace, key);
    const entry = this.entries.get(cacheKey);
    if (!entry) {
      this.misses += 1;
      return undefined;
    }
    this.entries.delete(cacheKey);
    this.entries.set(cacheKey, entry);
    this.hits += 1;
    return entry.value as Value;
  }

  set(namespace: string, key: string, value: unknown, residentBytes: number): void {
    if (!isNonNegativeInteger(residentBytes)) {
      throw new TypeError("cache entry residentBytes must be a non-negative safe integer");
    }
    const cacheKey = namespacedCacheKey(namespace, key);
    const previous = this.entries.get(cacheKey);
    if (previous) {
      this.removeResident(cacheKey, previous);
    }
    if (this.maxBytes === 0 || this.maxEntries === 0 || residentBytes > this.maxBytes) {
      this.oversizeSkips += 1;
      return;
    }
    this.entries.set(cacheKey, { namespace, value, residentBytes });
    this.residentBytes += residentBytes;
    while (this.residentBytes > this.maxBytes || this.entries.size > this.maxEntries) {
      const oldest = this.entries.entries().next().value as [string, ResidentEntry] | undefined;
      if (!oldest) break;
      this.removeResident(oldest[0], oldest[1]);
      this.evictions += 1;
    }
  }

  stats(namespace?: string): GraphProjectionCacheStats {
    if (namespace !== undefined) {
      const validNamespace = validCachePart(namespace, "namespace");
      let residentBytes = 0;
      let entries = 0;
      for (const entry of this.entries.values()) {
        if (entry.namespace !== validNamespace) continue;
        residentBytes += entry.residentBytes;
        entries += 1;
      }
      return {
        ...emptyGraphProjectionCacheStats(),
        residentBytes,
        entries,
        trackedNamespaces: entries === 0 ? 0 : 1,
      };
    }
    return {
      residentBytes: this.residentBytes,
      entries: this.entries.size,
      trackedNamespaces: new Set([...this.entries.values()].map((entry) => entry.namespace)).size,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      oversizeSkips: this.oversizeSkips,
    };
  }

  deleteNamespace(namespace: string): void {
    const validNamespace = validCachePart(namespace, "namespace");
    for (const [key, entry] of this.entries) {
      if (entry.namespace === validNamespace) this.removeResident(key, entry);
    }
  }

  clear(): void {
    this.entries.clear();
    this.residentBytes = 0;
    this.hits = 0;
    this.misses = 0;
    this.evictions = 0;
    this.oversizeSkips = 0;
  }

  private removeResident(key: string, entry: ResidentEntry): void {
    this.entries.delete(key);
    this.residentBytes -= entry.residentBytes;
  }
}

function namespacedCacheKey(namespace: string, key: string): string {
  return `${validCachePart(namespace, "namespace")}\0${validCachePart(key, "key")}`;
}

function validCachePart(value: string, label: string): string {
  if (value.length === 0 || value.includes("\0")) {
    throw new TypeError(`cache ${label} must be non-empty and cannot contain NUL`);
  }
  return value;
}

function emptyGraphProjectionCacheStats(): GraphProjectionCacheStats {
  return {
    residentBytes: 0,
    entries: 0,
    trackedNamespaces: 0,
    hits: 0,
    misses: 0,
    evictions: 0,
    oversizeSkips: 0,
  };
}
