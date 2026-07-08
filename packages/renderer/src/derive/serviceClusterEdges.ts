import type { ModuleTreeEdge } from "./moduleTree";
import type { ServiceCluster, ServiceClustering } from "./serviceComposition";

type Couplings = ServiceClustering["couplings"];

export interface ClusterDegrees {
  ca: Map<string, Set<string>>;
  ce: Map<string, Set<string>>;
}

export function clusterCouplingEdges(couplings: Couplings, leadOf: Map<string, string>, visibleIds: ReadonlySet<string>): ModuleTreeEdge[] {
  const byPair = new Map<string, ModuleTreeEdge>();
  for (const edge of couplings) {
    const source = representative(edge.source, leadOf, visibleIds);
    const target = representative(edge.target, leadOf, visibleIds);
    if (source === null || target === null || source === target || (!isServiceFrame(source) && !isServiceFrame(target))) {
      continue;
    }
    const key = `${source}->${target}`;
    const crossFrame = leadOf.get(edge.source) !== leadOf.get(edge.target);
    const existing = byPair.get(key);
    if (existing) {
      existing.weight += 1;
      existing.crossFrame = existing.crossFrame || crossFrame;
    } else {
      byPair.set(key, { id: `dep:${key}`, source, target, weight: 1, crossFrame, category: "dep" });
    }
  }
  return [...byPair.values()];
}

export function clusterDegrees(couplings: Couplings, leadOf: Map<string, string>): ClusterDegrees {
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

export function frameIdOf(leadId: string): string {
  return `svc:${leadId}`;
}

export function isOpen(cluster: ServiceCluster, expanded: ReadonlySet<string>): boolean {
  return cluster.memberIds.length > 1 && expanded.has(frameIdOf(cluster.leadId));
}

function representative(id: string, leadOf: Map<string, string>, visibleIds: ReadonlySet<string>): string | null {
  if (visibleIds.has(id)) {
    return id;
  }
  const lead = leadOf.get(id);
  return lead === undefined ? null : frameIdOf(lead);
}

function isServiceFrame(id: string): boolean {
  return id.startsWith("svc:");
}

function addTo(map: Map<string, Set<string>>, from: string, to: string): void {
  const set = map.get(from);
  if (set) {
    set.add(to);
  } else {
    map.set(from, new Set([to]));
  }
}
