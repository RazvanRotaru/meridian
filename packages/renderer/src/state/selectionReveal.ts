/**
 * The selection panel's model: which lenses can reveal the current selection. Enablement is decided
 * by the SAME per-lens many-variant reveals `setViewMode` will run on click — the panel is a
 * discoverable alias for the lens-carry, never a second placeability code path — so a button is
 * enabled exactly when flipping to that lens would land on the selection rather than the lens top.
 *
 * Every lens gets an entry, INCLUDING the active one: the panel filters the active lens out for
 * display, but "Scope Service view" reads its enablement (and disabled reason) straight off the
 * Service entry — one placeability computation per render, shared by both buttons.
 */

import type { GraphIndex } from "../graph/graphIndex";
import type { ViewMode } from "../derive/edgeSelection";
import { mapRevealStateForMany, serviceRevealStateForMany, uiRevealStateForMany } from "./lensPath";

export interface RevealTarget {
  mode: ViewMode;
  label: string;
  enabled: boolean;
  /** Why the button is greyed out — a human-readable tooltip; null when enabled. */
  reason: string | null;
}

interface LensTarget {
  mode: ViewMode;
  label: string;
  reason: string;
  placeable: (anchors: readonly string[], index: GraphIndex) => boolean;
}

const LENS_TARGETS: readonly LensTarget[] = [
  {
    mode: "modules",
    label: "Map",
    reason: "No file contains this selection",
    placeable: (anchors, index) => mapRevealStateForMany(anchors, index) !== null,
  },
  {
    mode: "call",
    label: "Service",
    reason: "No service cluster owns this selection",
    placeable: (anchors, index) => serviceRevealStateForMany(anchors, index) !== null,
  },
  {
    mode: "ui",
    label: "UI",
    reason: "Selection is not in the graph",
    placeable: (anchors, index) => uiRevealStateForMany(anchors, index) !== null,
  },
];

/** One entry per reveal-capable lens (Logic is never a reveal target), enabled iff at least one
 * anchor is placeable there — the many-variants drop unplaceable anchors per node and go null only
 * when the whole selection is unplaceable. The Service entry doubles as the "Scope Service view"
 * gate (same anchors→clusters resolution), so it is returned even when Service is the active lens. */
export function revealTargets(anchors: readonly string[], index: GraphIndex): RevealTarget[] {
  return LENS_TARGETS.map((lens) => {
    const enabled = lens.placeable(anchors, index);
    return { mode: lens.mode, label: lens.label, enabled, reason: enabled ? null : lens.reason };
  });
}
