/**
 * Capture the Module map's ON-SCREEN file positions so the minimal-graph overlay can MIRROR them.
 * A map file card's `position` is PARENT-RELATIVE (a file inside an expanded package frame is offset
 * from the frame, via React Flow `parentId`); root cards are absolute. The absolute position is the
 * walk of `position` up the `parentId` chain. Sizes read from `style` (falling back to a per-type
 * default). `file` and `package` cards are captured — so a package member/ghost has a mirrored
 * position, and building from the repo overview (all package cards) still yields a ghost ring around
 * them. Pure: no store, no React.
 */

import type { Node } from "@xyflow/react";
import type { PlacedRect } from "../layout/minimalPlacement";
import { FILE_WIDTH, FILE_HEIGHT } from "../layout/minimalPlacement";

// A collapsed package card's fallback footprint when its `style` carries no explicit size.
const GROUP_WIDTH = 230;
const GROUP_HEIGHT = 64;
const CAPTURED_TYPES: ReadonlySet<string> = new Set(["file", "package"]);

/** Absolute map position + size for every `file` / `package` card, keyed by node id, to mirror. */
export function captureMapPositions(moduleRfNodes: readonly Node[]): Record<string, PlacedRect> {
  const byId = new Map(moduleRfNodes.map((node) => [node.id, node]));
  const positions: Record<string, PlacedRect> = {};
  for (const node of moduleRfNodes) {
    if (!CAPTURED_TYPES.has(node.type ?? "")) {
      continue;
    }
    // A package renders as a COLLAPSED leaf card in the overlay, so mirror only its position at a fixed
    // group-card size — an expanded frame's tall captured `style` height would stretch the leaf card.
    if (node.type === "package") {
      positions[node.id] = { ...absolutePosition(node, byId), width: GROUP_WIDTH, height: GROUP_HEIGHT };
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
