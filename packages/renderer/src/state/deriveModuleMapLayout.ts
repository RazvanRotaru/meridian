/**
 * The Module-map pipeline behind one call: derive the flat containment level for the current focus
 * (the package overview when null, else the focus's children with imports lifted to the visible
 * frontier), then lay it out with ELK. Kept pure of store concerns so the store can wrap it in a
 * stale-layout guard, exactly like `deriveCompositionLayout`. The import graph is built once and
 * passed in (the store caches it), never rebuilt per relayout.
 */

import type { Edge, Node } from "@xyflow/react";
import type { GraphIndex } from "../graph/graphIndex";
import { deriveModuleTree } from "../derive/moduleTree";
import type { ModuleGraph } from "../derive/moduleGraph";
import { layoutModuleTree } from "../layout/moduleLevelLayout";

export interface ModuleLevelLayout {
  nodes: Node[];
  edges: Edge[];
  /** The node actually descended into after chain-collapse; null == the repo-level overview. */
  effectiveFocus: string | null;
}

export async function deriveModuleLevelLayout(
  index: GraphIndex,
  focus: string | null,
  expanded: ReadonlySet<string>,
  graph: ModuleGraph,
): Promise<ModuleLevelLayout> {
  const tree = deriveModuleTree(index, focus, expanded, graph);
  const { nodes, edges } = await layoutModuleTree(tree.nodes, tree.edges);
  return { nodes, edges, effectiveFocus: tree.effectiveFocus };
}
