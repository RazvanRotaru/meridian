/**
 * THE minimal-graph feature entry: build the overlay subgraph from its seeds (+ their always-shown
 * 1-hop ring), the committed ghosts, and the directional expansions, then lay it out by MIRRORING the
 * Module map — files that were on the map keep their captured positions (`basePositions`), the rest
 * are placed relative to them (see `minimalSubgraphLayout`). Pure of store concerns.
 */

import type { LogicFlows } from "@meridian/core";
import type { Edge, Node } from "@xyflow/react";
import type { GraphIndex } from "../graph/graphIndex";
import type { ModuleGraph } from "../derive/moduleGraph";
import type { BlockDeps } from "../derive/blockDeps";
import { buildMinimalSubgraph, type ExpansionEntry, type MinimalSubgraphOptions } from "../derive/minimalSubgraph";
import { layoutMinimalSubgraph } from "../layout/minimalSubgraphLayout";
import type { PlacedRect } from "../layout/minimalPlacement";

export interface MinimalGraphLayout {
  nodes: Node[];
  edges: Edge[];
}

/** The in-place expansion inputs mirrored from the Module map: the SAME `moduleExpanded` id space,
 * plus the block-dependency + logic-flow substrates its code walk reads. */
export interface MinimalCodeInputs {
  moduleExpanded: ReadonlySet<string>;
  blockDeps: BlockDeps;
  flows: LogicFlows;
}

export async function deriveMinimalGraphLayout(
  index: GraphIndex,
  moduleGraph: ModuleGraph,
  seedModuleIds: ReadonlySet<string>,
  keptIds: ReadonlySet<string>,
  expanded: readonly ExpansionEntry[],
  basePositions: Record<string, PlacedRect>,
  code: MinimalCodeInputs,
  options: MinimalSubgraphOptions = {},
): Promise<MinimalGraphLayout> {
  const onMapIds = new Set(Object.keys(basePositions));
  const spec = buildMinimalSubgraph(
    index,
    moduleGraph,
    seedModuleIds,
    keptIds,
    expanded,
    onMapIds,
    { expanded: code.moduleExpanded, blockDeps: code.blockDeps, flows: code.flows },
    options,
  );
  return layoutMinimalSubgraph(spec, basePositions);
}
