/**
 * Derive the graph's composition units into a pre-layout spec — the SOLID health scorecards the
 * Service-composition tab renders, wired by coupling edges. Each unit (class/interface/object body
 * or a whole module) becomes a scorecard sized to its metrics; each cross-unit coupling becomes one
 * peer wire. Colour tracks distance-from-the-main-sequence (green → amber → red).
 *
 * Pure: (nodes, edges) → {nodes, edges}. No React, no ELK. Mirrors `logicGraph.ts`.
 */

import type { GraphEdge, GraphNode } from "@meridian/core";
import { computeCompositionMetrics, type UnitMetrics } from "./composition";
import { couplingEdges } from "./composition-graph";
import { computeRootedView } from "./compositionRoot";
import { buildClusters, type ClusterFrame } from "./compositionClusters";

// A `type` (not an interface) so it satisfies React Flow's `Node<T extends Record<string, unknown>>`
// constraint — an interface lacks the implicit index signature (mirrors logic's LogicNodeData).
export type CompNodeData = {
  unitId: string;
  kind: string;
  label: string;
  metrics: UnitMetrics;
  /** A 1-hop coupling neighbour of the rooted subtree — drawn faded + click-to-re-root. Absent/false
   * for the root's own units and for the whole-system (rootless) view. */
  boundary?: boolean;
};

// A cluster FRAME's data: presentation only — the package/folder label plus the tallies that drive
// its header badges. A `type` for the same index-signature reason as CompNodeData.
export type ClusterNodeData = {
  clusterId: string;
  label: string;
  unitCount: number;
  smellyCount: number;
};

export type CompNodeType = "unit" | "cluster";

// A single spec type spans both node kinds (mirrors logic's LogicNodeSpec): a "unit" carries its
// scorecard size and a cluster `parentId`; a "cluster" frame is a container ELK sizes, so it omits
// width/height and parentId. `data` narrows on `type`.
export interface CompNodeSpec {
  id: string;
  type: CompNodeType;
  width?: number;
  height?: number;
  /** The cluster frame this unit nests in (undefined for a frame itself). */
  parentId?: string;
  data: CompNodeData | ClusterNodeData;
}

export interface CompEdgeSpec {
  id: string;
  source: string;
  target: string;
  inheritanceOnly: boolean;
  /** True when the pair sits in DIFFERENT clusters — the packaging / Common-Closure signal. */
  crossBoundary: boolean;
}

export interface CompositionGraphSpec {
  nodes: CompNodeSpec[];
  edges: CompEdgeSpec[];
}

/**
 * Every unit that carries weight — has ≥1 member OR sits on ≥1 coupling wire — as a sized
 * scorecard, plus the peer wires between them. An empty, uncoupled unit is dropped so the canvas
 * isn't cluttered with dead frames; a coupling endpoint is always kept even if it has no members.
 *
 * A non-null `root` (a module/package node id) narrows the graph to a ROOTED view: only the units
 * the root contains plus their 1-hop coupling neighbours (the latter flagged `boundary` and drawn
 * faded so a click can re-root there). `root === null` is the unchanged whole-system view.
 */
export function deriveCompositionGraph(nodes: GraphNode[], edges: GraphEdge[], root: string | null = null, showMetrics = true): CompositionGraphSpec {
  const metrics = computeCompositionMetrics(nodes, edges);
  const couplings = couplingEdges(nodes, edges);
  const coupled = couplingEndpoints(couplings);
  const nodesById = new Map(nodes.map((node) => [node.id, node]));

  // The whole-system survivor set drives both views; a root then restricts it to its subtree + the
  // 1-hop neighbours, keeping the root's own unit even if it would otherwise be dropped.
  const survivors = survivingUnits(metrics, coupled);
  const view = computeRootedView(root, survivors, root !== null && metrics.has(root), couplings, nodesById);

  const unitSpecs: CompNodeSpec[] = [];
  const emitted = new Set<string>();
  for (const metric of metrics.values()) {
    if (!view.visible.has(metric.id)) {
      continue;
    }
    unitSpecs.push(unitNode(metric, view.boundary.has(metric.id), showMetrics));
    emitted.add(metric.id);
  }

  // Group the surviving units into package frames and pin each unit to its frame. A frame node is
  // emitted BEFORE its child units so React Flow always sees a parent ahead of its children.
  const clusters = buildClusters(unitSpecs, nodesById);
  const clusterOf = assignClusters(clusters, unitSpecs);
  const nodeSpecs = [...clusters.map(clusterNode), ...unitSpecs];

  // A coupling endpoint is always a unit with a metrics entry, so both ends are emitted; the guard
  // is defensive against a pair that somehow references a dropped unit. A pair spanning two frames
  // is the packaging signal the layout emphasizes.
  const edgeSpecs = couplings
    .filter((edge) => emitted.has(edge.source) && emitted.has(edge.target))
    .map((edge) => ({
      id: `couple:${edge.source}->${edge.target}`,
      source: edge.source,
      target: edge.target,
      inheritanceOnly: edge.inheritanceOnly,
      crossBoundary: clusterOf.get(edge.source) !== clusterOf.get(edge.target),
    }));

  return { nodes: nodeSpecs, edges: edgeSpecs };
}

/** Set each unit spec's `parentId` to its cluster frame, returning the unit→cluster map the edge
 * pass reuses to flag cross-boundary couplings. */
function assignClusters(clusters: ClusterFrame[], unitSpecs: CompNodeSpec[]): Map<string, string> {
  const clusterOf = new Map<string, string>();
  for (const cluster of clusters) {
    for (const unitId of cluster.unitIds) {
      clusterOf.set(unitId, cluster.id);
    }
  }
  for (const spec of unitSpecs) {
    spec.parentId = clusterOf.get(spec.id);
  }
  return clusterOf;
}

function clusterNode(cluster: ClusterFrame): CompNodeSpec {
  const data: ClusterNodeData = {
    clusterId: cluster.id,
    label: cluster.label,
    unitCount: cluster.unitIds.length,
    smellyCount: cluster.smellyCount,
  };
  // No width/height, no parentId: ELK sizes a container from its children, and a frame is a root.
  return { id: cluster.id, type: "cluster", data };
}

function couplingEndpoints(couplings: ReturnType<typeof couplingEdges>): Set<string> {
  const ids = new Set<string>();
  for (const edge of couplings) {
    ids.add(edge.source);
    ids.add(edge.target);
  }
  return ids;
}

/** The units carrying weight: ≥1 member OR ≥1 coupling wire — the whole-system scorecard set. */
function survivingUnits(metrics: Map<string, UnitMetrics>, coupled: Set<string>): Set<string> {
  const survivors = new Set<string>();
  for (const metric of metrics.values()) {
    if (metric.members > 0 || coupled.has(metric.id)) {
      survivors.add(metric.id);
    }
  }
  return survivors;
}

function unitNode(metric: UnitMetrics, boundary: boolean, showMetrics: boolean): CompNodeSpec {
  const data: CompNodeData = { unitId: metric.id, kind: metric.kind, label: metric.displayName, metrics: metric, boundary };
  const { width, height } = sizeFor(data, showMetrics);
  return { id: metric.id, type: "unit", width, height, data };
}

// The scorecard geometry: a fixed-width card whose height grows only with the smell chips that
// wrap ~2 per row below the metrics. The base clears the header + the members/coupling/distance
// rows; each chip row adds a fixed band so the node component renders without clipping.
const CARD_WIDTH = 240;
const CARD_BASE_HEIGHT = 104;
const CHIP_ROW_HEIGHT = 22;
const CHIPS_PER_ROW = 2;
// A metrics-off card shows only its header row (kind + name), so it collapses to a compact height
// that clears just that row — no metric rows, no chip band.
const CARD_COMPACT_HEIGHT = 40;

export function sizeFor(data: CompNodeData, showMetrics = true): { width: number; height: number } {
  if (!showMetrics) {
    return { width: CARD_WIDTH, height: CARD_COMPACT_HEIGHT };
  }
  const chipRows = Math.ceil(data.metrics.smells.length / CHIPS_PER_ROW);
  return { width: CARD_WIDTH, height: CARD_BASE_HEIGHT + chipRows * CHIP_ROW_HEIGHT };
}

// Distance-from-the-main-sequence health scale, stepwise green → amber → red. The middle band
// collapses to amber (the spec allows a simple stepwise): on the main sequence reads green, a
// unit far off it (D ≥ 0.7 — a zone-of-pain/uselessness corner) reads red.
const DISTANCE_GREEN_MAX = 0.2;
const DISTANCE_RED_MIN = 0.7;
export const HEALTH_GREEN = "#56C271";
export const HEALTH_AMBER = "#E6B84D";
export const HEALTH_RED = "#E5484D";

export function colorForDistance(distance: number): string {
  if (distance <= DISTANCE_GREEN_MAX) {
    return HEALTH_GREEN;
  }
  if (distance >= DISTANCE_RED_MIN) {
    return HEALTH_RED;
  }
  return HEALTH_AMBER;
}
