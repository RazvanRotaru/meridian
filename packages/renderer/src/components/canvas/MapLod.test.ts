import { describe, expect, it } from "vitest";
import { mapLodTier } from "./MapLod";

describe("mapLodTier", () => {
  it("keeps the Map's orientation mode below the threshold by default", () => {
    expect(mapLodTier(0.44)).toBe("orientation");
    expect(mapLodTier(0.45)).toBe("reading");
  });

  it("keeps an action-bearing overlay in reading mode at every zoom", () => {
    expect(mapLodTier(0.01, false)).toBe("reading");
    expect(mapLodTier(0.44, false)).toBe("reading");
  });
});
