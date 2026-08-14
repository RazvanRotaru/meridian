import { describe, expect, it } from "vitest";
import { primaryModifierPressed } from "./usePrimaryModifierKey";

describe("primaryModifierPressed", () => {
  it("accepts Control and Command while rejecting an unmodified gesture", () => {
    expect(primaryModifierPressed({ ctrlKey: true, metaKey: false })).toBe(true);
    expect(primaryModifierPressed({ ctrlKey: false, metaKey: true })).toBe(true);
    expect(primaryModifierPressed({ ctrlKey: false, metaKey: false })).toBe(false);
  });
});
