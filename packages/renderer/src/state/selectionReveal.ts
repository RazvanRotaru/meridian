/**
 * The selection panel's model: may "Scope Service view" act on the current selection? Enablement is
 * decided by the SAME many-variant Service reveal `openServiceScope` will run on click — the panel
 * is a discoverable alias for the lens-carry, never a second placeability code path — so the button
 * is enabled exactly when scoping would land on the selection's owning cluster(s), with the reason
 * as the disabled tooltip otherwise.
 */

import type { GraphIndex } from "../graph/graphIndex";
import type { ServiceGroupingMode } from "../derive/serviceClusteringModes";
import { clusteringForIfAvailable } from "../derive/serviceClusteringCache";
import { serviceRevealStateForMany } from "./lensPath";

export type ScopeTarget = {
  availability: "available";
  enabled: true;
  reason: null;
} | {
  availability: "unavailable";
  enabled: false;
  reason: string;
} | {
  /** The active bounded view intentionally omits Service facts; destination hydration resolves it. */
  availability: "unresolved";
  enabled: true;
  reason: null;
};

const NO_CLUSTER_REASON = "No service cluster owns this selection";

/** Enabled iff at least one anchor resolves to a service cluster — the many-variant drops
 * unplaceable anchors per node and goes null only when the whole selection is unplaceable. */
export function scopeTarget(
  anchors: readonly string[],
  index: GraphIndex,
  groupingMode?: ServiceGroupingMode,
  groupingTargetSize?: number,
): ScopeTarget {
  if (anchors.length === 0) {
    return { availability: "unavailable", enabled: false, reason: NO_CLUSTER_REASON };
  }
  // Map/UI projections do not carry Service topology. That means eligibility is unresolved, not
  // false: the shared lens-transition lane will hydrate Service, then perform the authoritative
  // ownership check there. Never derive a second whole-revision abstraction in the current view.
  if (clusteringForIfAvailable(index) === null) {
    return { availability: "unresolved", enabled: true, reason: null };
  }
  const enabled = serviceRevealStateForMany(anchors, index, groupingMode, groupingTargetSize) !== null;
  return enabled
    ? { availability: "available", enabled: true, reason: null }
    : { availability: "unavailable", enabled: false, reason: NO_CLUSTER_REASON };
}
