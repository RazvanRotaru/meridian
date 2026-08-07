import { describe, expect, it } from "vitest";
import {
  MAX_SOURCE_SEARCH_MATCHES,
  nextSourceSearchIndex,
  shouldOpenSourceSearchFromShortcut,
  sourceSearchMatches,
  sourceSearchNavigationIndex,
} from "./sourceSearch";

describe("sourceSearchMatches", () => {
  it("finds case-insensitive literal matches with absolute line and column coordinates", () => {
    expect(sourceSearchMatches("Alpha beta alpha\nalpha", "ALPHA", 40, 2)).toEqual({
      matches: [
        { line: 40, column: 1, length: 5 },
        { line: 40, column: 12, length: 5 },
        { line: 41, column: 1, length: 5 },
      ],
      truncated: false,
    });
  });

  it("honours the exact source row count and hidden-row projection", () => {
    expect(sourceSearchMatches("keep\nhidden\noutside", "i", 7, 2, new Set([8])).matches).toEqual([]);
    expect(sourceSearchMatches("keep\nhidden\noutside", "outside", 7, 2).matches).toEqual([]);
  });

  it("treats punctuation and whitespace as literal source text", () => {
    expect(sourceSearchMatches("const matcher = a.*b;\nconst spaced = 'a b';", "a.*b", 1, 2).matches).toEqual([
      { line: 1, column: 17, length: 4 },
    ]);
    expect(sourceSearchMatches("const matcher = a.*b;\nconst spaced = 'a b';", "a b", 1, 2).matches).toEqual([
      { line: 2, column: 17, length: 3 },
    ]);
  });

  it("returns no result for an empty query or an exact zero-row source", () => {
    expect(sourceSearchMatches("visible", "", 1, 1).matches).toEqual([]);
    expect(sourceSearchMatches("visible", "visible", 1, 0).matches).toEqual([]);
  });

  it("keeps original UTF-16 coordinates when earlier characters expand during case folding", () => {
    expect(sourceSearchMatches("İ x ITEM", "item", 10, 1).matches).toEqual([
      { line: 10, column: 5, length: 4 },
    ]);
  });

  it("supports Unicode simple case folding", () => {
    expect(sourceSearchMatches("Kelvin ſource", "kelvin", 1, 1).matches).toEqual([
      { line: 1, column: 1, length: 6 },
    ]);
    expect(sourceSearchMatches("Kelvin ſource", "source", 1, 1).matches).toEqual([
      { line: 1, column: 8, length: 6 },
    ]);
  });

  it("reports UTF-16 columns when astral characters precede a match", () => {
    expect(sourceSearchMatches("😀 ITEM", "item", 25, 1).matches).toEqual([
      { line: 25, column: 4, length: 4 },
    ]);
  });

  it("truthfully caps high-cardinality searches", () => {
    const result = sourceSearchMatches("x".repeat(MAX_SOURCE_SEARCH_MATCHES + 1), "x", 1, 1);
    expect(result.matches).toHaveLength(MAX_SOURCE_SEARCH_MATCHES);
    expect(result.truncated).toBe(true);
    expect(sourceSearchMatches("x".repeat(MAX_SOURCE_SEARCH_MATCHES), "x", 1, 1).truncated).toBe(false);
  });
});

describe("source search navigation", () => {
  it("wraps in both directions and handles an empty result", () => {
    expect(nextSourceSearchIndex(0, 3, 1)).toBe(1);
    expect(nextSourceSearchIndex(2, 3, 1)).toBe(0);
    expect(nextSourceSearchIndex(0, 3, -1)).toBe(2);
    expect(nextSourceSearchIndex(-1, 3, -1)).toBe(2);
    expect(nextSourceSearchIndex(0, 0, 1)).toBe(-1);
  });

  it("starts from the displayed result when stored state is stale", () => {
    expect(sourceSearchNavigationIndex(8, 2, 1)).toBe(1);
    expect(sourceSearchNavigationIndex(8, 2, -1)).toBe(1);
    expect(sourceSearchNavigationIndex(-1, 2, 1)).toBe(1);
    expect(sourceSearchNavigationIndex(1, 0, 1)).toBe(-1);
  });
});

describe("source search shortcut", () => {
  const shortcut = {
    key: "f",
    metaKey: false,
    ctrlKey: true,
    altKey: false,
    shiftKey: false,
    defaultPrevented: false,
  };

  it("opens only for the exact unconsumed find chord with no higher modal", () => {
    expect(shouldOpenSourceSearchFromShortcut(shortcut, false)).toBe(true);
    expect(shouldOpenSourceSearchFromShortcut({ ...shortcut, defaultPrevented: true }, false)).toBe(false);
    expect(shouldOpenSourceSearchFromShortcut(shortcut, true)).toBe(false);
    expect(shouldOpenSourceSearchFromShortcut({ ...shortcut, ctrlKey: false }, false)).toBe(false);
    expect(shouldOpenSourceSearchFromShortcut({ ...shortcut, altKey: true }, false)).toBe(false);
    expect(shouldOpenSourceSearchFromShortcut({ ...shortcut, shiftKey: true }, false)).toBe(false);
  });
});
