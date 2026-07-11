import { describe, expect, it } from "vitest";
import { shouldApplyRecenter } from "./useRecenter";

describe("shouldApplyRecenter", () => {
  it("ignores mount and cover/reveal changes while the signal is unchanged", () => {
    expect(shouldApplyRecenter(4, 4, true)).toBe(false);
    expect(shouldApplyRecenter(4, 4, false)).toBe(false);
  });

  it("runs only a new signal on the active surface", () => {
    expect(shouldApplyRecenter(4, 5, true)).toBe(true);
    expect(shouldApplyRecenter(4, 5, false)).toBe(false);
  });
});
