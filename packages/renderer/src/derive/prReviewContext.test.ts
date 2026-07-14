import { describe, expect, it } from "vitest";
import { reviewContextFromPrFiles } from "./prReviewContext";

describe("reviewContextFromPrFiles", () => {
  it("fails closed to whole-file matching when GitHub marks a patch incomplete", () => {
    const context = reviewContextFromPrFiles({
      prNumber: 17,
      headRef: "feature",
      baseRef: "main",
      scopeId: "repo",
      files: [{
        path: "src/truncated.ts",
        status: "modified",
        additions: 20,
        deletions: 10,
        diffComplete: false,
        hunks: [{ start: 40, end: 42 }],
        oldHunks: [{ start: 38, end: 40 }],
      }],
    });

    expect(context.changedFiles).toEqual([{ path: "src/truncated.ts", status: "modified" }]);
  });

  it("retains verified exact ranges in the graph's coordinate space", () => {
    const files = [{
      path: "src/complete.ts",
      status: "renamed" as const,
      additions: 1,
      deletions: 1,
      previousPath: "src/old.ts",
      diffComplete: true,
      hunks: [{ start: 12, end: 12 }],
      oldHunks: [{ start: 9, end: 9 }],
    }];

    const base = reviewContextFromPrFiles({
      prNumber: 18,
      headRef: "feature",
      baseRef: "main",
      scopeId: "repo",
      files,
    });
    const head = reviewContextFromPrFiles({
      prNumber: 18,
      headRef: "feature",
      baseRef: "main",
      scopeId: "repo",
      files,
    }, { baseSide: false });

    expect(base.changedFiles[0]).toMatchObject({
      previousPath: "src/old.ts",
      hunks: [{ start: 12, end: 12 }],
      oldHunks: [{ start: 9, end: 9 }],
    });
    expect(head.changedFiles[0]).not.toHaveProperty("oldHunks");
  });
});
