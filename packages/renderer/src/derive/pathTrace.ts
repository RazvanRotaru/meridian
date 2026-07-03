/**
 * Path tracing for the click-to-highlight interaction: from an origin node, walk the
 * currently-visible lifted edges downstream (what this node reaches) and upstream (what
 * reaches it). The result is the full impact path — the reader's "what breaks if I touch
 * this" answer — used to paint direction-coloured wires and dim everything else.
 *
 * Cycles are fine: BFS with visited sets terminates, and an edge reachable both ways
 * counts as downstream (the outbound story wins the colour).
 */

export interface PathHighlight {
  /** Every node on the traced path, origin included. Empty == no highlight active. */
  nodeIds: ReadonlySet<string>;
  /** Edge id -> direction relative to the origin ("down" = flows away, "up" = flows in). */
  edgeDirections: ReadonlyMap<string, "up" | "down">;
}

export interface TraceableEdge {
  id: string;
  source: string;
  target: string;
}

export const EMPTY_HIGHLIGHT: PathHighlight = {
  nodeIds: new Set<string>(),
  edgeDirections: new Map<string, "up" | "down">(),
};

/**
 * `maxDepth` bounds the walk in hops from the origin: 1 = direct neighbours only (the calm
 * default — a full closure on a tangled codebase lights nearly everything, which highlights
 * nothing), Infinity = the complete impact path.
 */
export function tracePath(
  edges: readonly TraceableEdge[],
  originId: string,
  maxDepth = Number.POSITIVE_INFINITY,
): PathHighlight {
  const bySource = groupBy(edges, (edge) => edge.source);
  const byTarget = groupBy(edges, (edge) => edge.target);
  const nodeIds = new Set<string>([originId]);
  const edgeDirections = new Map<string, "up" | "down">();
  walk(originId, bySource, (edge) => edge.target, nodeIds, edgeDirections, "down", maxDepth);
  walk(originId, byTarget, (edge) => edge.source, nodeIds, edgeDirections, "up", maxDepth);
  return { nodeIds, edgeDirections };
}

/** Highlight a single edge: just its two endpoints, coloured as a downstream hop. */
export function traceEdge(edge: TraceableEdge): PathHighlight {
  return {
    nodeIds: new Set([edge.source, edge.target]),
    edgeDirections: new Map([[edge.id, "down"]]),
  };
}

function walk(
  originId: string,
  adjacency: ReadonlyMap<string, TraceableEdge[]>,
  nextOf: (edge: TraceableEdge) => string,
  nodeIds: Set<string>,
  edgeDirections: Map<string, "up" | "down">,
  direction: "up" | "down",
  maxDepth: number,
): void {
  const queue: Array<{ id: string; depth: number }> = [{ id: originId, depth: 0 }];
  const visited = new Set<string>([originId]);
  while (queue.length > 0) {
    const { id: current, depth } = queue.shift() as { id: string; depth: number };
    if (depth >= maxDepth) {
      continue;
    }
    for (const edge of adjacency.get(current) ?? []) {
      // "down" wins when an edge sits on a cycle and is reachable both ways.
      if (!edgeDirections.has(edge.id) || direction === "down") {
        edgeDirections.set(edge.id, direction);
      }
      const next = nextOf(edge);
      nodeIds.add(next);
      if (!visited.has(next)) {
        visited.add(next);
        queue.push({ id: next, depth: depth + 1 });
      }
    }
  }
}

function groupBy(
  edges: readonly TraceableEdge[],
  keyOf: (edge: TraceableEdge) => string,
): Map<string, TraceableEdge[]> {
  const grouped = new Map<string, TraceableEdge[]>();
  for (const edge of edges) {
    const key = keyOf(edge);
    const bucket = grouped.get(key);
    if (bucket) {
      bucket.push(edge);
    } else {
      grouped.set(key, [edge]);
    }
  }
  return grouped;
}
