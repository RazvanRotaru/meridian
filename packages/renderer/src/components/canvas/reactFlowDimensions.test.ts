import { describe, expect, it } from "vitest";
import type { Node } from "@xyflow/react";
import { withReactFlowDimensions } from "./reactFlowDimensions";

const node = (overrides: Partial<Node> = {}): Node => ({
  id: "node",
  position: { x: 10, y: 20 },
  data: { label: "Node" },
  ...overrides,
});

describe("withReactFlowDimensions", () => {
  it("promotes a complete finite numeric style size without changing the style or other fields", () => {
    const style = { width: 180, height: 54, opacity: 0.4 };
    const data = { label: "Node", marker: true };
    const original = node({ type: "file", parentId: "parent", style, data });
    const input = [original];

    const result = withReactFlowDimensions(input);

    expect(result).not.toBe(input);
    expect(result[0]).not.toBe(original);
    expect(result[0]).toEqual({ ...original, width: 180, height: 54 });
    expect(result[0].style).toBe(style);
    expect(result[0].data).toBe(data);
  });

  it.each([
    {
      axis: "height",
      original: node({ initialWidth: 160, style: { height: 54 } }),
      expected: { height: 54 },
    },
    {
      axis: "width",
      original: node({ measured: { height: 54 }, style: { width: 180 } }),
      expected: { width: 180 },
    },
  ])("fills only the unresolved $axis axis from a partial style", ({ original, expected }) => {
    const result = withReactFlowDimensions([original]);

    expect(result[0]).toEqual({ ...original, ...expected });
  });

  it.each([
    node({ width: 180, height: 54, style: { width: 200, height: 60 } }),
    node({ initialWidth: 180, initialHeight: 54, style: { width: 200, height: 60 } }),
    node({ measured: { width: 180, height: 54 }, style: { width: 200, height: 60 } }),
    node({ measured: { width: 180 }, initialHeight: 54, style: { width: 200, height: 60 } }),
  ])("preserves a node whose dimensions React Flow already recognises", (original) => {
    const input = [original];

    const result = withReactFlowDimensions(input);

    expect(result).toBe(input);
    expect(result[0]).toBe(original);
  });

  it.each([
    { width: "180px", height: 54 },
    { width: 180 },
    { width: Number.NaN, height: 54 },
    { width: 180, height: Number.POSITIVE_INFINITY },
  ])("ignores a style size React Flow cannot safely consume: %o", (style) => {
    const original = node({ style });
    const input = [original];

    const result = withReactFlowDimensions(input);

    expect(result).toBe(input);
    expect(result[0]).toBe(original);
  });

  it("keeps untouched node identities when another node requires promotion", () => {
    const untouched = node({ id: "explicit", width: 120, height: 40 });
    const styleSized = node({ id: "styled", style: { width: 180, height: 54 } });
    const input = [untouched, styleSized];

    const result = withReactFlowDimensions(input);

    expect(result).not.toBe(input);
    expect(result[0]).toBe(untouched);
    expect(result[1]).toEqual({ ...styleSized, width: 180, height: 54 });
  });
});
