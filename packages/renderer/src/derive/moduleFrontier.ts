/**
 * The Map lens's FRONTIER: which nodes a level starts from, and the containment tallies group cards
 * show. Split from `moduleTree.ts` (which owns the walk + edge folding) so each file keeps one job.
 * Pure; no React, no ELK.
 */

import type { GraphIndex } from "../graph/graphIndex";
import { BLOCK_KINDS, UNIT_CARD_KINDS } from "./blockDeps";

const MODULE_KIND = "module";
const PACKAGE_KIND = "package";

/** The top-level nodes of the drawn level: source-ownership roots at the overview, else the
 * focus's children. A target-scoped caller may supply an explicit resident root forest without
 * redefining the index's authoritative whole-repository overview. */
export function frontierRoots(
  index: GraphIndex,
  effectiveFocus: string | null,
  rootForestIds: readonly string[] = index.structure.moduleOverviewRootIds,
): string[] {
  if (effectiveFocus === null) {
    return rootForestIds.filter((id) => index.nodesById.has(id));
  }
  if (index.nodesById.get(effectiveFocus)?.kind === MODULE_KIND) {
    return codeChildren(index, effectiveFocus);
  }
  return containmentChildren(index, effectiveFocus);
}

/** A node's package/file children (directories + source files), skipping members and other kinds. */
export function containmentChildren(index: GraphIndex, nodeId: string): string[] {
  return index
    .childrenOf(nodeId)
    .filter((child) => child.kind === PACKAGE_KIND || child.kind === MODULE_KIND)
    .map((child) => child.id);
}

/** A focused file starts directly at the declarations its expanded frame would have shown. */
function codeChildren(index: GraphIndex, fileId: string): string[] {
  return index
    .childrenOf(fileId)
    .filter((child) => UNIT_CARD_KINDS.has(child.kind) || BLOCK_KINDS.has(child.kind))
    .map((child) => child.id);
}

/** Count `module`-kind descendants across the FULL containment subtree (independent of expansion). */
export function subtreeFileCount(index: GraphIndex, rootId: string): number {
  return index.structure.hierarchyById.get(rootId)?.descendantSourceFileCount ?? 0;
}
