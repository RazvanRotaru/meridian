/**
 * Service-centric composition clustering: each cluster is LED by a domain service and holds the
 * helper sub-services it is composed of (explicit registration/injection/construction — never
 * incidental behavioral calls).
 * Clusters collapse to just the lead card by default; expanding reveals the sub-services it owns.
 * Inter-cluster wires read as "service A depends on service B". This replaces the by-folder tree
 * that produced a single god-service composed of everything.
 *
 * Pure: (nodes, edges, expanded) → {nodes, edges}. No React, no ELK. Emits the same spec shape as
 * compositionGraph so the ELK/React-Flow layout is unchanged.
 */

import type { GraphEdge, GraphNode } from "@meridian/core";
import {
  deriveServiceClusters,
  isUnassignedServiceCluster,
  serviceClusterCount,
  type CouplingEdge,
  type ServiceCluster,
  type ServiceClustering,
  type ServiceMemberFeature,
  type UnitMetrics,
} from "@meridian/design-metrics";
import { sizeFor, type ClusterNodeData, type CompEdgeSpec, type CompNodeData, type CompNodeSpec, type CompositionGraphSpec } from "./compositionGraph";

export {
  deriveServiceClusters,
  isUnassignedServiceCluster,
  serviceClusterCount,
};
export type { ServiceCluster, ServiceClustering };

const NONE_EXPANDED: ReadonlySet<string> = new Set();

export function deriveServiceCompositionGraph(
  nodes: GraphNode[],
  edges: GraphEdge[],
  expanded: ReadonlySet<string> = NONE_EXPANDED,
  showMetrics = true,
): CompositionGraphSpec {
  const { clusters, leadOf, metrics, membersByUnit, couplings } = deriveServiceClusters(nodes, edges);
  if (clusters.length === 0) {
    return { nodes: [], edges: [] };
  }

  return emitSpecs(clusters, leadOf, metrics, membersByUnit, couplings, expanded, showMetrics);
}

function emitSpecs(
  clusters: ServiceCluster[],
  leadOf: Map<string, string>,
  metrics: Map<string, UnitMetrics>,
  membersByUnit: Map<string, ServiceMemberFeature[]>,
  couplings: CouplingEdge[],
  expanded: ReadonlySet<string>,
  showMetrics: boolean,
): CompositionGraphSpec {
  const frames: CompNodeSpec[] = [];
  const units: CompNodeSpec[] = [];
  for (const cluster of clusters) {
    const frameId = `svc-cluster:${cluster.leadId}`;
    const isExpanded = expanded.has(frameId);
    frames.push(frameSpec(cluster, frameId, isExpanded, metrics));
    const shown = isExpanded ? cluster.memberIds : [cluster.leadId];
    for (const id of shown) {
      units.push(unitSpec(metrics.get(id)!, membersByUnit.get(id) ?? [], showMetrics, frameId));
    }
  }
  // Frames precede units so React Flow always sees a parent ahead of its children.
  return { nodes: [...frames, ...units], edges: wireSpecs(couplings, leadOf, expanded) };
}

function frameSpec(cluster: ServiceCluster, frameId: string, isExpanded: boolean, metrics: Map<string, UnitMetrics>): CompNodeSpec {
  const smellyCount = cluster.memberIds.filter((id) => metrics.get(id)!.smells.length > 0).length;
  const data: ClusterNodeData = {
    clusterId: frameId,
    label: metrics.get(cluster.leadId)!.displayName,
    unitCount: cluster.memberIds.length,
    smellyCount,
    expanded: isExpanded,
    collapsedCount: isExpanded ? 0 : cluster.memberIds.length - 1,
    collapsible: cluster.memberIds.length > 1,
    unitIds: cluster.memberIds,
  };
  // No width/height, no parentId: ELK sizes a container from its children, and a frame is a root.
  return { id: frameId, type: "cluster", data };
}

/** A unit scorecard, shaped exactly like compositionGraph's unitNode (never a boundary ghost here). */
function unitSpec(metric: UnitMetrics, members: ServiceMemberFeature[], showMetrics: boolean, frameId: string): CompNodeSpec {
  const memberList = members
    .map((member) => ({ id: member.id, name: member.displayName }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const data: CompNodeData = { unitId: metric.id, kind: metric.kind, label: metric.displayName, metrics: metric, members: memberList, boundary: false };
  const { width, height } = sizeFor(data, showMetrics);
  return { id: metric.id, type: "unit", width, height, parentId: frameId, data };
}

/**
 * One wire per visible pair. Each endpoint is lifted to its VISIBLE representative — its own card
 * when its cluster is expanded, else the cluster's lead card (the only thing painted when collapsed).
 * Self-loops (both ends land on the same card) drop out; the pair dedupes, staying inheritance-only
 * only while no concrete coupling has been seen for it. Cross-boundary tracks the true cluster of the
 * underlying units, not their reps, so it stays honest under collapse.
 */
function wireSpecs(couplings: CouplingEdge[], leadOf: Map<string, string>, expanded: ReadonlySet<string>): CompEdgeSpec[] {
  const repOf = (id: string): string | null => {
    const lead = leadOf.get(id);
    if (lead === undefined) {
      return null;
    }
    return expanded.has(`svc-cluster:${lead}`) ? id : lead;
  };
  const byPair = new Map<string, CompEdgeSpec>();
  for (const edge of couplings) {
    const source = repOf(edge.source);
    const target = repOf(edge.target);
    if (source === null || target === null || source === target) {
      continue;
    }
    const key = `${source}->${target}`;
    const existing = byPair.get(key);
    if (existing) {
      existing.inheritanceOnly = existing.inheritanceOnly && edge.inheritanceOnly;
      continue;
    }
    byPair.set(key, {
      id: `couple:${key}`,
      source,
      target,
      inheritanceOnly: edge.inheritanceOnly,
      crossBoundary: leadOf.get(edge.source) !== leadOf.get(edge.target),
    });
  }
  return [...byPair.values()];
}
