/**
 * The blast radius: a forward BFS over the module import graph from a root file, returning the
 * minimum import-hop depth of every reachable file (root = 0). This is the DEPTH-RETURNING sibling
 * of flowReach's `forwardReachable` — the ring number each file will be laid out on.
 *
 * It runs on the FULL graph. Category hiding must NEVER be applied before this — dropping a `util`
 * file mid-walk would sever the only path to files beyond it and silently truncate the radius, so
 * hiding is a paint-time concern the layer above owns, never a graph edit here.
 */

import type { ModuleGraph } from "./moduleGraph";

const NO_TARGETS: ReadonlySet<string> = new Set();

/**
 * Min hop-depth from `rootId` for every forward-reachable file. `maxDepth` caps the walk (null =
 * unlimited); depth 0 is the root itself, always present even when it imports nothing. Visited-
 * guarded by the depth map, so an import cycle (A imports B imports A) settles instead of hanging.
 */
export function computeReach(graph: ModuleGraph, rootId: string, maxDepth: number | null): Map<string, number> {
  const depthById = new Map<string, number>([[rootId, 0]]);
  let frontier = [rootId];
  let depth = 0;
  while (frontier.length > 0 && !depthReached(depth, maxDepth)) {
    frontier = nextRing(graph, frontier, depthById, depth + 1);
    depth += 1;
  }
  return depthById;
}

/** True once the walk has expanded `maxDepth` rings and must stop (null never stops early). */
function depthReached(depth: number, maxDepth: number | null): boolean {
  return maxDepth !== null && depth >= maxDepth;
}

/** The next BFS ring: first-seen imports of the current frontier, stamped at `depth`. */
function nextRing(
  graph: ModuleGraph,
  frontier: string[],
  depthById: Map<string, number>,
  depth: number,
): string[] {
  const next: string[] = [];
  for (const fileId of frontier) {
    for (const target of graph.out.get(fileId) ?? NO_TARGETS) {
      if (depthById.has(target)) {
        continue;
      }
      depthById.set(target, depth);
      next.push(target);
    }
  }
  return next;
}
