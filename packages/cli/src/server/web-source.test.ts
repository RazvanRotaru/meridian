import { describe, expect, it } from "vitest";
import {
  artifactSourceFor,
  partitionExtractionSubdir,
  restoreExtractionSubdir,
} from "./web-source";

describe("artifact source provenance", () => {
  it("retains only repository coordinates needed for later PR analysis", () => {
    expect(artifactSourceFor({
      kind: "github",
      value: "octo/repo",
      subdir: "packages/app",
    })).toEqual({
      kind: "github",
      owner: "octo",
      repo: "repo",
      subdir: "packages/app",
    });
  });

  it("does not persist graph language as future extraction configuration", () => {
    expect(artifactSourceFor({ kind: "github", value: "octo/repo" })).toStrictEqual({
      kind: "github",
      owner: "octo",
      repo: "repo",
    });
  });

  it("retains local-path trust without persisting the filesystem value", () => {
    expect(artifactSourceFor({ kind: "path", value: "/private/worktree" })).toEqual({ kind: "path" });
  });

  it("preserves opaque Git filename characters while stripping and restoring a subdir", () => {
    const files = [
      { path: "packages/app/src/trailing.ts ", previousPath: "packages/app/src/old.ts " },
      { path: "packages/app/C:\\literal.ts", previousPath: "packages/other/outside-old.ts" },
      { path: "packages/other/outside.ts", previousPath: "packages/other/older.ts" },
    ];

    expect(partitionExtractionSubdir(files, "packages/app")).toEqual({
      inside: [
        { path: "src/trailing.ts ", previousPath: "src/old.ts " },
        { path: "C:\\literal.ts" },
      ],
      outside: [{ path: "packages/other/outside.ts", previousPath: "packages/other/older.ts" }],
    });
    expect(restoreExtractionSubdir("src/trailing.ts ", "packages/app")).toBe(
      "packages/app/src/trailing.ts ",
    );
    expect(restoreExtractionSubdir("C:\\literal.ts", "packages/app")).toBe(
      "packages/app/C:\\literal.ts",
    );
  });

  it.skipIf(process.platform === "win32")(
    "treats a POSIX extraction subdir backslash as an opaque filename character",
    () => {
      expect(partitionExtractionSubdir(
        [{ path: "packages\\app/src/a.ts" }, { path: "packages/app/src/b.ts" }],
        "packages\\app",
      )).toEqual({
        inside: [{ path: "src/a.ts" }],
        outside: [{ path: "packages/app/src/b.ts" }],
      });
      expect(restoreExtractionSubdir("src/a.ts", "packages\\app")).toBe(
        "packages\\app/src/a.ts",
      );
    },
  );
});
