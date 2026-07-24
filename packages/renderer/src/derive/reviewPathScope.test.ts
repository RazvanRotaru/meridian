import { describe, expect, it } from "vitest";
import {
  isReviewPathInScope,
  normalizeReviewPathScope,
  reviewPathSuggestions,
} from "./reviewPathScope";

describe("review path scope", () => {
  it("normalizes free-form directory input", () => {
    expect(normalizeReviewPathScope("./src/aria//app/")).toBe("src/aria/app");
  });

  it("matches on a path-segment boundary", () => {
    expect(isReviewPathInScope("src/aria/app/main.ts", "src/aria/app")).toBe(true);
    expect(isReviewPathInScope("src/aria/app", "src/aria/app")).toBe(true);
    expect(isReviewPathInScope("src/aria/application/main.ts", "src/aria/app")).toBe(false);
    expect(isReviewPathInScope("src/aria/lib/main.ts", "src/aria/app")).toBe(false);
  });

  it("treats a literal backslash as part of a Git filename, not a scope separator", () => {
    expect(isReviewPathInScope("src/a\\b.ts", "src/a\\b.ts")).toBe(true);
    expect(isReviewPathInScope("src/a/b.ts", "src/a\\b.ts")).toBe(false);
    expect(isReviewPathInScope("src/a\\b.ts", "src/a")).toBe(false);
  });

  it("builds deterministic multi-file directory suggestions", () => {
    expect(reviewPathSuggestions([
      "src/aria/app/a.ts",
      "src/aria/app/backend/b.ts",
      "src/aria/lib/c.ts",
      "packages/one.ts",
    ])).toEqual([
      { path: "src", files: 3 },
      { path: "src/aria", files: 3 },
      { path: "src/aria/app", files: 2 },
    ]);
  });
});
