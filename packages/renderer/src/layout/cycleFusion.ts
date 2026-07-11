/**
 * CYCLE fusion (wire-legibility plan, W3): `A→B` plus `B→A` of the same kind is MUTUAL coupling —
 * a design smell (`@meridian/design-metrics`' vocabulary) that used to render as two separate
 * curves the reader had to visually match up. Fuse them: one wire, an arrowhead at BOTH ends, and
 * a tension underlay — the cycle becomes a single glance instead of a puzzle.
 *
 * A pure paint fold over styled edges, run right after emphasis and BEFORE the highway passes
 * (a typed cycle edge passes through bundling/routing/ribbons/spooling untouched). Fusion is
 * per-KIND and per unordered pair: `calls` both ways fuses; `A calls B` + `B references A` stays
 * two wires (different stories). The fused edge keeps both directions in `members` for the Wire
 * Inspector and the hover breakdown, and takes the brighter direction's emphasis (lit if either).
 */

import type { Edge } from "@xyflow/react";
import { withBoundaryDash } from "./edgeBoundary";

export const CYCLE_EDGE_TYPE = "cycle";

export interface CycleEdgeData extends Record<string, unknown> {
  /** The two directional wires, FORWARD (matching the fused edge's source→target) first. */
  members: Edge[];
  depKind?: string;
  /** Summed weights per direction, for the tooltip/chip (`⇄ calls ×5/×2`). */
  forwardWeight: number;
  backwardWeight: number;
  crossPackage: boolean;
  outsideView: boolean;
  pulse?: boolean;
  hidden?: boolean;
}

export function fuseCycles(edges: Edge[]): Edge[] {
  const byDirectedKey = new Map<string, Edge>();
  for (const edge of edges) {
    if (edge.type === undefined) {
      byDirectedKey.set(directedKey(edge), edge);
    }
  }
  const fusedPairs = new Set<string>();
  const result: Edge[] = [];
  for (const edge of edges) {
    if (edge.type !== undefined) {
      result.push(edge);
      continue;
    }
    const reverse = byDirectedKey.get(directedKey(edge, true));
    if (!reverse || reverse === edge) {
      result.push(edge);
      continue;
    }
    const pairKey = undirectedKey(edge);
    if (fusedPairs.has(pairKey)) {
      continue; // the reverse wire already emitted the fused edge
    }
    fusedPairs.add(pairKey);
    result.push(fuse(edge, reverse));
  }
  return result;
}

/** One fused cycle wire: forward's geometry, both directions' evidence, the brighter emphasis. */
function fuse(forward: Edge, backward: Edge): Edge {
  const forwardData = (forward.data ?? {}) as {
    depKind?: string;
    weight?: number;
    underlyingEdgeIds?: string[];
    crossFrame?: boolean;
    crossPackage?: boolean;
    outsideView?: boolean;
  };
  const backwardData = (backward.data ?? {}) as {
    weight?: number;
    underlyingEdgeIds?: string[];
    crossPackage?: boolean;
    outsideView?: boolean;
  };
  const litSide = (forward.style as { opacity?: number } | undefined)?.opacity === 1 ? forward : backward;
  const crossPackage = forwardData.crossPackage === true || backwardData.crossPackage === true;
  const outsideView = forwardData.outsideView === true || backwardData.outsideView === true;
  return {
    id: `cycle:${forwardData.depKind ?? "wire"}:${forward.source}<->${forward.target}`,
    source: forward.source,
    target: forward.target,
    type: CYCLE_EDGE_TYPE,
    // Emphasis may choose either direction's paint, but boundary dashing is the OR of BOTH facts.
    style: withBoundaryDash(litSide.style, { crossPackage, outsideView }),
    markerEnd: forward.markerEnd,
    markerStart: backward.markerEnd, // the reverse direction's arrow, worn at the source end
    data: {
      members: [forward, backward],
      depKind: forwardData.depKind,
      crossFrame: forwardData.crossFrame,
      crossPackage,
      outsideView,
      weight: (forwardData.weight ?? 1) + (backwardData.weight ?? 1),
      forwardWeight: forwardData.weight ?? 1,
      backwardWeight: backwardData.weight ?? 1,
      underlyingEdgeIds: [...(forwardData.underlyingEdgeIds ?? []), ...(backwardData.underlyingEdgeIds ?? [])],
    } satisfies CycleEdgeData & Record<string, unknown>,
  };
}

const kindOf = (edge: Edge): string => {
  const data = edge.data as { depKind?: string; category?: string } | undefined;
  return data?.depKind ?? data?.category ?? "wire";
};

const directedKey = (edge: Edge, reversed = false): string =>
  reversed ? `${kindOf(edge)} ${edge.target} ${edge.source}` : `${kindOf(edge)} ${edge.source} ${edge.target}`;

const undirectedKey = (edge: Edge): string => {
  const [a, b] = [edge.source, edge.target].sort();
  return `${kindOf(edge)} ${a} ${b}`;
};
