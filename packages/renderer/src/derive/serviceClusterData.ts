/**
 * Node-data finalization for the Service lens's tree: every walked skeleton entry picks up the
 * SAME card data as the Map (file/unit/block/step via moduleLevel + codeWalk), while `svc:` frames
 * wear cluster group data (lead name, member count, scope-level ca/ce badges). Split from
 * serviceClusterTree so the walk stays readable beside the derive.
 */

import type { GraphIndex } from "../graph/graphIndex";
import { npmPackageIdOf } from "./compositionClusters";
import type { CodeWalk, Skeleton } from "./codeWalk";
import { blockData, fileData, unitData } from "./moduleLevel";
import type { ModuleGraph } from "./moduleGraph";
import { packageEntryModule } from "./packageOverview";
import type { ServiceCluster, ServiceClustering } from "./serviceComposition";
import type { ModuleGroupData, VisibleModuleNode } from "./moduleTreeTypes";
import type { StepData } from "./flowSteps";
import { leadIdOf, type ClusterDegrees } from "./serviceClusterEdges";

export function finalizeServiceNode(
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
