/** Minimal graph contracts needed to grow a literal selection without coupling the operation to
 * React Flow or to any one Meridian surface. */
export interface SelectionNode {
  id: string;
}

export interface SelectionEdge {
  source: string;
  target: string;
}

/** Grow `selected` by exactly one undirected hop across the currently visible graph. Existing
 * picks are preserved even when a surface is between paint frames; only visible endpoints can be
 * newly selected, and newly discovered nodes never become traversal roots until the next click. */
export function expandedSelectionByOneHop(
  selected: ReadonlySet<string>,
  visibleNodes: readonly SelectionNode[],
  visibleEdges: readonly SelectionEdge[],
): Set<string> {
  const visibleIds = new Set(visibleNodes.map((node) => node.id));
  const expanded = new Set(selected);
  for (const edge of visibleEdges) {
    if (!visibleIds.has(edge.source) || !visibleIds.has(edge.target)) {
      continue;
    }
    if (selected.has(edge.source)) expanded.add(edge.target);
    if (selected.has(edge.target)) expanded.add(edge.source);
  }
  return expanded;
}

export function selectionExpansionCount(
  selected: ReadonlySet<string>,
  visibleNodes: readonly SelectionNode[],
  visibleEdges: readonly SelectionEdge[],
): number {
  return expandedSelectionByOneHop(selected, visibleNodes, visibleEdges).size - selected.size;
}
