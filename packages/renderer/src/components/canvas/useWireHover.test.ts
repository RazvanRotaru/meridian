import type { Edge } from "@xyflow/react";
import { describe, expect, it } from "vitest";
import { GHOST_HIERARCHY_EDGE_TYPE } from "../edges/GhostHierarchyEdge";
import { RIBBON_EDGE_TYPE } from "../../layout/parallelWires";
import { BUNDLE_EDGE_TYPE } from "../../layout/edgeBundling";
import { GHOST_HIERARCHY_EDGE_ROLE } from "./presentationEdges";
import {
  INCOMING_CALL_SPOTLIGHT_Z,
  MODIFIER_GATED_EDGE_CLASS,
  SELECTED_NODE_EDGE_Z,
  applyIncomingCallSpotlight,
  gateWireClickInteraction,
  raiseSelectedNodeEdges,
  requestWireInspectionEnd,
  retainedInspectedEdge,
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

describe("gateWireClickInteraction", () => {
  it("removes edge hit targets until the primary modifier is held", () => {
    const named = { ...call, className: "existing" };
    const result = gateWireClickInteraction([named, unrelated], true);

    expect(result).not.toEqual([named, unrelated]);
    expect(result[0]).toMatchObject({
      interactionWidth: 0,
      className: `existing ${MODIFIER_GATED_EDGE_CLASS}`,
    });
    expect(result[1]).toMatchObject({
      interactionWidth: 0,
      className: MODIFIER_GATED_EDGE_CLASS,
    });
  });

  it("preserves the exact edge array while modifier interaction is available", () => {
    const input = [call, unrelated];
    expect(gateWireClickInteraction(input, false)).toBe(input);
  });
});

describe("raiseSelectedNodeEdges", () => {
  it("raises only semantic wires incident to the selected node above the card layer", () => {
    const input = [call, unrelated, hierarchy];
    const result = raiseSelectedNodeEdges(input, new Set(["a", "frame"]));

    expect(result).not.toBe(input);
    expect(result[0]).toEqual({
      ...call,
      zIndex: SELECTED_NODE_EDGE_Z,
      interactionWidth: 0,
    });
    expect(result[1]).toBe(unrelated);
    expect(result[2]).toBe(hierarchy);
  });

  it("raises an aggregate that represents an exact selected ghost", () => {
    const represented: Edge = {
      id: "represented",
      source: "grouped-ghost",
      target: "target",
      data: {
        ghostGroupAggregate: true,
        groupedGhostIds: ["exact-ghost"],
      },
    };
    const aggregate: Edge = {
      id: "aggregate",
      source: "grouped-ghost",
      target: "target",
      data: { members: [represented] },
    };

    expect(raiseSelectedNodeEdges([aggregate], new Set(["exact-ghost"]))[0])
      .toMatchObject({ zIndex: SELECTED_NODE_EDGE_Z });
  });

  it("keeps the original edge array when selection has no represented wire", () => {
    const input = [call, unrelated];
    expect(raiseSelectedNodeEdges(input, new Set())).toBe(input);
    expect(raiseSelectedNodeEdges(input, new Set(["missing"]))).toBe(input);
  });

  it("preserves a deliberately higher local layer without cloning", () => {
    const alreadyHigher = {
      ...call,
      zIndex: SELECTED_NODE_EDGE_Z + 1,
      interactionWidth: 0,
    };
    const input = [alreadyHigher];

    expect(raiseSelectedNodeEdges(input, new Set(["a"]))).toBe(input);
  });
});

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

describe("retainedInspectedEdge", () => {
  it("keeps an inspection across edge-object re-derivation and releases a removed strand", () => {
    const refreshed = { ...call, data: { ...call.data, refreshed: true } };

    expect(retainedInspectedEdge(call, [unrelated, refreshed])).toBe(refreshed);
    expect(retainedInspectedEdge(call, [unrelated])).toBeNull();
    expect(retainedInspectedEdge(null, [call])).toBeNull();
  });

  it("retains a drilled constituent through its freshly derived owning bundle", () => {
    const refreshed = { ...call, data: { ...call.data, refreshed: true } };
    const bundle: Edge = {
      id: "bundle",
      source: "source-parent",
      target: "target-parent",
      type: BUNDLE_EDGE_TYPE,
      data: { constituents: [unrelated, refreshed] },
    };

    expect(retainedInspectedEdge(call, [bundle])).toBe(refreshed);
  });
});

describe("requestWireInspectionEnd", () => {
  it("replays local unpin and global evidence dismissal together after admission", () => {
    const calls: string[] = [];
    const pending: Array<() => void> = [];

    requestWireInspectionEnd(
      (transition) => {
        pending.push(transition);
        return false;
      },
      () => calls.push("local"),
      () => calls.push("global"),
    );

    expect(calls).toEqual([]);
    expect(pending).toHaveLength(1);
    pending[0]!();
    expect(calls).toEqual(["local", "global"]);
  });
});
