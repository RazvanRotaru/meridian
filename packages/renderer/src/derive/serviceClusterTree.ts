/**
 * Service-composition as a Module-map lens: service clusters become expandable in-place group
 * cards, so the "call" tab reuses the Map layout, chrome, node components, and paint passes.
 *
 * Open clusters delegate every member to `codeWalk`, which is why a service member renders exactly
 * like that same node under an expanded file in the Map tab. The lens shares the Map's whole focus
 * and ghost vocabulary (unified-canvas phase B):
 *
 *   - FOCUS is the containment zoom into ONE cluster: a `svc:` focus draws only that cluster's
 *     frame, force-expanded, and flows out as `effectiveFocus` for the breadcrumb. Any other focus
 *     id (a folder left by another lens, a stale frame) is ignored — full lens.
 *   - GHOSTS chart every coupling the canvas cannot represent (`serviceGhosts.ts`): off-zoom /
 *     out-of-scope clusters, and code-level deps whose cluster frame is not drawn. Ghost ids are
 *     real artifact ids; `hiddenIds` (the Tests toggle) filters them exactly like the Map's tier.
 *
 * Cluster coupling wires only emit when at least one endpoint is a `svc:` frame; drawn-to-drawn
 * code pairs are handled by `depWireEdges`, avoiding a duplicate wire.
 */

import type { LogicFlows } from "@meridian/core";
import type { GraphIndex } from "../graph/graphIndex";
import { createCodeWalk, depWireEdges, flowChainEdges, stepCallEdges, visitCode, type CodeWalk, type Skeleton } from "./codeWalk";
import type { ModuleGraph } from "./moduleGraph";
import type { BlockDeps } from "./blockDeps";
import type { ServiceClustering } from "./serviceComposition";
import { clusteringFor } from "./serviceClusteringCache";
import type { ModuleTree } from "./moduleTree";
import { clusterCouplingEdges, clusterDegrees, frameIdOf, isOpen, leadIdOf } from "./serviceClusterEdges";
import { finalizeServiceNode } from "./serviceClusterData";
import { serviceGhostTier } from "./serviceGhosts";

export interface ServiceTreeOptions {
  /** The scoped sub-view's kept cluster leads; undefined == the full lens. */
  scopeLeadIds?: ReadonlySet<string>;
  /** Palette-pinned (⌘P "+") extra top-level cards. */
  extraIds?: ReadonlySet<string>;
  /** The Tests toggle's hidden set — filters the GHOST tier (the walk itself never hid tests on
   * this lens; that stands — test members hide at paint time like before). */
  hiddenIds?: ReadonlySet<string>;
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
  const focusLead = resolveFocusLead(focus, scoped);
  // FOCUS zooms INSIDE whatever the scope kept: the drawn set narrows to the one dived cluster.
  const clustering = focusLead === null ? scoped : scopedTo(scoped, new Set([focusLead]));
  if (clustering.clusters.length === 0) {
    return { nodes: [], edges: [], effectiveFocus: null };
  }
  // Badges read at SCOPE level (never the zoom): diving must not re-count a cluster's neighbours.
  const degrees = clusterDegrees(scoped.couplings, scoped.leadOf);
  const walk = serviceWalk(clustering, index, expanded, flows, focusLead);
  // Palette-pinned nodes (⌘P "+") ride in as EXTRA top-level cards — a unit/file/block that isn't
  // inside an expanded cluster still joins the canvas. Already-visited ids (a member of an open
  // cluster) are dropped by the walk's `seen` guard.
  appendExtras(walk, options.extraIds ?? EMPTY_IDS, index, expanded, flows);
  const visibleIds = new Set(walk.skeleton.map((entry) => entry.id));
  const kinds = kindsOf(walk.skeleton);
  const isCode = (id: string) => kinds.get(id) === "unit" || kinds.get(id) === "block";
  const nodes = walk.skeleton.map((entry) => finalizeServiceNode(entry, clustering, degrees, index, graph, walk));
  const drawnLeads = new Set(clustering.clusters.map((cluster) => cluster.leadId));
  const ghosts = serviceGhostTier(full, drawnLeads, blockDeps, walk, visibleIds, index, kinds, options.hiddenIds ?? EMPTY_IDS);
  const edges = [
    ...clusterCouplingEdges(clustering.couplings, clustering.leadOf, visibleIds),
    ...depWireEdges(blockDeps, visibleIds, index, isCode, walk.expandedBlocks),
    ...flowChainEdges(walk),
    ...stepCallEdges(walk, visibleIds, index),
    ...ghosts.edges,
  ].sort((a, b) => a.id.localeCompare(b.id));
  return { nodes: [...nodes, ...ghosts.nodes], edges, effectiveFocus: focusLead === null ? null : frameIdOf(focusLead) };
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

/** A shared empty set so the default option arguments never allocate per call. */
const EMPTY_IDS: ReadonlySet<string> = new Set<string>();

/** Draw each palette-pinned id as a detached top-level card (unit/file/block), reusing `visitCode` so
 * it renders exactly like an in-cluster member. Non-drawable or already-visited ids are skipped. */
function appendExtras(walk: CodeWalk, extraIds: ReadonlySet<string>, index: GraphIndex, expanded: ReadonlySet<string>, flows: LogicFlows): void {
  const ctx = { index, expanded, flows, unitsAlwaysOpen: true };
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
): CodeWalk {
  const walk = createCodeWalk();
  // The Service lens has always shown unit members inside service frames; only the folder Map gates units.
  const ctx = { index, expanded, flows, unitsAlwaysOpen: true };
  for (const cluster of [...clustering.clusters].sort((a, b) => a.leadId.localeCompare(b.leadId))) {
    const frameId = frameIdOf(cluster.leadId);
    // The FOCUSED cluster is the zoom: always open — even a single-member cluster, which the full
    // lens draws as a bare frame card — so the dive always lands on the members.
    const isFocus = cluster.leadId === focusLead;
    const isContainer = isFocus ? cluster.memberIds.length > 0 : cluster.memberIds.length > 1;
    const isExpanded = isFocus ? isContainer : isOpen(cluster, expanded);
    walk.skeleton.push({
      id: frameId,
      parentId: null,
      kind: "package",
      isContainer,
      isExpanded,
      depth: 0,
      childCount: cluster.memberIds.length,
    });
    if (isExpanded) {
      cluster.memberIds.slice().sort().forEach((id) => visitCode(id, frameId, 1, ctx, walk));
    }
  }
  return walk;
}

function kindsOf(skeleton: Skeleton[]): Map<string, Skeleton["kind"]> {
  return new Map(skeleton.map((entry) => [entry.id, entry.kind]));
}
