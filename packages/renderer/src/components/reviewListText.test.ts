/**
 * Pins the row-text formatting helpers: truncation keeps both ends and never overshoots
 * `maxLength`, and the calls-into phrase folds extra affected files into a "+k" suffix.
 */

import { describe, expect, it } from "vitest";
import { basename, callsIntoLabel, middleTruncate } from "./reviewListText";

describe("basename", () => {
  it("returns the last path segment", () => {
    expect(basename("src/pricing/pricingService.ts")).toBe("pricingService.ts");
  });

  it("returns the whole string when there is no slash", () => {
    expect(basename("pricingService.ts")).toBe("pricingService.ts");
  });
});

describe("middleTruncate", () => {
  it("returns the text unchanged when it already fits", () => {
    expect(middleTruncate("short.ts", 20)).toBe("short.ts");
  });

  it("elides the middle, keeping the start and end", () => {
    const result = middleTruncate("src/very/deeply/nested/pricing/pricingService.ts", 20);
    expect(result.length).toBe(20);
    expect(result.startsWith("src/very")).toBe(true);
    expect(result.endsWith("ervice.ts")).toBe(true);
    expect(result).toContain("…");
  });

  it("never exceeds maxLength even for a tiny budget", () => {
    expect(middleTruncate("a-very-long-file-name.ts", 1).length).toBe(1);
    expect(middleTruncate("a-very-long-file-name.ts", 0).length).toBe(0);
  });
});

describe("callsIntoLabel", () => {
  it("names the first file when there is exactly one", () => {
    expect(callsIntoLabel(["src/orderService.ts"])).toBe("calls into orderService.ts");
  });

  it("adds a +k suffix for additional affected files", () => {
    expect(callsIntoLabel(["src/orderService.ts", "src/pricingService.ts", "src/tax.ts"])).toBe(
      "calls into orderService.ts +2",
    );
  });
});
