/**
 * The Module-map level pipeline behind one call: derive the containment level for the current focus
 * (the package overview when null, else the focus's children with imports folded to them), then lay
 * it out with ELK. Kept pure of store concerns so the store can wrap it in a stale-layout guard,
 * exactly like `deriveCompositionLayout`. The import graph is built once and passed in (the store
 * caches it), never rebuilt per relayout.
 */

import type { Edge, Node } from "@xyflow/react";
import type { GraphIndex } from "../graph/graphIndex";
import { deriveLevel } from "../derive/moduleLevel";
import type { ModuleGraph } from "../derive/moduleGraph";
import { layoutLevel } from "../layout/moduleLevelLayout";

export interface ModuleLevelLayout {
  nodes: Node[];
  edges: Edge[];
  /** The node actually rendered from after chain-collapse; null == the repo-level overview. */
  effectiveFocus: string | null;
}

export async function deriveModuleLevelLayout(
  index: GraphIndex,
  focus: string | null,
  graph: ModuleGraph,
): Promise<ModuleLevelLayout> {
  const spec = deriveLevel(index, focus, graph);
  const { nodes, edges } = await layoutLevel(spec);
  return { nodes, edges, effectiveFocus: spec.effectiveFocus };
}
