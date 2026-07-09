/**
 * Capture on-screen positions so the minimal-graph surface can SEED ELK and transition seamlessly
 * from the Map. `captureMapPositions` reads the Module map's file cards — a card's `position` is
 * PARENT-RELATIVE (a file inside an expanded package frame is offset from the frame, via React Flow
 * `parentId`), so the absolute point is the walk of `position` up the `parentId` chain. Root cards are
 * already absolute. `captureLaidPositions` re-reads the minimal graph's OWN top-level cards after each
 * relayout so a later expand/reveal seeds from where things already are (nothing jumps). Pure.
 */

import type { Node } from "@xyflow/react";

/** Absolute Map position of every `file` card, keyed by node id — the minimal graph's seed positions. */
export function captureMapPositions(moduleRfNodes: readonly Node[]): Record<string, { x: number; y: number }> {
  const byId = new Map(moduleRfNodes.map((node) => [node.id, node]));
  const positions: Record<string, { x: number; y: number }> = {};
  for (const node of moduleRfNodes) {
    if (node.type === "file") {
      positions[node.id] = absolutePosition(node, byId);
    }
  }
  return positions;
}

/** The minimal graph's laid-out TOP-LEVEL cards (no parent → position already absolute), so the next
 * relayout re-seeds from the current arrangement and only truly-new nodes need placing. */
export function captureLaidPositions(nodes: readonly Node[]): Record<string, { x: number; y: number }> {
  const positions: Record<string, { x: number; y: number }> = {};
  for (const node of nodes) {
    if (!node.parentId) {
      positions[node.id] = { x: node.position.x, y: node.position.y };
    }
  }
  return positions;
}

/** Sum a node's `position` up its `parentId` chain to an absolute (canvas-space) point. */
function absolutePosition(node: Node, byId: Map<string, Node>): { x: number; y: number } {
  let x = node.position.x;
  let y = node.position.y;
  let parentId = node.parentId;
  const seen = new Set<string>([node.id]);
  while (parentId && !seen.has(parentId)) {
    const parent = byId.get(parentId);
    if (!parent) {
      break;
    }
    x += parent.position.x;
    y += parent.position.y;
    seen.add(parentId);
    parentId = parent.parentId;
  }
  return { x, y };
}
