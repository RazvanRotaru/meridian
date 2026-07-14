import { describe, expect, it } from "vitest";
import { artifactSourceFor } from "./web-source";

describe("artifact source provenance", () => {
  it("retains the selected language for later PR analysis", () => {
    expect(artifactSourceFor({
      kind: "github",
      value: "octo/repo",
      subdir: "packages/app",
      lang: "typescript",
    })).toEqual({
      kind: "github",
      owner: "octo",
      repo: "repo",
      subdir: "packages/app",
      language: "typescript",
    });
  });

  it("retains the extractor's resolved language when selection was automatic", () => {
    expect(artifactSourceFor({ kind: "github", value: "octo/repo" }, "typescript")).toMatchObject({
      language: "typescript",
    });
  });

  it("does not attach repository analysis provenance to local paths", () => {
    expect(artifactSourceFor({ kind: "path", value: ".", lang: "typescript" })).toEqual({ kind: "other" });
  });
});
