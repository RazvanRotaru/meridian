/**
 * From the matched affected files to the node sets the review lens works over: the seed module
 * (file) nodes, and EVERY node — any kind — that lives in an affected file. Membership is decided by
 * `location.file` (normalized), never the node id, so Python's dotted ids still land in the right
 * file. Pure; no React, no store.
 */

import type { GraphIndex } from "../graph/graphIndex";
import { normalizePath } from "./matchAffectedFiles";

const MODULE_KIND = "module";

export interface AffectedNodes {
  /** Module (file) node ids for the affected files — the subgraph seeds. */
  seedModuleIds: Set<string>;
  /** Every node in an affected file, any kind — the "did a flow touch changed code?" universe. */
  affectedCallableIds: Set<string>;
  /** Affected files actually present in the graph, normalized, deduped, sorted. */
  affectedFilesResolved: string[];
}

export function affectedNodes(index: GraphIndex, affectedFiles: string[]): AffectedNodes {
  const affected = new Set(affectedFiles.map(normalizePath));
  const seedModuleIds = new Set<string>();
  const affectedCallableIds = new Set<string>();
  const present = new Set<string>();
  for (const node of index.nodesById.values()) {
    const file = node.location?.file ? normalizePath(node.location.file) : null;
    if (file === null || !affected.has(file)) {
      continue;
    }
    present.add(file);
    affectedCallableIds.add(node.id);
    if (node.kind === MODULE_KIND) {
      seedModuleIds.add(node.id);
    }
  }
  return { seedModuleIds, affectedCallableIds, affectedFilesResolved: [...present].sort() };
}
