/**
 * THE minimal-graph feature entry: given any set of seed file-module ids, build the minimal
 * containment subgraph (ancestor union + capped 1-hop import boundary) and lay it out with nested
 * ELK. Extracted from the PR-review pipeline so the construction is a first-class capability: the
 * Module-map's "Build minimal graph" (multi-selection) calls it bare, and the PR-review lens calls
 * it with its per-file change statuses, which are stamped onto the spec between build and layout.
 * Pure of store concerns, exactly like `deriveModuleMapLayout`.
 */

import type { Edge, Node } from "@xyflow/react";
import type { GraphIndex } from "../graph/graphIndex";
import type { ModuleGraph } from "../derive/moduleGraph";
import type { ChangeStatus } from "../derive/changeStatus";
import {
  buildMinimalSubgraph,
  stampChangeStatuses,
  type MinimalSubgraphOptions,
} from "../derive/minimalSubgraph";
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
  statusByFile?: Record<string, ChangeStatus>,
): Promise<MinimalGraphLayout> {
  const built = buildMinimalSubgraph(index, moduleGraph, seedModuleIds, options).spec;
  // Only the review caller passes a status map (even an empty one — it means "all modified"); its
  // absence keeps the graph free of diff semantics, so seed cards render as plain picked files.
  const spec = statusByFile ? stampChangeStatuses(built, statusByFile) : built;
  return layoutMinimalSubgraph(spec);
}
