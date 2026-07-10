/**
 * Parallel same-pair strands: assignPairLanes spreads a pair's wires into centered lanes (bundles
 * and routed rails excluded); pairOf collects a clicked strand's whole ordered-pair stack — clicked
 * first, including siblings folded inside bundles — so the inspector always tells the full story.
 */

import { describe, expect, it } from "vitest";
import type { Edge } from "@xyflow/react";
import { assignPairLanes, pairOf, PAIR_LANE_PX } from "./parallelWires";
import { BUNDLE_EDGE_TYPE } from "./edgeBundling";
import { ROUTED_EDGE_TYPE } from "./edgeRouting";

const wire = (id: string, source: string, target: string, type?: string): Edge => ({ id, source, target, type });

describe("assignPairLanes", () => {
  it("spreads a 3-strand pair into centered lanes and leaves lone wires alone", () => {
    const lanes = assignPairLanes([
      wire("calls", "a", "b"),
      wire("refs", "a", "b"),
      wire("inst", "a", "b"),
      wire("lone", "a", "c"),
    ]);
    expect(lanes.get("calls")).toBe(-PAIR_LANE_PX);
    expect(lanes.get("refs")).toBe(0);
    expect(lanes.get("inst")).toBe(PAIR_LANE_PX);
    expect(lanes.has("lone")).toBe(false);
  });

  it("treats A→B and B→A as different pairs, and skips bundles and routed rails", () => {
    const lanes = assignPairLanes([
      wire("fwd", "a", "b"),
      wire("rev", "b", "a"),
      wire("bus1", "a", "b", ROUTED_EDGE_TYPE),
      wire("hwy", "a", "b", BUNDLE_EDGE_TYPE),
    ]);
    expect(lanes.size).toBe(0); // fwd/rev are singletons of their own ordered pairs
  });
});

describe("pairOf", () => {
  it("returns the clicked strand first, then its same-pair siblings", () => {
    const clicked = wire("refs", "a", "b");
    const pair = pairOf(clicked, [wire("calls", "a", "b"), clicked, wire("other", "a", "c")]);
    expect(pair.map((edge) => edge.id)).toEqual(["refs", "calls"]);
  });

  it("finds siblings folded inside a bundle (the drilled-constituent case)", () => {
    const drilled = wire("calls", "x", "y");
    const bundle: Edge = {
      ...wire("hwy", "px", "py", BUNDLE_EDGE_TYPE),
      data: { constituents: [drilled, wire("refs", "x", "y"), wire("far", "x", "z")] },
    };
    const pair = pairOf(drilled, [bundle]);
    expect(pair.map((edge) => edge.id)).toEqual(["calls", "refs"]);
  });

  it("a clicked bundle inspects as itself", () => {
    const bundle = wire("hwy", "px", "py", BUNDLE_EDGE_TYPE);
    expect(pairOf(bundle, [bundle, wire("w", "px", "py")])).toEqual([bundle]);
  });
});
