/**
 * Off-ELK placement for demoted COMMONS hubs (see derive/commonsDemotion): the utility files every
 * card depends on leave the wire field entirely — feeding them to ELK would put the biggest magnet
 * in the middle of the layers and pull everything toward it. They park inside ONE labelled DOCK
 * TRAY: a real (non-interactive) parent node drawn as a quiet dashed shelf titled "COMMONS", with
 * the docked cards nested as its children — so the dock reads as a place, not as strays that fell
 * off the graph, and paint-time ghost banding treats the whole tray as one footprint (a selected
 * dock card's ghosts band OUTSIDE the tray, never onto its neighbours).
 *
 * The tray stands to the RIGHT of the graph as a VERTICAL column: the Map reads left→right
 * (importers → imported), and the commons are the level's most-imported cards — the far right is
 * where that grammar puts them. A column is also exactly the geometry the gutter-bus routes best:
 * lit wires gate once on the tray's left edge, ride the rail, and peel off at each card's own
 * height — no sibling is ever crossed. Wires still exist (paint hides them until lit), so
 * selecting a docked card lights its real connections back into the graph. Pure, deterministic.
 */

import type { Node } from "@xyflow/react";
import type { VisibleModuleNode } from "../derive/moduleTree";
import { absoluteRectOf, boundingBoxOf, type Rect } from "./ghostBandPlacement";

export const COMMONS_DOCK_TYPE = "commonsDock";
/** The tray's RF-only id — presentational, never an artifact id (nothing joins through it). */
export const COMMONS_DOCK_ID = "dock:commons";

/** Clearance between the graph's box and the tray, the tray's inner chrome, and card spacing.
 * The 30px side padding mirrors the frame gutter convention (CONTAINER_OPTIONS): the tray is a
 * FRAME to the gutter-bus router, so lit wires ride a rail inside that gutter into the cards. */
const DOCK_GAP = 88;
const CARD_GAP = 18;
const TRAY_PAD_X = 30;
const TRAY_PAD_BOTTOM = 14;
/** Room for the tray's title row ("COMMONS · n") above the cards. */
const TRAY_TITLE = 30;

export function placeCommonsDock(
  commons: VisibleModuleNode[],
  coreNodes: Node[],
  sizeOf: (node: VisibleModuleNode) => { width: number; height: number },
): Node[] {
  if (commons.length === 0) {
    return [];
  }
  const byId = new Map(coreNodes.map((node) => [node.id, node]));
  const box: Rect =
    coreNodes.length > 0
      ? boundingBoxOf(coreNodes.map((node) => absoluteRectOf(node, byId)))
      : { x: 0, y: 0, width: 0, height: 0 };
  const ordered = [...commons].sort((a, b) => a.id.localeCompare(b.id));
  const sizes = ordered.map(sizeOf);
  const columnWidth = sizes.reduce((max, size) => Math.max(max, size.width), 0);
  const columnHeight = sizes.reduce((sum, size) => sum + size.height, 0) + CARD_GAP * (ordered.length - 1);
  const trayWidth = columnWidth + TRAY_PAD_X * 2;
  const trayHeight = TRAY_TITLE + columnHeight + TRAY_PAD_BOTTOM;
  const tray: Node = {
    id: COMMONS_DOCK_ID,
    type: COMMONS_DOCK_TYPE,
    position: { x: box.x + box.width + DOCK_GAP, y: box.y + box.height / 2 - trayHeight / 2 },
    style: { width: trayWidth, height: trayHeight },
    data: { count: ordered.length },
    selectable: false,
    focusable: false,
  };
  // Children are TRAY-RELATIVE (React Flow parentId semantics); the tray comes first in the array.
  let y = TRAY_TITLE;
  const cards = ordered.map((node, index) => {
    const size = sizes[index];
    const placed: Node = {
      id: node.id,
      type: node.kind,
      parentId: COMMONS_DOCK_ID,
      position: { x: TRAY_PAD_X, y },
      style: { width: size.width, height: size.height },
      data: node.data,
    };
    y += size.height + CARD_GAP;
    return placed;
  });
  return [tray, ...cards];
}
