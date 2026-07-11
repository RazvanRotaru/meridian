/**
 * COMMONS demotion — the hub treatment (wire-legibility plan, W2). Every level has a few utility
 * files (logger, config, types) that everything depends on; their wires radiate from every card to
 * one magnet and read as spaghetti while saying only "uses the logger" N times. Demote them: a
 * top-level LEAF file card whose visible in-degree at this level crosses the threshold leaves the
 * wire field — the layout parks it in a COMMONS DOCK beneath the graph (moduleLevelLayout), its
 * incoming wires hide at rest (paint: opacity 0, still present — selection/hover light them like
 * any wire), and each dependent card wears a small chip naming the commons it uses. Selecting the
 * commons card still lights its real connections; the Wire Inspector still attributes every chip.
 *
 * A pure derive pass over the assembled tree: marks node data (isCommons / commonsChips) and wires
 * (commons: true); never drops anything — hiding is paint's job, placement is layout's.
 */

import type { ModuleCardData } from "./moduleLevel";
import type { ModuleTreeEdge, VisibleModuleNode } from "./moduleTreeTypes";

/** The magnetism bar is LEVEL-RELATIVE: a fixed count misses a small level's logger (4 of 9 cards
 * depending on one file IS the hub phenomenon) and would demote too eagerly on a huge one. A file
 * demotes when its distinct dependents reach max(floor, share of the level's other top cards). */
const COMMONS_MIN_DEPENDENTS = 4;
const COMMONS_MIN_SHARE = 0.3;

export function demoteCommons(nodes: VisibleModuleNode[], edges: ModuleTreeEdge[]): { nodes: VisibleModuleNode[]; edges: ModuleTreeEdge[] } {
  const topOf = topLevelAncestors(nodes);
  const commonsIds = findCommons(nodes, edges, topOf);
  if (commonsIds.size === 0) {
    return { nodes, edges };
  }
  const labelById = new Map(nodes.map((node) => [node.id, chipLabel(node)]));
  // Dependent → the commons it uses (insertion-ordered, deduped) for the card chips. A wire from
  // INSIDE an expanded frame chips the frame's TOP-LEVEL card — unit/block cards render no chips,
  // and the frame is the thing the reader sees depending on the hub.
  const chipsByDependent = new Map<string, string[]>();
  const markedEdges = edges.map((edge) => {
    if (edge.ghost === true || (!commonsIds.has(edge.target) && !commonsIds.has(edge.source))) {
      return edge;
    }
    if (commonsIds.has(edge.target)) {
      const dependent = topOf.get(edge.source) ?? edge.source;
      const chips = chipsByDependent.get(dependent) ?? [];
      const label = labelById.get(edge.target) ?? edge.target;
      if (!chips.includes(label)) {
        chips.push(label);
      }
      chipsByDependent.set(dependent, chips);
    }
    // Both directions hide at rest: a docked hub's own imports would otherwise climb out of the
    // dock as the only visible strands of a card that "left the wire field".
    return { ...edge, commons: true };
  });
  const markedNodes = nodes.map((node) => {
    if (commonsIds.has(node.id)) {
      return { ...node, data: { ...(node.data as ModuleCardData), isCommons: true } };
    }
    const chips = chipsByDependent.get(node.id);
    return chips ? { ...node, data: { ...(node.data as ModuleCardData), commonsChips: chips } } : node;
  });
  return { nodes: markedNodes, edges: markedEdges };
}

/**
 * A commons is a TOP-LEVEL LEAF FILE card whose distinct TOP-LEVEL dependents among this level's
 * drawn wires reach the level-relative bar. Sources lift to their top-level ancestor first — an
 * expanded frame's five member wires are ONE dependent, not five (expanding a heavy user must not
 * flip a hub into the dock). Frames/packages stay (they are structure, not utility noise),
 * expanded files stay (the reader is inside them), the entry file stays (it is the story, not a
 * helper), and ghost wires don't count (off-level dependents aren't on this canvas).
 */
function findCommons(nodes: VisibleModuleNode[], edges: ModuleTreeEdge[], topOf: ReadonlyMap<string, string>): Set<string> {
  const eligible = new Map<string, VisibleModuleNode>();
  let topLevelCount = 0;
  for (const node of nodes) {
    if (node.parentId === null && node.kind !== "ghost") {
      topLevelCount += 1;
    }
    if (node.kind === "file" && node.parentId === null && !node.isExpanded && !(node.data as ModuleCardData).isEntry) {
      eligible.set(node.id, node);
    }
  }
  const bar = Math.max(COMMONS_MIN_DEPENDENTS, Math.ceil((topLevelCount - 1) * COMMONS_MIN_SHARE));
  const dependents = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (edge.ghost === true || !eligible.has(edge.target)) {
      continue;
    }
    const source = topOf.get(edge.source) ?? edge.source;
    if (source === edge.target) {
      continue;
    }
    const sources = dependents.get(edge.target) ?? new Set<string>();
    sources.add(source);
    dependents.set(edge.target, sources);
  }
  const commons = new Set<string>();
  for (const [id, sources] of dependents) {
    if (sources.size >= bar) {
      commons.add(id);
    }
  }
  return commons;
}

/** Every node's TOP-LEVEL drawn ancestor (self when already at the root of the level). */
function topLevelAncestors(nodes: VisibleModuleNode[]): Map<string, string> {
  const parentOf = new Map(nodes.map((node) => [node.id, node.parentId]));
  const topOf = new Map<string, string>();
  for (const node of nodes) {
    let current = node.id;
    const seen = new Set<string>();
    while (!seen.has(current)) {
      seen.add(current);
      const parent = parentOf.get(current);
      if (parent === null || parent === undefined || !parentOf.has(parent)) {
        break;
      }
      current = parent;
    }
    topOf.set(node.id, current);
  }
  return topOf;
}

/** The chip text a dependent wears: the commons file's basename without its extension. */
function chipLabel(node: VisibleModuleNode): string {
  const label = (node.data as { label?: string }).label ?? node.id;
  return label.replace(/\.[a-z]+$/i, "");
}
