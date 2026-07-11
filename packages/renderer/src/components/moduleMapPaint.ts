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
export { emphasize, type EmphasizedLevel, type GhostPresentationOptions, type HighlightMode, type SurfaceEmphasisMode } from "./moduleMapHighlight";

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

/** The relationship-toggle key an edge answers to; null = always shown (execution-order flow). */
function relKeyOf(edge: Edge): string | null {
  const data = edge.data as { category?: string; depKind?: string } | undefined;
  if (data?.category === "dep") return data.depKind ?? "calls";
  if (data?.category === "import") return "imports";
  if (data?.category === "ipc") return "ipc";
  return null;
}

/** Drop the wires whose relationship kind is toggled off — a pure paint filter, positions untouched. */
export function filterRelKinds(edges: Edge[], hidden: ReadonlySet<string>): Edge[] {
  if (hidden.size === 0) {
    return edges;
  }
  return edges.filter((edge) => {
    const key = relKeyOf(edge);
    return key === null || !hidden.has(key);
  });
}

/**
 * Suppress import edges between a pair that already has a typed dep edge. If file A calls/extends/
 * references file B, the import A→B is redundant visual noise — the dep edge carries more meaning.
 * Only bare imports (pairs with NO dep edge) survive.
 */
export function suppressRedundantImports(edges: Edge[]): Edge[] {
  // Collect all source→target pairs that have at least one dep edge.
  const depPairs = new Set<string>();
  for (const edge of edges) {
    const data = edge.data as { category?: string } | undefined;
    if (data?.category === "dep") {
      depPairs.add(`${edge.source}→${edge.target}`);
      depPairs.add(`${edge.target}→${edge.source}`); // bidirectional suppression
    }
  }
  if (depPairs.size === 0) return edges;
  return edges.filter((edge) => {
    const data = edge.data as { category?: string } | undefined;
    if (data?.category !== "import") return true;
    return !depPairs.has(`${edge.source}→${edge.target}`);
  });
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
    if (isCardHidden(node, options)) {
      hidden.add(node.id);
    }
  }
  return hidden;
}

// A group/`package` card is never CATEGORY-hidden (a directory has no single category), but it DOES
// hide with the Tests/Private toggle when it is WHOLLY test/private code. `testIds`/`privateIds` are
// closed over containment, so a package appears there only when ALL its descendants qualify — hiding
// the card then takes its (equally test/private) drawn subtree with it, so no child is orphaned.
function isCardHidden(node: Node, options: HideOptions): boolean {
  if (node.type === "package") {
    return toggledOff(node, options);
  }
  if (node.type === "file" || node.type === "unit" || node.type === "block" || node.type === "ghost") {
    return toggledOff(node, options) || options.hiddenCategories.has((node.data as ModuleCardData).category);
  }
  return false;
}

// The Tests/Private toggles (category is handled only for the card types that carry one).
function toggledOff(node: Node, options: HideOptions): boolean {
  if (!options.showTests && options.testIds.has(node.id)) {
    return true;
  }
  return !options.showPrivate && options.privateIds.has(node.id);
}
