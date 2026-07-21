import { describe, expect, it } from "vitest";
import { logicSelectionActionScope } from "./LogicFlowView";

describe("Logic Flow action scope", () => {
  it("uses the whole visible flow when nothing is selected", () => {
    const scope = logicSelectionActionScope([
      logicNode("collapsed-call", { expandable: true, isExpanded: false }),
      logicNode("expanded-call", { expandable: true, isExpanded: true }),
      logicNode("leaf", { expandable: false, isExpanded: false }),
    ] as never, null);

    expect(scope).toEqual({
      nodeIds: [],
      canExpand: true,
      canCollapse: true,
    });
  });

  it("leaves unavailable whole-flow actions disabled when there are no disclosures", () => {
    const scope = logicSelectionActionScope([
      logicNode("leaf", { expandable: false, isExpanded: false }),
    ] as never, null);

    expect(scope).toEqual({
      nodeIds: [],
      canExpand: false,
      canCollapse: false,
    });
  });

  it("uses an exact occurrence selection, including targetless structural nodes", () => {
    const scope = logicSelectionActionScope([
      logicNode("selected-control", { expandable: true, isExpanded: false }),
      {
        ...logicNode("selected-child", { expandable: true, isExpanded: true }),
        parentId: "selected-control",
      },
      logicNode("peer", { expandable: true, isExpanded: false }),
    ] as never, "persisted-target", new Set(["selected-control"]));

    expect(scope).toEqual({
      nodeIds: ["selected-control"],
      canExpand: true,
      canCollapse: true,
    });
  });
});

function logicNode(
  id: string,
  disclosure: { expandable: boolean; isExpanded: boolean },
) {
  return {
    id,
    type: "block",
    position: { x: 0, y: 0 },
    data: {
      targetId: null,
      ...disclosure,
    },
  };
}
