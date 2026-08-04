/**
 * Defensive client helpers for the versioned progressive-graph transport.
 *
 * A projection is intentionally not a GraphArtifact: its explicit generation, readiness, frontier,
 * and full-vs-slice counts prevent a partial response from being mistaken for a complete graph. The
 * renderer may convert a validated projection into the artifact-shaped input its existing derives
 * consume, and may union cumulative/disconnected projections from the same immutable generation.
 */

import {
  CHANNEL_KIND,
  GRAPH_PROJECTION_VERSION,
  PORTS_EXTENSION,
  REVIEW_FINGERPRINT_EXTENSION,
  TEST_EXECUTION_COVERAGE_EXTENSION,
  nodeIdSchema,
  readTestExecutionCoverage,
  reviewFingerprintsFromArtifact,
  validateArtifact,
} from "@meridian/core";
import type {
  GraphArtifact,
  GraphEdge,
  GraphNode,
  GraphProjectionCounts,
  GraphProjectionFrontierEntry,
  GraphProjectionRequestV1,
  GraphProjectionV1,
  GraphSymbolSearchResultV1,
  JsonValue,
} from "@meridian/core";
import {
  MAX_GRAPH_SYMBOL_RESPONSE_BYTES,
  parseBoundedGraphSymbolText,
  parseGraphSymbolResult,
  parseGraphSymbolText,
} from "./graphSymbolProtocol";
import type { GraphSymbolWorkerResponse } from "./graphSymbolWorker";
import { readBoundedUtf8Response } from "./boundedUtf8Response";

export { MAX_GRAPH_SYMBOL_RESPONSE_BYTES, MAX_GRAPH_SYMBOLS } from "./graphSymbolProtocol";

export const GRAPH_PROJECT_PATH = "/api/graph/project";
export const GRAPH_PROJECT_WARM_PATH = "/api/graph/project/warm";
export const GRAPH_SYMBOLS_PATH = "/api/graph/symbols";

// Response bounds are deliberately generous enough for a large repository while still rejecting a
// malformed endpoint before Zod or the palette performs unbounded work on attacker-controlled data.
export const MAX_GRAPH_PROJECTION_NODES = 500_000;
export const MAX_GRAPH_PROJECTION_EDGES = 2_000_000;
export const MAX_GRAPH_PROJECTION_FILES = 100_000;
export const MAX_GRAPH_FULL_NODES = 10_000_000;
export const MAX_GRAPH_FULL_EDGES = 50_000_000;
export const MAX_GRAPH_FULL_FILES = 2_000_000;
// A changed-files request is merged server-side and may legitimately return one root/frontier
// record for each selected PR file. This larger response ceiling is selected only when correlating
// such a request; direct parsing and explicit-root responses retain their 10k ceiling.
export const MAX_GRAPH_PROJECTION_ROOTS = 20_000;
export const MAX_GRAPH_PROJECTION_DEPTH = 32;
export const MAX_GRAPH_PROJECTION_RESPONSE_BYTES = 256 * 1024 * 1024;
const MAX_GRAPH_PROJECTION_REQUEST_ROOTS = 512;
const MAX_EXPLICIT_PROJECTION_ROOTS = 10_000;
// A user may explore many disconnected partial slices during one review. Bound their cumulative
// browser residency independently of the per-response protocol ceiling so repeated search/depth
// actions cannot quietly reconstruct a repository-sized graph in memory.
export const MAX_PROGRESSIVE_RESIDENT_NODES = 250_000;
export const MAX_PROGRESSIVE_RESIDENT_EDGES = 1_000_000;
export const MAX_PROGRESSIVE_RESIDENT_FILES = 20_000;

const MAX_ID_CHARS = 2_048;
const MAX_SYMBOL_TEXT_CHARS = 8_192;
const MAX_EXPLICIT_ROOT_BYTES = 4_096;
const MAX_GRAPH_PROJECT_REQUEST_BODY_BYTES = 60_000;
const DUMMY_ORIGIN = "http://meridian.local";
const LOGIC_FLOW_EXTENSION = "logicFlow";
const SEQUENCE_TIMELINE_EXTENSION = "sequenceTimeline";

export class ProgressiveGraphProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProgressiveGraphProtocolError";
  }
}

export interface ProgressiveGraphUrls {
  graphId: string | null;
  projectUrl: string;
  symbolsUrl: string;
}

/** Derive progressive endpoints from the canonical graph URL without carrying unrelated query data. */
export function progressiveGraphUrlsFromGraphUrl(graphUrl: string): ProgressiveGraphUrls {
  if (graphUrl.trim().length === 0) throw protocolError("graph URL is invalid");
  let graph: URL;
  try {
    graph = new URL(graphUrl, DUMMY_ORIGIN);
  } catch {
    throw protocolError("graph URL is invalid");
  }
  if (graph.protocol !== "http:" && graph.protocol !== "https:") {
    throw protocolError("graph URL must use http or https");
  }
  const graphId = nonEmptyQueryValue(graph.searchParams.get("id"));
  const project = endpointAt(graph, GRAPH_PROJECT_PATH);
  const symbols = endpointAt(graph, GRAPH_SYMBOLS_PATH);
  if (graphId !== null) symbols.searchParams.set("id", graphId);
  const relative = graph.origin === DUMMY_ORIGIN;
  return {
    graphId,
    projectUrl: printableUrl(project, relative),
    symbolsUrl: printableUrl(symbols, relative),
  };
}

/** Initial PR admission requests only its actionable depth. `prefetchDepth` advertises the bounded
 * horizon that a later, explicit post-paint warm request may compute without gating admission. */
export function changedFileProjectionRequest(
  graphId: string,
  seedGraphId: string,
  requestedDepth: number,
  prefetchDepth: number,
): GraphProjectionRequestV1 {
  return validateProjectionRequest({
    version: GRAPH_PROJECTION_VERSION,
    graphId,
    roots: { kind: "changed-files", seedGraphId },
    requestedDepth,
    prefetchDepth,
  });
}

/** Request an adjacency projection for search admission or a subsequently expanded frontier. */
export function fileProjectionRequest(
  graphId: string,
  fileIds: readonly string[],
  requestedDepth: number,
  prefetchDepth: number,
): GraphProjectionRequestV1 {
  return validateProjectionRequest({
    version: GRAPH_PROJECTION_VERSION,
    graphId,
    roots: { kind: "files", fileIds: [...fileIds] },
    requestedDepth,
    prefetchDepth,
  });
}

/** Split canonical file roots below both the worker root-count cap and the shared HTTP JSON-body
 * cap. UTF-8 bytes and JSON escaping—not JavaScript string length—decide every boundary. */
export function fileProjectionRequests(
  graphId: string,
  fileIds: readonly string[],
  requestedDepth: number,
  prefetchDepth: number,
): GraphProjectionRequestV1[] {
  return explicitRootProjectionRequests(
    graphId,
    "files",
    fileIds,
    requestedDepth,
    prefetchDepth,
    fileProjectionRequest,
  );
}

/** Resolve exact file paths in the target immutable graph. Unlike canonical node IDs, paths from
 * a comparison graph are coordinates only: the target worker decides whether they still exist and
 * returns target-graph nodes, so stale merge-base nodes can never enter the HEAD artifact. */
export function filePathProjectionRequest(
  graphId: string,
  paths: readonly string[],
  requestedDepth: number,
  prefetchDepth: number,
): GraphProjectionRequestV1 {
  return validateProjectionRequest({
    version: GRAPH_PROJECTION_VERSION,
    graphId,
    roots: { kind: "file-paths", paths: [...paths] },
    requestedDepth,
    prefetchDepth,
  });
}

/** Split exact path roots below both the worker root-count cap and the shared HTTP JSON-body cap. */
export function filePathProjectionRequests(
  graphId: string,
  paths: readonly string[],
  requestedDepth: number,
  prefetchDepth: number,
): GraphProjectionRequestV1[] {
  return explicitRootProjectionRequests(
    graphId,
    "file-paths",
    paths,
    requestedDepth,
    prefetchDepth,
    filePathProjectionRequest,
  );
}

function explicitRootProjectionRequests(
  graphId: string,
  kind: "files" | "file-paths",
  rawItems: readonly string[],
  requestedDepth: number,
  prefetchDepth: number,
  build: (
    graphId: string,
    items: readonly string[],
    requestedDepth: number,
    prefetchDepth: number,
  ) => GraphProjectionRequestV1,
): GraphProjectionRequestV1[] {
  if (rawItems.length === 0) {
    // Preserve the single-request helper's precise protocol error.
    return [build(graphId, rawItems, requestedDepth, prefetchDepth)];
  }
  if (rawItems.length > MAX_EXPLICIT_PROJECTION_ROOTS) {
    throw protocolError(`roots.${kind === "files" ? "fileIds" : "paths"} exceeds ${MAX_EXPLICIT_PROJECTION_ROOTS} entries`);
  }
  // Validate every root and global uniqueness before chunking. Per-chunk validation alone would
  // allow a duplicate split across two otherwise-valid HTTP requests.
  const items = kind === "files"
    ? parseRequestFileIds([...rawItems], "roots.fileIds")
    : parseRequestPaths([...rawItems], "roots.paths");
  const emptyBodyBytes = utf8ByteLength(JSON.stringify({
    version: GRAPH_PROJECTION_VERSION,
    graphId,
    roots: kind === "files"
      ? { kind, fileIds: [] }
      : { kind, paths: [] },
    requestedDepth,
    prefetchDepth,
  }));
  const chunks: string[][] = [];
  let chunk: string[] = [];
  let bodyBytes = emptyBodyBytes;
  for (const item of items) {
    const encodedItemBytes = utf8ByteLength(JSON.stringify(item));
    const itemBytes = encodedItemBytes + Number(chunk.length > 0);
    if (
      chunk.length > 0
      && (
        chunk.length >= MAX_GRAPH_PROJECTION_REQUEST_ROOTS
        || bodyBytes + itemBytes > MAX_GRAPH_PROJECT_REQUEST_BODY_BYTES
      )
    ) {
      chunks.push(chunk);
      chunk = [];
      bodyBytes = emptyBodyBytes;
    }
    if (bodyBytes + encodedItemBytes > MAX_GRAPH_PROJECT_REQUEST_BODY_BYTES) {
      throw protocolError(`one ${kind} projection root exceeds the HTTP request-body limit`);
    }
    bodyBytes += encodedItemBytes + Number(chunk.length > 0);
    chunk.push(item);
  }
  if (chunk.length > 0) chunks.push(chunk);
  return chunks.map((chunkItems) => {
    const request = build(graphId, chunkItems, requestedDepth, prefetchDepth);
    // Keep the batching arithmetic honest if the request schema changes later.
    serializeProjectionRequest(request);
    return request;
  });
}

/** Surviving caller/callee files absent from the current HEAD slice. Deleted-node projection only
 * preserves comparison `calls` edges incident to a proven tombstone, so limit pair hydration to
 * call boundaries crossing a changed comparison root. Other presentation-only boundary modules
 * must not fan out into whole HEAD files on the critical admission path. */
export function comparisonContextPathsMissingFromHead(
  head: GraphProjectionV1,
  comparison: GraphProjectionV1 | null,
): string[] {
  if (comparison === null) return [];
  const headNodesById = new Map(head.nodes.map((node) => [node.id, node]));
  // Frontier membership is the transport's proof that this file was traversed as a complete file
  // unit. Merely seeing its module ancestor in loadedFileIds is insufficient: incident edge
  // evidence may have materialized only that ancestor plus one unrelated boundary declaration.
  const completeHeadPaths = new Set(
    head.frontier
      .map((entry) => headNodesById.get(entry.fileId)?.location.file)
      .filter((path): path is string => path !== undefined),
  );
  const comparisonRoots = new Set(comparison.rootFileIds);
  const nodesById = new Map(comparison.nodes.map((node) => [node.id, node]));
  const fileCache = new Map<string, string | null>();
  const fileOf = (nodeId: string): string | null => {
    if (fileCache.has(nodeId)) return fileCache.get(nodeId) ?? null;
    const visited: string[] = [];
    const seen = new Set<string>();
    let node = nodesById.get(nodeId);
    let result: string | null = null;
    while (node !== undefined && !seen.has(node.id)) {
      const cached = fileCache.get(node.id);
      if (cached !== undefined || fileCache.has(node.id)) {
        result = cached ?? null;
        break;
      }
      visited.push(node.id);
      seen.add(node.id);
      if (isCanonicalProjectionFileNode(node)) {
        result = node.id;
        break;
      }
      node = node.parentId ? nodesById.get(node.parentId) : undefined;
    }
    for (const id of visited) fileCache.set(id, result);
    return result;
  };
  const contextPaths = new Set<string>();
  for (const edge of comparison.edges) {
    if (edge.kind !== "calls") continue;
    const sourceFile = fileOf(edge.source);
    const targetFile = fileOf(edge.target);
    if (sourceFile === null || targetFile === null || sourceFile === targetFile) continue;
    const addMissingEndpoint = (endpointId: string, fileId: string): void => {
      const path = nodesById.get(fileId)?.location.file;
      if (
        path !== undefined
        && !headNodesById.has(endpointId)
        && !completeHeadPaths.has(path)
      ) {
        contextPaths.add(path);
      }
    };
    if (comparisonRoots.has(sourceFile) && !comparisonRoots.has(targetFile)) {
      addMissingEndpoint(edge.target, targetFile);
    }
    if (comparisonRoots.has(targetFile) && !comparisonRoots.has(sourceFile)) {
      addMissingEndpoint(edge.source, sourceFile);
    }
  }
  return [...contextPaths].sort((left, right) => left.localeCompare(right));
}

/** Hydrate surviving comparison context from HEAD before a deleted-node composite is admitted.
 * Requests are bounded and concurrency-limited; a missing path is an honest deletion and produces
 * an empty fragment. These complete HEAD files support tombstone edges but are not user roots, so
 * their root/readiness metadata is removed before merge. Non-root frontier provenance is retained
 * to distinguish a complete file from a boundary ancestor; promoting one still requires the
 * ordinary depth-one node-admission path. */
export async function hydrateHeadProjectionForComparisonContext(
  projectUrl: string,
  head: GraphProjectionV1,
  comparison: GraphProjectionV1 | null,
  options: FetchGraphProjectionOptions = {},
): Promise<GraphProjectionV1> {
  const paths = comparisonContextPathsMissingFromHead(head, comparison);
  if (paths.length === 0) return head;
  const requests = filePathProjectionRequests(head.graphId, paths, 0, 0);
  const fragments = new Array<GraphProjectionV1>(requests.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < requests.length) {
      const index = cursor;
      cursor += 1;
      const fragment = await fetchGraphProjection(
        projectUrl,
        requests[index]!,
        options,
      );
      fragments[index] = parseGraphProjection({
        ...fragment,
        rootFileIds: [],
        readyFileIds: [],
        // Retain full-file provenance. These entries are not roots, so they cannot affect session
        // depth readiness, but they prevent repeated support requests when the old endpoint truly
        // vanished from an otherwise-complete HEAD file.
        frontier: fragment.frontier,
      });
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, requests.length) }, worker));
  return fragments.reduce((merged, fragment) => mergeGraphProjections(merged, fragment), head);
}

export interface FetchGraphProjectionOptions {
  signal?: AbortSignal;
  maxBytes?: number;
  fetchImpl?: typeof fetch;
}

/** Ask the server to populate one immutable projection cache entry without transferring the slice.
 * Callers invoke this only after an actionable paint; failures are advisory and never change the
 * current canvas or its canonical fallback contract. */
export async function warmGraphProjection(
  projectUrl: string,
  request: GraphProjectionRequestV1,
  options: Pick<FetchGraphProjectionOptions, "signal" | "fetchImpl"> = {},
): Promise<void> {
  const checkedRequest = validateProjectionRequest(request);
  const body = serializeProjectionRequest(checkedRequest);
  const project = endpointAt(new URL(projectUrl, requestOrigin()), GRAPH_PROJECT_WARM_PATH);
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(project, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body,
    signal: options.signal,
  });
  if (!response.ok) {
    throw new Error(`graph projection warm failed (${response.status}) from ${project.pathname}`);
  }
}

/** POST one bounded request and correlate the response before exposing it to state. */
export async function fetchGraphProjection(
  projectUrl: string,
  request: GraphProjectionRequestV1,
  options: FetchGraphProjectionOptions = {},
): Promise<GraphProjectionV1> {
  const checkedRequest = validateProjectionRequest(request);
  const body = serializeProjectionRequest(checkedRequest);
  const maxBytes = options.maxBytes ?? MAX_GRAPH_PROJECTION_RESPONSE_BYTES;
  requirePositiveByteLimit(maxBytes);
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(new URL(projectUrl, requestOrigin()), {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body,
    signal: options.signal,
  });
  if (!response.ok) {
    throw new Error(`graph projection fetch failed (${response.status}) from ${projectUrl}`);
  }
  const text = await readBoundedUtf8Response(response, maxBytes, "graph projection", protocolError);
  const projection = parseBoundedGraphProjectionResponse(
    text,
    checkedRequest.roots.kind === "changed-files"
      ? MAX_GRAPH_PROJECTION_ROOTS
      : MAX_EXPLICIT_PROJECTION_ROOTS,
  );
  const expectedSeedGraphId = checkedRequest.roots.kind === "changed-files"
    ? checkedRequest.roots.seedGraphId
    : checkedRequest.graphId;
  if (
    projection.graphId !== checkedRequest.graphId
    || projection.seedGraphId !== expectedSeedGraphId
    || projection.requestedDepth !== checkedRequest.requestedDepth
    || projection.prefetchDepth !== checkedRequest.prefetchDepth
  ) {
    throw protocolError("graph projection response does not match its request");
  }
  return projection;
}

export function parseGraphProjectionResponse(
  text: string,
  maxBytes = MAX_GRAPH_PROJECTION_RESPONSE_BYTES,
): GraphProjectionV1 {
  requirePositiveByteLimit(maxBytes);
  if (utf8ByteLength(text) > maxBytes) {
    throw protocolError(`graph projection response exceeds ${maxBytes} bytes`);
  }
  return parseBoundedGraphProjectionResponse(text, MAX_EXPLICIT_PROJECTION_ROOTS);
}

function parseBoundedGraphProjectionResponse(text: string, maxRoots: number): GraphProjectionV1 {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw protocolError("graph projection response is not valid JSON");
  }
  return parseGraphProjectionWithRootLimit(value, maxRoots);
}

/** Parse, bound, and cross-check a graph projection before any renderer state sees it. */
export function parseGraphProjection(value: unknown): GraphProjectionV1 {
  return parseGraphProjectionWithRootLimit(value, MAX_EXPLICIT_PROJECTION_ROOTS);
}

function parseGraphProjectionWithRootLimit(value: unknown, maxRoots: number): GraphProjectionV1 {
  const candidate = requireRecord(value, "graph projection");
  requireExactVersion(candidate.version, GRAPH_PROJECTION_VERSION, "graph projection");
  const graphId = requireBoundedString(candidate.graphId, "graphId", MAX_ID_CHARS);
  const seedGraphId = requireBoundedString(candidate.seedGraphId, "seedGraphId", MAX_ID_CHARS);
  const generation = requireBoundedString(candidate.generation, "generation", MAX_ID_CHARS);
  const requestedDepth = requireBoundedInteger(
    candidate.requestedDepth,
    "requestedDepth",
    0,
    MAX_GRAPH_PROJECTION_DEPTH,
  );
  const prefetchDepth = requireBoundedInteger(
    candidate.prefetchDepth,
    "prefetchDepth",
    requestedDepth,
    MAX_GRAPH_PROJECTION_DEPTH,
  );
  const loadedDepth = requireBoundedInteger(
    candidate.loadedDepth,
    "loadedDepth",
    0,
    prefetchDepth,
  );

  const rawNodes = requireBoundedArray(candidate.nodes, "nodes", MAX_GRAPH_PROJECTION_NODES);
  const rawEdges = requireBoundedArray(candidate.edges, "edges", MAX_GRAPH_PROJECTION_EDGES);
  const rawRootIds = requireBoundedArray(candidate.rootFileIds, "rootFileIds", maxRoots);
  const rawReadyIds = requireBoundedArray(candidate.readyFileIds, "readyFileIds", MAX_GRAPH_PROJECTION_FILES);
  const rawLoadedIds = requireBoundedArray(candidate.loadedFileIds, "loadedFileIds", MAX_GRAPH_PROJECTION_FILES);
  const rawFrontier = requireBoundedArray(candidate.frontier, "frontier", maxRoots);
  const counts = parseCounts(candidate.counts);

  // Reuse the canonical Tier-1 and Tier-2 artifact validators for the repeated header and graph
  // payload. This does not claim the projection itself is a complete artifact; it proves that the
  // self-contained slice honors node IDs, parent closure, resolved endpoints, and edge provenance.
  const validation = validateArtifact({
    schemaVersion: candidate.schemaVersion,
    generatedAt: candidate.generatedAt,
    generator: candidate.generator,
    target: candidate.target,
    ...(candidate.telemetry === undefined ? {} : { telemetry: candidate.telemetry }),
    nodes: rawNodes,
    edges: rawEdges,
    ...(candidate.extensions === undefined ? {} : { extensions: candidate.extensions }),
  });
  if (!validation.ok || validation.artifact === undefined) {
    const detail = validation.errors.slice(0, 3).map((issue) => `${issue.code}: ${issue.message}`).join("; ");
    throw protocolError(`graph projection payload is invalid${detail ? `: ${detail}` : ""}`);
  }
  const artifact = validation.artifact;
  validateLogicFlowExtension(artifact.extensions);

  const rootFileIds = parseUniqueNodeIds(rawRootIds, "rootFileIds");
  const readyFileIds = parseUniqueNodeIds(rawReadyIds, "readyFileIds");
  const loadedFileIds = parseUniqueNodeIds(rawLoadedIds, "loadedFileIds");
  const frontier = parseFrontier(rawFrontier, prefetchDepth);
  const nodesById = new Map(artifact.nodes.map((node) => [node.id, node]));

  requireCanonicalFileIds(rootFileIds, nodesById, "rootFileIds");
  requireCanonicalFileIds(readyFileIds, nodesById, "readyFileIds");
  requireCanonicalFileIds(loadedFileIds, nodesById, "loadedFileIds");
  requireCanonicalFileIds(frontier.map((entry) => entry.fileId), nodesById, "frontier");
  requireSubset(rootFileIds, loadedFileIds, "rootFileIds", "loadedFileIds");
  requireSubset(readyFileIds, loadedFileIds, "readyFileIds", "loadedFileIds");

  const actualSlice: GraphProjectionCounts = {
    nodes: artifact.nodes.length,
    edges: artifact.edges.length,
    files: artifact.nodes.reduce((total, node) => total + Number(isCanonicalProjectionFileNode(node)), 0),
  };
  if (!sameCounts(counts.slice, actualSlice)) {
    throw protocolError(
      `slice counts do not match payload (declared ${formatCounts(counts.slice)}, actual ${formatCounts(actualSlice)})`,
    );
  }
  if (
    counts.full.nodes < counts.slice.nodes
    || counts.full.edges < counts.slice.edges
    || counts.full.files < counts.slice.files
  ) {
    throw protocolError("full counts must be greater than or equal to slice counts");
  }

  const projection: GraphProjectionV1 = {
    version: GRAPH_PROJECTION_VERSION,
    graphId,
    seedGraphId,
    generation,
    requestedDepth,
    prefetchDepth,
    loadedDepth,
    schemaVersion: artifact.schemaVersion,
    generatedAt: artifact.generatedAt,
    generator: artifact.generator,
    target: artifact.target,
    ...(artifact.telemetry === undefined ? {} : { telemetry: artifact.telemetry }),
    ...(artifact.extensions === undefined ? {} : { extensions: artifact.extensions }),
    nodes: artifact.nodes,
    edges: artifact.edges,
    rootFileIds,
    readyFileIds,
    loadedFileIds,
    frontier,
    counts,
  };
  const hasPartialMarker = artifact.extensions !== undefined
    && Object.hasOwn(artifact.extensions, "prPartialGraph");
  if (hasPartialMarker && partialProjectionLineage(projection) === null) {
    throw protocolError("partial graph lineage is invalid");
  }
  if (hasPartialMarker) assertProgressiveResidentCounts(projection.counts.slice);
  return projection;
}

/** Adapt a validated projection to the existing derive input without adding fake extension state. */
export function projectionToArtifact(projection: GraphProjectionV1): GraphArtifact {
  return {
    schemaVersion: projection.schemaVersion,
    generatedAt: projection.generatedAt,
    generator: projection.generator,
    target: projection.target,
    ...(projection.telemetry === undefined ? {} : { telemetry: projection.telemetry }),
    nodes: projection.nodes,
    edges: projection.edges,
    ...(projection.extensions === undefined ? {} : { extensions: projection.extensions }),
  };
}

/**
 * Union two projections of the same immutable graph generation.
 *
 * Replaying the same fragment is idempotent. A canonical ID carrying different data or mismatched
 * immutable metadata fails loudly instead of letting arrival order decide what the reader sees.
 * Independently extracted partial slices carry an exact logical-lineage marker: only for that
 * server-proven case may serialization time and source-slice counts differ. Existing declarations
 * and file metadata remain exact; IPC channel nodes conservatively retain the lowest correlation
 * confidence discovered by any slice. Unseen entries append in each incoming projection's canonical
 * source order. Edges plus filtered `logicFlow`, `reviewFingerprints`, and `ports` extensions have
 * explicit, conflict-detecting union rules; other repeated extension values must be identical.
 */
export function mergeGraphProjections(
  current: GraphProjectionV1,
  incoming: GraphProjectionV1,
): GraphProjectionV1 {
  assertSameImmutableProjection(current, incoming);
  const partialLineage = samePartialProjectionLineage(current, incoming);
  const nodes = partialLineage
    ? mergePartialNodes(current.nodes, incoming.nodes, MAX_PROGRESSIVE_RESIDENT_NODES)
    : mergeByCanonicalId(
        current.nodes,
        incoming.nodes,
        "node",
        MAX_GRAPH_PROJECTION_NODES,
      );
  const edges = partialLineage
    ? mergePartialEdges(current.edges, incoming.edges, MAX_PROGRESSIVE_RESIDENT_EDGES)
    : mergeByCanonicalId(
        current.edges,
        incoming.edges,
        "edge",
        MAX_GRAPH_PROJECTION_EDGES,
      );
  const extensions = mergeExtensions(current.extensions, incoming.extensions, partialLineage);
  const loadedDepth = Math.max(current.loadedDepth, incoming.loadedDepth);
  const rootFileIds = orderedUnion(current.rootFileIds, incoming.rootFileIds);
  const readyFileIds = orderedUnion(current.readyFileIds, incoming.readyFileIds);
  const loadedFileIds = orderedUnion(current.loadedFileIds, incoming.loadedFileIds);
  const frontier = mergeFrontier(current.frontier, incoming.frontier);
  const sliceCounts: GraphProjectionCounts = {
    nodes: nodes.length,
    edges: edges.length,
    files: nodes.reduce((total, node) => total + Number(isCanonicalProjectionFileNode(node)), 0),
  };
  if (partialLineage) assertProgressiveResidentCounts(sliceCounts);
  const fullCounts: GraphProjectionCounts = partialLineage
    ? {
        nodes: Math.max(current.counts.full.nodes, incoming.counts.full.nodes, sliceCounts.nodes),
        edges: Math.max(current.counts.full.edges, incoming.counts.full.edges, sliceCounts.edges),
        files: Math.max(current.counts.full.files, incoming.counts.full.files, sliceCounts.files),
      }
    : current.counts.full;

  return parseGraphProjection({
    version: GRAPH_PROJECTION_VERSION,
    graphId: current.graphId,
    seedGraphId: current.seedGraphId,
    generation: current.generation,
    requestedDepth: Math.max(current.requestedDepth, incoming.requestedDepth),
    prefetchDepth: Math.max(current.prefetchDepth, incoming.prefetchDepth),
    loadedDepth,
    schemaVersion: current.schemaVersion,
    // The landing extraction necessarily precedes its later slices. Lexical ISO minimum keeps that
    // stable baseline even when disconnected fragments race and are merged in reverse order.
    generatedAt: partialLineage
      ? [current.generatedAt, incoming.generatedAt].sort()[0]!
      : current.generatedAt,
    generator: current.generator,
    target: current.target,
    ...(current.telemetry === undefined ? {} : { telemetry: current.telemetry }),
    ...(extensions === undefined ? {} : { extensions }),
    nodes,
    edges,
    rootFileIds,
    readyFileIds,
    loadedFileIds,
    frontier,
    counts: { full: fullCounts, slice: sliceCounts },
  });
}

export function assertProgressiveResidentCounts(counts: GraphProjectionCounts): void {
  if (
    counts.nodes > MAX_PROGRESSIVE_RESIDENT_NODES
    || counts.edges > MAX_PROGRESSIVE_RESIDENT_EDGES
    || counts.files > MAX_PROGRESSIVE_RESIDENT_FILES
  ) {
    throw protocolError(
      `partial graph resident limit exceeded (${formatCounts(counts)}; maximum `
      + `${MAX_PROGRESSIVE_RESIDENT_NODES} nodes, ${MAX_PROGRESSIVE_RESIDENT_EDGES} edges, `
      + `${MAX_PROGRESSIVE_RESIDENT_FILES} files)`,
    );
  }
}

/** Explicit readiness is authoritative; loaded membership alone never admits a file to the canvas. */
export function isProjectionFileReady(projection: GraphProjectionV1, fileId: string): boolean {
  return projection.readyFileIds.includes(fileId);
}

export function areProjectionFilesReady(
  projection: GraphProjectionV1,
  fileIds: Iterable<string> = projection.rootFileIds,
): boolean {
  const ready = new Set(projection.readyFileIds);
  for (const fileId of fileIds) {
    if (!ready.has(fileId)) return false;
  }
  return true;
}

/** The initial review may open only after every canonical root is explicitly ready. */
export function isProjectionReadyForCanvas(projection: GraphProjectionV1): boolean {
  return projection.rootFileIds.length > 0
    && projection.loadedDepth >= projection.requestedDepth
    && areProjectionFilesReady(projection);
}

/** Boundaries whose advertised computation has not reached the absolute prefetch horizon. */
export function projectionFrontierToPrefetch(
  projection: GraphProjectionV1,
  targetDepth = projection.prefetchDepth,
): GraphProjectionFrontierEntry[] {
  if (!Number.isSafeInteger(targetDepth) || targetDepth < 0 || targetDepth > MAX_GRAPH_PROJECTION_DEPTH) {
    throw protocolError("target prefetch depth is invalid");
  }
  return projection.frontier.filter(
    (entry) => entry.hasMore && entry.completeThroughDepth < targetDepth,
  );
}

/** Parse a compact background symbol-index result with explicit collection and string bounds. */
export function parseGraphSymbolSearchResult(value: unknown): GraphSymbolSearchResultV1 {
  return parseGraphSymbolResult(value, protocolError);
}

/** Parse JSON text only after bounding its UTF-8 size. */
export function parseGraphSymbolSearchResponse(
  text: string,
  maxBytes = MAX_GRAPH_SYMBOL_RESPONSE_BYTES,
): GraphSymbolSearchResultV1 {
  return parseGraphSymbolText(text, maxBytes, protocolError);
}

export interface FetchGraphSymbolsOptions {
  signal?: AbortSignal;
  maxBytes?: number;
  fetchImpl?: typeof fetch;
  /** Test seam; production uses a Vite-emitted module Worker. */
  workerFactory?: () => Worker;
}

/** Fetch the compact index independently from graph hydration so callers can schedule it as P3 work. */
export async function fetchGraphSymbols(
  symbolsUrl: string,
  options: FetchGraphSymbolsOptions = {},
): Promise<GraphSymbolSearchResultV1> {
  const maxBytes = options.maxBytes ?? MAX_GRAPH_SYMBOL_RESPONSE_BYTES;
  requirePositiveByteLimit(maxBytes);
  if (options.fetchImpl === undefined && (options.workerFactory !== undefined || typeof Worker !== "undefined")) {
    return fetchGraphSymbolsInWorker(symbolsUrl, maxBytes, options.signal, options.workerFactory);
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(new URL(symbolsUrl, requestOrigin()), {
    credentials: "same-origin",
    signal: options.signal,
  });
  if (!response.ok) {
    throw new Error(`graph symbol fetch failed (${response.status}) from ${symbolsUrl}`);
  }
  const text = await readBoundedUtf8Response(response, maxBytes, "graph symbol", protocolError);
  return parseBoundedGraphSymbolText(text, protocolError);
}

function fetchGraphSymbolsInWorker(
  symbolsUrl: string,
  maxBytes: number,
  signal?: AbortSignal,
  workerFactory: () => Worker = () => new Worker(
    new URL("./graphSymbolWorker.ts", import.meta.url),
    { type: "module", name: "meridian-graph-symbol-index" },
  ),
): Promise<GraphSymbolSearchResultV1> {
  if (signal?.aborted) return Promise.reject(new DOMException("aborted", "AbortError"));
  return new Promise((resolve, reject) => {
    const worker = workerFactory();
    let settled = false;
    const finish = (result: { value: GraphSymbolSearchResultV1 } | { error: unknown }) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      worker.terminate();
      if ("error" in result) reject(result.error);
      else resolve(result.value);
    };
    const onAbort = () => finish({ error: new DOMException("aborted", "AbortError") });
    signal?.addEventListener("abort", onAbort, { once: true });
    worker.onmessage = (event: MessageEvent<GraphSymbolWorkerResponse>) => {
      const message = event.data;
      if (message.ok) finish({ value: message.result });
      else finish({ error: protocolError(message.error) });
    };
    worker.onerror = (event) => {
      finish({ error: new Error(event.message || "graph symbol worker failed") });
    };
    worker.postMessage({
      url: new URL(symbolsUrl, requestOrigin()).toString(),
      maxBytes,
    });
  });
}

function validateProjectionRequest(request: GraphProjectionRequestV1): GraphProjectionRequestV1 {
  const value = requireRecord(request, "graph projection request");
  requireExactVersion(value.version, GRAPH_PROJECTION_VERSION, "graph projection request");
  const graphId = requireBoundedString(value.graphId, "graphId", MAX_ID_CHARS);
  const requestedDepth = requireBoundedInteger(
    value.requestedDepth,
    "requestedDepth",
    0,
    MAX_GRAPH_PROJECTION_DEPTH,
  );
  const prefetchDepth = requireBoundedInteger(
    value.prefetchDepth,
    "prefetchDepth",
    requestedDepth,
    MAX_GRAPH_PROJECTION_DEPTH,
  );
  const roots = requireRecord(value.roots, "roots");
  if (roots.kind === "changed-files") {
    return {
      version: GRAPH_PROJECTION_VERSION,
      graphId,
      roots: {
        kind: "changed-files",
        seedGraphId: requireBoundedString(roots.seedGraphId, "roots.seedGraphId", MAX_ID_CHARS),
      },
      requestedDepth,
      prefetchDepth,
    };
  }
  if (roots.kind === "files") {
    const rawFileIds = requireBoundedArray(roots.fileIds, "roots.fileIds", MAX_GRAPH_PROJECTION_REQUEST_ROOTS);
    const fileIds = parseRequestFileIds(rawFileIds, "roots.fileIds");
    if (fileIds.length === 0) throw protocolError("roots.fileIds must not be empty");
    return {
      version: GRAPH_PROJECTION_VERSION,
      graphId,
      roots: { kind: "files", fileIds },
      requestedDepth,
      prefetchDepth,
    };
  }
  if (roots.kind !== "file-paths") throw protocolError("roots.kind is invalid");
  const rawPaths = requireBoundedArray(roots.paths, "roots.paths", MAX_GRAPH_PROJECTION_REQUEST_ROOTS);
  const paths = parseRequestPaths(rawPaths, "roots.paths");
  if (paths.length === 0) throw protocolError("roots.paths must not be empty");
  return {
    version: GRAPH_PROJECTION_VERSION,
    graphId,
    roots: { kind: "file-paths", paths },
    requestedDepth,
    prefetchDepth,
  };
}

function parseRequestFileIds(values: unknown[], field: string): string[] {
  const ids = parseUniqueNodeIds(values, field);
  for (const [index, id] of ids.entries()) {
    if (utf8ByteLength(id) > MAX_EXPLICIT_ROOT_BYTES) {
      throw protocolError(`${field}[${index}] exceeds ${MAX_EXPLICIT_ROOT_BYTES} UTF-8 bytes`);
    }
  }
  return ids;
}

function parseRequestPaths(values: unknown[], field: string): string[] {
  const paths = values.map((path, index) => {
    const parsed = requireBoundedString(path, `${field}[${index}]`, MAX_SYMBOL_TEXT_CHARS);
    if (parsed.includes("\0")) throw protocolError(`${field}[${index}] contains a null byte`);
    if (utf8ByteLength(parsed) > MAX_EXPLICIT_ROOT_BYTES) {
      throw protocolError(`${field}[${index}] exceeds ${MAX_EXPLICIT_ROOT_BYTES} UTF-8 bytes`);
    }
    return parsed;
  });
  requireUnique(paths, field);
  return paths;
}

function serializeProjectionRequest(request: GraphProjectionRequestV1): string {
  const body = JSON.stringify(request);
  if (utf8ByteLength(body) > MAX_GRAPH_PROJECT_REQUEST_BODY_BYTES) {
    throw protocolError(
      `graph projection request exceeds ${MAX_GRAPH_PROJECT_REQUEST_BODY_BYTES} UTF-8 bytes`,
    );
  }
  return body;
}

function parseCounts(value: unknown): GraphProjectionV1["counts"] {
  const counts = requireRecord(value, "counts");
  return {
    full: parseOneCount(counts.full, "counts.full", {
      nodes: MAX_GRAPH_FULL_NODES,
      edges: MAX_GRAPH_FULL_EDGES,
      files: MAX_GRAPH_FULL_FILES,
    }),
    slice: parseOneCount(counts.slice, "counts.slice", {
      nodes: MAX_GRAPH_PROJECTION_NODES,
      edges: MAX_GRAPH_PROJECTION_EDGES,
      files: MAX_GRAPH_PROJECTION_FILES,
    }),
  };
}

function parseOneCount(
  value: unknown,
  field: string,
  maximum: GraphProjectionCounts,
): GraphProjectionCounts {
  const count = requireRecord(value, field);
  return {
    nodes: requireBoundedInteger(count.nodes, `${field}.nodes`, 0, maximum.nodes),
    edges: requireBoundedInteger(count.edges, `${field}.edges`, 0, maximum.edges),
    files: requireBoundedInteger(count.files, `${field}.files`, 0, maximum.files),
  };
}

function parseFrontier(value: unknown[], loadedDepth: number): GraphProjectionFrontierEntry[] {
  const entries = value.map((raw, index) => {
    const entry = requireRecord(raw, `frontier[${index}]`);
    const fileId = requireNodeId(entry.fileId, `frontier[${index}].fileId`);
    if (typeof entry.hasMore !== "boolean") {
      throw protocolError(`frontier[${index}].hasMore must be a boolean`);
    }
    return {
      fileId,
      hasMore: entry.hasMore,
      completeThroughDepth: requireBoundedInteger(
        entry.completeThroughDepth,
        `frontier[${index}].completeThroughDepth`,
        0,
        loadedDepth,
      ),
    };
  });
  requireUnique(entries.map((entry) => entry.fileId), "frontier file ids");
  return entries;
}

function assertSameImmutableProjection(left: GraphProjectionV1, right: GraphProjectionV1): void {
  const partialLineage = samePartialProjectionLineage(left, right);
  const fields: Array<[string, unknown, unknown]> = [
    ["graphId", left.graphId, right.graphId],
    ["seedGraphId", left.seedGraphId, right.seedGraphId],
    ["generation", left.generation, right.generation],
    ["schemaVersion", left.schemaVersion, right.schemaVersion],
    ["generator", left.generator, right.generator],
    ["target", left.target, right.target],
    ["telemetry", left.telemetry, right.telemetry],
    ...(partialLineage
      ? []
      : [
          ["generatedAt", left.generatedAt, right.generatedAt],
          ["counts.full", left.counts.full, right.counts.full],
        ] as Array<[string, unknown, unknown]>),
  ];
  for (const [field, leftValue, rightValue] of fields) {
    if (!jsonEqual(leftValue, rightValue)) {
      throw protocolError(`cannot merge projections with conflicting ${field}`);
    }
  }
}

function samePartialProjectionLineage(left: GraphProjectionV1, right: GraphProjectionV1): boolean {
  const leftLineage = partialProjectionLineage(left);
  const rightLineage = partialProjectionLineage(right);
  return leftLineage !== null && rightLineage !== null && jsonEqual(leftLineage, rightLineage);
}

function partialProjectionLineage(
  projection: GraphProjectionV1,
): { version: 1; graphId: string; generation: string } | null {
  const value = projection.extensions?.prPartialGraph;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join("\0") !== "generation\0graphId\0version"
    || record.version !== 1
    || record.graphId !== projection.graphId
    || record.generation !== projection.generation
  ) return null;
  return {
    version: 1,
    graphId: record.graphId as string,
    generation: record.generation as string,
  };
}

function mergeByCanonicalId<T extends GraphNode | GraphEdge>(
  current: readonly T[],
  incoming: readonly T[],
  kind: "node" | "edge",
  maximum: number,
): T[] {
  if (current.length > maximum) {
    throw protocolError(`merged graph ${kind} limit exceeded`);
  }
  const merged = [...current];
  const indexById = new Map(current.map((value, index) => [value.id, index]));
  for (const value of incoming) {
    const previousIndex = indexById.get(value.id);
    if (previousIndex === undefined) {
      if (merged.length >= maximum) {
        throw protocolError(`merged graph ${kind} limit exceeded`);
      }
      indexById.set(value.id, merged.length);
      merged.push(value);
      continue;
    }
    if (!jsonEqual(merged[previousIndex], value)) {
      throw protocolError(`conflicting ${kind} payload for ${value.id}`);
    }
    // The incoming projection is the latest authoritative transport record. Replace it without
    // moving its slot so already-rendered declaration and edge order remains a stable prefix.
    merged[previousIndex] = value;
  }
  return merged;
}

/**
 * Independently extracted slices can see different subsets of the ports which materialize one IPC
 * channel. Channel identity is immutable, but its confidence is the minimum of all matching ports;
 * a deeper slice may therefore downgrade an initially exact channel to a conservative candidate.
 * No other node field or node kind is allowed to drift.
 */
function mergePartialNodes(
  current: readonly GraphNode[],
  incoming: readonly GraphNode[],
  maximum: number,
): GraphNode[] {
  if (current.length > maximum) throw protocolError("merged graph node limit exceeded");
  const merged = [...current];
  const indexById = new Map(current.map((node, index) => [node.id, index]));
  for (const node of incoming) {
    const previousIndex = indexById.get(node.id);
    if (previousIndex === undefined) {
      if (merged.length >= maximum) throw protocolError("merged graph node limit exceeded");
      indexById.set(node.id, merged.length);
      merged.push(node);
      continue;
    }
    merged[previousIndex] = mergePartialNodeEvidence(merged[previousIndex]!, node);
  }
  return merged;
}

function mergePartialNodeEvidence(current: GraphNode, incoming: GraphNode): GraphNode {
  if (jsonEqual(current, incoming)) return incoming;
  if (current.kind !== CHANNEL_KIND || incoming.kind !== CHANNEL_KIND) {
    throw protocolError(`conflicting node payload for ${incoming.id}`);
  }
  const { summary: currentSummary, tags: currentTags, ...currentIdentity } = current;
  const { summary: incomingSummary, tags: incomingTags, ...incomingIdentity } = incoming;
  if (!jsonEqual(currentIdentity, incomingIdentity)) {
    throw protocolError(`conflicting node payload for ${incoming.id}`);
  }
  const currentEvidence = channelNodeEvidence(currentSummary, currentTags);
  const incomingEvidence = channelNodeEvidence(incomingSummary, incomingTags);
  if (currentEvidence === null
    || incomingEvidence === null
    || !jsonEqual(currentEvidence.identity, incomingEvidence.identity)
    || (currentEvidence.candidate === incomingEvidence.candidate
      && currentEvidence.confidence === incomingEvidence.confidence)) {
    throw protocolError(`conflicting node payload for ${incoming.id}`);
  }
  if (currentEvidence.candidate !== incomingEvidence.candidate) {
    return currentEvidence.candidate ? current : incoming;
  }
  return currentEvidence.confidence < incomingEvidence.confidence ? current : incoming;
}

function channelNodeEvidence(
  summary: GraphNode["summary"],
  tags: GraphNode["tags"],
): {
  candidate: boolean;
  confidence: number;
  identity: { protocol: string; qualifier: string | null; tags: string[] };
} | null {
  if (typeof summary !== "string" || !Array.isArray(tags) || tags.length === 0) return null;
  const candidateMatch = summary.match(/ — candidate IPC correlation \((\d{1,3})% confidence\)$/);
  const exactSuffix = " — joined by exact static evidence";
  const candidate = candidateMatch !== null;
  if (!candidate && !summary.endsWith(exactSuffix)) return null;
  // `protocol` and `lane` are open vocabularies, so either may itself be the literal string
  // "candidate" and they may be equal. Only the final tag on a candidate summary is the evidence
  // marker; exact summaries do not reserve that token at all.
  if (candidate && (tags.length < 2 || tags.at(-1) !== "candidate")) return null;
  const baseTags = candidate ? tags.slice(0, -1) : [...tags];
  const protocol = baseTags[0];
  if (protocol === undefined) return null;
  const confidence = candidate ? Number(candidateMatch[1]) : 100;
  // Core displays Math.round(rawConfidence * 100), so a conservative 0.995–0.999 candidate is
  // legitimately rendered as 100%. The candidate tag remains the authoritative evidence class.
  if (!Number.isInteger(confidence) || confidence < 0 || confidence > 100) return null;
  const suffixStart = candidate ? candidateMatch.index : summary.length - exactSuffix.length;
  if (suffixStart === undefined) return null;
  const summaryIdentity = summary.slice(0, suffixStart);
  const expectedPrefix = `${protocol} ${candidate ? "selector" : "channel"}`;
  if (!summaryIdentity.startsWith(expectedPrefix)) return null;
  const qualifierText = summaryIdentity.slice(expectedPrefix.length);
  const qualifier = qualifierText === ""
    ? null
    : qualifierText.startsWith(" (") && qualifierText.endsWith(")") && qualifierText.length > 3
      ? qualifierText.slice(2, -1)
      : undefined;
  if (qualifier === undefined) return null;
  return {
    candidate,
    confidence,
    identity: {
      protocol,
      qualifier,
      tags: baseTags,
    },
  };
}

/**
 * Independently extracted partial revisions can discover additional call-site evidence for an
 * already-known logical edge. Its canonical identity and semantic fields remain immutable, while
 * `callSites`/`weight` are a monotonic aggregate. Union that evidence as a multiset so a deeper
 * slice, a shallower replay, and reverse arrival all converge without hiding semantic conflicts.
 */
function mergePartialEdges(
  current: readonly GraphEdge[],
  incoming: readonly GraphEdge[],
  maximum: number,
): GraphEdge[] {
  if (current.length > maximum) throw protocolError("merged graph edge limit exceeded");
  const merged = [...current];
  const indexById = new Map(current.map((edge, index) => [edge.id, index]));
  for (const edge of incoming) {
    const previousIndex = indexById.get(edge.id);
    if (previousIndex === undefined) {
      if (merged.length >= maximum) throw protocolError("merged graph edge limit exceeded");
      indexById.set(edge.id, merged.length);
      merged.push(edge);
      continue;
    }
    merged[previousIndex] = mergePartialEdgeEvidence(merged[previousIndex]!, edge);
  }
  return merged;
}

function mergePartialEdgeEvidence(current: GraphEdge, incoming: GraphEdge): GraphEdge {
  if (jsonEqual(current, incoming)) return incoming;
  const { callSites: currentSites, weight: currentWeight, ...currentIdentity } = current;
  const { callSites: incomingSites, weight: incomingWeight, ...incomingIdentity } = incoming;
  if (!jsonEqual(currentIdentity, incomingIdentity)
    || currentSites === undefined
    || incomingSites === undefined) {
    throw protocolError(`conflicting edge payload for ${incoming.id}`);
  }

  const callSites = mergeCallSiteMultisets(currentSites, incomingSites);
  if ((currentWeight !== undefined && currentWeight !== currentSites.length)
    || (incomingWeight !== undefined && incomingWeight !== incomingSites.length)) {
    throw protocolError(`conflicting edge payload for ${incoming.id}`);
  }
  return {
    ...currentIdentity,
    ...(currentWeight === undefined && incomingWeight === undefined ? {} : { weight: callSites.length }),
    callSites,
  };
}

function mergeCallSiteMultisets(
  current: NonNullable<GraphEdge["callSites"]>,
  incoming: NonNullable<GraphEdge["callSites"]>,
): NonNullable<GraphEdge["callSites"]> {
  const left = callSiteMultiset(current);
  const right = callSiteMultiset(incoming);
  const merged: NonNullable<GraphEdge["callSites"]> = [];
  for (const key of sortedUnion([...left.keys()], [...right.keys()])) {
    const count = Math.max(left.get(key) ?? 0, right.get(key) ?? 0);
    const callSite = JSON.parse(key) as NonNullable<GraphEdge["callSites"]>[number];
    for (let index = 0; index < count; index += 1) merged.push(callSite);
  }
  return merged.sort((leftSite, rightSite) =>
    leftSite.file.localeCompare(rightSite.file)
    || leftSite.line - rightSite.line
    || (leftSite.col ?? -1) - (rightSite.col ?? -1)
    || (leftSite.endLine ?? -1) - (rightSite.endLine ?? -1)
    || (leftSite.endCol ?? -1) - (rightSite.endCol ?? -1));
}

function callSiteMultiset(
  callSites: NonNullable<GraphEdge["callSites"]>,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const callSite of callSites) {
    const key = canonicalJson(callSite as unknown as JsonValue);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function mergeExtensions(
  current: Record<string, JsonValue> | undefined,
  incoming: Record<string, JsonValue> | undefined,
  partialLineage = false,
): Record<string, JsonValue> | undefined {
  if (current === undefined && incoming === undefined) return undefined;
  const merged = Object.create(null) as Record<string, JsonValue>;
  for (const [key, value] of Object.entries(current ?? {})) {
    merged[key] = normalizeMergeableExtension(key, value);
  }
  for (const [key, value] of Object.entries(incoming ?? {})) {
    if (!Object.hasOwn(merged, key)) {
      merged[key] = normalizeMergeableExtension(key, value);
      continue;
    }
    if (key === LOGIC_FLOW_EXTENSION) {
      merged[key] = mergeLogicFlows(merged[key], value, partialLineage);
      continue;
    }
    if (key === REVIEW_FINGERPRINT_EXTENSION) {
      merged[key] = mergeReviewFingerprints(merged[key], value, partialLineage);
      continue;
    }
    if (key === PORTS_EXTENSION) {
      merged[key] = mergePorts(merged[key], value);
      continue;
    }
    if (key === SEQUENCE_TIMELINE_EXTENSION) {
      merged[key] = mergeJsonRecords(
        requireJsonRecord(merged[key], "extensions.sequenceTimeline"),
        requireJsonRecord(value, "extensions.sequenceTimeline"),
        "sequenceTimeline entries",
      );
      continue;
    }
    if (key === TEST_EXECUTION_COVERAGE_EXTENSION) {
      merged[key] = mergeTestExecutionCoverage(merged[key], value);
      continue;
    }
    if (key === "entryModules" && partialLineage) {
      merged[key] = mergePartialEntryModules(merged[key], value);
      continue;
    }
    // `entryModules` is deliberately not unioned. Every projection carries the complete canonical
    // ordered list (IDs absent from a slice are ignored by the renderer), so byte inequality means
    // the immutable artifact contract was violated. The default conflict check preserves that proof.
    if (!jsonEqual(merged[key], value)) {
      throw protocolError(`conflicting extension payload for ${key}`);
    }
  }
  return merged;
}

function mergePartialEntryModules(current: JsonValue, incoming: JsonValue): JsonValue {
  const values = [...partialEntryModules(current), ...partialEntryModules(incoming)];
  return [...new Set(values)].sort();
}

function partialEntryModules(value: JsonValue): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw protocolError("partial entryModules must be an array of node ids");
  }
  const entries = value as string[];
  if (new Set(entries).size !== entries.length) {
    throw protocolError("partial entryModules must not contain duplicate node ids");
  }
  return entries;
}

function normalizeMergeableExtension(key: string, value: JsonValue): JsonValue {
  if (key === REVIEW_FINGERPRINT_EXTENSION) return normalizeReviewFingerprints(value);
  if (key === PORTS_EXTENSION) return mergePorts([], value);
  if (key === SEQUENCE_TIMELINE_EXTENSION) {
    return sortedJsonRecord(requireJsonRecord(value, "extensions.sequenceTimeline"));
  }
  if (key === TEST_EXECUTION_COVERAGE_EXTENSION) return normalizeTestExecutionCoverage(value);
  return value;
}

function mergeTestExecutionCoverage(current: JsonValue, incoming: JsonValue): JsonValue {
  const left = parseTestExecutionCoverage(current);
  const right = parseTestExecutionCoverage(incoming);
  if (
    left.version !== right.version
    || left.aggregate !== right.aggregate
    || !jsonEqual(left.producer, right.producer)
  ) {
    throw protocolError("conflicting testExecutionCoverage metadata");
  }
  return {
    version: left.version,
    aggregate: left.aggregate,
    producer: left.producer,
    files: mergeJsonRecords(
      left.files as unknown as Record<string, JsonValue>,
      right.files as unknown as Record<string, JsonValue>,
      "testExecutionCoverage files",
    ),
  } as unknown as JsonValue;
}

function normalizeTestExecutionCoverage(value: JsonValue): JsonValue {
  const coverage = parseTestExecutionCoverage(value);
  return {
    version: coverage.version,
    aggregate: coverage.aggregate,
    producer: coverage.producer,
    files: sortedJsonRecord(coverage.files as unknown as Record<string, JsonValue>),
  } as unknown as JsonValue;
}

function parseTestExecutionCoverage(value: JsonValue) {
  const parsed = readTestExecutionCoverage({
    schemaVersion: "1.0.0",
    generatedAt: "1970-01-01T00:00:00.000Z",
    generator: { name: "meridian", version: "0.0.0" },
    target: { name: "projection-extension", root: ".", language: "typescript" },
    nodes: [],
    edges: [],
    extensions: { [TEST_EXECUTION_COVERAGE_EXTENSION]: value },
  });
  if (parsed === null) {
    throw protocolError("extensions.testExecutionCoverage must be valid runtime coverage");
  }
  return parsed;
}

function mergeLogicFlows(
  current: JsonValue,
  incoming: JsonValue,
  partialLineage = false,
): JsonValue {
  const left = requireJsonRecord(current, "extensions.logicFlow");
  const right = requireJsonRecord(incoming, "extensions.logicFlow");
  const merged = Object.create(null) as Record<string, JsonValue>;
  for (const [id, flow] of Object.entries(left)) merged[id] = flow;
  for (const [id, flow] of Object.entries(right)) {
    if (Object.hasOwn(merged, id) && partialLineage) {
      try {
        // Exact-revision partial extracts can see the same source declaration with different
        // resolver horizons. Merge only monotonic target-resolution upgrades (for example an
        // external import becoming resolved when its defining file enters a later slice). Every
        // source/branch/call shape still has to match exactly, so unrelated or contradictory flow
        // payloads remain fail-closed. The recursive max is commutative and replay-idempotent.
        merged[id] = mergePartialLogicFlowValue(merged[id]!, flow);
      } catch {
        throw protocolError(`conflicting logicFlow payload for ${id}`);
      }
      continue;
    }
    if (Object.hasOwn(merged, id) && !jsonEqual(merged[id], flow)) {
      throw protocolError(`conflicting logicFlow payload for ${id}`);
    }
    merged[id] = flow;
  }
  return merged;
}

const LOGIC_FLOW_RESOLUTION_RANK: Readonly<Record<string, number>> = {
  unresolved: 0,
  external: 1,
  resolved: 2,
};

/** Merge the same source flow observed under two bounded TypeScript resolver horizons. */
function mergePartialLogicFlowValue(left: JsonValue, right: JsonValue): JsonValue {
  if (jsonEqual(left, right)) return left;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      throw new Error("logic-flow shape differs");
    }
    return left.map((value, index) => mergePartialLogicFlowValue(value, right[index]!));
  }
  if (!isRecord(left) || !isRecord(right)) throw new Error("logic-flow value differs");

  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  if (leftKeys.length !== rightKeys.length || leftKeys.some((key, index) => key !== rightKeys[index])) {
    throw new Error("logic-flow object shape differs");
  }

  const hasResolutionPair = Object.hasOwn(left, "resolution")
    && Object.hasOwn(left, "target")
    && Object.hasOwn(right, "resolution")
    && Object.hasOwn(right, "target");
  const merged = Object.create(null) as Record<string, JsonValue>;
  for (const key of leftKeys) {
    if (hasResolutionPair && (key === "resolution" || key === "target")) continue;
    merged[key] = mergePartialLogicFlowValue(left[key] as JsonValue, right[key] as JsonValue);
  }
  if (!hasResolutionPair) return merged;

  const leftResolution = left.resolution;
  const rightResolution = right.resolution;
  const leftTarget = left.target;
  const rightTarget = right.target;
  if (
    typeof leftResolution !== "string"
    || typeof rightResolution !== "string"
    || typeof leftTarget !== "string"
    || typeof rightTarget !== "string"
  ) {
    throw new Error("logic-flow resolution is invalid");
  }
  const leftRank = LOGIC_FLOW_RESOLUTION_RANK[leftResolution];
  const rightRank = LOGIC_FLOW_RESOLUTION_RANK[rightResolution];
  if (leftRank === undefined || rightRank === undefined) {
    throw new Error("logic-flow resolutions conflict");
  }
  if (leftRank === rightRank && leftResolution === "resolved") {
    // Two internal targets at one exact revision cannot both be authoritative.
    throw new Error("resolved logic-flow targets conflict");
  }
  const leftPair = { resolution: leftResolution, target: leftTarget };
  const rightPair = { resolution: rightResolution, target: rightTarget };
  const preferred = leftRank === rightRank
    // Resolver-limited slices can expose different external aliases for the same exact call site.
    // Neither is an internal authority; a canonical tie-break keeps A+B, B+A, and replay identical.
    ? [leftPair, rightPair].sort((a, b) => (
        `${a.resolution}\0${a.target}` < `${b.resolution}\0${b.target}` ? -1 : 1
      ))[0]!
    : leftRank > rightRank
      ? leftPair
      : rightPair;
  merged.resolution = preferred.resolution;
  merged.target = preferred.target;
  return merged;
}

function mergeReviewFingerprints(
  current: JsonValue,
  incoming: JsonValue,
  partialLineage: boolean,
): JsonValue {
  const leftRaw = requireJsonRecord(current, "extensions.reviewFingerprints");
  const rightRaw = requireJsonRecord(incoming, "extensions.reviewFingerprints");
  for (const field of ["version", "algorithm"] as const) {
    if (!jsonEqual(leftRaw[field], rightRaw[field])) {
      throw protocolError(`conflicting reviewFingerprints ${field}`);
    }
  }
  if (!partialLineage && !jsonEqual(leftRaw.complete, rightRaw.complete)) {
    throw protocolError("conflicting reviewFingerprints complete");
  }

  const left = parseReviewFingerprints(current);
  const right = parseReviewFingerprints(incoming);
  const merged = {
    version: left.version,
    algorithm: left.algorithm,
    // Independently extracted partial slices describe completeness only within their own bounded
    // source artifact. Their union may claim completeness only if every constituent did; once any
    // slice reports a missing fingerprint, later arrival order must never restore the stronger bit.
    complete: partialLineage ? left.complete && right.complete : left.complete,
    units: mergeJsonRecords(
      left.units as unknown as Record<string, JsonValue>,
      right.units as unknown as Record<string, JsonValue>,
      "reviewFingerprints units",
    ),
    files: mergeJsonRecords(
      left.files as unknown as Record<string, JsonValue>,
      right.files as unknown as Record<string, JsonValue>,
      "reviewFingerprints files",
    ),
  } as unknown as JsonValue;

  // Revalidate the union as a whole. This also catches two different keys acquiring the same
  // logical address only after independently valid filtered fragments are combined.
  return normalizeReviewFingerprints(merged);
}

function normalizeReviewFingerprints(value: JsonValue): JsonValue {
  const parsed = parseReviewFingerprints(value);
  return {
    version: parsed.version,
    algorithm: parsed.algorithm,
    complete: parsed.complete,
    units: sortedJsonRecord(parsed.units as unknown as Record<string, JsonValue>),
    files: sortedJsonRecord(parsed.files as unknown as Record<string, JsonValue>),
  };
}

function parseReviewFingerprints(value: JsonValue) {
  const parsed = reviewFingerprintsFromArtifact({
    extensions: { [REVIEW_FINGERPRINT_EXTENSION]: value },
  });
  if (parsed === null) {
    throw protocolError("extensions.reviewFingerprints must be a valid fingerprint extension");
  }
  return parsed;
}

function mergeJsonRecords(
  current: Record<string, JsonValue>,
  incoming: Record<string, JsonValue>,
  field: string,
): Record<string, JsonValue> {
  const merged = Object.create(null) as Record<string, JsonValue>;
  for (const key of sortedUnion(Object.keys(current), Object.keys(incoming))) {
    const hasCurrent = Object.hasOwn(current, key);
    const hasIncoming = Object.hasOwn(incoming, key);
    if (hasCurrent && hasIncoming && !jsonEqual(current[key], incoming[key])) {
      throw protocolError(`conflicting ${field} payload for ${key}`);
    }
    merged[key] = hasCurrent ? current[key] : incoming[key];
  }
  return merged;
}

function sortedJsonRecord(value: Record<string, JsonValue>): Record<string, JsonValue> {
  const sorted = Object.create(null) as Record<string, JsonValue>;
  for (const key of Object.keys(value).sort()) sorted[key] = value[key];
  return sorted;
}

/**
 * Ports have no canonical ID and an artifact may contain repeated equal observations. Treat them
 * as a multiset: take the maximum multiplicity seen in either cumulative fragment, then order by a
 * canonical JSON encoding. That makes A+B, B+A, and replaying B produce the same lossless result.
 */
function mergePorts(current: JsonValue, incoming: JsonValue): JsonValue {
  if (!Array.isArray(current) || !Array.isArray(incoming)) {
    throw protocolError("extensions.ports must be an array");
  }
  const left = jsonMultiset(current);
  const right = jsonMultiset(incoming);
  const values: JsonValue[] = [];
  for (const key of sortedUnion([...left.keys()], [...right.keys()])) {
    const count = Math.max(left.get(key) ?? 0, right.get(key) ?? 0);
    const canonical = JSON.parse(key) as JsonValue;
    for (let index = 0; index < count; index += 1) values.push(canonical);
  }
  return values;
}

function jsonMultiset(values: JsonValue[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) {
    const key = canonicalJson(value);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw protocolError("extensions.ports must contain JSON values");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`
  )).join(",")}}`;
}

function mergeFrontier(
  current: readonly GraphProjectionFrontierEntry[],
  incoming: readonly GraphProjectionFrontierEntry[],
): GraphProjectionFrontierEntry[] {
  const merged = [...current];
  const indexByFileId = new Map(current.map((entry, index) => [entry.fileId, index]));
  for (const entry of incoming) {
    const previousIndex = indexByFileId.get(entry.fileId);
    if (previousIndex === undefined) {
      indexByFileId.set(entry.fileId, merged.length);
      merged.push(entry);
      continue;
    }
    const previous = merged[previousIndex]!;
    if (entry.completeThroughDepth > previous.completeThroughDepth) {
      merged[previousIndex] = entry;
    } else if (entry.completeThroughDepth === previous.completeThroughDepth) {
      // `hasMore:false` is the stronger observation at the same proven depth: the server completed
      // that boundary and found a leaf. A prior optimistic `true` must not trigger endless prefetch.
      merged[previousIndex] = { ...entry, hasMore: previous.hasMore && entry.hasMore };
    }
  }
  return merged;
}

function validateLogicFlowExtension(extensions: Record<string, JsonValue> | undefined): void {
  if (extensions === undefined || !Object.hasOwn(extensions, LOGIC_FLOW_EXTENSION)) return;
  requireJsonRecord(extensions[LOGIC_FLOW_EXTENSION], "extensions.logicFlow");
}

function requireJsonRecord(value: JsonValue | undefined, field: string): Record<string, JsonValue> {
  if (!isRecord(value)) throw protocolError(`${field} must be an object`);
  return value as Record<string, JsonValue>;
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) throw protocolError(`${field} must be an object`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireBoundedArray(value: unknown, field: string, maximum: number): unknown[] {
  if (!Array.isArray(value)) throw protocolError(`${field} must be an array`);
  if (value.length > maximum) throw protocolError(`${field} exceeds ${maximum} entries`);
  return value;
}

function requireBoundedString(value: unknown, field: string, maximum: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    throw protocolError(`${field} must be a non-empty string of at most ${maximum} characters`);
  }
  return value;
}

function requireNodeId(value: unknown, field: string): string {
  const id = requireBoundedString(value, field, MAX_ID_CHARS);
  if (!nodeIdSchema.safeParse(id).success) throw protocolError(`${field} is not a canonical node id`);
  return id;
}

function requireBoundedInteger(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw protocolError(`${field} must be an integer between ${minimum} and ${maximum}`);
  }
  return value as number;
}

function requireExactVersion(value: unknown, version: number, field: string): void {
  if (value !== version) throw protocolError(`${field} version must be ${version}`);
}

function parseUniqueNodeIds(values: unknown[], field: string): string[] {
  const ids = values.map((value, index) => requireNodeId(value, `${field}[${index}]`));
  requireUnique(ids, field);
  return ids;
}

function requireUnique(values: readonly string[], field: string): void {
  if (new Set(values).size !== values.length) throw protocolError(`${field} must not contain duplicates`);
}

function requireCanonicalFileIds(ids: readonly string[], nodes: ReadonlyMap<string, GraphNode>, field: string): void {
  for (const id of ids) {
    if (!isCanonicalProjectionFileNode(nodes.get(id))) {
      throw protocolError(`${field} contains ${id}, which is not a loaded canonical file node`);
    }
  }
}

/** Python represents `pkg/__init__.py` with its package node rather than a duplicate module node.
 * Only a package backed by an actual Python source location is a file identity; namespace and
 * synthetic packages remain hierarchy-only nodes. Keep this predicate identical to the projector. */
function isCanonicalProjectionFileNode(node: GraphNode | undefined): boolean {
  return node !== undefined
    && (
      node.kind === "module"
      || (node.kind === "package" && node.location.file.replaceAll("\\", "/").endsWith(".py"))
    );
}

function requireSubset(
  values: readonly string[],
  container: readonly string[],
  field: string,
  containerField: string,
): void {
  const allowed = new Set(container);
  if (values.some((value) => !allowed.has(value))) {
    throw protocolError(`${field} must be a subset of ${containerField}`);
  }
}

function sortedUnion(left: readonly string[], right: readonly string[]): string[] {
  return [...new Set([...left, ...right])].sort();
}

function orderedUnion(left: readonly string[], right: readonly string[]): string[] {
  const seen = new Set(left);
  const merged = [...left];
  for (const value of right) {
    if (seen.has(value)) continue;
    seen.add(value);
    merged.push(value);
  }
  return merged;
}

function sameCounts(left: GraphProjectionCounts, right: GraphProjectionCounts): boolean {
  return left.nodes === right.nodes && left.edges === right.edges && left.files === right.files;
}

function formatCounts(counts: GraphProjectionCounts): string {
  return `${counts.nodes} nodes/${counts.edges} edges/${counts.files} files`;
}

function jsonEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => jsonEqual(value, right[index]));
  }
  if (!isRecord(left) || !isRecord(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index] && jsonEqual(left[key], right[key]));
}

function endpointAt(graph: URL, path: string): URL {
  const endpoint = new URL(graph.toString());
  endpoint.pathname = path;
  endpoint.search = "";
  endpoint.hash = "";
  return endpoint;
}

function printableUrl(url: URL, relative: boolean): string {
  return relative ? `${url.pathname}${url.search}` : url.toString();
}

function nonEmptyQueryValue(value: string | null): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

function requestOrigin(): string {
  return typeof window === "undefined" ? DUMMY_ORIGIN : window.location.origin;
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function requirePositiveByteLimit(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw protocolError("maxBytes must be a positive integer");
}

function protocolError(message: string): ProgressiveGraphProtocolError {
  return new ProgressiveGraphProtocolError(message);
}
