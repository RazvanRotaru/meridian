/**
 * The Map lens's FRONTIER: which nodes a level starts from, and the containment tallies group cards
 * show. Split from `moduleTree.ts` (which owns the walk + edge folding) so each file keeps one job.
 * Pure; no React, no ELK.
 */

import type { GraphIndex } from "../graph/graphIndex";
import { BLOCK_KINDS, UNIT_CARD_KINDS } from "./blockDeps";
import { npmPackageIdOf } from "./compositionClusters";
import type { ModuleGraph } from "./moduleGraph";

const MODULE_KIND = "module";
const PACKAGE_KIND = "package";

/** The top-level nodes of the drawn level: npm packages at the overview, else the focus's children. */
export function frontierRoots(index: GraphIndex, effectiveFocus: string | null, graph: ModuleGraph): string[] {
  if (effectiveFocus === null) {
    return overviewPackages(index, graph);
  }
  if (index.nodesById.get(effectiveFocus)?.kind === MODULE_KIND) {
    return codeChildren(index, effectiveFocus);
  }
  return containmentChildren(index, effectiveFocus);
}

/** The npm packages that own ≥1 source file — the whole-repo overview's frontier (deduped, sorted).
 * A single-project artifact carries no npm-package tags at all; falling back to the files' topmost
 * package (directory) roots keeps the DEFAULT lens from booting into an empty canvas. */
function overviewPackages(index: GraphIndex, graph: ModuleGraph): string[] {
  const packages = new Set<string>();
  const rootDirs = new Set<string>();
  for (const fileId of graph.fileIds) {
    const pkg = npmPackageIdOf(fileId, index.nodesById);
    if (pkg !== null) {
      packages.add(pkg);
    } else {
      const root = topmostPackageOf(fileId, index);
      if (root !== null) {
        rootDirs.add(root);
      }
    }
  }
  const frontier = packages.size > 0 ? packages : rootDirs;
  return [...frontier].sort();
}

/** The file's topmost `package`-kind ancestor (the containment root directory), or null if none. */
function topmostPackageOf(fileId: string, index: GraphIndex): string | null {
  const root = index.ancestorsOf(fileId)[0];
  return root && root.kind === PACKAGE_KIND ? root.id : null;
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
  let count = 0;
  const seen = new Set<string>();
  const stack = [rootId];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    for (const child of index.childrenOf(id)) {
      if (child.kind === MODULE_KIND) {
        count += 1;
      } else if (child.kind === PACKAGE_KIND) {
        stack.push(child.id);
      }
    }
  }
  return count;
}
