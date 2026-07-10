/**
 * The PAIR RIBBON — one cable per ordered pair, colours inside it. Two cards coupled by several
 * relationship kinds (calls + references + instantiates) used to draw one wire per kind on the
 * same geometry: the strands overlapped, their dashes interleaved into confetti, every strand
 * carried its own arrowhead into a pile-up at the pin, and the topmost captured every click.
 * `foldPairRibbons` replaces each such group with ONE edge that renders as a striped cable
 * (RibbonEdge): tightly packed parallel sub-strokes — one per kind, in the kind's colour, each
 * keeping its own lit/dim emphasis — under a single arrowhead and a single hover/click target.
 * `pairOf` gives the inspector the full member list, whatever the reader clicked.
 *
 * A pure paint fold over styled edges, run after bundling/routing (typed edges pass through) and
 * before spooling (a ribbon is already an aggregate; it must not join a fan trunk).
 */

import type { Edge } from "@xyflow/react";
import { BUNDLE_EDGE_TYPE, type BundleEdgeData } from "./edgeBundling";

export const RIBBON_EDGE_TYPE = "ribbon";

export interface RibbonEdgeData extends Record<string, unknown> {
  /** The folded same-pair strands in STRIPE ORDER, arranged centre-out by weight: the heaviest
   * strand sits mid-cable (where the single arrowhead rides), lighter strands alternate outward.
   * Each keeps its full styled edge — stroke, opacity, dash — for honest per-strand emphasis. */
  members: Edge[];
  /** Paint-time flag (hover/pin): every strand lights together. */
  boosted?: boolean;
  /** The Map's direction-pulse opt-in, forwarded to the cable's spine. */
  pulse?: boolean;
}

/** Fold every same-(source,target) group of 2+ plain wires into one ribbon edge. */
export function foldPairRibbons(edges: Edge[]): Edge[] {
  const groups = new Map<string, Edge[]>();
  for (const edge of edges) {
    if (edge.type !== undefined) {
      continue; // bundles/routed keep their own renderer; ribbons fold only plain strands
    }
    const key = `${edge.source} ${edge.target}`;
    const group = groups.get(key);
    if (group) {
      group.push(edge);
    } else {
      groups.set(key, [edge]);
    }
  }
  const folded: Edge[] = [];
  const seenPairs = new Set<string>();
  for (const edge of edges) {
    if (edge.type !== undefined) {
      folded.push(edge);
      continue;
    }
    const key = `${edge.source} ${edge.target}`;
    const group = groups.get(key) ?? [edge];
    if (group.length < 2) {
      folded.push(edge);
      continue;
    }
    if (!seenPairs.has(key)) {
      seenPairs.add(key);
      folded.push(ribbonOf(group));
    }
  }
  return folded;
}

function ribbonOf(group: Edge[]): Edge {
  const members = centerOutByWeight(group);
  const dominant = [...group].sort((a, b) => weightOf(b) - weightOf(a))[0];
  return {
    id: `ribbon:${dominant.source}->${dominant.target}`,
    source: dominant.source,
    target: dominant.target,
    type: RIBBON_EDGE_TYPE,
    // The cable's level style mirrors the dominant strand (minimap/paint consumers); the strands
    // themselves render from `members`.
    style: dominant.style,
    markerEnd: dominant.markerEnd,
    data: { members } satisfies RibbonEdgeData,
  };
}

/** Weight per artifact aggregate; exported so RibbonEdge can seat the arrowhead on the heaviest. */
export const weightOf = (edge: Edge): number => (edge.data as { weight?: number } | undefined)?.weight ?? 1;

/** Stripe order: heaviest strand exactly mid-cable, lighter strands alternating outward — so the
 * cable's visual centre (and its single arrowhead) belongs to the pair's dominant relationship. */
function centerOutByWeight(group: Edge[]): Edge[] {
  const byWeight = [...group].sort((a, b) => weightOf(b) - weightOf(a));
  const center = (group.length - 1) / 2;
  const positions = group
    .map((_, index) => index)
    .sort((a, b) => Math.abs(a - center) - Math.abs(b - center) || a - b);
  const members = new Array<Edge>(group.length);
  positions.forEach((position, rank) => {
    members[position] = byWeight[rank];
  });
  return members;
}

/**
 * Every strand behind a clicked wire, for the inspector: a ribbon opens as its members; a plain
 * strand collects its same-pair siblings (including ones folded inside bundles — the drilled-
 * constituent case), clicked first; a clicked bundle inspects as itself.
 */
export function pairOf(inspected: Edge, edges: Edge[]): Edge[] {
  if (inspected.type === BUNDLE_EDGE_TYPE) {
    return [inspected];
  }
  if (inspected.type === RIBBON_EDGE_TYPE) {
    const members = (inspected.data as RibbonEdgeData).members ?? [];
    return [...members].sort((a, b) => weightOf(b) - weightOf(a)); // the panel leads with the pair's main story
  }
  const pool = edges.flatMap((edge) =>
    edge.type === BUNDLE_EDGE_TYPE ? ((edge.data as BundleEdgeData).constituents ?? []) : [edge],
  );
  const siblings = pool.filter(
    (edge) => edge.source === inspected.source && edge.target === inspected.target && edge.id !== inspected.id,
  );
  return [inspected, ...siblings];
}
