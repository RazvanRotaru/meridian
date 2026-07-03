/**
 * Roll up the extraction summary over the FINAL (post-collapse) node + edge sets, plus the
 * drop counters from the resolution pass. Mirrors the TypeScript extractor's stats shape.
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
    nodeCountByKind: countBy(input.nodes.map((node) => node.kind)),
    edgeCountByResolution: countResolution(input.edges),
    summaryCoverage: {
      withSummary: input.nodes.filter((node) => node.summary != null).length,
      total: input.nodes.length,
    },
    externalCallsDropped: input.externalCallsDropped,
    unresolvedCalls: input.unresolvedCalls,
  };
}

function countBy(values: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

function countResolution(edges: GraphEdge[]): Record<string, number> {
  const counts: Record<string, number> = { resolved: 0, external: 0, unresolved: 0 };
  for (const edge of edges) {
    const resolution = edge.resolution ?? "resolved";
    counts[resolution] = (counts[resolution] ?? 0) + 1;
  }
  return counts;
}
