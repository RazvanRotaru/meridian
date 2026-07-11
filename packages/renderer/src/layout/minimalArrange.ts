/**
 * The minimal-graph overlay's "Re-arrange" layout: a FRESH canonical canvas ELK pass over the
 * current leaf cards, IGNORING the captured map positions. Where the map-mirror keeps every card at its
 * (possibly far-apart) map spot, this lays the graph out compactly left→right by its visible relations — the
 * fix for a selection whose members mirror distant map locations. Each card enters at its real rendered
 * size so ELK reserves the right footprint.
 */

import type { ElkNode } from "elkjs/lib/elk-api";
import { CANVAS_ROOT_ELK_OPTIONS, FLAT_CANVAS_ELK_OPTIONS } from "./elkCanvasOptions";
import { runElkLayout } from "./elkLayout";
import { ELK_ROOT_ID } from "./elkNesting";
import { FILE_WIDTH, FILE_HEIGHT, type PlacedRect } from "./minimalPlacement";

type Size = { width: number; height: number };
type SizeOf = (id: string) => Size;
const ARRANGE_CONTAINER_ID = "__minimal_arrange_cards__";
const PACK_PADDING = 12;
const PACK_GAP = Number(CANVAS_ROOT_ELK_OPTIONS["elk.spacing.nodeNode"]);

/** Lay the cards out fresh: one ELK leaf per card (at its size), wired by visible internal relations.
 * Returns absolute rects (flat graph), falling back to the given size if ELK omits one. */
export async function arrangeMinimalCards(
  cardIds: readonly string[],
  sizes: Record<string, Size>,
  layoutEdges: readonly { source: string; target: string }[],
): Promise<Record<string, PlacedRect>> {
  const ids = new Set(cardIds);
  const sizeOf = (id: string): Size => sizes[id] ?? { width: FILE_WIDTH, height: FILE_HEIGHT };
  const children: ElkNode[] = cardIds.map((id) => ({ id, ...sizeOf(id) }));
  const edges = arrangementEdges(layoutEdges, ids);
  // With INCLUDE_CHILDREN on a flat root, ELK 0.11 stacks disconnected direct leaves into one
  // column and never invokes its component packer. This transparent layout-only container opts its
  // children out of cross-hierarchy processing, so ELK packs them across columns while the real root
  // still reuses the canonical options by identity. It is flattened away below and never renders.
  const graph: ElkNode = {
    id: ELK_ROOT_ID,
    layoutOptions: CANVAS_ROOT_ELK_OPTIONS,
    children: [{ id: ARRANGE_CONTAINER_ID, layoutOptions: FLAT_CANVAS_ELK_OPTIONS, children }],
    edges,
  };
  const laid = await runElkLayout(graph);
  const container = laid.children?.find((child) => child.id === ARRANGE_CONTAINER_ID);
  const offsetX = container?.x ?? 0;
  const offsetY = container?.y ?? 0;
  const result: Record<string, PlacedRect> = {};
  for (const child of container?.children ?? []) {
    const size = sizeOf(child.id);
    result[child.id] = {
      x: offsetX + (child.x ?? 0),
      y: offsetY + (child.y ?? 0),
      width: child.width ?? size.width,
      height: child.height ?? size.height,
    };
  }
  return ensureMultipleColumns(cardIds, result, sizeOf);
}

/** ELK needs one structural edge per drawn card pair; several coupling kinds between the same pair
 * should shape the layout once, not gain accidental extra weight. */
function arrangementEdges(
  layoutEdges: readonly { source: string; target: string }[],
  cardIds: ReadonlySet<string>,
): NonNullable<ElkNode["edges"]> {
  const seen = new Set<string>();
  const result: NonNullable<ElkNode["edges"]> = [];
  for (const edge of layoutEdges) {
    const key = `${edge.source}\0${edge.target}`;
    if (!cardIds.has(edge.source) || !cardIds.has(edge.target) || seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push({ id: `arrange:${result.length}`, sources: [edge.source], targets: [edge.target] });
  }
  return result;
}

/** ELK's component packer still chooses a column for some equal-sized disconnected sets. Keep its
 * result whenever it produced real columns; otherwise apply a deterministic grid as a hard visual
 * postcondition. Connected layered graphs normally never enter this fallback. */
function ensureMultipleColumns(
  cardIds: readonly string[],
  placement: Record<string, PlacedRect>,
  sizeOf: SizeOf,
): Record<string, PlacedRect> {
  const rects = cardIds.flatMap((id) => (placement[id] ? [placement[id]] : []));
  if (cardIds.length <= 1 || (rects.length === cardIds.length && hasSideBySidePair(rects))) {
    return placement;
  }
  return gridPlacement(cardIds, sizeOf);
}

function hasSideBySidePair(rects: readonly PlacedRect[]): boolean {
  return rects.some((left, index) =>
    rects.slice(index + 1).some((right) => left.x + left.width <= right.x || right.x + right.width <= left.x),
  );
}

/** Row-major compact grid with size-aware column/row tracks; two or more cards always get at least
 * two horizontally disjoint columns. */
function gridPlacement(cardIds: readonly string[], sizeOf: SizeOf): Record<string, PlacedRect> {
  const columnCount = Math.min(cardIds.length, Math.max(2, Math.ceil(Math.sqrt(cardIds.length))));
  const rowCount = Math.ceil(cardIds.length / columnCount);
  const columnWidths = Array<number>(columnCount).fill(0);
  const rowHeights = Array<number>(rowCount).fill(0);
  cardIds.forEach((id, index) => {
    const size = sizeOf(id);
    const column = index % columnCount;
    const row = Math.floor(index / columnCount);
    columnWidths[column] = Math.max(columnWidths[column], size.width);
    rowHeights[row] = Math.max(rowHeights[row], size.height);
  });
  const xOffsets = trackOffsets(columnWidths);
  const yOffsets = trackOffsets(rowHeights);
  return Object.fromEntries(
    cardIds.map((id, index) => [
      id,
      {
        x: xOffsets[index % columnCount],
        y: yOffsets[Math.floor(index / columnCount)],
        ...sizeOf(id),
      },
    ]),
  );
}

function trackOffsets(trackSizes: readonly number[]): number[] {
  const offsets: number[] = [];
  let cursor = PACK_PADDING;
  for (const size of trackSizes) {
    offsets.push(cursor);
    cursor += size + PACK_GAP;
  }
  return offsets;
}
