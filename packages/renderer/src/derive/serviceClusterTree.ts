/**
 * Service-composition as a Module-map lens: service clusters become expandable in-place group
 * cards, so the "call" tab can reuse the Map's layout, chrome, node components, and paint passes.
 * The only difference from the folder map is the derive: lead services own helper sub-services,
 * and dependency couplings lift to each cluster's visible representative.
 */

import type { GraphEdge, GraphNode } from "@meridian/core";
import { deriveServiceClusters, type ServiceCluster, type ServiceClustering } from "./serviceComposition";
import type { ModuleGroupData, ModuleTreeEdge, VisibleModuleNode } from "./moduleTree";
import type { UnitCardData } from "./moduleLevel";

type Couplings = ServiceClustering["couplings"];

export function deriveServiceTree(
  nodes: GraphNode[],
  edges: GraphEdge[],
  expanded: ReadonlySet<string>,
): { nodes: VisibleModuleNode[]; edges: ModuleTreeEdge[] } {
  const clustering = deriveServiceClusters(nodes, edges);
  if (clustering.clusters.length === 0) {
    return { nodes: [], edges: [] };
  }
  const degrees = clusterDegrees(clustering.couplings, clustering.leadOf);
  return {
    nodes: visibleNodes(clustering, degrees, expanded),
    edges: dependencyEdges(clustering, expanded),
  };
}

function visibleNodes(
  clustering: ServiceClustering,
  degrees: ClusterDegrees,
  expanded: ReadonlySet<string>,
): VisibleModuleNode[] {
  const out: VisibleModuleNode[] = [];
  for (const cluster of clustering.clusters) {
    out.push(groupNode(cluster, clustering, degrees, expanded));
    if (isOpen(cluster, expanded)) {
      for (const unitId of cluster.memberIds) {
        out.push(memberNode(unitId, frameIdOf(cluster.leadId), clustering));
      }
    }
  }
  return out;
}

function groupNode(
  cluster: ServiceCluster,
  clustering: ServiceClustering,
  degrees: ClusterDegrees,
  expanded: ReadonlySet<string>,
): VisibleModuleNode {
  const memberCount = cluster.memberIds.length;
  const isContainer = memberCount > 1;
  const isExpanded = isOpen(cluster, expanded);
  const metric = clustering.metrics.get(cluster.leadId);
  const data: ModuleGroupData = {
    label: metric?.displayName ?? cluster.leadId,
    fileCount: memberCount,
    ca: degrees.ca.get(cluster.leadId)?.size ?? 0,
    ce: degrees.ce.get(cluster.leadId)?.size ?? 0,
    isContainer,
    isExpanded,
  };
  return {
    id: frameIdOf(cluster.leadId),
    parentId: null,
    kind: "package",
    isContainer,
    isExpanded,
    depth: 0,
    childCount: memberCount,
    data,
  };
}

function memberNode(unitId: string, frameId: string, clustering: ServiceClustering): VisibleModuleNode {
  const metric = clustering.metrics.get(unitId);
  const data: UnitCardData = {
    label: metric?.displayName ?? unitId,
    unitKind: metric?.kind ?? "class",
    memberCount: metric?.members ?? 0,
    isFrame: false,
  };
  return {
    id: unitId,
    parentId: frameId,
    kind: "unit",
    isContainer: false,
    isExpanded: false,
    depth: 1,
    childCount: 0,
    data,
  };
}

function isOpen(cluster: ServiceCluster, expanded: ReadonlySet<string>): boolean {
  return cluster.memberIds.length > 1 && expanded.has(frameIdOf(cluster.leadId));
}

function frameIdOf(leadId: string): string {
  return `svc:${leadId}`;
}

interface ClusterDegrees {
  ca: Map<string, Set<string>>;
  ce: Map<string, Set<string>>;
}

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

function dependencyEdges(clustering: ServiceClustering, expanded: ReadonlySet<string>): ModuleTreeEdge[] {
  const openLeads = new Set(clustering.clusters.filter((cluster) => isOpen(cluster, expanded)).map((cluster) => cluster.leadId));
  const byPair = new Map<string, ModuleTreeEdge>();
  for (const edge of clustering.couplings) {
    const sourceLead = clustering.leadOf.get(edge.source);
    const targetLead = clustering.leadOf.get(edge.target);
    if (sourceLead === undefined || targetLead === undefined) {
      continue;
    }
    const source = openLeads.has(sourceLead) ? edge.source : frameIdOf(sourceLead);
    const target = openLeads.has(targetLead) ? edge.target : frameIdOf(targetLead);
    if (source === target) {
      continue;
    }
    const key = `${source}->${target}`;
    const crossFrame = sourceLead !== targetLead;
    const existing = byPair.get(key);
    if (existing) {
      existing.weight += 1;
      existing.crossFrame = existing.crossFrame || crossFrame;
    } else {
      byPair.set(key, { id: `dep:${key}`, source, target, weight: 1, crossFrame, category: "dep" });
    }
  }
  return [...byPair.values()].sort((a, b) => a.id.localeCompare(b.id));
}
