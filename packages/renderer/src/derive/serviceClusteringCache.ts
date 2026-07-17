/**
 * Memoized service clustering. Clustering depends only on the graph, and a GraphIndex is built once
 * per loaded artifact (it carries the edges too), so the index object itself is the cache key — a
 * WeakMap lets a replaced index (a newly loaded artifact) free its clustering with it. Shared by the
 * Service-lens tree derive, the lens-carry translation, and the UI probing cluster placeability, so
 * they all read the SAME clustering object instead of re-clustering per relayout, click, or render.
 */

import {
  deriveServiceClusters,
  hydrateServiceTopology,
  type ServiceClustering,
} from "@meridian/design-metrics";
import type { GraphIndex } from "../graph/graphIndex";

const cache = new WeakMap<GraphIndex, ServiceClustering>();

export function clusteringFor(index: GraphIndex): ServiceClustering {
  const cached = cache.get(index);
  if (cached !== undefined) {
    return cached;
  }
  const clustering = index.serviceTopology !== null
    ? hydrateServiceTopology(index.serviceTopology)
    : deriveFromCompleteArtifact(index);
  cache.set(index, clustering);
  return clustering;
}

/**
 * Non-Service projections may contain request/selection overlays that can paint their ordinary
 * containment ancestors without any service abstraction. Those cross-view consumers opt into
 * service representatives only when authoritative facts are actually available.
 */
export function clusteringForIfAvailable(index: GraphIndex): ServiceClustering | null {
  return index.serviceTopology !== null || index.artifactComplete
    ? clusteringFor(index)
    : null;
}

function deriveFromCompleteArtifact(index: GraphIndex): ServiceClustering {
  if (!index.artifactComplete) {
    throw new Error(
      "Service topology is unavailable for this bounded graph projection; request a Service projection",
    );
  }
  return deriveServiceClusters([...index.nodesById.values()], index.edges);
}
