/**
 * The module IMPORT graph: file to file adjacency folded from the artifact's `imports` edges. This
 * is the substrate the Module-map lens walks for its blast radius, kept separate from the
 * behavioural call graph. Endpoints are always `module` nodes — an edge that lands on a member
 * (function/method) is lifted to its owning file so the graph stays file-to-file. Pure; no React.
 */

import type { GraphEdge, GraphNode } from "@meridian/core";
import { parseNodeId } from "@meridian/core";
import type { GraphIndex } from "../graph/graphIndex";

const MODULE_KIND = "module";
const IMPORT_KIND = "imports";
// A NUL join so no path/id character can forge a collision between two different ordered pairs.
const KEY_SEP = "\u0000";

export interface ModuleGraph {
  /** Every source-file (`module`) node id — the universe the reach walk lives in. */
  fileIds: Set<string>;
  /** Forward import adjacency: importer to imported files. */
  out: Map<string, Set<string>>;
  /** Reverse adjacency: file to its importers (afferent). */
  in: Map<string, Set<string>>;
  /** Import multiplicity per ordered pair, keyed by `weightKey(src, tgt)`. */
  weight: Map<string, number>;
}

/** The stable weight-map key for an ordered file pair. */
export function weightKey(source: string, target: string): string {
  return `${source}${KEY_SEP}${target}`;
}

/** Fold the artifact's resolved `imports` edges into a file-to-file graph. */
export function buildModuleGraph(index: GraphIndex): ModuleGraph {
  const graph = emptyGraph(collectModuleIds(index));
  for (const edge of index.edges) {
    if (isResolvedImport(edge)) {
      addImport(graph, index, edge);
    }
  }
  return graph;
}

/**
 * The blast-radius centre, resolved by falling priority: the first caller-supplied entry module that
 * exists, then an entry-named module (main/index/app/…), then the most-imported module, then null.
 * Hiding categories NEVER enters here — the root is chosen over the whole file universe.
 */
export function resolveModuleRoot(index: GraphIndex, entryModules: string[] | undefined): string | null {
  return firstExistingModule(index, entryModules ?? []) ?? entryNamedModule(index) ?? mostImportedModule(index);
}

function isResolvedImport(edge: GraphEdge): boolean {
  return edge.kind === IMPORT_KIND && edge.resolution === "resolved";
}

/** Lift both endpoints to their owning files, then record a non-self import in all three maps. */
function addImport(graph: ModuleGraph, index: GraphIndex, edge: GraphEdge): void {
  const source = nearestModuleId(index, edge.source);
  const target = nearestModuleId(index, edge.target);
  if (source === null || target === null || source === target) {
    return;
  }
  addAdjacency(graph.out, source, target);
  addAdjacency(graph.in, target, source);
  const key = weightKey(source, target);
  graph.weight.set(key, (graph.weight.get(key) ?? 0) + 1);
}

/** Walk `parentId` up to the nearest `module` ancestor (visited-guarded against a parentId cycle). */
function nearestModuleId(index: GraphIndex, nodeId: string): string | null {
  const visited = new Set<string>();
  let current: GraphNode | undefined = index.nodesById.get(nodeId);
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    if (current.kind === MODULE_KIND) {
      return current.id;
    }
    current = current.parentId ? index.nodesById.get(current.parentId) : undefined;
  }
  return null;
}

function addAdjacency(map: Map<string, Set<string>>, from: string, to: string): void {
  const neighbours = map.get(from);
  if (neighbours) {
    neighbours.add(to);
    return;
  }
  map.set(from, new Set([to]));
}

function emptyGraph(fileIds: Set<string>): ModuleGraph {
  return { fileIds, out: new Map(), in: new Map(), weight: new Map() };
}

function collectModuleIds(index: GraphIndex): Set<string> {
  const ids = new Set<string>();
  for (const node of index.nodesById.values()) {
    if (node.kind === MODULE_KIND) {
      ids.add(node.id);
    }
  }
  return ids;
}

function firstExistingModule(index: GraphIndex, candidateIds: string[]): string | null {
  for (const id of candidateIds) {
    if (index.nodesById.get(id)?.kind === MODULE_KIND) {
      return id;
    }
  }
  return null;
}

// Entry-point-shaped file names. Matched against the file's own BASENAME, not the whole path — an
// `app/` directory must not make every file under it read as entry.
const ENTRY_MODULE_NAME = /^(main|index|bootstrap|app|entry|boot|server|start|root)\b/i;

/** The shallowest entry-named module (fewest path segments), id tie-break — a stable default centre. */
function entryNamedModule(index: GraphIndex): string | null {
  const matches = moduleNodes(index).filter((node) => ENTRY_MODULE_NAME.test(basenameOf(node.id)));
  return shallowestModulePath(matches);
}

function basenameOf(nodeId: string): string {
  const segments = parseNodeId(nodeId).modulePath.split("/");
  return segments[segments.length - 1] ?? "";
}

function shallowestModulePath(nodes: GraphNode[]): string | null {
  let best: GraphNode | null = null;
  for (const node of nodes) {
    if (best === null || isShallower(node, best)) {
      best = node;
    }
  }
  return best?.id ?? null;
}

function isShallower(candidate: GraphNode, incumbent: GraphNode): boolean {
  const depth = depthOf(candidate);
  const incumbentDepth = depthOf(incumbent);
  return depth < incumbentDepth || (depth === incumbentDepth && candidate.id < incumbent.id);
}

function depthOf(node: GraphNode): number {
  return parseNodeId(node.id).modulePath.split("/").length;
}

/** The most depended-upon file (max afferent imports), lowest id on a tie; null when none is imported. */
function mostImportedModule(index: GraphIndex): string | null {
  const graph = buildModuleGraph(index);
  let best: string | null = null;
  let bestCount = 0;
  for (const id of [...graph.fileIds].sort()) {
    const count = graph.in.get(id)?.size ?? 0;
    if (count > bestCount) {
      best = id;
      bestCount = count;
    }
  }
  return best;
}

function moduleNodes(index: GraphIndex): GraphNode[] {
  return [...index.nodesById.values()].filter((node) => node.kind === MODULE_KIND);
}
