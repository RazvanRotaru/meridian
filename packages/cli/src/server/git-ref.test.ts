import { describe, expect, it } from "vitest";
import { isAllowedCloneRef } from "./git-ref";

describe("isAllowedCloneRef", () => {
  it.each([
    "main",
    "feature/dropdown",
    "feature+picker@team",
    "@",
    "release/$next",
    "unicode/ramură",
  ])("accepts Git branch %s", (value) => {
    expect(isAllowedCloneRef(value)).toBe(true);
  });

  it.each([
    "",
    "HEAD",
    "--upload-pack=evil",
    "/leading",
    "trailing/",
    ".hidden",
    "topic/.hidden",
    "topic.lock",
    "topic/child.lock",
    "has space",
    "double..dot",
    "reflog@{1}",
    "double//slash",
    "bad~ref",
    "bad^ref",
    "bad:ref",
    "bad?ref",
    "bad*ref",
    "bad[ref",
    "bad\\ref",
  ])("rejects non-branch %s", (value) => {
    expect(isAllowedCloneRef(value)).toBe(false);
  });
});
