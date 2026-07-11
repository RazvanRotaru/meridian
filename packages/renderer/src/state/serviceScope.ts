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

/** Widen a live scope by extra owning leads — a ghost reveal into a scoped-OUT cluster must draw
 * the frame it opens, so the reveal grows the kept set instead of silently opening nothing. Null
 * (unscoped) stays null; an already-covering scope returns unchanged; the label deliberately keeps
 * naming the ORIGINAL owner (the trail still says where the scope came from), but its "(+K)" is
 * recounted from the widened set so the trail never under-reports what is drawn. */
export function widenServiceScope(scope: ServiceScope | null, owningLeads: readonly string[]): ServiceScope | null {
  if (scope === null) {
    return null;
  }
  const missing = owningLeads.filter((lead) => !scope.leadIds.includes(lead));
  if (missing.length === 0) {
    return scope;
  }
  const leadIds = [...scope.leadIds, ...missing].sort();
  return { leadIds, label: recountedLabel(scope.label, leadIds.length) };
}

/** Strip a label's old " (+K)" suffix and re-derive it from the widened scope size. */
function recountedLabel(label: string, scopeSize: number): string {
  const name = label.replace(/ \(\+\d+\)$/, "");
  return scopeSize > 1 ? `${name} (+${scopeSize - 1})` : name;
}

/** The breadcrumb trail's name for a scope: the first OWNING lead's display name, "+K" counting
 * every other cluster in scope (owning siblings and coupled neighbours alike). */
function scopeLabel(leadId: string, scopeSize: number, clustering: ServiceClustering): string {
  const name = clustering.metrics.get(leadId)?.displayName ?? leadId;
  return scopeSize > 1 ? `${name} (+${scopeSize - 1})` : name;
}
