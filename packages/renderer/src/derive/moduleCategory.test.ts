/**
 * Path-heuristic categorisation of a source file into its Module-map role. Each rule is pinned on a
 * bare module path so the buckets stay stable independent of any extractor.
 */

import { describe, expect, it } from "vitest";
import { categorize, CATEGORY_LABEL, TOGGLEABLE_CATEGORIES } from "./moduleCategory";

describe("categorize", () => {
  it("reads a util segment as util", () => {
    expect(categorize("src/utils/format.ts")).toBe("util");
    expect(categorize("packages/shared/logger.ts")).toBe("util");
    expect(categorize("lib/math.ts")).toBe("util");
  });

  it("reads a ui segment as ui", () => {
    expect(categorize("src/components/Button.tsx")).toBe("ui");
    expect(categorize("app/pages/home.tsx")).toBe("ui");
    expect(categorize("src/hooks/useThing.ts")).toBe("ui");
  });

  it("reads a config segment or a config-named file as config", () => {
    expect(categorize("src/types/graph.ts")).toBe("config");
    expect(categorize("src/config.ts")).toBe("config");
    expect(categorize("src/constants.ts")).toBe("config");
  });

  it("falls back to app for ordinary domain code", () => {
    expect(categorize("src/orders/checkout.ts")).toBe("app");
    expect(categorize("main.ts")).toBe("app");
  });

  it("prefers util over ui when a path reads as both", () => {
    expect(categorize("src/components/utils/dom.ts")).toBe("util");
  });

  it("never infers entry from a path (the caller stamps it)", () => {
    expect(categorize("src/entry.ts")).not.toBe("entry");
  });
});

describe("category metadata", () => {
  it("offers exactly the hideable categories, omitting entry and app", () => {
    expect(TOGGLEABLE_CATEGORIES).toEqual(["ui", "util", "config"]);
  });

  it("labels every category", () => {
    for (const category of ["entry", "ui", "util", "config", "app"] as const) {
      expect(CATEGORY_LABEL[category]).toBeTruthy();
    }
  });
});
