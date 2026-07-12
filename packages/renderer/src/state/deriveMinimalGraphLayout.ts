/**
 * THE minimal-graph feature entry: build the curated MEMBER subgraph (+ its ghost-satellite ring, the
 * Map's own projection), then lay it out by MIRRORING the Module map — member boxes that were on the
 * map keep their captured positions (`basePositions`), the rest are placed relative to them, and the
 * satellites band outside the core (see `minimalSubgraphLayout`). `originIds` (the raw selection)
 * drives the seed vs persistent tier split. Pure of store concerns.
 */

import type { LogicFlows } from "@meridian/core";
import type { Edge, Node } from "@xyflow/react";
import type { GraphIndex } from "../graph/graphIndex";
import type { ModuleGraph } from "../derive/moduleGraph";
import type { BlockDeps } from "../derive/blockDeps";
import { buildMinimalSubgraph } from "../derive/minimalSubgraph";
import { layoutMinimalSubgraph } from "../layout/minimalSubgraphLayout";
import type { PlacedRect } from "../layout/minimalPlacement";
import { MAP_RELATION_POLICY, type LensRelationPolicy } from "../graph/lensRelationPolicy";
import type { MinimalRollupExpansion } from "../derive/minimalRollupExpansion";

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
  /** Rolled group members disclosed through the ordinary Map package chevron. */
  expandableGroupIds?: ReadonlySet<string>;
  /** Canonical Map subtrees for the rolled packages currently opened in place. */
  rollupExpansions?: readonly MinimalRollupExpansion[];
  /** PR flow review: exact drawn callables whose incident dependencies must stay attached to the
   * callable instead of folding to their member files. */
  inspectionIds?: ReadonlySet<string>;
}

export async function deriveMinimalGraphLayout(
  index: GraphIndex,
  moduleGraph: ModuleGraph,
  memberIds: ReadonlySet<string>,
  originIds: ReadonlySet<string>,
  basePositions: Record<string, PlacedRect>,
  code: MinimalCodeInputs,
  arrange = false,
  hiddenIds: ReadonlySet<string> = new Set<string>(),
  relationPolicy: LensRelationPolicy = MAP_RELATION_POLICY,
): Promise<MinimalGraphLayout> {
  const rollupExpansions = code.rollupExpansions ?? [];
  const effectiveMembers = replaceExpandedRollups(memberIds, rollupExpansions, index);
  const effectiveOrigins = replaceExpandedRollups(originIds, rollupExpansions, index);
  const spec = buildMinimalSubgraph(
    index,
    moduleGraph,
    effectiveMembers,
    effectiveOrigins,
    {
      expanded: code.moduleExpanded,
      blockDeps: code.blockDeps,
      flows: code.flows,
      expandableGroupIds: code.expandableGroupIds,
      inspectionIds: code.inspectionIds,
    },
    hiddenIds,
  );
  const groupExpansions = rollupExpansions.map((expansion) => ({
    ...expansion,
    tier: [...originIds].some((id) => index.isWithinFocus(expansion.rootId, id))
      ? "seed" as const
      : "persistent" as const,
  }));
  return layoutMinimalSubgraph(spec, basePositions, arrange, relationPolicy, groupExpansions);
}

/** Replace a logical rollup member only for derivation. Store membership remains anchored to the
 * package, while edges/ghosts project over the exact visible frontier inside its open frame. */
function replaceExpandedRollups(
  ids: ReadonlySet<string>,
  expansions: readonly MinimalRollupExpansion[],
  index: GraphIndex,
): Set<string> {
  const effective = new Set(ids);
  for (const expansion of expansions) {
    const covered = [...effective].filter((id) => index.isWithinFocus(expansion.rootId, id));
    if (covered.length === 0) {
      continue;
    }
    covered.forEach((id) => effective.delete(id));
    expansion.frontierIds.forEach((id) => effective.add(id));
  }
  return effective;
}
