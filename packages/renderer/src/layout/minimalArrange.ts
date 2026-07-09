/**
 * The minimal-graph overlay's "Re-arrange" layout: a FRESH, non-interactive layered ELK pass over the
 * current leaf cards, IGNORING the captured map positions. Where the map-mirror keeps every card at its
 * (possibly far-apart) map spot, this lays the graph out compactly left→right by its import edges — the
 * fix for a selection whose members mirror distant map locations. Deterministic (no seed coords, no
 * clock/random); each card enters at its real rendered size so ELK reserves the right footprint.
 */

import type { ElkNode } from "elkjs/lib/elk-api";
import { runElkLayout } from "./elkLayout";
import { ELK_ROOT_ID } from "./elkNesting";
import { FILE_WIDTH, FILE_HEIGHT, type PlacedRect } from "./minimalPlacement";

type Size = { width: number; height: number };

// Plain layered RIGHT (NOT interactive — ELK assigns layers + order from the edges), same spacing as
// the Module map's own root pass so the arranged graph reads with the map's feel.
const ARRANGE_OPTIONS: Record<string, string> = {
  "elk.algorithm": "layered",
  "elk.direction": "RIGHT",
  "elk.spacing.nodeNode": "44",
  "elk.layered.spacing.nodeNodeBetweenLayers": "120",
  "elk.spacing.edgeNode": "28",
};

/** Lay the cards out fresh: one ELK leaf per card (at its size), wired by the visible import edges.
 * Returns absolute rects (flat graph), falling back to the given size if ELK omits one. */
export async function arrangeMinimalCards(
  cardIds: readonly string[],
  sizes: Record<string, Size>,
  importEdges: readonly { source: string; target: string }[],
): Promise<Record<string, PlacedRect>> {
  const ids = new Set(cardIds);
  const sizeOf = (id: string): Size => sizes[id] ?? { width: FILE_WIDTH, height: FILE_HEIGHT };
  const children: ElkNode[] = cardIds.map((id) => ({ id, ...sizeOf(id) }));
  const edges = importEdges
    .filter((edge) => ids.has(edge.source) && ids.has(edge.target))
    .map((edge, i) => ({ id: `arrange:${i}`, sources: [edge.source], targets: [edge.target] }));
  const laid = await runElkLayout({ id: ELK_ROOT_ID, layoutOptions: ARRANGE_OPTIONS, children, edges });
  const result: Record<string, PlacedRect> = {};
  for (const child of laid.children ?? []) {
    const size = sizeOf(child.id);
    result[child.id] = { x: child.x ?? 0, y: child.y ?? 0, width: child.width ?? size.width, height: child.height ?? size.height };
  }
  return result;
}
