/**
 * THE minimal-graph feature entry: build the curated MEMBER/GHOST subgraph from the working member set
 * (+ its on-map 1-hop ghost ring), then lay it out by MIRRORING the Module map — boxes that were on the
 * map keep their captured positions (`basePositions`), the rest are placed relative to them (see
 * `minimalSubgraphLayout`). `originIds` (the raw selection) drives the seed vs persistent tier split.
 * Pure of store concerns.
 */

import type { LogicFlows } from "@meridian/core";
import type { Edge, Node } from "@xyflow/react";
import type { GraphIndex } from "../graph/graphIndex";
import type { ModuleGraph } from "../derive/moduleGraph";
import type { BlockDeps } from "../derive/blockDeps";
import { buildMinimalSubgraph } from "../derive/minimalSubgraph";
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
  memberIds: ReadonlySet<string>,
  originIds: ReadonlySet<string>,
  basePositions: Record<string, PlacedRect>,
  code: MinimalCodeInputs,
  arrange = false,
): Promise<MinimalGraphLayout> {
  const onMapIds = new Set(Object.keys(basePositions));
  const spec = buildMinimalSubgraph(index, moduleGraph, memberIds, originIds, onMapIds, {
    expanded: code.moduleExpanded,
    blockDeps: code.blockDeps,
    flows: code.flows,
  });
  return layoutMinimalSubgraph(spec, basePositions, arrange);
}
