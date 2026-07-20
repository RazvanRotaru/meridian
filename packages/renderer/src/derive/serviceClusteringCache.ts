/**
 * Memoized service clustering. Clustering depends only on the graph, and a GraphIndex is built once
 * per loaded artifact (it carries the edges too), so the index object itself is the cache key — a
 * WeakMap lets a replaced index (a newly loaded artifact) free its clustering with it. Shared by the
 * Service-lens tree derive, the lens-carry translation, and the UI probing cluster placeability, so
 * they all read the SAME clustering object instead of re-clustering per relayout, click, or render.
 */

import type { GraphIndex } from "../graph/graphIndex";
import { deriveServiceClusters, type ServiceClustering } from "./serviceComposition";

const cache = new WeakMap<GraphIndex, ServiceClustering>();

export function clusteringFor(index: GraphIndex): ServiceClustering {
  const cached = cache.get(index);
  if (cached !== undefined) {
    return cached;
  }
  const clustering = deriveServiceClusters([...index.nodesById.values()], index.edges);
  cache.set(index, clustering);
  return clustering;
}
