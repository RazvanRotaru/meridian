import { renderToStaticMarkup } from "react-dom/server";
import { Position, type Edge, type EdgeProps } from "@xyflow/react";
import { describe, expect, it } from "vitest";
import type { BundleEdgeData } from "../../layout/edgeBundling";
import type { CycleEdgeData } from "../../layout/cycleFusion";
import type { RibbonEdgeData } from "../../layout/parallelWires";
import { BundledEdge } from "./BundledEdge";
import { CycleEdge } from "./CycleEdge";
import { RibbonEdge } from "./RibbonEdge";

const MEMBER: Edge = {
  id: "calls:a->b",
  source: "a",
  target: "b",
  style: { opacity: 1, stroke: "#8C9DFF" },
  data: { relationKind: "calls", weight: 1, underlyingEdgeIds: ["artifact-call"] },
};

function props(data: Record<string, unknown>): EdgeProps {
  return {
    id: "aggregate:a->b",
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
    style: { opacity: 1, stroke: "#8C9DFF", filter: "drop-shadow(0 0 3px #8C9DFF)" },
    data,
  } as unknown as EdgeProps;
}

describe("incoming-call aggregate edge interaction", () => {
  it("makes a spotlighted mutual-call cycle pointer-inert at its renderer boundary", () => {
    const data: CycleEdgeData = {
      members: [MEMBER, { ...MEMBER, id: "calls:b->a", source: "b", target: "a" }],
      relationKind: "calls",
      forwardWeight: 1,
      backwardWeight: 1,
      crossPackage: false,
      outsideView: false,
      callLensSpotlight: true,
    };

    const markup = renderToStaticMarkup(<svg><CycleEdge {...props(data)} /></svg>);

    expect(markup).toContain('<g style="pointer-events:none">');
  });

  it("makes a spotlighted ribbon pointer-inert while retaining its glow", () => {
    const data: RibbonEdgeData = {
      members: [MEMBER],
      boosted: true,
      callLensSpotlight: true,
    };

    const markup = renderToStaticMarkup(<svg><RibbonEdge {...props(data)} /></svg>);

    expect(markup).toContain('<g style="pointer-events:none;filter:drop-shadow(0 0 3px #8C9DFF)">');
  });

  it("makes a spotlighted highway bundle pointer-inert while retaining its glow", () => {
    const data: BundleEdgeData = {
      count: 1,
      breakdown: { calls: 1 },
      dominantKind: "calls",
      relationKind: "calls",
      constituents: [MEMBER],
      hasLit: true,
      crossFrame: true,
      crossPackage: false,
      outsideView: false,
      category: "bundle",
      sourceParent: "left",
      targetParent: "right",
      callLensSpotlight: true,
    };

    const markup = renderToStaticMarkup(<svg><BundledEdge {...props(data)} /></svg>);

    expect(markup).toContain('<g style="pointer-events:none;filter:drop-shadow(0 0 3px #8C9DFF)">');
  });
});
