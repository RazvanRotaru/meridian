/** Strict, bounded IPC messages for disposable graph projection workers. */

import { isAbsolute } from "node:path";
import {
  compareBinaryStrings,
  GRAPH_PROJECTION_VERSION,
  nodeIdSchema,
  type GraphProjectionRequestV1,
} from "@meridian/core";

export const MAX_GRAPH_PROJECT_ROOTS = 512;
// The renderer can retain more roots than one disposable projection worker may traverse. Large PR
// changed-file sets are split into <=512-root jobs and combined by a rootless merge job under this
// response cap; the per-project worker bound above is intentionally unchanged.
export const MAX_GRAPH_PROJECT_MERGED_ROOTS = 20_000;
export const MAX_GRAPH_PROJECT_MERGE_INPUTS = 256;
export const MAX_GRAPH_PROJECT_REQUESTED_DEPTH = 6;
export const MAX_GRAPH_PROJECT_ABSOLUTE_DEPTH = 9;
export const MAX_GRAPH_PROJECT_NODE_ID_BYTES = 4_096;
// The HTTP JSON reader caps the entire body at 64,000 bytes. Keep decoded roots below 60,000 so
// the version/graph/depth envelope and ordinary JSON punctuation can never imply a 1 MiB worker
// capability that the public transport cannot reach.
export const MAX_GRAPH_PROJECT_ROOT_BYTES = 60_000;
export const MAX_GRAPH_PROJECT_OUTPUT_BYTES = 256 * 1024 * 1024;
// Match the renderer's pre-parse response cap so the server never publishes an unusable index.
export const MAX_GRAPH_SYMBOL_OUTPUT_BYTES = 64 * 1024 * 1024;
export const MAX_GRAPH_TOPOLOGY_OUTPUT_BYTES = 64 * 1024 * 1024;
export const MAX_GRAPH_PROJECT_STDERR_BYTES = 16 * 1024;
export const MAX_GRAPH_PROJECT_OUTPUT_NODES = 500_000;
export const MAX_GRAPH_PROJECT_OUTPUT_EDGES = 2_000_000;
export const MAX_GRAPH_PROJECT_OUTPUT_FILES = 100_000;
export const MAX_GRAPH_SYMBOL_ENTRIES = 500_000;
export const MAX_GRAPH_TOPOLOGY_ADJACENCY = 1_000_000;
export const MAX_GRAPH_SOURCE_BYTES = 1024 * 1024 * 1024;
export const MAX_GRAPH_SOURCE_FILE_BYTES = 16 * 1024 * 1024;

export interface GraphSourceIndexUsage {
  sourceFileCount: number;
  sourceBytes: number;
  symbolCount: number;
  adjacencyEntries: number;
}

export interface GraphSourceIndexRemainingLimits {
  maxFiles: number;
  maxSourceBytes: number;
  maxSymbols: number;
  maxAdjacencyEntries: number;
}

/** Allocate the second language only the exact aggregate budget left by the first scan. A zero
 * remainder is terminal: rounding it up to one would silently weaken the advertised process cap. */
export function remainingGraphSourceIndexLimits(
  used: GraphSourceIndexUsage,
): GraphSourceIndexRemainingLimits {
  assertGraphSourceIndexUsage(used);
  const remaining = {
    maxFiles: MAX_GRAPH_PROJECT_OUTPUT_FILES - used.sourceFileCount,
    maxSourceBytes: MAX_GRAPH_SOURCE_BYTES - used.sourceBytes,
    maxSymbols: MAX_GRAPH_SYMBOL_ENTRIES - used.symbolCount,
    maxAdjacencyEntries: MAX_GRAPH_TOPOLOGY_ADJACENCY - used.adjacencyEntries,
  };
  if (Object.values(remaining).some((value) => value <= 0)) {
    throw new RangeError("source index exhausted its aggregate mixed-language limit");
  }
  return remaining;
}

/** Re-prove the merged result before serialization; child scanners remain mutually untrusted even
 * when each independently honored the exact remainder it received. */
export function assertGraphSourceIndexUsage(usage: GraphSourceIndexUsage): void {
  if (
    !Number.isSafeInteger(usage.sourceFileCount)
    || usage.sourceFileCount < 0
    || usage.sourceFileCount > MAX_GRAPH_PROJECT_OUTPUT_FILES
    || !Number.isSafeInteger(usage.sourceBytes)
    || usage.sourceBytes < 0
    || usage.sourceBytes > MAX_GRAPH_SOURCE_BYTES
    || !Number.isSafeInteger(usage.symbolCount)
    || usage.symbolCount < 0
    || usage.symbolCount > MAX_GRAPH_SYMBOL_ENTRIES
    || !Number.isSafeInteger(usage.adjacencyEntries)
    || usage.adjacencyEntries < 0
    || usage.adjacencyEntries > MAX_GRAPH_TOPOLOGY_ADJACENCY
  ) {
    throw new RangeError("source index exceeded its aggregate mixed-language limit");
  }
}

const SHA256 = /^[a-f0-9]{64}$/;
const ITEM_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface GraphProjectWorkerArtifactInput {
  graphId: string;
  path: string;
  bytes: number;
  sha256: string;
}

export interface GraphProjectWorkerRequest {
  type: "project" | "symbols" | "merge";
  id: string;
  graph: GraphProjectWorkerArtifactInput;
  seedGraph: GraphProjectWorkerArtifactInput | null;
  generation: string;
  projection: GraphProjectionRequestV1 | null;
  projectionOutputPath: string | null;
  /** Exact maximum bytes this child may serialize for its projection output. */
  projectionOutputMaxBytes: number | null;
  symbolOutputPath: string | null;
  /** Trusted exact-revision workspace retained by this provisional graph registration. */
  symbolSourceRoot: string | null;
  /** Compact import/IPC topology emitted from the same source scan as provisional symbols. */
  topologyOutputPath: string | null;
  /** Immutable <=512-root projection outputs consumed only by a rootless disposable merge job. */
  projectionInputs?: GraphProjectWorkerOutputFile[];
}

export interface GraphProjectWorkerOutputFile {
  path: string;
  bytes: number;
  sha256: string;
}

export interface GraphProjectWorkerResult {
  id: string;
  operation: GraphProjectWorkerRequest["type"];
  graphId: string;
  generation: string;
  projection: (GraphProjectWorkerOutputFile & {
    nodes: number;
    edges: number;
    files: number;
    roots: number;
    /** Root files whose frontier proves the requested depth, not merely depth one. */
    completeRoots: number;
    loadedDepth: number;
  }) | null;
  symbols: (GraphProjectWorkerOutputFile & { count: number }) | null;
  topology: (GraphProjectWorkerOutputFile & { files: number; adjacencyEntries: number }) | null;
}

export type GraphProjectWorkerResponse =
  | { type: "result"; result: GraphProjectWorkerResult }
  | { type: "error"; error: { kind: "invalid" | "internal"; message: string } };

export function isGraphProjectWorkerRequest(value: unknown): value is GraphProjectWorkerRequest {
  if (!isRecord(value)) return false;
  const ordinaryKeys = [
    "generation",
    "graph",
    "id",
    "projection",
    "projectionOutputMaxBytes",
    "projectionOutputPath",
    "seedGraph",
    "symbolOutputPath",
    "symbolSourceRoot",
    "topologyOutputPath",
    "type",
  ];
  const exactKeys = value.type === "merge"
    ? [...ordinaryKeys, "projectionInputs"]
    : ordinaryKeys;
  if (!hasExactKeys(value, exactKeys)) return false;
  if ((value.type !== "project" && value.type !== "symbols" && value.type !== "merge")
    || typeof value.id !== "string" || !ITEM_ID.test(value.id)
    || typeof value.generation !== "string" || !SHA256.test(value.generation)
    || !artifactInput(value.graph)
    || (value.seedGraph !== null && !artifactInput(value.seedGraph))) return false;
  if (value.type === "symbols") {
    const sourceBacked = typeof value.symbolSourceRoot === "string"
      && isAbsolute(value.symbolSourceRoot)
      && typeof value.topologyOutputPath === "string"
      && isAbsolute(value.topologyOutputPath)
      && value.topologyOutputPath !== value.graph.path
      && value.topologyOutputPath !== value.symbolOutputPath;
    const artifactBacked = value.symbolSourceRoot === null && value.topologyOutputPath === null;
    return value.projection === null && value.projectionOutputPath === null && value.seedGraph === null
      && value.projectionOutputMaxBytes === null
      && typeof value.symbolOutputPath === "string" && isAbsolute(value.symbolOutputPath)
      && value.symbolOutputPath !== value.graph.path
      && (sourceBacked || artifactBacked);
  }
  if (value.type === "merge") {
    if (!isBoundedGraphProjectionRequest(value.projection)
      || value.projection.roots.kind !== "changed-files"
      || value.projection.graphId !== value.graph.graphId
      || value.seedGraph !== null
      || typeof value.projectionOutputPath !== "string"
      || !isAbsolute(value.projectionOutputPath)
      || !integerBetween(value.projectionOutputMaxBytes, 1, MAX_GRAPH_PROJECT_OUTPUT_BYTES)
      || value.projectionOutputPath === value.graph.path
      || value.symbolOutputPath !== null
      || value.symbolSourceRoot !== null
      || value.topologyOutputPath !== null
      || !Array.isArray(value.projectionInputs)
      || value.projectionInputs.length < 2
      || value.projectionInputs.length > MAX_GRAPH_PROJECT_MERGE_INPUTS) return false;
    const paths = new Set<string>();
    let aggregateBytes = 0;
    for (const input of value.projectionInputs) {
      if (!isRecord(input)
        || !hasExactKeys(input, ["bytes", "path", "sha256"])
        || !outputFile(input, MAX_GRAPH_PROJECT_OUTPUT_BYTES)
        || input.path === value.graph.path
        || input.path === value.projectionOutputPath
        || paths.has(input.path as string)) return false;
      paths.add(input.path as string);
      aggregateBytes += input.bytes as number;
      if (aggregateBytes > MAX_GRAPH_PROJECT_OUTPUT_BYTES) return false;
    }
    return true;
  }
  return isBoundedGraphProjectionRequest(value.projection)
    && value.projection.graphId === value.graph.graphId
    && typeof value.projectionOutputPath === "string"
    && isAbsolute(value.projectionOutputPath)
    && integerBetween(value.projectionOutputMaxBytes, 1, MAX_GRAPH_PROJECT_OUTPUT_BYTES)
    && value.projectionOutputPath !== value.graph.path
    && value.projectionOutputPath !== value.seedGraph?.path
    && value.symbolOutputPath === null
    && value.symbolSourceRoot === null
    && value.topologyOutputPath === null
    && (value.projection.roots.kind === "changed-files"
      ? value.seedGraph !== null && value.seedGraph.graphId === value.projection.roots.seedGraphId
      : value.seedGraph === null);
}

/** Re-prove the aggregate staging budget before orchestration starts the rootless merge child.
 * Individual immutable projection outputs are bounded too, but their sum is the memory/disk
 * contract that prevents a large root set from retaining many maximum-sized shards at once. */
export function assertGraphProjectMergeInputBudget(
  inputs: readonly Pick<GraphProjectWorkerOutputFile, "bytes">[],
): void {
  if (inputs.length < 2 || inputs.length > MAX_GRAPH_PROJECT_MERGE_INPUTS) {
    throw new RangeError("graph projection merge input count exceeds its worker limit");
  }
  let bytes = 0;
  for (const input of inputs) {
    if (!positiveSafeInteger(input.bytes) || input.bytes > MAX_GRAPH_PROJECT_OUTPUT_BYTES) {
      throw new RangeError("graph projection merge input exceeds its worker byte limit");
    }
    bytes += input.bytes;
    if (bytes > MAX_GRAPH_PROJECT_OUTPUT_BYTES) {
      throw new RangeError("graph projection merge inputs exceed their aggregate byte limit");
    }
  }
}

/** Validate the immutable oversized changed-file plan persisted beside a graph registration. The
 * flattened paths must already be globally binary-sorted and unique, and each child chunk retains
 * the exact ordinary project-worker count/byte envelope. */
export function isGraphProjectRootChunks(value: unknown): value is string[][] {
  if (!Array.isArray(value)
    || value.length < 2
    || value.length > MAX_GRAPH_PROJECT_MERGE_INPUTS) return false;
  let totalRoots = 0;
  let previous: string | undefined;
  for (const candidate of value) {
    if (!Array.isArray(candidate)
      || candidate.length === 0
      || candidate.length > MAX_GRAPH_PROJECT_ROOTS) return false;
    let chunkBytes = 0;
    for (const path of candidate) {
      if (!boundedString(path, MAX_GRAPH_PROJECT_NODE_ID_BYTES) || path.includes("\0")) return false;
      if (previous !== undefined && compareBinaryStrings(previous, path) >= 0) return false;
      previous = path;
      chunkBytes += Buffer.byteLength(path, "utf8");
      if (chunkBytes > MAX_GRAPH_PROJECT_ROOT_BYTES) return false;
      totalRoots += 1;
      if (totalRoots > MAX_GRAPH_PROJECT_MERGED_ROOTS) return false;
    }
  }
  return true;
}

export function isGraphProjectWorkerResponse(value: unknown): value is GraphProjectWorkerResponse {
  if (!isRecord(value)) return false;
  if (value.type === "error") {
    return hasExactKeys(value, ["error", "type"])
      && isRecord(value.error)
      && hasExactKeys(value.error, ["kind", "message"])
      && (value.error.kind === "invalid" || value.error.kind === "internal")
      && typeof value.error.message === "string"
      && value.error.message.length <= 1_024;
  }
  if (value.type !== "result" || !hasExactKeys(value, ["result", "type"]) || !isRecord(value.result)) return false;
  const result = value.result;
  return hasExactKeys(result, ["generation", "graphId", "id", "operation", "projection", "symbols", "topology"])
    && typeof result.id === "string" && ITEM_ID.test(result.id)
    && (result.operation === "project" || result.operation === "symbols" || result.operation === "merge")
    && boundedString(result.graphId, 2_048)
    && typeof result.generation === "string" && SHA256.test(result.generation)
    && (result.projection === null || projectionOutput(
      result.projection,
      result.operation === "merge" ? MAX_GRAPH_PROJECT_MERGED_ROOTS : MAX_GRAPH_PROJECT_ROOTS,
    ))
    && (result.symbols === null || symbolOutput(result.symbols))
    && (result.topology === null || topologyOutput(result.topology))
    && (result.operation === "project" || result.operation === "merge"
      ? result.projection !== null && result.symbols === null && result.topology === null
      : result.projection === null && result.symbols !== null);
}

export function isBoundedGraphProjectionRequest(value: unknown): value is GraphProjectionRequestV1 {
  if (!isRecord(value) || !hasExactKeys(value, ["graphId", "prefetchDepth", "requestedDepth", "roots", "version"])
    || value.version !== GRAPH_PROJECTION_VERSION
    || !boundedString(value.graphId, 2_048)
    || !integerBetween(value.requestedDepth, 0, MAX_GRAPH_PROJECT_REQUESTED_DEPTH)
    || !integerBetween(
      value.prefetchDepth,
      value.requestedDepth as number,
      Math.min(MAX_GRAPH_PROJECT_ABSOLUTE_DEPTH, (value.requestedDepth as number) + 3),
    )
    || !isRecord(value.roots)) return false;
  if (value.roots.kind === "changed-files") {
    return hasExactKeys(value.roots, ["kind", "seedGraphId"])
      && boundedString(value.roots.seedGraphId, 2_048);
  }
  const items = value.roots.kind === "files"
    && hasExactKeys(value.roots, ["fileIds", "kind"])
    && Array.isArray(value.roots.fileIds)
    ? value.roots.fileIds
    : value.roots.kind === "file-paths"
      && hasExactKeys(value.roots, ["kind", "paths"])
      && Array.isArray(value.roots.paths)
      ? value.roots.paths
      : null;
  if (items === null || items.length === 0 || items.length > MAX_GRAPH_PROJECT_ROOTS) return false;
  let bytes = 0;
  const seen = new Set<string>();
  for (const item of items) {
    if (!boundedString(item, MAX_GRAPH_PROJECT_NODE_ID_BYTES)
      || (value.roots.kind === "files" && !nodeIdSchema.safeParse(item).success)
      || item.includes("\0")
      || seen.has(item)) return false;
    seen.add(item);
    bytes += Buffer.byteLength(item, "utf8");
    if (bytes > MAX_GRAPH_PROJECT_ROOT_BYTES) return false;
  }
  return true;
}

function artifactInput(value: unknown): value is GraphProjectWorkerArtifactInput {
  return isRecord(value)
    && hasExactKeys(value, ["bytes", "graphId", "path", "sha256"])
    && boundedString(value.graphId, 2_048)
    && typeof value.path === "string" && isAbsolute(value.path)
    && positiveSafeInteger(value.bytes)
    && typeof value.sha256 === "string" && SHA256.test(value.sha256);
}

function projectionOutput(value: unknown, maxRoots: number): boolean {
  return isRecord(value)
    && hasExactKeys(value, [
      "bytes",
      "completeRoots",
      "edges",
      "files",
      "loadedDepth",
      "nodes",
      "path",
      "roots",
      "sha256",
    ])
    && outputFile(value, MAX_GRAPH_PROJECT_OUTPUT_BYTES)
    && integerBetween(value.nodes, 0, MAX_GRAPH_PROJECT_OUTPUT_NODES)
    && integerBetween(value.edges, 0, MAX_GRAPH_PROJECT_OUTPUT_EDGES)
    && integerBetween(value.files, 0, MAX_GRAPH_PROJECT_OUTPUT_FILES)
    && integerBetween(value.roots, 0, maxRoots)
    && integerBetween(value.completeRoots, 0, value.roots as number)
    && integerBetween(value.loadedDepth, 0, MAX_GRAPH_PROJECT_ABSOLUTE_DEPTH);
}

function symbolOutput(value: unknown): boolean {
  return isRecord(value)
    && hasExactKeys(value, ["bytes", "count", "path", "sha256"])
    && outputFile(value, MAX_GRAPH_SYMBOL_OUTPUT_BYTES)
    && integerBetween(value.count, 0, MAX_GRAPH_SYMBOL_ENTRIES);
}

function topologyOutput(value: unknown): boolean {
  return isRecord(value)
    && hasExactKeys(value, ["adjacencyEntries", "bytes", "files", "path", "sha256"])
    && outputFile(value, MAX_GRAPH_TOPOLOGY_OUTPUT_BYTES)
    && integerBetween(value.files, 0, MAX_GRAPH_PROJECT_OUTPUT_FILES)
    && integerBetween(value.adjacencyEntries, 0, MAX_GRAPH_TOPOLOGY_ADJACENCY);
}

function outputFile(value: Record<string, unknown>, maxBytes: number): boolean {
  return typeof value.path === "string" && isAbsolute(value.path)
    && positiveSafeInteger(value.bytes) && value.bytes <= maxBytes
    && typeof value.sha256 === "string" && SHA256.test(value.sha256);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function boundedString(value: unknown, maxBytes: number): value is string {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= maxBytes;
}

function positiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function integerBetween(value: unknown, min: number, max: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;
}
