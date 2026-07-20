/**
 * The UI lens as a Module-map surface (unified-canvas phase C): the SAME containment walk and card
 * vocabulary as the folder Map, but ROOTED at the render subtree (`uiFocusTarget`) and wired by the
 * RENDERS projection instead of the import graph:
 *
 *   - `focus === null` → inside the render root (the component tree front-and-centre); a dive
 *     (`moduleFocus`) zooms the containment exactly like the Map, and flows out as `effectiveFocus`
 *     for the breadcrumb. No renders edges at all → the whole-repo overview (never a blank canvas).
 *   - EDGES are the renders wires lifted onto the drawn cards (category "dep", depKind "renders" —
 *     the lens keeps its cyan identity via the shared relationship paint) plus the dep wires of
 *     expanded cards, step chains, and step call wires — the Map's own code-level machinery.
 *   - GHOSTS ride the shared tier: an off-tree dep OR renders endpoint charts as a dashed ghost
 *     card exactly like the Map's off-level deps (same exact derivation, Tests filter, and optional
 *     paint-time parent grouping).
 *
 * Pure; no React, no ELK.
 */

import type { GraphEdge, LogicFlows } from "@meridian/core";
import type { GraphIndex } from "../graph/graphIndex";
import { UI_EDGE_KIND } from "./edgeSelection";
import { uiFocusTarget } from "./uiFocus";
import type { ModuleGraph } from "./moduleGraph";
import type { BlockDeps } from "./blockDeps";
import { collapseChain } from "./moduleLevel";
import { frontierRoots } from "./moduleFrontier";
import { extraRoots, walkContainment } from "./moduleTree";
import { depWireEdges, flowChainEdges, stepCallEdges, type Skeleton } from "./codeWalk";
import { finalizeModuleNode, foldById } from "./moduleTreeData";
import { ghostData, nearestVisible, type GhostEmission, type GhostWire } from "./ghostDeps";
import { finishGhostTier, isDepAnchorKind, rawGhostEmission } from "./ghostLevel";
import { folderGhostEmission, mergeGhostEmissions } from "./folderGhosts";
import type { LiftedEdge } from "./types";
import { liftEdges } from "./liftEdges";
import type { ModulePackageData } from "./packageOverview";
import type { ModuleTree, ModuleTreeEdge } from "./moduleTreeTypes";
import { graphEdgeCrossesPackage, underlyingEdgesCrossPackage } from "./packageBoundary";

/** A shared empty set so the default arguments never allocate per call. */
const EMPTY_IDS: ReadonlySet<string> = new Set<string>();

/** The renders-rooted containment tree for `(focus, expanded)` — see the module header. */
export function deriveUiTree(
  index: GraphIndex,
  focus: string | null,
  expanded: ReadonlySet<string>,
  graph: ModuleGraph,
  blockDeps: BlockDeps,
  flows: LogicFlows,
  extraIds: ReadonlySet<string> = EMPTY_IDS,
  hiddenIds: ReadonlySet<string> = EMPTY_IDS,
): ModuleTree {
  const dived = focus === null ? null : collapseChain(index, focus);
  // The lens's implicit root: the render subtree. A dive REPLACES it (containment zoom); with no
  // renders edges in the graph the root falls to null == the Map's whole-repo overview.
  const root = dived ?? uiFocusTarget(index);
  const roots = [...frontierRoots(index, root, graph), ...extraRoots(index, extraIds)];
  const walked = walkContainment(index, roots, expanded, flows, hiddenIds);
  const visibleIds = new Set(walked.skeleton.map((entry) => entry.id));
  // Hidden (test) endpoints drop BEFORE lifting and ghosting: an edge touching hidden code must not
  // re-materialize on the endpoint's visible ancestor — a hidden RTL test's renders would otherwise
  // lift onto its folder card and inflate the visible wires (the invariant hideTests.test.ts pins).
  const renders = index.edges.filter(
    (edge) => edge.kind === UI_EDGE_KIND && !hiddenIds.has(edge.source) && !hiddenIds.has(edge.target),
  );
  const lifted = liftEdges(renders, visibleIds, index.parentOf);
  // Only the true whole-repo fallback wears the overview ownership fold (mirrors the Map).
  const overviewFold = root === null ? foldById(index) : new Map<string, ModulePackageData>();
  const nodes = walked.skeleton.map((entry) => finalizeModuleNode(entry, index, graph, lifted, walked.stepData, overviewFold, hiddenIds));
  const kinds = new Map(walked.skeleton.map((entry) => [entry.id, entry.kind]));
  const isDepAnchor = (id: string) => isDepAnchorKind(kinds.get(id));
  const emission = mergeGhostEmissions(
    rawGhostEmission(blockDeps, walked, visibleIds, index, kinds),
    rendersGhostEmission(renders, visibleIds, index, isDepAnchor),
    // A folder-only UI frontier cannot anchor the symbol-level renders projection above. Keep the
    // canvas at folder granularity by aggregating descendants onto the complete peer-folder set.
    folderGhostEmission(renders, visibleIds, index, hiddenIds),
  );
  const ghosts = finishGhostTier(emission, index, hiddenIds);
  const edges = [
    ...rendersTreeEdges(lifted, kinds, index),
    ...depWireEdges(blockDeps, visibleIds, index, isDepAnchor, walked.expandedBlocks),
    ...flowChainEdges(walked),
    ...stepCallEdges(walked, visibleIds, index),
    ...ghosts.edges,
  ].sort((a, b) => a.id.localeCompare(b.id));
  return { nodes: [...nodes, ...ghosts.nodes], edges, effectiveFocus: dived };
}

/** Lifted renders wires as level edges — category "dep" with depKind "renders", so the shared
 * relationship paint gives them the lens's cyan and the emphasis walk treats them as couplings. */
function rendersTreeEdges(lifted: LiftedEdge[], kinds: Map<string, Skeleton["kind"]>, index: GraphIndex): ModuleTreeEdge[] {
  return lifted.map((edge) => ({
    id: `uir:${edge.source}->${edge.target}`,
    source: edge.source,
    target: edge.target,
    weight: edge.weight,
    crossFrame: kinds.get(edge.source) === "package" || kinds.get(edge.target) === "package",
    crossPackage: underlyingEdgesCrossPackage(edge.underlyingEdgeIds, index),
    outsideView: false,
    category: "dep" as const,
    relationKind: UI_EDGE_KIND,
    depKind: UI_EDGE_KIND,
    underlyingEdgeIds: edge.underlyingEdgeIds,
  }));
}

/** Renders edges that LEAVE the drawn tree, as ghost cards + wires — the same off-level projection
 * the Map runs for code deps: one drawn endpoint anchors the wire, the off-tree REAL endpoint
 * becomes the dashed ghost (ext:/unresolved: targets have no definition to chart). */
function rendersGhostEmission(
  renders: GraphEdge[],
  visibleIds: ReadonlySet<string>,
  index: GraphIndex,
  isAnchor: (id: string) => boolean,
): GhostEmission {
  const ghosts = new Map<string, ReturnType<typeof ghostData>>();
  const byPair = new Map<string, GhostWire>();
  // Real artifact edge ids ride along so the Wire Inspector can attribute a ghost renders wire.
  const add = (source: string, target: string, ghostId: string, weight: number, edge: GraphEdge): void => {
    const node = index.nodesById.get(ghostId);
    if (!node) {
      return;
    }
    ghosts.set(ghostId, ghostData(node));
    const key = `${source} ${target}`;
    const existing = byPair.get(key);
    if (existing) {
      existing.weight += weight;
      existing.crossPackage ||= graphEdgeCrossesPackage(edge, index);
      existing.underlyingEdgeIds.push(edge.id);
    } else {
      byPair.set(key, {
        source,
        target,
        weight,
        kind: UI_EDGE_KIND,
        crossPackage: graphEdgeCrossesPackage(edge, index),
        underlyingEdgeIds: [edge.id],
      });
    }
  };
  for (const edge of renders) {
    const sourceVisible = nearestVisible(edge.source, visibleIds, index);
    const targetVisible = nearestVisible(edge.target, visibleIds, index);
    const weight = edge.weight ?? 1;
    if (sourceVisible !== null && targetVisible === null && isAnchor(sourceVisible)) {
      add(sourceVisible, edge.target, edge.target, weight, edge);
    }
    if (targetVisible !== null && sourceVisible === null && isAnchor(targetVisible)) {
      add(edge.source, targetVisible, edge.source, weight, edge);
    }
  }
  return { ghosts, wires: [...byPair.values()] };
}
