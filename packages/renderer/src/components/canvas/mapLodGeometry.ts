import type { Node } from "@xyflow/react";
import { absoluteRectOf, boundingBoxOf } from "../../layout/ghostBandPlacement";
import { CANVAS_MIN_ZOOM } from "./flowCanvasProps";

export interface GraphRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The first detail graph starts previewing its enclosing node below this zoom. */
export const SEMANTIC_FIRST_PREVIEW_MAX = 0.45;

/**
 * Every threshold is this fraction of the previous threshold. Alternating reading and preview
 * intervals gives each newly revealed parent graph a real reading window before it starts its own
 * transition. The first sequence is therefore:
 *
 *   detail reading >= .45
 *   detail preview  .30 .. .45
 *   parent reading  .20 .. .30
 *   parent preview  .133 .. .20
 *   grandparent reading ...
 */
export const SEMANTIC_ZOOM_BAND_RATIO = 2 / 3;

/**
 * Preserve the roomy 2/3 bands for ordinary paths, but compress them just enough when a hierarchy
 * is unusually deep that its final canonical level remains reachable at the canvas minimum zoom.
 */
export function semanticZoomBandRatio(
  layerCount: number,
  firstPreviewMax: number = SEMANTIC_FIRST_PREVIEW_MAX,
): number {
  const transitions = Math.max(0, Math.floor(layerCount) - 1);
  if (transitions === 0) {
    return SEMANTIC_ZOOM_BAND_RATIO;
  }
  const previewMax = validFirstPreviewMax(firstPreviewMax);
  const required = (CANVAS_MIN_ZOOM / previewMax) ** (1 / (transitions * 2));
  return Math.max(SEMANTIC_ZOOM_BAND_RATIO, required);
}

/** Give a fitted graph a real reading interval even when its whole-graph fit is below the ordinary
 * .45 threshold. The first outward preview starts one ratio below that fitted reading zoom; normal
 * sized graphs keep the established .45 ceiling. */
export function semanticFirstPreviewMaxForReadingZoom(readingZoom: number): number {
  const safeReadingZoom = Number.isFinite(readingZoom) && readingZoom > 0
    ? readingZoom
    : SEMANTIC_FIRST_PREVIEW_MAX;
  return Math.min(SEMANTIC_FIRST_PREVIEW_MAX, safeReadingZoom * SEMANTIC_ZOOM_BAND_RATIO);
}

/**
 * Metadata for one independently laid semantic graph. Depth is a stable identity from the original
 * stack; after an outward commit, the smallest retained depth becomes the current graph.
 */
export interface SemanticLodLayer {
  depth: number;
  focus: string | null;
  /** The node in this layer which the preceding detail graph collapses into. */
  anchorId: string;
  /** Optional already-resolved anchor label for the preceding layer's preview frame. */
  label?: string;
}

export type MapSemanticStage = "reading" | "preview";

export interface SemanticZoomBand {
  /** The graph which stays visible in this band. */
  depth: number;
  stage: MapSemanticStage;
  /** During preview, the next graph whose anchor is being foreshadowed. */
  previewDepth?: number;
}

/**
 * The zoom where the graph at `depth` stops being a preview and the next retained depth becomes
 * canonical. Absolute depth values identify layers, while their position in the retained stack
 * determines the threshold. A promoted parent therefore starts again at the first transition
 * after the camera is reset to a normal reading zoom. Passing the preceding origin keeps the old
 * threshold sequence stable during that reset animation.
 */
export function semanticCommitZoomForDepth(
  depth: number,
  layerDepths: readonly number[],
  originDepth?: number,
  firstPreviewMax: number = SEMANTIC_FIRST_PREVIEW_MAX,
): number {
  const depths = normalizedSemanticDepths(layerDepths);
  const origin = semanticOriginDepth(depths, originDepth);
  if (origin === null || !depths.includes(depth) || depth >= depths[depths.length - 1]) {
    return Number.NaN;
  }
  const previewMax = validFirstPreviewMax(firstPreviewMax);
  const ratio = semanticZoomBandRatio(depths[depths.length - 1] - origin + 1, previewMax);
  return previewMax * ratio ** ((depth - origin) * 2 + 1);
}

/**
 * Resolve a zoom against any number of pre-mounted semantic levels. This is deliberately pure:
 * no focus mutation, timeout, or sticky direction state is involved. Thresholds are relative to
 * the smallest retained depth, so every promoted parent receives the same reading and preview
 * windows after the owner resets the camera.
 */
export function semanticZoomBandForZoom(
  zoom: number,
  layerDepths: readonly number[],
  originDepth?: number,
  firstPreviewMax: number = SEMANTIC_FIRST_PREVIEW_MAX,
): SemanticZoomBand | null {
  const depths = normalizedSemanticDepths(layerDepths);
  if (depths.length === 0) {
    return null;
  }

  const safeZoom = Number.isFinite(zoom) && zoom >= 0 ? zoom : Number.POSITIVE_INFINITY;
  const origin = semanticOriginDepth(depths, originDepth) ?? depths[0];
  const previewCeiling = validFirstPreviewMax(firstPreviewMax);
  const ratio = semanticZoomBandRatio(depths[depths.length - 1] - origin + 1, previewCeiling);
  for (let transition = 0; transition < depths.length - 1; transition += 1) {
    const depth = depths[transition];
    const previewMax = previewCeiling * ratio ** ((depth - origin) * 2);
    const commitMax = previewMax * ratio;
    if (safeZoom >= previewMax) {
      return { depth, stage: "reading" };
    }
    if (safeZoom >= commitMax) {
      return {
        depth,
        stage: "preview",
        previewDepth: depths[transition + 1],
      };
    }
  }

  return { depth: depths[depths.length - 1], stage: "reading" };
}

/**
 * Resolve one outward navigation commit from consecutive samples of a user camera move. The caller
 * gates samples by their browser event, so programmatic fits never enter this function. Inward and
 * unchanged movement returns null.
 *
 * A coarse wheel sample can cross several boundaries at once. Return the canonical depth visible
 * at the sample's zoom so the store can commit that exact graph atomically; URL/focus state must
 * never lag behind the population MapLod has revealed.
 */
export function semanticCommitDepthForZoomChange(
  previousZoom: number | null,
  zoom: number,
  layerDepths: readonly number[],
  originDepth?: number,
  firstPreviewMax: number = SEMANTIC_FIRST_PREVIEW_MAX,
): number | null {
  if (
    previousZoom === null ||
    !Number.isFinite(previousZoom) ||
    !Number.isFinite(zoom) ||
    zoom >= previousZoom
  ) {
    return null;
  }
  const depths = normalizedSemanticDepths(layerDepths);
  if (depths.length < 2) {
    return null;
  }

  const band = semanticZoomBandForZoom(zoom, depths, originDepth, firstPreviewMax);
  return band !== null && band.depth > depths[0] ? band.depth : null;
}

/** Stable, defensive ordering for store metadata and DOM-rule generation. */
export function normalizedSemanticDepths(depths: readonly number[]): number[] {
  return [...new Set(depths.filter((depth) => Number.isInteger(depth) && depth >= 0))].sort((a, b) => a - b);
}

/**
 * Resolve the threshold origin without changing absolute layer identities. The optional override
 * may point at an already-discarded inner layer during a camera handoff, but never past the current
 * retained graph. Invalid overrides safely rebase to that current graph.
 */
function semanticOriginDepth(depths: readonly number[], originDepth?: number): number | null {
  if (depths.length === 0) {
    return null;
  }
  return Number.isInteger(originDepth) && originDepth! >= 0 && originDepth! <= depths[0]
    ? originDepth!
    : depths[0];
}

function validFirstPreviewMax(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : SEMANTIC_FIRST_PREVIEW_MAX;
}

/** Screen-space chrome reserved around the structural graph when it becomes one parent node. */
export const PARENT_FRAME_HEADER_PX = 34;
const PARENT_FRAME_SIDE_PX = 18;
const PARENT_FRAME_BODY_TOP_PX = 16;
const PARENT_FRAME_BOTTOM_PX = 18;

/** Bounds of the structural graph in absolute flow coordinates. Nested nodes are parent-relative,
 * so their ancestor positions must be accumulated before taking the bounds. Off-level ghost cards
 * do not move the parent frame; if a surface somehow consists only of ghosts, they are the safe
 * fallback rather than returning no enclosure. */
export function structuralGraphBounds(nodes: readonly Node[], candidates: readonly Node[] = nodes): GraphRect | null {
  const structural = candidates.filter((node) => node.type !== "ghost");
  const bounded = structural.length > 0 ? structural : candidates;
  if (bounded.length === 0) {
    return null;
  }
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const box = boundingBoxOf(bounded.map((node) => absoluteRectOf(node, byId)));
  if (![box.x, box.y, box.width, box.height].every(Number.isFinite)) {
    return null;
  }
  return box;
}

/** A parent-node rect that encloses `bounds` while keeping its header and gutters a stable size on
 * screen. The ViewportPortal applies canvas zoom later, so pixel chrome becomes flow-space distance
 * by dividing through the current zoom. */
export function enclosingParentFrame(bounds: GraphRect, zoom: number): GraphRect {
  const safeZoom = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  const side = PARENT_FRAME_SIDE_PX / safeZoom;
  const top = (PARENT_FRAME_HEADER_PX + PARENT_FRAME_BODY_TOP_PX) / safeZoom;
  const bottom = PARENT_FRAME_BOTTOM_PX / safeZoom;
  return {
    x: bounds.x - side,
    y: bounds.y - top,
    width: bounds.width + side * 2,
    height: bounds.height + top + bottom,
  };
}
