/**
 * The Service-composition tab's containment tree, emitted in the Map's EXACT shapes
 * (`VisibleModuleNode`/`ModuleTreeEdge`) so the same ModuleMapView, node components, paint passes,
 * and ELK layout render it unchanged. Only the organizing principle differs from the folder map:
 * top-level "package" group cards are SERVICE CLUSTERS (a lead service + the helper sub-services
 * it is composed of, per serviceComposition's clustering); expanding a cluster nests its member
 * unit cards inside its frame; wires are unit couplings lifted to the visible representatives.
 * Pure; no React, no ELK.
 */

import type { GraphEdge, GraphNode } from "@meridian/core";
import { buildUnitIndex, computeCompositionMetrics, couplingEdges, groupMembersByUnit, type UnitMetrics } from "@meridian/design-metrics";
import { clusterServices, type Cluster } from "./serviceComposition";
import type { ModuleGroupData, ModuleTreeEdge, VisibleModuleNode } from "./moduleTree";
import type { UnitCardData } from "./moduleLevel";

type Couplings = ReturnType<typeof couplingEdges>;

/** A cluster frame's node id — namespaced like the composition view's, so it can never collide
 * with a real unit id in the shared `moduleExpanded` set. */
const frameIdOf = (leadId: string): string => `svc:${leadId}`;

/** The service-cluster tree for `expanded`: one group card per cluster (collapsed by default),
 * member unit cards nested inside each expanded cluster, dependency wires between the visible cards. */
export function deriveServiceTree(
  nodes: GraphNode[],
  edges: GraphEdge[],
  expanded: ReadonlySet<string>,
): { nodes: VisibleModuleNode[]; edges: ModuleTreeEdge[] } {
  const metrics = computeCompositionMetrics(nodes, edges);
  const couplings = couplingEdges(nodes, edges);
  const { clusters, leadOf } = clusterServices(metrics, couplings);
  if (clusters.length === 0) {
    return { nodes: [], edges: [] };
  }
  const membersByUnit = groupMembersByUnit(nodes, buildUnitIndex(nodes));
  const degrees = clusterDegrees(couplings, leadOf);
  // Group cards BEFORE unit cards — React Flow requires a parent ahead of its children. Clusters
  // arrive sorted by lead id and members sorted within, so the emission is deterministic.
  const groups = clusters.map((cluster) => groupNode(cluster, metrics, degrees, expanded));
  const units = clusters.flatMap((cluster) => memberNodes(cluster, metrics, membersByUnit, expanded));
  return { nodes: [...groups, ...units], edges: dependencyEdges(couplings, leadOf, expanded) };
}

/** One cluster's group card, wearing the Map's group-card data (Ca/Ce here count DISTINCT peer
 * clusters, the service-level coupling the collapsed overview should read as). */
function groupNode(
  cluster: Cluster,
  metrics: Map<string, UnitMetrics>,
  degrees: ClusterDegrees,
  expanded: ReadonlySet<string>,
): VisibleModuleNode {
  const frameId = frameIdOf(cluster.leadId);
  const isContainer = cluster.memberIds.length > 1;
  const isExpanded = expanded.has(frameId);
  const data: ModuleGroupData = {
    label: metrics.get(cluster.leadId)?.displayName ?? cluster.leadId,
    fileCount: cluster.memberIds.length,
    ca: degrees.ca.get(cluster.leadId)?.size ?? 0,
    ce: degrees.ce.get(cluster.leadId)?.size ?? 0,
    isContainer,
    isExpanded,
  };
  return { id: frameId, parentId: null, kind: "package", isContainer, isExpanded, depth: 0, childCount: cluster.memberIds.length, data };
}

/** An expanded cluster's member unit cards, nested inside its frame; a collapsed cluster emits none. */
function memberNodes(
  cluster: Cluster,
  metrics: Map<string, UnitMetrics>,
  membersByUnit: Map<string, GraphNode[]>,
  expanded: ReadonlySet<string>,
): VisibleModuleNode[] {
  const frameId = frameIdOf(cluster.leadId);
  if (!expanded.has(frameId)) {
    return [];
  }
  return cluster.memberIds.map((unitId) => {
    const metric = metrics.get(unitId);
    const data: UnitCardData = {
      label: metric?.displayName ?? unitId,
      unitKind: metric?.kind ?? "class",
      memberCount: membersByUnit.get(unitId)?.length ?? 0,
      isFrame: false,
    };
    return { id: unitId, parentId: frameId, kind: "unit" as const, isContainer: false, isExpanded: false, depth: 1, childCount: 0, data };
  });
}

interface ClusterDegrees {
  /** lead id → the distinct peer clusters depending on it (afferent). */
  ca: Map<string, Set<string>>;
  /** lead id → the distinct peer clusters it depends on (efferent). */
  ce: Map<string, Set<string>>;
}

/** Fold unit couplings up to cluster pairs to count each cluster's distinct in/out neighbours. */
function clusterDegrees(couplings: Couplings, leadOf: Map<string, string>): ClusterDegrees {
  const ca = new Map<string, Set<string>>();
  const ce = new Map<string, Set<string>>();
  for (const edge of couplings) {
    const sourceLead = leadOf.get(edge.source);
    const targetLead = leadOf.get(edge.target);
    if (sourceLead === undefined || targetLead === undefined || sourceLead === targetLead) {
      continue;
    }
    addTo(ce, sourceLead, targetLead);
    addTo(ca, targetLead, sourceLead);
  }
  return { ca, ce };
}

function addTo(map: Map<string, Set<string>>, from: string, to: string): void {
  const set = map.get(from);
  if (set) {
    set.add(to);
  } else {
    map.set(from, new Set([to]));
  }
}

/**
 * One wire per visible pair. Each coupling endpoint lifts to its VISIBLE representative — its own
 * unit card when its cluster is open, else the cluster's group card. Self-loops (both ends on the
 * same card) drop; pairs aggregate by summing one per underlying coupling. `crossFrame` tracks the
 * TRUE clusters of the underlying units, not their reps, so it stays honest under collapse.
 */
function dependencyEdges(couplings: Couplings, leadOf: Map<string, string>, expanded: ReadonlySet<string>): ModuleTreeEdge[] {
  const repOf = (id: string): string | null => {
    const lead = leadOf.get(id);
    if (lead === undefined) {
      return null; // not a surviving unit — its couplings never chart.
    }
    const frameId = frameIdOf(lead);
    return expanded.has(frameId) ? id : frameId;
  };
  const byPair = new Map<string, ModuleTreeEdge>();
  for (const edge of couplings) {
    const source = repOf(edge.source);
    const target = repOf(edge.target);
    if (source === null || target === null || source === target) {
      continue;
    }
    const key = `${source}->${target}`;
    const existing = byPair.get(key);
    if (existing) {
      existing.weight += 1;
      continue;
    }
    byPair.set(key, {
      id: `dep:${key}`,
      source,
      target,
      weight: 1,
      crossFrame: leadOf.get(edge.source) !== leadOf.get(edge.target),
      category: "dep",
    });
  }
  return [...byPair.values()].sort((a, b) => a.id.localeCompare(b.id));
}
