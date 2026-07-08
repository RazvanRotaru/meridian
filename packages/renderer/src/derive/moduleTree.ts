/**
 * The Map lens's INLINE-EXPANDABLE containment tree, wired by the import graph lifted to the
 * visible frontier. Unlike the old flat one-level fold, this walks the real `parentId` hierarchy
 * from the current focus and emits a NESTED set: a group card that the reader expanded (its id is
 * in `expanded`) yields its children as `parentId`-nested nodes, exactly like the logic-flow tab.
 *
 *   - `focus === null` → the whole-repo overview: the npm packages that own ≥1 file, as top-level
 *     group cards (collapsed → the package graph; expand one to descend into its directories/files).
 *   - a `focus` package/dir → its children (after chain-collapsing a lone `src`), each expandable.
 *   - a FILE card holding declarations expands into the CODE level (the merged Service-composition
 *     level of the Map): a class/interface/object becomes a unit card that can expand into a frame
 *     for its method nodes; file-level functions and type definitions sit beside it as BLOCK nodes.
 *
 * Imports are folded to the visible boxes by `liftEdges`: a collapsed group swallows its internal
 * imports (self-loops, dropped) and an import leaving the drawn subtree lifts past the frontier and
 * drops — so a level shows only the coupling between what is currently on screen. Code-dependency
 * wires (calls/instantiates/extends/implements at their REAL endpoints) join the edge set whenever
 * a code node is drawn, so a wire starts at the specific block that uses the dependency and points
 * at wherever its definition lives on screen. Pure; no React, no ELK.
 */

import type { GraphEdge, GraphNode, LogicFlows } from "@meridian/core";
import type { GraphIndex } from "../graph/graphIndex";
import { npmPackageIdOf } from "./compositionClusters";
import { derivePackageOverview, packageEntryModule, type ModulePackageData } from "./packageOverview";
import { weightKey, type ModuleGraph } from "./moduleGraph";
import { basename, blockData, collapseChain, fileData, unitData, type BlockData, type ModuleCardData, type UnitCardData } from "./moduleLevel";
import { containmentChildren, frontierRoots, subtreeFileCount } from "./moduleFrontier";
import { BLOCK_KINDS, constructionTarget, liftDepEdges, UNIT_CARD_KINDS, type BlockDeps } from "./blockDeps";
import { emitFlowSteps, type StepData } from "./flowSteps";
import { ghostDepWires, nearestVisible, type GhostData } from "./ghostDeps";
import { liftEdges } from "./liftEdges";

const MODULE_KIND = "module";

/** A group card carries its expansion state so the card can draw a chevron and open into a frame. */
export type ModuleGroupData = ModulePackageData & { isContainer: boolean; isExpanded: boolean };

/** One node in the drawn containment tree, in DFS preorder (parents BEFORE children — React Flow
 * requires a parent to appear first). `parentId` is the drawn parent (null at the frontier root). */
export interface VisibleModuleNode {
  id: string;
  parentId: string | null;
  kind: "package" | "file" | "unit" | "block" | "step" | "ghost";
  isContainer: boolean;
  isExpanded: boolean;
  depth: number;
  childCount: number;
  data: ModuleGroupData | ModuleCardData | UnitCardData | BlockData | StepData | GhostData;
}

/** A wire between two visible nodes. `category` "import" is the file/package import graph;
 * "dep" is a code-dependency wire (it touches at least one drawn unit card/frame or block).
 * `crossFrame` = a group is involved (coupling gold). */
export interface ModuleTreeEdge {
  id: string;
  source: string;
  target: string;
  weight: number;
  crossFrame: boolean;
  category: "import" | "dep" | "flow";
  /** The far endpoint is a GHOST card (an off-screen definition/caller) — drawn dashed. */
  ghost?: boolean;
}

export interface ModuleTree {
  nodes: VisibleModuleNode[];
  edges: ModuleTreeEdge[];
  /** The node actually descended into after chain-collapse; null == the repo-level overview. */
  effectiveFocus: string | null;
}

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
  const nodes = skeleton.map((entry) => finalize(entry, index, graph, lifted, walked.stepData, overviewFold));
  const kinds = kindsOf(skeleton);
  const ghosts = ghostLevel(blockDeps, walked, visibleIds, index, kinds);
  const edges = [
    ...importTreeEdges(lifted, kinds),
    ...depTreeEdges(blockDeps, visibleIds, index, kinds, walked.expandedBlocks),
    ...flowChainEdges(walked),
    ...stepCallEdges(walked, visibleIds, index),
    ...ghosts.edges,
  ].sort((a, b) => a.id.localeCompare(b.id));
  return { nodes: [...nodes, ...ghosts.nodes], edges, effectiveFocus };
}

/** Off-screen relationships charted as detached GHOST cards + dashed wires — derived only when a
 * code node is drawn (the ghosts tell the CODE level's story; file levels keep the import graph). */
function ghostLevel(
  blockDeps: BlockDeps,
  walked: WalkResult,
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

/** A file's drawn declarations — the code level a file card expands to. Source order. */
function declChildren(index: GraphIndex, fileId: string): GraphNode[] {
  return index.childrenOf(fileId).filter((child) => UNIT_CARD_KINDS.has(child.kind) || BLOCK_KINDS.has(child.kind));
}

/** A unit's drawn members: its callable/type children, each a block node inside the frame. */
function memberChildren(index: GraphIndex, unitId: string): GraphNode[] {
  return index.childrenOf(unitId).filter((child) => BLOCK_KINDS.has(child.kind));
}

interface Skeleton {
  id: string;
  parentId: string | null;
  kind: "package" | "file" | "unit" | "block" | "step";
  isContainer: boolean;
  isExpanded: boolean;
  depth: number;
  childCount: number;
}

/** The walk's full yield: the drawn skeletons plus everything the step level adds. */
interface WalkResult {
  skeleton: Skeleton[];
  /** View-only data for each drawn step pseudo-node, keyed by step id. */
  stepData: Map<string, StepData>;
  /** Execution-order wires between consecutive steps of each expanded block. */
  chains: Array<{ id: string; source: string; target: string }>;
  /** Resolved call steps and their artifact targets (for dep wires to visible definitions). */
  calls: Array<{ stepId: string; blockId: string; target: string }>;
  /** Blocks opened into flow frames — their own frame-level dep wires are superseded by step wires. */
  expandedBlocks: Set<string>;
}

/** DFS preorder over the containment tree; a group/file descends only when it is in `expanded`. */
function walk(index: GraphIndex, roots: string[], expanded: ReadonlySet<string>, flows: LogicFlows): WalkResult {
  const out: Skeleton[] = [];
  const stepData = new Map<string, StepData>();
  const chains: WalkResult["chains"] = [];
  const calls: WalkResult["calls"] = [];
  const expandedBlocks = new Set<string>();
  const seen = new Set<string>();
  const visit = (id: string, parentId: string | null, depth: number): void => {
    if (seen.has(id)) {
      return; // a parentId cycle (tolerated by the lenient viewer) must not spin forever.
    }
    seen.add(id);
    const graphNode = index.nodesById.get(id);
    if (graphNode?.kind === MODULE_KIND) {
      visitFile(id, parentId, depth);
      return;
    }
    if (graphNode && (UNIT_CARD_KINDS.has(graphNode.kind) || BLOCK_KINDS.has(graphNode.kind))) {
      visitDecl(graphNode, parentId, depth);
      return;
    }
    if (subtreeFileCount(index, id) === 0) {
      return; // a directory owning no in-project files anywhere below is a useless "0 files" card.
    }
    const children = containmentChildren(index, id);
    const isContainer = children.length > 0;
    const isExpanded = isContainer && expanded.has(id);
    out.push({ id, parentId, kind: "package", isContainer, isExpanded, depth, childCount: children.length });
    if (isExpanded) {
      children.forEach((child) => visit(child, id, depth + 1));
    }
  };
  const visitFile = (id: string, parentId: string | null, depth: number): void => {
    const decls = declChildren(index, id);
    const isContainer = decls.length > 0;
    const isExpanded = isContainer && expanded.has(id);
    out.push({ id, parentId, kind: "file", isContainer, isExpanded, depth, childCount: decls.length });
    if (isExpanded) {
      decls.forEach((decl) => visitDecl(decl, id, depth + 1));
    }
  };
  // A unit with members is a real container: collapsed it is a card, expanded it frames its member
  // blocks. Memberless units and file-level functions/types remain leaf cards/blocks.
  const visitDecl = (decl: GraphNode, parentId: string | null, depth: number): void => {
    seen.add(decl.id);
    if (!UNIT_CARD_KINDS.has(decl.kind)) {
      visitBlock(decl.id, parentId, depth);
      return;
    }
    const members = memberChildren(index, decl.id);
    const isContainer = members.length > 0;
    const isExpanded = isContainer && expanded.has(decl.id);
    out.push({ id: decl.id, parentId, kind: "unit", isContainer, isExpanded, depth, childCount: members.length });
    if (isExpanded) {
      members.forEach((member) => {
        seen.add(member.id);
        visitBlock(member.id, decl.id, depth + 1);
      });
    }
  };
  // POC — a callable block WITH a logic flow is itself expandable: opening it turns the block into
  // a frame whose top-level flow steps chart in place, chained by execution wires.
  const visitBlock = (id: string, parentId: string | null, depth: number): void => {
    const flow = flows[id];
    const isContainer = (flow?.length ?? 0) > 0;
    const isExpanded = isContainer && expanded.has(id);
    out.push({ id, parentId, kind: "block", isContainer, isExpanded, depth, childCount: flow?.length ?? 0 });
    if (!isExpanded || !flow) {
      return;
    }
    expandedBlocks.add(id);
    // The emission recurses into every step the reader expanded (nested step ids live in the same
    // `expanded` set), so a call step opens its callee's flow and a construct opens its body. Call
    // targets resolve constructions to the constructor block, whose flow (and drawn node) is real.
    const emission = emitFlowSteps(id, flow, flows, expanded, (target) => constructionTarget(target, index));
    emission.steps.forEach((step) => {
      stepData.set(step.id, step.data);
      out.push({
        id: step.id,
        parentId: step.parentId,
        kind: "step",
        isContainer: step.data.isContainer,
        isExpanded: step.data.isExpanded,
        depth: depth + step.depth,
        childCount: 0,
      });
    });
    chains.push(...emission.chain);
    emission.calls.forEach((call) => calls.push({ stepId: call.stepId, blockId: id, target: call.target }));
  };
  roots.forEach((id) => visit(id, null, 0));
  return { skeleton: out, stepData, chains, calls, expandedBlocks };
}

/** Attach the card data each drawn node needs: file cards from the import graph, group cards from
 * the subtree file tally and the lifted-edge frontier degree (Ca/Ce among what is on screen),
 * unit cards/frames and code blocks from their identity (name + kind — deps are the wires' story). */
function finalize(
  entry: Skeleton,
  index: GraphIndex,
  graph: ModuleGraph,
  lifted: ReturnType<typeof liftEdges>,
  stepData: ReadonlyMap<string, StepData>,
  overviewFold: ReadonlyMap<string, ModulePackageData>,
): VisibleModuleNode {
  const data =
    entry.kind === "step"
      ? (stepData.get(entry.id) as StepData)
      : entry.kind === "block"
      ? blockData(entry.id, index, { hasFlow: entry.isContainer, isExpanded: entry.isExpanded })
      : entry.kind === "unit"
      ? unitData(entry.id, index, {
          memberCount: entry.childCount,
          isContainer: entry.isContainer,
          isExpanded: entry.isExpanded,
        })
      : entry.kind === "file"
        ? fileData(entry.id, graph, index, entryFor(entry.id, index), {
            isContainer: entry.isContainer,
            isExpanded: entry.isExpanded,
            unitCount: entry.childCount,
          })
        : groupData(entry, index, subtreeFileCount(index, entry.id), lifted, overviewFold);
  return { ...entry, data };
}

/** The blast-radius entry module of the file's owning package (for the ENTRY badge on the card). */
function entryFor(fileId: string, index: GraphIndex): string | null {
  return packageEntryModule(index, npmPackageIdOf(fileId, index.nodesById) ?? fileId);
}

function groupData(
  entry: Skeleton,
  index: GraphIndex,
  fileCount: number,
  lifted: ReturnType<typeof liftEdges>,
  overviewFold: ReadonlyMap<string, ModulePackageData>,
): ModuleGroupData {
  const fold = overviewFold.get(entry.id);
  if (fold) {
    return { ...fold, isContainer: entry.isContainer, isExpanded: entry.isExpanded };
  }
  const label = index.nodesById.get(entry.id)?.displayName ?? basename(entry.id);
  return {
    label,
    fileCount,
    ce: distinctNeighbours(lifted, entry.id, "source"),
    ca: distinctNeighbours(lifted, entry.id, "target"),
    isContainer: entry.isContainer,
    isExpanded: entry.isExpanded,
  };
}

/** Overview-fold card data per npm package id (empty when the artifact has none — the topmost-dir
 * fallback roots keep the lifted-edge numbers). */
function foldById(index: GraphIndex): Map<string, ModulePackageData> {
  return new Map(derivePackageOverview(index).nodes.map((node) => [node.id, node.data]));
}

/** Distinct frontier nodes this node imports (`source`) or is imported by (`target`) after lifting. */
function distinctNeighbours(lifted: ReturnType<typeof liftEdges>, id: string, role: "source" | "target"): number {
  const other = role === "source" ? "target" : "source";
  const neighbours = new Set<string>();
  for (const edge of lifted) {
    if (edge[role] === id) {
      neighbours.add(edge[other]);
    }
  }
  return neighbours.size;
}

/** The file-to-file import graph as synthetic resolved `imports` edges, ready for `liftEdges`. */
function importEdges(graph: ModuleGraph): GraphEdge[] {
  const edges: GraphEdge[] = [];
  for (const [source, targets] of graph.out) {
    for (const target of targets) {
      const key = weightKey(source, target);
      edges.push({ id: `mimp:${key}`, source, target, kind: "imports", resolution: "resolved", weight: graph.weight.get(key) ?? 1 } as GraphEdge);
    }
  }
  return edges;
}

function kindsOf(skeleton: Skeleton[]): Map<string, Skeleton["kind"]> {
  return new Map(skeleton.map((entry) => [entry.id, entry.kind]));
}

/** Lifted import wires as level edges, flagged crossFrame when either endpoint is a group card. */
function importTreeEdges(lifted: ReturnType<typeof liftEdges>, kinds: Map<string, Skeleton["kind"]>): ModuleTreeEdge[] {
  return lifted.map((edge) => ({
    id: `lvl:${edge.source}->${edge.target}`,
    source: edge.source,
    target: edge.target,
    weight: edge.weight,
    crossFrame: kinds.get(edge.source) === "package" || kinds.get(edge.target) === "package",
    category: "import" as const,
  }));
}

/** Code-dependency wires projected onto the frontier — derived only when a code node (a unit card,
 * unit frame, or block) is on screen (the common no-code level skips the whole projection). */
function depTreeEdges(
  blockDeps: BlockDeps,
  visibleIds: ReadonlySet<string>,
  index: GraphIndex,
  kinds: Map<string, Skeleton["kind"]>,
  expandedBlocks: ReadonlySet<string>,
): ModuleTreeEdge[] {
  const isCode = (id: string) => kinds.get(id) === "unit" || kinds.get(id) === "block";
  if (![...kinds.values()].some((kind) => kind === "unit" || kind === "block")) {
    return [];
  }
  return liftDepEdges(blockDeps, visibleIds, index, isCode)
    // An expanded block's calls chart as step wires — the folded frame-level wire would double-draw.
    .filter((edge) => !expandedBlocks.has(edge.source))
    .map((edge) => ({
      id: `dep:${edge.source}->${edge.target}`,
      source: edge.source,
      target: edge.target,
      weight: edge.weight,
      crossFrame: false,
      category: "dep" as const,
    }));
}

/** Execution-order wires between an expanded block's consecutive steps. */
function flowChainEdges(walked: WalkResult): ModuleTreeEdge[] {
  return walked.chains.map((chain) => ({
    id: chain.id,
    source: chain.source,
    target: chain.target,
    weight: 1,
    crossFrame: false,
    category: "flow" as const,
  }));
}

/** A resolved call step's wire OUT to its target's drawn definition (dropped when the target lifts
 * back into the step's own block — a recursive call needs no wire to its own frame). Constructions
 * arrive already resolved to the constructor block (the emitter's resolveTarget). */
function stepCallEdges(walked: WalkResult, visibleIds: ReadonlySet<string>, index: GraphIndex): ModuleTreeEdge[] {
  const edges: ModuleTreeEdge[] = [];
  for (const call of walked.calls) {
    const target = nearestVisible(call.target, visibleIds, index);
    if (target === null || target === call.blockId || index.isWithinFocus(target, call.blockId)) {
      continue;
    }
    edges.push({
      id: `dep:${call.stepId}->${target}`,
      source: call.stepId,
      target,
      weight: 1,
      crossFrame: false,
      category: "dep" as const,
    });
  }
  return edges;
}
