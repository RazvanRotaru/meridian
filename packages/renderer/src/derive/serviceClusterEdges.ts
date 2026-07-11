import type { GraphIndex } from "../graph/graphIndex";
import type { ModuleTreeEdge } from "./moduleTree";
import { clusteringFor } from "./serviceClusteringCache";
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

/** The scoped Service sub-view's lead set: the owning leads plus every cluster coupled to them in
 * EITHER direction. Couplings are unit-level, so each endpoint lifts through `leadOf` first; only
 * neighbours of the OWNING leads join (1-hop, not transitive). Sorted for a deterministic scope. */
export function coupledLeadNeighbourhood(owningLeads: readonly string[], couplings: Couplings, leadOf: Map<string, string>): string[] {
  const owning = new Set(owningLeads);
  const scope = new Set(owningLeads);
  for (const edge of couplings) {
    const sourceLead = leadOf.get(edge.source);
    const targetLead = leadOf.get(edge.target);
    if (sourceLead === undefined || targetLead === undefined || sourceLead === targetLead) {
      continue;
    }
    if (owning.has(sourceLead)) {
      scope.add(targetLead);
    }
    if (owning.has(targetLead)) {
      scope.add(sourceLead);
    }
  }
  return [...scope].sort();
}

export function frameIdOf(leadId: string): string {
  return `svc:${leadId}`;
}

/** The inverse of `frameIdOf`: the lead unit id a `svc:` frame names, null for any other id — so the
 * `svc:` grammar stays known in this one module and callers can map a selected cluster frame (a
 * pseudo-id absent from the graph) back onto a real, placeable node. */
export function leadIdOf(frameId: string): string | null {
  return frameId.startsWith("svc:") ? frameId.slice("svc:".length) : null;
}

export function isOpen(cluster: ServiceCluster, expanded: ReadonlySet<string>): boolean {
  return cluster.memberIds.length > 1 && expanded.has(frameIdOf(cluster.leadId));
}

/** Decompose selected `svc:` frames into their cluster's members (a frame is a pseudo-id absent
 * from the graph, so nothing downstream could draw it), then land every id on its home FILE —
 * `buildMinimalSubgraph` draws file ("module") and folder boxes, so a bare unit id would chart as
 * a bogus zero-file package card. Module/package ids pass through unchanged; an unknown frame
 * contributes nothing. Union, deduped, selection-ordered — the minimal-graph seed translation for
 * the Service lens. */
export function clusterMemberSeeds(selection: readonly string[], index: GraphIndex): string[] {
  const { clusters } = clusteringFor(index);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of selection) {
    const lead = leadIdOf(id);
    const ids = lead === null ? [id] : (clusters.find((cluster) => cluster.leadId === lead)?.memberIds ?? []);
    for (const member of ids.map((memberId) => homeFileOf(memberId, index))) {
      if (!seen.has(member)) {
        seen.add(member);
        out.push(member);
      }
    }
  }
  return out;
}

/** A member unit's home FILE: the nearest module-kind ancestor-or-self. Ids with none (a folder,
 * an id the graph doesn't know) pass through unchanged. Exported for the UI lens's minimal-graph
 * seeds, which land component/unit selections on their home files the same way. */
export function homeFileOf(id: string, index: GraphIndex): string {
  const ancestors = index.ancestorsOf(id);
  for (let i = ancestors.length - 1; i >= 0; i -= 1) {
    if (ancestors[i].kind === "module") {
      return ancestors[i].id;
    }
  }
  return id;
}

function representative(id: string, leadOf: Map<string, string>, visibleIds: ReadonlySet<string>): string | null {
  if (visibleIds.has(id)) {
    return id;
  }
  const lead = leadOf.get(id);
  return lead === undefined ? null : frameIdOf(lead);
}

function isServiceFrame(id: string): boolean {
  return leadIdOf(id) !== null;
}

function addTo(map: Map<string, Set<string>>, from: string, to: string): void {
  const set = map.get(from);
  if (set) {
    set.add(to);
  } else {
    map.set(from, new Set([to]));
  }
}
