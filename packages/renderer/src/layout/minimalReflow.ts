/**
 * The minimal-graph overlay's EXPANDED-state reflow: a position-seeded ELK pass that opens JUST enough
 * spacing around grown file frames to clear overlaps, WITHOUT relaying the graph from scratch. It runs
 * `layered` in fully INTERACTIVE mode — layer assignment, in-layer ordering, and cycle breaking all read
 * the seed x/y — so the captured left→right / top→bottom arrangement is preserved and neighbours are
 * merely pushed apart. Seeds are the captured/placed rects; each expanded file carries its per-file
 * nested-ELK frame size, so ELK reserves the taller/wider box and steps its neighbours past it.
 *
 * This is a FLAT pass (top-level files only): expanded files enter as leaf boxes sized to their frame,
 * and their already-laid-out children ride along via React Flow `parentId` when the frame is re-anchored
 * (see `minimalSubgraphLayout.emitFiles`). So there is no nesting here — the per-file nesting lives in
 * `layoutModuleTree`, reused untouched. Runs ONLY when at least one file is expanded; the no-expansion
 * path never reaches this module, which is how the exact captured-position mirror is guaranteed.
 */

import type { ElkNode } from "elkjs/lib/elk-api";
import { runElkLayout } from "./elkLayout";
import { ELK_ROOT_ID } from "./elkNesting";
import type { PlacedRect } from "./minimalPlacement";

// Fully interactive layered: every phase that could re-order nodes is told to honour the seed
// coordinates instead, so the reflow opens spacing without reshuffling the arrangement. Same spacing
// as the Module map (`moduleLevelLayout.ROOT_OPTIONS`) so the opened gaps match the map's feel.
const REFLOW_OPTIONS: Record<string, string> = {
  "elk.algorithm": "layered",
  "elk.direction": "RIGHT",
  "elk.interactive": "true",
  "elk.layered.nodePlacement.strategy": "INTERACTIVE",
  "elk.layered.crossingMinimization.strategy": "INTERACTIVE",
  "elk.layered.cycleBreaking.strategy": "INTERACTIVE",
  "elk.spacing.nodeNode": "44",
  "elk.layered.spacing.nodeNodeBetweenLayers": "120",
  "elk.spacing.edgeNode": "28",
};

/** Reflow the top-level file rects: seed ELK with their captured/placed positions + real sizes and let
 * interactive-layered open spacing around the (already-sized) expanded frames. Returns new file rects;
 * stubs are re-hung against these afterwards. */
export async function reflowMinimalFiles(
  fileIds: readonly string[],
  seedRects: Record<string, PlacedRect>,
  importEdges: readonly { source: string; target: string }[],
): Promise<Record<string, PlacedRect>> {
  const children = seededChildren(fileIds, seedRects);
  const graph: ElkNode = { id: ELK_ROOT_ID, layoutOptions: REFLOW_OPTIONS, children, edges: seededEdges(importEdges, seedRects) };
  const laid = await runElkLayout(graph);
  return collectRects(laid.children ?? [], seedRects);
}

/** One seeded ELK leaf per placed file: its seed position drives interactive layering, its real size
 * (a grown frame when expanded) is the footprint ELK reserves. */
function seededChildren(fileIds: readonly string[], seedRects: Record<string, PlacedRect>): ElkNode[] {
  const children: ElkNode[] = [];
  for (const id of fileIds) {
    const rect = seedRects[id];
    if (rect) {
      children.push({ id, x: rect.x, y: rect.y, width: rect.width, height: rect.height });
    }
  }
  return children;
}

/** File→file import wires between two seeded files — the layered edges the reflow routes and spaces. */
function seededEdges(importEdges: readonly { source: string; target: string }[], seedRects: Record<string, PlacedRect>) {
  return importEdges
    .filter((edge) => seedRects[edge.source] && seedRects[edge.target])
    .map((edge, i) => ({ id: `reflow:${i}`, sources: [edge.source], targets: [edge.target] }));
}

/** Read the laid-out (absolute, since flat) rects back, falling back to the seed size if ELK omits it. */
function collectRects(laidChildren: readonly ElkNode[], seedRects: Record<string, PlacedRect>): Record<string, PlacedRect> {
  const result: Record<string, PlacedRect> = {};
  for (const child of laidChildren) {
    const seed = seedRects[child.id];
    result[child.id] = {
      x: child.x ?? seed?.x ?? 0,
      y: child.y ?? seed?.y ?? 0,
      width: child.width ?? seed?.width ?? 0,
      height: child.height ?? seed?.height ?? 0,
    };
  }
  return result;
}
