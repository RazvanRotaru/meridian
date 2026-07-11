/**
 * The Map lens's INLINE-EXPANDABLE containment tree, wired by the import graph lifted to the
 * visible frontier. Unlike the old flat one-level fold, this walks the real `parentId` hierarchy
 * from the current focus and emits a NESTED set: a group card that the reader expanded yields its
 * children as `parentId`-nested nodes, exactly like the logic-flow tab.
 *
 *   - `focus === null` → the whole-repo overview: npm packages that own at least one file.
 *   - a `focus` package/dir → its children, after chain-collapsing a lone `src`.
 *   - a focused/expanded FILE enters `codeWalk`: classes/interfaces/objects become unit cards that
 *     expand into member frames, file-level functions/types become block cards, and flow-bearing
 *     blocks can unroll into steps.
 *
 * Imports are folded to visible boxes by `liftEdges`; code dependencies and step wires delegate to
 * `codeWalk`, so the Map and Service lenses render file/decl/block/step subtrees identically.
 * Pure; no React, no ELK.
 */

import type { LogicFlows } from "@meridian/core";
import type { GraphIndex } from "../graph/graphIndex";
import { type ModulePackageData } from "./packageOverview";
import { type ModuleGraph } from "./moduleGraph";
import { collapseChain } from "./moduleLevel";
import { containmentChildren, frontierRoots, subtreeFileCount } from "./moduleFrontier";
import { BLOCK_KINDS, type BlockDeps, UNIT_CARD_KINDS } from "./blockDeps";
import { ghostLevel, isDepAnchorKind } from "./ghostLevel";
import { liftEdges } from "./liftEdges";
import { createCodeWalk, depWireEdges, flowChainEdges, stepCallEdges, visitCode, type CodeWalk, type Skeleton } from "./codeWalk";
import { finalizeModuleNode, foldById, importEdges, importTreeEdges } from "./moduleTreeData";
import { ipcTreeEdges } from "./moduleIpc";
import type { ModuleTree, ModuleTreeEdge } from "./moduleTreeTypes";
export type { ModuleGroupData, ModuleTree, ModuleTreeEdge, VisibleModuleNode } from "./moduleTreeTypes";

const MODULE_KIND = "module";
/** A shared empty set so the default `extraIds` argument never allocates per call. */
const EMPTY_IDS: ReadonlySet<string> = new Set<string>();

/** Palette-added ids as extra roots — only real file/unit/block nodes `walk` can draw, sorted for a
 * stable order. A package/unknown id is dropped (the walk would need its subtree, not the raw pin).
 * Exported for the UI lens's tree derive, which pins palette extras identically. */
export function extraRoots(index: GraphIndex, extraIds: ReadonlySet<string>): string[] {
  return [...extraIds]
    .filter((id) => {
      const kind = index.nodesById.get(id)?.kind;
      return kind !== undefined && (kind === MODULE_KIND || UNIT_CARD_KINDS.has(kind) || BLOCK_KINDS.has(kind));
    })
    .sort();
}

/** The containment tree to draw for `(focus, expanded)`: overview when null, else the focus subtree.
 * Private members and category-toggled cards are ALWAYS derived and laid out — those toggles hide at
 * PAINT time so positions hold still. `hiddenIds` (the Tests toggle) is the deliberate exception:
 * test code can be half a repo's cards, and paint-hiding it leaves a crater of kept empty space — so
 * hidden ids are excluded HERE and the level relayouts compact. */
export function deriveModuleTree(
  index: GraphIndex,
  focus: string | null,
  expanded: ReadonlySet<string>,
  graph: ModuleGraph,
  blockDeps: BlockDeps,
  flows: LogicFlows,
  extraIds: ReadonlySet<string> = EMPTY_IDS,
  hiddenIds: ReadonlySet<string> = EMPTY_IDS,
): ModuleTree {
  const effectiveFocus = focus === null ? null : collapseChain(index, focus);
  // Palette-pinned nodes (⌘P "+") ride in as EXTRA top-level roots so an out-of-focus card joins the
  // current level; `walk`'s `seen` guard drops any that the focus subtree already draws.
  const roots = [...frontierRoots(index, effectiveFocus, graph), ...extraRoots(index, extraIds)];
  const walked = walkContainment(index, roots, expanded, flows, hiddenIds);
  const skeleton = walked.skeleton;
  const visibleIds = new Set(skeleton.map((entry) => entry.id));
  const lifted = liftEdges(importEdges(graph), visibleIds, index.parentOf);
  // At the repo overview, root package cards wear the OWNERSHIP-fold numbers (each file counts once,
  // toward its nearest npm package) so nested packages never double-count — main's dedicated
  // package-overview fold, kept through the expandable walk.
  const overviewFold = effectiveFocus === null ? foldById(index) : new Map<string, ModulePackageData>();
  const nodes = skeleton.map((entry) => finalizeModuleNode(entry, index, graph, lifted, walked.stepData, overviewFold, hiddenIds));
  const kinds = kindsOf(skeleton);
  const ghosts = ghostLevel(blockDeps, walked, visibleIds, index, kinds, hiddenIds);
  const isDepAnchor = (id: string) => isDepAnchorKind(kinds.get(id));
  const edges = [
    ...importTreeEdges(lifted, kinds),
    // Code-level dep wires: anchored to file/unit/block cards (the detailed intra-package view).
    ...depWireEdges(blockDeps, visibleIds, index, isDepAnchor, walked.expandedBlocks),
    // Package-level dep wires: typed relationships (calls/extends/etc.) LIFTED to packages so the
    // repo overview shows more than just imports. Only emitted when packages are on screen.
    ...packageDepEdges(blockDeps, visibleIds, index, kinds),
    ...flowChainEdges(walked),
    ...stepCallEdges(walked, visibleIds, index),
    ...ipcTreeEdges(index, visibleIds),
    ...ghosts.edges,
  ].sort((a, b) => a.id.localeCompare(b.id));
  return { nodes: [...nodes, ...ghosts.nodes], edges, effectiveFocus };
}

/**
 * Typed dep relationships (calls/extends/implements/references) LIFTED to the package level.
 * Only emits edges when at least one package-kind node is visible — the repo overview.
 * Uses `liftEdges` directly (like ipcTreeEdges) without the code-level restrictions of
 * `liftDepEdges`, so inter-package relationships always surface.
 */
/** The coupling edge kinds to lift between packages (same set as @meridian/design-metrics). */
const PKG_DEP_KINDS: ReadonlySet<string> = new Set(["calls", "instantiates", "extends", "implements", "references"]);

function packageDepEdges(
  _blockDeps: BlockDeps,
  visibleIds: ReadonlySet<string>,
  index: GraphIndex,
  kinds: Map<string, Skeleton["kind"]>,
): ModuleTreeEdge[] {
  // Only emit at levels where packages are drawn (the repo overview / mid-level directory views).
  if (![...kinds.values()].some((k) => k === "package")) return [];
  const packageIds = new Set([...kinds.entries()].filter(([, k]) => k === "package").map(([id]) => id));
  // Use index.edges directly — bypass blockDeps which has lazy-init timing issues in some paths.
  const couplingEdges = index.edges.filter((e) => PKG_DEP_KINDS.has(e.kind));
  // Lift every coupling edge to the visible frontier — liftEdges drops self-loops (intra-package).
  const lifted = liftEdges(couplingEdges, visibleIds, index.parentOf);
  // Keep only edges where BOTH endpoints landed on a package (skip file-to-file at this level —
  // those are handled by depWireEdges). Aggregate by source+target+kind, summing weight.
  const byKey = new Map<string, { source: string; target: string; kind: string; weight: number }>();
  for (const edge of lifted) {
    if (!packageIds.has(edge.source) || !packageIds.has(edge.target)) continue;
    const key = `${edge.kind}@${edge.source}|${edge.target}`;
    const existing = byKey.get(key);
    if (existing) { existing.weight += edge.weight; }
    else { byKey.set(key, { source: edge.source, target: edge.target, kind: edge.kind, weight: edge.weight }); }
  }
  return [...byKey.values()].map((e) => ({
    id: `pdep:${e.kind}:${e.source}->${e.target}`,
    source: e.source,
    target: e.target,
    weight: e.weight,
    crossFrame: true, // always cross-package at this level
    category: "dep" as const,
    depKind: e.kind,
  }));
}

/** The Map's containment walk over packages/files/code — exported so the UI lens (deriveUiTree)
 * draws the identical card set over its renders-rooted frontier. */
export function walkContainment(index: GraphIndex, roots: string[], expanded: ReadonlySet<string>, flows: LogicFlows, hiddenIds: ReadonlySet<string>): CodeWalk {
  const walked = createCodeWalk();
  const ctx = { index, expanded, flows };
  const visit = (id: string, parentId: string | null, depth: number): void => {
    if (hiddenIds.has(id)) {
      return; // the Tests toggle EXCLUDES hidden subtrees from layout (testIds close over containment)
    }
    const graphNode = index.nodesById.get(id);
    if (graphNode?.kind === MODULE_KIND || (graphNode && (UNIT_CARD_KINDS.has(graphNode.kind) || BLOCK_KINDS.has(graphNode.kind)))) {
      visitCode(id, parentId, depth, ctx, walked);
      return;
    }
    if (walked.seen.has(id)) {
      return; // a parentId cycle (tolerated by the lenient viewer) must not spin forever.
    }
    walked.seen.add(id);
    if (subtreeFileCount(index, id) === 0) {
      return; // a directory owning no in-project files anywhere below is a useless "0 files" card.
    }
    const children = containmentChildren(index, id);
    const isContainer = children.length > 0;
    const isExpanded = isContainer && expanded.has(id);
    walked.skeleton.push({ id, parentId, kind: "package", isContainer, isExpanded, depth, childCount: children.length });
    if (isExpanded) {
      children.forEach((child) => visit(child, id, depth + 1));
    }
  };
  roots.forEach((id) => visit(id, null, 0));
  return walked;
}

function kindsOf(skeleton: Skeleton[]): Map<string, Skeleton["kind"]> {
  return new Map(skeleton.map((entry) => [entry.id, entry.kind]));
}
