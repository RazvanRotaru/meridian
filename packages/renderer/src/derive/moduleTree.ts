/**
 * The Module-map's one-level containment view, wired by the import graph lifted to the visible
 * frontier. The current focus emits a FLAT set: repository root shows the package overview; a
 * package/directory focus shows only that focus's immediate children after single-dir collapse.
 *
 *   - `focus === null` → the whole-repo overview: the npm packages that own ≥1 file, as top-level
 *     group cards (the package graph).
 *   - a `focus` package/dir → its children (after chain-collapsing a lone `src`).
 *
 * Imports are folded to the visible boxes by `liftEdges`: a group swallows its internal imports
 * (self-loops, dropped) and an import leaving the drawn level lifts past the frontier and drops, so
 * a level shows only the coupling between what is currently on screen. Pure; no React, no ELK.
 */

import type { GraphEdge } from "@meridian/core";
import type { GraphIndex } from "../graph/graphIndex";
import { npmPackageIdOf } from "./compositionClusters";
import { derivePackageOverview, packageEntryModule, type ModulePackageData, type PackageOverviewSpec } from "./packageOverview";
import { weightKey, type ModuleGraph } from "./moduleGraph";
import { basename, collapseChain, fileData, type ModuleCardData } from "./moduleLevel";
import { liftEdges } from "./liftEdges";

const MODULE_KIND = "module";
const PACKAGE_KIND = "package";

/** Group cards keep these flags for the shared node renderer; Module map never expands inline. */
export type ModuleGroupData = ModulePackageData & { isContainer: boolean; isExpanded: boolean };

/** One node in the drawn containment level. `parentId` stays null because Module map is flat. */
export interface VisibleModuleNode {
  id: string;
  parentId: string | null;
  kind: "package" | "file";
  isContainer: boolean;
  isExpanded: boolean;
  depth: number;
  childCount: number;
  data: ModuleGroupData | ModuleCardData;
}

/** An import wire between two visible nodes; `crossFrame` = a group is involved (coupling gold). */
export interface ModuleTreeEdge {
  id: string;
  source: string;
  target: string;
  weight: number;
  crossFrame: boolean;
}

export interface ModuleTree {
  nodes: VisibleModuleNode[];
  edges: ModuleTreeEdge[];
  /** The node actually descended into after chain-collapse; null == the repo-level overview. */
  effectiveFocus: string | null;
}

/** The flat containment level to draw: overview when focus is null, else the focus's children. */
export function deriveModuleTree(
  index: GraphIndex,
  focus: string | null,
  _expanded: ReadonlySet<string>,
  graph: ModuleGraph,
): ModuleTree {
  const effectiveFocus = focus === null ? null : collapseChain(index, focus);
  if (effectiveFocus === null) {
    return collapsedOverviewTree(index);
  }
  const roots = frontierRoots(index, effectiveFocus, graph);
  const skeleton = walk(index, roots);
  const visibleIds = new Set(skeleton.map((entry) => entry.id));
  const lifted = liftEdges(importEdges(graph), visibleIds, index.parentOf);
  const nodes = skeleton.map((entry) => finalize(entry, index, graph, lifted));
  return { nodes, edges: toTreeEdges(lifted, kindsOf(skeleton)), effectiveFocus };
}

/** Repository level, unexpanded: keep the dedicated package-overview fold that built this view. */
function collapsedOverviewTree(index: GraphIndex): ModuleTree {
  const overview = derivePackageOverview(index);
  return {
    nodes: overview.nodes.map((node) => overviewNode(node, index)),
    edges: overview.edges.map(overviewEdge),
    effectiveFocus: null,
  };
}

function overviewNode(node: PackageOverviewSpec["nodes"][number], index: GraphIndex): VisibleModuleNode {
  const childCount = containmentChildren(index, node.id).length;
  const isContainer = childCount > 0;
  return {
    id: node.id,
    parentId: null,
    kind: "package",
    isContainer,
    isExpanded: false,
    depth: 0,
    childCount,
    data: { ...node.data, isContainer, isExpanded: false },
  };
}

function overviewEdge(edge: PackageOverviewSpec["edges"][number]): ModuleTreeEdge {
  return { id: `lvl:${edge.source}->${edge.target}`, source: edge.source, target: edge.target, weight: edge.weight, crossFrame: true };
}

/** The top-level nodes of the drawn level: npm packages at the overview, else the focus's children. */
function frontierRoots(index: GraphIndex, effectiveFocus: string | null, graph: ModuleGraph): string[] {
  if (effectiveFocus === null) {
    return overviewPackages(index, graph);
  }
  return containmentChildren(index, effectiveFocus);
}

/** The npm packages that own ≥1 source file — the whole-repo overview's frontier (deduped, sorted). */
function overviewPackages(index: GraphIndex, graph: ModuleGraph): string[] {
  const packages = new Set<string>();
  for (const fileId of graph.fileIds) {
    const pkg = npmPackageIdOf(fileId, index.nodesById);
    if (pkg !== null) {
      packages.add(pkg);
    }
  }
  return [...packages].sort();
}

/** A node's package/file children (directories + source files), skipping members and other kinds. */
function containmentChildren(index: GraphIndex, nodeId: string): string[] {
  return index
    .childrenOf(nodeId)
    .filter((child) => child.kind === PACKAGE_KIND || child.kind === MODULE_KIND)
    .map((child) => child.id);
}

interface Skeleton {
  id: string;
  parentId: string | null;
  kind: "package" | "file";
  isContainer: boolean;
  isExpanded: boolean;
  depth: number;
  childCount: number;
}

/** One flat frontier: roots render as top-level cards; group descendants require double-click zoom. */
function walk(index: GraphIndex, roots: string[]): Skeleton[] {
  const out: Skeleton[] = [];
  const seen = new Set<string>();
  const visit = (id: string, parentId: string | null, depth: number): void => {
    if (seen.has(id)) {
      return; // a parentId cycle (tolerated by the lenient viewer) must not spin forever.
    }
    seen.add(id);
    if (index.nodesById.get(id)?.kind === MODULE_KIND) {
      out.push({ id, parentId, kind: "file", isContainer: false, isExpanded: false, depth, childCount: 0 });
      return;
    }
    if (subtreeFileCount(index, id) === 0) {
      return; // a directory owning no in-project files anywhere below is a useless "0 files" card.
    }
    const children = containmentChildren(index, id);
    const isContainer = children.length > 0;
    out.push({ id, parentId, kind: "package", isContainer, isExpanded: false, depth, childCount: children.length });
  };
  roots.forEach((id) => visit(id, null, 0));
  return out;
}

/** Attach the card data each drawn node needs: file cards from the import graph, group cards from
 * the subtree file tally and the lifted-edge frontier degree (Ca/Ce among what is on screen). */
function finalize(entry: Skeleton, index: GraphIndex, graph: ModuleGraph, lifted: ReturnType<typeof liftEdges>): VisibleModuleNode {
  const data =
    entry.kind === "file"
      ? fileData(entry.id, graph, index, entryFor(entry.id, index))
      : groupData(entry, index, subtreeFileCount(index, entry.id), lifted);
  return { ...entry, data };
}

/** The blast-radius entry module of the file's owning package (for the ENTRY badge on the card). */
function entryFor(fileId: string, index: GraphIndex): string | null {
  return packageEntryModule(index, npmPackageIdOf(fileId, index.nodesById) ?? fileId);
}

function groupData(entry: Skeleton, index: GraphIndex, fileCount: number, lifted: ReturnType<typeof liftEdges>): ModuleGroupData {
  const label = index.nodesById.get(entry.id)?.displayName ?? basename(entry.id);
  return {
    label,
    fileCount,
    ce: distinctNeighbours(lifted, entry.id, "source"),
    ca: distinctNeighbours(lifted, entry.id, "target"),
    isContainer: entry.isContainer,
    isExpanded: entry.isExpanded,
  };
}

/** Count `module`-kind descendants across the FULL containment subtree (independent of expansion). */
function subtreeFileCount(index: GraphIndex, rootId: string): number {
  let count = 0;
  const seen = new Set<string>();
  const stack = [rootId];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    for (const child of index.childrenOf(id)) {
      if (child.kind === MODULE_KIND) {
        count += 1;
      } else if (child.kind === PACKAGE_KIND) {
        stack.push(child.id);
      }
    }
  }
  return count;
}

/** Distinct frontier nodes this node imports (`source`) or is imported by (`target`) after lifting. */
function distinctNeighbours(lifted: ReturnType<typeof liftEdges>, id: string, role: "source" | "target"): number {
  const other = role === "source" ? "target" : "source";
  const neighbours = new Set<string>();
  for (const edge of lifted) {
    if (edge[role] === id) {
      neighbours.add(edge[other]);
    }
  }
  return neighbours.size;
}

/** The file-to-file import graph as synthetic resolved `imports` edges, ready for `liftEdges`. */
function importEdges(graph: ModuleGraph): GraphEdge[] {
  const edges: GraphEdge[] = [];
  for (const [source, targets] of graph.out) {
    for (const target of targets) {
      const key = weightKey(source, target);
      edges.push({ id: `mimp:${key}`, source, target, kind: "imports", resolution: "resolved", weight: graph.weight.get(key) ?? 1 } as GraphEdge);
    }
  }
  return edges;
}

function kindsOf(skeleton: Skeleton[]): Map<string, "package" | "file"> {
  return new Map(skeleton.map((entry) => [entry.id, entry.kind]));
}

/** Lifted wires as level edges, flagged crossFrame when either endpoint is a group card. */
function toTreeEdges(lifted: ReturnType<typeof liftEdges>, kinds: Map<string, "package" | "file">): ModuleTreeEdge[] {
  return lifted
    .map((edge) => ({
      id: `lvl:${edge.source}->${edge.target}`,
      source: edge.source,
      target: edge.target,
      weight: edge.weight,
      crossFrame: kinds.get(edge.source) === "package" || kinds.get(edge.target) === "package",
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}
