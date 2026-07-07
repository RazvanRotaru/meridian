/**
 * Pure row-visibility for the PR-review list: which ranked flows the file-filter chip and the
 * "Hide reviewed" toggle leave on screen. A flow matches the chip when its own file is the
 * filtered file, or when a module it touches lives in that file (a "calls into" flow highlights
 * modules, not just its own). Split out of `ReviewFlowList` so it's testable without React.
 */

import type { GraphIndex } from "../graph/graphIndex";
import type { RankedReviewFlow } from "../derive/reviewFlows";
import { fileOf } from "../derive/reviewFlowMetrics";

export interface VisibleFlowsOptions {
  /** The clicked-file filter chip's file, or null when unfiltered. */
  filterFile: string | null;
  /** Whether already-reviewed flows are hidden. */
  hideReviewed: boolean;
  reviewedFlowIds: ReadonlySet<string>;
}

/** The flows a reader currently sees in the list, in their given (ranked) order. */
export function visibleFlows(
  flows: readonly RankedReviewFlow[],
  index: GraphIndex,
  options: VisibleFlowsOptions,
): RankedReviewFlow[] {
  return flows.filter((flow) => {
    if (options.filterFile !== null && !touchesFile(flow, options.filterFile, index)) {
      return false;
    }
    return !(options.hideReviewed && options.reviewedFlowIds.has(flow.rootId));
  });
}

/** Whether a flow's own file or any module it touches matches `file`. */
export function touchesFile(flow: RankedReviewFlow, file: string, index: GraphIndex): boolean {
  if (flow.file === file) {
    return true;
  }
  return flow.touchedModuleIds.some((moduleId) => fileOf(index, moduleId) === file);
}
