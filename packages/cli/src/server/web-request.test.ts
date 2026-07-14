import { describe, expect, it } from "vitest";
import { artifactId } from "./web-request";

describe("web graph identity", () => {
  it("separates local analyses by selected language", () => {
    const source = { kind: "path", value: "/repo" } as const;
    expect(artifactId({ ...source, lang: "typescript" })).not.toBe(
      artifactId({ ...source, lang: "python" }),
    );
  });
});
