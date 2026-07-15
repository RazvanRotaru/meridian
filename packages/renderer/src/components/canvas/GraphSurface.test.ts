import { describe, expect, it } from "vitest";
import { logicEdgeTypes } from "../edges/AsyncRailEdge";
import { moduleNodeTypes } from "../nodes/modulemap/ModuleCardNode";
import { moduleEdgeTypes, shouldVirtualizeCanvasNodes } from "./GraphSurface";
import { MINIMAP_NODE_CAP } from "./flowCanvasProps";

describe("shouldVirtualizeCanvasNodes", () => {
  it("preserves canvas/MiniMap parity through the MiniMap cap and virtualizes denser graphs", () => {
    expect(shouldVirtualizeCanvasNodes(MINIMAP_NODE_CAP - 1)).toBe(false);
    expect(shouldVirtualizeCanvasNodes(MINIMAP_NODE_CAP)).toBe(false);
    expect(shouldVirtualizeCanvasNodes(MINIMAP_NODE_CAP + 1)).toBe(true);
  });
});

describe("graph surface interaction boundaries", () => {
  it("keeps execution edge disclosures and fold nodes out of Map, Service, UI, and minimal graphs", () => {
    const logicEdgeTypeNames = new Set(Object.keys(logicEdgeTypes));
    const sharedMapEdgeTypeNames = Object.keys(moduleEdgeTypes);

    expect(sharedMapEdgeTypeNames.filter((type) => logicEdgeTypeNames.has(type))).toEqual([]);
    expect(Object.keys(moduleNodeTypes)).not.toContain("fold");
  });
});
