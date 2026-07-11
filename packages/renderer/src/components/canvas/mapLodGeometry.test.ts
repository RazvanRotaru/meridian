import { describe, expect, it } from "vitest";
import type { Node } from "@xyflow/react";
import { enclosingParentFrame, structuralGraphBounds } from "./mapLodGeometry";

const node = (id: string, x: number, y: number, width: number, height: number, parentId?: string, type = "file"): Node => ({
  id,
  type,
  parentId,
  position: { x, y },
  style: { width, height },
  data: {},
});

describe("structuralGraphBounds", () => {
  it("bounds the structural graph and accounts for parent-relative positions", () => {
    const nodes = [node("frame", 100, 40, 200, 120, undefined, "package"), node("child", 30, 20, 40, 30, "frame")];

    expect(structuralGraphBounds(nodes)).toEqual({ x: 100, y: 40, width: 200, height: 120 });
  });

  it("does not let a selection-relative ghost enlarge the parent node", () => {
    const nodes = [node("left", 0, 0, 100, 50), node("right", 300, 100, 100, 50), node("ghost", 2000, 900, 180, 50, undefined, "ghost")];

    expect(structuralGraphBounds(nodes)).toEqual({ x: 0, y: 0, width: 400, height: 150 });
  });

  it("returns null for an empty graph", () => {
    expect(structuralGraphBounds([])).toBeNull();
  });
});

describe("enclosingParentFrame", () => {
  it("adds a stable-screen header and gutters around every child", () => {
    expect(enclosingParentFrame({ x: 0, y: 0, width: 400, height: 150 }, 0.5)).toEqual({
      x: -36,
      y: -100,
      width: 472,
      height: 286,
    });
  });
});
