import { describe, expect, it } from "vitest";
import type { Node } from "@xyflow/react";
import { decorateGhostGroupToggles, shouldVirtualizeCanvasNodes } from "./GraphSurface";
import { MINIMAP_NODE_CAP } from "./flowCanvasProps";

function node(id: string, type: string, x: number): Node {
  return { id, type, position: { x, y: 12 }, data: { label: id }, style: { width: 180, height: 50 } };
}

describe("decorateGhostGroupToggles", () => {
  it("attaches the explicit disclosure action only to grouped parent ghosts", () => {
    const core = node("core", "file", 40);
    const exact = node("ghost", "ghost", 260);
    const parent = {
      ...node("parent", "ghost", 460),
      data: { label: "parent", ghostGroupId: "parent", ghostExpanded: false },
    };
    const nodes = [core, exact, parent];
    const toggle = () => undefined;

    const decorated = decorateGhostGroupToggles(nodes, toggle);

    expect(decorated).not.toBe(nodes);
    expect(decorated[0]).toBe(core);
    expect(decorated[1]).toBe(exact);
    expect(decorated[2]).not.toBe(parent);
    expect(decorated[2]).toMatchObject({ id: parent.id, type: "ghost", position: parent.position, style: parent.style });
    expect(decorated[2].position).toBe(parent.position);
    expect((decorated[2].data as { toggleGhostGroup?: unknown }).toggleGhostGroup).toBe(toggle);
    expect((parent.data as { toggleGhostGroup?: unknown }).toggleGhostGroup).toBeUndefined();
  });

  it("returns the original paint array when no grouped parent is present", () => {
    const nodes = [node("same-id", "file", 0), node("ghost", "ghost", 200)];
    expect(decorateGhostGroupToggles(nodes, () => undefined)).toBe(nodes);
  });
});

describe("shouldVirtualizeCanvasNodes", () => {
  it("preserves canvas/MiniMap parity through the MiniMap cap and virtualizes denser graphs", () => {
    expect(shouldVirtualizeCanvasNodes(MINIMAP_NODE_CAP - 1)).toBe(false);
    expect(shouldVirtualizeCanvasNodes(MINIMAP_NODE_CAP)).toBe(false);
    expect(shouldVirtualizeCanvasNodes(MINIMAP_NODE_CAP + 1)).toBe(true);
  });
});
