import { describe, expect, it } from "vitest";
import { shouldVirtualizeCanvasNodes } from "./GraphSurface";
import { MINIMAP_NODE_CAP } from "./flowCanvasProps";

describe("shouldVirtualizeCanvasNodes", () => {
  it("preserves canvas/MiniMap parity through the MiniMap cap and virtualizes denser graphs", () => {
    expect(shouldVirtualizeCanvasNodes(MINIMAP_NODE_CAP - 1)).toBe(false);
    expect(shouldVirtualizeCanvasNodes(MINIMAP_NODE_CAP)).toBe(false);
    expect(shouldVirtualizeCanvasNodes(MINIMAP_NODE_CAP + 1)).toBe(true);
  });
});
