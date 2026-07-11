import { describe, expect, it } from "vitest";
import { canvasActionPlacement } from "./CanvasActionBar";

describe("canvasActionPlacement", () => {
  it("keeps the action bar centered while the bottom lane has room", () => {
    expect(canvasActionPlacement(900, true)).toEqual({ position: "bottom-center" });
    expect(canvasActionPlacement(800, false)).toEqual({ position: "bottom-center" });
  });

  it("moves a wider extraction bar above the chrome before it reaches either gutter", () => {
    expect(canvasActionPlacement(850, true)).toEqual({ position: "bottom-left", left: 327, bottom: 181 });
  });

  it("uses the graph pane width after a review rail narrows it", () => {
    expect(canvasActionPlacement(520, false)).toEqual({ position: "bottom-left", left: 327, bottom: 181 });
  });

  it("keeps the bar inside an exceptionally narrow pane", () => {
    expect(canvasActionPlacement(400, true)).toEqual({ position: "bottom-left", left: 171, bottom: 181 });
  });
});
