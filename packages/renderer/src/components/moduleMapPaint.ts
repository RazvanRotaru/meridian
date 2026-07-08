/**
 * Paint-time transforms for the Module-map surface: HIDE file cards by category / test-status, and
 * EMPHASIZE the wires within N import hops of the active (selected) node. Both are pure over the
 * already laid-out React Flow arrays — positions are NEVER touched, so filtering or highlighting
 * reshuffles nothing. Kept out of the view component so the rules are small, named, and testable.
 * A group card is never category-hidden (only file cards are), so an expanded frame and its nested
 * children's parent chain always survive a repaint — React Flow never loses a referenced parent.
 */

import { type Edge, type Node } from "@xyflow/react";
import type { ModuleCardData } from "../derive/moduleLevel";
import type { ModuleCategory } from "../derive/moduleCategory";
export { emphasize, type EmphasizedLevel, type HighlightMode } from "./moduleMapHighlight";

export interface HideOptions {
  hiddenCategories: ReadonlySet<ModuleCategory>;
  showTests: boolean;
  testIds: ReadonlySet<string>;
  showPrivate: boolean;
  privateIds: ReadonlySet<string>;
}

/**
 * Drop the file cards a filter hides (a category toggled off, or test code with tests hidden) and
 * the wires touching them — WITHOUT moving anything. Group cards are never category-hidden (a
 * directory has no single category), so the level's structure holds. Hiding closes over drawn
 * DESCENDANTS: an expanded file frame that hides takes its nested unit cards with it, so the
 * toggle's contract holds and React Flow never sees a child whose parent frame vanished.
 */
export function filterVisible(nodes: Node[], edges: Edge[], options: HideOptions): { nodes: Node[]; edges: Edge[] } {
  const hidden = hiddenCardIds(nodes, options);
  if (hidden.size === 0) {
    return { nodes, edges };
  }
  const keptNodes = nodes.filter((node) => !hidden.has(node.id));
  const keptEdges = edges.filter((edge) => !hidden.has(edge.source) && !hidden.has(edge.target));
  return { nodes: keptNodes, edges: keptEdges };
}

function hiddenCardIds(nodes: Node[], options: HideOptions): Set<string> {
  const hidden = new Set<string>();
  // Nodes arrive parents-before-children (a React Flow requirement), so one pass both applies the
  // filters and closes hiding over each hidden card's drawn subtree via parentId membership.
  for (const node of nodes) {
    if (node.parentId && hidden.has(node.parentId)) {
      hidden.add(node.id);
      continue;
    }
    if ((node.type === "file" || node.type === "unit" || node.type === "block" || node.type === "ghost") && isHidden(node, options)) {
      hidden.add(node.id);
    }
  }
  return hidden;
}

function isHidden(node: Node, options: HideOptions): boolean {
  if (!options.showTests && options.testIds.has(node.id)) {
    return true;
  }
  if (!options.showPrivate && options.privateIds.has(node.id)) {
    return true;
  }
  // Unit cards carry no category of their own; they hide with their file frame (subtree closure).
  return options.hiddenCategories.has((node.data as ModuleCardData).category);
}
