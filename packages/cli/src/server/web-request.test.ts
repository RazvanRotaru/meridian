import { describe, expect, it } from "vitest";
import { artifactId, parseGenerateRequest } from "./web-request";

describe("web graph identity", () => {
  it("ignores the retired language selector and keeps one canonical analysis identity", () => {
    const typescript = parseGenerateRequest({ kind: "path", value: "/repo", lang: "typescript" });
    const python = parseGenerateRequest({ kind: "path", value: "/repo", lang: "python" });

    expect(typescript).not.toHaveProperty("lang");
    expect(python).not.toHaveProperty("lang");
    expect(artifactId(typescript)).toBe(artifactId(python));
  });
});
