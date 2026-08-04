import { describe, expect, it } from "vitest";
import { compareBinaryStrings, isStrictlyBinarySorted } from "./binary-order";

describe("canonical binary string order", () => {
  it("is locale-independent UTF-16 code-unit order, including astral versus BMP paths", () => {
    const values = [
      "src/a.ts",
      "src/\uE000.ts",
      "src/é.ts",
      "src/😀.ts",
      "src/Z.ts",
    ];
    const ordered = [...values].sort(compareBinaryStrings);

    expect(ordered).toEqual([
      "src/Z.ts",
      "src/a.ts",
      "src/é.ts",
      "src/😀.ts",
      "src/\uE000.ts",
    ]);
    expect(isStrictlyBinarySorted(ordered)).toBe(true);
    expect(isStrictlyBinarySorted([...ordered, ordered.at(-1)!])).toBe(false);
  });
});
