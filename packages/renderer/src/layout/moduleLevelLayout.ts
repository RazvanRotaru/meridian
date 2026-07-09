/**
 * Lay the Module-map's containment tree out as a NESTED dependency diagram: ELK `layered` left→right
 * so importers sit left of what they import, with expanded group cards recursing as ELK containers
 * (their children placed INSIDE them, parent-relative — exactly React Flow's parentId semantics).
 * Built on the shared `elkNesting` primitives, same as the call/logic graphs, so `INCLUDE_CHILDREN`
 * lives on the ROOT ONLY (setting it per-subgraph throws). Every leaf card sizes to its own content
 * (label + badges + metric row), so long component names never clip. Deterministic — ELK layered is
 * stable and no Math.random/Date is used.
 */

import type { ElkNode } from "elkjs/lib/elk-api";
import type { Edge, Node } from "@xyflow/react";
import { runElkLayout } from "./elkLayout";
import { buildNestedElkGraph, emitReactFlowNodes, parentRelativePlacement, type ElkNestAdapter } from "./elkNesting";
import { clamp, countsRowWidth, monoTextWidth, pillWidth } from "./measure";
import type { ModuleGroupData, ModuleTreeEdge, VisibleModuleNode } from "../derive/moduleTree";
import type { BlockData, ModuleCardData, UnitCardData } from "../derive/moduleLevel";
import type { StepData } from "../derive/flowSteps";
import type { GhostData } from "../derive/ghostDeps";

const GROUP_HEIGHT = 76;
const FILE_HEIGHT = 54;
// A memberless unit is compact; a collapsed memberful unit mirrors the file-card height.
const UNIT_LEAF_HEIGHT = 42;
const UNIT_CONTAINER_CARD_HEIGHT = 54;

// Group/file/unit cards size to their content — the mono label, any badges, and the metric row — so a
// long component name is never clipped. Clamped to a readable floor and a ceiling that still fits any
// real name, so a pathological generated name can't blow the layout out sideways.
const CARD_MIN_WIDTH = 150;
const CARD_MAX_WIDTH = 420;
const CHEVRON_WIDTH = 16; // the expand-chevron button (frameChrome CHEVRON)
const HEADER_GAP = 6; // gap between chevron / label / trailing badge in a header
const META_GAP = 8; // gap between the metric groups on a card's meta row
const COUNTS_GAP = 4; // gap between the spans inside one `uses N used by N` group
const CHIP_FONT = 8; // category / kind chips and the ENTRY badge
const CHIP_LETTER_SPACING = CHIP_FONT * 0.06; // chips render with letter-spacing: 0.06em
// Per-card chrome = 1px border each side + inner horizontal padding (left + right), matching each
// card component's CARD/INNER styles.
const PACKAGE_CHROME = 2 + 14 + 12;
const FILE_CHROME = 2 + 12 + 10;
const UNIT_CHROME = 2 + 12 + 10;
const UNIT_ROW_GAP = 7; // gap between glyph / label / kind chip on a unit card's single row
const UNIT_GLYPH_WIDTH = 12; // one geometric kind glyph rendered at 11px
// Code blocks (methods, functions, type definitions): a kind glyph + name (+ a chevron when the block
// has a charted flow), sized to that name so long identifiers never clip.
const BLOCK_MIN_WIDTH = 120;
const BLOCK_MAX_WIDTH = 420;
const BLOCK_HEIGHT = 30;
const BLOCK_ROW_GAP = 6;
const BLOCK_CHROME = 2 + 5 + 9; // border + inner padding (left 5 + right 9)
// Flow steps are the smallest shapes on the canvas — a glyph + name (+ chevron when expandable).
const STEP_MIN_WIDTH = 96;
const STEP_MAX_WIDTH = 360;
const STEP_HEIGHT = 26;
const STEP_ROW_GAP = 5;
const STEP_CHROME = 2 + 5 + 8; // border + inner padding (left 5 + right 8)
// Ghost cards (off-screen definitions/callers): two lines — qualified name + faint home file — sized
// to whichever line is longer so neither clips.
const GHOST_MIN_WIDTH = 150;
const GHOST_MAX_WIDTH = 420;
const GHOST_HEIGHT = 42;
const GHOST_ROW_GAP = 5;
const GHOST_CHROME = 2 + 9 + 9; // border + inner padding (left 9 + right 9)
const CODE_GLYPH_WIDTH = 9; // the ƒ / τ / kind glyph on code + ghost cards
// Every located card (file, unit, block) now trails a `</>` code button, and a changed one also a
// "Δ n" chip. Reserve room for both in the label row so a long name is never crowded out — the clip
// the reader hit on `f cons…` / `f _ensu…`. Δ is over-reserved on unchanged cards (the layout can't
// see the diff sets), a small, safe cost that guarantees nothing clips.
const CODE_BTN_WIDTH = pillWidth("</>", 9, { padX: 4 });
const DELTA_CHIP_WIDTH = pillWidth("Δ 99", CHIP_FONT, { padX: 4, letterSpacing: CHIP_LETTER_SPACING });
const TRAILING_BADGES = HEADER_GAP + DELTA_CHIP_WIDTH + HEADER_GAP + CODE_BTN_WIDTH;

const ROOT_OPTIONS: Record<string, string> = {
  "elk.algorithm": "layered",
  "elk.direction": "RIGHT",
  "elk.hierarchyHandling": "INCLUDE_CHILDREN",
  "elk.spacing.nodeNode": "44",
  "elk.layered.spacing.nodeNodeBetweenLayers": "120",
  "elk.spacing.edgeNode": "28",
};

// Top padding leaves room for an expanded group's title bar; React Flow draws nothing there itself.
const CONTAINER_OPTIONS: Record<string, string> = { "elk.padding": "[top=44,left=18,bottom=18,right=18]" };

const adapter: ElkNestAdapter<VisibleModuleNode> = {
  id: (node) => node.id,
  parentId: (node) => node.parentId,
  isContainer: (node) => node.isExpanded,
  leafSize: (node) => leafSize(node),
  containerOptions: CONTAINER_OPTIONS,
};

/** Run ELK over the nested tree and map the placed (parent-relative) coordinates to React Flow. */
export async function layoutModuleTree(nodes: VisibleModuleNode[], edges: ModuleTreeEdge[]): Promise<{ nodes: Node[]; edges: Edge[] }> {
  if (nodes.length === 0) {
    return { nodes: [], edges: [] };
  }
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const laid = await runElkLayout(buildNestedElkGraph(nodes, edges, adapter, ROOT_OPTIONS));
  const placed = emitReactFlowNodes(laid, (elkNode, parentId) => toNode(elkNode, parentId, byId));
  return { nodes: placed, edges: edges.map(toEdge) };
}

/** Every leaf card sizes to its own content so a long name is never clipped: blocks/steps/ghosts
 * track their label; group/file/unit-leaf cards measure name + badges + metric row. Expanded groups,
 * file frames, and unit frames are ELK-sized around their children. */
function leafSize(node: VisibleModuleNode): { width: number; height: number } {
  if (node.kind === "ghost") {
    return ghostSize(node.data as GhostData);
  }
  if (node.kind === "step") {
    return stepSize(node.data as StepData);
  }
  if (node.kind === "block") {
    return blockSize(node.data as BlockData);
  }
  if (node.kind === "unit") {
    return unitSize(node.data as UnitCardData);
  }
  if (node.kind === "file") {
    return fileSize(node.data as ModuleCardData);
  }
  return groupSize(node.data as ModuleGroupData);
}

/** A package/directory group card: chevron + name in the header, `N files` + `uses N used by N` on
 * the meta row below — the box fits whichever of the two lines is wider. */
function groupSize(data: ModuleGroupData): { width: number; height: number } {
  const header = (data.isContainer ? CHEVRON_WIDTH + HEADER_GAP : 0) + monoTextWidth(data.label, 13);
  const meta =
    monoTextWidth(`${data.fileCount} files`, 11) +
    META_GAP +
    countsRowWidth(["uses", String(data.ce), "used by", String(data.ca)], 10.5, COUNTS_GAP);
  return { width: cardWidth(PACKAGE_CHROME + Math.max(header, meta)), height: GROUP_HEIGHT };
}

/** A source-file card: chevron + name (+ ENTRY badge) in the header, a category chip + `in N out N`
 * on the meta row. */
function fileSize(data: ModuleCardData): { width: number; height: number } {
  const chevron = data.isContainer ? CHEVRON_WIDTH + HEADER_GAP : 0;
  const entry = data.isEntry ? HEADER_GAP + pillWidth("ENTRY", CHIP_FONT, { letterSpacing: CHIP_LETTER_SPACING }) : 0;
  const header = chevron + monoTextWidth(data.label, 12.5) + entry + TRAILING_BADGES;
  const meta =
    pillWidth(data.category.toUpperCase(), CHIP_FONT, { letterSpacing: CHIP_LETTER_SPACING }) +
    META_GAP +
    countsRowWidth(["in", String(data.inCount), "out", String(data.outCount)], 10.5, COUNTS_GAP);
  return { width: cardWidth(FILE_CHROME + Math.max(header, meta)), height: FILE_HEIGHT };
}

/** A unit identity card: memberless units use one row; collapsed memberful units add a meta row. */
function unitSize(data: UnitCardData): { width: number; height: number } {
  const chip = pillWidth(data.unitKind.toUpperCase(), CHIP_FONT, { letterSpacing: CHIP_LETTER_SPACING });
  if (data.isContainer) {
    const header = CHEVRON_WIDTH + HEADER_GAP + UNIT_GLYPH_WIDTH + HEADER_GAP + monoTextWidth(data.label, 12.5) + TRAILING_BADGES;
    const meta = chip + META_GAP + monoTextWidth(`${data.memberCount} members`, 10.5);
    return { width: cardWidth(UNIT_CHROME + Math.max(header, meta)), height: UNIT_CONTAINER_CARD_HEIGHT };
  }
  const content = UNIT_GLYPH_WIDTH + UNIT_ROW_GAP + monoTextWidth(data.label, 12.5) + UNIT_ROW_GAP + chip + TRAILING_BADGES;
  return { width: cardWidth(UNIT_CHROME + content), height: UNIT_LEAF_HEIGHT };
}

/** Round a measured content width and clamp it to the shared card floor/ceiling. */
function cardWidth(content: number): number {
  return Math.round(clamp(CARD_MIN_WIDTH, CARD_MAX_WIDTH, content));
}

function blockSize(data: BlockData): { width: number; height: number } {
  const chevron = data.hasFlow ? CHEVRON_WIDTH + BLOCK_ROW_GAP : 0;
  const content = chevron + CODE_GLYPH_WIDTH + BLOCK_ROW_GAP + monoTextWidth(data.label, 11.5) + TRAILING_BADGES;
  return { width: Math.round(clamp(BLOCK_MIN_WIDTH, BLOCK_MAX_WIDTH, BLOCK_CHROME + content)), height: BLOCK_HEIGHT };
}

function stepSize(data: StepData): { width: number; height: number } {
  const chevron = data.isContainer ? CHEVRON_WIDTH + STEP_ROW_GAP : 0;
  const content = chevron + CODE_GLYPH_WIDTH + STEP_ROW_GAP + monoTextWidth(data.label, 10.5);
  return { width: Math.round(clamp(STEP_MIN_WIDTH, STEP_MAX_WIDTH, STEP_CHROME + content)), height: STEP_HEIGHT };
}

/** A ghost card stacks a name over a faint home-file line; size to the wider of the two. */
function ghostSize(data: GhostData): { width: number; height: number } {
  const head = CODE_GLYPH_WIDTH + GHOST_ROW_GAP + monoTextWidth(data.label, 11);
  const context = data.context ? monoTextWidth(data.context, 9) : 0;
  return { width: Math.round(clamp(GHOST_MIN_WIDTH, GHOST_MAX_WIDTH, GHOST_CHROME + Math.max(head, context))), height: GHOST_HEIGHT };
}

/** Map one placed ELK node back to a React Flow node, wired to its parent frame when nested. */
function toNode(elkNode: ElkNode, parentId: string | undefined, byId: Map<string, VisibleModuleNode>): Node | null {
  const node = byId.get(elkNode.id);
  if (!node) {
    return null;
  }
  const placement = parentRelativePlacement(elkNode, parentId);
  return {
    id: node.id,
    type: node.kind,
    position: placement.position,
    style: { width: placement.width, height: placement.height },
    data: node.data,
    ...(placement.parentId ? { parentId: placement.parentId, extent: placement.extent } : {}),
  };
}

function toEdge(edge: ModuleTreeEdge): Edge {
  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    data: { weight: edge.weight, crossFrame: edge.crossFrame, category: edge.category, ghost: edge.ghost === true, depKind: edge.depKind },
    // Edge hit-paths sit above nested frames' title bars and steal button clicks; Map edges are non-interactive.
    interactionWidth: 0,
  };
}
