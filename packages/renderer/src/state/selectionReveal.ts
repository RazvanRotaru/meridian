/**
 * The selection panel's model: may "Scope Service view" act on the current selection? Enablement is
 * decided by the SAME many-variant Service reveal `openServiceScope` will run on click — the panel
 * is a discoverable alias for the lens-carry, never a second placeability code path — so the button
 * is enabled exactly when scoping would land on the selection's owning cluster(s), with the reason
 * as the disabled tooltip otherwise.
 */

import type { GraphIndex } from "../graph/graphIndex";
import type { ServiceGroupingMode } from "../derive/serviceClusteringModes";
import { serviceRevealStateForMany } from "./lensPath";

export interface ScopeTarget {
  enabled: boolean;
  /** Why the button is greyed out — a human-readable tooltip; null when enabled. */
  reason: string | null;
}

const NO_CLUSTER_REASON = "No service cluster owns this selection";

/** Enabled iff at least one anchor resolves to a service cluster — the many-variant drops
 * unplaceable anchors per node and goes null only when the whole selection is unplaceable. */
export function scopeTarget(
  anchors: readonly string[],
  index: GraphIndex,
  groupingMode?: ServiceGroupingMode,
  groupingTargetSize?: number,
): ScopeTarget {
  const enabled = serviceRevealStateForMany(anchors, index, groupingMode, groupingTargetSize) !== null;
  return { enabled, reason: enabled ? null : NO_CLUSTER_REASON };
}
