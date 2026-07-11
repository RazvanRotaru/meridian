/** Build a throwaway reverse-edge index for derivations that need direct callers. */

import type { GraphEdge } from "@meridian/core";

/** Group only the requested edge kinds by target in one O(E) pass. */
export function buildInboundByTarget(
  edges: GraphEdge[],
  kinds: ReadonlySet<string>,
): Map<string, GraphEdge[]> {
  const inbound = new Map<string, GraphEdge[]>();
  for (const edge of edges) {
    if (!kinds.has(edge.kind)) {
      continue;
    }
    const existing = inbound.get(edge.target);
    if (existing) {
      existing.push(edge);
    } else {
      inbound.set(edge.target, [edge]);
    }
  }
  return inbound;
}
