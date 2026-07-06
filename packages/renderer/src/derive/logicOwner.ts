/**
 * The bridge from a logic-flow call to its Service-composition unit: given a call's target id, which
 * composition unit (class/interface/object/module) OWNS that callable, and how healthy is it. Lets a
 * building block carry a "service relationship" chip — the same health colour + smell read the
 * scorecards use — so the flat call graph gains the vertical, cross-view context.
 *
 * Pure: (nodes, edges) → a lookup closure. Metrics + the unit index are built ONCE; the returned
 * function is a cheap map lookup, called per call node during a logic relayout.
 */

import type { GraphEdge, GraphNode } from "@meridian/core";
import { buildUnitIndex, computeCompositionMetrics } from "@meridian/design-metrics";
import { colorForDistance } from "./compositionGraph";

/** The owning composition unit of a call target, resolved for the logic node's chip. */
export type LogicOwner = {
  unitId: string;
  label: string;
  kind: string;
  /** Distance-from-the-main-sequence health colour, shared with the scorecards' accent rail. */
  health: string;
  /** Whether the unit carries any design smell — a quiet marker beside its name. */
  smelly: boolean;
};

/** Map a call target id to its owning unit, or null for an external/absent/unit-less target. */
export type OwnerLookup = (targetId: string | null) => LogicOwner | null;

export function buildOwnerLookup(nodes: GraphNode[], edges: GraphEdge[]): OwnerLookup {
  const metrics = computeCompositionMetrics(nodes, edges);
  const index = buildUnitIndex(nodes);
  return (targetId) => {
    if (targetId === null) {
      return null;
    }
    const unitId = index.unitIdOf(targetId);
    const unit = unitId ? index.nodesById.get(unitId) : undefined;
    const unitMetrics = unitId ? metrics.get(unitId) : undefined;
    if (!unitId || !unit || !unitMetrics) {
      return null;
    }
    return {
      unitId,
      label: unit.displayName,
      kind: unit.kind,
      health: colorForDistance(unitMetrics.distance),
      smelly: unitMetrics.smells.length > 0,
    };
  };
}
