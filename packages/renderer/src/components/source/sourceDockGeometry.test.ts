import { describe, expect, it } from "vitest";
import {
  MIN_SOURCE_CONTEXT_WIDTH,
  MIN_SOURCE_DOCK_WIDTH,
  sourceDockMetrics,
  sourceDockRatioBounds,
  sourceDockRatioForKey,
  sourceDockRatioForWidth,
  sourceDockRatioFromPointer,
  sourceDockValueText,
} from "./sourceDockGeometry";

describe("source dock responsive bounds", () => {
  it("keeps both pixel minimums when the workspace can satisfy them", () => {
    expect(sourceDockRatioBounds(1_400)).toEqual({
      minRatio: 0.4,
      maxRatio: 1 - (MIN_SOURCE_CONTEXT_WIDTH / 1_400),
    });
    expect(sourceDockRatioBounds(1_000)).toEqual({
      minRatio: MIN_SOURCE_DOCK_WIDTH / 1_000,
      maxRatio: 1 - (MIN_SOURCE_CONTEXT_WIDTH / 1_000),
    });
  });

  it("shrinks dock and context proportionally when their minimums cannot both fit", () => {
    const ratio = MIN_SOURCE_DOCK_WIDTH / (MIN_SOURCE_DOCK_WIDTH + MIN_SOURCE_CONTEXT_WIDTH);

    expect(sourceDockRatioBounds(779)).toEqual({ minRatio: ratio, maxRatio: ratio });
    expect(sourceDockRatioBounds(500)).toEqual({ minRatio: ratio, maxRatio: ratio });
    expect(ratio).toBeCloseTo(2 / 3);
  });

  it("falls back to product bounds before a live container has been measured", () => {
    expect(sourceDockRatioBounds(0)).toEqual({ minRatio: 0.4, maxRatio: 0.9 });
    expect(sourceDockRatioBounds(Number.NaN)).toEqual({ minRatio: 0.4, maxRatio: 0.9 });
  });
});

describe("source dock geometry", () => {
  it("uses the same constrained metrics for rendered width and ARIA", () => {
    const metrics = sourceDockMetrics(0.9, 1_000);

    expect(metrics.minPercent).toBe(52);
    expect(metrics.maxPercent).toBe(74);
    expect(metrics.valuePercent).toBe(74);
    expect(metrics.effectiveRatio).toBe(0.74);
    expect(metrics.renderedWidth).toBe(740);
    expect(sourceDockValueText(metrics)).toBe("Source dock 74% of workspace width (740 px)");
  });

  it("keeps responsive decimal ARIA values on the exact percentage used by CSS", () => {
    const wide = sourceDockMetrics(0.9, 1_400);
    const narrow = sourceDockMetrics(0.4, 700);

    expect(wide.maxPercent).toBe(81.4286);
    expect(wide.valuePercent).toBe(81.4286);
    expect(wide.effectiveRatio).toBe(wide.valuePercent / 100);
    expect(sourceDockValueText(wide)).toBe("Source dock 81.4286% of workspace width (1140 px)");
    expect(narrow.minPercent).toBe(66.6667);
    expect(narrow.maxPercent).toBe(66.6667);
    expect(narrow.valuePercent).toBe(66.6667);
    expect(sourceDockValueText(narrow)).toBe("Source dock 66.6667% of workspace width (467 px)");
  });

  it("derives pointer width from explicit shell coordinates and the preserved grab point", () => {
    expect(sourceDockRatioFromPointer({
      clientPosition: 600,
      grabOffset: 10,
      containerLeft: 100,
      containerWidth: 1_400,
    })).toBeCloseTo(910 / 1_400);
    expect(sourceDockRatioFromPointer({
      clientPosition: 600,
      grabOffset: 10,
      handleBoundaryOffset: 10,
      containerLeft: 100,
      containerWidth: 1_400,
    })).toBeCloseTo(900 / 1_400);
    expect(sourceDockRatioForWidth(0, 1_400)).toBe(0.4);
    expect(sourceDockRatioForWidth(1_400, 1_400)).toBeCloseTo(1 - (260 / 1_400));
  });

  it("supports keyboard resizing, limits, reset, and the collapsed narrow state", () => {
    expect(sourceDockRatioForKey(0.6, "ArrowLeft", false, 1_400)).toBeGreaterThan(0.6);
    expect(sourceDockRatioForKey(0.6, "ArrowRight", true, 1_400)).toBeLessThan(0.6);
    expect(sourceDockRatioForKey(0.6, "Home", false, 1_400)).toBeCloseTo(1 - (260 / 1_400));
    expect(sourceDockRatioForKey(0.6, "End", false, 1_400)).toBe(0.4);
    expect(sourceDockRatioForKey(0.8, "Enter", false, 1_400)).toBe(0.6);
    expect(sourceDockRatioForKey(0.6, "Escape", false, 1_400)).toBeNull();

    expect(sourceDockRatioForKey(0.4, "ArrowLeft", false, 700)).toBeNull();
    expect(sourceDockRatioForKey(0.9, "ArrowRight", false, 700)).toBeNull();
    expect(sourceDockRatioForKey(0.4, "Home", false, 700)).toBeNull();
    expect(sourceDockRatioForKey(0.9, "End", false, 700)).toBeNull();
    expect(sourceDockRatioForKey(0.9, "Enter", false, 700)).toBe(0.6);
  });
});
