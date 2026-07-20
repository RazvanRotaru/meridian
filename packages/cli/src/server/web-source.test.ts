import { describe, expect, it } from "vitest";
import { artifactSourceFor } from "./web-source";

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
});
