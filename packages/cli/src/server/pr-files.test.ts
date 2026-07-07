/**
 * Aligning repo-root-relative PR filenames with the extraction root: with no subdir they pass
 * through; with one, the prefix is stripped and anything outside the subdir is dropped so the
 * survivors match a node's `location.file`.
 */

import { describe, expect, it } from "vitest";
import { stripSubdirPrefix } from "./pr-files";

describe("stripSubdirPrefix", () => {
  it("returns filenames unchanged when there is no subdir", () => {
    expect(stripSubdirPrefix(["src/a.ts", "README.md"])).toEqual(["src/a.ts", "README.md"]);
  });

  it("strips the subdir prefix and drops files outside it", () => {
    const files = ["packages/cli/src/a.ts", "packages/cli/b.ts", "packages/other/c.ts", "root.md"];
    expect(stripSubdirPrefix(files, "packages/cli")).toEqual(["src/a.ts", "b.ts"]);
  });

  it("normalizes backslashes, a leading ./ and surrounding slashes", () => {
    expect(stripSubdirPrefix(["src/pkg/a.ts"], "./src/pkg/")).toEqual(["a.ts"]);
    expect(stripSubdirPrefix(["a\\b\\c.ts"], "a/b")).toEqual(["c.ts"]);
  });

  it("drops a file equal to the subdir path itself, leaving no empty survivors", () => {
    expect(stripSubdirPrefix(["src", "src/a.ts"], "src")).toEqual(["a.ts"]);
  });
});
