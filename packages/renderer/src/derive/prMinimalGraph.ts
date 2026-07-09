/**
 * PR-review minimal graph: the same pure minimal-subgraph pipeline the Module-map overlay uses
 * (`buildMinimalSubgraph` + `layoutMinimalSubgraph`), but SEEDED from the PR's changed modules instead
 * of a user selection. Every changed node lifts to its nearest owning file (`module`); those files are
 * the seeds. There are no captured map positions here, so `basePositions` is empty — the layout places
 * the changed files fresh. A post-pass marks each changed/seed node so the view can paint a change ring
 * regardless of the inner node component. Pure; no React, no store.
 */

import type { GraphArtifact, LogicFlows } from "@meridian/core";
import type { Edge, Node } from "@xyflow/react";
import type { GraphIndex } from "../graph/graphIndex";
import { buildModuleGraph } from "./moduleGraph";
import { buildBlockDeps } from "./blockDeps";
import { deriveMinimalGraphLayout } from "../state/deriveMinimalGraphLayout";

const MODULE_KIND = "module";
const CHANGE_RING = "2px solid #f5a623";

export interface PrMinimalGraph {
  nodes: Node[];
  edges: Edge[];
  /** The seed module ids the subgraph grew from (the changed files). */
  seedIds: string[];
}

export async function derivePrMinimalGraph(prIndex: GraphIndex, prArtifact: GraphArtifact): Promise<PrMinimalGraph> {
  const seedIds = changedModuleSeeds(prIndex);
  const moduleGraph = buildModuleGraph(prIndex);
  const flows = (prArtifact.extensions?.logicFlow ?? {}) as unknown as LogicFlows;
  const layout = await deriveMinimalGraphLayout(
    prIndex,
    moduleGraph,
    new Set(seedIds),
    new Set(), // no drilled-through (kept) ghosts
    [], // no directional expansions
    {}, // no captured map positions — place the changed files fresh
    { moduleExpanded: new Set(), blockDeps: buildBlockDeps(prIndex), flows },
  );
  const seedSet = new Set(seedIds);
  const nodes = layout.nodes.map((node) => markChanged(node, prIndex.changedIds, seedSet));
  return { nodes, edges: layout.edges, seedIds };
}

/** For every changed node, its nearest owning `module` ancestor id — deduped + sorted for determinism. */
function changedModuleSeeds(prIndex: GraphIndex): string[] {
  const seeds = new Set<string>();
  for (const changedId of prIndex.changedIds) {
    const moduleId = nearestModule(prIndex, changedId);
    if (moduleId) {
      seeds.add(moduleId);
    }
  }
  return [...seeds].sort();
}

/** `ancestorsOf` is root..self inclusive, so the LAST `module` entry is the nearest owning file. */
function nearestModule(prIndex: GraphIndex, id: string): string | null {
  const ancestors = prIndex.ancestorsOf(id);
  for (let i = ancestors.length - 1; i >= 0; i -= 1) {
    if (ancestors[i].kind === MODULE_KIND) {
      return ancestors[i].id;
    }
  }
  return null;
}

/** Flag a changed/seed node in both data (for the component) and style (a ring any component shows). */
function markChanged(node: Node, changedIds: ReadonlySet<string>, seedIds: ReadonlySet<string>): Node {
  if (!changedIds.has(node.id) && !seedIds.has(node.id)) {
    return node;
  }
  return {
    ...node,
    data: { ...node.data, prChanged: true },
    style: { ...(node.style ?? {}), outline: CHANGE_RING, outlineOffset: "2px" },
  };
}
