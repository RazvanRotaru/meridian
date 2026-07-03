/**
 * Roll up the extraction summary. Counts are taken over the FINAL (post-collapse) node and
 * edge sets so they describe what actually shipped, while the drop counters reflect the
 * resolution pass.
 */

import type { ExtractionStats, GraphEdge, GraphNode } from "@meridian/core";

export interface StatsInput {
  files: number;
  nodes: GraphNode[];
  edges: GraphEdge[];
  externalCallsDropped: number;
  unresolvedCalls: number;
}

export function buildStats(input: StatsInput): ExtractionStats {
  return {
    files: input.files,
    nodeCountByKind: countByKind(input.nodes),
    edgeCountByResolution: countByResolution(input.edges),
    summaryCoverage: summaryCoverage(input.nodes),
    externalCallsDropped: input.externalCallsDropped,
    unresolvedCalls: input.unresolvedCalls,
  };
}

function countByKind(nodes: GraphNode[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const node of nodes) {
    counts[node.kind] = (counts[node.kind] ?? 0) + 1;
  }
  return counts;
}

function countByResolution(edges: GraphEdge[]): Record<string, number> {
  const counts: Record<string, number> = { resolved: 0, external: 0, unresolved: 0 };
  for (const edge of edges) {
    const resolution = edge.resolution ?? "resolved";
    counts[resolution] = (counts[resolution] ?? 0) + 1;
  }
  return counts;
}

function summaryCoverage(nodes: GraphNode[]): { withSummary: number; total: number } {
  const withSummary = nodes.filter((node) => node.summary != null).length;
  return { withSummary, total: nodes.length };
}
