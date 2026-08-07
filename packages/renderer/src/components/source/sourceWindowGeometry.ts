export interface SourceWindowRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SourceWindowRegion {
  width: number;
  height: number;
}

export type SourceWindowResizeDirection =
  | "n"
  | "ne"
  | "e"
  | "se"
  | "s"
  | "sw"
  | "w"
  | "nw";

export const SOURCE_WINDOW_MARGIN = 12;
export const DEFAULT_SOURCE_WINDOW_WIDTH = 1_200;
export const DEFAULT_SOURCE_WINDOW_HEIGHT = 700;
export const MIN_SOURCE_WINDOW_WIDTH = 320;
export const MIN_SOURCE_WINDOW_HEIGHT = 320;
export const SOURCE_WINDOW_RAIL_COLLAPSE_WIDTH = 620;
export const SOURCE_WINDOW_KEYBOARD_STEP = 16;
export const SOURCE_WINDOW_KEYBOARD_LARGE_STEP = 64;

/** Responsive product default. Tiny regions surrender the margin before allowing overflow. */
export function defaultSourceWindowRect(region: SourceWindowRegion): SourceWindowRect {
  const bounds = sourceWindowBounds(region);
  const width = Math.min(DEFAULT_SOURCE_WINDOW_WIDTH, bounds.availableWidth);
  const height = Math.min(DEFAULT_SOURCE_WINDOW_HEIGHT, bounds.availableHeight);
  return {
    x: bounds.right - width,
    y: bounds.top,
    width,
    height,
  };
}

/** Resolve preferred shell-local pixels into a fully visible runtime rectangle. */
export function constrainSourceWindowRect(
  rect: SourceWindowRect,
  region: SourceWindowRegion,
): SourceWindowRect {
  const bounds = sourceWindowBounds(region);
  const fallback = defaultSourceWindowRect(region);
  const width = clamp(
    finiteOr(rect.width, fallback.width),
    Math.min(MIN_SOURCE_WINDOW_WIDTH, bounds.availableWidth),
    bounds.availableWidth,
  );
  const height = clamp(
    finiteOr(rect.height, fallback.height),
    Math.min(MIN_SOURCE_WINDOW_HEIGHT, bounds.availableHeight),
    bounds.availableHeight,
  );
  return {
    x: clamp(finiteOr(rect.x, fallback.x), bounds.left, bounds.right - width),
    y: clamp(finiteOr(rect.y, fallback.y), bounds.top, bounds.bottom - height),
    width,
    height,
  };
}

/** Move from a captured starting rectangle; callers should pass total, not incremental, deltas. */
export function moveSourceWindow(
  rect: SourceWindowRect,
  deltaX: number,
  deltaY: number,
  region: SourceWindowRegion,
): SourceWindowRect {
  const start = constrainSourceWindowRect(rect, region);
  return constrainSourceWindowRect({
    ...start,
    x: start.x + finiteOr(deltaX, 0),
    y: start.y + finiteOr(deltaY, 0),
  }, region);
}

/** Resize from any edge or corner while keeping the opposite edge fixed. */
export function resizeSourceWindow(
  rect: SourceWindowRect,
  direction: SourceWindowResizeDirection,
  deltaX: number,
  deltaY: number,
  region: SourceWindowRegion,
): SourceWindowRect {
  const start = constrainSourceWindowRect(rect, region);
  const bounds = sourceWindowBounds(region);
  const horizontal = resizeAxis({
    start: start.x,
    size: start.width,
    minimumSize: Math.min(MIN_SOURCE_WINDOW_WIDTH, bounds.availableWidth),
    minimum: bounds.left,
    maximum: bounds.right,
    delta: finiteOr(deltaX, 0),
    resizeStart: direction.includes("w"),
    resizeEnd: direction.includes("e"),
  });
  const vertical = resizeAxis({
    start: start.y,
    size: start.height,
    minimumSize: Math.min(MIN_SOURCE_WINDOW_HEIGHT, bounds.availableHeight),
    minimum: bounds.top,
    maximum: bounds.bottom,
    delta: finiteOr(deltaY, 0),
    resizeStart: direction.includes("n"),
    resizeEnd: direction.includes("s"),
  });
  return {
    x: horizontal.start,
    y: vertical.start,
    width: horizontal.size,
    height: vertical.size,
  };
}

export function moveSourceWindowForKey(
  rect: SourceWindowRect,
  key: string,
  shiftKey: boolean,
  region: SourceWindowRegion,
): SourceWindowRect | null {
  const delta = movementDeltaForKey(key, shiftKey);
  return delta === null ? null : moveSourceWindow(rect, delta.x, delta.y, region);
}

export function resizeSourceWindowForKey(
  rect: SourceWindowRect,
  direction: SourceWindowResizeDirection,
  key: string,
  shiftKey: boolean,
  region: SourceWindowRegion,
): SourceWindowRect | null {
  const delta = movementDeltaForKey(key, shiftKey);
  if (delta === null) return null;
  const horizontal = direction.includes("e") || direction.includes("w");
  const vertical = direction.includes("n") || direction.includes("s");
  if ((delta.x !== 0 && !horizontal) || (delta.y !== 0 && !vertical)) return null;
  return resizeSourceWindow(rect, direction, delta.x, delta.y, region);
}

export function sourceWindowShouldCollapseRail(width: number): boolean {
  return !Number.isFinite(width) || width < SOURCE_WINDOW_RAIL_COLLAPSE_WIDTH;
}

/** Truthful size range for one anchored resize edge. The opposite edge remains fixed, so its
 * reachable maximum can be smaller than the region's total available width or height. */
export function sourceWindowResizeValueBounds(
  rect: SourceWindowRect,
  direction: Extract<SourceWindowResizeDirection, "n" | "e" | "s" | "w">,
  region: SourceWindowRegion,
): { minimum: number; maximum: number } {
  const resolved = constrainSourceWindowRect(rect, region);
  const bounds = sourceWindowBounds(region);
  const horizontal = direction === "e" || direction === "w";
  const maximum = direction === "e"
    ? bounds.right - resolved.x
    : direction === "w"
      ? resolved.x + resolved.width - bounds.left
      : direction === "s"
        ? bounds.bottom - resolved.y
        : resolved.y + resolved.height - bounds.top;
  const productMinimum = horizontal ? MIN_SOURCE_WINDOW_WIDTH : MIN_SOURCE_WINDOW_HEIGHT;
  return {
    minimum: Math.min(productMinimum, maximum),
    maximum,
  };
}

interface ResolvedSourceWindowBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
  availableWidth: number;
  availableHeight: number;
}

function sourceWindowBounds(region: SourceWindowRegion): ResolvedSourceWindowBounds {
  const width = Math.max(0, finiteOr(region.width, 0));
  const height = Math.max(0, finiteOr(region.height, 0));
  const horizontalMargin = width >= SOURCE_WINDOW_MARGIN * 2 ? SOURCE_WINDOW_MARGIN : 0;
  const verticalMargin = height >= SOURCE_WINDOW_MARGIN * 2 ? SOURCE_WINDOW_MARGIN : 0;
  return {
    left: horizontalMargin,
    top: verticalMargin,
    right: width - horizontalMargin,
    bottom: height - verticalMargin,
    availableWidth: Math.max(0, width - horizontalMargin * 2),
    availableHeight: Math.max(0, height - verticalMargin * 2),
  };
}

function resizeAxis(args: {
  start: number;
  size: number;
  minimumSize: number;
  minimum: number;
  maximum: number;
  delta: number;
  resizeStart: boolean;
  resizeEnd: boolean;
}): { start: number; size: number } {
  if (args.resizeStart) {
    const fixedEnd = args.start + args.size;
    const start = clamp(args.start + args.delta, args.minimum, fixedEnd - args.minimumSize);
    return { start, size: fixedEnd - start };
  }
  if (args.resizeEnd) {
    const end = clamp(
      args.start + args.size + args.delta,
      args.start + args.minimumSize,
      args.maximum,
    );
    return { start: args.start, size: end - args.start };
  }
  return { start: args.start, size: args.size };
}

function movementDeltaForKey(
  key: string,
  shiftKey: boolean,
): { x: number; y: number } | null {
  const step = shiftKey ? SOURCE_WINDOW_KEYBOARD_LARGE_STEP : SOURCE_WINDOW_KEYBOARD_STEP;
  if (key === "ArrowLeft") return { x: -step, y: 0 };
  if (key === "ArrowRight") return { x: step, y: 0 };
  if (key === "ArrowUp") return { x: 0, y: -step };
  if (key === "ArrowDown") return { x: 0, y: step };
  return null;
}

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
