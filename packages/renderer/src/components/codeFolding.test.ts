import { describe, expect, it } from "vitest";
import { unchangedCodeFolds } from "./codeFolding";

describe("unchangedCodeFolds", () => {
  it("folds large leading, middle, and trailing gaps around changed lines", () => {
    expect(unchangedCodeFolds({
      startLine: 1,
      lineCount: 100,
      focusLines: new Set([30, 70]),
    })).toEqual([
      { startLine: 1, endLine: 26, lineCount: 26 },
      { startLine: 34, endLine: 66, lineCount: 33 },
      { startLine: 74, endLine: 100, lineCount: 27 },
    ]);
  });

  it("keeps exactly three context lines and folds every remaining gap", () => {
    expect(unchangedCodeFolds({
      startLine: 1,
      lineCount: 30,
      focusLines: new Set([8, 20]),
    })).toEqual([
      { startLine: 1, endLine: 4, lineCount: 4 },
      { startLine: 12, endLine: 16, lineCount: 5 },
      { startLine: 24, endLine: 30, lineCount: 7 },
    ]);
  });

  it("folds short snippets but not source without an in-range focus line", () => {
    expect(unchangedCodeFolds({ startLine: 10, lineCount: 7, focusLines: new Set([13]) })).toEqual([]);
    expect(unchangedCodeFolds({ startLine: 10, lineCount: 20, focusLines: new Set([15]) })).toEqual([
      { startLine: 10, endLine: 11, lineCount: 2 },
      { startLine: 19, endLine: 29, lineCount: 11 },
    ]);
    expect(unchangedCodeFolds({ startLine: 10, lineCount: 40, focusLines: new Set([4]) })).toEqual([]);
  });

  it("keeps a one-line omitted gap expandable", () => {
    expect(unchangedCodeFolds({
      startLine: 1,
      lineCount: 15,
      focusLines: new Set([5, 13]),
    })).toContainEqual({ startLine: 9, endLine: 9, lineCount: 1 });
  });

  it("uses absolute source coordinates for non-one-based slices", () => {
    expect(unchangedCodeFolds({
      startLine: 100,
      lineCount: 50,
      focusLines: new Set([125]),
    })).toEqual([
      { startLine: 100, endLine: 121, lineCount: 22 },
      { startLine: 129, endLine: 149, lineCount: 21 },
    ]);
  });

  it("keeps exactly three source rows on each side of a middle deletion gap", () => {
    expect(unchangedCodeFolds({
      startLine: 1,
      lineCount: 30,
      focusLines: new Set(),
      focusGaps: new Set([15]),
    })).toEqual([
      { startLine: 1, endLine: 11, lineCount: 11 },
      { startLine: 18, endLine: 30, lineCount: 13 },
    ]);
  });

  it("does not invent a fourth context row for deletion gaps at file boundaries", () => {
    expect(unchangedCodeFolds({
      startLine: 1,
      lineCount: 20,
      focusLines: new Set(),
      focusGaps: new Set([1]),
    })).toEqual([{ startLine: 4, endLine: 20, lineCount: 17 }]);
    expect(unchangedCodeFolds({
      startLine: 1,
      lineCount: 20,
      focusLines: new Set(),
      focusGaps: new Set([21]),
    })).toEqual([{ startLine: 1, endLine: 17, lineCount: 17 }]);
  });
});
