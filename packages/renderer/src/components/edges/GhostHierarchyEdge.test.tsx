import { renderToStaticMarkup } from "react-dom/server";
import { Position, type EdgeProps } from "@xyflow/react";
import { describe, expect, it } from "vitest";
import { GhostHierarchyEdge } from "./GhostHierarchyEdge";

describe("GhostHierarchyEdge", () => {
  it("renders one neutral non-interactive spoke without semantic chrome", () => {
    const props = {
      id: "ghost-hierarchy:parent->member",
      source: "parent",
      target: "member",
      sourceX: 0,
      sourceY: 10,
      targetX: 120,
      targetY: 40,
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
      selected: false,
      deletable: false,
      markerEnd: "url(#semantic-arrow)",
      style: { stroke: "#ff0000", strokeWidth: 9 },
      data: { edgeRole: "ghost-hierarchy", pulse: true, depKind: "calls" },
    } as unknown as EdgeProps;

    const markup = renderToStaticMarkup(<svg><GhostHierarchyEdge {...props} /></svg>);

    expect(markup.match(/<path/g)).toHaveLength(1);
    expect(markup).toContain("stroke:#4B535F");
    expect(markup).toContain("stroke-width:1");
    expect(markup).toContain("pointer-events:none");
    expect(markup).not.toContain("marker-end");
    expect(markup).not.toContain("<text");
    expect(markup).not.toContain("<animate");
  });
});
