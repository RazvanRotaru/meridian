/**
 * The Service lens's scoped sub-view slice: the scope's shape, how a set of owning cluster leads
 * grows into the drawn scope (owning clusters + their 1-hop coupled neighbours), and how the derive
 * reads it. Session-only state — deliberately never URL-round-tripped (YAGNI until asked) — so the
 * store keeps only thin actions over these helpers.
 */

import type { GraphIndex } from "../graph/graphIndex";
import { coupledLeadNeighbourhood } from "../derive/serviceClusterEdges";
import { clusteringFor } from "../derive/serviceClusteringCache";
import type { ServiceClustering } from "../derive/serviceComposition";

/** The scoped Service sub-view: only these cluster leads (the anchors' owning clusters + their
 * 1-hop coupled neighbours) are drawn; `label` names the trail in the breadcrumb exit. */
export interface ServiceScope {
  leadIds: string[];
  label: string;
}

/** Grow the anchors' OWNING leads into the scope actually drawn: the owning clusters plus every
 * cluster coupled to them in EITHER direction (1-hop), labelled after the first owning lead. Reads
 * the same cached clustering as the lens derive, so scope and canvas can never disagree. */
export function serviceScopeFor(owningLeads: readonly string[], index: GraphIndex): ServiceScope {
  const clustering = clusteringFor(index);
  const leadIds = coupledLeadNeighbourhood(owningLeads, clustering.couplings, clustering.leadOf);
  return { leadIds, label: scopeLabel(owningLeads[0], leadIds.length, clustering) };
}

/** The scoped Service sub-view's cluster-lead set for the derive, or undefined == the full lens. */
export function scopeSetOf(scope: ServiceScope | null): ReadonlySet<string> | undefined {
  return scope === null ? undefined : new Set(scope.leadIds);
}

/** The breadcrumb trail's name for a scope: the first OWNING lead's display name, "+K" counting
 * every other cluster in scope (owning siblings and coupled neighbours alike). */
function scopeLabel(leadId: string, scopeSize: number, clustering: ServiceClustering): string {
  const name = clustering.metrics.get(leadId)?.displayName ?? leadId;
  return scopeSize > 1 ? `${name} (+${scopeSize - 1})` : name;
}
