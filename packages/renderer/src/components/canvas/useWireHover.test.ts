import type { Edge } from "@xyflow/react";
import { describe, expect, it } from "vitest";
import { GHOST_HIERARCHY_EDGE_TYPE } from "../edges/GhostHierarchyEdge";
import { RIBBON_EDGE_TYPE } from "../../layout/parallelWires";
import { GHOST_HIERARCHY_EDGE_ROLE } from "./presentationEdges";
import {
  INCOMING_CALL_SPOTLIGHT_Z,
  applyIncomingCallSpotlight,
} from "./useWireHover";

const CALL_ID = "calls:a->target";
const call: Edge = {
  id: "wire:call",
  source: "a",
  target: "target",
  interactionWidth: 14,
  style: { opacity: 0.16, strokeWidth: 1.1 },
  data: { underlyingEdgeIds: [CALL_ID] },
};
const unrelated: Edge = {
  id: "wire:unrelated",
  source: "other",
  target: "target",
  data: { underlyingEdgeIds: ["references:other->target"] },
};
const hierarchy: Edge = {
  id: "hierarchy",
  source: "frame",
  target: "member",
  type: GHOST_HIERARCHY_EDGE_TYPE,
  data: { edgeRole: GHOST_HIERARCHY_EDGE_ROLE, underlyingEdgeIds: [CALL_ID] },
};

describe("applyIncomingCallSpotlight", () => {
  it("raises and brightens only matching semantic wires without covering card hit targets", () => {
    const input = [call, unrelated, hierarchy];
    const result = applyIncomingCallSpotlight(input, new Set([CALL_ID]));

    expect(result).not.toBe(input);
    expect(result[0]).toMatchObject({
      zIndex: INCOMING_CALL_SPOTLIGHT_Z,
      interactionWidth: 0,
      data: { callLensSpotlight: true, hidden: false },
      style: { opacity: 1, strokeWidth: 2.3, pointerEvents: "none" },
    });
    expect(result[1]).toBe(unrelated);
    expect(result[2]).toBe(hierarchy);
  });

  it("finds a call inside a ribbon and lights the whole cable", () => {
    const ribbon: Edge = {
      id: "ribbon",
      source: "a",
      target: "target",
      type: RIBBON_EDGE_TYPE,
      data: { members: [unrelated, call] },
    };

    const [result] = applyIncomingCallSpotlight([ribbon], new Set([CALL_ID]));
    expect(result).toMatchObject({
      zIndex: INCOMING_CALL_SPOTLIGHT_Z,
      interactionWidth: 0,
      data: { boosted: true, callLensSpotlight: true, hidden: false },
    });
  });

  it("returns the original array when the lens is closed or no painted wire matches", () => {
    const input = [call, unrelated];
    expect(applyIncomingCallSpotlight(input, new Set())).toBe(input);
    expect(applyIncomingCallSpotlight(input, new Set(["calls:missing"]))).toBe(input);
  });
});
