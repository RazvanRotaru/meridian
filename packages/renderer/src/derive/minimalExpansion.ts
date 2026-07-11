/**
 * One expanded file's code subtree for the minimal-graph overlay, in the Module-map's OWN
 * VisibleModuleNode + edge shapes — so an expanded file card can be sized and nested by the Map's
 * exact per-file ELK pass (`layoutModuleTree`) rather than a parallel nesting layout. It reuses the
 * shared `codeWalk` (visitFile/visitCode) + edge helpers, so the overlay and the Map cannot drift on
 * what a file expands into. Edges are kept STRICTLY intra-file (both endpoints inside this file's
 * subtree); cross-file dependency wires would dangle at a frame nobody drew here. Pure; no React.
 */

import type { LogicFlows } from "@meridian/core";
import type { GraphIndex } from "../graph/graphIndex";
import type { ModuleGraph } from "./moduleGraph";
import type { BlockDeps } from "./blockDeps";
import { createCodeWalk, depWireEdges, flowChainEdges, stepCallEdges, visitCode, type Skeleton } from "./codeWalk";
import { finalizeModuleNode } from "./moduleTreeData";
import type { ModulePackageData } from "./packageOverview";
import type { ModuleTreeEdge, VisibleModuleNode } from "./moduleTreeTypes";

/** One expanded file's drawn subtree: the file frame node first (parents-before-children), its
 * nested unit/block/step cards, and their intra-file dep/flow/step wires. Ready for `layoutModuleTree`. */
export interface MinimalExpansion {
  fileId: string;
  nodes: VisibleModuleNode[];
  edges: ModuleTreeEdge[];
}

/** The file card's container facts (for the flat card's chevron) plus, when it is expanded, its
 * drawn code subtree. A collapsed or childless file yields `expansion: null`. `calls` and
 * `expandedBlocks` surface the walk's step-call/expansion facts for the overlay's GHOST projection —
 * the same inputs `moduleTree` feeds `ghostDepWires` from its own walk (empty while collapsed). */
export interface FileCodeWalk {
  isContainer: boolean;
  isExpanded: boolean;
  unitCount: number;
  expansion: MinimalExpansion | null;
  /** Keep the original owning block so a synthetic step-call wire can still resolve package scope. */
  calls: ReadonlyArray<{ stepId: string; blockId: string; target: string }>;
  expandedBlocks: ReadonlySet<string>;
}

const NO_IMPORT_FOLD = new Map<string, ModulePackageData>();

/** Walk one file's code the way the Map does, for the SAME `expanded` set. Returns the card's
 * container affordance always, and its nested subtree only when the file is actually expanded. */
export function walkFileCode(
  fileId: string,
  index: GraphIndex,
  graph: ModuleGraph,
  expanded: ReadonlySet<string>,
  blockDeps: BlockDeps,
  flows: LogicFlows,
): FileCodeWalk {
  const walk = createCodeWalk();
  visitCode(fileId, null, 0, { index, expanded, flows }, walk);
  const fileEntry = walk.skeleton.find((entry) => entry.id === fileId);
  if (!fileEntry) {
    return { isContainer: false, isExpanded: false, unitCount: 0, expansion: null, calls: [], expandedBlocks: new Set() };
  }
  const facts = { isContainer: fileEntry.isContainer, isExpanded: fileEntry.isExpanded, unitCount: fileEntry.childCount, calls: walk.calls, expandedBlocks: walk.expandedBlocks };
  if (!fileEntry.isExpanded) {
    return { ...facts, expansion: null };
  }
  return { ...facts, expansion: assembleExpansion(fileId, walk.skeleton, walk, index, graph, blockDeps) };
}

function assembleExpansion(
  fileId: string,
  skeleton: Skeleton[],
  walk: ReturnType<typeof createCodeWalk>,
  index: GraphIndex,
  graph: ModuleGraph,
  blockDeps: BlockDeps,
): MinimalExpansion {
  const visibleIds = new Set(skeleton.map((entry) => entry.id));
  const kinds = new Map(skeleton.map((entry) => [entry.id, entry.kind]));
  const isCode = (id: string) => kinds.get(id) === "unit" || kinds.get(id) === "block";
  const nodes = skeleton.map((entry) => finalizeModuleNode(entry, index, graph, [], walk.stepData, NO_IMPORT_FOLD));
  const edges = [
    ...depWireEdges(blockDeps, visibleIds, index, isCode, walk.expandedBlocks),
    ...flowChainEdges(walk),
    ...stepCallEdges(walk, visibleIds, index),
  ]
    .filter((edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target))
    .sort((a, b) => a.id.localeCompare(b.id));
  return { fileId, nodes, edges };
}
