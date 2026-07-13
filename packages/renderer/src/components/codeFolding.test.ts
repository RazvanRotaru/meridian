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

  it("keeps small gaps visible instead of replacing them with noisy controls", () => {
    expect(unchangedCodeFolds({
      startLine: 1,
      lineCount: 30,
      focusLines: new Set([8, 20]),
    })).toEqual([]);
  });

  it("does not fold short snippets or source without an in-range focus line", () => {
    expect(unchangedCodeFolds({ startLine: 10, lineCount: 20, focusLines: new Set([15]) })).toEqual([]);
    expect(unchangedCodeFolds({ startLine: 10, lineCount: 40, focusLines: new Set([4]) })).toEqual([]);
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
});
