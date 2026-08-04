/** Bounded stdlib-AST topology and symbol index for progressive partial Python graphs. */

import { Buffer } from "node:buffer";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import {
  compareBinaryStrings,
  closePythonExtractionFiles,
  nodeIdSchema,
  type CompactGraphSymbolEntry,
  type NodeId,
  type NodeKind,
} from "@meridian/core";
export { closePythonExtractionFiles } from "@meridian/core";
import { runPythonSourceIndexer } from "./analyzer";

const MAX_FILES = 100_000;
const MAX_SOURCE_BYTES = 1024 * 1024 * 1024;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_SYMBOLS = 500_000;
const MAX_ADJACENCY = 1_000_000;
const MAX_PATH_BYTES_TOTAL = 8 * 1024 * 1024;
const MAX_SELECTED_FILES = 20_000;
const MAX_PATH_BYTES = 4_096;
const INDEXED_KINDS = new Set<NodeKind>(["function", "method", "module", "class", "interface"]);

export interface PythonSourceIndexLimits {
  maxFiles: number;
  maxSourceBytes: number;
  maxFileBytes: number;
  maxSymbols: number;
  maxAdjacencyEntries: number;
}

export interface PythonSourceTopologyFile {
  path: string;
  fileId: NodeId;
  neighbors: NodeId[];
  uncertain: boolean;
}

export interface PythonSourceIndex {
  seeds: string[];
  symbols: CompactGraphSymbolEntry[];
  topology: PythonSourceTopologyFile[];
  sourceFileCount: number;
  sourceBytes: number;
  adjacencyEntries: number;
}

export interface PythonSourceIndexOptions {
  root: string;
  seeds: readonly string[];
  exclude?: readonly string[];
  limits: PythonSourceIndexLimits;
}

export interface InitialPythonProjectionOptions {
  root: string;
  seeds: readonly string[];
  depth: number;
  exclude?: readonly string[];
  maxSelectedFiles?: number;
}

export interface InitialPythonProjectionFiles {
  /** Requested weak-adjacency BFS files; these alone define projection/frontier state. */
  files: string[];
  /** BFS files plus minimal parsed allocator stabilizers needed for exact full-source IDs. */
  extractionFiles: string[];
  seeds: string[];
  frontier: string[];
}

/** Select a complete weak-import neighbourhood without constructing the semantic Python graph. */
export async function selectInitialPythonProjectionFiles(
  options: InitialPythonProjectionOptions,
): Promise<InitialPythonProjectionFiles | null> {
  if (!Number.isSafeInteger(options.depth) || options.depth < 0 || options.depth > 8) return null;
  const maxSelectedFiles = options.maxSelectedFiles ?? MAX_SELECTED_FILES;
  if (!Number.isSafeInteger(maxSelectedFiles) || maxSelectedFiles <= 0 || maxSelectedFiles > MAX_SELECTED_FILES) {
    return null;
  }
  if (options.seeds.length === 0) {
    return existingDirectory(options.root)
      ? { files: [], extractionFiles: [], seeds: [], frontier: [] }
      : null;
  }
  let indexed: PythonSourceIndex;
  try {
    indexed = await scanPythonWorkspaceSources({
      root: options.root,
      seeds: options.seeds,
      exclude: options.exclude,
      limits: defaultLimits(),
    }, false);
  } catch {
    return null;
  }
  const selected = bfs(indexed.topology, indexed.seeds, options.depth, maxSelectedFiles);
  if (selected === null) return null;
  const extractionFiles = closePythonExtractionFiles(indexed.topology, selected.files, maxSelectedFiles);
  return extractionFiles === null ? null : { ...selected, extractionFiles };
}

/** Build the complete source-backed Python symbol inventory and its shared import topology. */
export async function indexPythonWorkspaceSources(
  options: PythonSourceIndexOptions,
): Promise<PythonSourceIndex> {
  return scanPythonWorkspaceSources(options, true);
}

async function scanPythonWorkspaceSources(
  options: PythonSourceIndexOptions,
  includeSymbols: boolean,
): Promise<PythonSourceIndex> {
  validateLimits(options.limits);
  const root = canonicalDirectory(options.root);
  const seeds = normalizeSeeds(root, options.seeds);
  const raw = await runPythonSourceIndexer(root, {
    seeds,
    exclude: [...(options.exclude ?? [])],
    includeSymbols,
    ...options.limits,
    maxPathBytes: MAX_PATH_BYTES_TOTAL,
  });
  return parseIndex(raw, seeds, options.limits, includeSymbols);
}

function parseIndex(
  raw: unknown,
  expectedSeeds: readonly string[],
  limits: PythonSourceIndexLimits,
  includeSymbols: boolean,
): PythonSourceIndex {
  if (!isRecord(raw) || !exactKeys(raw, [
    "adjacencyEntries",
    "files",
    "seeds",
    "sourceBytes",
    "sourceFileCount",
    "symbols",
  ]) || !Array.isArray(raw.files) || !Array.isArray(raw.symbols) || !Array.isArray(raw.seeds)) {
    throw new TypeError("Python source index is invalid");
  }
  const sourceFileCount = boundedInteger(raw.sourceFileCount, 0, limits.maxFiles);
  const sourceBytes = boundedInteger(raw.sourceBytes, 0, limits.maxSourceBytes);
  const adjacencyEntries = boundedInteger(raw.adjacencyEntries, 0, limits.maxAdjacencyEntries);
  if (raw.files.length !== sourceFileCount || raw.symbols.length > limits.maxSymbols) {
    throw new TypeError("Python source index is invalid");
  }

  const topology: PythonSourceTopologyFile[] = [];
  const byId = new Map<string, PythonSourceTopologyFile>();
  const byPath = new Map<string, PythonSourceTopologyFile>();
  let observedAdjacency = 0;
  for (const value of raw.files) {
    if (!isRecord(value) || !exactKeys(value, ["fileId", "neighbors", "path", "uncertain"])
      || !safePath(value.path) || typeof value.fileId !== "string"
      || !pythonFileId(value.fileId) || value.uncertain !== false || !Array.isArray(value.neighbors)
      || byPath.has(value.path) || byId.has(value.fileId)) {
      throw new TypeError("Python source topology is invalid");
    }
    const neighbors: NodeId[] = [];
    const neighborIds = new Set<NodeId>();
    for (const neighbor of value.neighbors) {
      if (typeof neighbor !== "string" || !pythonFileId(neighbor) || neighbor === value.fileId
        || neighborIds.has(neighbor)) {
        throw new TypeError("Python source topology is invalid");
      }
      neighborIds.add(neighbor);
      neighbors.push(neighbor);
      observedAdjacency += 1;
    }
    neighbors.sort(compareBinaryStrings);
    const file = { path: value.path, fileId: value.fileId, neighbors, uncertain: false } satisfies PythonSourceTopologyFile;
    topology.push(file);
    byPath.set(file.path, file);
    byId.set(file.fileId, file);
  }
  topology.sort((left, right) => compareBinaryStrings(left.path, right.path));
  if (observedAdjacency !== adjacencyEntries) throw new TypeError("Python source topology is invalid");
  for (const file of topology) {
    for (const neighborId of file.neighbors) {
      const neighbor = byId.get(neighborId);
      if (neighbor === undefined || !neighbor.neighbors.includes(file.fileId)) {
        throw new TypeError("Python source topology is invalid");
      }
    }
  }

  const seeds = sortedPaths(raw.seeds, byPath);
  if (includeSymbols) {
    if (!sameStrings(seeds, expectedSeeds)) throw new TypeError("Python source-index seeds changed");
  } else {
    const requested = new Set(expectedSeeds);
    if (seeds.some((seed) => !requested.has(seed))) {
      throw new TypeError("Python source-index seeds changed");
    }
  }
  const symbols = includeSymbols ? raw.symbols.map((value) => parseSymbol(value, byId)) : [];
  if (!includeSymbols && raw.symbols.length !== 0) throw new TypeError("Python topology scan emitted symbols");
  return { seeds, symbols, topology, sourceFileCount, sourceBytes, adjacencyEntries };
}

function parseSymbol(value: unknown, byId: ReadonlyMap<string, PythonSourceTopologyFile>): CompactGraphSymbolEntry {
  if (!isRecord(value) || !exactKeys(value, [
    "displayName",
    "file",
    "fileId",
    "id",
    "isPrivateMethod",
    "kind",
    "qualifiedName",
    "stepCount",
  ]) || typeof value.id !== "string" || !nodeIdSchema.safeParse(value.id).success
    || typeof value.fileId !== "string" || !byId.has(value.fileId)
    || typeof value.displayName !== "string" || value.displayName.length === 0
    || typeof value.qualifiedName !== "string" || value.qualifiedName.length === 0
    || !INDEXED_KINDS.has(value.kind as NodeKind) || !safePath(value.file)
    || byId.get(value.fileId)?.path !== value.file
    || typeof value.isPrivateMethod !== "boolean" || value.stepCount !== null) {
    throw new TypeError("Python source symbol is invalid");
  }
  return value as unknown as CompactGraphSymbolEntry;
}

function bfs(
  topology: readonly PythonSourceTopologyFile[],
  seeds: readonly string[],
  depth: number,
  maxSelectedFiles: number,
): Omit<InitialPythonProjectionFiles, "extractionFiles"> | null {
  const byPath = new Map(topology.map((file) => [file.path, file]));
  const byId = new Map(topology.map((file) => [file.fileId, file]));
  const distance = new Map<string, number>();
  const queue: PythonSourceTopologyFile[] = [];
  for (const path of seeds) {
    const file = byPath.get(path);
    if (file === undefined) return null;
    distance.set(file.fileId, 0);
    queue.push(file);
  }
  for (let index = 0; index < queue.length; index += 1) {
    const file = queue[index]!;
    const nextDepth = distance.get(file.fileId)! + 1;
    if (nextDepth > depth) continue;
    for (const neighborId of file.neighbors) {
      if (distance.has(neighborId)) continue;
      const neighbor = byId.get(neighborId);
      if (neighbor === undefined) return null;
      distance.set(neighborId, nextDepth);
      if (distance.size > maxSelectedFiles) return null;
      queue.push(neighbor);
    }
  }
  const selected = topology.filter((file) => distance.has(file.fileId));
  const selectedIds = new Set(selected.map((file) => file.fileId));
  return {
    files: selected.map((file) => file.path),
    seeds: [...seeds],
    frontier: selected
      .filter((file) => file.uncertain || file.neighbors.some((neighbor) => !selectedIds.has(neighbor)))
      .map((file) => file.path),
  };
}

function normalizeSeeds(root: string, values: readonly string[]): string[] {
  const result = new Set<string>();
  for (const value of values) {
    if (!safePath(value) || isAbsolute(value)) throw new TypeError("Python source-index seed is invalid");
    let canonical: string;
    try {
      canonical = realpathSync.native(resolve(root, value));
    } catch {
      throw new TypeError("Python source-index seed is unavailable");
    }
    const normalized = relative(root, canonical).replaceAll("\\", "/");
    if (normalized !== value || normalized.startsWith("../")) {
      throw new TypeError("Python source-index seed escaped its workspace");
    }
    result.add(normalized);
  }
  return [...result].sort(compareBinaryStrings);
}

function canonicalDirectory(root: string): string {
  const canonical = realpathSync.native(root);
  if (!statSync(canonical).isDirectory()) throw new TypeError("Python source-index root is invalid");
  return canonical;
}

function existingDirectory(root: string): boolean {
  try {
    canonicalDirectory(root);
    return true;
  } catch {
    return false;
  }
}

function validateLimits(limits: PythonSourceIndexLimits): void {
  const pairs: Array<[number, number]> = [
    [limits.maxFiles, MAX_FILES],
    [limits.maxSourceBytes, MAX_SOURCE_BYTES],
    [limits.maxFileBytes, MAX_FILE_BYTES],
    [limits.maxSymbols, MAX_SYMBOLS],
    [limits.maxAdjacencyEntries, MAX_ADJACENCY],
  ];
  if (pairs.some(([value, maximum]) => !Number.isSafeInteger(value) || value <= 0 || value > maximum)) {
    throw new TypeError("Python source-index limits are invalid");
  }
}

function defaultLimits(): PythonSourceIndexLimits {
  return {
    maxFiles: MAX_FILES,
    maxSourceBytes: MAX_SOURCE_BYTES,
    maxFileBytes: MAX_FILE_BYTES,
    maxSymbols: MAX_SYMBOLS,
    maxAdjacencyEntries: MAX_ADJACENCY,
  };
}

function sortedPaths(values: unknown[], byPath: ReadonlyMap<string, unknown>): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (!safePath(value) || !byPath.has(value) || seen.has(value)) {
      throw new TypeError("Python source-index seeds are invalid");
    }
    seen.add(value);
    result.push(value);
  }
  return result.sort(compareBinaryStrings);
}

function pythonFileId(value: string): value is NodeId {
  const parsed = nodeIdSchema.safeParse(value);
  return parsed.success && value.startsWith("py:") && !value.includes("#");
}

function safePath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0
    && Buffer.byteLength(value, "utf8") <= MAX_PATH_BYTES
    && value.endsWith(".py") && !value.startsWith("/") && !value.includes("\\") && !value.includes("\0")
    && value.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
}

function boundedInteger(value: unknown, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new TypeError("Python source-index count is invalid");
  }
  return value as number;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort(compareBinaryStrings).join("\0")
    === [...keys].sort(compareBinaryStrings).join("\0");
}
