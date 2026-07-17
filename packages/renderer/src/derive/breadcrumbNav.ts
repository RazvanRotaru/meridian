/**
 * The breadcrumb dropdown's contents: the navigable cards at a given focus. It reuses the Map's own
 * `frontierRoots`, so the menu is EXACTLY the boxes on screen at that level — npm packages at the
 * overview, folder/file children deeper — then applies the SAME two exclusions the Map's walk does:
 * hidden ids (the Tests toggle) and folders with no source file below. A file focus yields nothing:
 * its children are code, not navigation targets.
 */

import type { GraphIndex } from "../graph/graphIndex";
import { frontierRoots, subtreeFileCount } from "./moduleFrontier";

const NAVIGABLE_KINDS: ReadonlySet<string> = new Set(["package", "module"]);
const PACKAGE_KIND = "package";
const EMPTY_IDS: ReadonlySet<string> = new Set<string>();

export interface NavChild {
  id: string;
  label: string;
}

export function levelChildren(
  index: GraphIndex,
  focus: string | null,
  hiddenIds: ReadonlySet<string> = EMPTY_IDS,
): NavChild[] {
  const children: NavChild[] = [];
  for (const id of frontierRoots(index, focus)) {
    if (hiddenIds.has(id)) {
      continue; // the Tests toggle excludes these from the graph — keep the menu in step
    }
    const node = index.nodesById.get(id);
    if (!node || !NAVIGABLE_KINDS.has(node.kind)) {
      continue;
    }
    if (node.kind === PACKAGE_KIND && subtreeFileCount(index, id) === 0) {
      continue; // a directory the Map draws nothing for
    }
    children.push({ id: node.id, label: node.displayName ?? node.id });
  }
  return children;
}
