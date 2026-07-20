/**
 * Shared file/decl/block/step subtree walk for Module-map surfaces. It was extracted so the Map tab
 * and the Service-composition lens cannot drift: when either surface opens a file or service member,
 * classes/interfaces/objects, member blocks, flow frames, step chains, and step call wires are emitted
 * by the same code with the same `moduleExpanded` set.
 */

import type { GraphNode, LogicFlows } from "@meridian/core";
import type { GraphIndex } from "../graph/graphIndex";
import { BLOCK_KINDS, CALLABLE_BLOCK_KINDS, constructionTarget, liftDepEdges, UNIT_CARD_KINDS, type BlockDeps } from "./blockDeps";
import { emitFlowSteps, type StepData } from "./flowSteps";
import { nearestVisible } from "./ghostDeps";
import { crossesPackageBoundary, underlyingEdgesCrossPackage } from "./packageBoundary";

const MODULE_KIND = "module";

export interface Skeleton {
  id: string;
  parentId: string | null;
  kind: "package" | "serviceDomain" | "file" | "unit" | "block" | "step";
  isContainer: boolean;
  isExpanded: boolean;
  depth: number;
  childCount: number;
}

/** The walk's full yield: the drawn skeletons plus everything the step level adds. */
export interface CodeWalk {
  skeleton: Skeleton[];
  /** View-only data for each drawn step pseudo-node, keyed by step id. */
  stepData: Map<string, StepData>;
  /** Execution-order wires between consecutive steps of each expanded block. */
  chains: Array<{ id: string; source: string; target: string }>;
  /** Resolved call steps and their artifact targets (for dep wires to visible definitions). */
  calls: Array<{ stepId: string; blockId: string; target: string }>;
  /** Blocks opened into flow frames — their own frame-level dep wires are superseded by step wires. */
  expandedBlocks: Set<string>;
  seen: Set<string>;
}

export interface CodeWalkContext {
  index: GraphIndex;
  expanded: ReadonlySet<string>;
  flows: LogicFlows;
}

export function createCodeWalk(): CodeWalk {
  return {
    skeleton: [],
    stepData: new Map<string, StepData>(),
    chains: [],
    calls: [],
    expandedBlocks: new Set<string>(),
    seen: new Set<string>(),
  };
}

export function visitCode(id: string, parentId: string | null, depth: number, ctx: CodeWalkContext, walk: CodeWalk): void {
  if (walk.seen.has(id)) {
    return;
  }
  walk.seen.add(id);
  const node = ctx.index.nodesById.get(id);
  if (node?.kind === MODULE_KIND) {
    visitFile(id, parentId, depth, ctx, walk);
    return;
  }
  if (node && UNIT_CARD_KINDS.has(node.kind)) {
    visitDecl(node, parentId, depth, ctx, walk);
    return;
  }
  visitBlock(id, parentId, depth, ctx, walk);
}

/** A file's drawn declarations — the code level a file card expands to. Source order. */
function declChildren(index: GraphIndex, fileId: string): GraphNode[] {
  return index.childrenOf(fileId).filter((child) => UNIT_CARD_KINDS.has(child.kind) || BLOCK_KINDS.has(child.kind));
}

/** A unit's drawn members: its callable/type children, each a block node inside the frame. */
function memberChildren(index: GraphIndex, unitId: string): GraphNode[] {
  return index.childrenOf(unitId).filter((child) => BLOCK_KINDS.has(child.kind));
}

function visitFile(id: string, parentId: string | null, depth: number, ctx: CodeWalkContext, walk: CodeWalk): void {
  const decls = declChildren(ctx.index, id);
  // A source file is an expandable entity even when extraction found no drawable declarations.
  // `childCount` stays honest; the renderer owns the shared empty-details presentation.
  const isExpanded = ctx.expanded.has(id);
  walk.skeleton.push({ id, parentId, kind: "file", isContainer: true, isExpanded, depth, childCount: decls.length });
  if (isExpanded) {
    decls.forEach((decl) => visitCode(decl.id, id, depth + 1, ctx, walk));
  }
}

/** Every class/interface/object can open as a frame of member blocks — methods are first-class
 * nodes, not rows on a card. Memberless units use the shared honest empty-details frame. */
function visitDecl(decl: GraphNode, parentId: string | null, depth: number, ctx: CodeWalkContext, walk: CodeWalk): void {
  const members = memberChildren(ctx.index, decl.id);
  const isExpanded = ctx.expanded.has(decl.id);
  walk.skeleton.push({ id: decl.id, parentId, kind: "unit", isContainer: true, isExpanded, depth, childCount: members.length });
  if (isExpanded) {
    members.forEach((member) => visitCode(member.id, decl.id, depth + 1, ctx, walk));
  }
}

/** Every callable block is expandable. A non-empty flow charts its steps in place; an empty,
 * computation-only or return-only callable becomes a frame with the shared honest empty state. */
function visitBlock(id: string, parentId: string | null, depth: number, ctx: CodeWalkContext, walk: CodeWalk): void {
  const node = ctx.index.nodesById.get(id);
  const flow = ctx.flows[id] ?? [];
  const isContainer = node !== undefined && CALLABLE_BLOCK_KINDS.has(node.kind);
  const isExpanded = isContainer && ctx.expanded.has(id);
  walk.skeleton.push({ id, parentId, kind: "block", isContainer, isExpanded, depth, childCount: flow.length });
  if (!isExpanded || flow.length === 0) {
    return;
  }
  walk.expandedBlocks.add(id);
  // The emission recurses into every step the reader expanded (nested step ids live in the same
  // `expanded` set), so a call step opens its callee's flow and a construct opens its body. Call
  // targets resolve constructions to the constructor block, whose flow (and drawn node) is real.
  const emission = emitFlowSteps(
    id,
    flow,
    ctx.flows,
    ctx.expanded,
    (target) => constructionTarget(target, ctx.index),
    (target) => ctx.index.nodesById.get(target),
  );
  emission.steps.forEach((step) => {
    walk.stepData.set(step.id, step.data);
    walk.skeleton.push({
      id: step.id,
      parentId: step.parentId,
      kind: "step",
      isContainer: step.data.isContainer,
      isExpanded: step.data.isExpanded,
      depth: depth + step.depth,
      childCount: 0,
    });
  });
  walk.chains.push(...emission.chain);
  walk.calls.push(...emission.calls);
}

/** Code-dependency wires projected onto the frontier — derived only when a code node (a unit frame
 * or a block) is on screen (the common no-code level skips the whole projection). */
export function depWireEdges(
  blockDeps: BlockDeps,
  visibleIds: ReadonlySet<string>,
  index: GraphIndex,
  isCode: (id: string) => boolean,
  expandedBlocks: ReadonlySet<string>,
) {
  if (![...visibleIds].some(isCode)) {
    return [];
  }
  return liftDepEdges(blockDeps, visibleIds, index, isCode)
    // An expanded block's calls chart as step wires — the folded frame-level wire would double-draw.
    .filter((edge) => !expandedBlocks.has(edge.source))
    .map((edge) => ({
      id: `dep:${edge.kind}:${edge.source}->${edge.target}`,
      source: edge.source,
      target: edge.target,
      weight: edge.weight,
      crossFrame: false,
      crossPackage: underlyingEdgesCrossPackage(edge.underlyingEdgeIds, index),
      outsideView: false,
      category: "dep" as const,
      relationKind: edge.kind,
      depKind: edge.kind,
      underlyingEdgeIds: edge.underlyingEdgeIds,
    }));
}

/** Execution-order wires between an expanded block's consecutive steps. */
export function flowChainEdges(walk: CodeWalk) {
  return walk.chains.map((chain) => ({
    id: chain.id,
    source: chain.source,
    target: chain.target,
    weight: 1,
    crossFrame: false,
    crossPackage: false,
    outsideView: false,
    category: "flow" as const,
  }));
}

/** A resolved call step's wire OUT to its target's drawn definition (dropped when the target lifts
 * back into the step's own block — a recursive call needs no wire to its own frame). Constructions
 * arrive already resolved to the constructor block (the emitter's resolveTarget). */
export function stepCallEdges(
  walk: { calls: ReadonlyArray<CodeWalk["calls"][number]> },
  visibleIds: ReadonlySet<string>,
  index: GraphIndex,
) {
  const edges = [];
  for (const call of walk.calls) {
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
      crossPackage: crossesPackageBoundary(call.blockId, call.target, index),
      outsideView: false,
      category: "dep" as const,
      relationKind: "calls",
      depKind: "calls",
    });
  }
  return edges;
}
