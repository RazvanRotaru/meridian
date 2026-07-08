/**
 * The Service-composition tab's Module-map pipeline: derive service clusters in the Map's tree
 * shapes, then lay them out with the same nested ELK pass. There is no zoom/focus in this lens,
 * so the effective focus always stays null.
 */

import type { GraphIndex } from "../graph/graphIndex";
import { deriveServiceTree } from "../derive/serviceClusterTree";
import { layoutModuleTree } from "../layout/moduleLevelLayout";
import type { ModuleLevelLayout } from "./deriveModuleMapLayout";

export async function deriveServiceLevelLayout(
  index: GraphIndex,
  expanded: ReadonlySet<string>,
): Promise<ModuleLevelLayout> {
  const tree = deriveServiceTree([...index.nodesById.values()], index.edges, expanded);
  if (tree.nodes.length === 0) {
    return { nodes: [], edges: [], effectiveFocus: null };
  }
  const { nodes, edges } = await layoutModuleTree(tree.nodes, tree.edges);
  return { nodes, edges, effectiveFocus: null };
}
