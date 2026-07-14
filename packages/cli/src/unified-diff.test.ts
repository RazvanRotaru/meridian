import { describe, expect, it } from "vitest";
import { parseUnifiedDiffBody } from "./unified-diff";

describe("parseUnifiedDiffBody", () => {
  it("uses correct 1-based cursors for a U0 insertion at the start of a file", () => {
    const parsed = parseUnifiedDiffBody("@@ -0,0 +1,2 @@\n+first\n+second");

    expect(parsed.complete).toBe(true);
    expect(parsed.edits).toEqual([{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 2 }]);
    expect(parsed.diffLines).toEqual([
      { kind: "added", oldLine: null, newLine: 1, beforeNewLine: 1, text: "first" },
      { kind: "added", oldLine: null, newLine: 2, beforeNewLine: 2, text: "second" },
    ]);
    expect(parsed.ranges).toEqual([{ start: 1, end: 2 }]);
    expect(parsed.oldRanges).toEqual([{ start: 1, end: 1 }]);
  });

  it("anchors a U0 pure deletion to the next HEAD row without fabricating paintable rows", () => {
    const parsed = parseUnifiedDiffBody("@@ -3,2 +2,0 @@\n-old three\n-old four");

    expect(parsed.complete).toBe(true);
    expect(parsed.edits).toEqual([{ oldStart: 3, oldLines: 2, newStart: 3, newLines: 0 }]);
    expect(parsed.diffLines).toEqual([
      { kind: "deleted", oldLine: 3, newLine: null, beforeNewLine: 3, text: "old three" },
      { kind: "deleted", oldLine: 4, newLine: null, beforeNewLine: 3, text: "old four" },
    ]);
    expect(parsed.ranges).toEqual([{ start: 3, end: 3 }]);
    expect(parsed.oldRanges).toEqual([{ start: 3, end: 4 }]);
    expect(parsed.kinds).toEqual([]);
  });

  it("emits exact rows and one tight edit for a replacement with an unpaired addition", () => {
    const parsed = parseUnifiedDiffBody([
      "@@ -4,2 +4,3 @@",
      "-old one",
      "-old two",
      "+new one",
      "+new two",
      "+brand new",
    ].join("\n"));

    expect(parsed).toMatchObject({
      complete: true,
      added: 3,
      deleted: 2,
      ranges: [{ start: 4, end: 6 }],
      oldRanges: [{ start: 4, end: 5 }],
      edits: [{ oldStart: 4, oldLines: 2, newStart: 4, newLines: 3 }],
      kinds: [
        { start: 4, end: 5, kind: "modified" },
        { start: 6, end: 6, kind: "added" },
      ],
    });
    expect(parsed.diffLines.map((line) => line.text)).toEqual([
      "old one",
      "old two",
      "new one",
      "new two",
      "brand new",
    ]);
  });

  it("splits edits at context rows instead of reusing the context-padded hunk header", () => {
    const parsed = parseUnifiedDiffBody([
      "@@ -10,5 +10,5 @@",
      " context one",
      "-old a",
      "+new a",
      " middle",
      "-old b",
      "+new b",
      " context two",
    ].join("\n"));

    expect(parsed.complete).toBe(true);
    expect(parsed.edits).toEqual([
      { oldStart: 11, oldLines: 1, newStart: 11, newLines: 1 },
      { oldStart: 13, oldLines: 1, newStart: 13, newLines: 1 },
    ]);
  });

  it("marks a cut hunk incomplete while retaining the rows it could parse", () => {
    const parsed = parseUnifiedDiffBody("@@ -1,2 +1,2 @@\n-old\n+new");

    expect(parsed.complete).toBe(false);
    expect(parsed.diffLines).toHaveLength(2);
  });

  it("attaches Git's no-newline marker to the exact preceding changed side", () => {
    const parsed = parseUnifiedDiffBody([
      "@@ -1 +1 @@",
      "-old without newline",
      "\\ No newline at end of file",
      "+new without newline",
      "\\ No newline at end of file",
    ].join("\n"));

    expect(parsed.complete).toBe(true);
    expect(parsed.diffLines).toEqual([
      {
        kind: "deleted",
        oldLine: 1,
        newLine: null,
        beforeNewLine: 1,
        text: "old without newline",
        noNewline: true,
      },
      {
        kind: "added",
        oldLine: null,
        newLine: 1,
        beforeNewLine: 1,
        text: "new without newline",
        noNewline: true,
      },
    ]);
  });
});
