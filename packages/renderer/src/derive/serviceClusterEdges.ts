import type { GraphIndex } from "../graph/graphIndex";
import type { ModuleTreeEdge } from "./moduleTree";
import { clusteringFor } from "./serviceClusteringCache";
import type { ServiceCluster, ServiceClustering } from "./serviceComposition";
import { crossesPackageBoundary } from "./packageBoundary";
import { deriveServiceDomains, isServiceDomainId, serviceDomainById } from "./serviceDomains";
import type { ServiceGroupingMode } from "./serviceClusteringModes";

type Couplings = ServiceClustering["couplings"];

export interface ClusterDegrees {
  ca: Map<string, Set<string>>;
  ce: Map<string, Set<string>>;
}

export function clusterCouplingEdges(
  couplings: Couplings,
  leadOf: Map<string, string>,
  visibleIds: ReadonlySet<string>,
  index: GraphIndex,
  domainIdByLead: ReadonlyMap<string, string> = EMPTY_DOMAIN_IDS,
): ModuleTreeEdge[] {
  const byPair = new Map<string, ModuleTreeEdge>();
  for (const edge of couplings) {
    const source = representative(edge.source, leadOf, visibleIds, domainIdByLead);
    const target = representative(edge.target, leadOf, visibleIds, domainIdByLead);
    if (source === null || target === null || source === target || (!isServiceContainer(source) && !isServiceContainer(target))) {
      continue;
    }
    const crossFrame = leadOf.get(edge.source) !== leadOf.get(edge.target);
    const crossPackage = crossesPackageBoundary(edge.source, edge.target, index);
    for (const [kind, evidence] of couplingEvidence(edge)) {
      const key = `${kind}:${source}->${target}`;
      const existing = byPair.get(key);
      if (existing) {
        existing.weight += evidence.weight;
        existing.crossFrame = existing.crossFrame || crossFrame;
        existing.crossPackage ||= crossPackage;
        existing.underlyingEdgeIds = uniqueIds(existing.underlyingEdgeIds, evidence.underlyingEdgeIds);
      } else {
        byPair.set(key, {
          id: `dep:${key}`,
          source,
          target,
          weight: evidence.weight,
          crossFrame,
          crossPackage,
          outsideView: false,
          category: "dep",
          relationKind: kind,
          depKind: kind,
          underlyingEdgeIds: [...evidence.underlyingEdgeIds],
        });
      }
    }
  }
  return [...byPair.values()];
}

interface KindEvidence {
  weight: number;
  underlyingEdgeIds: readonly string[];
}

/** Compatibility for hand-built/test couplings predating evidence retention: every declared kind
 * still becomes its own typed wire, with a unit weight and no fabricated source attribution. */
function couplingEvidence(edge: Couplings[number]): Array<[string, KindEvidence]> {
  return [...edge.kinds]
    .sort()
    .map((kind) => [kind, edge.evidenceByKind?.get(kind) ?? { weight: 1, underlyingEdgeIds: [] }]);
}

function uniqueIds(existing: readonly string[] | undefined, incoming: readonly string[]): string[] {
  return [...new Set([...(existing ?? []), ...incoming])];
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
  // A service frame is an artificial parent even when it contains only its lead class. Keeping a
  // one-member frame expandable is what lets cross-lens reveal paint the exact selected class id;
  // opening it still exposes only that direct child, never the class's methods in the same action.
  return cluster.memberIds.length > 0 && expanded.has(frameIdOf(cluster.leadId));
}

/** Decompose selected `svc:` frames and synthetic domains into their represented cluster members
 * (both are pseudo-ids absent from the graph), then land every id on its home FILE —
 * `buildMinimalSubgraph` draws file ("module") and folder boxes, so a bare unit id would chart as
 * a bogus zero-file package card. Module/package ids pass through unchanged; an unknown frame
 * contributes nothing. Union, deduped, selection-ordered — the minimal-graph seed translation for
 * the Service lens. */
export function clusterMemberSeeds(
  selection: readonly string[],
  index: GraphIndex,
  groupingMode?: ServiceGroupingMode,
  groupingTargetSize?: number,
): string[] {
  const clustering = clusteringFor(index);
  const { clusters } = clustering;
  const domains = deriveServiceDomains(clustering, groupingMode, groupingTargetSize);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of selection) {
    const lead = leadIdOf(id);
    const domain = serviceDomainById(domains, id);
    const ids = lead !== null
      ? (clusters.find((cluster) => cluster.leadId === lead)?.memberIds ?? [])
      : domain
        ? domain.leadIds.flatMap((domainLead) => clusters.find((cluster) => cluster.leadId === domainLead)?.memberIds ?? [])
        : isServiceDomainId(id)
          ? [] // a stale/unknown synthetic domain never leaks into the artifact-only overlay
          : [id];
    for (const member of ids.map((memberId) => homeFileOf(memberId, index))) {
      if (!seen.has(member)) {
        seen.add(member);
        out.push(member);
      }
    }
  }
  return out;
}

/** Translate Service-only synthetic selections at a real-artifact action boundary. The live
 * canvas keeps one logical selected domain; cross-lens reveal expands it to its real lead units. */
export function expandServiceSyntheticAnchors(
  ids: readonly string[],
  index: GraphIndex,
  groupingMode?: ServiceGroupingMode,
  groupingTargetSize?: number,
): string[] {
  const clustering = clusteringFor(index);
  const domains = deriveServiceDomains(clustering, groupingMode, groupingTargetSize);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    const lead = leadIdOf(id);
    const domain = serviceDomainById(domains, id);
    const expanded = lead !== null ? [lead] : domain ? domain.leadIds : isServiceDomainId(id) ? [] : [id];
    for (const anchor of expanded) {
      if (!seen.has(anchor)) {
        seen.add(anchor);
        out.push(anchor);
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

function representative(
  id: string,
  leadOf: Map<string, string>,
  visibleIds: ReadonlySet<string>,
  domainIdByLead: ReadonlyMap<string, string>,
): string | null {
  if (visibleIds.has(id)) {
    return id;
  }
  const lead = leadOf.get(id);
  if (lead === undefined) {
    return null;
  }
  const frame = frameIdOf(lead);
  if (visibleIds.has(frame)) {
    return frame;
  }
  const domain = domainIdByLead.get(lead);
  return domain !== undefined && visibleIds.has(domain) ? domain : null;
}

function isServiceContainer(id: string): boolean {
  return leadIdOf(id) !== null || isServiceDomainId(id);
}

const EMPTY_DOMAIN_IDS: ReadonlyMap<string, string> = new Map<string, string>();

function addTo(map: Map<string, Set<string>>, from: string, to: string): void {
  const set = map.get(from);
  if (set) {
    set.add(to);
  } else {
    map.set(from, new Set([to]));
  }
}
