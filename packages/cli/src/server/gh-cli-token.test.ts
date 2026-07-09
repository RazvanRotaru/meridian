import { describe, expect, it } from "vitest";
import { parseGhTokenOutput } from "./gh-cli-token";

describe("parseGhTokenOutput", () => {
  it("returns the trimmed token on a clean exit", () => {
    expect(parseGhTokenOutput("gho_abc123\n", 0)).toBe("gho_abc123");
  });

  it("is undefined when gh exits non-zero (not signed in)", () => {
    expect(parseGhTokenOutput("", 1)).toBeUndefined();
    expect(parseGhTokenOutput("error: not logged in\n", 1)).toBeUndefined();
  });

  it("is undefined on a killed run (code null) or empty output", () => {
    expect(parseGhTokenOutput("gho_abc", null)).toBeUndefined();
    expect(parseGhTokenOutput("   \n", 0)).toBeUndefined();
  });
});
