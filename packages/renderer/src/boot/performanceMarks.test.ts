import { afterEach, describe, expect, it } from "vitest";
import {
  markPerformance,
  measurePerformance,
  PERFORMANCE,
  startPerformanceSpan,
} from "./performanceMarks";

afterEach(() => {
  performance.clearMarks();
  performance.clearMeasures();
});

describe("bounded renderer performance marks", () => {
  it("retains only the latest point and duration for each category", () => {
    markPerformance(PERFORMANCE.bootStart);
    markPerformance(PERFORMANCE.bootStart);
    const finishFirst = startPerformanceSpan(PERFORMANCE.projectionIndex);
    finishFirst();
    const finishSecond = startPerformanceSpan(PERFORMANCE.projectionIndex);
    finishSecond();

    expect(performance.getEntriesByName(PERFORMANCE.bootStart, "mark")).toHaveLength(1);
    expect(performance.getEntriesByName(PERFORMANCE.projectionIndex, "measure")).toHaveLength(1);
    expect(performance.getEntriesByType("mark").some((entry) => entry.name.includes(":start:"))).toBe(false);
  });

  it("measures boot to first usable paint only after both lifecycle marks exist", () => {
    markPerformance(PERFORMANCE.bootStart);
    measurePerformance(
      PERFORMANCE.bootToFirstUsablePaint,
      PERFORMANCE.bootStart,
      PERFORMANCE.firstUsablePaint,
    );
    expect(performance.getEntriesByName(PERFORMANCE.bootToFirstUsablePaint, "measure")).toHaveLength(0);

    markPerformance(PERFORMANCE.firstUsablePaint);
    measurePerformance(
      PERFORMANCE.bootToFirstUsablePaint,
      PERFORMANCE.bootStart,
      PERFORMANCE.firstUsablePaint,
    );
    expect(performance.getEntriesByName(PERFORMANCE.bootToFirstUsablePaint, "measure")).toHaveLength(1);
  });
});
