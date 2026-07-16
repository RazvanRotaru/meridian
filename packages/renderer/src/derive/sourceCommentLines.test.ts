import type { ChangedDiffLine } from "@meridian/core";
import { describe, expect, it } from "vitest";
import { sourceCommentOnlyLines, withoutAddedSourceCommentDiffLines } from "./sourceCommentLines";

describe("sourceCommentOnlyLines", () => {
  it("finds ordinary TypeScript line and block comments with absolute line numbers", () => {
    const code = [
      'const marker = "// still code";',
      "  // Explain the branch below.",
      "  /* Explain the fallback",
      "   * over several lines.",
      "   */",
      "  run(); // trailing comments remain code",
      "  {/* JSX comment wrappers remain code */}",
    ].join("\n");

    expect([...sourceCommentOnlyLines("src/review.tsx", code, 10)]).toEqual([11, 12, 13, 14]);
  });

  it("finds JSDoc and directives while preserving mixed annotations and multiline templates", () => {
    const code = [
      "/** Public API documentation. */",
      "/// <reference types=\"node\" />",
      "// @ts-expect-error intentional fixture",
      "/* eslint-disable no-console */",
      "const value = /*#__PURE__*/ factory();",
      "const prose = `",
      "// text inside a template",
      "/* more template text */",
      "`;",
    ].join("\n");

    expect([...sourceCommentOnlyLines("src/review.ts", code)]).toEqual([1, 2, 3, 4]);
  });

  it("finds every row in a multiline directive block", () => {
    const code = [
      "/*",
      " * @license Example license",
      " */",
      "// Ordinary explanation.",
    ].join("\n");

    expect([...sourceCommentOnlyLines("src/review.js", code)]).toEqual([1, 2, 3, 4]);
  });

  it("finds Python comments and directives while preserving strings and docstrings", () => {
    const code = [
      "#!/usr/bin/env python3",
      "# coding: utf-8",
      "# Explain the rule below.",
      'label = "# still code"',
      "work()  # trailing comment",
      '"""A docstring',
      "# text inside the docstring",
      '"""',
      "# type: ignore[assignment]",
      "# noqa: F401",
      "# Another ordinary explanation.",
    ].join("\n");

    expect([...sourceCommentOnlyLines("tools/review.py", code)]).toEqual([1, 2, 3, 9, 10, 11]);
  });

  it("finds all rows in an unterminated block comment", () => {
    const code = "/* generated explanation\n * continued";

    expect([...sourceCommentOnlyLines("src/review.ts", code, 20)]).toEqual([20, 21]);
  });

  it("fails open for unsupported source languages", () => {
    expect(sourceCommentOnlyLines("src/review.go", "// explanation").size).toBe(0);
    expect(sourceCommentOnlyLines("README.md", "# explanation").size).toBe(0);
  });
});

describe("withoutAddedSourceCommentDiffLines", () => {
  it("neutralizes comment-only rows in a pure insertion while retaining following code", () => {
    const lines = [
      added(2, "// Explain the rule."),
      added(3, "return chooseTier();"),
    ];

    expect(withoutAddedSourceCommentDiffLines(lines, new Set([2]))).toEqual([lines[1]]);
  });

  it("neutralizes comment additions that belong to a replacement run", () => {
    const lines: ChangedDiffLine[] = [
      { kind: "deleted", oldLine: 8, newLine: null, beforeNewLine: 8, text: "return oldTier();" },
      added(8, "// Explain the replacement."),
      added(9, "return newTier();"),
    ];

    expect(withoutAddedSourceCommentDiffLines(lines, new Set([8]))).toEqual([lines[0], lines[2]]);
  });

  it("distinguishes a later insertion from an earlier deletion by coordinates", () => {
    const deletion: ChangedDiffLine = {
      kind: "deleted",
      oldLine: 2,
      newLine: null,
      beforeNewLine: 2,
      text: "removeMe();",
    };
    const comment = added(20, "// Independent insertion.");

    expect(withoutAddedSourceCommentDiffLines([deletion, comment], new Set([20]))).toEqual([deletion]);
  });

  it("returns the original collection when no row is neutralized", () => {
    const lines = [added(4, "run();")];
    expect(withoutAddedSourceCommentDiffLines(lines, new Set([3]))).toBe(lines);
  });
});

function added(line: number, text: string): ChangedDiffLine {
  return { kind: "added", oldLine: null, newLine: line, beforeNewLine: line, text };
}
