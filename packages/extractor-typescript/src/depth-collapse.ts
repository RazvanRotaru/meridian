/**
 * The `--depth` post-pass. Nodes deeper than the requested rank are dropped; their edges are
 * re-pointed to the nearest surviving ancestor, self-loops fall away, and duplicates merge by
 * unioning call sites so weight stays equal to the call-site count.
 */

import { DEPTH_RANK, rankOfKind, type ExtractionDepth } from "@meridian/core";
import type { GraphEdge, GraphNode } from "@meridian/core";
import { aggregationKey, edgeId } from "./edge-id";

export interface CollapseResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export function collapseToDepth(nodes: GraphNode[], edges: GraphEdge[], depth: ExtractionDepth): CollapseResult {
  const maxRank = DEPTH_RANK[depth];
  const survivors = nodes.filter((node) => rankOfKind(node.kind) <= maxRank);
  const lift = ancestorLifter(nodes, new Set(survivors.map((node) => node.id)));
  const repointed = edges.map((edge) => repoint(edge, lift)).filter(isEdge);
  return { nodes: survivors, edges: mergeDuplicates(repointed) };
}

/** Map any node id to its nearest surviving ancestor; pseudo-targets pass through unchanged. */
function ancestorLifter(nodes: GraphNode[], survivorIds: Set<string>): (id: string) => string | null {
  const knownIds = new Set(nodes.map((node) => node.id));
  const parentOf = new Map(nodes.map((node) => [node.id, node.parentId ?? null]));
  return (id: string) => {
    if (!knownIds.has(id)) {
      return id;
    }
    let current: string | null = id;
    while (current && !survivorIds.has(current)) {
      current = parentOf.get(current) ?? null;
    }
    return current;
  };
}

function repoint(edge: GraphEdge, lift: (id: string) => string | null): GraphEdge | null {
  const source = lift(edge.source);
  const target = lift(edge.target);
  if (source === null || target === null || source === target) {
    return null;
  }
  return { ...edge, source, target, id: edgeId(edge.kind, source, target) };
}

function mergeDuplicates(edges: GraphEdge[]): GraphEdge[] {
  const merged = new Map<string, GraphEdge>();
  for (const edge of edges) {
    const key = aggregationKey(edge.kind, edge.source, edge.target);
    const existing = merged.get(key);
    if (existing) {
      existing.callSites = [...(existing.callSites ?? []), ...(edge.callSites ?? [])];
      existing.weight = existing.callSites.length;
    } else {
      merged.set(key, { ...edge });
    }
  }
  return [...merged.values()];
}

function isEdge(edge: GraphEdge | null): edge is GraphEdge {
  return edge !== null;
}
