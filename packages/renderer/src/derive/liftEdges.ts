/**
 * liftEdges: project the artifact's leaf-level edges onto the currently visible boxes.
 *
 * Each endpoint rises to its nearest VISIBLE ancestor-or-self (roots are always visible, so
 * the walk terminates). Self-loops after lifting are dropped; the rest aggregate by
 * source->target->kind, summing weight and retaining the underlying edge ids so a click can
 * still reach the real call sites and their telemetry.
 */

import type { GraphEdge } from "@meridian/core";
import type { LiftedEdge } from "./types";

interface MutableAggregate {
  source: string;
  target: string;
  kind: string;
  weight: number;
  underlyingEdgeIds: string[];
  lifted: boolean;
  resolved: boolean;
}

export function liftEdges(
  edges: GraphEdge[],
  visible: ReadonlySet<string>,
  parentOf: ReadonlyMap<string, string | null>,
): LiftedEdge[] {
  const aggregates = new Map<string, MutableAggregate>();
  for (const edge of edges) {
    accumulate(edge, visible, parentOf, aggregates);
  }
  return [...aggregates.values()].map(finalize);
}

function accumulate(
  edge: GraphEdge,
  visible: ReadonlySet<string>,
  parentOf: ReadonlyMap<string, string | null>,
  aggregates: Map<string, MutableAggregate>,
): void {
  const source = liftEndpoint(edge.source, visible, parentOf);
  const target = liftEndpoint(edge.target, visible, parentOf);
  if (source === null || target === null || source === target) {
    return;
  }
  const lifted = source !== edge.source || target !== edge.target;
  mergeInto(aggregates, edge, source, target, lifted);
}

/** Walk parentId until a visible ancestor; null when an endpoint (e.g. an `ext:` target) has none. */
function liftEndpoint(
  startId: string,
  visible: ReadonlySet<string>,
  parentOf: ReadonlyMap<string, string | null>,
): string | null {
  const seen = new Set<string>();
  let current: string | null | undefined = startId;
  while (current) {
    if (visible.has(current)) {
      return current;
    }
    // A parentId cycle (tolerated by the lenient viewer) must not spin forever.
    if (seen.has(current) || !parentOf.has(current)) {
      return null;
    }
    seen.add(current);
    current = parentOf.get(current) ?? null;
  }
  return null;
}

function mergeInto(
  aggregates: Map<string, MutableAggregate>,
  edge: GraphEdge,
  source: string,
  target: string,
  lifted: boolean,
): void {
  const key = `${edge.kind}@${source}|${target}`;
  const isResolved = (edge.resolution ?? "resolved") === "resolved";
  const existing = aggregates.get(key);
  if (!existing) {
    aggregates.set(key, {
      source,
      target,
      kind: edge.kind,
      weight: edge.weight ?? 1,
      underlyingEdgeIds: [edge.id],
      lifted,
      resolved: isResolved,
    });
    return;
  }
  existing.weight += edge.weight ?? 1;
  existing.underlyingEdgeIds.push(edge.id);
  existing.lifted = existing.lifted || lifted;
  existing.resolved = existing.resolved && isResolved;
}

function finalize(aggregate: MutableAggregate): LiftedEdge {
  return { id: `${aggregate.kind}@${aggregate.source}|${aggregate.target}`, ...aggregate };
}
