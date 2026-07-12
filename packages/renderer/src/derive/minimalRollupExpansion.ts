/**
 * Extract the ordinary Map subtrees used when a rolled minimal-graph package opens in place.
 * The source tree is already the Map's canonical derive (same node data, containment and edges);
 * this helper only detaches requested roots so the minimal layout can anchor each as a top-level
 * expanded frame among its other curated cards.
 */

import type { GraphIndex } from "../graph/graphIndex";
import type { ModuleTree, ModuleTreeEdge, VisibleModuleNode } from "./moduleTree";

export interface MinimalRollupExpansion {
  rootId: string;
  /** File/collapsed-package boxes that replace the logical rollup only for edge/ghost derivation. */
  frontierIds: string[];
  /** Canonical Map subtree, with the requested package detached as a top-level root. */
  nodes: VisibleModuleNode[];
  edges: ModuleTreeEdge[];
}

/** Ancestor-most requested roots win: an opened outer rollup already contains any opened inner one,
 * and React Flow cannot render the same artifact id both nested and top-level. */
export function minimalRollupExpansions(
  tree: ModuleTree,
  index: GraphIndex,
  requestedRootIds: ReadonlySet<string>,
): MinimalRollupExpansion[] {
  const roots = [...requestedRootIds]
    .filter((rootId) => ![...requestedRootIds].some(
      (otherId) => otherId !== rootId && index.isWithinFocus(otherId, rootId),
    ))
    .sort();
  return roots
    .map((rootId) => detachSubtree(tree, rootId))
    .filter((entry): entry is MinimalRollupExpansion => entry !== null);
}

function detachSubtree(tree: ModuleTree, rootId: string): MinimalRollupExpansion | null {
  const root = tree.nodes.find((node) => node.id === rootId);
  if (!root?.isContainer || !root.isExpanded) {
    return null;
  }
  const kept = new Set<string>();
  const nodes: VisibleModuleNode[] = [];
  const rootDepth = root.depth;
  for (const node of tree.nodes) {
    if (node.id === rootId) {
      kept.add(node.id);
      nodes.push({ ...node, parentId: null, depth: 0 });
      continue;
    }
    if (node.parentId === null || !kept.has(node.parentId)) {
      continue;
    }
    kept.add(node.id);
    nodes.push({ ...node, depth: Math.max(0, node.depth - rootDepth) });
  }
  const frontierIds = nodes
    .filter((node) => node.id !== rootId && (
      node.kind === "file"
      || ((node.kind === "package" || node.kind === "serviceDomain") && !node.isExpanded)
    ))
    .map((node) => node.id);
  if (frontierIds.length === 0) {
    return null;
  }
  const edges = tree.edges.filter((edge) => kept.has(edge.source) && kept.has(edge.target));
  return { rootId, frontierIds, nodes, edges };
}
