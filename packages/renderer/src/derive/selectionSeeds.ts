/**
 * Resolve a Module-map multi-selection to minimal-graph SEEDS: the file (`module`) node ids the
 * subgraph grows from. A selected file card is its own seed; a selected group card (package /
 * directory) contributes every file module in its containment subtree, so "build a minimal graph of
 * these two packages" works from the repo overview too. Deduped + sorted for a deterministic build.
 * Pure; no React, no store.
 */

import type { GraphIndex } from "../graph/graphIndex";

const MODULE_KIND = "module";

export function seedModuleIdsFor(index: GraphIndex, selectedIds: readonly string[]): string[] {
  const seeds = new Set<string>();
  for (const id of selectedIds) {
    collectFileModules(index, id, seeds, new Set());
  }
  return [...seeds].sort();
}

/** DFS over containment, collecting `module` descendants (a module node is itself a seed). */
function collectFileModules(index: GraphIndex, nodeId: string, seeds: Set<string>, visited: Set<string>): void {
  if (visited.has(nodeId)) {
    return; // tolerate a parentId cycle, like the rest of the lenient viewer.
  }
  visited.add(nodeId);
  const node = index.nodesById.get(nodeId);
  if (!node) {
    return;
  }
  if (node.kind === MODULE_KIND) {
    seeds.add(node.id);
    return; // members inside a file lift to the file itself; nothing deeper is a seed.
  }
  for (const child of index.childrenOf(node.id)) {
    collectFileModules(index, child.id, seeds, visited);
  }
}
