import { describe, expect, it } from "vitest";
import { arrangeMinimalCards } from "./minimalArrange";

const CARD_IDS = ["orderRoutes.ts", "orderValidator.ts", "orderService.ts", "emailService.ts", "pricingService.ts"];
const CARD_SIZES = {
  "orderRoutes.ts": { width: 325, height: 178 },
  "orderValidator.ts": { width: 878, height: 105 },
  "orderService.ts": { width: 210, height: 54 },
  "emailService.ts": { width: 288, height: 116 },
  "pricingService.ts": { width: 303, height: 116 },
};
const SAMPLE_RELATIONS = [
  { source: "orderRoutes.ts", target: "orderService.ts" },
  { source: "orderService.ts", target: "orderValidator.ts" },
  { source: "orderService.ts", target: "emailService.ts" },
  { source: "orderService.ts", target: "pricingService.ts" },
];

function hasHorizontallyDisjointPair(rects: readonly { x: number; width: number }[]): boolean {
  return rects.some((left, index) =>
    rects.slice(index + 1).some((right) => left.x + left.width <= right.x || right.x + right.width <= left.x),
  );
}

describe("arrangeMinimalCards", () => {
  it("lays the reported sample selection across at least three dependency columns", async () => {
    const placement = await arrangeMinimalCards(CARD_IDS, CARD_SIZES, SAMPLE_RELATIONS);

    expect(placement["orderRoutes.ts"].x + placement["orderRoutes.ts"].width).toBeLessThanOrEqual(
      placement["orderService.ts"].x,
    );
    for (const dependency of ["orderValidator.ts", "emailService.ts", "pricingService.ts"]) {
      expect(placement["orderService.ts"].x + placement["orderService.ts"].width).toBeLessThanOrEqual(
        placement[dependency].x,
      );
    }
    expect(new Set(CARD_IDS.map((id) => placement[id].x)).size).toBeGreaterThanOrEqual(3);
  });

  it("component-packs disconnected members into more than one column", async () => {
    // The bundled sample has no import edges, so this is the exact pathological substrate from the
    // minimal graph: differently sized expanded frames that ELK used to stack at one shared x.
    const placement = await arrangeMinimalCards(CARD_IDS, CARD_SIZES, []);
    const rects = CARD_IDS.map((id) => placement[id]);

    expect(Object.keys(placement)).toHaveLength(CARD_IDS.length);
    expect(hasHorizontallyDisjointPair(rects)).toBe(true);
  });

  it("never leaves equal-sized disconnected members in a single column", async () => {
    const ids = ["a", "b", "c", "d", "e"];
    const sizes = Object.fromEntries(ids.map((id) => [id, { width: 210, height: 54 }]));
    const placement = await arrangeMinimalCards(ids, sizes, []);

    expect(hasHorizontallyDisjointPair(ids.map((id) => placement[id]))).toBe(true);
  });
});
