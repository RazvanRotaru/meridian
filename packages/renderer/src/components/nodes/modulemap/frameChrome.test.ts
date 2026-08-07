import { describe, expect, it } from "vitest";
import { cardSelectedStyle, frameTitleBarStyle, TITLE_BAR } from "./frameChrome";

describe("Map container title", () => {
  it.each([
    ["added", "#3FB950"],
    ["modified", "#E2A33C"],
    ["deleted", "#E5484D"],
    ["renamed", "#E2A33C"],
  ] as const)("colours a %s container title from the shared change palette", (status, color) => {
    expect(frameTitleBarStyle(status)).toMatchObject({
      borderBottomColor: color,
      backgroundImage: `linear-gradient(0deg, ${color}66, ${color}66)`,
    });
  });

  it("keeps an unchanged container title on the resting style", () => {
    expect(frameTitleBarStyle(undefined)).toBe(TITLE_BAR);
  });
});

describe("Map card selection", () => {
  it("preserves the resting border style while recolouring it", () => {
    expect(cardSelectedStyle({ border: "1px dashed #4B535F" }, "#A78BFA")).toMatchObject({
      border: "1px dashed #A78BFA",
    });
    expect(cardSelectedStyle({ border: "2px solid rgba(42, 49, 64, 0.8)" }, "#60A5FA")).toMatchObject({
      border: "2px solid #60A5FA",
    });
  });
});
