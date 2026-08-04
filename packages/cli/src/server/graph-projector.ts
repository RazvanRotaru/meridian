/** Pure projection/index construction. Full artifacts enter only inside the disposable worker. */

import {
  GRAPH_PROJECTION_VERSION,
  GRAPH_SYMBOL_SEARCH_VERSION,
  LOGIC_FLOW_EXTENSION,
  PORTS_EXTENSION,
  REVIEW_FINGERPRINT_EXTENSION,
  TEST_EXECUTION_COVERAGE_EXTENSION,
  changedFileManifestFromExtensions,
  readTestExecutionCoverage,
  reviewFingerprintsFromArtifact,
  type CompactGraphSymbolEntry,
  type GraphArtifact,
  type GraphEdge,
  type GraphNode,
  type GraphProjectionFrontierEntry,
  type GraphProjectionRequestV1,
  type GraphProjectionV1,
  type GraphSymbolSearchResultV1,
  type JsonValue,
  type NodeId,
} from "@meridian/core";

const MODULE_KIND = "module";
// Package nodes may span many files and therefore have no honest single file hydration root.
const SYMBOL_KINDS = new Set([
  "function",
  "method",
  "module",
  "class",
  "interface",
  "typeAlias",
  "object",
]);
const COUPLING_KINDS = new Set([
  "registers",
  "binds",
  "provides",
  "injects",
  "owns",
  "aliases",
  "calls",
  "instantiates",
  "extends",
  "implements",
  "implementedBy",
  "references",
  "renders",
]);
const PROMISE_LIFECYCLE_KINDS = new Set([
  "createsPromise",
  "returnsPromise",
  "awaitsPromise",
  "resolvesPromise",
  "rejectsPromise",
]);
const SEQUENCE_TIMELINE_EXTENSION = "sequenceTimeline";

export interface ProjectCanonicalGraphOptions {
  artifact: GraphArtifact;
  seedArtifact: GraphArtifact;
  request: GraphProjectionRequestV1;
  /** Stable SHA-256 identity of the immutable primary artifact. */
  generation: string;
  /** The critical response horizon. Background prefetch is a separate worker/cache entry. */
  loadedDepth: number;
}

interface ArtifactIndex {
  nodesById: Map<NodeId, GraphNode>;
  modules: GraphNode[];
  modulesByFile: Map<string, GraphNode[]>;
  moduleOf(nodeId: NodeId): NodeId | null;
}

/**
 * Project a deterministic weak file graph. Imports and exact IPC joins decide traversal; all
 * presentation coupling evidence incident to loaded files is retained without expanding traversal.
 */
export function projectCanonicalGraph(options: ProjectCanonicalGraphOptions): GraphProjectionV1 {
  const { artifact, request, seedArtifact, generation } = options;
  const index = buildArtifactIndex(artifact.nodes);
  const rootFileIds = resolveRootFiles(request, seedArtifact, index);
  const provisionalFrontier = provisionalFrontierFileIds(artifact, index);
  const traversal = buildTraversal(index, artifact.edges, provisionalFrontier !== null);
  const horizon = options.loadedDepth;
  const distances = weakBfs(rootFileIds, traversal, horizon);
  const traversedFileIds = index.modules
    .map((node) => node.id)
    .filter((id) => distances.has(id));
  const traversedFiles = new Set(traversedFileIds);
  const loadedNodeIds = new Set<NodeId>();

  // A file is admitted as one indivisible unit: complete declaration subtree plus parent closure.
  for (const node of artifact.nodes) {
    const moduleId = index.moduleOf(node.id);
    if (moduleId !== null && traversedFiles.has(moduleId)) addWithAncestors(node.id, loadedNodeIds, index.nodesById);
  }

  const selectedEdgeIds = new Set<string>();
  const activeChannels = ipcChannelsTouchingLoadedFiles(artifact.edges, index, traversedFiles);
  const activePromises = promisesTouchingLoadedFiles(artifact.edges, index, traversedFiles);
  for (const edge of artifact.edges) {
    const sourceFile = index.moduleOf(edge.source);
    const targetFile = index.moduleOf(edge.target);
    const internal = sourceFile !== null && targetFile !== null
      && traversedFiles.has(sourceFile) && traversedFiles.has(targetFile);
    const incidentPresentationEvidence = COUPLING_KINDS.has(edge.kind)
      && ((sourceFile !== null && traversedFiles.has(sourceFile))
        || (targetFile !== null && traversedFiles.has(targetFile)));
    const incidentImport = edge.kind === "imports"
      && ((sourceFile !== null && traversedFiles.has(sourceFile))
        || (targetFile !== null && traversedFiles.has(targetFile)));
    const activeIpc = (edge.kind === "sends" && activeChannels.has(edge.target))
      || (edge.kind === "handles" && activeChannels.has(edge.source));
    const promiseId = promiseResourceId(edge, index);
    const activePromise = promiseId !== null && activePromises.has(promiseId);
    if (!internal && !incidentPresentationEvidence && !incidentImport && !activeIpc && !activePromise) continue;
    selectedEdgeIds.add(edge.id);
    addWithAncestors(edge.source, loadedNodeIds, index.nodesById);
    if (index.nodesById.has(edge.target)) addWithAncestors(edge.target, loadedNodeIds, index.nodesById);
  }

  const logicFlow = projectedLogicFlow(
    artifact.extensions?.[LOGIC_FLOW_EXTENSION],
    traversedFiles,
    index,
    loadedNodeIds,
  );
  for (const target of flowTargets(logicFlow)) {
    if (index.nodesById.has(target)) addWithAncestors(target, loadedNodeIds, index.nodesById);
  }

  const nodes = artifact.nodes.filter((node) => loadedNodeIds.has(node.id));
  const edges = artifact.edges.filter((edge) => selectedEdgeIds.has(edge.id));
  // Edge evidence may materialize a boundary module as a ghost. The wire contract defines
  // `loadedFileIds` as every represented module, while readiness remains explicit and root-only.
  const loadedFileIds = nodes.filter(isCanonicalFileNode).map((node) => node.id);
  const projected = projectedExtensions(
    artifact.extensions,
    logicFlow,
    index,
    loadedNodeIds,
    reviewFilePaths(seedArtifact),
  );
  const extensions = provisionalFrontier === null
    ? projected
    : normalizePartialProjectionExtensions(projected, request.graphId, generation);
  const readiness = projectionFrontierReadinessForIndexedArtifact(
    index,
    traversedFileIds,
    traversal,
    request.prefetchDepth,
    provisionalFrontier ?? new Set(),
  );

  return {
    version: GRAPH_PROJECTION_VERSION,
    graphId: request.graphId,
    seedGraphId: request.roots.kind === "changed-files" ? request.roots.seedGraphId : request.graphId,
    generation,
    requestedDepth: request.requestedDepth,
    prefetchDepth: request.prefetchDepth,
    loadedDepth: horizon,
    schemaVersion: artifact.schemaVersion,
    generatedAt: artifact.generatedAt,
    generator: artifact.generator,
    target: artifact.target,
    ...(artifact.telemetry === undefined ? {} : { telemetry: artifact.telemetry }),
    ...(extensions === undefined ? {} : { extensions }),
    nodes,
    edges,
    rootFileIds,
    readyFileIds: readiness.readyFileIds,
    loadedFileIds,
    frontier: readiness.frontier,
    counts: {
      full: { nodes: artifact.nodes.length, edges: artifact.edges.length, files: index.modules.length },
      slice: { nodes: nodes.length, edges: edges.length, files: loadedFileIds.length },
    },
  };
}

/**
 * Recompute the exact frontier owned by a union of independently projected file sets. Chunk-local
 * frontier states cannot be combined pointwise: two fragments may each expose the same boundary
 * while their union closes it. This deliberately rebuilds only the bounded artifact's in-memory
 * traversal; it neither reads source files nor performs canonical extraction.
 */
export function recomputeProjectionFrontierReadiness(
  artifact: GraphArtifact,
  traversedFileIds: readonly NodeId[],
  advertisedDepth: number,
): { frontier: GraphProjectionFrontierEntry[]; readyFileIds: NodeId[] } {
  if (!Number.isSafeInteger(advertisedDepth) || advertisedDepth < 0) {
    throw new TypeError("projection frontier depth is invalid");
  }
  if (new Set(traversedFileIds).size !== traversedFileIds.length) {
    throw new TypeError("projection traversed file ids must be unique");
  }
  const index = buildArtifactIndex(artifact.nodes);
  const provisionalFrontier = provisionalFrontierFileIds(artifact, index);
  const traversal = buildTraversal(index, artifact.edges, provisionalFrontier !== null);
  return projectionFrontierReadinessForIndexedArtifact(
    index,
    traversedFileIds,
    traversal,
    advertisedDepth,
    provisionalFrontier ?? new Set(),
  );
}

/** Remove extraction-local selection coordinates before independently produced slices meet in the
 * renderer. The stable logical lineage is identical for the landing artifact and every later
 * exact-revision expansion, while `prInitialGraph` depth/frontier arrays are private child facts. */
function normalizePartialProjectionExtensions(
  extensions: GraphArtifact["extensions"],
  graphId: string,
  generation: string,
): GraphArtifact["extensions"] {
  const normalized = { ...(extensions ?? {}) };
  delete normalized.prInitialGraph;
  normalized.prPartialGraph = { version: 1, graphId, generation };
  return normalized;
}

/** Build the complete compact symbol inventory once, beside the first projection. */
export function indexCanonicalGraphSymbols(
  artifact: GraphArtifact,
  graphId: string,
  generation: string,
): GraphSymbolSearchResultV1 {
  const index = buildArtifactIndex(artifact.nodes);
  const flows = recordValue(artifact.extensions?.[LOGIC_FLOW_EXTENSION]);
  const symbols: CompactGraphSymbolEntry[] = [];
  for (const node of artifact.nodes) {
    if (!SYMBOL_KINDS.has(node.kind)) continue;
    const fileId = index.moduleOf(node.id);
    if (fileId === null) continue;
    const steps = flows?.[node.id];
    symbols.push({
      id: node.id,
      fileId,
      displayName: node.displayName,
      qualifiedName: node.qualifiedName,
      kind: node.kind,
      file: node.location.file,
      isPrivateMethod: node.kind === "method" && node.displayName.startsWith("__"),
      stepCount: Array.isArray(steps)
        ? steps.reduce((count, step) => count + Number(recordValue(step)?.kind !== "exit"), 0)
        : null,
    });
  }
  symbols.sort((left, right) => left.displayName.localeCompare(right.displayName)
    || left.qualifiedName.localeCompare(right.qualifiedName)
    || left.id.localeCompare(right.id));
  return {
    version: GRAPH_SYMBOL_SEARCH_VERSION,
    graphId,
    generation,
    complete: true,
    indexedSymbolCount: symbols.length,
    totalSymbolCount: symbols.length,
    symbols,
  };
}

function resolveRootFiles(
  request: GraphProjectionRequestV1,
  seedArtifact: GraphArtifact,
  index: ArtifactIndex,
): NodeId[] {
  const roots = new Set<NodeId>();
  if (request.roots.kind === "files") {
    for (const id of request.roots.fileIds) {
      const node = index.nodesById.get(id);
      if (node === undefined || !isCanonicalFileNode(node)) {
        throw new TypeError(`projection root is not a canonical file node: ${id}`);
      }
      roots.add(id);
    }
  } else if (request.roots.kind === "file-paths") {
    for (const path of request.roots.paths) {
      for (const moduleNode of index.modulesByFile.get(normalizeArtifactPath(path)) ?? []) {
        roots.add(moduleNode.id);
      }
    }
  } else {
    const manifest = changedFileManifestFromExtensions(seedArtifact.extensions);
    if (manifest === null) throw new TypeError("projection seed graph has no exact changed-file manifest");
    const projectsSeed = request.graphId === request.roots.seedGraphId;
    for (const changed of manifest) {
      if (projectsSeed && changed.status === "deleted") continue;
      if (!projectsSeed && changed.status === "added") continue;
      const path = projectsSeed ? changed.path : changed.previousPath ?? changed.path;
      for (const moduleNode of index.modulesByFile.get(path) ?? []) roots.add(moduleNode.id);
    }
  }
  // Preserve canonical artifact order instead of request/hash iteration order.
  return index.modules.map((node) => node.id).filter((id) => roots.has(id));
}

function buildArtifactIndex(nodes: readonly GraphNode[]): ArtifactIndex {
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const modules = nodes.filter(isCanonicalFileNode);
  const modulesByFile = new Map<string, GraphNode[]>();
  for (const node of modules) {
    const path = normalizeArtifactPath(node.location.file);
    const bucket = modulesByFile.get(path) ?? [];
    bucket.push(node);
    modulesByFile.set(path, bucket);
  }
  const cache = new Map<NodeId, NodeId | null>();
  const moduleOf = (nodeId: NodeId): NodeId | null => {
    if (cache.has(nodeId)) return cache.get(nodeId) ?? null;
    const visited: NodeId[] = [];
    const seen = new Set<NodeId>();
    let node = nodesById.get(nodeId);
    let found: NodeId | null = null;
    while (node !== undefined && !seen.has(node.id)) {
      const cached = cache.get(node.id);
      if (cached !== undefined || cache.has(node.id)) {
        found = cached ?? null;
        break;
      }
      visited.push(node.id);
      seen.add(node.id);
      if (isCanonicalFileNode(node)) {
        found = node.id;
        break;
      }
      node = node.parentId ? nodesById.get(node.parentId) : undefined;
    }
    for (const id of visited) cache.set(id, found);
    return found;
  };
  return { nodesById, modules, modulesByFile, moduleOf };
}

/** Python package initializers are represented by their package node, not a duplicate module.
 * Treat only packages backed by a real `.py` location as file identities; synthetic namespace
 * packages keep their hierarchy-only behavior. */
function isCanonicalFileNode(node: GraphNode): boolean {
  return node.kind === MODULE_KIND
    || (node.kind === "package" && normalizeArtifactPath(node.location.file).endsWith(".py"));
}

function buildTraversal(
  index: ArtifactIndex,
  edges: readonly GraphEdge[],
  selectorBounded: boolean,
): Map<NodeId, Set<NodeId>> {
  const graph = new Map<NodeId, Set<NodeId>>(index.modules.map((node) => [node.id, new Set()]));
  const connect = (left: NodeId | null, right: NodeId | null) => {
    if (left === null || right === null || left === right) return;
    graph.get(left)?.add(right);
    graph.get(right)?.add(left);
  };
  for (const edge of edges) {
    if (edge.kind === "imports" && (edge.resolution ?? "resolved") === "resolved") {
      connect(index.moduleOf(edge.source), index.moduleOf(edge.target));
    }
  }
  const senders = new Map<NodeId, Set<NodeId>>();
  const handlers = new Map<NodeId, Set<NodeId>>();
  for (const edge of edges) {
    if (edge.kind !== "sends" && edge.kind !== "handles") continue;
    // Candidate IPC correlations remain presentation evidence, but they must not make unrelated
    // files adjacent. Only an exact static join is strong enough to expand the projection.
    if ((edge.resolution ?? "resolved") !== "resolved" || (edge.confidence ?? 1) < 1) continue;
    const channel = edge.kind === "sends" ? edge.target : edge.source;
    // The cheap all-file selector owns imports and exact Electron IPC only. Semantic protocols
    // such as HTTP templates and typed RPC remain visible as presentation evidence, but cannot
    // expand (or block readiness for) a bounded provisional projection whose selector never
    // claimed to enumerate their complete endpoint set. Canonical artifacts keep traversing every
    // exact channel exactly as before.
    if (selectorBounded && !selectorProvesChannelProtocol(channel, index)) continue;
    const endpoint = index.moduleOf(edge.kind === "sends" ? edge.source : edge.target);
    if (endpoint === null) continue;
    const target = edge.kind === "sends" ? senders : handlers;
    const bucket = target.get(channel) ?? new Set<NodeId>();
    bucket.add(endpoint);
    target.set(channel, bucket);
  }
  for (const [channel, senderFiles] of senders) {
    for (const sender of senderFiles) {
      for (const handler of handlers.get(channel) ?? []) connect(sender, handler);
    }
  }
  return graph;
}

function weakBfs(
  roots: readonly NodeId[],
  graph: ReadonlyMap<NodeId, ReadonlySet<NodeId>>,
  horizon: number,
): Map<NodeId, number> {
  const distance = new Map<NodeId, number>();
  const queue: NodeId[] = [];
  for (const root of roots) {
    distance.set(root, 0);
    queue.push(root);
  }
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index]!;
    const nextDepth = distance.get(current)! + 1;
    if (nextDepth > horizon) continue;
    const neighbors = [...(graph.get(current) ?? [])].sort();
    for (const neighbor of neighbors) {
      if (distance.has(neighbor)) continue;
      distance.set(neighbor, nextDepth);
      queue.push(neighbor);
    }
  }
  return distance;
}

/** Compute completeness relative to every represented file, rather than borrowing the original
 * root's distance or one component-wide boundary bit. Seed each loaded file adjacent to unloaded
 * traversal state at distance zero, then walk inward over the loaded subgraph. The resulting
 * distance is exactly how many complete neighbour levels that file owns before the first omitted
 * file. A leaf on a different arm of the same component can therefore become actionable even while
 * another arm still has an external frontier. */
function frontierStateForTraversedFiles(
  traversedFiles: ReadonlySet<NodeId>,
  graph: ReadonlyMap<NodeId, ReadonlySet<NodeId>>,
  advertisedDepth: number,
  forcedBoundaryFiles: ReadonlySet<NodeId> = new Set(),
): Map<NodeId, { hasMore: boolean; completeThroughDepth: number }> {
  const distanceFromBoundary = new Map<NodeId, number>();
  const queue: NodeId[] = [];
  for (const fileId of traversedFiles) {
    if (forcedBoundaryFiles.has(fileId)
      || [...(graph.get(fileId) ?? [])].some((neighbor) => !traversedFiles.has(neighbor))) {
      distanceFromBoundary.set(fileId, 0);
      queue.push(fileId);
    }
  }

  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index]!;
    const distance = distanceFromBoundary.get(current)!;
    for (const neighbor of graph.get(current) ?? []) {
      if (!traversedFiles.has(neighbor) || distanceFromBoundary.has(neighbor)) continue;
      distanceFromBoundary.set(neighbor, distance + 1);
      queue.push(neighbor);
    }
  }

  const result = new Map<NodeId, { hasMore: boolean; completeThroughDepth: number }>();
  for (const fileId of traversedFiles) {
    const distance = distanceFromBoundary.get(fileId);
    result.set(fileId, distance === undefined
      ? { hasMore: false, completeThroughDepth: advertisedDepth }
      : { hasMore: true, completeThroughDepth: Math.min(distance, advertisedDepth) });
  }
  return result;
}

function projectionFrontierReadinessForIndexedArtifact(
  index: ArtifactIndex,
  traversedFileIds: readonly NodeId[],
  graph: ReadonlyMap<NodeId, ReadonlySet<NodeId>>,
  advertisedDepth: number,
  forcedBoundaryFiles: ReadonlySet<NodeId>,
): { frontier: GraphProjectionFrontierEntry[]; readyFileIds: NodeId[] } {
  const requested = new Set(traversedFileIds);
  const canonicalFileIds = index.modules
    .map((node) => node.id)
    .filter((fileId) => requested.has(fileId));
  if (canonicalFileIds.length !== requested.size) {
    throw new TypeError("projection traversed id is not a canonical file node");
  }
  const traversedFiles = new Set(canonicalFileIds);
  const frontierByFile = frontierStateForTraversedFiles(
    traversedFiles,
    graph,
    advertisedDepth,
    forcedBoundaryFiles,
  );
  const frontier = canonicalFileIds.map((fileId) => {
    const state = frontierByFile.get(fileId) ?? {
      hasMore: false,
      completeThroughDepth: advertisedDepth,
    };
    return { fileId, ...state };
  });
  // Canvas admission always owes the selected file plus its immediate neighbours. Boundary ghost
  // modules may be represented earlier as edge evidence, but do not become actionable until this
  // relative depth-one proof arrives.
  const readyFileIds = frontier
    .filter(({ completeThroughDepth }) => completeThroughDepth >= 1)
    .map(({ fileId }) => fileId);
  return { frontier, readyFileIds };
}

/** A bounded backing artifact cannot contain edges to files it intentionally omitted. Its exact
 * all-file topology scan therefore carries those known boundary paths explicitly. */
function provisionalFrontierFileIds(
  artifact: GraphArtifact,
  index: ArtifactIndex,
): Set<NodeId> | null {
  const raw = artifact.extensions?.prInitialGraph;
  if (raw === undefined) return null;
  const value = recordValue(raw);
  const selected = provisionalPathSet(value?.selectedFiles);
  const seeds = provisionalPathSet(value?.seedFiles);
  const frontier = provisionalPathSet(value?.frontierFiles);
  if (value?.version !== 1
    || value.complete !== false
    || !Number.isSafeInteger(value.depth)
    || (value.depth as number) < 1
    || (value.depth as number) > 8
    || selected === null
    || seeds === null
    || frontier === null
    || [...seeds].some((path) => !selected.has(path))
    || [...frontier].some((path) => !selected.has(path))) {
    // This marker changes traversal completeness semantics. It is server-owned, so a malformed
    // value must fail the partial projection safely instead of silently suppressing semantic
    // channel traversal on an arbitrary artifact. The caller may retry; no complete fallback runs.
    throw new TypeError("provisional graph boundary metadata is invalid");
  }
  return new Set(index.modules
    .filter((node) => frontier.has(normalizeArtifactPath(node.location.file)))
    .map((node) => node.id));
}

function provisionalPathSet(value: unknown): Set<string> | null {
  if (!Array.isArray(value)) return null;
  const result = new Set<string>();
  for (const path of value) {
    if (typeof path !== "string"
      || path.length === 0
      || path.includes("\0")
      || path.includes("\\")
      || path.startsWith("/")
      || path.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..")
      || result.has(path)) return null;
    result.add(path);
  }
  return result;
}

function selectorProvesChannelProtocol(channelId: NodeId, index: ArtifactIndex): boolean {
  const channel = index.nodesById.get(channelId);
  return channel?.kind === "channel" && channel.id.startsWith("ipc:electron/");
}

function ipcChannelsTouchingLoadedFiles(
  edges: readonly GraphEdge[],
  index: ArtifactIndex,
  loadedFiles: ReadonlySet<NodeId>,
): Set<NodeId> {
  const result = new Set<NodeId>();
  for (const edge of edges) {
    if (edge.kind === "sends" && loadedFiles.has(index.moduleOf(edge.source) ?? "")) result.add(edge.target);
    if (edge.kind === "handles" && loadedFiles.has(index.moduleOf(edge.target) ?? "")) result.add(edge.source);
  }
  return result;
}

/** Promise resources are boundary identities, like IPC channels: touching one loaded file makes
 * its complete lifecycle first-class evidence, but never turns the other endpoint files into BFS
 * neighbours. Those endpoints remain represented ghosts until an ordinary traversal proves them
 * actionable. */
function promisesTouchingLoadedFiles(
  edges: readonly GraphEdge[],
  index: ArtifactIndex,
  loadedFiles: ReadonlySet<NodeId>,
): Set<NodeId> {
  const result = new Set<NodeId>();
  for (const edge of edges) {
    const promiseId = promiseResourceId(edge, index);
    if (promiseId === null) continue;
    const sourceFile = index.moduleOf(edge.source);
    const targetFile = index.moduleOf(edge.target);
    if (
      (sourceFile !== null && loadedFiles.has(sourceFile))
      || (targetFile !== null && loadedFiles.has(targetFile))
    ) {
      result.add(promiseId);
    }
  }
  return result;
}

function promiseResourceId(edge: GraphEdge, index: ArtifactIndex): NodeId | null {
  if (!PROMISE_LIFECYCLE_KINDS.has(edge.kind)) return null;
  if (index.nodesById.get(edge.source)?.kind === "promise") return edge.source;
  if (index.nodesById.get(edge.target)?.kind === "promise") return edge.target;
  return null;
}

function addWithAncestors(
  nodeId: NodeId,
  result: Set<NodeId>,
  nodesById: ReadonlyMap<NodeId, GraphNode>,
): void {
  const seen = new Set<NodeId>();
  let node = nodesById.get(nodeId);
  while (node !== undefined && !seen.has(node.id)) {
    result.add(node.id);
    seen.add(node.id);
    node = node.parentId ? nodesById.get(node.parentId) : undefined;
  }
}

function projectedLogicFlow(
  value: unknown,
  loadedFiles: ReadonlySet<NodeId>,
  index: ArtifactIndex,
  loadedNodeIds: ReadonlySet<NodeId>,
): JsonValue | undefined {
  if (value === undefined) return undefined;
  const rawFlows = recordValue(value);
  if (rawFlows === null) return value as JsonValue;
  const flows: Record<string, JsonValue> = {};
  for (const [nodeId, value] of Object.entries(rawFlows)) {
    const fileId = index.moduleOf(nodeId);
    if (fileId !== null && loadedFiles.has(fileId) && loadedNodeIds.has(nodeId)) flows[nodeId] = value as JsonValue;
  }
  return flows;
}

function projectedExtensions(
  extensions: GraphArtifact["extensions"],
  logicFlow: JsonValue | undefined,
  index: ArtifactIndex,
  representedNodeIds: ReadonlySet<NodeId>,
  requiredReviewFiles: ReadonlySet<string>,
): GraphArtifact["extensions"] {
  if (extensions === undefined) return undefined;
  const projected = { ...extensions };
  if (Object.hasOwn(extensions, LOGIC_FLOW_EXTENSION) && logicFlow !== undefined) {
    projected[LOGIC_FLOW_EXTENSION] = logicFlow;
  }

  const representedModuleFiles = new Set<string>();
  for (const id of representedNodeIds) {
    const node = index.nodesById.get(id);
    if (node?.kind === MODULE_KIND) representedModuleFiles.add(normalizeArtifactPath(node.location.file));
  }
  const representedReviewFiles = new Set([...requiredReviewFiles, ...representedModuleFiles]);
  const fingerprints = reviewFingerprintsFromArtifact({ extensions });
  if (fingerprints !== null) {
    const units = Object.fromEntries(
      Object.entries(fingerprints.units).filter(([nodeId]) => representedNodeIds.has(nodeId)),
    );
    const files = Object.fromEntries(
      Object.entries(fingerprints.files)
        .filter(([file]) => representedReviewFiles.has(normalizeArtifactPath(file))),
    );
    projected[REVIEW_FINGERPRINT_EXTENSION] = {
      version: fingerprints.version,
      algorithm: fingerprints.algorithm,
      complete: fingerprints.complete,
      units,
      files,
    } as unknown as JsonValue;
  }

  const ports = extensions[PORTS_EXTENSION];
  if (Array.isArray(ports)) {
    projected[PORTS_EXTENSION] = ports.filter((value) => {
      const port = recordValue(value);
      return typeof port?.nodeId === "string" && representedNodeIds.has(port.nodeId);
    }) as JsonValue;
  }

  // Runtime execution coverage is commonly one of the largest repository-wide extensions. The
  // renderer joins it by file, so retaining only represented module files is exact for this slice.
  // A malformed known payload is unusable in the full renderer and is safer to omit than to copy
  // wholesale into every bounded projection.
  delete projected[TEST_EXECUTION_COVERAGE_EXTENSION];
  const executionCoverage = readTestExecutionCoverage(
    { extensions } as GraphArtifact,
    { includeFiles: representedModuleFiles },
  );
  if (executionCoverage !== null) {
    projected[TEST_EXECUTION_COVERAGE_EXTENSION] = {
      version: executionCoverage.version,
      aggregate: executionCoverage.aggregate,
      producer: executionCoverage.producer,
      files: executionCoverage.files,
    } as unknown as JsonValue;
  }

  const sequenceTimelines = recordValue(extensions[SEQUENCE_TIMELINE_EXTENSION]);
  if (sequenceTimelines !== null) {
    projected[SEQUENCE_TIMELINE_EXTENSION] = Object.fromEntries(
      Object.entries(sequenceTimelines).filter(([nodeId]) => representedNodeIds.has(nodeId)),
    ) as JsonValue;
  }
  return projected;
}

function reviewFilePaths(seedArtifact: GraphArtifact): Set<string> {
  const paths = new Set<string>();
  for (const entry of changedFileManifestFromExtensions(seedArtifact.extensions) ?? []) {
    paths.add(normalizeArtifactPath(entry.path));
    if (entry.previousPath !== undefined) paths.add(normalizeArtifactPath(entry.previousPath));
  }
  return paths;
}

function normalizeArtifactPath(path: string): string {
  return process.platform === "win32" ? path.replaceAll("\\", "/") : path;
}

function flowTargets(value: unknown): Set<NodeId> {
  const targets = new Set<NodeId>();
  const queue: unknown[] = [value];
  let visited = 0;
  while (queue.length > 0 && visited < 1_000_000) {
    visited += 1;
    const current = queue.pop();
    if (Array.isArray(current)) {
      for (const item of current) queue.push(item);
      continue;
    }
    const record = recordValue(current);
    if (record === null) continue;
    if (record.kind === "call" && typeof record.target === "string") targets.add(record.target);
    for (const item of Object.values(record)) queue.push(item);
  }
  return targets;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
