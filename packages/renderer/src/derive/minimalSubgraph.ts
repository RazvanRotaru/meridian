/**
 * The minimal containment subtree behind the PR-review graph pane: the ancestor union over every
 * affected (seed) module, PLUS each seed's DIRECT 1-hop import neighbors in BOTH directions (files
 * it imports = context, files importing it = blast radius) as faded boundary nodes, capped per seed.
 * Boundary ancestors join the union too. Import wires are folded to affected<->affected and
 * affected<->boundary only (never boundary<->boundary). Single-child package chains collapse AFTER
 * the union + boundary. The result is a nested (parentId) spec the layout stage lays out with ELK.
 * Pure; no React, no ELK. Reuses the module import graph and the Module-map card-data shapes.
 */

import type { GraphNode } from "@meridian/core";
import type { GraphIndex } from "../graph/graphIndex";
import { weightKey, type ModuleGraph } from "./moduleGraph";
import { categorize } from "./moduleCategory";
import type { ChangeStatus } from "./changeStatus";
import { normalizePath } from "./matchAffectedFiles";
import { collapseChains, type ChainCollapse } from "./collapseChains";
import type { ModuleCardData } from "./moduleLevel";
import type { ModulePackageData } from "./packageOverview";

const MODULE_KIND = "module";
const DEFAULT_BOUNDARY_CAP = 12;

export interface MinimalSubgraphNode {
  id: string;
  kind: "group" | "file";
  parentId: string | null;
  isBoundary: boolean;
  /** The PR change status of an AFFECTED (non-boundary) file; undefined on boundary + group frames. */
  changeStatus?: ChangeStatus;
  /** Joined path segments when this frame is a collapsed package chain. */
  collapsedLabel?: string;
  data: ModuleCardData | ModulePackageData;
}

export interface MinimalSubgraphEdge {
  id: string;
  source: string;
  target: string;
  weight: number;
}

export interface MinimalSubgraphSpec {
  nodes: MinimalSubgraphNode[];
  edges: MinimalSubgraphEdge[];
}

export interface MinimalSubgraph {
  spec: MinimalSubgraphSpec;
  keptNodeIds: string[];
  boundaryNodeIds: string[];
}

export interface MinimalSubgraphOptions {
  boundaryCap?: number;
  includeBoundary?: boolean;
}

export function buildMinimalSubgraph(
  index: GraphIndex,
  moduleGraph: ModuleGraph,
  seedModuleIds: ReadonlySet<string>,
  options: MinimalSubgraphOptions = {},
  statusByFile: Record<string, ChangeStatus> = {},
): MinimalSubgraph {
  const boundary = wantsBoundary(options)
    ? boundaryNeighbors(moduleGraph, seedModuleIds, capOf(options))
    : new Set<string>();
  const keptFileIds = new Set<string>([...seedModuleIds, ...boundary]);
  const { keptNodeIds, fileCountByGroup } = closeOverAncestors(index, keptFileIds);
  const collapse = collapseChains(index, keptNodeIds);
  const context: NodeContext = { keptNodeIds, boundary, collapse, fileCountByGroup, statusByFile };
  return {
    spec: { nodes: buildNodes(index, moduleGraph, context), edges: buildEdges(moduleGraph, seedModuleIds, keptFileIds) },
    keptNodeIds: [...keptNodeIds].sort(),
    boundaryNodeIds: [...boundary].sort(),
  };
}

function wantsBoundary(options: MinimalSubgraphOptions): boolean {
  return options.includeBoundary !== false;
}

function capOf(options: MinimalSubgraphOptions): number {
  return options.boundaryCap ?? DEFAULT_BOUNDARY_CAP;
}

/** 1-hop import neighbors (both directions) of the seeds, minus seeds, capped per seed. */
function boundaryNeighbors(graph: ModuleGraph, seeds: ReadonlySet<string>, cap: number): Set<string> {
  const boundary = new Set<string>();
  for (const seed of [...seeds].sort()) {
    for (const neighbor of cappedNeighbors(graph, seed, seeds, cap)) {
      boundary.add(neighbor);
    }
  }
  return boundary;
}

function cappedNeighbors(graph: ModuleGraph, seed: string, seeds: ReadonlySet<string>, cap: number): string[] {
  const notSeed = (id: string) => !seeds.has(id);
  const importers = [...(graph.in.get(seed) ?? [])].filter(notSeed).sort(); // blast radius
  const imports = [...(graph.out.get(seed) ?? [])].filter(notSeed).sort(); // context
  return interleave(importers, imports).slice(0, cap);
}

/** Round-robin two id lists (importers first each round, deduped) so neither direction is starved by the cap. */
function interleave(importers: string[], imports: string[]): string[] {
  const merged: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < Math.max(importers.length, imports.length); i += 1) {
    for (const id of [importers[i], imports[i]]) {
      if (id !== undefined && !seen.has(id)) {
        seen.add(id);
        merged.push(id);
      }
    }
  }
  return merged;
}

/** Ancestor-close the kept files (root..file inclusive) and tally kept files per ancestor frame. */
function closeOverAncestors(index: GraphIndex, keptFileIds: ReadonlySet<string>) {
  const keptNodeIds = new Set<string>();
  const fileCountByGroup = new Map<string, number>();
  for (const fileId of keptFileIds) {
    for (const ancestor of index.ancestorsOf(fileId)) {
      keptNodeIds.add(ancestor.id);
      if (ancestor.id !== fileId) {
        fileCountByGroup.set(ancestor.id, (fileCountByGroup.get(ancestor.id) ?? 0) + 1);
      }
    }
  }
  return { keptNodeIds, fileCountByGroup };
}

interface NodeContext {
  keptNodeIds: Set<string>;
  boundary: Set<string>;
  collapse: ChainCollapse;
  fileCountByGroup: Map<string, number>;
  statusByFile: Record<string, ChangeStatus>;
}

function buildNodes(index: GraphIndex, graph: ModuleGraph, context: NodeContext): MinimalSubgraphNode[] {
  const nodes: MinimalSubgraphNode[] = [];
  for (const id of context.keptNodeIds) {
    const node = index.nodesById.get(id);
    if (!node || context.collapse.absorbed.has(id)) {
      continue;
    }
    nodes.push(node.kind === MODULE_KIND ? fileNode(node, graph, context) : groupNode(node, context));
  }
  return nodes.sort((a, b) => a.id.localeCompare(b.id));
}

function fileNode(node: GraphNode, graph: ModuleGraph, context: NodeContext): MinimalSubgraphNode {
  const file = normalizePath(node.location.file);
  const isBoundary = context.boundary.has(node.id);
  return {
    id: node.id,
    kind: "file",
    parentId: context.collapse.parentById.get(node.id) ?? null,
    isBoundary,
    // Only AFFECTED (seed) files carry a change status; a boundary neighbour is unchanged context.
    changeStatus: isBoundary ? undefined : context.statusByFile[file] ?? "modified",
    data: {
      label: node.displayName,
      fullPath: file,
      category: categorize(file),
      inCount: graph.in.get(node.id)?.size ?? 0,
      outCount: graph.out.get(node.id)?.size ?? 0,
      isEntry: false,
    },
  };
}

function groupNode(node: GraphNode, context: NodeContext): MinimalSubgraphNode {
  const collapsedLabel = context.collapse.labelById.get(node.id);
  return {
    id: node.id,
    kind: "group",
    parentId: context.collapse.parentById.get(node.id) ?? null,
    isBoundary: false,
    collapsedLabel,
    data: { label: collapsedLabel ?? node.displayName, fileCount: context.fileCountByGroup.get(node.id) ?? 0, ca: 0, ce: 0 },
  };
}

/** Fold import wires touching >=1 seed onto the kept files; drops boundary<->boundary and self-loops. */
function buildEdges(graph: ModuleGraph, seeds: ReadonlySet<string>, keptFileIds: ReadonlySet<string>): MinimalSubgraphEdge[] {
  const pairs = new Map<string, MinimalSubgraphEdge>();
  for (const seed of seeds) {
    for (const target of graph.out.get(seed) ?? []) {
      addPair(pairs, graph, seed, target, keptFileIds);
    }
    for (const source of graph.in.get(seed) ?? []) {
      addPair(pairs, graph, source, seed, keptFileIds);
    }
  }
  return [...pairs.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function addPair(
  pairs: Map<string, MinimalSubgraphEdge>,
  graph: ModuleGraph,
  source: string,
  target: string,
  keptFileIds: ReadonlySet<string>,
): void {
  if (source === target || !keptFileIds.has(source) || !keptFileIds.has(target)) {
    return;
  }
  const key = `${source}->${target}`;
  if (!pairs.has(key)) {
    pairs.set(key, { id: `review:${key}`, source, target, weight: graph.weight.get(weightKey(source, target)) ?? 1 });
  }
}
