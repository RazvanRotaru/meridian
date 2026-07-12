/**
 * Service-composition as a Module-map lens: service clusters become expandable in-place group
 * cards, so the "call" tab reuses the Map layout, chrome, node components, and paint passes.
 *
 * Open clusters delegate every member to `codeWalk`, which is why a service member renders exactly
 * like that same node under an expanded file in the Map tab. The lens shares the Map's whole focus
 * and ghost vocabulary (unified-canvas phase B):
 *
 *   - FOCUS is containment zoom into one synthetic domain or one `svc:` cluster. A domain focus
 *     draws its service cards flat; a service focus draws that frame force-expanded.
 *   - GHOSTS chart every coupling the canvas cannot represent (`serviceGhosts.ts`): off-zoom /
 *     out-of-scope clusters, and code-level deps whose cluster frame is not drawn. Ghost ids are
 *     real artifact ids; `hiddenIds` (the Tests toggle) filters them exactly like the Map's tier.
 *
 * Cluster coupling wires lift to the nearest visible service/domain container; drawn-to-drawn code
 * pairs are handled by `depWireEdges`, avoiding a duplicate wire.
 */

import type { LogicFlows } from "@meridian/core";
import type { GraphIndex } from "../graph/graphIndex";
import { createCodeWalk, depWireEdges, flowChainEdges, stepCallEdges, visitCode, type CodeWalk, type Skeleton } from "./codeWalk";
import type { ModuleGraph } from "./moduleGraph";
import type { BlockDeps } from "./blockDeps";
import type { ServiceClustering } from "./serviceComposition";
import type { ServiceGroupingLabelMode, ServiceGroupingMode } from "./serviceClusteringModes";
import { clusteringFor } from "./serviceClusteringCache";
import type { ModuleTree } from "./moduleTree";
import { clusterCouplingEdges, clusterDegrees, frameIdOf, isOpen, leadIdOf } from "./serviceClusterEdges";
import { finalizeServiceDomainNode, finalizeServiceNode } from "./serviceClusterData";
import { serviceGhostTier } from "./serviceGhosts";
import {
  deriveServiceDomains,
  serviceDomainById,
  shouldGroupServiceDomains,
  visibleServiceDomains,
  type ServiceDomain,
  type ServiceDomainModel,
} from "./serviceDomains";

export interface ServiceTreeOptions {
  /** The scoped sub-view's kept cluster leads; undefined == the full lens. */
  scopeLeadIds?: ReadonlySet<string>;
  /** Palette-pinned (⌘P "+") extra top-level cards. */
  extraIds?: ReadonlySet<string>;
  /** The Tests toggle's hidden set — filters the GHOST tier (the walk itself never hid tests on
   * this lens; that stands — test members hide at paint time like before). */
  hiddenIds?: ReadonlySet<string>;
  /** Full-system parent assignment used only by the dense unscoped overview. */
  groupingMode?: ServiceGroupingMode;
  /** Preferred member count for balanced parent-assignment strategies. */
  groupingTargetSize?: number;
  /** Whether inferred parent names show one semantic term or the top pair. */
  groupingLabelMode?: ServiceGroupingLabelMode;
}

export function deriveServiceTree(
  index: GraphIndex,
  focus: string | null,
  expanded: ReadonlySet<string>,
  graph: ModuleGraph,
  blockDeps: BlockDeps,
  flows: LogicFlows,
  options: ServiceTreeOptions = {},
): ModuleTree {
  // The memoized clustering (keyed by the index) — the SAME object the lens-carry and the scoped
  // sub-view's lead resolution read, so a relayout never re-clusters and scope leads always match.
  const full = clusteringFor(index);
  const scoped = scopedTo(full, options.scopeLeadIds);
  const domainModel = deriveServiceDomains(
    full,
    options.groupingMode,
    options.groupingTargetSize,
    options.groupingLabelMode,
  );
  const groupsDomains = shouldGroupServiceDomains(full);
  const focusLead = resolveFocusLead(focus, scoped);
  const focusDomain = resolveFocusDomain(focus, scoped, domainModel, groupsDomains);
  // FOCUS zooms INSIDE whatever the scope kept: a service narrows to one cluster; a synthetic
  // domain narrows to that domain's service leads and drops its own wrapper, like a Map folder dive.
  const clustering = focusLead !== null
    ? scopedTo(scoped, new Set([focusLead]))
    : focusDomain !== null
      ? scopedTo(scoped, new Set(focusDomain.leadIds))
      : scoped;
  if (clustering.clusters.length === 0) {
    return { nodes: [], edges: [], effectiveFocus: null };
  }
  // Badges read at SCOPE level (never the zoom): diving must not re-count a cluster's neighbours.
  const degrees = clusterDegrees(scoped.couplings, scoped.leadOf);
  const visibleDomains = visibleServiceDomains(clustering.clusters, domainModel);
  // The close-up view was already good: focused/small scopes stay flat. Domain frames solve only
  // the dense overview where spatial responsibility areas otherwise disappear.
  const domains = focusLead === null
    && focusDomain === null
    && options.scopeLeadIds === undefined
    && groupsDomains
    && visibleDomains.length > 0
    ? visibleDomains
    : [];
  const walk = serviceWalk(clustering, index, expanded, flows, focusLead, domains);
  // Palette-pinned nodes (⌘P "+") ride in as EXTRA top-level cards — a unit/file/block that isn't
  // inside an expanded cluster still joins the canvas. Already-visited ids (a member of an open
  // cluster) are dropped by the walk's `seen` guard.
  appendExtras(walk, options.extraIds ?? EMPTY_IDS, index, expanded, flows);
  const visibleIds = new Set(walk.skeleton.map((entry) => entry.id));
  const kinds = kindsOf(walk.skeleton);
  const isCode = (id: string) => kinds.get(id) === "unit" || kinds.get(id) === "block";
  const domainById = new Map(domains.map((domain) => [domain.id, domain]));
  const domainIdByLead = new Map([...domainModel.domainByLead].map(([lead, domain]) => [lead, domain.id]));
  const nodes = walk.skeleton.map((entry) => {
    const domain = domainById.get(entry.id);
    return domain
      ? finalizeServiceDomainNode(entry, domain)
      : finalizeServiceNode(entry, clustering, degrees, index, graph, walk);
  });
  const drawnLeads = new Set(clustering.clusters.map((cluster) => cluster.leadId));
  const ghosts = serviceGhostTier(full, drawnLeads, blockDeps, walk, visibleIds, index, kinds, domainIdByLead, options.hiddenIds ?? EMPTY_IDS);
  const edges = [
    ...clusterCouplingEdges(clustering.couplings, clustering.leadOf, visibleIds, index, domainIdByLead),
    ...depWireEdges(blockDeps, visibleIds, index, isCode, walk.expandedBlocks),
    ...flowChainEdges(walk),
    ...stepCallEdges(walk, visibleIds, index),
    ...ghosts.edges,
  ].sort((a, b) => a.id.localeCompare(b.id));
  return {
    nodes: [...nodes, ...ghosts.nodes],
    edges,
    effectiveFocus: focusLead !== null ? frameIdOf(focusLead) : focusDomain?.id ?? null,
  };
}

/**
 * The scoped Service sub-view: keep only the clusters whose lead is in scope, and only the
 * couplings whose BOTH endpoints lift (via leadOf) into scope. An edge touching an out-of-scope
 * cluster leaves this set and is GHOSTED by `serviceGhostTier` — the dropped fact still charts,
 * as a dashed lead card, never a silent hole.
 */
function scopedTo(clustering: ServiceClustering, scopeLeadIds: ReadonlySet<string> | undefined): ServiceClustering {
  if (scopeLeadIds === undefined) {
    return clustering;
  }
  const inScope = (unitId: string) => {
    const lead = clustering.leadOf.get(unitId);
    return lead !== undefined && scopeLeadIds.has(lead);
  };
  return {
    ...clustering,
    clusters: clustering.clusters.filter((cluster) => scopeLeadIds.has(cluster.leadId)),
    couplings: clustering.couplings.filter((edge) => inScope(edge.source) && inScope(edge.target)),
  };
}

/** The focused cluster's lead: a `svc:` focus id resolving to a cluster the scope kept; anything
 * else — a folder id another lens left behind, a stale frame — is ignored (full lens). */
function resolveFocusLead(focus: string | null, clustering: ServiceClustering): string | null {
  const lead = focus === null ? null : leadIdOf(focus);
  if (lead === null) {
    return null;
  }
  return clustering.clusters.some((cluster) => cluster.leadId === lead) ? lead : null;
}

/** A focused synthetic domain, restricted to the leads the current Service scope kept. */
function resolveFocusDomain(
  focus: string | null,
  clustering: ServiceClustering,
  model: ServiceDomainModel,
  groupsDomains: boolean,
): ServiceDomain | null {
  if (focus === null || !groupsDomains) {
    return null;
  }
  const domain = serviceDomainById(model, focus);
  if (!domain) {
    return null;
  }
  const scopedLeads = new Set(clustering.clusters.map((cluster) => cluster.leadId));
  const leadIds = domain.leadIds.filter((lead) => scopedLeads.has(lead));
  return leadIds.length > 0 ? { ...domain, leadIds } : null;
}

/** A shared empty set so the default option arguments never allocate per call. */
const EMPTY_IDS: ReadonlySet<string> = new Set<string>();

/** Draw each palette-pinned id as a detached top-level card (unit/file/block), reusing `visitCode` so
 * it renders like the same node on the Map. Every level respects the explicit expansion set: opening
 * a file reveals collapsed declarations, never their members in the same action. Non-drawable or
 * already-visited ids are skipped. */
function appendExtras(walk: CodeWalk, extraIds: ReadonlySet<string>, index: GraphIndex, expanded: ReadonlySet<string>, flows: LogicFlows): void {
  const ctx = { index, expanded, flows };
  for (const id of [...extraIds].sort()) {
    if (walk.seen.has(id) || !index.nodesById.has(id)) {
      continue;
    }
    visitCode(id, null, 0, ctx, walk);
  }
}

function serviceWalk(
  clustering: ServiceClustering,
  index: GraphIndex,
  expanded: ReadonlySet<string>,
  flows: LogicFlows,
  focusLead: string | null,
  domains: readonly ServiceDomain[],
): CodeWalk {
  const walk = createCodeWalk();
  // A service frame reveals exactly its direct members. Member-bearing units stay collapsed until
  // the reader explicitly expands them, matching the one-level contract of every other container.
  const ctx = { index, expanded, flows };
  const clustersByLead = new Map(clustering.clusters.map((cluster) => [cluster.leadId, cluster]));
  const emitCluster = (cluster: ServiceClustering["clusters"][number], parentId: string | null, depth: number) => {
    const frameId = frameIdOf(cluster.leadId);
    // Every synthetic service frame is a real container, including a one-member cluster. The
    // collapsed frame remains the overview summary; opening it reveals the lead class as its one
    // direct child so selection/reveal can preserve that exact artifact id across lenses.
    const isFocus = cluster.leadId === focusLead;
    const isContainer = cluster.memberIds.length > 0;
    const isExpanded = isFocus ? isContainer : isOpen(cluster, expanded);
    walk.skeleton.push({
      id: frameId,
      parentId,
      kind: "package",
      isContainer,
      isExpanded,
      depth,
      childCount: cluster.memberIds.length,
    });
    if (isExpanded) {
      cluster.memberIds.slice().sort().forEach((id) => visitCode(id, frameId, depth + 1, ctx, walk));
    }
  };
  if (domains.length === 0) {
    [...clustering.clusters]
      .sort((a, b) => a.leadId.localeCompare(b.leadId))
      .forEach((cluster) => emitCluster(cluster, null, 0));
    return walk;
  }
  for (const domain of domains) {
    const isExpanded = expanded.has(domain.id);
    walk.skeleton.push({
      id: domain.id,
      parentId: null,
      kind: "serviceDomain",
      isContainer: true,
      isExpanded,
      depth: 0,
      childCount: domain.leadIds.length,
    });
    if (isExpanded) {
      domain.leadIds.forEach((leadId) => {
        const cluster = clustersByLead.get(leadId);
        if (cluster) emitCluster(cluster, domain.id, 1);
      });
    }
  }
  return walk;
}

function kindsOf(skeleton: Skeleton[]): Map<string, Skeleton["kind"]> {
  return new Map(skeleton.map((entry) => [entry.id, entry.kind]));
}
