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

/** The top-level nodes of the drawn level: source-ownership roots at the overview, else the
 * focus's children. */
export function frontierRoots(index: GraphIndex, effectiveFocus: string | null, graph: ModuleGraph): string[] {
  if (effectiveFocus === null) {
    return overviewRoots(index, graph);
  }
  if (index.nodesById.get(effectiveFocus)?.kind === MODULE_KIND) {
    return codeChildren(index, effectiveFocus);
  }
  return containmentChildren(index, effectiveFocus);
}

/** A frontier that assigns every source file to an overview root. Tagged npm packages remain
 * first-class roots (including intentionally nested package boundaries);
 * an unowned file falls back to the shallowest structural package that does not also contain an npm
 * root, or to the file itself. This keeps mixed-language and linked-system graphs complete without
 * pairing a structural fallback ancestor with its npm descendant and double-counting their source. */
function overviewRoots(index: GraphIndex, graph: ModuleGraph): string[] {
  const npmPackages = new Set<string>();
  const unownedFiles: string[] = [];
  for (const fileId of graph.fileIds) {
    const pkg = npmPackageIdOf(fileId, index.nodesById);
    if (pkg !== null) {
      npmPackages.add(pkg);
    } else {
      unownedFiles.push(fileId);
    }
  }

  // Any structural package above a selected npm root cannot also be a frontier root: their
  // containment subtrees would overlap. Precomputing this set keeps selection linear in path depth.
  const blockedPackages = new Set<string>();
  for (const packageId of npmPackages) {
    for (const ancestor of index.ancestorsOf(packageId)) {
      if (ancestor.kind === PACKAGE_KIND) {
        blockedPackages.add(ancestor.id);
      }
    }
  }

  const roots = new Set<string>(npmPackages);
  for (const fileId of unownedFiles) {
    roots.add(unownedRootOf(fileId, index, blockedPackages));
  }
  return [...roots].sort();
}

/** The shallowest usable structural package, skipping linked `system` wrappers and any package whose
 * subtree also owns an npm frontier; a truly package-less module is its own overview card. */
function unownedRootOf(fileId: string, index: GraphIndex, blockedPackages: ReadonlySet<string>): string {
  const root = index
    .ancestorsOf(fileId)
    .find((ancestor) => ancestor.kind === PACKAGE_KIND && !blockedPackages.has(ancestor.id));
  return root?.id ?? fileId;
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
