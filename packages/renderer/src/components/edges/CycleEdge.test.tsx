import { renderToStaticMarkup } from "react-dom/server";
import { Position, type EdgeProps } from "@xyflow/react";
import { describe, expect, it } from "vitest";
import { BOUNDARY_DASH_PATTERN } from "../../layout/edgeBoundary";
import { CycleEdge } from "./CycleEdge";

describe("CycleEdge", () => {
  it("applies the boundary dash to the tension halo so it cannot fill the main stroke's gaps", () => {
    const props = {
      id: "cycle:a<->b",
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
      markerEnd: "end",
      markerStart: "start",
      style: { stroke: "#123456", strokeDasharray: BOUNDARY_DASH_PATTERN },
      data: { members: [], forwardWeight: 1, backwardWeight: 1, crossPackage: true, outsideView: false },
    } as unknown as EdgeProps;

    const markup = renderToStaticMarkup(<svg><CycleEdge {...props} /></svg>);
    expect(markup).toContain(`stroke-dasharray="${BOUNDARY_DASH_PATTERN}"`);
  });
});
