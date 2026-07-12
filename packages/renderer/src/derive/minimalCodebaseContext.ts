/** Place a minimal graph back into the cheapest canonical Map tree that can show all of it. */

import type { LogicFlows } from "@meridian/core";
import type { GraphIndex } from "../graph/graphIndex";
import type { BlockDeps } from "./blockDeps";
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

export interface MinimalCodebaseContext {
  /** The ordinary Map tree, ready for layoutModuleTree. */
  tree: ModuleTree;
  /** Store-compatible reveal inputs used to derive `tree`. */
  reveal: MinimalCodebaseRevealState;
  /** Members after package-rollup substitution, first-seen and de-duplicated. */
  normalizedTargetIds: string[];
  /** Exact ids to emphasize. Every id is guaranteed to be a non-ghost node in `tree.nodes`. */
  highlightTargetIds: Set<string>;
  /** Unknown or Map-unrenderable normalized targets. */
  unresolvedTargetIds: Set<string>;
}

interface CandidateContext {
  tree: ModuleTree;
  focus: string | null;
  expanded: Set<string>;
  visibleTargetIds: string[];
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
  const knownTargetIds = normalizedTargetIds.filter((id) => index.nodesById.has(id));
  if (knownTargetIds.length === 0) {
    return null;
  }

  const targetPathIds = new Set(knownTargetIds.flatMap((id) => index.ancestorsOf(id).map((node) => node.id)));
  const contextHiddenIds = new Set([...hiddenIds].filter((id) => !targetPathIds.has(id)));
  const candidates = minimalCodebaseFocusCandidates(knownTargetIds, index);
  let best: CandidateContext | null = null;
  for (const focus of candidates) {
    const expanded = minimalCodebaseExpandedPaths(knownTargetIds, focus, index, expandedIds);
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
    const visibleTargetIds = knownTargetIds.filter((id) => visibleIds.has(id));
    const candidate = { tree, focus, expanded, visibleTargetIds };
    if (best === null || visibleTargetIds.length > best.visibleTargetIds.length) {
      best = candidate;
    }
    // Candidates run deepest-to-widest, so the first complete one is the cheapest truthful level.
    if (visibleTargetIds.length === knownTargetIds.length) {
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
  };
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
