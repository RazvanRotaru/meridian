import { describe, expect, it } from "vitest";
import { canonicalPrReviewScope } from "./prReviewScope";

describe("canonicalPrReviewScope", () => {
  it("normalizes GitHub repository identity and extraction subdirectory", () => {
    expect(canonicalPrReviewScope({ repository: "https://github.com/Acme/Shop.git", subdir: "/packages/app/" }, 42))
      .toBe(canonicalPrReviewScope({ repository: "acme/shop", subdir: "packages/app" }, 42));
  });

  it("keeps a literal backslash subdirectory distinct from a slash path", () => {
    expect(canonicalPrReviewScope({ repository: "acme/shop", subdir: "packages\\app" }, 42))
      .not.toBe(canonicalPrReviewScope({ repository: "acme/shop", subdir: "packages/app" }, 42));
  });

  it("isolates repository, subdirectory, and PR number without delimiter collisions", () => {
    const scopes = [
      canonicalPrReviewScope({ repository: "acme/shop", subdir: "packages/app" }, 7),
      canonicalPrReviewScope({ repository: "acme/other", subdir: "packages/app" }, 7),
      canonicalPrReviewScope({ repository: "acme/shop", subdir: "packages/other" }, 7),
      canonicalPrReviewScope({ repository: "acme/shop", subdir: "packages/app" }, 8),
    ];
    expect(new Set(scopes).size).toBe(scopes.length);
  });
});
