/**
 * Cycle fusion: A→B + B→A of the SAME kind fuse into one double-headed cycle edge (members kept
 * for the inspector, weights per direction, both arrowheads); different kinds or one-way pairs
 * pass through; typed edges are never touched; the fused edge takes the brighter emphasis.
 */

import { describe, expect, it } from "vitest";
import type { Edge } from "@xyflow/react";
import { CYCLE_EDGE_TYPE, fuseCycles, type CycleEdgeData } from "./cycleFusion";
import { BOUNDARY_DASH_PATTERN, type EdgeBoundaryData } from "./edgeBoundary";

type WireOptions = EdgeBoundaryData & { weight?: number; opacity?: number; type?: string; staleDash?: string };

const wire = (id: string, source: string, target: string, kind: string, opts: WireOptions = {}): Edge => ({
  id,
  source,
  target,
  type: opts.type,
  data: {
    depKind: kind,
    category: "dep",
    weight: opts.weight ?? 1,
    underlyingEdgeIds: [id],
    crossPackage: opts.crossPackage ?? false,
    outsideView: opts.outsideView ?? false,
  },
  style: { opacity: opts.opacity ?? 0.4, stroke: "#123456", ...(opts.staleDash ? { strokeDasharray: opts.staleDash } : {}) },
  markerEnd: `marker-${id}`,
});

describe("fuseCycles", () => {
  it("fuses a same-kind mutual pair into one edge with both arrows and both directions' evidence", () => {
    const forward = wire("f", "a", "b", "calls", { weight: 5, opacity: 1 });
    const backward = wire("b", "b", "a", "calls", { weight: 2 });
    const fused = fuseCycles([forward, backward, wire("solo", "a", "c", "calls")]);
    expect(fused.map((edge) => edge.id)).toEqual(["cycle:calls:a<->b", "solo"]);
    const cycle = fused[0];
    expect(cycle.type).toBe(CYCLE_EDGE_TYPE);
    expect(cycle.markerEnd).toBe("marker-f");
    expect(cycle.markerStart).toBe("marker-b");
    const data = cycle.data as CycleEdgeData;
    expect([data.forwardWeight, data.backwardWeight]).toEqual([5, 2]);
    expect((data as { underlyingEdgeIds?: string[] }).underlyingEdgeIds).toEqual(["f", "b"]);
    expect((cycle.style as { opacity?: number }).opacity).toBe(1); // the lit direction's emphasis wins
    expect(data.members.map((member) => member.id)).toEqual(["f", "b"]);
  });

  it("never fuses across kinds, one-way pairs, or typed edges", () => {
    const edges = [
      wire("call", "a", "b", "calls"),
      wire("ref", "b", "a", "references"), // opposite direction but different kind
      wire("one", "c", "d", "calls"),
      wire("t1", "e", "f", "calls", { type: "routed" }),
      wire("t2", "f", "e", "calls", { type: "routed" }),
    ];
    expect(fuseCycles(edges)).toEqual(edges);
  });

  it.each(["crossPackage", "outsideView"] as const)("ORs %s from both directions and dashes independently of the lit side", (flag) => {
    const forward = wire("f", "a", "b", "calls", { opacity: 1 });
    const backward = wire("b", "b", "a", "calls", { [flag]: true });
    const [cycle] = fuseCycles([forward, backward]);
    expect(cycle.data).toMatchObject({ [flag]: true });
    expect(cycle.style?.opacity).toBe(1);
    expect(cycle.style?.strokeDasharray).toBe(BOUNDARY_DASH_PATTERN);
  });

  it("removes a stale/legacy dash when neither semantic boundary flag is set", () => {
    const [cycle] = fuseCycles([
      wire("f", "a", "b", "calls", { opacity: 1, staleDash: "1 1" }),
      wire("b", "b", "a", "calls"),
    ]);
    expect(cycle.style?.strokeDasharray).toBeUndefined();
  });

  it("a self-loop wire never fuses with itself", () => {
    const loop = wire("loop", "a", "a", "calls");
    expect(fuseCycles([loop])).toEqual([loop]);
  });
});
