import { describe, expect, it } from "vitest";
import { artifactId, parseGenerateRequest } from "./web-request";

describe("web graph identity", () => {
  it("rejects retired and unknown selectors instead of retaining a compatibility path", () => {
    expect(() => parseGenerateRequest({ kind: "path", value: "/repo", lang: "typescript" }))
      .toThrow(/unknown field/);
    const request = parseGenerateRequest({ kind: "path", value: "/repo" });
    expect(artifactId(request)).toBe(artifactId({ kind: "path", value: "/repo" }));
  });
});
