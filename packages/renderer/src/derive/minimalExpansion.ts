/**
 * One expanded file's code subtree for the minimal-graph overlay, in the Module-map's OWN
 * VisibleModuleNode + edge shapes — so an expanded file card can be sized and nested by the Map's
 * exact per-file ELK pass (`layoutModuleTree`) rather than a parallel nesting layout. It reuses the
 * shared `codeWalk` (visitFile/visitCode) + edge helpers, so the overlay and the Map cannot drift on
 * what a file expands into. Edges are kept STRICTLY intra-file (both endpoints inside this file's
 * subtree); cross-file dependency wires would dangle at a frame nobody drew here. Pure; no React.
 */

import type { LogicFlows } from "@meridian/core";
import type { GraphIndex } from "../graph/graphIndex";
import type { ModuleGraph } from "./moduleGraph";
import { constructionTarget, type BlockDeps } from "./blockDeps";
import { createCodeWalk, depWireEdges, flowChainEdges, stepCallEdges, visitCode, type Skeleton } from "./codeWalk";
import { emitFlowSteps, type StepEmission } from "./flowSteps";
import { finalizeModuleNode } from "./moduleTreeData";
import type { ModulePackageData } from "./packageOverview";
import type { ModuleTreeEdge, VisibleModuleNode } from "./moduleTreeTypes";

/** One expanded file's drawn subtree: the file frame node first (parents-before-children), its
 * nested unit/block/step cards, and their intra-file dep/flow/step wires. Ready for `layoutModuleTree`. */
export interface MinimalExpansion {
  fileId: string;
  /** Owning artifact callable for a synthetic `step:*` root; absent for real artifact roots. */
  artifactOwnerId?: string;
  nodes: VisibleModuleNode[];
  edges: ModuleTreeEdge[];
}

export interface ResolvedFlowStep {
  artifactOwnerId: string;
  emission: StepEmission;
  step: StepEmission["steps"][number];
}

/** The file card's container facts (for the flat card's chevron) plus, when it is expanded, its
 * drawn code subtree. A collapsed file yields `expansion: null`; an expanded source-only file
 * yields the same one-node empty-details frame as the Map. `calls` and
 * `expandedBlocks` surface the walk's step-call/expansion facts for the overlay's GHOST projection —
 * the same inputs `moduleTree` feeds `ghostDepWires` from its own walk (empty while collapsed). */
export interface FileCodeWalk {
  isContainer: boolean;
  isExpanded: boolean;
  unitCount: number;
  expansion: MinimalExpansion | null;
  /** Keep the original owning block so a synthetic step-call wire can still resolve package scope. */
  calls: ReadonlyArray<{ stepId: string; blockId: string; target: string }>;
  expandedBlocks: ReadonlySet<string>;
}

const NO_IMPORT_FOLD = new Map<string, ModulePackageData>();

/** Walk one file's code the way the Map does, for the SAME `expanded` set. Returns the card's
 * container affordance always, and its nested subtree only when the file is actually expanded. */
export function walkFileCode(
  fileId: string,
  index: GraphIndex,
  graph: ModuleGraph,
  expanded: ReadonlySet<string>,
  blockDeps: BlockDeps,
  flows: LogicFlows,
): FileCodeWalk {
  const walk = createCodeWalk();
  visitCode(fileId, null, 0, { index, expanded, flows }, walk);
  const fileEntry = walk.skeleton.find((entry) => entry.id === fileId);
  if (!fileEntry) {
    return { isContainer: false, isExpanded: false, unitCount: 0, expansion: null, calls: [], expandedBlocks: new Set() };
  }
  const facts = { isContainer: fileEntry.isContainer, isExpanded: fileEntry.isExpanded, unitCount: fileEntry.childCount, calls: walk.calls, expandedBlocks: walk.expandedBlocks };
  if (!fileEntry.isExpanded) {
    return { ...facts, expansion: null };
  }
  return { ...facts, expansion: assembleExpansion(fileId, walk.skeleton, walk, index, graph, blockDeps) };
}

/** Materialize one real declaration as an exact top-level Map card. Unlike a file, a declaration
 * needs its one-node expansion even while collapsed: the minimal graph must render a selected class
 * as a `unit` and a selected callable as a `block`, never as a package-summary placeholder. */
export function walkCodeRoot(
  rootId: string,
  index: GraphIndex,
  graph: ModuleGraph,
  expanded: ReadonlySet<string>,
  blockDeps: BlockDeps,
  flows: LogicFlows,
): FileCodeWalk | null {
  const walk = createCodeWalk();
  visitCode(rootId, null, 0, { index, expanded, flows }, walk);
  const root = walk.skeleton[0];
  if (root?.id !== rootId || (root.kind !== "unit" && root.kind !== "block")) {
    return null;
  }
  return {
    isContainer: root.isContainer,
    isExpanded: root.isExpanded,
    unitCount: root.childCount,
    expansion: assembleExpansion(rootId, walk.skeleton, walk, index, graph, blockDeps),
    calls: walk.calls,
    expandedBlocks: walk.expandedBlocks,
  };
}

/** Reconstruct a selected view-only flow step from the same emitter that drew it on its parent
 * graph. Step ids deliberately do not enter GraphIndex, so resolving against the visible expanded
 * flow forest is the only truthful way to retain the step's kind, label, and nested disclosure. */
export function walkFlowStepRoot(
  rootId: string,
  index: GraphIndex,
  graph: ModuleGraph,
  expanded: ReadonlySet<string>,
  blockDeps: BlockDeps,
  flows: LogicFlows,
): FileCodeWalk | null {
  const resolved = resolveFlowStep(rootId, index, expanded, flows);
  if (resolved === null) {
    return null;
  }
  const { artifactOwnerId, emission, step: root } = resolved;

  // Emission is parents-before-children. One forward pass therefore captures the selected step's
  // complete currently-disclosed subtree without parsing the intentionally recursive step id.
  const retained = new Set([rootId]);
  for (const step of emission.steps) {
    if (retained.has(step.parentId)) {
      retained.add(step.id);
    }
  }
  const walk = createCodeWalk();
  walk.skeleton = emission.steps
    .filter((step) => retained.has(step.id))
    .map((step) => ({
      id: step.id,
      parentId: step.id === rootId ? null : step.parentId,
      kind: "step" as const,
      isContainer: step.data.isContainer,
      isExpanded: step.data.isExpanded,
      depth: step.depth - root.depth,
      childCount: 0,
    }));
  emission.steps
    .filter((step) => retained.has(step.id))
    .forEach((step) => walk.stepData.set(step.id, step.data));
  walk.chains = emission.chain.filter((edge) => retained.has(edge.source) && retained.has(edge.target));
  walk.calls = emission.calls.filter((call) => retained.has(call.stepId));
  walk.seen = new Set(retained);
  return {
    isContainer: root.data.isContainer,
    isExpanded: root.data.isExpanded,
    unitCount: 0,
    expansion: {
      ...assembleExpansion(rootId, walk.skeleton, walk, index, graph, blockDeps),
      artifactOwnerId,
    },
    calls: walk.calls,
    expandedBlocks: walk.expandedBlocks,
  };
}

/** Resolve a recursively nested synthetic step through the canonical emitted flow forest. The
 * artifact owner is explicit output, so callers never need to parse ids whose owner may itself be a
 * `step:*` path. */
export function resolveFlowStep(
  rootId: string,
  index: GraphIndex,
  expanded: ReadonlySet<string>,
  flows: LogicFlows,
): ResolvedFlowStep | null {
  if (!rootId.startsWith("step:")) {
    return null;
  }
  for (const [blockId, flow] of Object.entries(flows).sort(([left], [right]) => left.localeCompare(right))) {
    const emission = emitFlowSteps(
      blockId,
      flow,
      flows,
      expanded,
      (target) => constructionTarget(target, index),
    );
    const step = emission.steps.find((candidate) => candidate.id === rootId);
    if (step !== undefined) {
      return { artifactOwnerId: blockId, emission, step };
    }
  }
  return null;
}

/** Recover execution-order wires whose endpoints are visible but owned by different extracted
 * roots. A per-root step walk deliberately keeps only that root's subtree, so two selected sibling
 * steps otherwise become truthful cards with their connecting chain silently missing. Re-emitting
 * the shared flow forest lets the outer minimal layout keep cross-root chains while suppressing the
 * copies already owned by one expansion. */
export function visibleFlowChainEdges(
  visibleIds: ReadonlySet<string>,
  index: GraphIndex,
  expanded: ReadonlySet<string>,
  flows: LogicFlows,
): ModuleTreeEdge[] {
  if (![...visibleIds].some((id) => id.startsWith("step:"))) {
    return [];
  }
  const edges = new Map<string, ModuleTreeEdge>();
  for (const [blockId, flow] of Object.entries(flows).sort(([left], [right]) => left.localeCompare(right))) {
    const emission = emitFlowSteps(
      blockId,
      flow,
      flows,
      expanded,
      (target) => constructionTarget(target, index),
    );
    for (const chain of emission.chain) {
      if (!visibleIds.has(chain.source) || !visibleIds.has(chain.target)) {
        continue;
      }
      edges.set(chain.id, {
        ...chain,
        weight: 1,
        crossFrame: false,
        crossPackage: false,
        outsideView: false,
        category: "flow",
      });
    }
  }
  return [...edges.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function assembleExpansion(
  fileId: string,
  skeleton: Skeleton[],
  walk: ReturnType<typeof createCodeWalk>,
  index: GraphIndex,
  graph: ModuleGraph,
  blockDeps: BlockDeps,
): MinimalExpansion {
  const visibleIds = new Set(skeleton.map((entry) => entry.id));
  const kinds = new Map(skeleton.map((entry) => [entry.id, entry.kind]));
  const isCode = (id: string) => kinds.get(id) === "unit" || kinds.get(id) === "block";
  const nodes = skeleton.map((entry) => finalizeModuleNode(entry, index, graph, [], walk.stepData, NO_IMPORT_FOLD));
  const edges = [
    ...depWireEdges(blockDeps, visibleIds, index, isCode, walk.expandedBlocks),
    ...flowChainEdges(walk),
    ...stepCallEdges(walk, visibleIds, index),
  ]
    .filter((edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target))
    .sort((a, b) => a.id.localeCompare(b.id));
  return { fileId, nodes, edges };
}
