/**
 * Bounded syntax-only workspace index for progressive PR review.
 *
 * The scanner reads one exact-revision source at a time, derives the same structural identifiers as
 * the graph extractor, and immediately drops its ts-morph SourceFile. It never resolves symbols,
 * constructs relationship edges, builds logic flow, or retains a compiler graph. The same source
 * read also feeds the initial selector's import/dynamic-import/conservative-Electron-IPC topology
 * scanner.
 */

import { Buffer } from "node:buffer";
import { createWrappedNode, ts, type SourceFile } from "ts-morph";
import { buildNodeId, type CompactGraphSymbolEntry, type NodeId } from "@meridian/core";
import { moduleDescriptor } from "./descriptor-factory";
import { assignFinalIds, buildGraphNodes } from "./finalize-nodes";
import {
  scanTypeScriptProjectionTopology,
  type TypeScriptProjectionTopology,
} from "./initial-projection-files";
import { emitContainer } from "./member-emit";
import type { NodeDescriptor } from "./model";

const INDEXED_KINDS = new Set(["function", "method", "module", "class", "interface", "object"]);
const MAX_SOURCE_INDEX_PATH_BYTES = 8 * 1024 * 1024;

export interface TypeScriptSourceIndexLimits {
  maxFiles: number;
  maxSourceBytes: number;
  maxFileBytes: number;
  maxSymbols: number;
  maxAdjacencyEntries: number;
}

export interface TypeScriptSourceIndexOptions {
  root: string;
  /** Supplemental exact-revision files admitted to manifest-driven workspace scope. */
  seeds: readonly string[];
  exclude?: readonly string[];
  limits: TypeScriptSourceIndexLimits;
}

export interface TypeScriptSourceTopologyFile {
  path: string;
  fileId: NodeId;
  /** Canonical module IDs in deterministic path order. */
  neighbors: NodeId[];
  /** Reserved incomplete boundary bit; conservative TypeScript IPC pairing currently emits false. */
  uncertain: boolean;
}

export interface TypeScriptSourceIndex {
  /** Normalized supplemental roots used to admit stale-manifest review files. */
  seeds: string[];
  symbols: CompactGraphSymbolEntry[];
  topology: TypeScriptSourceTopologyFile[];
  sourceFileCount: number;
  sourceBytes: number;
  adjacencyEntries: number;
}

/** Build symbols and compact BFS topology from one shared sequence of immutable source reads. */
export function indexTypeScriptWorkspaceSources(options: TypeScriptSourceIndexOptions): TypeScriptSourceIndex {
  validateLimits(options.limits);
  const symbols: CompactGraphSymbolEntry[] = [];
  let sourceFileCount = 0;
  let sourceBytes = 0;
  let callbackError: unknown;

  const topology = scanTypeScriptProjectionTopology({
    root: options.root,
    seeds: options.seeds,
    exclude: options.exclude,
    maxFiles: options.limits.maxFiles,
    maxPathBytes: MAX_SOURCE_INDEX_PATH_BYTES,
    maxAdjacencyEntries: options.limits.maxAdjacencyEntries,
    onSource(file, source) {
      try {
        sourceFileCount += 1;
        if (sourceFileCount > options.limits.maxFiles) {
          throw new RangeError("TypeScript source index exceeded its file limit");
        }
        const bytes = Buffer.byteLength(source, "utf8");
        if (bytes > options.limits.maxFileBytes) {
          throw new RangeError("TypeScript source index encountered an oversized source file");
        }
        sourceBytes += bytes;
        if (sourceBytes > options.limits.maxSourceBytes) {
          throw new RangeError("TypeScript source index exceeded its source-byte limit");
        }
        for (const symbol of indexOneSource(file, source)) {
          symbols.push(symbol);
          if (symbols.length > options.limits.maxSymbols) {
            throw new RangeError("TypeScript source index exceeded its symbol limit");
          }
        }
      } catch (error) {
        callbackError = error;
        throw error;
      }
    },
  });
  // The selector intentionally fails closed for arbitrary filesystem/read failures. Preserve
  // actionable bounds from this trusted callback while keeping path details out of other errors.
  if (callbackError !== undefined) throw callbackError;
  if (topology === null) throw new TypeError("TypeScript source topology could not be proven");

  const compactTopology = topologyFiles(topology);
  const adjacencyEntries = compactTopology.reduce((count, file) => count + file.neighbors.length, 0);
  if (adjacencyEntries > options.limits.maxAdjacencyEntries) {
    throw new RangeError("TypeScript source index exceeded its adjacency limit");
  }

  symbols.sort((left, right) => left.displayName.localeCompare(right.displayName)
    || left.qualifiedName.localeCompare(right.qualifiedName)
    || left.id.localeCompare(right.id));
  return {
    seeds: [...topology.seeds],
    symbols,
    topology: compactTopology,
    sourceFileCount,
    sourceBytes,
    adjacencyEntries,
  };
}

function indexOneSource(file: string, source: string): CompactGraphSymbolEntry[] {
  // `createWrappedNode` gives the existing syntax-only structural emitters their ordinary ts-morph
  // API without a Project, language service, virtual filesystem, or retained compiler owner.
  const compilerSource = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const sourceFile = createWrappedNode(compilerSource, { sourceFile: compilerSource }) as SourceFile;
  const descriptors: NodeDescriptor[] = [];
  const emit = (descriptor: NodeDescriptor): NodeDescriptor => {
    descriptors.push(descriptor);
    return descriptor;
  };
  const context = { lang: "ts", modulePath: file, relPath: file, identityOnly: true };
  const moduleNode = emit(moduleDescriptor(context, sourceFile, null));
  emitContainer(sourceFile, moduleNode, [], { ...context, emit });
  assignFinalIds(descriptors);
  const nodes = buildGraphNodes(descriptors);
  const fileId = moduleNode.finalId;
  return nodes.flatMap((node): CompactGraphSymbolEntry[] => (
    INDEXED_KINDS.has(node.kind)
      ? [{
          id: node.id,
          fileId,
          displayName: node.displayName,
          qualifiedName: node.qualifiedName,
          kind: node.kind,
          file: node.location.file,
          isPrivateMethod: node.kind === "method" && node.displayName.startsWith("__"),
          // Flow is intentionally not extracted here. Hydrated graph nodes replace this compact
          // row in the renderer worker and supply their authoritative flow count.
          stepCount: null,
        }]
      : []
  ));
}

function topologyFiles(topology: TypeScriptProjectionTopology): TypeScriptSourceTopologyFile[] {
  const fileIds = new Map(topology.files.map(({ path }) => [path, moduleId(path)]));
  const uncertain = new Set(topology.uncertainFiles);
  return topology.files.map(({ path, neighbors }) => ({
    path,
    fileId: fileIds.get(path)!,
    neighbors: neighbors.map((neighbor) => fileIds.get(neighbor)!),
    uncertain: uncertain.has(path),
  }));
}

function moduleId(path: string): NodeId {
  return buildNodeId({ lang: "ts", modulePath: path });
}

function validateLimits(limits: TypeScriptSourceIndexLimits): void {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new RangeError(`TypeScript source index ${name} must be a positive integer`);
    }
  }
}
