/** Place a minimal graph back into the cheapest canonical Map tree that can show all of it. */

import type { LogicFlows } from "@meridian/core";
import type { GraphIndex } from "../graph/graphIndex";
import { constructionTarget, type BlockDeps } from "./blockDeps";
import { emitFlowSteps } from "./flowSteps";
import type { ModuleGraph } from "./moduleGraph";
import { deriveModuleTree, type ModuleTree } from "./moduleTree";
import {
  minimalCodebaseExpandedPaths,
  minimalCodebaseFocusCandidates,
} from "./minimalCodebaseFocus";

const EMPTY_IDS: ReadonlySet<string> = new Set<string>();
const EMPTY_ROLLUPS: Readonly<Record<string, readonly string[]>> = {};

export interface MinimalCodebaseRevealState {
  moduleFocus: string | null;
  moduleExpanded: Set<string>;
  moduleSelected: Set<string>;
}

export interface DeriveMinimalCodebaseContextArgs {
  index: GraphIndex;
  moduleGraph: ModuleGraph;
  blockDeps: BlockDeps;
  flows: LogicFlows;
  /** The overlay's CURRENT curated members (not its immutable reset seeds). */
  minimalMemberIds: readonly string[];
  /** PR package rollups apply only while their package remains a member. */
  minimalRollups?: Readonly<Record<string, readonly string[]>>;
  hiddenIds?: ReadonlySet<string>;
  /** Flow/block disclosure already visible in the minimal graph. */
  expandedIds?: ReadonlySet<string>;
  /** Mirrors deriveModuleTree's hub-demotion switch. */
  demoteCommons?: boolean;
}

export interface MinimalCodebaseExpansionArgs {
  index: GraphIndex;
  moduleGraph: ModuleGraph;
  blockDeps: BlockDeps;
  flows: LogicFlows;
  hiddenIds?: ReadonlySet<string>;
  demoteCommons?: boolean;
}

export interface MinimalCodebaseContext {
  /** The ordinary Map tree, ready for layoutModuleTree. */
  tree: ModuleTree;
  /** Store-compatible reveal inputs used to derive `tree`. */
  reveal: MinimalCodebaseRevealState;
  /** Members after package-rollup substitution, first-seen and de-duplicated. */
  normalizedTargetIds: string[];
  /** Visible ids to emphasize: exact targets normally, or their deepest visible ancestor after a
   * local collapse. Every id is guaranteed to be a non-ghost node in `tree.nodes`. */
  highlightTargetIds: Set<string>;
  /** Unknown or Map-unrenderable normalized targets. */
  unresolvedTargetIds: Set<string>;
  /** Artifact anchor used for LCA/focus when a target is a synthetic `step:*` id. */
  targetAnchorIds: ReadonlyMap<string, string>;
  /** Canonical root-to-target path, including synthetic step parents absent from GraphIndex. */
  targetPathsById: ReadonlyMap<string, readonly string[]>;
}

interface CandidateContext {
  tree: ModuleTree;
  focus: string | null;
  expanded: Set<string>;
  visibleTargetIds: string[];
}

interface ResolvedTarget {
  id: string;
  anchorId: string;
  path: string[];
  expansionGates: string[];
}

/**
 * Derive the cheapest canonical Map level that can show every normalized minimal member. Unknown
 * ids are ignored best-effort; null means no member can be represented on the Map at all.
 */
export function deriveMinimalCodebaseContext(
  args: DeriveMinimalCodebaseContextArgs,
): MinimalCodebaseContext | null {
  const {
    index,
    moduleGraph,
    blockDeps,
    flows,
    minimalMemberIds,
    minimalRollups = EMPTY_ROLLUPS,
    hiddenIds = EMPTY_IDS,
    expandedIds = EMPTY_IDS,
    demoteCommons = true,
  } = args;
  const normalizedTargetIds = normalizeTargets(minimalMemberIds, minimalRollups);
  const resolvedTargets = resolveTargets(normalizedTargetIds, index, flows, expandedIds);
  if (resolvedTargets.length === 0) {
    return null;
  }

  const anchorIds = [...new Set(resolvedTargets.map((target) => target.anchorId))];
  const targetExpandedIds = new Set(expandedIds);
  resolvedTargets.forEach((target) => target.expansionGates.forEach((id) => targetExpandedIds.add(id)));
  const contextHiddenIds = hiddenOutsideTargetPaths(anchorIds, hiddenIds, index);
  const candidates = minimalCodebaseFocusCandidates(anchorIds, index);
  let best: CandidateContext | null = null;
  for (const focus of candidates) {
    const expanded = minimalCodebaseExpandedPaths(anchorIds, focus, index, targetExpandedIds);
    const tree = deriveModuleTree(
      index,
      focus,
      expanded,
      moduleGraph,
      blockDeps,
      flows,
      EMPTY_IDS,
      contextHiddenIds,
      demoteCommons,
    );
    const visibleIds = new Set(
      tree.nodes.filter((node) => node.kind !== "ghost").map((node) => node.id),
    );
    const visibleTargetIds = resolvedTargets
      .map((target) => target.id)
      .filter((id) => visibleIds.has(id));
    const candidate = { tree, focus, expanded, visibleTargetIds };
    if (best === null || visibleTargetIds.length > best.visibleTargetIds.length) {
      best = candidate;
    }
    // Candidates run deepest-to-widest, so the first complete one is the cheapest truthful level.
    if (visibleTargetIds.length === resolvedTargets.length) {
      best = candidate;
      break;
    }
  }

  if (best === null || best.visibleTargetIds.length === 0) {
    return null;
  }

  const highlightTargetIds = new Set(best.visibleTargetIds);
  const drawnIds = new Set(best.tree.nodes.map((node) => node.id));
  // An expansion gate absent from the final tree cannot affect disclosure. Removing it keeps the
  // returned state to exactly the visible ancestor paths (not ancestors above the chosen focus).
  const moduleExpanded = new Set([...best.expanded].filter((id) => drawnIds.has(id)));
  const targetAnchorIds = new Map(resolvedTargets.map((target) => [target.id, target.anchorId]));
  const targetPathsById = new Map(resolvedTargets.map((target) => [target.id, target.path]));
  return {
    tree: best.tree,
    reveal: {
      moduleFocus: best.focus,
      moduleExpanded,
      moduleSelected: new Set(highlightTargetIds),
    },
    normalizedTargetIds,
    highlightTargetIds,
    unresolvedTargetIds: new Set(normalizedTargetIds.filter((id) => !highlightTargetIds.has(id))),
    targetAnchorIds,
    targetPathsById,
  };
}

/** Apply view-local disclosure to an already-selected canonical context. The focus is deliberately
 * fixed: collapsing a highlighted path must not make the LCA search jump to a wider repository
 * level. These overrides are presentation state only and never enter the shared moduleExpanded set.
 *
 * A collapsed target remains locatable through its deepest visible ancestor. Availability is still
 * canonical, so hiding a known target does not misreport it as an unresolved extraction. */
export function applyMinimalCodebaseExpansionOverrides(
  context: MinimalCodebaseContext,
  args: MinimalCodebaseExpansionArgs,
  overrides: ReadonlyMap<string, boolean>,
): MinimalCodebaseContext {
  if (overrides.size === 0) {
    return context;
  }
  const expanded = new Set(context.reveal.moduleExpanded);
  for (const [id, isExpanded] of overrides) {
    if (isExpanded) {
      expanded.add(id);
    } else {
      expanded.delete(id);
    }
  }
  if (sameIds(expanded, context.reveal.moduleExpanded)) {
    return context;
  }

  const {
    index,
    moduleGraph,
    blockDeps,
    flows,
    hiddenIds = EMPTY_IDS,
    demoteCommons = true,
  } = args;
  const knownAnchorIds = [...new Set(context.targetAnchorIds.values())];
  const contextHiddenIds = hiddenOutsideTargetPaths(knownAnchorIds, hiddenIds, index);
  const tree = deriveModuleTree(
    index,
    context.reveal.moduleFocus,
    expanded,
    moduleGraph,
    blockDeps,
    flows,
    EMPTY_IDS,
    contextHiddenIds,
    demoteCommons,
  );
  const visibleIds = new Set(
    tree.nodes.filter((node) => node.kind !== "ghost").map((node) => node.id),
  );
  const canonicalTargets = context.normalizedTargetIds.filter(
    (id) => !context.unresolvedTargetIds.has(id),
  );
  const highlightTargetIds = new Set<string>();
  for (const targetId of canonicalTargets) {
    const representative = deepestVisibleTarget(
      targetId,
      visibleIds,
      index,
      context.targetPathsById,
    );
    if (representative !== null) {
      highlightTargetIds.add(representative);
    }
  }
  const drawnIds = new Set(tree.nodes.map((node) => node.id));
  const moduleExpanded = new Set([...expanded].filter((id) => drawnIds.has(id)));
  return {
    ...context,
    tree,
    reveal: {
      moduleFocus: context.reveal.moduleFocus,
      moduleExpanded,
      moduleSelected: new Set(highlightTargetIds),
    },
    highlightTargetIds,
  };
}

function deepestVisibleTarget(
  targetId: string,
  visibleIds: ReadonlySet<string>,
  index: GraphIndex,
  targetPathsById: ReadonlyMap<string, readonly string[]>,
): string | null {
  const path = targetPathsById.get(targetId)
    ?? index.ancestorsOf(targetId).map((node) => node.id);
  for (let position = path.length - 1; position >= 0; position -= 1) {
    if (visibleIds.has(path[position])) {
      return path[position];
    }
  }
  return null;
}

/** Resolve real artifacts directly and synthetic flow steps through the same emitter used by the
 * Map. The emitted parent chain gives a step a truthful artifact anchor without parsing recursive
 * `step:step:…` ids, so this remains valid at any nesting depth. */
function resolveTargets(
  targetIds: readonly string[],
  index: GraphIndex,
  flows: LogicFlows,
  expandedIds: ReadonlySet<string>,
): ResolvedTarget[] {
  const resolved = new Map<string, ResolvedTarget>();
  const pendingSteps = new Set<string>();
  for (const id of targetIds) {
    if (index.nodesById.has(id)) {
      resolved.set(id, {
        id,
        anchorId: id,
        path: index.ancestorsOf(id).map((node) => node.id),
        expansionGates: [],
      });
    } else if (id.startsWith("step:")) {
      pendingSteps.add(id);
    }
  }

  for (const [blockId, flow] of Object.entries(flows).sort(([left], [right]) => left.localeCompare(right))) {
    if (pendingSteps.size === 0 || !index.nodesById.has(blockId)) {
      continue;
    }
    const emission = emitFlowSteps(
      blockId,
      flow,
      flows,
      expandedIds,
      (target) => constructionTarget(target, index),
    );
    const stepsById = new Map(emission.steps.map((step) => [step.id, step]));
    for (const targetId of [...pendingSteps]) {
      if (!stepsById.has(targetId)) {
        continue;
      }
      const stepPath = syntheticStepPath(targetId, blockId, stepsById);
      if (stepPath === null) {
        continue;
      }
      const artifactPath = index.ancestorsOf(blockId).map((node) => node.id);
      resolved.set(targetId, {
        id: targetId,
        anchorId: blockId,
        path: [...artifactPath, ...stepPath.slice(1)],
        expansionGates: stepPath.slice(0, -1),
      });
      pendingSteps.delete(targetId);
    }
  }
  return targetIds.flatMap((id) => {
    const target = resolved.get(id);
    return target === undefined ? [] : [target];
  });
}

function syntheticStepPath(
  targetId: string,
  blockId: string,
  stepsById: ReadonlyMap<string, { parentId: string }>,
): string[] | null {
  const reversed = [targetId];
  const seen = new Set<string>();
  let current = targetId;
  while (!seen.has(current)) {
    seen.add(current);
    const parentId = stepsById.get(current)?.parentId;
    if (parentId === undefined) {
      return null;
    }
    if (parentId === blockId) {
      return [blockId, ...reversed.reverse()];
    }
    reversed.push(parentId);
    current = parentId;
  }
  return null;
}

function hiddenOutsideTargetPaths(
  knownTargetIds: readonly string[],
  hiddenIds: ReadonlySet<string>,
  index: GraphIndex,
): Set<string> {
  const targetPathIds = new Set(
    knownTargetIds.flatMap((id) => index.ancestorsOf(id).map((node) => node.id)),
  );
  return new Set([...hiddenIds].filter((id) => !targetPathIds.has(id)));
}

function sameIds(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every((id) => right.has(id));
}

function normalizeTargets(
  memberIds: readonly string[],
  rollups: Readonly<Record<string, readonly string[]>>,
): string[] {
  const targets: string[] = [];
  const seen = new Set<string>();
  for (const memberId of memberIds) {
    const rolledFiles = rollups[memberId];
    const replacements = rolledFiles && rolledFiles.length > 0 ? rolledFiles : [memberId];
    for (const id of replacements) {
      if (!seen.has(id)) {
        seen.add(id);
        targets.push(id);
      }
    }
  }
  return targets;
}
