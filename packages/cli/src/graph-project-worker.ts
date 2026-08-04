/** One-shot child entry for full-artifact projection and symbol indexing. */

import { createHash } from "node:crypto";
import { lstatSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import {
  compareBinaryStrings,
  GRAPH_SYMBOL_SEARCH_VERSION,
  LOGIC_FLOW_EXTENSION,
  PORTS_EXTENSION,
  REVIEW_FINGERPRINT_EXTENSION,
  TEST_EXECUTION_COVERAGE_EXTENSION,
  validateArtifact,
  type GraphArtifact,
  type GraphEdge,
  type GraphNode,
  type GraphProjectionFrontierEntry,
  type GraphProjectionV1,
  type GraphSymbolSearchResultV1,
  type JsonValue,
  type NodeId,
} from "@meridian/core";
import { indexTypeScriptWorkspaceSources } from "@meridian/extractor-typescript";
import { indexPythonWorkspaceSources } from "@meridian/extractor-python";
import {
  indexCanonicalGraphSymbols,
  projectCanonicalGraph,
  recomputeProjectionFrontierReadiness,
} from "./server/graph-projector";
import {
  MAX_PR_PARTIAL_TOPOLOGY_ADJACENCY,
  MAX_PR_PARTIAL_TOPOLOGY_FILES,
  PR_PARTIAL_SOURCE_TOPOLOGY_VERSION,
  filterPrPartialDepthOneSymbols,
  parsePrPartialSourceTopology,
  type PrPartialSourceTopologyV1,
} from "./server/web-pr-partial-topology";
import {
  MAX_GRAPH_PROJECT_OUTPUT_EDGES,
  MAX_GRAPH_PROJECT_OUTPUT_FILES,
  MAX_GRAPH_PROJECT_OUTPUT_NODES,
  MAX_GRAPH_PROJECT_ROOTS,
  MAX_GRAPH_SOURCE_BYTES,
  MAX_GRAPH_SOURCE_FILE_BYTES,
  MAX_GRAPH_SYMBOL_OUTPUT_BYTES,
  MAX_GRAPH_SYMBOL_ENTRIES,
  MAX_GRAPH_TOPOLOGY_OUTPUT_BYTES,
  assertGraphSourceIndexUsage,
  isGraphProjectWorkerRequest,
  remainingGraphSourceIndexLimits,
  type GraphProjectWorkerArtifactInput,
  type GraphProjectWorkerOutputFile,
  type GraphProjectWorkerRequest,
  type GraphProjectWorkerResponse,
  type GraphProjectWorkerResult,
} from "./server/web-graph-project-worker-job";

let finished = false;

if (typeof process.send !== "function") {
  process.exitCode = 1;
} else {
  process.once("message", (value: unknown) => {
    void handleRequest(value);
  });
  process.once("disconnect", () => {
    if (!finished) process.exit(1);
  });
}

async function handleRequest(value: unknown): Promise<void> {
  if (!isGraphProjectWorkerRequest(value)) {
    reply({ type: "error", error: { kind: "invalid", message: "graph projection worker request is invalid" } });
    return;
  }
  try {
    const artifact = readCanonicalArtifact(value.graph);
    requireLogicalGeneration(value, artifact);
    const result = value.type === "merge"
      ? mergeProjectionsToFile(value, artifact)
      : await projectOrIndex(value, artifact);
    reply({ type: "result", result });
  } catch (error) {
    cleanupOutputs(value);
    reply({
      type: "error",
      error: {
        kind: error instanceof TypeError || error instanceof RangeError ? "invalid" : "internal",
        message: safeMessage(error),
      },
    });
  }
}

async function projectOrIndex(
  request: GraphProjectWorkerRequest,
  artifact: GraphArtifact,
): Promise<GraphProjectWorkerResult> {
  return request.type === "project"
    ? projectToFile(request, artifact)
    : symbolsToFile(request, artifact);
}

/**
 * Ordinary artifacts identify their logical generation with their exact bytes. Incremental PR
 * slices are independently serialized derivatives, so they may retain the original exact-revision
 * identity only when the validated artifact carries the server-stamped lineage proof.
 */
function requireLogicalGeneration(request: GraphProjectWorkerRequest, artifact: GraphArtifact): void {
  if (request.generation === request.graph.sha256) return;
  const lineage = artifact.extensions?.prPartialGraph;
  if (
    typeof lineage !== "object"
    || lineage === null
    || Array.isArray(lineage)
    || Object.keys(lineage).sort().join("\0") !== "generation\0graphId\0version"
  ) {
    throw new TypeError("graph projection logical generation has no partial-graph lineage");
  }
  const value = lineage as Record<string, unknown>;
  if (
    value.version !== 1
    || value.graphId !== request.graph.graphId
    || value.generation !== request.generation
  ) {
    throw new TypeError("graph projection partial-graph lineage does not match its request");
  }
}

function projectToFile(
  request: Extract<GraphProjectWorkerRequest, { type: "project" }> | GraphProjectWorkerRequest,
  artifact: GraphArtifact,
): GraphProjectWorkerResult {
  if (request.projection === null
    || request.projectionOutputPath === null
    || request.projectionOutputMaxBytes === null) {
    throw new TypeError("projection coordinates are missing");
  }
  const seedArtifact = request.seedGraph === null
    ? artifact
    : request.seedGraph.path === request.graph.path && request.seedGraph.sha256 === request.graph.sha256
      ? artifact
      : readCanonicalArtifact(request.seedGraph);
  const projection = projectCanonicalGraph({
    artifact,
    seedArtifact,
    request: request.projection,
    generation: request.generation,
    loadedDepth: request.projection.requestedDepth,
  });
  const ready = new Set(projection.readyFileIds);
  const completeThrough = new Map(
    projection.frontier.map((entry) => [entry.fileId, entry.completeThroughDepth]),
  );
  const completeRoots = projection.rootFileIds.filter((fileId) => (
    ready.has(fileId)
    && (completeThrough.get(fileId) ?? -1) >= projection.requestedDepth
  )).length;
  const written = writeJson(
    request.projectionOutputPath,
    projection,
    request.projectionOutputMaxBytes,
  );
  return {
    id: request.id,
    operation: "project",
    graphId: request.graph.graphId,
    generation: request.generation,
    projection: {
      ...written,
      nodes: projection.nodes.length,
      edges: projection.edges.length,
      files: projection.counts.slice.files,
      roots: projection.rootFileIds.length,
      completeRoots,
      loadedDepth: projection.loadedDepth,
    },
    symbols: null,
    topology: null,
  };
}

/**
 * Combine independently verified <=512-root projection files without rerunning any root BFS.
 * Inputs are read one at a time and canonical collections are sorted after every union. Once all
 * traversed file IDs are known, the bounded artifact traversal is rebuilt solely to prove their
 * exact frontier/readiness, keeping the result independent of chunk order and replay.
 */
function mergeProjectionsToFile(
  request: GraphProjectWorkerRequest,
  artifact: GraphArtifact,
): GraphProjectWorkerResult {
  if (request.type !== "merge"
    || request.projection === null
    || request.projection.roots.kind !== "changed-files"
    || request.projectionOutputPath === null
    || request.projectionOutputMaxBytes === null
    || request.projectionInputs === undefined) {
    throw new TypeError("projection merge coordinates are missing");
  }
  let merged: GraphProjectionV1 | null = null;
  const traversedFileIds = new Set<NodeId>();
  for (const input of request.projectionInputs) {
    const chunk = readProjectionChunk(input, request);
    for (const { fileId } of chunk.frontier) traversedFileIds.add(fileId);
    merged = merged === null ? chunk : mergeProjectionPayloadChunks(merged, chunk);
  }
  if (merged === null) throw new TypeError("projection merge requires inputs");
  const readiness = recomputeProjectionFrontierReadiness(
    artifact,
    [...traversedFileIds],
    request.projection.prefetchDepth,
  );
  const projection: GraphProjectionV1 = {
    ...merged,
    seedGraphId: request.projection.roots.seedGraphId,
    requestedDepth: request.projection.requestedDepth,
    prefetchDepth: request.projection.prefetchDepth,
    readyFileIds: readiness.readyFileIds,
    frontier: readiness.frontier,
  };
  const ready = new Set(projection.readyFileIds);
  const completeThrough = new Map(
    projection.frontier.map((entry) => [entry.fileId, entry.completeThroughDepth]),
  );
  const completeRoots = projection.rootFileIds.filter((fileId) => (
    ready.has(fileId)
    && (completeThrough.get(fileId) ?? -1) >= projection.requestedDepth
  )).length;
  const written = writeJson(
    request.projectionOutputPath,
    projection,
    request.projectionOutputMaxBytes,
  );
  return {
    id: request.id,
    operation: "merge",
    graphId: request.graph.graphId,
    generation: request.generation,
    projection: {
      ...written,
      nodes: projection.nodes.length,
      edges: projection.edges.length,
      files: projection.counts.slice.files,
      roots: projection.rootFileIds.length,
      completeRoots,
      loadedDepth: projection.loadedDepth,
    },
    symbols: null,
    topology: null,
  };
}

function readProjectionChunk(
  input: GraphProjectWorkerOutputFile,
  request: GraphProjectWorkerRequest,
): GraphProjectionV1 {
  const projection = request.projection;
  if (projection === null) throw new TypeError("projection merge request is missing coordinates");
  const value = readImmutableJson(input, "graph projection merge input");
  const candidate = recordValue(value);
  if (candidate === null
    || candidate.version !== 1
    || candidate.graphId !== request.graph.graphId
    || candidate.seedGraphId !== request.graph.graphId
    || candidate.generation !== request.generation
    || candidate.requestedDepth !== projection.requestedDepth
    || candidate.prefetchDepth !== projection.prefetchDepth
    || candidate.loadedDepth !== projection.requestedDepth
    || !boundedArray(candidate.nodes, MAX_GRAPH_PROJECT_OUTPUT_NODES)
    || !boundedArray(candidate.edges, MAX_GRAPH_PROJECT_OUTPUT_EDGES)
    || !boundedArray(candidate.rootFileIds, MAX_GRAPH_PROJECT_ROOTS)
    || !boundedArray(candidate.readyFileIds, MAX_GRAPH_PROJECT_OUTPUT_FILES)
    || !boundedArray(candidate.loadedFileIds, MAX_GRAPH_PROJECT_OUTPUT_FILES)
    || !boundedArray(candidate.frontier, MAX_GRAPH_PROJECT_OUTPUT_FILES)) {
    throw new TypeError("graph projection merge input has invalid coordinates");
  }
  const validation = validateArtifact({
    schemaVersion: candidate.schemaVersion,
    generatedAt: candidate.generatedAt,
    generator: candidate.generator,
    target: candidate.target,
    ...(candidate.telemetry === undefined ? {} : { telemetry: candidate.telemetry }),
    nodes: candidate.nodes,
    edges: candidate.edges,
    ...(candidate.extensions === undefined ? {} : { extensions: candidate.extensions }),
  });
  if (!validation.ok || validation.artifact === undefined) {
    throw new TypeError("graph projection merge input has an invalid graph payload");
  }
  const rootFileIds = uniqueStrings(candidate.rootFileIds, "rootFileIds");
  const readyFileIds = uniqueStrings(candidate.readyFileIds, "readyFileIds");
  const loadedFileIds = uniqueStrings(candidate.loadedFileIds, "loadedFileIds");
  const frontier = projectionFrontier(candidate.frontier, projection.prefetchDepth);
  const counts = projectionCounts(candidate.counts);
  if (counts.slice.nodes !== validation.artifact.nodes.length
    || counts.slice.edges !== validation.artifact.edges.length
    || counts.slice.files !== loadedFileIds.length
    || counts.full.nodes < counts.slice.nodes
    || counts.full.edges < counts.slice.edges
    || counts.full.files < counts.slice.files) {
    throw new TypeError("graph projection merge input counts do not match its payload");
  }
  const loaded = new Set(loadedFileIds);
  if (rootFileIds.some((id) => !loaded.has(id)) || readyFileIds.some((id) => !loaded.has(id))) {
    throw new TypeError("graph projection merge input readiness is outside its loaded files");
  }
  return {
    version: 1,
    graphId: request.graph.graphId,
    seedGraphId: request.graph.graphId,
    generation: request.generation,
    requestedDepth: projection.requestedDepth,
    prefetchDepth: projection.prefetchDepth,
    loadedDepth: projection.requestedDepth,
    schemaVersion: validation.artifact.schemaVersion,
    generatedAt: validation.artifact.generatedAt,
    generator: validation.artifact.generator,
    target: validation.artifact.target,
    ...(validation.artifact.telemetry === undefined ? {} : { telemetry: validation.artifact.telemetry }),
    ...(validation.artifact.extensions === undefined ? {} : { extensions: validation.artifact.extensions }),
    nodes: validation.artifact.nodes,
    edges: validation.artifact.edges,
    rootFileIds,
    readyFileIds,
    loadedFileIds,
    frontier,
    counts,
  };
}

function mergeProjectionPayloadChunks(left: GraphProjectionV1, right: GraphProjectionV1): GraphProjectionV1 {
  for (const [name, leftValue, rightValue] of [
    ["graphId", left.graphId, right.graphId],
    ["seedGraphId", left.seedGraphId, right.seedGraphId],
    ["generation", left.generation, right.generation],
    ["requestedDepth", left.requestedDepth, right.requestedDepth],
    ["prefetchDepth", left.prefetchDepth, right.prefetchDepth],
    ["loadedDepth", left.loadedDepth, right.loadedDepth],
    ["schemaVersion", left.schemaVersion, right.schemaVersion],
    ["generatedAt", left.generatedAt, right.generatedAt],
    ["generator", left.generator, right.generator],
    ["target", left.target, right.target],
    ["telemetry", left.telemetry, right.telemetry],
    ["counts.full", left.counts.full, right.counts.full],
  ] as const) {
    if (!isDeepStrictEqual(leftValue, rightValue)) {
      throw new TypeError(`projection chunks have conflicting ${name}`);
    }
  }
  const nodes = mergeCanonicalItems(left.nodes, right.nodes, "node", MAX_GRAPH_PROJECT_OUTPUT_NODES);
  const edges = mergeCanonicalItems(left.edges, right.edges, "edge", MAX_GRAPH_PROJECT_OUTPUT_EDGES);
  const loadedFileIds = sortedUnion(left.loadedFileIds, right.loadedFileIds);
  const extensions = mergeProjectionExtensions(left.extensions, right.extensions);
  return {
    ...left,
    ...(extensions === undefined ? {} : { extensions }),
    nodes,
    edges,
    rootFileIds: sortedUnion(left.rootFileIds, right.rootFileIds),
    // These coordinates are intentionally blank until every input has contributed its traversed
    // file set. The caller then recomputes them once from the bounded canonical traversal.
    readyFileIds: [],
    loadedFileIds,
    frontier: [],
    counts: {
      full: left.counts.full,
      slice: { nodes: nodes.length, edges: edges.length, files: loadedFileIds.length },
    },
  };
}

function mergeCanonicalItems<T extends GraphNode | GraphEdge>(
  left: readonly T[],
  right: readonly T[],
  name: string,
  maximum: number,
): T[] {
  const byId = new Map<string, T>();
  for (const value of [...left, ...right]) {
    const existing = byId.get(value.id);
    if (existing !== undefined && !isDeepStrictEqual(existing, value)) {
      throw new TypeError(`projection chunks have conflicting ${name} ${value.id}`);
    }
    byId.set(value.id, value);
    if (byId.size > maximum) throw new RangeError(`merged projection ${name} limit exceeded`);
  }
  return [...byId.values()].sort((a, b) => compareBinaryStrings(a.id, b.id));
}

function mergeProjectionExtensions(
  left: Record<string, JsonValue> | undefined,
  right: Record<string, JsonValue> | undefined,
): Record<string, JsonValue> | undefined {
  if (left === undefined && right === undefined) return undefined;
  const merged: Record<string, JsonValue> = {};
  for (const key of sortedUnion(Object.keys(left ?? {}), Object.keys(right ?? {}))) {
    const leftValue = left?.[key];
    const rightValue = right?.[key];
    if (leftValue === undefined) merged[key] = rightValue!;
    else if (rightValue === undefined) merged[key] = leftValue;
    else if (key === LOGIC_FLOW_EXTENSION || key === "sequenceTimeline") {
      merged[key] = mergeJsonRecords(leftValue, rightValue, key);
    } else if (key === REVIEW_FINGERPRINT_EXTENSION) {
      merged[key] = mergeReviewFingerprintFragments(leftValue, rightValue);
    } else if (key === PORTS_EXTENSION) {
      merged[key] = mergeJsonArrays(leftValue, rightValue, key);
    } else if (key === TEST_EXECUTION_COVERAGE_EXTENSION) {
      merged[key] = mergeCoverageFragments(leftValue, rightValue);
    } else if (isDeepStrictEqual(leftValue, rightValue)) merged[key] = leftValue;
    else throw new TypeError(`projection chunks have conflicting extension ${key}`);
  }
  return merged;
}

function mergeReviewFingerprintFragments(left: JsonValue, right: JsonValue): JsonValue {
  const a = requiredRecord(left, "reviewFingerprints");
  const b = requiredRecord(right, "reviewFingerprints");
  for (const field of ["version", "algorithm", "complete"]) {
    if (!isDeepStrictEqual(a[field], b[field])) {
      throw new TypeError(`projection chunks have conflicting reviewFingerprints ${field}`);
    }
  }
  return {
    version: a.version as JsonValue,
    algorithm: a.algorithm as JsonValue,
    complete: a.complete as JsonValue,
    units: mergeJsonRecords(a.units as JsonValue, b.units as JsonValue, "reviewFingerprints units"),
    files: mergeJsonRecords(a.files as JsonValue, b.files as JsonValue, "reviewFingerprints files"),
  };
}

function mergeCoverageFragments(left: JsonValue, right: JsonValue): JsonValue {
  const a = requiredRecord(left, "testExecutionCoverage");
  const b = requiredRecord(right, "testExecutionCoverage");
  for (const field of ["version", "aggregate", "producer"]) {
    if (!isDeepStrictEqual(a[field], b[field])) {
      throw new TypeError(`projection chunks have conflicting testExecutionCoverage ${field}`);
    }
  }
  return {
    version: a.version as JsonValue,
    aggregate: a.aggregate as JsonValue,
    producer: a.producer as JsonValue,
    files: mergeJsonRecords(a.files as JsonValue, b.files as JsonValue, "testExecutionCoverage files"),
  };
}

function mergeJsonRecords(left: JsonValue, right: JsonValue, name: string): JsonValue {
  const a = requiredRecord(left, name);
  const b = requiredRecord(right, name);
  const merged: Record<string, JsonValue> = {};
  for (const key of sortedUnion(Object.keys(a), Object.keys(b))) {
    const hasLeft = Object.hasOwn(a, key);
    const hasRight = Object.hasOwn(b, key);
    const leftValue = a[key] as JsonValue;
    const rightValue = b[key] as JsonValue;
    if (hasLeft && hasRight && !isDeepStrictEqual(leftValue, rightValue)) {
      throw new TypeError(`projection chunks have conflicting ${name} entry ${key}`);
    }
    merged[key] = hasLeft ? leftValue : rightValue;
  }
  return merged;
}

function mergeJsonArrays(left: JsonValue, right: JsonValue, name: string): JsonValue {
  if (!Array.isArray(left) || !Array.isArray(right)) throw new TypeError(`${name} must be arrays`);
  const values = new Map<string, JsonValue>();
  for (const value of [...left, ...right]) values.set(JSON.stringify(value), value);
  return [...values.entries()].sort(([a], [b]) => compareBinaryStrings(a, b)).map(([, value]) => value);
}

function sortedUnion(left: readonly string[], right: readonly string[]): string[] {
  return [...new Set([...left, ...right])].sort(compareBinaryStrings);
}

function uniqueStrings(value: unknown[], name: string): string[] {
  if (value.some((item) => typeof item !== "string")) throw new TypeError(`${name} must contain strings`);
  const result = value as string[];
  if (new Set(result).size !== result.length) throw new TypeError(`${name} must be unique`);
  return [...result].sort(compareBinaryStrings);
}

function projectionFrontier(value: unknown[], maximumDepth: number): GraphProjectionFrontierEntry[] {
  const entries = value.map((raw) => {
    const entry = recordValue(raw);
    if (entry === null
      || typeof entry.fileId !== "string"
      || typeof entry.hasMore !== "boolean"
      || !Number.isSafeInteger(entry.completeThroughDepth)
      || (entry.completeThroughDepth as number) < 0
      || (entry.completeThroughDepth as number) > maximumDepth) {
      throw new TypeError("projection frontier entry is invalid");
    }
    return {
      fileId: entry.fileId,
      hasMore: entry.hasMore,
      completeThroughDepth: entry.completeThroughDepth as number,
    };
  });
  if (new Set(entries.map(({ fileId }) => fileId)).size !== entries.length) {
    throw new TypeError("projection frontier entries must be unique");
  }
  return entries.sort((a, b) => compareBinaryStrings(a.fileId, b.fileId));
}

function projectionCounts(value: unknown): GraphProjectionV1["counts"] {
  const counts = recordValue(value);
  const full = recordValue(counts?.full);
  const slice = recordValue(counts?.slice);
  const valid = (candidate: Record<string, unknown> | null) => candidate !== null
    && [candidate.nodes, candidate.edges, candidate.files]
      .every((item) => Number.isSafeInteger(item) && (item as number) >= 0);
  if (!valid(full) || !valid(slice)) throw new TypeError("projection counts are invalid");
  return {
    full: { nodes: full!.nodes as number, edges: full!.edges as number, files: full!.files as number },
    slice: { nodes: slice!.nodes as number, edges: slice!.edges as number, files: slice!.files as number },
  };
}

function requiredRecord(value: unknown, name: string): Record<string, unknown> {
  const record = recordValue(value);
  if (record === null) throw new TypeError(`${name} must be an object`);
  return record;
}

function boundedArray(value: unknown, maximum: number): value is unknown[] {
  return Array.isArray(value) && value.length <= maximum;
}

async function symbolsToFile(
  request: Extract<GraphProjectWorkerRequest, { type: "symbols" }> | GraphProjectWorkerRequest,
  artifact: GraphArtifact,
): Promise<GraphProjectWorkerResult> {
  if (request.symbolOutputPath === null) throw new TypeError("symbol output coordinates are missing");
  if ((request.symbolSourceRoot === null) !== (request.topologyOutputPath === null)) {
    throw new TypeError("source symbol coordinates are incomplete");
  }
  if (request.symbolSourceRoot !== null && request.topologyOutputPath !== null) {
    return sourceSymbolsToFile(request, artifact);
  }
  const symbols = indexCanonicalGraphSymbols(artifact, request.graph.graphId, request.generation);
  const written = writeJson(request.symbolOutputPath, symbols, MAX_GRAPH_SYMBOL_OUTPUT_BYTES);
  return {
    id: request.id,
    operation: "symbols",
    graphId: request.graph.graphId,
    generation: request.generation,
    projection: null,
    symbols: { ...written, count: symbols.symbols.length },
    topology: null,
  };
}

async function sourceSymbolsToFile(
  request: GraphProjectWorkerRequest,
  artifact: GraphArtifact,
): Promise<GraphProjectWorkerResult> {
  if (request.symbolOutputPath === null || request.symbolSourceRoot === null || request.topologyOutputPath === null) {
    throw new TypeError("source symbol coordinates are missing");
  }
  const seeds = provisionalSeedFiles(artifact);
  const typeScriptSeeds = seeds.filter((file) => /\.tsx?$/.test(file));
  const pythonSeeds = seeds.filter((file) => file.endsWith(".py"));
  const typeScript = indexTypeScriptWorkspaceSources({
    root: request.symbolSourceRoot,
    seeds: typeScriptSeeds,
    limits: {
      maxFiles: MAX_PR_PARTIAL_TOPOLOGY_FILES,
      maxSourceBytes: MAX_GRAPH_SOURCE_BYTES,
      maxFileBytes: MAX_GRAPH_SOURCE_FILE_BYTES,
      maxSymbols: MAX_GRAPH_SYMBOL_ENTRIES,
      maxAdjacencyEntries: MAX_PR_PARTIAL_TOPOLOGY_ADJACENCY,
    },
  });
  // The Python child starts only after the in-process TypeScript scan released all source text.
  // Give it the remaining aggregate budget so a mixed repository cannot double any wire/RSS cap.
  const remaining = remainingGraphSourceIndexLimits({
    sourceFileCount: typeScript.sourceFileCount,
    sourceBytes: typeScript.sourceBytes,
    symbolCount: typeScript.symbols.length,
    adjacencyEntries: typeScript.adjacencyEntries,
  });
  const python = await indexPythonWorkspaceSources({
    root: request.symbolSourceRoot,
    seeds: pythonSeeds,
    limits: {
      maxFiles: remaining.maxFiles,
      maxSourceBytes: remaining.maxSourceBytes,
      maxFileBytes: MAX_GRAPH_SOURCE_FILE_BYTES,
      maxSymbols: remaining.maxSymbols,
      maxAdjacencyEntries: remaining.maxAdjacencyEntries,
    },
  });
  assertGraphSourceIndexUsage({
    sourceFileCount: typeScript.sourceFileCount + python.sourceFileCount,
    sourceBytes: typeScript.sourceBytes + python.sourceBytes,
    symbolCount: typeScript.symbols.length + python.symbols.length,
    adjacencyEntries: typeScript.adjacencyEntries + python.adjacencyEntries,
  });
  const indexed = {
    seeds: [...typeScript.seeds, ...python.seeds].sort(compareBinaryStrings),
    symbols: [...typeScript.symbols, ...python.symbols].sort((left, right) => (
      left.displayName.localeCompare(right.displayName)
      || left.qualifiedName.localeCompare(right.qualifiedName)
      || left.id.localeCompare(right.id)
    )),
    topology: [...typeScript.topology, ...python.topology]
      .sort((left, right) => compareBinaryStrings(left.path, right.path)),
    adjacencyEntries: typeScript.adjacencyEntries + python.adjacencyEntries,
  };
  if (!sameStrings(indexed.seeds, seeds)) {
    throw new TypeError("source symbol seeds differ from provisional graph provenance");
  }
  const topology = parsePrPartialSourceTopology({
    version: PR_PARTIAL_SOURCE_TOPOLOGY_VERSION,
    graphId: request.graph.graphId,
    generation: request.generation,
    target: artifact.target,
    changedSinceBaseRef: changedSinceBaseRef(artifact),
    seeds: indexed.seeds,
    files: indexed.topology,
  } satisfies PrPartialSourceTopologyV1, {
    graphId: request.graph.graphId,
    generation: request.generation,
  });
  const searchableSymbols = filterPrPartialDepthOneSymbols(topology, indexed.symbols);
  const symbols: GraphSymbolSearchResultV1 = {
    version: GRAPH_SYMBOL_SEARCH_VERSION,
    graphId: request.graph.graphId,
    generation: request.generation,
    complete: true,
    indexedSymbolCount: searchableSymbols.length,
    totalSymbolCount: searchableSymbols.length,
    symbols: searchableSymbols,
  };
  const symbolFile = writeJson(request.symbolOutputPath, symbols, MAX_GRAPH_SYMBOL_OUTPUT_BYTES);
  const topologyFile = writeJson(request.topologyOutputPath, topology, MAX_GRAPH_TOPOLOGY_OUTPUT_BYTES);
  return {
    id: request.id,
    operation: "symbols",
    graphId: request.graph.graphId,
    generation: request.generation,
    projection: null,
    symbols: { ...symbolFile, count: symbols.symbols.length },
    topology: {
      ...topologyFile,
      files: indexed.topology.length,
      adjacencyEntries: indexed.adjacencyEntries,
    },
  };
}

function provisionalSeedFiles(artifact: GraphArtifact): string[] {
  const marker = recordValue(artifact.extensions?.prInitialGraph);
  if (marker?.version !== 1 || marker.complete !== false || !Array.isArray(marker.seedFiles)) {
    throw new TypeError("source symbols require provisional graph provenance");
  }
  const seeds: string[] = [];
  for (const value of marker.seedFiles) {
    if (typeof value !== "string" || value.length === 0 || seeds.includes(value)) {
      throw new TypeError("provisional graph seed provenance is invalid");
    }
    seeds.push(value);
  }
  return seeds.sort(compareBinaryStrings);
}

function changedSinceBaseRef(artifact: GraphArtifact): string | null {
  const changedSince = recordValue(artifact.extensions?.changedSince);
  return typeof changedSince?.baseRef === "string" && changedSince.baseRef.length > 0
    ? changedSince.baseRef
    : null;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function readCanonicalArtifact(input: GraphProjectWorkerArtifactInput): GraphArtifact {
  const parsed = readImmutableJson(input, "graph projection input");
  const validated = validateArtifact(parsed);
  if (!validated.ok || validated.artifact === undefined) {
    throw new TypeError("graph projection input is not a valid graph artifact");
  }
  return validated.artifact;
}

function readImmutableJson(input: GraphProjectWorkerOutputFile, name: string): unknown {
  const before = lstatSync(input.path);
  if (!before.isFile() || before.size !== input.bytes) throw new TypeError(`${name} changed`);
  const bytes = readFileSync(input.path);
  const after = lstatSync(input.path);
  if (!after.isFile()
    || after.dev !== before.dev
    || after.ino !== before.ino
    || after.size !== before.size
    || after.mtimeMs !== before.mtimeMs
    || after.ctimeMs !== before.ctimeMs
    || digest(bytes) !== input.sha256) {
    throw new TypeError(`${name} failed immutable verification`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new TypeError(`${name} is not valid JSON`);
  }
  return parsed;
}

function writeJson(path: string, value: unknown, maxBytes: number): GraphProjectWorkerOutputFile {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  if (bytes.byteLength === 0 || bytes.byteLength > maxBytes) {
    throw new RangeError("graph projection output exceeded its byte limit");
  }
  writeFileSync(path, bytes, { flag: "wx", mode: 0o600 });
  return { path, bytes: bytes.byteLength, sha256: digest(bytes) };
}

function cleanupOutputs(request: GraphProjectWorkerRequest): void {
  if (request.projectionOutputPath !== null) rmSync(request.projectionOutputPath, { force: true });
  if (request.symbolOutputPath !== null) rmSync(request.symbolOutputPath, { force: true });
  if (request.topologyOutputPath !== null) rmSync(request.topologyOutputPath, { force: true });
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function safeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "graph projection failed";
  return message.slice(0, 1_024);
}

function reply(message: GraphProjectWorkerResponse): void {
  if (finished || typeof process.send !== "function" || !process.connected) {
    process.exitCode = 1;
    return;
  }
  process.send(message, (error) => {
    finished = true;
    process.exitCode = error ? 1 : 0;
    if (process.connected) process.disconnect?.();
  });
}
