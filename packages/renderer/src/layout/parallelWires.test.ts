/**
 * The pair ribbon: same-(source,target) plain strands fold into ONE striped cable edge (members
 * lightest-first so the heaviest rides mid-cable under the single arrowhead); typed edges and lone
 * wires pass through. pairOf gives the inspector the full member stack for any clicked wire —
 * ribbon members, a strand's siblings (including bundle-folded ones), or a bundle as itself.
 */

import { describe, expect, it } from "vitest";
import type { Edge } from "@xyflow/react";
import { foldPairRibbons, pairOf, RIBBON_EDGE_TYPE, type RibbonEdgeData } from "./parallelWires";
import { BUNDLE_EDGE_TYPE } from "./edgeBundling";
import { ROUTED_EDGE_TYPE } from "./edgeRouting";

const wire = (id: string, source: string, target: string, weight = 1, type?: string): Edge => ({
  id,
  source,
  target,
  type,
  data: { weight },
  style: { stroke: `#${id}` },
  markerEnd: `marker-${id}`,
});

describe("foldPairRibbons", () => {
  it("folds a multi-kind pair into one ribbon: heaviest strand MID-CABLE, dominant's marker on the cable", () => {
    const folded = foldPairRibbons([wire("refs", "a", "b", 7), wire("calls", "a", "b", 5), wire("inst", "a", "b", 2), wire("lone", "a", "c")]);
    expect(folded.map((edge) => edge.id)).toEqual(["ribbon:a->b", "lone"]);
    const ribbon = folded[0];
    expect(ribbon.type).toBe(RIBBON_EDGE_TYPE);
    // Centre-out by weight: refs(7) mid-cable, calls(5) beside it, inst(2) at the band's edge.
    expect((ribbon.data as RibbonEdgeData).members.map((member) => member.id)).toEqual(["calls", "refs", "inst"]);
    expect(ribbon.markerEnd).toBe("marker-refs"); // heaviest strand's arrowhead
  });

  it("leaves typed edges (bundles, routed rails) and opposite-direction wires unfolded", () => {
    const edges = [
      wire("fwd", "a", "b"),
      wire("rev", "b", "a"),
      wire("bus", "a", "b", 1, ROUTED_EDGE_TYPE),
      wire("hwy", "a", "b", 1, BUNDLE_EDGE_TYPE),
    ];
    expect(foldPairRibbons(edges)).toEqual(edges);
  });
});

describe("pairOf", () => {
  it("a ribbon opens as its members, heaviest first", () => {
    const [ribbon] = foldPairRibbons([wire("calls", "a", "b", 5), wire("refs", "a", "b", 7)]);
    expect(pairOf(ribbon, [ribbon]).map((edge) => edge.id)).toEqual(["refs", "calls"]);
  });

  it("a plain strand collects its same-pair siblings, clicked first", () => {
    const clicked = wire("refs", "a", "b");
    const pair = pairOf(clicked, [wire("calls", "a", "b"), clicked, wire("other", "a", "c")]);
    expect(pair.map((edge) => edge.id)).toEqual(["refs", "calls"]);
  });

  it("finds siblings folded inside a bundle (the drilled-constituent case)", () => {
    const drilled = wire("calls", "x", "y");
    const bundle: Edge = {
      ...wire("hwy", "px", "py", 1, BUNDLE_EDGE_TYPE),
      data: { constituents: [drilled, wire("refs", "x", "y"), wire("far", "x", "z")] },
    };
    expect(pairOf(drilled, [bundle]).map((edge) => edge.id)).toEqual(["calls", "refs"]);
  });

  it("a clicked bundle inspects as itself", () => {
    const bundle = wire("hwy", "px", "py", 1, BUNDLE_EDGE_TYPE);
    expect(pairOf(bundle, [bundle, wire("w", "px", "py")])).toEqual([bundle]);
  });
});
