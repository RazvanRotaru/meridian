/**
 * Where UI-composition mode should land you: the nearest common ancestor of everything that
 * takes part in a "renders" edge. Diving into that container puts the whole render tree
 * front-and-centre without the reader hunting for it. Returns null when there is nothing to
 * render (no renders edges, or participants that share no ancestor) so the caller falls home.
 */

import type { GraphIndex } from "../graph/graphIndex";
import { UI_EDGE_KIND } from "./edgeSelection";

export function uiFocusTarget(index: GraphIndex): string | null {
  const participants = rendersParticipants(index);
  if (participants.length === 0) {
    return null;
  }
  const start = nearestCommonAncestor(participants, index);
  if (start === null) {
    return null;
  }
  const target = descendToDominant(start, participants, index);
  // Diving into a childless leaf would blank the canvas; fall back to the whole graph (still
  // filtered to renders edges) rather than an empty box.
  return index.childrenOf(target).length === 0 ? null : target;
}

// The common ancestor can sit too high when one outlier participates (e.g. a bootstrap
// `main.tsx` that renders <App/> pulls the NCA up to `src`). Descend into whichever child
// still holds the large majority of participants so UI mode lands on the real component tree.
function descendToDominant(start: string, participants: string[], index: GraphIndex): string {
  const threshold = Math.ceil(participants.length * 0.75);
  const seen = new Set<string>();
  let current = start;
  // A parentId cycle (tolerated by the lenient viewer) could otherwise spin forever.
  while (!seen.has(current)) {
    seen.add(current);
    const dominant = index.childrenOf(current).find((child) => subtreeCount(child.id, participants, index) >= threshold);
    if (!dominant) {
      return current;
    }
    current = dominant.id;
  }
  return current;
}

function subtreeCount(containerId: string, participants: string[], index: GraphIndex): number {
  return participants.filter((participant) => index.isWithinFocus(containerId, participant)).length;
}

/** Real in-graph nodes touched by any renders edge (unresolved `ext:` targets are skipped). */
function rendersParticipants(index: GraphIndex): string[] {
  const ids = new Set<string>();
  for (const edge of index.edges) {
    if (edge.kind !== UI_EDGE_KIND) {
      continue;
    }
    addIfReal(ids, edge.source, index);
    addIfReal(ids, edge.target, index);
  }
  return [...ids];
}

function addIfReal(ids: Set<string>, nodeId: string, index: GraphIndex): void {
  if (index.nodesById.has(nodeId)) {
    ids.add(nodeId);
  }
}

/** The deepest node shared by every participant's root..node path, or null if none is shared. */
function nearestCommonAncestor(nodeIds: string[], index: GraphIndex): string | null {
  let common = pathIds(nodeIds[0], index);
  for (let i = 1; i < nodeIds.length; i += 1) {
    common = commonPrefix(common, pathIds(nodeIds[i], index));
    if (common.length === 0) {
      return null;
    }
  }
  return common[common.length - 1] ?? null;
}

function pathIds(nodeId: string, index: GraphIndex): string[] {
  return index.ancestorsOf(nodeId).map((node) => node.id);
}

function commonPrefix(a: string[], b: string[]): string[] {
  const limit = Math.min(a.length, b.length);
  let length = 0;
  while (length < limit && a[length] === b[length]) {
    length += 1;
  }
  return a.slice(0, length);
}
