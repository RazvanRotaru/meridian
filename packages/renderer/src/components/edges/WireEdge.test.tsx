import { renderToStaticMarkup } from "react-dom/server";
import { Position, type EdgeProps } from "@xyflow/react";
import { describe, expect, it } from "vitest";
import { WireEdge } from "./WireEdge";

describe("WireEdge", () => {
  it("keeps highlighted wires static while retaining their label", () => {
    const props = {
      id: "calls:a->b",
      source: "a",
      target: "b",
      sourceX: 0,
      sourceY: 0,
      targetX: 120,
      targetY: 0,
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
      selected: false,
      deletable: false,
      style: { opacity: 1, stroke: "#58A6FF", strokeWidth: 3 },
      data: { pulse: true, depKind: "calls" },
    } as unknown as EdgeProps;

    const markup = renderToStaticMarkup(<svg><WireEdge {...props} /></svg>);

    expect(markup).toContain("calls");
    expect(markup).not.toContain("stroke-dasharray");
    expect(markup).not.toContain("<animate");
    expect(markup).not.toContain("stroke-dashoffset");
  });
});
