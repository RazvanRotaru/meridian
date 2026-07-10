import { describe, expect, it } from "vitest";
import type { ElkNode } from "elkjs/lib/elk-api";
import { buildNestedElkGraph, type ElkNestAdapter } from "./elkNesting";

type N = { id: string; parent: string | null; container: boolean };

const NODES: N[] = [
  { id: "frame", parent: null, container: true },
  { id: "leaf", parent: "frame", container: false },
];

const base: ElkNestAdapter<N> = {
  id: (n) => n.id,
  parentId: (n) => n.parent,
  isContainer: (n) => n.container,
  leafSize: () => ({ width: 100, height: 40 }),
  containerOptions: { "elk.padding": "[top=44]" },
};

function find(graph: ElkNode, id: string): ElkNode | undefined {
  const stack = [...(graph.children ?? [])];
  while (stack.length) {
    const node = stack.pop() as ElkNode;
    if (node.id === id) return node;
    stack.push(...(node.children ?? []));
  }
  return undefined;
}

describe("buildNestedElkGraph — container min-size floor", () => {
  it("feeds containerMinSize to ELK as a MINIMUM_SIZE floor, keeping the base options", () => {
    const adapter = { ...base, containerMinSize: () => ({ width: 260, height: 54 }) };
    const frame = find(buildNestedElkGraph(NODES, [], adapter, {}), "frame");
    expect(frame?.layoutOptions?.["elk.nodeSize.constraints"]).toBe("MINIMUM_SIZE");
    expect(frame?.layoutOptions?.["elk.nodeSize.minimum"]).toBe("(260,54)");
    expect(frame?.layoutOptions?.["elk.padding"]).toBe("[top=44]");
  });

  it("omits the floor when no containerMinSize is given, so other pipelines are unaffected", () => {
    const frame = find(buildNestedElkGraph(NODES, [], base, {}), "frame");
    expect(frame?.layoutOptions).toEqual({ "elk.padding": "[top=44]" });
  });

  it("floors only the container — leaves keep their explicit width, containers stay children-sized", () => {
    const adapter = { ...base, containerMinSize: () => ({ width: 260, height: 54 }) };
    const graph = buildNestedElkGraph(NODES, [], adapter, {});
    expect(find(graph, "frame")?.width).toBeUndefined();
    expect(find(graph, "leaf")?.width).toBe(100);
  });
});
