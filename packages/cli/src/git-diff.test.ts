import { describe, expect, it } from "vitest";
import { parseHunkRanges, parseNameStatus, parseNumstat } from "./git-diff";

describe("parseNumstat", () => {
  it("parses additions/deletions per file and tolerates binary '-' counts", () => {
    const output = ["12\t4\tsrc/a.ts", "0\t9\tsrc/b.tsx", "-\t-\tassets/logo.png", "", "garbage line"].join("\n");
    expect(parseNumstat(output)).toEqual([
      { additions: 12, deletions: 4, path: "src/a.ts" },
      { additions: 0, deletions: 9, path: "src/b.tsx" },
      { additions: 0, deletions: 0, path: "assets/logo.png" },
    ]);
  });
});

describe("parseNameStatus", () => {
  it("maps A/M/D and folds renames onto the surviving path as modified", () => {
    const output = ["A\tsrc/new.ts", "M\tsrc/mod.ts", "D\tsrc/gone.ts", "R087\tsrc/old.ts\tsrc/renamed.ts"].join("\n");
    const statuses = parseNameStatus(output);
    expect(statuses.get("src/new.ts")).toBe("A");
    expect(statuses.get("src/mod.ts")).toBe("M");
    expect(statuses.get("src/gone.ts")).toBe("D");
    expect(statuses.get("src/renamed.ts")).toBe("M");
  });
});

describe("parseHunkRanges", () => {
  it("collects new-side ranges per file, including one-line and zero-count hunks", () => {
    const output = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -10,2 +12,5 @@ context",
      "@@ -30 +40 @@",
      "@@ -50,3 +60,0 @@ pure deletion",
      "diff --git a/src/b.ts b/src/b.ts",
      "+++ b/src/b.ts",
      "@@ -1,1 +1,2 @@",
    ].join("\n");
    const ranges = parseHunkRanges(output);
    expect(ranges.get("src/a.ts")).toEqual([
      { start: 12, end: 16 },
      { start: 40, end: 40 },
      { start: 60, end: 60 },
    ]);
    expect(ranges.get("src/b.ts")).toEqual([{ start: 1, end: 2 }]);
  });

  it("anchors nothing to deleted files (new side is /dev/null)", () => {
    const output = ["--- a/src/dead.ts", "+++ /dev/null", "@@ -1,10 +0,0 @@"].join("\n");
    expect(parseHunkRanges(output).size).toBe(0);
  });
});
