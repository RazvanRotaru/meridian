/**
 * Fan-in/out spooling — the Visual Highways treatment for HUB nodes. Container-pair bundling
 * (edgeBundling.ts) can't help when dozens of wires converge on ONE node from parentless sources
 * (the minimal-graph overlay's ghost ring, a protocol Bridge imported by every test): each edge has
 * a distinct far end, so nothing merges. Spooling keeps every edge individual — click/hover/emphasis
 * still address one wire — but reroutes all of a hub's wires through a shared GATHER point just off
 * the hub, so they travel the last stretch as one visible trunk instead of a 44-strand spray.
 *
 * A pure paint pass over already-styled edges: it only swaps the edge `type` (the spool router) and
 * tags which end(s) gather. Positions, styles, and the edges themselves are untouched.
 */

import type { Edge } from "@xyflow/react";

export const SPOOL_EDGE_TYPE = "spool";

/** How many same-direction wires a node needs before its fan gathers into a trunk. */
const SPOOL_THRESHOLD = 6;

export interface SpoolEdgeData extends Record<string, unknown> {
  /** Which end(s) of this edge belong to a hub and gather into its trunk. */
  spoolEnd: "source" | "target" | "both";
}

/** Retype each edge that touches a fan hub; everything else passes through untouched. */
export function spoolFanEdges(edges: Edge[]): Edge[] {
  const inCount = new Map<string, number>();
  const outCount = new Map<string, number>();
  for (const edge of edges) {
    if (edge.type !== undefined) {
      continue; // container highways (bundle) and gutter-bus wires (routed) are already structured
    }
    outCount.set(edge.source, (outCount.get(edge.source) ?? 0) + 1);
    inCount.set(edge.target, (inCount.get(edge.target) ?? 0) + 1);
  }
  return edges.map((edge) => {
    if (edge.type !== undefined) {
      return edge;
    }
    const gathersIn = (inCount.get(edge.target) ?? 0) >= SPOOL_THRESHOLD;
    const gathersOut = (outCount.get(edge.source) ?? 0) >= SPOOL_THRESHOLD;
    if (!gathersIn && !gathersOut) {
      return edge;
    }
    const spoolEnd = gathersIn && gathersOut ? "both" : gathersIn ? "target" : "source";
    return { ...edge, type: SPOOL_EDGE_TYPE, data: { ...edge.data, spoolEnd } };
  });
}
