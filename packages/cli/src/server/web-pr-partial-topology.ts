/** Strict compact source-topology contract used by exact-revision partial graph expansion. */

import {
  buildNodeId,
  closePythonExtractionFiles,
  compareBinaryStrings,
  nodeIdSchema,
  parseNodeId,
  preparePythonExtractionFileClosure,
  targetSchema,
  type CompactGraphSymbolEntry,
  type GraphProjectionRequestV1,
  type Target,
} from "@meridian/core";
import { WebError } from "./web-error";

export const PR_PARTIAL_SOURCE_TOPOLOGY_VERSION = 1 as const;
export const MAX_PR_PARTIAL_TOPOLOGY_FILES = 100_000;
export const MAX_PR_PARTIAL_TOPOLOGY_ADJACENCY = 1_000_000;
/** One expansion remains materially smaller than the repository-wide source index. */
export const MAX_PR_PARTIAL_SELECTED_FILES = 20_000;
/** Public requested depth is at most six; extraction owns one extra frontier-ghost ring. */
export const MAX_PR_PARTIAL_EXTRACTION_DEPTH = 7;
const MAX_PATH_BYTES = 4_096;
const MAX_PATH_BYTES_TOTAL = 8 * 1024 * 1024;
const MAX_GRAPH_ID_BYTES = 2_048;
const SHA256 = /^[a-f0-9]{64}$/;

export interface PrPartialSourceTopologyFileV1 {
  path: string;
  fileId: string;
  neighbors: string[];
  uncertain: boolean;
}

export interface PrPartialSourceTopologyV1 {
  version: typeof PR_PARTIAL_SOURCE_TOPOLOGY_VERSION;
  graphId: string;
  generation: string;
  target: Target;
  changedSinceBaseRef: string | null;
  seeds: string[];
  files: PrPartialSourceTopologyFileV1[];
}

export interface PrPartialTopologySelection {
  seeds: string[];
  selectedFiles: string[];
  /** Selected files plus hidden Python allocator stabilizers used only by semantic extraction. */
  extractionFiles: string[];
  frontierFiles: string[];
}

/**
 * Remove source-index symbols whose owning file cannot satisfy the palette's depth-one hydration
 * contract. The decision uses the same selected/extraction cap as projection, including hidden
 * Python identity stabilizers, and unknown file IDs fail closed.
 */
export function filterPrPartialDepthOneSymbols(
  topology: PrPartialSourceTopologyV1,
  symbols: readonly CompactGraphSymbolEntry[],
): CompactGraphSymbolEntry[] {
  const byId = new Map(topology.files.map((file) => [file.fileId, file]));
  let extractionClosure: ReturnType<typeof preparePythonExtractionFileClosure> | undefined;
  const admitted = new Map<string, boolean>();
  const canHydrate = (fileId: string): boolean => {
    const cached = admitted.get(fileId);
    if (cached !== undefined) return cached;
    const root = byId.get(fileId);
    if (root === undefined || root.neighbors.length >= MAX_PR_PARTIAL_SELECTED_FILES) {
      admitted.set(fileId, false);
      return false;
    }
    const selectedFiles = [
      root.path,
      ...root.neighbors.map((neighborId) => byId.get(neighborId)?.path),
    ];
    const valid = selectedFiles.every((path): path is string => path !== undefined)
      && (selectedFiles.every((path) => !path.endsWith(".py"))
        || (extractionClosure ??= preparePythonExtractionFileClosure(topology.files))
          .fits(selectedFiles, MAX_PR_PARTIAL_SELECTED_FILES));
    admitted.set(fileId, valid);
    return valid;
  };
  return symbols.filter((symbol) => canHydrate(symbol.fileId));
}

/** Parse and correlate a child-produced topology before it can influence extractor file access. */
export function parsePrPartialSourceTopology(
  value: unknown,
  expected: { graphId: string; generation: string },
): PrPartialSourceTopologyV1 {
  if (!isRecord(value) || !hasExactKeys(value, [
    "changedSinceBaseRef",
    "files",
    "generation",
    "graphId",
    "seeds",
    "target",
    "version",
  ])) throw invalidTopology();
  if (
    value.version !== PR_PARTIAL_SOURCE_TOPOLOGY_VERSION
    || value.graphId !== expected.graphId
    || value.generation !== expected.generation
    || !boundedString(value.graphId, MAX_GRAPH_ID_BYTES)
    || typeof value.generation !== "string"
    || !SHA256.test(value.generation)
    || (value.changedSinceBaseRef !== null && !boundedString(value.changedSinceBaseRef, MAX_PATH_BYTES))
    || !Array.isArray(value.files)
    || value.files.length > MAX_PR_PARTIAL_TOPOLOGY_FILES
    || !Array.isArray(value.seeds)
  ) throw invalidTopology();
  const target = targetSchema.safeParse(value.target);
  if (!target.success) throw invalidTopology();

  const files: PrPartialSourceTopologyFileV1[] = [];
  const pathById = new Map<string, string>();
  const fileByPath = new Map<string, PrPartialSourceTopologyFileV1>();
  let pathBytes = 0;
  let adjacencyEntries = 0;
  for (const raw of value.files) {
    if (!isRecord(raw) || !hasExactKeys(raw, ["fileId", "neighbors", "path", "uncertain"])) {
      throw invalidTopology();
    }
    const path = raw.path;
    const fileId = raw.fileId;
    if (
      !safePath(path)
      || typeof fileId !== "string"
      || !sourceFileId(path, fileId)
      || typeof raw.uncertain !== "boolean"
      || !Array.isArray(raw.neighbors)
      || fileByPath.has(path)
      || pathById.has(fileId)
    ) throw invalidTopology();
    pathBytes += Buffer.byteLength(path, "utf8");
    if (pathBytes > MAX_PATH_BYTES_TOTAL) throw invalidTopology();
    const neighbors: string[] = [];
    const neighborIds = new Set<string>();
    for (const neighbor of raw.neighbors) {
      if (
        typeof neighbor !== "string"
        || neighbor === fileId
        || neighborIds.has(neighbor)
      ) throw invalidTopology();
      neighbors.push(neighbor);
      neighborIds.add(neighbor);
      adjacencyEntries += 1;
      if (adjacencyEntries > MAX_PR_PARTIAL_TOPOLOGY_ADJACENCY) throw invalidTopology();
    }
    neighbors.sort(compareBinaryStrings);
    const file = { path, fileId, neighbors, uncertain: raw.uncertain };
    files.push(file);
    fileByPath.set(path, file);
    pathById.set(fileId, path);
  }
  files.sort((left, right) => compareBinaryStrings(left.path, right.path));
  for (const file of files) {
    for (const neighborId of file.neighbors) {
      const neighborPath = pathById.get(neighborId);
      const neighbor = neighborPath === undefined ? undefined : fileByPath.get(neighborPath);
      // Neighbor lists are strictly sorted above. Binary lookup keeps symmetric-edge validation
      // O(E log degree) for high-degree stars instead of degenerating toward O(E * degree) at the
      // one-million-entry wire bound.
      if (neighbor === undefined || !sortedContains(neighbor.neighbors, file.fileId)) {
        throw invalidTopology();
      }
    }
  }
  if (!pythonFileIdentitiesCorrelate(files)) throw invalidTopology();
  const seeds = parseCanonicalPaths(value.seeds, fileByPath);
  return {
    version: PR_PARTIAL_SOURCE_TOPOLOGY_VERSION,
    graphId: value.graphId,
    generation: value.generation,
    target: target.data,
    changedSinceBaseRef: value.changedSinceBaseRef as string | null,
    seeds,
    files,
  };
}

function sortedContains(values: readonly string[], expected: string): boolean {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    const value = values[middle]!;
    if (compareBinaryStrings(value, expected) < 0) low = middle + 1;
    else high = middle;
  }
  return values[low] === expected;
}

/** Compute one deterministic weak-adjacency BFS without retaining source text or compiler state. */
export function selectPrPartialTopology(
  topology: PrPartialSourceTopologyV1,
  roots: GraphProjectionRequestV1["roots"],
  depth: number,
): PrPartialTopologySelection {
  if (!Number.isSafeInteger(depth) || depth < 0 || depth > MAX_PR_PARTIAL_EXTRACTION_DEPTH) {
    throw new WebError(400, "partial graph expansion depth is invalid");
  }
  const byId = new Map(topology.files.map((file) => [file.fileId, file]));
  const byPath = new Map(topology.files.map((file) => [file.path, file]));
  let rootFiles: PrPartialSourceTopologyFileV1[];
  if (roots.kind === "changed-files") {
    rootFiles = topology.seeds.map((path) => byPath.get(path)!).filter(Boolean);
  } else if (roots.kind === "file-paths") {
    rootFiles = roots.paths.map((path) => byPath.get(path)).filter(
      (file): file is PrPartialSourceTopologyFileV1 => file !== undefined,
    );
  } else {
    rootFiles = roots.fileIds.map((id) => {
      const file = byId.get(id);
      if (file === undefined) {
        throw new WebError(422, "partial graph expansion root is not an exact source file");
      }
      return file;
    });
  }
  rootFiles = [...new Map(rootFiles.map((file) => [file.path, file])).values()]
    .sort((left, right) => compareBinaryStrings(left.path, right.path));
  if (rootFiles.length > MAX_PR_PARTIAL_SELECTED_FILES) {
    throw new WebError(422, "partial graph expansion exceeded its selected-file limit");
  }

  const distance = new Map<string, number>();
  const queue: PrPartialSourceTopologyFileV1[] = [];
  for (const file of rootFiles) {
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
      if (neighbor === undefined) throw invalidTopology();
      distance.set(neighborId, nextDepth);
      if (distance.size > MAX_PR_PARTIAL_SELECTED_FILES) {
        throw new WebError(422, "partial graph expansion exceeded its selected-file limit");
      }
      queue.push(neighbor);
    }
  }
  const selected = topology.files.filter((file) => distance.has(file.fileId));
  const selectedIds = new Set(selected.map((file) => file.fileId));
  const selectedFiles = selected.map((file) => file.path);
  const extractionFiles = closePythonExtractionFiles(
    topology.files,
    selectedFiles,
    MAX_PR_PARTIAL_SELECTED_FILES,
  );
  if (extractionFiles === null) {
    throw new WebError(422, "partial graph expansion exceeded its selected-file limit");
  }
  return {
    seeds: rootFiles.map((file) => file.path),
    selectedFiles,
    extractionFiles,
    frontierFiles: selected
      .filter((file) => file.uncertain || file.neighbors.some((neighbor) => !selectedIds.has(neighbor)))
      .map((file) => file.path),
  };
}

function parseCanonicalPaths(
  value: unknown[],
  files: ReadonlyMap<string, PrPartialSourceTopologyFileV1>,
): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const path of value) {
    if (!safePath(path) || !files.has(path) || seen.has(path)) {
      throw invalidTopology();
    }
    result.push(path);
    seen.add(path);
  }
  return result.sort(compareBinaryStrings);
}

function safePath(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && Buffer.byteLength(value, "utf8") <= MAX_PATH_BYTES
    && !value.startsWith("/")
    && !value.includes("\\")
    && !value.includes("\0")
    && (/\.tsx?$/.test(value) || value.endsWith(".py"))
    && !/\.d\.ts$/.test(value)
    && value.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
}

function sourceFileId(path: string, fileId: string): boolean {
  if (!nodeIdSchema.safeParse(fileId).success) return false;
  if (/\.tsx?$/.test(path)) {
    return !/\.d\.ts$/.test(path) && fileId === buildNodeId({ lang: "ts", modulePath: path });
  }
  if (!path.endsWith(".py")) return false;
  const parsed = parseNodeId(fileId);
  return parsed.lang === "py" && parsed.qualname === undefined;
}

/**
 * Python file nodes use import identities rather than repository paths. Prove that every Python
 * path/id pair belongs to one globally consistent production source-anchor profile, then replay
 * the extractor's package-first/file-discovery allocator (including `foo.py` vs
 * `foo/__init__.py` ordinals). A path/id swap cannot satisfy this proof even though either ID is a
 * syntactically valid `py:*` node.
 */
function pythonFileIdentitiesCorrelate(files: readonly PrPartialSourceTopologyFileV1[]): boolean {
  const python = files.filter((file) => file.path.endsWith(".py"));
  if (python.length === 0) return true;
  for (const stripRootSrc of [false, true]) {
    const prefix = inferPythonFallbackPrefix(python, stripRootSrc);
    if (prefix === null) continue;
    const graphPathByFile = new Map<string, string>();
    let valid = true;
    for (const file of python) {
      const relativePath = stripRootSrc && file.path.startsWith("src/")
        ? file.path.slice("src/".length)
        : file.path;
      const relativeModule = pythonRelativeModule(relativePath);
      const graphPath = stripRootSrc && file.path.startsWith("src/")
        ? relativeModule
        : dottedJoin(prefix, relativeModule);
      if (graphPath.length === 0) {
        valid = false;
        break;
      }
      graphPathByFile.set(file.path, graphPath);
    }
    if (valid && pythonAllocatedIdsMatch(python, graphPathByFile)) return true;
  }
  return false;
}

function inferPythonFallbackPrefix(
  files: readonly PrPartialSourceTopologyFileV1[],
  stripRootSrc: boolean,
): string | null {
  let prefix: string | undefined;
  for (const file of files) {
    if (stripRootSrc && file.path.startsWith("src/")) {
      const expected = pythonRelativeModule(file.path.slice("src/".length));
      if (parseNodeId(file.fileId).modulePath !== expected) return null;
      continue;
    }
    const relativeModule = pythonRelativeModule(file.path);
    const modulePath = parseNodeId(file.fileId).modulePath;
    const candidate = removeDottedSuffix(modulePath, relativeModule);
    if (candidate === null || (prefix !== undefined && prefix !== candidate)) return null;
    prefix = candidate;
  }
  return prefix ?? "";
}

function pythonRelativeModule(path: string): string {
  const parts = path.slice(0, -".py".length).split("/");
  if (parts.at(-1) === "__init__") parts.pop();
  return parts.join(".");
}

function removeDottedSuffix(modulePath: string, suffix: string): string | null {
  if (suffix.length === 0) return modulePath;
  if (modulePath === suffix) return "";
  return modulePath.endsWith(`.${suffix}`)
    ? modulePath.slice(0, -(suffix.length + 1))
    : null;
}

function dottedJoin(prefix: string, suffix: string): string {
  return prefix.length === 0 ? suffix : suffix.length === 0 ? prefix : `${prefix}.${suffix}`;
}

function pythonAllocatedIdsMatch(
  files: readonly PrPartialSourceTopologyFileV1[],
  graphPathByFile: ReadonlyMap<string, string>,
): boolean {
  const packagePaths = new Set<string>();
  for (const file of files) {
    const graphPath = graphPathByFile.get(file.path)!;
    const segments = graphPath.split(".");
    for (let depth = 1; depth < segments.length; depth += 1) {
      packagePaths.add(segments.slice(0, depth).join("."));
    }
    if (file.path.endsWith("/__init__.py") || file.path === "__init__.py") {
      packagePaths.add(graphPath);
    }
  }
  const counts = new Map<string, number>();
  const allocate = (base: string): string => {
    const ordinal = counts.get(base) ?? 0;
    counts.set(base, ordinal + 1);
    return ordinal === 0 ? base : `${base}~${ordinal}`;
  };
  const packageIds = new Map([...packagePaths]
    .sort((left, right) => left.split(".").length - right.split(".").length || left.localeCompare(right))
    .map((path) => [path, allocate(buildNodeId({ lang: "py", modulePath: path }))]));
  const byPath = new Map(files.map((file) => [file.path, file]));
  for (const path of pythonDiscoveryOrder(files.map((file) => file.path))) {
    const file = byPath.get(path)!;
    const graphPath = graphPathByFile.get(path)!;
    const packageInitializer = path.endsWith("/__init__.py") || path === "__init__.py";
    const expected = packageInitializer
      ? packageIds.get(graphPath)
      : allocate(buildNodeId({ lang: "py", modulePath: graphPath }));
    if (expected === undefined || expected !== file.fileId) return false;
  }
  return true;
}

/** Reproduce `os.walk`: files in a directory precede its lexically sorted child directories. */
function pythonDiscoveryOrder(paths: readonly string[]): string[] {
  const filesByDirectory = new Map<string, string[]>();
  const childDirectories = new Map<string, Set<string>>();
  for (const path of paths) {
    const parts = path.split("/");
    const file = parts.pop()!;
    const directory = parts.join("/");
    const files = filesByDirectory.get(directory) ?? [];
    files.push(file);
    filesByDirectory.set(directory, files);
    for (let depth = 0; depth < parts.length; depth += 1) {
      const parent = parts.slice(0, depth).join("/");
      const children = childDirectories.get(parent) ?? new Set<string>();
      children.add(parts[depth]!);
      childDirectories.set(parent, children);
    }
  }
  const result: string[] = [];
  const visit = (directory: string) => {
    for (const file of [...(filesByDirectory.get(directory) ?? [])].sort()) {
      result.push(directory.length === 0 ? file : `${directory}/${file}`);
    }
    for (const child of [...(childDirectories.get(directory) ?? [])].sort()) {
      visit(directory.length === 0 ? child : `${directory}/${child}`);
    }
  };
  visit("");
  return result;
}

function boundedString(value: unknown, maxBytes: number): value is string {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= maxBytes;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort(compareBinaryStrings).join("\0")
    === [...keys].sort(compareBinaryStrings).join("\0");
}

function invalidTopology(): WebError {
  return new WebError(422, "partial graph source topology is invalid");
}
