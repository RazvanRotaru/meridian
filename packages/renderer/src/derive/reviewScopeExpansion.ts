/**
 * Preserve the containment gates for merge-base-only review units when the reader narrows a PR to
 * one connectivity group or path. The ordinary review projection expands changed file modules, but
 * a deleted method can sit below a base-only class that also has to stay open for the method card to
 * remain visible.
 */

import type { GraphIndex } from "../graph/graphIndex";
import { UNIT_CARD_KINDS } from "./blockDeps";
import { normalizePath } from "./matchAffectedFiles";
import type { ReviewFileRow } from "./reviewFiles";

export interface ReviewScopeBaseNodes {
  /** Every node copied from the comparison graph, including containment-only ancestors. */
  baseNodeIds: ReadonlySet<string>;
  /** Nodes directly proven absent from HEAD. */
  deletedNodeIds: ReadonlySet<string>;
}

/**
 * Union the declaration-level containment paths required by base-side units in the selected files.
 * `sourceSide` is the canonical signal; the id sets keep older/in-memory rows safe if that optional
 * field is absent. Files outside the already-resolved scope cannot contribute expansion state.
 */
export function expandReviewScopeBaseUnits(
  current: ReadonlySet<string>,
  index: GraphIndex,
  reviewFiles: readonly ReviewFileRow[],
  includedPaths: ReadonlySet<string>,
  baseNodes: ReviewScopeBaseNodes,
  collapsedRoots: ReadonlySet<string> = new Set(),
): Set<string> {
  const expanded = new Set(current);
  const normalizedPaths = new Set([...includedPaths].map(normalizePath));
  const collapsedRootIds = [...collapsedRoots];

  for (const file of reviewFiles) {
    if (!normalizedPaths.has(normalizePath(file.path))) {
      continue;
    }
    for (const unit of file.units) {
      const isBaseUnit = unit.sourceSide === "base"
        || baseNodes.deletedNodeIds.has(unit.nodeId)
        || baseNodes.baseNodeIds.has(unit.nodeId);
      if (!isBaseUnit) {
        continue;
      }
      for (const ancestor of index.ancestorsOf(unit.nodeId)) {
        const hiddenByRollup = collapsedRootIds.some((rootId) => index.isWithinFocus(rootId, ancestor.id));
        if (!hiddenByRollup && (ancestor.kind === "module" || UNIT_CARD_KINDS.has(ancestor.kind))) {
          expanded.add(ancestor.id);
        }
      }
    }
  }

  return expanded;
}
