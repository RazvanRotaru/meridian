/**
 * THE minimal-graph feature entry: given any set of seed file-module ids, build the minimal
 * containment subgraph (ancestor union + capped 1-hop import boundary) and lay it out with nested
 * ELK, rendered by the Module-map's own card components. Pure of store concerns, exactly like
 * `deriveModuleMapLayout`.
 */

import type { Edge, Node } from "@xyflow/react";
import type { GraphIndex } from "../graph/graphIndex";
import type { ModuleGraph } from "../derive/moduleGraph";
import { buildMinimalSubgraph, type MinimalSubgraphOptions } from "../derive/minimalSubgraph";
import { layoutMinimalSubgraph } from "../layout/minimalSubgraphLayout";

export interface MinimalGraphLayout {
  nodes: Node[];
  edges: Edge[];
}

export async function deriveMinimalGraphLayout(
  index: GraphIndex,
  moduleGraph: ModuleGraph,
  seedModuleIds: ReadonlySet<string>,
  options: MinimalSubgraphOptions = {},
): Promise<MinimalGraphLayout> {
  const spec = buildMinimalSubgraph(index, moduleGraph, seedModuleIds, options).spec;
  return layoutMinimalSubgraph(spec);
}
