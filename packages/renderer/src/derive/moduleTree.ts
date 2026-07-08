/**
 * The Map lens's INLINE-EXPANDABLE containment tree, wired by the import graph lifted to the
 * visible frontier. Unlike the old flat one-level fold, this walks the real `parentId` hierarchy
 * from the current focus and emits a NESTED set: a group card that the reader expanded yields its
 * children as `parentId`-nested nodes, exactly like the logic-flow tab.
 *
 *   - `focus === null` → the whole-repo overview: npm packages that own at least one file.
 *   - a `focus` package/dir → its children, after chain-collapsing a lone `src`.
 *   - a FILE card expands through `codeWalk`: classes/interfaces/objects become unit frames,
 *     methods/functions/types become block cards, and flow-bearing blocks can unroll into steps.
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
import { type BlockDeps } from "./blockDeps";
import { ghostDepWires } from "./ghostDeps";
import { liftEdges } from "./liftEdges";
import { createCodeWalk, depWireEdges, flowChainEdges, stepCallEdges, visitCode, type CodeWalk, type Skeleton } from "./codeWalk";
import { finalizeModuleNode, foldById, importEdges, importTreeEdges } from "./moduleTreeData";
import type { ModuleTree, ModuleTreeEdge, VisibleModuleNode } from "./moduleTreeTypes";
export type { ModuleGroupData, ModuleTree, ModuleTreeEdge, VisibleModuleNode } from "./moduleTreeTypes";

const MODULE_KIND = "module";

/** The containment tree to draw for `(focus, expanded)`: overview when null, else the focus subtree.
 * Private members are ALWAYS derived and laid out — the Private toggle hides them at PAINT time
 * (like Tests/categories), so every toggle holds positions still and nothing ever reshuffles. */
export function deriveModuleTree(
  index: GraphIndex,
  focus: string | null,
  expanded: ReadonlySet<string>,
  graph: ModuleGraph,
  blockDeps: BlockDeps,
  flows: LogicFlows,
): ModuleTree {
  const effectiveFocus = focus === null ? null : collapseChain(index, focus);
  const roots = frontierRoots(index, effectiveFocus, graph);
  const walked = walk(index, roots, expanded, flows);
  const skeleton = walked.skeleton;
  const visibleIds = new Set(skeleton.map((entry) => entry.id));
  const lifted = liftEdges(importEdges(graph), visibleIds, index.parentOf);
  // At the repo overview, root package cards wear the OWNERSHIP-fold numbers (each file counts once,
  // toward its nearest npm package) so nested packages never double-count — main's dedicated
  // package-overview fold, kept through the expandable walk.
  const overviewFold = effectiveFocus === null ? foldById(index) : new Map<string, ModulePackageData>();
  const nodes = skeleton.map((entry) => finalizeModuleNode(entry, index, graph, lifted, walked.stepData, overviewFold));
  const kinds = kindsOf(skeleton);
  const ghosts = ghostLevel(blockDeps, walked, visibleIds, index, kinds);
  const isCode = (id: string) => kinds.get(id) === "unit" || kinds.get(id) === "block";
  const edges = [
    ...importTreeEdges(lifted, kinds),
    // An expanded block's calls chart as step wires in codeWalk — its folded frame-level dependency
    // wire would double-draw the same relationship, so depWireEdges receives expandedBlocks.
    ...depWireEdges(blockDeps, visibleIds, index, isCode, walked.expandedBlocks),
    ...flowChainEdges(walked),
    // Step call targets resolve constructions to the constructor block, and recursive calls drop
    // when the target lifts back into their own block frame.
    ...stepCallEdges(walked, visibleIds, index),
    ...ghosts.edges,
  ].sort((a, b) => a.id.localeCompare(b.id));
  return { nodes: [...nodes, ...ghosts.nodes], edges, effectiveFocus };
}

/** Off-screen relationships charted as detached GHOST cards + dashed wires — derived only when a
 * code node is drawn (the ghosts tell the CODE level's story; file levels keep the import graph). */
function ghostLevel(
  blockDeps: BlockDeps,
  walked: CodeWalk,
  visibleIds: ReadonlySet<string>,
  index: GraphIndex,
  kinds: Map<string, Skeleton["kind"]>,
): { nodes: VisibleModuleNode[]; edges: ModuleTreeEdge[] } {
  const isCode = (id: string) => kinds.get(id) === "unit" || kinds.get(id) === "block";
  if (![...kinds.values()].some((kind) => kind === "unit" || kind === "block")) {
    return { nodes: [], edges: [] };
  }
  const emission = ghostDepWires(blockDeps, walked.calls, visibleIds, index, isCode, walked.expandedBlocks);
  const nodes: VisibleModuleNode[] = [...emission.ghosts.entries()].map(([id, data]) => ({
    id,
    parentId: null,
    kind: "ghost",
    isContainer: false,
    isExpanded: false,
    depth: 0,
    childCount: 0,
    data,
  }));
  const edges: ModuleTreeEdge[] = emission.wires.map((wire) => ({
    id: `gdep:${wire.source}->${wire.target}`,
    source: wire.source,
    target: wire.target,
    weight: wire.weight,
    crossFrame: false,
    category: "dep",
    ghost: true,
  }));
  return { nodes, edges };
}

function walk(index: GraphIndex, roots: string[], expanded: ReadonlySet<string>, flows: LogicFlows): CodeWalk {
  const walked = createCodeWalk();
  const ctx = { index, expanded, flows };
  const visit = (id: string, parentId: string | null, depth: number): void => {
    if (index.nodesById.get(id)?.kind === MODULE_KIND) {
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
