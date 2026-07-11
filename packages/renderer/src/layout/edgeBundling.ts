/**
 * Visual Highways — edge bundling for the Module-map surface.
 *
 * Edges traveling between the same two PARENT CONTAINERS (packages/directories) merge into a single
 * thick "highway" edge that represents the aggregate coupling between those regions. The highway
 * connects the two parent nodes directly — a clean trunk replacing dozens of crossing wires.
 *
 * Intra-container edges (both endpoints in the same parent) stay individual — they're short and
 * don't contribute to spaghetti. Only CROSS-CONTAINER traffic merges.
 *
 * Bundling is a VISUAL-ONLY post-emphasize pass — the individual edges drive neighbourhood traversal
 * and emphasis logic upstream; this step only transforms what React Flow draws.
 */

import type { Edge, Node } from "@xyflow/react";
import { relColor } from "../theme/mapPalette";
import { withBoundaryDash } from "./edgeBoundary";

/** The data payload on a bundled "highway" edge. Index signature so it satisfies React Flow's
 * `Edge.data` constraint (`Record<string, unknown>`). */
export interface BundleEdgeData extends Record<string, unknown> {
  /** Number of constituent edges merged into this bundle. */
  count: number;
  /** Breakdown by relationship kind: { calls: 5, extends: 2, ... } */
  breakdown: Record<string, number>;
  /** The dominant kind (most edges) — drives the bundle's base colour. */
  dominantKind: string;
  /** The original constituent edges (for hover expansion). */
  constituents: Edge[];
  /** Whether ANY constituent was lit (opacity 1) by the emphasis pass. */
  hasLit: boolean;
  /** Geometric/grouping signal retained for the bundle's established colour vocabulary. */
  crossFrame: boolean;
  /** Whether ANY constituent's original dependency crosses an npm-package boundary. */
  crossPackage: boolean;
  /** Whether ANY constituent represents an endpoint outside the current view. */
  outsideView: boolean;
  /** Synthesized category for compatibility with the paint layer. */
  category: "bundle";
  /** Source parent container id. */
  sourceParent: string;
  /** Target parent container id. */
  targetParent: string;
}

export const BUNDLE_EDGE_TYPE = "bundle";

/** Shared empty selection so the default arg is a stable reference (no per-call allocation). */
const EMPTY_SELECTION: ReadonlySet<string> = new Set<string>();

/**
 * True when `ancestor` sits on the parent chain above `start` — i.e. `start` is nested inside
 * `ancestor`. Walks up via `parentOf` (cycle-guarded). Used to reject highways between a frame and
 * a container nested inside it: that "highway" would just route to the enclosing frame's boundary
 * and read as a wire diving into its own parent, which is meaningless.
 */
function isNestedWithin(ancestor: string, start: string | undefined, parentOf: Map<string, string | undefined>): boolean {
  let current = parentOf.get(start ?? "");
  const seen = new Set<string>();
  while (current && !seen.has(current)) {
    if (current === ancestor) return true;
    seen.add(current);
    current = parentOf.get(current);
  }
  return false;
}

/** Minimum number of cross-container edges before they merge into a highway. */
const BUNDLE_THRESHOLD = 3;

/** Base width for a bundle; grows logarithmically with edge count. */
const BASE_BUNDLE_WIDTH = 3.5;
const MAX_BUNDLE_WIDTH = 12;

/** Compute the rendered stroke width for a bundle of `count` edges. */
export function bundleWidth(count: number): number {
  if (count <= 1) return 1.5;
  // Logarithmic growth: 3 edges ≈ 4px, 10 edges ≈ 6px, 30 edges ≈ 8px, 50+ → 12px cap
  return Math.min(MAX_BUNDLE_WIDTH, BASE_BUNDLE_WIDTH + Math.log2(count) * 1.8);
}

/**
 * Bundle cross-container edges into highway edges. Edges whose source and target live in DIFFERENT
 * parent containers merge into one thick highway per (sourceParent, targetParent) pair.
 *
 * Intra-container edges and edges at the top level (no parent) pass through unchanged.
 *
 * `selected` un-bundles on demand: any edge incident to a selected node draws individually so the
 * reader can trace that node's own links out of the highway they'd otherwise disappear into. The
 * rest of the highway stays merged (its count drops by the extracted edges).
 */
export function bundleEdges(edges: Edge[], nodes: Node[], selected: ReadonlySet<string> = EMPTY_SELECTION): Edge[] {
  // Build parent lookup from the React Flow node array.
  const parentOf = new Map<string, string | undefined>();
  for (const node of nodes) {
    parentOf.set(node.id, node.parentId);
  }

  // Group cross-container edges by (sourceParent, targetParent).
  const groups = new Map<string, Edge[]>();
  const passThrough: Edge[] = [];

  for (const edge of edges) {
    const sp = parentOf.get(edge.source);
    const tp = parentOf.get(edge.target);

    // Only bundle edges that cross between two DIFFERENT named containers.
    // Edges within the same container or at the root level (no parent) stay individual.
    if (!sp || !tp || sp === tp) {
      passThrough.push(edge);
      continue;
    }

    // Never bundle between NESTED containers (one parent is an ancestor of the other). Such a
    // highway would draw to the enclosing frame's edge — reading as a wire diving into its own
    // parent — and, worse, fans-out to many sibling cards collapse onto the shared ancestor as one
    // meaningless trunk. Draw these individually so each real endpoint is visible.
    if (isNestedWithin(sp, tp, parentOf) || isNestedWithin(tp, sp, parentOf)) {
      passThrough.push(edge);
      continue;
    }

    // A selected node's own wires always draw individually — never folded into a highway.
    if (selected.has(edge.source) || selected.has(edge.target)) {
      passThrough.push(edge);
      continue;
    }

    // Directional key: edges from container A → container B are a separate highway from B → A.
    const key = `${sp}→${tp}`;
    const group = groups.get(key);
    if (group) {
      group.push(edge);
    } else {
      groups.set(key, [edge]);
    }
  }

  const result: Edge[] = [...passThrough];
  for (const [key, group] of groups) {
    if (group.length < BUNDLE_THRESHOLD) {
      // Below threshold — keep individual edges
      result.push(...group);
    } else {
      // Merge into a highway bundle connecting the two parent containers
      const [sourceParent, targetParent] = key.split("→");
      result.push(createBundleEdge(sourceParent, targetParent, group));
    }
  }
  return result;
}

/** Create a single highway bundle edge connecting two parent containers. */
function createBundleEdge(sourceParent: string, targetParent: string, edges: Edge[]): Edge {
  // Tally relationship kinds
  const breakdown: Record<string, number> = {};
  let hasLit = false;
  let crossPackage = false;
  let outsideView = false;

  for (const edge of edges) {
    const data = edge.data as { depKind?: string; category?: string; crossPackage?: boolean; outsideView?: boolean } | undefined;
    const kind = data?.depKind ?? data?.category ?? "other";
    breakdown[kind] = (breakdown[kind] ?? 0) + 1;
    crossPackage ||= data?.crossPackage === true;
    outsideView ||= data?.outsideView === true;
    if ((edge.style as { opacity?: number } | undefined)?.opacity === 1) {
      hasLit = true;
    }
  }

  // Find dominant kind (most frequent)
  let dominantKind = "calls";
  let maxCount = 0;
  for (const [kind, count] of Object.entries(breakdown)) {
    if (count > maxCount) {
      maxCount = count;
      dominantKind = kind;
    }
  }

  const count = edges.length;
  const width = bundleWidth(count);
  const color = relColor(dominantKind) ?? "#8B95A3";
  const opacity = hasLit ? 0.85 : 0.45;

  const bundleData: BundleEdgeData = {
    count,
    breakdown,
    dominantKind,
    constituents: edges,
    hasLit,
    crossFrame: true, // cross-container by definition; colour/geometric signal, not dash semantics
    crossPackage,
    outsideView,
    category: "bundle",
    sourceParent,
    targetParent,
  };

  return {
    id: `highway:${sourceParent}→${targetParent}`,
    source: sourceParent,
    target: targetParent,
    type: BUNDLE_EDGE_TYPE,
    data: bundleData,
    style: withBoundaryDash({ stroke: color, strokeWidth: width, opacity }, bundleData),
    interactionWidth: Math.max(width + 10, 18), // generous hit area
  };
}

/** Format the breakdown into a human-readable label (e.g. "5 calls · 2 extends"). */
export function bundleLabel(breakdown: Record<string, number>): string {
  return Object.entries(breakdown)
    .sort((a, b) => b[1] - a[1])
    .map(([kind, count]) => `${count} ${kind}`)
    .join(" · ");
}
