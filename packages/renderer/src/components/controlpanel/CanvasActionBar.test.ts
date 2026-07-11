import { describe, expect, it } from "vitest";
import { canvasActionPlacement, panelAnchorStyle } from "./canvasActionBarLayout";

describe("canvasActionPlacement", () => {
  it("centers each single-row footprint at its exact clearance threshold", () => {
    expect(canvasActionPlacement(798, "base")).toEqual({ position: "bottom-center", layout: "row" });
    expect(canvasActionPlacement(871, "extract")).toEqual({ position: "bottom-center", layout: "row" });
    expect(canvasActionPlacement(953, "minimal")).toEqual({ position: "bottom-center", layout: "row" });
  });

  it("moves a full row beside the control panel when centering would overlap it", () => {
    expect(canvasActionPlacement(797, "base")).toEqual({ position: "bottom-left", layout: "row", left: 327, bottom: 181 });
    expect(canvasActionPlacement(870, "extract")).toEqual({ position: "bottom-left", layout: "row", left: 327, bottom: 181 });
    expect(canvasActionPlacement(952, "minimal")).toEqual({ position: "bottom-left", layout: "row", left: 327, bottom: 181 });
  });

  it("keeps the minimal actions in one row down to the exact side-lane boundary", () => {
    expect(canvasActionPlacement(642, "minimal")).toEqual({ position: "bottom-left", layout: "row", left: 327, bottom: 181 });
    expect(canvasActionPlacement(641, "minimal")).toEqual({ position: "bottom-left", layout: "stacked", left: 327, bottom: 181 });
  });

  it("stacks whole groups after a review panel narrows the graph pane", () => {
    expect(canvasActionPlacement(520, "minimal")).toEqual({ position: "bottom-left", layout: "stacked", left: 327, bottom: 181 });
    expect(canvasActionPlacement(559, "extract")).toEqual({ position: "bottom-left", layout: "stacked", left: 327, bottom: 181 });
  });

  it("keeps the short stacked layout when the side lane disappears", () => {
    expect(canvasActionPlacement(497, "minimal")).toEqual({ position: "bottom-left", layout: "stacked", left: 327, bottom: 181 });
    expect(canvasActionPlacement(496, "minimal")).toEqual({ position: "bottom-left", layout: "stacked", left: 326, bottom: 181 });
    expect(canvasActionPlacement(400, "minimal")).toEqual({ position: "bottom-left", layout: "stacked", left: 230, bottom: 181 });
  });

  it("clamps a stacked bar to the canvas edge at a truly tiny width", () => {
    expect(canvasActionPlacement(150, "minimal")).toEqual({ position: "bottom-left", layout: "stacked", left: 16, bottom: 181 });
  });

  it("slides toward the bottom while preserving the members-to-actions gap", () => {
    expect(canvasActionPlacement(520, "minimal", 418)).toEqual({ position: "bottom-left", layout: "stacked", left: 327, bottom: 181 });
    expect(canvasActionPlacement(520, "minimal", 417)).toEqual({ position: "bottom-left", layout: "stacked", left: 327, bottom: 180 });
    expect(canvasActionPlacement(520, "minimal", 253)).toEqual({ position: "bottom-left", layout: "stacked", left: 327, bottom: 16 });
  });

  it("lifts the bar above chrome when horizontal or vertical overlap is unavoidable", () => {
    expect(panelAnchorStyle(canvasActionPlacement(330, "minimal", 600))).toMatchObject({ left: 160, bottom: 181, zIndex: 7 });
    expect(panelAnchorStyle(canvasActionPlacement(520, "minimal", 417))).toMatchObject({ left: 327, bottom: 180, zIndex: 7 });
  });
});
