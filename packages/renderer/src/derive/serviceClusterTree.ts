/**
 * Service-composition as a Module-map lens: service clusters become expandable in-place group
 * cards, so the "call" tab reuses the Map layout, chrome, node components, and paint passes.
 *
 * Open clusters delegate every member to `codeWalk`, which is why a service member renders exactly
 * like that same node under an expanded file in the Map tab. This lens intentionally emits NO ghosts:
 * revealing a ghost would call `revealModule`, setting `moduleFocus`, and the Service lens must keep
 * `moduleFocus` null. Cluster coupling wires only emit when at least one endpoint is a `svc:` frame;
 * drawn-to-drawn code pairs are handled by `depWireEdges`, avoiding a duplicate wire.
 */

import type { LogicFlows } from "@meridian/core";
import type { GraphIndex } from "../graph/graphIndex";
import { npmPackageIdOf } from "./compositionClusters";
import { createCodeWalk, depWireEdges, flowChainEdges, stepCallEdges, visitCode, type CodeWalk, type Skeleton } from "./codeWalk";
import { blockData, fileData, unitData } from "./moduleLevel";
import type { ModuleGraph } from "./moduleGraph";
import type { BlockDeps } from "./blockDeps";
import { packageEntryModule } from "./packageOverview";
import type { ServiceCluster, ServiceClustering } from "./serviceComposition";
import { clusteringFor } from "./serviceClusteringCache";
import type { ModuleGroupData, ModuleTreeEdge, VisibleModuleNode } from "./moduleTree";
import type { StepData } from "./flowSteps";
import { clusterCouplingEdges, clusterDegrees, frameIdOf, isOpen, leadIdOf, type ClusterDegrees } from "./serviceClusterEdges";

export function deriveServiceTree(
  index: GraphIndex,
  expanded: ReadonlySet<string>,
  graph: ModuleGraph,
  blockDeps: BlockDeps,
  flows: LogicFlows,
  scopeLeadIds?: ReadonlySet<string>,
  extraIds: ReadonlySet<string> = EMPTY_IDS,
): { nodes: VisibleModuleNode[]; edges: ModuleTreeEdge[] } {
  // The memoized clustering (keyed by the index) — the SAME object the lens-carry and the scoped
  // sub-view's lead resolution read, so a relayout never re-clusters and scope leads always match.
  const clustering = scopedTo(clusteringFor(index), scopeLeadIds);
  if (clustering.clusters.length === 0) {
    return { nodes: [], edges: [] };
  }
  const degrees = clusterDegrees(clustering.couplings, clustering.leadOf);
  const walk = serviceWalk(clustering, index, expanded, flows);
  // Palette-pinned nodes (⌘P "+") ride in as EXTRA top-level cards — this lens has no focus/frontier,
  // so a unit/file/block that isn't inside an expanded cluster still joins the canvas. Already-visited
  // ids (a member of an open cluster) are dropped by the walk's `seen` guard.
  appendExtras(walk, extraIds, index, expanded, flows);
  const visibleIds = new Set(walk.skeleton.map((entry) => entry.id));
  const kinds = kindsOf(walk.skeleton);
  const isCode = (id: string) => kinds.get(id) === "unit" || kinds.get(id) === "block";
  const nodes = walk.skeleton.map((entry) => finalize(entry, clustering, degrees, index, graph, walk));
  const edges = [
    ...clusterCouplingEdges(clustering.couplings, clustering.leadOf, visibleIds),
    ...depWireEdges(blockDeps, visibleIds, index, isCode, walk.expandedBlocks),
    ...flowChainEdges(walk),
    ...stepCallEdges(walk, visibleIds, index),
  ].sort((a, b) => a.id.localeCompare(b.id));
  return { nodes, edges };
}

/**
 * The scoped Service sub-view: keep only the clusters whose lead is in scope, and only the
 * couplings whose BOTH endpoints lift (via leadOf) into scope. An edge touching an out-of-scope
 * cluster is DROPPED, not ghosted — the same no-ghost invariant as the rest of this lens — so the
 * degree badges too count in-scope neighbours only, matching the wires actually drawn.
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

/** A shared empty set so the default `extraIds` argument never allocates per call. */
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
): CodeWalk {
  const walk = createCodeWalk();
  // The Service lens has always shown unit members inside service frames; only the folder Map gates units.
  const ctx = { index, expanded, flows, unitsAlwaysOpen: true };
  for (const cluster of [...clustering.clusters].sort((a, b) => a.leadId.localeCompare(b.leadId))) {
    const frameId = frameIdOf(cluster.leadId);
    const isExpanded = isOpen(cluster, expanded);
    walk.skeleton.push({
      id: frameId,
      parentId: null,
      kind: "package",
      isContainer: cluster.memberIds.length > 1,
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

function finalize(
  entry: Skeleton,
  clustering: ServiceClustering,
  degrees: ClusterDegrees,
  index: GraphIndex,
  graph: ModuleGraph,
  walk: CodeWalk,
): VisibleModuleNode {
  const data =
    entry.kind === "package"
      ? clusterData(clusterForFrame(entry.id, clustering), clustering, degrees, entry)
      : entry.kind === "file"
        ? fileData(entry.id, graph, index, entryModuleFor(entry.id, index), {
            isContainer: entry.isContainer,
            isExpanded: entry.isExpanded,
            unitCount: entry.childCount,
          })
        : entry.kind === "unit"
          ? unitData(entry.id, index, {
              memberCount: entry.childCount,
              isContainer: entry.isContainer,
              isExpanded: entry.isExpanded,
            })
          : entry.kind === "block"
            ? blockData(entry.id, index, { hasFlow: entry.isContainer, isExpanded: entry.isExpanded })
            : (walk.stepData.get(entry.id) as StepData);
  return { ...entry, data };
}

function clusterData(
  cluster: ServiceCluster,
  clustering: ServiceClustering,
  degrees: ClusterDegrees,
  entry: Skeleton,
): ModuleGroupData {
  const metric = clustering.metrics.get(cluster.leadId);
  return {
    label: metric?.displayName ?? cluster.leadId,
    fileCount: cluster.memberIds.length,
    ca: degrees.ca.get(cluster.leadId)?.size ?? 0,
    ce: degrees.ce.get(cluster.leadId)?.size ?? 0,
    isContainer: entry.isContainer,
    isExpanded: entry.isExpanded,
  };
}

function clusterForFrame(frameId: string, clustering: ServiceClustering): ServiceCluster {
  const leadId = leadIdOf(frameId);
  const cluster = clustering.clusters.find((item) => item.leadId === leadId);
  if (!cluster) {
    throw new Error(`Unknown service cluster frame: ${frameId}`);
  }
  return cluster;
}

function entryModuleFor(fileId: string, index: GraphIndex): string | null {
  return packageEntryModule(index, npmPackageIdOf(fileId, index.nodesById) ?? fileId);
}

function kindsOf(skeleton: Skeleton[]): Map<string, Skeleton["kind"]> {
  return new Map(skeleton.map((entry) => [entry.id, entry.kind]));
}
