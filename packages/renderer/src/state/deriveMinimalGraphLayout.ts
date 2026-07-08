/**
 * THE minimal-graph feature entry: build the overlay subgraph from its seeds (+ their always-shown
 * 1-hop ring), the committed ghosts, and the directional expansions, then lay it out with nested ELK,
 * rendered by the Module-map's own card components. Pure of store concerns, like `deriveModuleMapLayout`.
 */

import type { Edge, Node } from "@xyflow/react";
import type { GraphIndex } from "../graph/graphIndex";
import type { ModuleGraph } from "../derive/moduleGraph";
import { buildMinimalSubgraph, type ExpansionEntry } from "../derive/minimalSubgraph";
import { layoutMinimalSubgraph } from "../layout/minimalSubgraphLayout";

export interface MinimalGraphLayout {
  nodes: Node[];
  edges: Edge[];
}

export async function deriveMinimalGraphLayout(
  index: GraphIndex,
  moduleGraph: ModuleGraph,
  seedModuleIds: ReadonlySet<string>,
  keptIds: ReadonlySet<string>,
  expanded: readonly ExpansionEntry[],
): Promise<MinimalGraphLayout> {
  const spec = buildMinimalSubgraph(index, moduleGraph, seedModuleIds, keptIds, expanded);
  return layoutMinimalSubgraph(spec);
}
