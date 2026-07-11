import { describe, expect, it } from "vitest";
import type { Node } from "@xyflow/react";
import { decorateInspectedGhost } from "./GraphSurface";

function node(id: string, type: string, x: number): Node {
  return { id, type, position: { x, y: 12 }, data: { label: id }, style: { width: 180, height: 50 } };
}

describe("decorateInspectedGhost", () => {
  it("marks only the matching ghost without changing identity or geometry", () => {
    const core = node("core", "file", 40);
    const ghost = node("ghost", "ghost", 260);
    const nodes = [core, ghost];

    const decorated = decorateInspectedGhost(nodes, ghost.id);

    expect(decorated).not.toBe(nodes);
    expect(decorated[0]).toBe(core);
    expect(decorated[1]).not.toBe(ghost);
    expect(decorated[1]).toMatchObject({ id: ghost.id, type: "ghost", position: ghost.position, style: ghost.style });
    expect(decorated[1].position).toBe(ghost.position);
    expect((decorated[1].data as { inspected?: boolean }).inspected).toBe(true);
    expect((ghost.data as { inspected?: boolean }).inspected).toBeUndefined();
  });

  it("returns the original paint array when inspection is absent or no ghost matches", () => {
    const nodes = [node("same-id", "file", 0), node("ghost", "ghost", 200)];
    expect(decorateInspectedGhost(nodes, null)).toBe(nodes);
    expect(decorateInspectedGhost(nodes, "missing")).toBe(nodes);
    expect(decorateInspectedGhost(nodes, "same-id")).toBe(nodes);
  });
});
