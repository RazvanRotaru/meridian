import { describe, expect, it } from "vitest";
import { logicEdgeTypes } from "../edges/AsyncRailEdge";
import { moduleNodeTypes } from "../nodes/modulemap/ModuleCardNode";
import { moduleEdgeTypes, shouldVirtualizeCanvasNodes } from "./GraphSurface";
import {
  MINIMAP_MIN_SURFACE_HEIGHT,
  MINIMAP_MIN_SURFACE_WIDTH,
  MINIMAP_NODE_CAP,
  LEGEND_MIN_SURFACE_WIDTH,
  shouldShowMapLegend,
  shouldShowMiniMap,
} from "./flowCanvasProps";

describe("shouldVirtualizeCanvasNodes", () => {
  it("preserves canvas/MiniMap parity through the MiniMap cap and virtualizes denser graphs", () => {
    expect(shouldVirtualizeCanvasNodes(MINIMAP_NODE_CAP - 1)).toBe(false);
    expect(shouldVirtualizeCanvasNodes(MINIMAP_NODE_CAP)).toBe(false);
    expect(shouldVirtualizeCanvasNodes(MINIMAP_NODE_CAP + 1)).toBe(true);
  });
});

describe("shouldShowMiniMap", () => {
  it("retires passive bottom chrome before it can squeeze a narrow or short action bar", () => {
    expect(shouldShowMiniMap(true, MINIMAP_MIN_SURFACE_WIDTH, MINIMAP_MIN_SURFACE_HEIGHT)).toBe(true);
    expect(shouldShowMiniMap(true, MINIMAP_MIN_SURFACE_WIDTH - 1, MINIMAP_MIN_SURFACE_HEIGHT)).toBe(false);
    expect(shouldShowMiniMap(true, MINIMAP_MIN_SURFACE_WIDTH, MINIMAP_MIN_SURFACE_HEIGHT - 1)).toBe(false);
    expect(shouldShowMiniMap(false, 1600, 1000)).toBe(false);
  });

  it("retires the wider Legend until its expanded card can share the fixed bottom lane", () => {
    expect(shouldShowMapLegend(LEGEND_MIN_SURFACE_WIDTH, MINIMAP_MIN_SURFACE_HEIGHT)).toBe(true);
    expect(shouldShowMapLegend(LEGEND_MIN_SURFACE_WIDTH, MINIMAP_MIN_SURFACE_HEIGHT, true)).toBe(false);
    expect(shouldShowMapLegend(LEGEND_MIN_SURFACE_WIDTH - 1, MINIMAP_MIN_SURFACE_HEIGHT)).toBe(false);
    expect(shouldShowMapLegend(LEGEND_MIN_SURFACE_WIDTH, MINIMAP_MIN_SURFACE_HEIGHT - 1)).toBe(false);
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
