import { describe, expect, it } from "vitest";
import type { PrChangedFile } from "../state/prTypes";
import { nonTextualDiffNotice } from "./nonTextualDiffNotice";

describe("nonTextualDiffNotice", () => {
  it("explains binary and mode-only changes instead of presenting unchanged source", () => {
    expect(nonTextualDiffNotice("src/logo.bin", [changed({ path: "src/logo.bin" })])).toBe(
      "Git reports this file changed, but no textual diff is available (for example, binary or mode-only).",
    );
  });

  it("names a pure rename from either revision's path", () => {
    const renamed = changed({
      path: "src/new-name.ts",
      previousPath: "src/old-name.ts",
      status: "renamed",
    });

    expect(nonTextualDiffNotice("packages/app/src/new-name.ts", [renamed])).toBe(
      "Renamed from src/old-name.ts; Git reports no textual diff.",
    );
    expect(nonTextualDiffNotice("src/old-name.ts", [renamed])).toBe(
      "Renamed from src/old-name.ts; Git reports no textual diff.",
    );
  });

  it("warns when file-level churn exists but the textual body is incomplete", () => {
    expect(nonTextualDiffNotice("src/large.ts", [changed({
      path: "src/large.ts",
      additions: 100,
      deletions: 40,
    })])).toBe("Git reports this file changed, but its complete textual diff is unavailable.");
  });

  it("stays silent for exact textual diffs, ordinary files, and ambiguous suffixes", () => {
    expect(nonTextualDiffNotice("src/complete.ts", [changed({
      path: "src/complete.ts",
      diffComplete: true,
    })])).toBeNull();
    expect(nonTextualDiffNotice("src/ordinary.ts", [])).toBeNull();
    expect(nonTextualDiffNotice("same.ts", [
      changed({ path: "apps/a/same.ts" }),
      changed({ path: "apps/b/same.ts" }),
    ])).toBeNull();
  });
});

function changed(overrides: Partial<PrChangedFile>): PrChangedFile {
  return {
    path: "src/file.ts",
    status: "modified",
    additions: 0,
    deletions: 0,
    diffComplete: false,
    ...overrides,
  };
}
