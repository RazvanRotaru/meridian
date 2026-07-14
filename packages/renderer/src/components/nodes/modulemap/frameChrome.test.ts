import { describe, expect, it } from "vitest";
import { frameTitleBarStyle, TITLE_BAR } from "./frameChrome";

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
