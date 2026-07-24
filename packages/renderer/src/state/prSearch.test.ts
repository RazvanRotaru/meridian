import { describe, expect, it } from "vitest";
import type { PrSummary } from "./prTypes";
import {
  matchesPrSearchQuery,
  mergePrSearchResults,
  nextPrSearchResult,
  normalizePrSearchQuery,
  prSearchCacheKey,
} from "./prSearch";

describe("PR priority-search helpers", () => {
  it.each([
    ["#417", true],
    ["417", true],
    ["17", false],
    ["checkout", true],
    ["ALICE", true],
    ["feature/search", true],
    ["#FEATURE/SEARCH", true],
    ["release/next", true],
    ["race condition", true],
    ["not present", false],
  ])("matches arbitrary query %j across the shared PR summary vocabulary", (query, expected) => {
    expect(matchesPrSearchQuery(summary(417), query)).toBe(expected);
  });

  it("normalizes cache identity without changing the tab", () => {
    expect(normalizePrSearchQuery("  Feature/Search  ")).toBe("feature/search");
    expect(prSearchCacheKey("open", " Feature/Search ")).toBe("open\0feature/search");
    expect(prSearchCacheKey("closed", "feature/search")).toBe("closed\0feature/search");
  });

  it("appends remote-only hits without replacing or reordering loaded rows", () => {
    const loaded = [summary(1), summary(2)];
    const refreshedDuplicate = { ...summary(2), title: "remote replacement" };
    expect(mergePrSearchResults(loaded, [refreshedDuplicate, summary(3)])).toEqual([
      loaded[0],
      loaded[1],
      summary(3),
    ]);
  });

  it("wraps keyboard navigation while retaining identity across appended results", () => {
    expect(nextPrSearchResult([1, 2], null, 1)).toBe(1);
    expect(nextPrSearchResult([1, 2], null, -1)).toBe(2);
    expect(nextPrSearchResult([1, 2, 3], 2, 1)).toBe(3);
    expect(nextPrSearchResult([1, 2, 3], 1, -1)).toBe(3);
    expect(nextPrSearchResult([], 2, 1)).toBeNull();
  });
});

function summary(number: number): PrSummary {
  return {
    number,
    title: "Keep checkout state consistent",
    body: "Prevents a race condition while loading a pull request.",
    author: "alice",
    headRef: "feature/search",
    headSha: "abc1234",
    baseRef: "release/next",
    updatedAt: "2026-07-24T00:00:00.000Z",
    draft: false,
    state: "open",
    url: `https://github.com/o/r/pull/${number}`,
  };
}
