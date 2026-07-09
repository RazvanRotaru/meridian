/**
 * The Module-map pipeline behind one call: derive the flat containment level for the current focus
 * (the package overview when null, else the focus's children with imports lifted to the visible
 * frontier), then lay it out with ELK. Kept pure of store concerns so the store can wrap it in a
 * stale-layout guard, exactly like `deriveCompositionLayout`. The import graph is built once and
 * passed in (the store caches it), never rebuilt per relayout.
 */

import type { LogicFlows } from "@meridian/core";
import type { Edge, Node } from "@xyflow/react";
import type { GraphIndex } from "../graph/graphIndex";
import { deriveModuleTree } from "../derive/moduleTree";
import type { ModuleGraph } from "../derive/moduleGraph";
import type { BlockDeps } from "../derive/blockDeps";
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
  blockDeps: BlockDeps,
  flows: LogicFlows,
): Promise<ModuleLevelLayout> {
  const tree = deriveModuleTree(index, { kind: "focus", focus }, expanded, graph, blockDeps, flows);
  const { nodes, edges } = await layoutModuleTree(tree.nodes, tree.edges);
  return { nodes, edges, effectiveFocus: tree.effectiveFocus };
}

/** The minimal-graph surface: the SAME level pipeline seeded by an EXPLICIT set (the picked files)
 * instead of a folder focus. Bare top-level file cards, their off-level code ghosts, one ELK pass —
 * everything the folder Map does, just with a different root container. `seedPositions` carries the
 * cards' captured Map coordinates so ELK lays out INTERACTIVE from there (the seamless transition);
 * revealed nodes with no captured spot step off their anchor. Effective focus is always null. */
export async function deriveSeedGraphLayout(
  index: GraphIndex,
  seedIds: ReadonlySet<string>,
  expanded: ReadonlySet<string>,
  graph: ModuleGraph,
  blockDeps: BlockDeps,
  flows: LogicFlows,
  seedPositions: Record<string, { x: number; y: number }>,
): Promise<{ nodes: Node[]; edges: Edge[] }> {
  const tree = deriveModuleTree(index, { kind: "explicit", ids: [...seedIds] }, expanded, graph, blockDeps, flows);
  const { nodes, edges } = await layoutModuleTree(tree.nodes, tree.edges, seedPositions);
  return { nodes, edges };
}
