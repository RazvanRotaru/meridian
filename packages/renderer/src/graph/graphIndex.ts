/**
 * The graph index: O(1) lookups the renderer needs on every toggle.
 *
 * `node.id` from the artifact is the React Flow node id AND the telemetry join key, so the
 * index keys everything by that id verbatim and never mints a parallel identifier.
 */

import { collectChangedIds, collectTestIds } from "@meridian/core";
import type { GraphArtifact, GraphEdge, GraphNode } from "@meridian/core";

export interface GraphIndex {
  nodesById: Map<string, GraphNode>;
  childrenByParent: Map<string, GraphNode[]>;
  roots: GraphNode[];
  parentOf: Map<string, string | null>;
  outEdges: Map<string, GraphEdge[]>;
  edges: GraphEdge[];
  /** Every test-code node (tag or path heuristic), closed over containment — the hide-tests set. */
  testIds: Set<string>;
  /** Every `private`-tagged node (the open tags vocabulary) — the Map's hide-privates set. */
  privateIds: Set<string>;
  /** Every node tagged "changed" (`--changed-since`) — the exact edits, no containment closure. */
  changedIds: Set<string>;
  /** Changed nodes strictly inside each container, so a COLLAPSED ancestor can hint at them. */
  changedDescendants: Map<string, number>;
  isContainer(nodeId: string): boolean;
  /** Ordered children of a node (source order); the roots of a dive-in focus scope. */
  childrenOf(nodeId: string): GraphNode[];
  /** The containment path root..id INCLUSIVE, for the dive-in breadcrumb. */
  ancestorsOf(nodeId: string): GraphNode[];
  /** Whether nodeId lies in focusId's subtree (inclusive); a null focus contains everything. */
  isWithinFocus(focusId: string | null, nodeId: string): boolean;
}

export function buildGraphIndex(artifact: GraphArtifact): GraphIndex {
  const nodesById = indexById(artifact.nodes);
  const childrenByParent = groupByParent(artifact.nodes);
  const parentOf = mapParents(artifact.nodes);
  const changedIds = collectChangedIds(artifact.nodes);
  return {
    nodesById,
    childrenByParent,
    roots: artifact.nodes.filter(isRoot),
    parentOf,
    outEdges: groupOutEdges(artifact.edges),
    edges: artifact.edges,
    testIds: collectTestIds(artifact.nodes),
    privateIds: new Set(artifact.nodes.filter((node) => node.tags?.includes("private")).map((node) => node.id)),
    changedIds,
    changedDescendants: countChangedDescendants(changedIds, parentOf),
    isContainer: (nodeId) => (childrenByParent.get(nodeId)?.length ?? 0) > 0,
    childrenOf: (nodeId) => childrenByParent.get(nodeId) ?? [],
    ancestorsOf: (nodeId) => ancestorsOf(nodeId, nodesById, parentOf),
    isWithinFocus: (focusId, nodeId) => isWithinFocus(focusId, nodeId, parentOf),
  };
}

/**
 * Overwrite the "changed" set at runtime, in place, and rebuild changedDescendants to match. A GitHub
 * PR review reuses the same `--changed-since` channel every card already paints from: computing the
 * modified code blocks (diff hunks ∩ node ranges) and pushing them here makes the Map + minimal
 * overlay ring exactly those blocks amber, for free. Mutating the one index object every card reads
 * means the next store `set()` re-runs their `changedIds.has(id)` selectors and repaints.
 */
export function applyChangedIds(index: GraphIndex, changedIds: Iterable<string>): void {
  index.changedIds.clear();
  for (const id of changedIds) {
    index.changedIds.add(id);
  }
  index.changedDescendants.clear();
  for (const changedId of index.changedIds) {
    const seen = new Set<string>([changedId]);
    let current = index.parentOf.get(changedId) ?? null;
    while (current && !seen.has(current)) {
      seen.add(current);
      index.changedDescendants.set(current, (index.changedDescendants.get(current) ?? 0) + 1);
      current = index.parentOf.get(current) ?? null;
    }
  }
}

/** Bubble each changed node up its parent chain so collapsed ancestors can count what they hide. */
function countChangedDescendants(
  changedIds: Set<string>,
  parentOf: ReadonlyMap<string, string | null>,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const changedId of changedIds) {
    const seen = new Set<string>([changedId]);
    let current = parentOf.get(changedId) ?? null;
    while (current && !seen.has(current)) {
      seen.add(current);
      counts.set(current, (counts.get(current) ?? 0) + 1);
      current = parentOf.get(current) ?? null;
    }
  }
  return counts;
}

/** Walk parentId up to a root, collecting nodes, then reverse to root..id order. */
function ancestorsOf(
  nodeId: string,
  nodesById: ReadonlyMap<string, GraphNode>,
  parentOf: ReadonlyMap<string, string | null>,
): GraphNode[] {
  const path: GraphNode[] = [];
  const seen = new Set<string>();
  let current: string | null | undefined = nodeId;
  // A parentId cycle is tolerated by the lenient viewer, so guard against spinning forever.
  while (current && !seen.has(current)) {
    seen.add(current);
    const node = nodesById.get(current);
    if (node) {
      path.push(node);
    }
    current = parentOf.get(current) ?? null;
  }
  return path.reverse();
}

function isWithinFocus(
  focusId: string | null,
  nodeId: string,
  parentOf: ReadonlyMap<string, string | null>,
): boolean {
  if (focusId === null) {
    return true;
  }
  const seen = new Set<string>();
  let current: string | null | undefined = nodeId;
  while (current && !seen.has(current)) {
    if (current === focusId) {
      return true;
    }
    seen.add(current);
    current = parentOf.get(current) ?? null;
  }
  return false;
}

function isRoot(node: GraphNode): boolean {
  return node.parentId === null || node.parentId === undefined;
}

function indexById(nodes: GraphNode[]): Map<string, GraphNode> {
  return new Map(nodes.map((node) => [node.id, node]));
}

/** Children keep artifact (source) order so siblings render in a stable, meaningful sequence. */
function groupByParent(nodes: GraphNode[]): Map<string, GraphNode[]> {
  const byParent = new Map<string, GraphNode[]>();
  for (const node of nodes) {
    if (isRoot(node)) {
      continue;
    }
    appendTo(byParent, node.parentId as string, node);
  }
  return byParent;
}

function mapParents(nodes: GraphNode[]): Map<string, string | null> {
  return new Map(nodes.map((node) => [node.id, node.parentId ?? null]));
}

function groupOutEdges(edges: GraphEdge[]): Map<string, GraphEdge[]> {
  const bySource = new Map<string, GraphEdge[]>();
  for (const edge of edges) {
    appendTo(bySource, edge.source, edge);
  }
  return bySource;
}

function appendTo<Value>(map: Map<string, Value[]>, key: string, value: Value): void {
  const existing = map.get(key);
  if (existing) {
    existing.push(value);
    return;
  }
  map.set(key, [value]);
}
