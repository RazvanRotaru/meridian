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
import { deriveServiceClusters, type ServiceCluster, type ServiceClustering } from "./serviceComposition";
import type { ModuleGroupData, ModuleTreeEdge, VisibleModuleNode } from "./moduleTree";
import type { StepData } from "./flowSteps";
import { clusterCouplingEdges, clusterDegrees, frameIdOf, isOpen, type ClusterDegrees } from "./serviceClusterEdges";

export function deriveServiceTree(
  index: GraphIndex,
  expanded: ReadonlySet<string>,
  graph: ModuleGraph,
  blockDeps: BlockDeps,
  flows: LogicFlows,
): { nodes: VisibleModuleNode[]; edges: ModuleTreeEdge[] } {
  const clustering = deriveServiceClusters([...index.nodesById.values()], index.edges);
  if (clustering.clusters.length === 0) {
    return { nodes: [], edges: [] };
  }
  const degrees = clusterDegrees(clustering.couplings, clustering.leadOf);
  const walk = serviceWalk(clustering, index, expanded, flows);
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

function serviceWalk(
  clustering: ServiceClustering,
  index: GraphIndex,
  expanded: ReadonlySet<string>,
  flows: LogicFlows,
): CodeWalk {
  const walk = createCodeWalk();
  const ctx = { index, expanded, flows };
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
          ? unitData(entry.id, index, entry.childCount)
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
  const leadId = frameId.slice("svc:".length);
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
