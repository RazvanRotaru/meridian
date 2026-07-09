/**
 * Capture the Module map's ON-SCREEN file positions so the minimal-graph overlay can MIRROR them.
 * A map file card's `position` is PARENT-RELATIVE (a file inside an expanded package frame is offset
 * from the frame, via React Flow `parentId`); root cards are absolute. The absolute position is the
 * walk of `position` up the `parentId` chain. Sizes read from `style` (falling back to the file-card
 * default). Only `type === "file"` cards are captured — package frames aren't mirrored (the overlay
 * is flat). Pure: no store, no React.
 */

import type { Node } from "@xyflow/react";
import type { PlacedRect } from "../layout/minimalPlacement";
import { FILE_WIDTH, FILE_HEIGHT } from "../layout/minimalPlacement";

/** Absolute map position + size for every `file` card, keyed by node id, for the overlay to mirror. */
export function captureMapPositions(moduleRfNodes: readonly Node[]): Record<string, PlacedRect> {
  const byId = new Map(moduleRfNodes.map((node) => [node.id, node]));
  const positions: Record<string, PlacedRect> = {};
  for (const node of moduleRfNodes) {
    if (node.type !== "file") {
      continue;
    }
    const style = (node.style ?? {}) as { width?: number; height?: number };
    positions[node.id] = {
      ...absolutePosition(node, byId),
      width: typeof style.width === "number" ? style.width : FILE_WIDTH,
      height: typeof style.height === "number" ? style.height : FILE_HEIGHT,
    };
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
