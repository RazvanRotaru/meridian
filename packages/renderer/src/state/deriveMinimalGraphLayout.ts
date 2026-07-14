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
import { buildMinimalSubgraph, type MinimalSubgraphSpec } from "../derive/minimalSubgraph";
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
  /** Project every dependency over the visible expanded frontier instead of folding eagerly to the
   * member set. Collapsed files still remain the nearest visible endpoints. */
  directDependencies?: boolean;
  /** Optional PR-review projection: only these artifact nodes and their relationships are laid out.
   * The caller supplies an ancestor-closed set so retained declarations keep their file/package
   * frames while unrelated siblings, ghosts, and their incident edges disappear before ELK. */
  visibleIds?: ReadonlySet<string>;
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
  const rollupExpansions = code.visibleIds === undefined
    ? (code.rollupExpansions ?? [])
    : filterMinimalRollupExpansions(code.rollupExpansions ?? [], code.visibleIds);
  const effectiveMembers = replaceExpandedRollups(memberIds, rollupExpansions, index);
  const effectiveOrigins = replaceExpandedRollups(originIds, rollupExpansions, index);
  const builtSpec = buildMinimalSubgraph(
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
      directDependencies: code.directDependencies,
    },
    hiddenIds,
  );
  const spec = code.visibleIds === undefined
    ? builtSpec
    : filterMinimalSubgraph(builtSpec, code.visibleIds);
  const groupExpansions = rollupExpansions.map((expansion) => ({
    ...expansion,
    tier: [...originIds].some((id) => index.isWithinFocus(expansion.rootId, id))
      ? "seed" as const
      : "persistent" as const,
  }));
  return layoutMinimalSubgraph(spec, basePositions, arrange, relationPolicy, groupExpansions);
}

/** Canonical review visibility: exact hunk-matched nodes plus their root-to-node containment chain.
 * Keeping this predicate beside the layout filter prevents UI wording or graph curation tiers from
 * becoming an accidental second definition of "in the diff". */
export function reviewDiffVisibleIds(index: GraphIndex, affectedIds: ReadonlySet<string>): Set<string> {
  const visible = new Set<string>();
  for (const id of affectedIds) {
    const ancestors = index.ancestorsOf(id);
    if (ancestors.length === 0) {
      // Defensive fallback for a transient affected id while a prepared graph is being swapped.
      // The later spec filter still ignores it unless the id is actually present in the scene.
      visible.add(id);
      continue;
    }
    ancestors.forEach((node) => visible.add(node.id));
  }
  return visible;
}

/** Remove non-diff context before layout so hiding it also compacts expanded file frames. */
export function filterMinimalSubgraph(
  spec: MinimalSubgraphSpec,
  visibleIds: ReadonlySet<string>,
): MinimalSubgraphSpec {
  const syntheticMemberOwners = spec.syntheticMemberOwners ?? new Map<string, string>();
  const visibleSyntheticMembers = new Set(
    [...syntheticMemberOwners]
      .filter(([, ownerId]) => visibleIds.has(ownerId))
      .map(([id]) => id),
  );
  const expansions = spec.expansions.flatMap((expansion) => {
    const syntheticVisible = expansion.artifactOwnerId !== undefined
      && visibleIds.has(expansion.artifactOwnerId);
    if (!visibleIds.has(expansion.fileId) && !syntheticVisible) {
      return [];
    }
    const selectedSubtree = new Set(
      expansion.nodes
        .filter((node) => visibleSyntheticMembers.has(node.id))
        .map((node) => node.id),
    );
    for (const node of expansion.nodes) {
      if (selectedSubtree.has(node.parentId ?? "")) {
        selectedSubtree.add(node.id);
      }
    }
    const parentById = new Map(expansion.nodes.map((node) => [node.id, node.parentId]));
    const selectedPaths = new Set(selectedSubtree);
    for (const selectedId of selectedSubtree) {
      let parentId = parentById.get(selectedId) ?? null;
      while (parentId !== null && !selectedPaths.has(parentId)) {
        selectedPaths.add(parentId);
        parentId = parentById.get(parentId) ?? null;
      }
    }
    const nodes = syntheticVisible
      ? expansion.nodes
      : expansion.nodes.filter((node) => visibleIds.has(node.id) || selectedPaths.has(node.id));
    const retained = new Set(nodes.map((node) => node.id));
    return [{
      ...expansion,
      nodes,
      edges: expansion.edges.filter((edge) => retained.has(edge.source) && retained.has(edge.target)),
    }];
  });
  // Outer cross-root edges may target a selected synthetic node embedded in an artifact-root
  // expansion, so every node that survived expansion filtering participates in endpoint retention.
  const retainedExpansionIds = new Set(
    expansions.flatMap((expansion) => expansion.nodes.map((node) => node.id)),
  );
  const retainedIds = new Set([...visibleIds, ...retainedExpansionIds]);
  return {
    nodes: spec.nodes.filter((node) => retainedIds.has(node.id)),
    edges: spec.edges.filter((edge) => retainedIds.has(edge.source) && retainedIds.has(edge.target)),
    expansions,
    syntheticMemberOwners: new Map(
      [...syntheticMemberOwners].filter(([id]) => retainedIds.has(id)),
    ),
  };
}

/** Apply the same projection to opened rollup packages before they replace their logical member. */
export function filterMinimalRollupExpansions(
  expansions: readonly MinimalRollupExpansion[],
  visibleIds: ReadonlySet<string>,
): MinimalRollupExpansion[] {
  return expansions.flatMap((expansion) => {
    if (!visibleIds.has(expansion.rootId)) {
      return [];
    }
    const nodes = expansion.nodes.filter((node) => visibleIds.has(node.id));
    const retained = new Set(nodes.map((node) => node.id));
    const frontierIds = expansion.frontierIds.filter((id) => retained.has(id));
    // With no visible frontier, leave the logical rollup as its compact summary card instead of
    // replacing it with an empty expanded frame.
    if (frontierIds.length === 0) {
      return [];
    }
    return [{
      ...expansion,
      frontierIds,
      nodes,
      edges: expansion.edges.filter((edge) => retained.has(edge.source) && retained.has(edge.target)),
    }];
  });
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
