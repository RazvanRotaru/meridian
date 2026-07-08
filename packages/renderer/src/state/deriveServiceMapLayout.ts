/**
 * The Service-composition pipeline behind one call: derive the service-cluster containment tree,
 * then lay it out with the SAME ELK module-tree layout as the Map — the "call" lens reuses the
 * module slice wholesale, only the organizing principle (service clusters, not folders) differs.
 * Kept pure of store concerns so the store wraps it in the same stale-layout guard as
 * `deriveModuleLevelLayout`. There is no zoom/focus on this tab, so `effectiveFocus` is always null.
 */

import type { GraphIndex } from "../graph/graphIndex";
import { deriveServiceTree } from "../derive/serviceClusterTree";
import { layoutModuleTree } from "../layout/moduleLevelLayout";
import type { ModuleLevelLayout } from "./deriveModuleMapLayout";

export async function deriveServiceLevelLayout(index: GraphIndex, expanded: ReadonlySet<string>): Promise<ModuleLevelLayout> {
  const nodes = [...index.nodesById.values()];
  const tree = deriveServiceTree(nodes, index.edges, expanded);
  if (tree.nodes.length === 0) {
    return { nodes: [], edges: [], effectiveFocus: null };
  }
  const laid = await layoutModuleTree(tree.nodes, tree.edges);
  return { nodes: laid.nodes, edges: laid.edges, effectiveFocus: null };
}
