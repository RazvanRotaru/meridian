import { describe, expect, it } from "vitest";
import {
  DEFAULT_SOURCE_WINDOW_HEIGHT,
  DEFAULT_SOURCE_WINDOW_WIDTH,
  MIN_SOURCE_WINDOW_HEIGHT,
  MIN_SOURCE_WINDOW_WIDTH,
  SOURCE_WINDOW_KEYBOARD_LARGE_STEP,
  SOURCE_WINDOW_KEYBOARD_STEP,
  SOURCE_WINDOW_MARGIN,
  SOURCE_WINDOW_RAIL_COLLAPSE_WIDTH,
  constrainSourceWindowRect,
  defaultSourceWindowRect,
  moveSourceWindow,
  moveSourceWindowForKey,
  resizeSourceWindow,
  resizeSourceWindowForKey,
  sourceWindowResizeValueBounds,
  sourceWindowShouldCollapseRail,
  type SourceWindowRect,
  type SourceWindowResizeDirection,
} from "./sourceWindowGeometry";

const REGION = { width: 1_600, height: 900 };
const RECT: SourceWindowRect = { x: 100, y: 80, width: 900, height: 600 };

describe("source window defaults and constraints", () => {
  it("places the responsive product default inside a safe margin", () => {
    expect(defaultSourceWindowRect(REGION)).toEqual({
      x: REGION.width - SOURCE_WINDOW_MARGIN - DEFAULT_SOURCE_WINDOW_WIDTH,
      y: SOURCE_WINDOW_MARGIN,
      width: DEFAULT_SOURCE_WINDOW_WIDTH,
      height: DEFAULT_SOURCE_WINDOW_HEIGHT,
    });
    expect(defaultSourceWindowRect({ width: 800, height: 500 })).toEqual({
      x: SOURCE_WINDOW_MARGIN,
      y: SOURCE_WINDOW_MARGIN,
      width: 800 - SOURCE_WINDOW_MARGIN * 2,
      height: 500 - SOURCE_WINDOW_MARGIN * 2,
    });
  });

  it("shrinks below the ordinary minimum only when the region cannot fit it", () => {
    expect(defaultSourceWindowRect({ width: 300, height: 250 })).toEqual({
      x: SOURCE_WINDOW_MARGIN,
      y: SOURCE_WINDOW_MARGIN,
      width: 276,
      height: 226,
    });
    expect(defaultSourceWindowRect({ width: 20, height: 10 })).toEqual({
      x: 0,
      y: 0,
      width: 20,
      height: 10,
    });
  });

  it("clamps size and position without mutating the preferred rectangle", () => {
    const preferred = { x: 1_500, y: -100, width: 100, height: 2_000 };
    expect(constrainSourceWindowRect(preferred, REGION)).toEqual({
      x: 1_600 - SOURCE_WINDOW_MARGIN - MIN_SOURCE_WINDOW_WIDTH,
      y: SOURCE_WINDOW_MARGIN,
      width: MIN_SOURCE_WINDOW_WIDTH,
      height: 900 - SOURCE_WINDOW_MARGIN * 2,
    });
    expect(preferred).toEqual({ x: 1_500, y: -100, width: 100, height: 2_000 });
  });

  it("falls back from non-finite rectangle and region values", () => {
    expect(constrainSourceWindowRect({
      x: Number.NaN,
      y: Number.POSITIVE_INFINITY,
      width: Number.NaN,
      height: Number.NEGATIVE_INFINITY,
    }, REGION)).toEqual(defaultSourceWindowRect(REGION));
    expect(defaultSourceWindowRect({ width: Number.NaN, height: -4 })).toEqual({
      x: 0,
      y: 0,
      width: 0,
      height: 0,
    });
  });
});

describe("source window pointer geometry", () => {
  it("moves from total deltas and clamps every viewport edge", () => {
    expect(moveSourceWindow(RECT, 50, -30, REGION)).toEqual({ ...RECT, x: 150, y: 50 });
    expect(moveSourceWindow(RECT, -1_000, 1_000, REGION)).toEqual({
      ...RECT,
      x: SOURCE_WINDOW_MARGIN,
      y: 900 - SOURCE_WINDOW_MARGIN - RECT.height,
    });
  });

  it.each([
    ["n", { x: 100, y: 120, width: 900, height: 560 }],
    ["ne", { x: 100, y: 120, width: 940, height: 560 }],
    ["e", { x: 100, y: 80, width: 940, height: 600 }],
    ["se", { x: 100, y: 80, width: 940, height: 640 }],
    ["s", { x: 100, y: 80, width: 900, height: 640 }],
    ["sw", { x: 140, y: 80, width: 860, height: 640 }],
    ["w", { x: 140, y: 80, width: 860, height: 600 }],
    ["nw", { x: 140, y: 120, width: 860, height: 560 }],
  ] satisfies Array<[SourceWindowResizeDirection, SourceWindowRect]>)
  ("resizes %s while preserving the opposite edges", (direction, expected) => {
    expect(resizeSourceWindow(RECT, direction, 40, 40, REGION)).toEqual(expected);
  });

  it("enforces minimums and region maximums from every anchored side", () => {
    expect(resizeSourceWindow(RECT, "nw", 2_000, 2_000, REGION)).toEqual({
      x: RECT.x + RECT.width - MIN_SOURCE_WINDOW_WIDTH,
      y: RECT.y + RECT.height - MIN_SOURCE_WINDOW_HEIGHT,
      width: MIN_SOURCE_WINDOW_WIDTH,
      height: MIN_SOURCE_WINDOW_HEIGHT,
    });
    expect(resizeSourceWindow(RECT, "se", 2_000, 2_000, REGION)).toEqual({
      ...RECT,
      width: REGION.width - SOURCE_WINDOW_MARGIN - RECT.x,
      height: REGION.height - SOURCE_WINDOW_MARGIN - RECT.y,
    });
  });

  it("reports the reachable ARIA range for each fixed opposite edge", () => {
    expect(sourceWindowResizeValueBounds(RECT, "e", REGION)).toEqual({
      minimum: MIN_SOURCE_WINDOW_WIDTH,
      maximum: REGION.width - SOURCE_WINDOW_MARGIN - RECT.x,
    });
    expect(sourceWindowResizeValueBounds(RECT, "w", REGION)).toEqual({
      minimum: MIN_SOURCE_WINDOW_WIDTH,
      maximum: RECT.x + RECT.width - SOURCE_WINDOW_MARGIN,
    });
    expect(sourceWindowResizeValueBounds(RECT, "s", REGION)).toEqual({
      minimum: MIN_SOURCE_WINDOW_HEIGHT,
      maximum: REGION.height - SOURCE_WINDOW_MARGIN - RECT.y,
    });
    expect(sourceWindowResizeValueBounds(RECT, "n", REGION)).toEqual({
      minimum: MIN_SOURCE_WINDOW_HEIGHT,
      maximum: RECT.y + RECT.height - SOURCE_WINDOW_MARGIN,
    });
  });
});

describe("source window keyboard geometry", () => {
  it("moves with ordinary and accelerated arrow steps", () => {
    expect(moveSourceWindowForKey(RECT, "ArrowLeft", false, REGION)).toEqual({
      ...RECT,
      x: RECT.x - SOURCE_WINDOW_KEYBOARD_STEP,
    });
    expect(moveSourceWindowForKey(RECT, "ArrowDown", true, REGION)).toEqual({
      ...RECT,
      y: RECT.y + SOURCE_WINDOW_KEYBOARD_LARGE_STEP,
    });
    expect(moveSourceWindowForKey(RECT, "Enter", false, REGION)).toBeNull();
  });

  it("resizes only along axes owned by the selected handle", () => {
    expect(resizeSourceWindowForKey(RECT, "e", "ArrowRight", false, REGION)).toEqual({
      ...RECT,
      width: RECT.width + SOURCE_WINDOW_KEYBOARD_STEP,
    });
    expect(resizeSourceWindowForKey(RECT, "nw", "ArrowUp", true, REGION)).toEqual({
      x: RECT.x,
      y: RECT.y - SOURCE_WINDOW_KEYBOARD_LARGE_STEP,
      width: RECT.width,
      height: RECT.height + SOURCE_WINDOW_KEYBOARD_LARGE_STEP,
    });
    expect(resizeSourceWindowForKey(RECT, "e", "ArrowDown", false, REGION)).toBeNull();
    expect(resizeSourceWindowForKey(RECT, "se", "Escape", false, REGION)).toBeNull();
  });

  it("reports the compact related-code threshold", () => {
    expect(sourceWindowShouldCollapseRail(SOURCE_WINDOW_RAIL_COLLAPSE_WIDTH - 1)).toBe(true);
    expect(sourceWindowShouldCollapseRail(SOURCE_WINDOW_RAIL_COLLAPSE_WIDTH)).toBe(false);
    expect(sourceWindowShouldCollapseRail(Number.NaN)).toBe(true);
  });
});
