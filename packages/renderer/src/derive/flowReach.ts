/**
 * Flow isolation: given one entry node, the forward call-reachable set of nodes over the
 * current view's edges. Rooting on a container seeds from its whole subtree (so "root on
 * main.ts" follows what the file's code calls), then BFS forward — this is the single "one
 * flow on screen" story that keeps a 15k-edge graph from lifting into a package-to-package
 * tangle. Also ranks candidate entry points for the quick-pick buttons.
 */

import type { GraphEdge } from "@meridian/core";
import type { GraphIndex } from "../graph/graphIndex";
import { selectEdgesForMode, type ViewMode } from "./edgeSelection";

export interface FlowEntry {
  id: string;
  /** The node's own name, e.g. `main.ts` or `bootstrapApp`. */
  label: string;
  /** A faint container path for disambiguation, e.g. `src/aria/app/src`. */
  detail: string;
  /** Direct out-edges in this view — the cheap rank signal. */
  fanOut: number;
}

const TEST_PATH = /(__tests?__|\.test\.|\.spec\.|\.stories\.)/i;
const ENTRY_NAME = /(^|\/)(main|index|bootstrap|app|entry|boot|server|start|root)\b/i;
const ENTRY_NAME_BOOST = 100_000;
const NON_ENTRY_KINDS: ReadonlySet<string> = new Set(["interface", "package", "namespace"]);

/** Forward call-reachable node ids from `rootId`'s subtree, optionally capped at `maxDepth` hops. */
export function forwardReachable(
  index: GraphIndex,
  rootId: string,
  viewMode: ViewMode,
  maxDepth?: number,
): Set<string> {
  const adjacency = viewAdjacency(index, viewMode);
  const seeds = subtreeIds(index, rootId);
  const reached = new Set(seeds);
  let frontier = seeds;
  let depth = 0;
  while (frontier.length > 0 && (maxDepth === undefined || depth < maxDepth)) {
    frontier = nextFrontier(frontier, adjacency, reached);
    depth += 1;
  }
  return reached;
}

/** The nodes to draw for a flow: every reached node plus its container ancestors, so functions nest. */
export function flowKeepSet(reachable: ReadonlySet<string>, index: GraphIndex): Set<string> {
  const keep = new Set(reachable);
  for (const id of reachable) {
    for (const ancestor of index.ancestorsOf(id)) {
      keep.add(ancestor.id);
    }
  }
  return keep;
}

/** Candidate flow entries (never-called callers + module-level code), ranked for the quick-picks. */
export function rankedEntryPoints(index: GraphIndex, viewMode: ViewMode, limit = 12): FlowEntry[] {
  const edges = selectEdgesForMode(index.edges, viewMode);
  const inDegree = countBy(edges, (edge) => edge.target);
  const outDegree = countBy(edges, (edge) => edge.source);
  const entries: FlowEntry[] = [];
  for (const [id, fanOut] of outDegree) {
    if (isEntryCandidate(index, id, inDegree.get(id) ?? 0)) {
      entries.push(entryFor(index, id, fanOut));
    }
  }
  return entries.sort((a, b) => score(b) - score(a)).slice(0, limit);
}

function nextFrontier(
  frontier: string[],
  adjacency: Map<string, string[]>,
  reached: Set<string>,
): string[] {
  const next: string[] = [];
  for (const node of frontier) {
    for (const target of adjacency.get(node) ?? []) {
      if (!reached.has(target)) {
        reached.add(target);
        next.push(target);
      }
    }
  }
  return next;
}

function viewAdjacency(index: GraphIndex, viewMode: ViewMode): Map<string, string[]> {
  const adjacency = new Map<string, string[]>();
  for (const edge of selectEdgesForMode(index.edges, viewMode)) {
    const existing = adjacency.get(edge.source);
    if (existing) {
      existing.push(edge.target);
    } else {
      adjacency.set(edge.source, [edge.target]);
    }
  }
  return adjacency;
}

/** rootId plus every descendant, so rooting on a file/package follows all the code inside it. */
function subtreeIds(index: GraphIndex, rootId: string): string[] {
  const ids: string[] = [];
  const stack = [rootId];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const current = stack.pop() as string;
    if (seen.has(current)) {
      continue;
    }
    seen.add(current);
    ids.push(current);
    for (const child of index.childrenOf(current)) {
      stack.push(child.id);
    }
  }
  return ids;
}

function isEntryCandidate(index: GraphIndex, id: string, inDegree: number): boolean {
  const node = index.nodesById.get(id);
  if (!node || TEST_PATH.test(id) || NON_ENTRY_KINDS.has(node.kind)) {
    return false;
  }
  // A module that runs code at import time is an entry; anything else must be a never-called caller.
  return node.kind === "module" || inDegree === 0;
}

function entryFor(index: GraphIndex, id: string, fanOut: number): FlowEntry {
  const node = index.nodesById.get(id);
  const parent = index.parentOf.get(id);
  const parentNode = parent ? index.nodesById.get(parent) : undefined;
  return {
    id,
    label: node?.displayName ?? id,
    detail: parentNode?.location?.file ?? parentNode?.displayName ?? "",
    fanOut,
  };
}

function score(entry: FlowEntry): number {
  return entry.fanOut + (ENTRY_NAME.test(entry.id) ? ENTRY_NAME_BOOST : 0);
}

function countBy(edges: GraphEdge[], key: (edge: GraphEdge) => string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const edge of edges) {
    const k = key(edge);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return counts;
}
