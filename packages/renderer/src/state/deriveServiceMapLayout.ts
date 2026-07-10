/**
 * The Service-composition tab's Module-map pipeline: derive service clusters in the Map's tree
 * shapes, then lay them out with the same nested ELK pass. There is no zoom/focus in this lens,
 * so the effective focus always stays null.
 */

import type { LogicFlows } from "@meridian/core";
import type { GraphIndex } from "../graph/graphIndex";
import type { BlockDeps } from "../derive/blockDeps";
import type { ModuleGraph } from "../derive/moduleGraph";
import { deriveServiceTree } from "../derive/serviceClusterTree";
import { layoutModuleTree } from "../layout/moduleLevelLayout";
import type { ModuleLevelLayout } from "./deriveModuleMapLayout";

export async function deriveServiceLevelLayout(
  index: GraphIndex,
  expanded: ReadonlySet<string>,
  graph: ModuleGraph,
  blockDeps: BlockDeps,
  flows: LogicFlows,
  extraIds: ReadonlySet<string> = new Set<string>(),
): Promise<ModuleLevelLayout> {
  const tree = deriveServiceTree(index, expanded, graph, blockDeps, flows, extraIds);
  if (tree.nodes.length === 0) {
    return { nodes: [], edges: [], effectiveFocus: null };
  }
  const { nodes, edges } = await layoutModuleTree(tree.nodes, tree.edges);
  return { nodes, edges, effectiveFocus: null };
}
