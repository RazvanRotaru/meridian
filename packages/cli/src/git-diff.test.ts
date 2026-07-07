import { describe, expect, it } from "vitest";
import { parseUnifiedDiff, parseUnifiedDiffWithStats, validatedRef } from "./git-diff";

const DIFF = [
  "diff --git a/src/orderService.ts b/src/orderService.ts",
  "index 1111111..2222222 100644",
  "--- a/src/orderService.ts",
  "+++ b/src/orderService.ts",
  "@@ -10,2 +10,3 @@ export function priceOrder(",
  "+  const rounded = round(total);",
  "@@ -30 +31 @@ function round(",
  "+  return Math.round(value * 100) / 100;",
  "diff --git a/src/removed.ts b/src/removed.ts",
  "deleted file mode 100644",
  "--- a/src/removed.ts",
  "+++ /dev/null",
  "@@ -1,12 +0,0 @@",
  "diff --git a/src/old-name.ts b/src/new-name.ts",
  "similarity index 90%",
  "--- a/src/old-name.ts",
  "+++ b/src/new-name.ts",
  "@@ -5,0 +6,2 @@",
  "+export const flag = true;",
  "@@ -20,3 +22,0 @@",
].join("\n");

describe("parseUnifiedDiff", () => {
  it("collects new-side ranges per file, keyed root-relative", () => {
    expect(parseUnifiedDiff(DIFF)["src/orderService.ts"]).toEqual([
      { start: 10, end: 12 },
      { start: 31, end: 31 },
    ]);
  });

  it("skips deleted files entirely (no new-side path to tag)", () => {
    expect(parseUnifiedDiff(DIFF)["src/removed.ts"]).toBeUndefined();
  });

  it("keys a rename by its new path and marks a pure-deletion hunk as the seam", () => {
    expect(parseUnifiedDiff(DIFF)["src/new-name.ts"]).toEqual([
      { start: 6, end: 7 },
      { start: 22, end: 23 }, // -20,3 +22,0: lines removed between 22 and 23.
    ]);
  });

  it("clamps a deletion at the top of a file to line 1", () => {
    const top = ["+++ b/x.ts", "@@ -1,2 +0,0 @@"].join("\n");
    expect(parseUnifiedDiff(top)["x.ts"]).toEqual([{ start: 1, end: 2 }]);
  });

  it("returns an empty record for an empty diff", () => {
    expect(parseUnifiedDiff("")).toEqual({});
  });
});

describe("parseUnifiedDiffWithStats", () => {
  it("collects per-file +added/-deleted totals from hunk headers", () => {
    const parsed = parseUnifiedDiffWithStats(DIFF);
    expect(parsed.stats["src/orderService.ts"]).toEqual({ added: 4, deleted: 3 });
    expect(parsed.stats["src/new-name.ts"]).toEqual({ added: 2, deleted: 3 });
  });

  it("skips deleted files because they have no new-side path in the artifact", () => {
    const parsed = parseUnifiedDiffWithStats(DIFF);
    expect(parsed.stats["src/removed.ts"]).toBeUndefined();
  });
});

describe("validatedRef", () => {
  it("accepts branch, tag, sha and HEAD~n shapes", () => {
    for (const ref of ["main", "origin/main", "v1.2.3", "a1b2c3d", "HEAD~2", "feature/x_y-z", "HEAD^"]) {
      expect(validatedRef(ref)).toBe(ref);
    }
  });

  it("rejects refs that could parse as git options or empty input", () => {
    for (const ref of ["--output=/tmp/x", "-rf", "", "  ", "ref with space"]) {
      expect(() => validatedRef(ref)).toThrow(/looks invalid/);
    }
  });
});
