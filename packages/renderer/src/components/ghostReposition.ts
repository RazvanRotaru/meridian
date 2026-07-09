/**
 * Paint-time, SELECTION-RELATIVE ghost placement. The layout lays out ALL of a level's ghosts at once,
 * so a selected node's ghosts land far down a shared global band. Here — after the paint pass has pruned
 * to just the LIT ghosts (those wired to the selection's neighbourhood) — we reposition those few around
 * the lit subgraph's own small bounding box, so a node's ghosts sit right beside IT, outside the local
 * perimeter, never across the whole graph. Pure: no store, no React.
 */

import type { Edge, Node } from "@xyflow/react";
import { bandGhostsOutside, boundingBoxOf, absoluteRectOf, type GhostItem, type Side } from "../layout/ghostBandPlacement";

// A core node counts as LIT (part of the selection's neighbourhood) unless the emphasis pass dimmed it.
const LIT_OPACITY_FLOOR = 0.5;

/** Move every visible ghost to sit just outside the LIT subgraph, beside the node it belongs to. */
export function repositionLitGhosts(nodes: Node[], edges: Edge[]): Node[] {
  const ghosts = nodes.filter((node) => node.type === "ghost");
  if (ghosts.length === 0) {
    return nodes;
  }
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const ghostIds = new Set(ghosts.map((ghost) => ghost.id));
  const litRects = nodes.filter((node) => node.type !== "ghost" && isLit(node)).map((node) => absoluteRectOf(node, byId));
  if (litRects.length === 0) {
    return nodes; // nothing lit (e.g. no selection) — ghosts are hidden anyway, leave them.
  }
  const box = boundingBoxOf(litRects);
  const anchorOf = anchorByGhost(edges, ghostIds, byId);
  const items: GhostItem[] = [];
  for (const ghost of ghosts) {
    const info = anchorOf.get(ghost.id);
    const anchor = info ? byId.get(info.anchorId) : undefined;
    if (!info || !anchor) {
      continue; // no lit drawn anchor — leave the ghost where layout put it.
    }
    const rect = absoluteRectOf(anchor, byId);
    const size = sizeOf(ghost);
    items.push({ id: ghost.id, side: info.side, anchorCx: rect.x + rect.width / 2, anchorCy: rect.y + rect.height / 2, ...size });
  }
  const positions = bandGhostsOutside(box, items);
  return nodes.map((node) => {
    const pos = positions.get(node.id);
    return pos ? { ...node, position: pos, parentId: undefined } : node;
  });
}

/**
 * Per ghost, its drawn anchor and its SIDE by import direction: a wire drawn→ghost means the selection
 * imports the ghost (a DEPENDENCY → right); ghost→drawn means the ghost imports the selection (a CALLER
 * → left). A ghost seen both ways takes the majority (tie → right). Anchor = smallest drawn id on the side.
 */
function anchorByGhost(edges: Edge[], ghostIds: ReadonlySet<string>, byId: ReadonlyMap<string, Node>): Map<string, { anchorId: string; side: Side }> {
  const dependencyOf = new Map<string, string[]>(); // drawn→ghost (RIGHT)
  const callerOf = new Map<string, string[]>(); //     ghost→drawn (LEFT)
  for (const edge of edges) {
    if (ghostIds.has(edge.target) && byId.has(edge.source) && !ghostIds.has(edge.source)) {
      add(dependencyOf, edge.target, edge.source);
    } else if (ghostIds.has(edge.source) && byId.has(edge.target) && !ghostIds.has(edge.target)) {
      add(callerOf, edge.source, edge.target);
    }
  }
  const anchor = new Map<string, { anchorId: string; side: Side }>();
  for (const ghostId of ghostIds) {
    const dep = dependencyOf.get(ghostId) ?? [];
    const call = callerOf.get(ghostId) ?? [];
    if (dep.length === 0 && call.length === 0) {
      continue;
    }
    const side: Side = dep.length >= call.length ? "right" : "left";
    const anchors = side === "right" ? dep : call;
    anchor.set(ghostId, { anchorId: [...anchors].sort()[0], side });
  }
  return anchor;
}

function add(map: Map<string, string[]>, key: string, value: string): void {
  const list = map.get(key) ?? [];
  list.push(value);
  map.set(key, list);
}

const isLit = (node: Node): boolean => ((node.style?.opacity as number | undefined) ?? 1) > LIT_OPACITY_FLOOR;

function sizeOf(node: Node): { width: number; height: number } {
  const style = (node.style ?? {}) as { width?: number; height?: number };
  return { width: style.width ?? 0, height: style.height ?? 0 };
}
