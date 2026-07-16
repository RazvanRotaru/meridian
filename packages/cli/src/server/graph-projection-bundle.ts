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
  type GraphArtifact,
  type GraphEdge,
  type GraphNode,
  type JsonValue,
  type LogicFlows,
} from "@meridian/core";
import { graphSummaryFor, type InspectionGraphSummary } from "./inspection-snapshot-store";

export const GRAPH_PROJECTION_DIRECTORY = "graph-projections";
export const GRAPH_PROJECTION_FORMAT_VERSION = 3;
export const GRAPH_SYMBOL_SEARCH_VERSION = 1;
const MANIFEST_FILE = "manifest.json";
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
const MAX_ID_BYTES = 2_048;
const MAX_FILE_PATHS = 512;
const MAX_FILE_PATH_BYTES = 2_048;
const MAX_FILE_PATHS_BYTES = 48 * 1024;
const MAX_EXTENSION_LABEL_BYTES = 2_048;
const MAX_SYMBOL_FIELD_BYTES = 2_048;
const MAX_SYMBOL_QUERY_BYTES = 256;
const MAX_SYMBOL_SEARCH_RESULTS = 40;
const GRAPH_PROJECTION_REQUEST_KEYS = new Set([
  "view",
  "focusIds",
  "expandedIds",
  "extraIds",
  "filePaths",
  "depth",
  "radius",
  "includeTests",
  "maxNodes",
  "maxEdges",
  "maxResponseBytes",
]);
const GRAPH_SYMBOL_SEARCH_REQUEST_KEYS = new Set(["version", "query", "mode", "scope"]);
const MAP_SYMBOL_KINDS = new Set(["function", "method", "module", "package", "class", "interface", "object"]);
const LOGIC_SYMBOL_KINDS = new Set(["function", "method", "module"]);

export type GraphProjectionView =
  | "modules"
  | "call"
  | "ui"
  | "logic"
  | "review";

export interface GraphProjectionRequest {
  view: GraphProjectionView;
  focusIds?: readonly string[];
  expandedIds?: readonly string[];
  extraIds?: readonly string[];
  /** Canonical extraction-root-relative POSIX paths used by the review projection. */
  filePaths?: readonly string[];
  /** Containment levels disclosed below the seed/focus. */
  depth?: number;
  /** Incoming/outgoing relationship hops for service/UI/composition views. */
  radius?: number;
  includeTests?: boolean;
  maxNodes?: number;
  maxEdges?: number;
  maxResponseBytes?: number;
}

export interface CanonicalGraphProjectionRequest {
  view: GraphProjectionView;
  focusIds: string[];
  expandedIds: string[];
  extraIds: string[];
  filePaths: string[];
  depth: number;
  radius: number;
  includeTests: boolean;
  maxNodes: number;
  maxEdges: number;
  maxResponseBytes: number;
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
  graphSummary: InspectionGraphSummary;
  header: GraphHeader;
  shardCount: typeof SHARD_COUNT;
  roots: PagedIds;
  changed: PagedIds;
  symbols: Record<GraphSymbolSearchMode, GraphSymbolCatalogManifest>;
  filePathCount: number;
  extensions: {
    entryModuleCount: number;
    changedPathCount: number;
    changedMetaBytes: number;
    flowCount: number;
  };
}

interface NodeShardIndex {
  pages: SliceRef[];
  byId: Record<string, number>;
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
  projectionId: string;
  request: CanonicalGraphProjectionRequest;
  artifact: GraphArtifact;
  childCounts: Record<string, number>;
  completeness: GraphProjectionCompleteness;
  /** Conservative default weight for the browser's inactive-projection LRU. */
  residentBytes: number;
}

export interface GraphProjectionBundleOptions {
  maxCacheBytes?: number;
  maxCacheEntries?: number;
}

export interface GraphProjectionCacheStats {
  bytes: number;
  entries: number;
  hits: number;
  misses: number;
  evictions: number;
  oversizeSkips: number;
}

/** Write a complete immutable query bundle into an empty/caller-owned directory. */
export function writeGraphProjectionBundle(bundleRoot: string, artifact: GraphArtifact): GraphProjectionManifest {
  const root = resolve(bundleRoot);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  for (const category of [
    "nodes",
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
    header,
    shardCount: SHARD_COUNT,
    roots: { count: roots.length, refs: rootPages },
    changed: { count: changed.length, refs: changedPages },
    symbols,
    filePathCount: indexedFilePaths.size,
    extensions: { entryModuleCount, changedPathCount, changedMetaBytes, flowCount },
  };
  writeJson(join(root, MANIFEST_FILE), manifest);
  return manifest;
}

export function readGraphProjectionManifest(bundleRoot: string): GraphProjectionManifest | null {
  try {
    const path = join(resolve(bundleRoot), MANIFEST_FILE);
    if (statSync(path).size > 256 * 1024) return null;
    const raw = readFileSync(path, "utf8");
    const value = JSON.parse(raw) as Partial<GraphProjectionManifest>;
    if (value.formatVersion !== GRAPH_PROJECTION_FORMAT_VERSION
      || typeof value.contentId !== "string"
      || !/^[0-9a-f]{64}$/.test(value.contentId)
      || value.shardCount !== SHARD_COUNT
      || !isSummary(value.graphSummary)
      || !isHeader(value.header)
      || !isPagedIds(value.roots)
      || !isPagedIds(value.changed)
      || !isSymbolCatalogs(value.symbols)
      || !isNonNegativeInteger(value.filePathCount)
      || !isExtensionManifest(value.extensions)) return null;
    return value as GraphProjectionManifest;
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
  private readonly cache: ResidentLru;

  constructor(bundleRoot: string, options: GraphProjectionBundleOptions = {}) {
    this.root = resolve(bundleRoot);
    const manifest = readGraphProjectionManifest(this.root);
    if (!manifest) throw new Error("graph projection manifest is unavailable or invalid");
    this.manifest = manifest;
    this.cache = new ResidentLru(
      positiveOrZero(options.maxCacheBytes, DEFAULT_CACHE_BYTES, "maxCacheBytes"),
      positiveOrZero(options.maxCacheEntries, DEFAULT_CACHE_ENTRIES, "maxCacheEntries"),
    );
  }

  cacheStats(): GraphProjectionCacheStats {
    return this.cache.stats();
  }

  clearMemoryCache(): void {
    this.cache.clear();
  }

  query(input: GraphProjectionRequest): GraphProjectionResult {
    const request = canonicalizeGraphProjectionRequest(input);
    const projectionId = createHash("sha256")
      .update(`projection-v3\0${this.manifest.contentId}\0${JSON.stringify(request)}`)
      .digest("hex");
    const reasons = new Set<string>();
    let omittedNodes = 0;
    let omittedEdges = 0;
    let retainedBytes = projectionEnvelopeReserveBytes(projectionId, request, this.manifest.header);
    if (retainedBytes > request.maxResponseBytes) {
      throw new GraphProjectionRequestError(413, "graph projection response budget cannot hold its request envelope");
    }
    const nodes = new Map<string, GraphNode>();

    const addNode = (id: string): boolean => {
      if (nodes.has(id)) return true;
      const node = this.node(id);
      if (!node) return false;
      if (!request.includeTests && isTestNode(node)) return false;
      const parentId = node.parentId ?? null;
      if (parentId !== null && !nodes.has(parentId) && !addNode(parentId)) return false;
      // Charge both the node and a conservative childCounts entry. Most nodes have no disclosed
      // children, so this intentionally over-reserves rather than allowing envelope overhead to
      // push the serialized response past maxResponseBytes.
      const bytes = jsonBytes(node) + jsonBytes(id) + 32;
      if (nodes.size >= request.maxNodes || retainedBytes + bytes > request.maxResponseBytes) {
        omittedNodes += 1;
        reasons.add(nodes.size >= request.maxNodes ? "node-limit" : "byte-limit");
        return false;
      }
      nodes.set(id, node);
      retainedBytes += bytes;
      return true;
    };

    const seeds = new Set<string>([...request.focusIds, ...request.extraIds]);
    if (request.view === "review") {
      for (const filePath of request.filePaths) {
        const entry = this.adjacencyEntry("file-nodes", filePath);
        if (!entry) continue;
        for (const id of this.readAdjacencyPages<string>("file-nodes", filePath, entry.refs)) {
          if (seeds.has(id)) continue;
          if (seeds.size >= request.maxNodes) {
            omittedNodes += 1;
            reasons.add("node-limit");
            continue;
          }
          seeds.add(id);
        }
      }
    }
    // An explicit path query that has no nodes is still a complete empty projection (for example,
    // a deleted path on HEAD). Never broaden it to every changed node as an implicit fallback.
    if (seeds.size === 0 && request.filePaths.length === 0) {
      const list = request.view === "review" ? this.manifest.changed : this.manifest.roots;
      for (const id of this.readIdPages(request.view === "review" ? "changed.ndjson" : "roots.ndjson", list.refs)) {
        seeds.add(id);
        if (seeds.size >= request.maxNodes) {
          omittedNodes += Math.max(0, list.count - seeds.size);
          if (list.count > seeds.size) reasons.add("node-limit");
          break;
        }
      }
    }
    for (const id of seeds) addNode(id);

    const disclose = (parents: Iterable<string>, depth: number) => {
      let frontier = [...parents];
      for (let level = 0; level < depth && frontier.length > 0; level += 1) {
        const next: string[] = [];
        for (const parentId of frontier) {
          const entry = this.adjacencyEntry("children", parentId);
          if (!entry) continue;
          let visited = 0;
          for (const child of this.readAdjacencyPages<string>("children", parentId, entry.refs)) {
            visited += 1;
            if (addNode(child)) next.push(child);
            if (nodes.size >= request.maxNodes) break;
          }
          if (visited < entry.count) {
            omittedNodes += entry.count - visited;
            reasons.add("node-limit");
          }
          if (nodes.size >= request.maxNodes) break;
        }
        frontier = next;
      }
    };
    disclose(seeds, request.depth);
    disclose(request.expandedIds, 1);

    if (request.view === "call" || request.view === "ui") {
      let frontier = [...nodes.keys()];
      const visited = new Set(frontier);
      for (let hop = 0; hop < request.radius && frontier.length > 0; hop += 1) {
        const next: string[] = [];
        for (const id of frontier) {
          for (const category of ["out-edges", "in-edges"] as const) {
            for (const edge of this.adjacency<GraphEdge>(category, id)) {
              const peer = edge.source === id ? edge.target : edge.source;
              if (visited.has(peer)) continue;
              visited.add(peer);
              if (addNode(peer)) next.push(peer);
            }
          }
        }
        frontier = next;
      }
    }

    const flows: LogicFlows = {};
    if (request.view === "logic") {
      for (const id of request.focusIds.length > 0 ? request.focusIds : [...seeds]) {
        const flow = this.flow(id);
        if (!flow) continue;
        const flowBytes = jsonBytes(flow) + jsonBytes(id) + 48;
        if (retainedBytes + flowBytes > request.maxResponseBytes) {
          reasons.add("extension-byte-limit");
          continue;
        }
        flows[id] = flow;
        retainedBytes += flowBytes;
        for (const target of flowTargets(flow)) addNode(target);
      }
    }

    const edges: GraphEdge[] = [];
    const edgeIds = new Set<string>();
    for (const source of nodes.keys()) {
      for (const edge of this.adjacency<GraphEdge>("out-edges", source)) {
        if (!nodes.has(edge.target) || edgeIds.has(edge.id)) continue;
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

    const childCounts: Record<string, number> = {};
    for (const id of nodes.keys()) {
      const count = this.adjacencyEntry("children", id)?.count ?? 0;
      if (count > 0) childCounts[id] = count;
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

      const relevantPaths = new Set(request.filePaths);
      for (const node of nodes.values()) {
        const filePath = storedFilePath(node.location?.file);
        if (filePath !== null) relevantPaths.add(filePath);
      }
      const manifestPaths = new Set<string>();
      for (const filePath of [...relevantPaths].sort()) {
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
    const baseResult = { projectionId, request, artifact, childCounts, completeness };
    const residentBytes = Math.min(Number.MAX_SAFE_INTEGER, jsonBytes(baseResult) * 3);
    const result: GraphProjectionResult = {
      projectionId,
      request,
      artifact,
      childCounts,
      completeness,
      residentBytes,
    };
    if (jsonBytes(result) > request.maxResponseBytes) {
      throw new Error("graph projection response exceeded its reserved byte budget");
    }
    return result;
  }

  /** Search the extraction-authored compact catalog without hydrating graph nodes or indexes. Catalog
   * pages share the projection reader's byte/entry-bounded LRU; yielding between page batches lets a
   * disconnected HTTP subscriber cancel a worst-case rare substring scan. */
  async search(
    input: GraphSymbolSearchRequest,
    signal?: AbortSignal,
  ): Promise<GraphSymbolSearchResult> {
    const request = canonicalizeGraphSymbolSearchRequest(input);
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
            contentId: this.manifest.contentId,
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
      contentId: this.manifest.contentId,
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
    return this.readPage<GraphNode[]>(join("nodes", `${shard}.ndjson`), ref)?.find((node) => node.id === id) ?? null;
  }

  private flow(id: string): LogicFlows[string] | null {
    const shard = shardName(id);
    const index = this.readJson<FlowShardIndex>(join("flows", `${shard}.index.json`));
    const ref = index?.[id];
    if (!ref) return null;
    return this.readPage<LogicFlows[string]>(join("flows", `${shard}.ndjson`), ref) ?? null;
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
    yield* this.readAdjacencyPages<Value>(category, id, entry.refs);
  }

  private *readAdjacencyPages<Value>(
    category: AdjacencyCategory,
    id: string,
    refs: readonly SliceRef[],
  ): Generator<Value> {
    const path = join(category, `${shardName(id)}.ndjson`);
    for (const ref of refs) {
      for (const value of this.readPage<Value[]>(path, ref) ?? []) yield value;
    }
  }

  private *readIdPages(path: string, refs: readonly SliceRef[]): Generator<string> {
    for (const ref of refs) {
      for (const id of this.readPage<string[]>(path, ref) ?? []) yield id;
    }
  }

  private readJson<Value>(path: string): Value | null {
    const key = `json:${path}`;
    const cached = this.cache.get<Value>(key);
    if (cached !== undefined) return cached;
    const absolute = join(this.root, path);
    if (!existsSync(absolute)) return null;
    try {
      const size = statSync(absolute).size;
      if (size > DEFAULT_MAX_RESPONSE_BYTES) return null;
      const raw = readFileSync(absolute);
      const value = JSON.parse(raw.toString("utf8")) as Value;
      this.cache.set(key, value, Math.max(raw.byteLength * 2, raw.byteLength + 1_024));
      return value;
    } catch {
      return null;
    }
  }

  private readPage<Value>(path: string, ref: SliceRef): Value | null {
    const key = `page:${path}:${ref.offset}:${ref.length}`;
    const cached = this.cache.get<Value>(key);
    if (cached !== undefined) return cached;
    if (!safeRef(ref)) return null;
    const absolute = join(this.root, path);
    let descriptor: number | undefined;
    try {
      descriptor = openSync(absolute, "r");
      const buffer = Buffer.allocUnsafe(ref.length);
      const read = readSync(descriptor, buffer, 0, ref.length, ref.offset);
      if (read !== ref.length) return null;
      const value = JSON.parse(buffer.toString("utf8")) as Value;
      this.cache.set(key, value, Math.max(buffer.byteLength * 2, buffer.byteLength + 1_024));
      return value;
    } catch {
      return null;
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  }
}

export function canonicalizeGraphProjectionRequest(input: GraphProjectionRequest): CanonicalGraphProjectionRequest {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new GraphProjectionRequestError(400, "graph projection request must be an object");
  }
  const unknownKey = Object.keys(input).find((key) => !GRAPH_PROJECTION_REQUEST_KEYS.has(key));
  if (unknownKey !== undefined) {
    throw new GraphProjectionRequestError(400, `unknown graph projection request field: ${unknownKey}`);
  }
  const views: readonly GraphProjectionView[] = ["modules", "call", "ui", "logic", "review"];
  if (!views.includes(input.view)) throw new GraphProjectionRequestError(400, "unknown graph projection view");
  if (input.includeTests !== undefined && typeof input.includeTests !== "boolean") {
    throw new GraphProjectionRequestError(400, "includeTests must be a boolean");
  }
  const filePaths = normalizedFilePaths(input.filePaths);
  if (filePaths.length > 0 && input.view !== "review") {
    throw new GraphProjectionRequestError(400, "filePaths are supported only by the review view");
  }
  return {
    view: input.view,
    focusIds: normalizedIds(input.focusIds, MAX_FOCUS_IDS, "focusIds"),
    expandedIds: normalizedIds(input.expandedIds, MAX_EXPANDED_IDS, "expandedIds"),
    extraIds: normalizedIds(input.extraIds, MAX_EXTRA_IDS, "extraIds"),
    filePaths,
    depth: boundedInteger(input.depth, 1, 0, 4, "depth"),
    radius: boundedInteger(input.radius, 1, 0, 3, "radius"),
    includeTests: input.includeTests === true,
    maxNodes: boundedInteger(input.maxNodes, DEFAULT_MAX_NODES, 1, DEFAULT_MAX_NODES, "maxNodes"),
    maxEdges: boundedInteger(input.maxEdges, DEFAULT_MAX_EDGES, 0, DEFAULT_MAX_EDGES, "maxEdges"),
    maxResponseBytes: boundedInteger(
      input.maxResponseBytes,
      DEFAULT_MAX_RESPONSE_BYTES,
      64 * 1024,
      DEFAULT_MAX_RESPONSE_BYTES,
      "maxResponseBytes",
    ),
  };
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
  for (const [label, value] of [
    ["id", node.id],
    ["displayName", node.displayName],
    ["qualifiedName", node.qualifiedName],
    ["file", file],
    ["kind", node.kind],
  ] as const) {
    if (typeof value !== "string" || value.includes("\0") || Buffer.byteLength(value, "utf8") > MAX_SYMBOL_FIELD_BYTES) {
      throw new TypeError(`cannot publish graph symbol catalog: ${label} is invalid or exceeds ${MAX_SYMBOL_FIELD_BYTES} bytes`);
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

function normalizedIds(values: readonly string[] | undefined, limit: number, label: string): string[] {
  if (values === undefined) return [];
  if (!Array.isArray(values) || values.length > limit) {
    throw new GraphProjectionRequestError(413, `${label} exceeds its limit`);
  }
  const result = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value) > MAX_ID_BYTES || value.includes("\0")) {
      throw new GraphProjectionRequestError(400, `${label} contains an invalid graph id`);
    }
    result.add(value);
  }
  return [...result].sort();
}

function normalizedFilePaths(values: readonly string[] | undefined): string[] {
  if (values === undefined) return [];
  if (!Array.isArray(values) || values.length > MAX_FILE_PATHS) {
    throw new GraphProjectionRequestError(413, "filePaths exceeds its limit");
  }
  let totalBytes = 0;
  const result = new Set<string>();
  for (const value of values) {
    const canonical = storedFilePath(value);
    if (typeof value !== "string" || canonical === null || canonical !== value) {
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
  if (Buffer.byteLength(normalized) > MAX_FILE_PATH_BYTES
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

function boundedInteger(value: number | undefined, fallback: number, min: number, max: number, label: string): number {
  const effective = value ?? fallback;
  if (!Number.isSafeInteger(effective) || effective < min || effective > max) {
    throw new GraphProjectionRequestError(400, `${label} must be an integer between ${min} and ${max}`);
  }
  return effective;
}

function positiveOrZero(value: number | undefined, fallback: number, label: string): number {
  const effective = value ?? fallback;
  if (!Number.isSafeInteger(effective) || effective < 0) throw new RangeError(`${label} must be a non-negative safe integer`);
  return effective;
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function projectionEnvelopeReserveBytes(
  projectionId: string,
  request: CanonicalGraphProjectionRequest,
  header: GraphHeader,
): number {
  return jsonBytes({
    projectionId,
    request,
    artifact: { ...header, nodes: [], edges: [] },
    childCounts: {},
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

function isTestNode(node: GraphNode): boolean {
  if (node.tags?.includes("test")) return true;
  const file = node.location?.file ?? "";
  return /(?:^|\/)(?:test|tests|__tests__)(?:\/|$)|\.(?:test|spec)\.[^/]+$/i.test(file);
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

function isSummary(value: unknown): value is InspectionGraphSummary {
  if (!value || typeof value !== "object") return false;
  const summary = value as Partial<InspectionGraphSummary>;
  return typeof summary.schemaVersion === "string"
    && typeof summary.generatedAt === "string"
    && Number.isSafeInteger(summary.nodeCount) && (summary.nodeCount ?? -1) >= 0
    && Number.isSafeInteger(summary.edgeCount) && (summary.edgeCount ?? -1) >= 0;
}

function isHeader(value: unknown): value is GraphHeader {
  if (!value || typeof value !== "object") return false;
  const header = value as Partial<GraphHeader>;
  return typeof header.schemaVersion === "string"
    && typeof header.generatedAt === "string"
    && typeof header.generator === "object" && header.generator !== null
    && typeof header.target === "object" && header.target !== null;
}

function isPagedIds(value: unknown): value is PagedIds {
  if (!value || typeof value !== "object") return false;
  const paged = value as Partial<PagedIds>;
  return isNonNegativeInteger(paged.count)
    && Array.isArray(paged.refs) && paged.refs.every((ref) => safeRef(ref as SliceRef));
}

function isExtensionManifest(value: unknown): value is GraphProjectionManifest["extensions"] {
  if (!value || typeof value !== "object") return false;
  const extension = value as Partial<GraphProjectionManifest["extensions"]>;
  return isNonNegativeInteger(extension.entryModuleCount)
    && isNonNegativeInteger(extension.changedPathCount)
    && isNonNegativeInteger(extension.changedMetaBytes)
    && isNonNegativeInteger(extension.flowCount);
}

function isSymbolCatalogs(value: unknown): value is GraphProjectionManifest["symbols"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const catalogs = value as Partial<GraphProjectionManifest["symbols"]>;
  return isSymbolCatalogManifest(catalogs.map) && isSymbolCatalogManifest(catalogs.logic);
}

function isSymbolCatalogManifest(value: unknown): value is GraphSymbolCatalogManifest {
  if (!isPagedIds(value)) return false;
  const scopeCounts = (value as Partial<GraphSymbolCatalogManifest>).scopeCounts;
  return isGraphSymbolScopeCounts(scopeCounts) && scopeCounts.all === value.count
    && scopeCounts.public + scopeCounts.private === scopeCounts.all;
}

function isGraphSymbolScopeCounts(value: unknown): value is GraphSymbolSearchScopeCounts {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const counts = value as Partial<GraphSymbolSearchScopeCounts>;
  return isNonNegativeInteger(counts.public)
    && isNonNegativeInteger(counts.all)
    && isNonNegativeInteger(counts.private);
}

function isGraphSymbolEntry(value: unknown): value is GraphSymbolEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Partial<GraphSymbolEntry>;
  return boundedSymbolField(entry.id)
    && boundedSymbolField(entry.displayName)
    && boundedSymbolField(entry.qualifiedName)
    && boundedSymbolField(entry.file)
    && boundedSymbolField(entry.kind)
    && typeof entry.isPrivateMethod === "boolean"
    && (entry.stepCount === null || isNonNegativeInteger(entry.stepCount));
}

function boundedSymbolField(value: unknown): value is string {
  return typeof value === "string" && !value.includes("\0")
    && Buffer.byteLength(value, "utf8") <= MAX_SYMBOL_FIELD_BYTES;
}

function isSymbolInScope(entry: GraphSymbolEntry, scope: GraphSymbolSearchScope): boolean {
  if (scope === "all") return true;
  return scope === "private" ? entry.isPrivateMethod : !entry.isPrivateMethod;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

interface ResidentEntry {
  value: unknown;
  bytes: number;
}

class ResidentLru {
  private readonly entries = new Map<string, ResidentEntry>();
  private residentBytes = 0;
  private hits = 0;
  private misses = 0;
  private evictions = 0;
  private oversizeSkips = 0;

  constructor(private readonly maxBytes: number, private readonly maxEntries: number) {}

  get<Value>(key: string): Value | undefined {
    const entry = this.entries.get(key);
    if (!entry) {
      this.misses += 1;
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    this.hits += 1;
    return entry.value as Value;
  }

  set(key: string, value: unknown, bytes: number): void {
    const previous = this.entries.get(key);
    if (previous) {
      this.entries.delete(key);
      this.residentBytes -= previous.bytes;
    }
    if (this.maxBytes === 0 || this.maxEntries === 0 || bytes > this.maxBytes) {
      this.oversizeSkips += 1;
      return;
    }
    this.entries.set(key, { value, bytes });
    this.residentBytes += bytes;
    while (this.residentBytes > this.maxBytes || this.entries.size > this.maxEntries) {
      const oldest = this.entries.entries().next().value as [string, ResidentEntry] | undefined;
      if (!oldest) break;
      this.entries.delete(oldest[0]);
      this.residentBytes -= oldest[1].bytes;
      this.evictions += 1;
    }
  }

  stats(): GraphProjectionCacheStats {
    return {
      bytes: this.residentBytes,
      entries: this.entries.size,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      oversizeSkips: this.oversizeSkips,
    };
  }

  clear(): void {
    this.entries.clear();
    this.residentBytes = 0;
    this.hits = 0;
    this.misses = 0;
    this.evictions = 0;
    this.oversizeSkips = 0;
  }
}
