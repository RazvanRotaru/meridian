/**
 * Keep small review graphs file-shaped, but summarize a large sibling set as its immediate package.
 * This is deliberately one level only: a rolled package never participates in another rollup.
 */

import type { GraphIndex } from "../graph/graphIndex";
import type { FileMatch } from "./matchAffectedFiles";

const ROLLUP_THRESHOLD = 10;
const MIN_GROUP_SIZE = 3;

export function rollupSeeds(matched: FileMatch[], index: GraphIndex): { seeds: string[]; rolledUp: Map<string, string[]> } {
  const moduleIds = [...new Set(matched.map((match) => match.moduleId))].sort();
  if (matched.length <= ROLLUP_THRESHOLD) {
    return { seeds: moduleIds, rolledUp: new Map() };
  }

  const byParent = new Map<string, string[]>();
  const ungrouped: string[] = [];
  for (const moduleId of moduleIds) {
    const parentId = index.parentOf.get(moduleId) ?? null;
    if (parentId === null || index.nodesById.get(parentId)?.kind !== "package") {
      ungrouped.push(moduleId);
      continue;
    }
    const group = byParent.get(parentId);
    group ? group.push(moduleId) : byParent.set(parentId, [moduleId]);
  }

  const seeds = [...ungrouped];
  const rolledUp = new Map<string, string[]>();
  for (const [parentId, fileIds] of [...byParent.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    fileIds.sort();
    if (fileIds.length >= MIN_GROUP_SIZE) {
      seeds.push(parentId);
      rolledUp.set(parentId, fileIds);
    } else {
      seeds.push(...fileIds);
    }
  }
  return { seeds: seeds.sort(), rolledUp };
}
