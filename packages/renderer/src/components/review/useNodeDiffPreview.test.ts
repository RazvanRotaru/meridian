import { describe, expect, it } from "vitest";
import { placeNodeDiffPreview, type PreviewRect } from "./useNodeDiffPreview";

function rect(overrides: Partial<PreviewRect> = {}): PreviewRect {
  return {
    left: 100,
    top: 300,
    right: 200,
    bottom: 350,
    width: 100,
    height: 50,
    ...overrides,
  };
}

describe("placeNodeDiffPreview", () => {
  const bounds = { left: 0, top: 0, width: 1200, height: 800 };

  it("places the card to the right of a node when it fits", () => {
    expect(placeNodeDiffPreview(rect(), bounds)).toEqual({
      left: 212,
      top: 110,
      width: 680,
      maxHeight: 430,
    });
  });

  it("flips the card to the left near the pane's right edge", () => {
    expect(placeNodeDiffPreview(rect({ left: 1000, right: 1100 }), bounds).left).toBe(308);
  });

  it("shrinks into the larger side gap instead of covering the hovered node", () => {
    expect(
      placeNodeDiffPreview(
        rect({ left: 246, right: 371, width: 125 }),
        { left: 0, top: 0, width: 900, height: 720 },
      ),
    ).toMatchObject({ left: 383, width: 505 });
  });

  it("clamps the card vertically inside the pane", () => {
    expect(placeNodeDiffPreview(rect({ top: 0, bottom: 20, height: 20 }), bounds).top).toBe(12);
    expect(placeNodeDiffPreview(rect({ top: 780, bottom: 800, height: 20 }), bounds).top).toBe(358);
  });

  it("shrinks to a narrow pane while preserving its margins", () => {
    const placement = placeNodeDiffPreview(
      rect({ left: 280, right: 340 }),
      { left: 100, top: 50, width: 500, height: 300 },
    );
    expect(placement.width).toBe(476);
    expect(placement.maxHeight).toBe(276);
    expect(placement.left).toBeGreaterThanOrEqual(112);
    expect(placement.left + placement.width).toBeLessThanOrEqual(588);
    expect(placement.top).toBe(62);
  });
});
