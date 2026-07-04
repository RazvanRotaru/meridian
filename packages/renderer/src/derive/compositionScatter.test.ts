/**
 * The scatter geometry: A/I → plot coords with the axis inversion (A grows upward) and a stable,
 * non-random jitter. Fixtures are minimal UnitMetrics — only the fields the mapping reads.
 */

import { describe, expect, it } from "vitest";
import type { UnitMetrics } from "./composition";
import { scatterPoints } from "./compositionScatter";

function unit(id: string, instability: number, abstractness: number, distance = 0): UnitMetrics {
  return {
    id,
    kind: "class",
    displayName: id,
    moduleFile: "f.ts",
    members: 1,
    cohesion: 1,
    lcomComponents: 1,
    ce: 0,
    ca: 0,
    instability,
    abstractness,
    distance,
    externalFanout: 0,
    smells: [],
  };
}

describe("scatterPoints", () => {
  it("maps I=0, A=1 to the top-left corner (inset by pad)", () => {
    const [point] = scatterPoints([unit("a", 0, 1)], 200, 200, 10);
    expect(point.x).toBe(10);
    expect(point.y).toBe(10);
  });

  it("maps I=1, A=0 to the bottom-right corner (inset by pad)", () => {
    const [point] = scatterPoints([unit("a", 1, 0)], 200, 200, 10);
    expect(point.x).toBe(190);
    expect(point.y).toBe(190);
  });

  it("inverts abstractness so A=0 sits below A=1 at the same instability", () => {
    const [low, high] = scatterPoints([unit("low", 0.5, 0), unit("high", 0.5, 1)], 200, 200, 10);
    expect(low.y).toBeGreaterThan(high.y); // A=0 is nearer the bottom (larger y).
  });

  it("carries the unit's distance and display name through for colour + hover", () => {
    const [point] = scatterPoints([unit("svc", 0.5, 0.5, 0.42)], 200, 200, 10);
    expect(point).toMatchObject({ id: "svc", distance: 0.42, label: "svc" });
  });

  it("jitters co-located units apart deterministically, and is stable across calls", () => {
    const metrics = [unit("a", 0, 0), unit("b", 0, 0), unit("c", 0, 0)];
    const first = scatterPoints(metrics, 200, 200, 10);
    const second = scatterPoints(metrics, 200, 200, 10);
    expect(first).toEqual(second); // no Math.random — identical across calls.
    // The three A=0/I=0 units don't all collapse onto one dot.
    const distinct = new Set(first.map((p) => `${p.x},${p.y}`));
    expect(distinct.size).toBeGreaterThan(1);
  });

  it("keeps a jittered edge point inside the [0..w] × [0..h] box", () => {
    const points = scatterPoints(
      Array.from({ length: 7 }, (_, i) => unit(`u${i}`, 1, 1)),
      200,
      200,
      2,
    );
    for (const point of points) {
      expect(point.x).toBeGreaterThanOrEqual(0);
      expect(point.x).toBeLessThanOrEqual(200);
      expect(point.y).toBeGreaterThanOrEqual(0);
      expect(point.y).toBeLessThanOrEqual(200);
    }
  });
});
