import { renderToStaticMarkup } from "react-dom/server";
import { Position, type EdgeProps } from "@xyflow/react";
import { describe, expect, it } from "vitest";
import { AsyncRailEdge } from "./AsyncRailEdge";

describe("AsyncRailEdge", () => {
  it("preserves selection paint on the rail and endpoint sockets", () => {
    const props = {
      id: "async:price",
      source: "launch",
      target: "await",
      sourceX: 20,
      sourceY: 30,
      targetX: 240,
      targetY: 40,
      sourcePosition: Position.Bottom,
      targetPosition: Position.Bottom,
      selected: false,
      deletable: false,
      style: { stroke: "#56C271", strokeWidth: 3, opacity: 0.25 },
    } as unknown as EdgeProps;

    const markup = renderToStaticMarkup(<svg><AsyncRailEdge {...props} /></svg>);

    expect(markup).toContain("stroke:#56C271");
    expect(markup).toContain("stroke-width:3");
    expect(markup).toContain("opacity:0.25");
    expect(markup.match(/opacity="0.25"/g)).toHaveLength(2);
  });
});
