import { describe, expect, it } from "vitest";
import type { Edge, Node } from "@xyflow/react";
import { emphasizeFlow, renderedIdsForFlowEmphasis } from "./flowEmphasisPaint";

function node(id: string, parentId?: string): Node {
  return { id, parentId, position: { x: 0, y: 0 }, data: {} } as Node;
}

function edge(source: string, target: string): Edge {
  return { id: `${source}->${target}`, source, target, data: {} } as Edge;
}

describe("emphasizeFlow", () => {
  it("returns the original arrays when there is no emphasis", () => {
    const nodes = [node("a"), node("b")];
    const edges = [edge("a", "b")];
    const styled = emphasizeFlow(nodes, edges, new Set());
    expect(styled.nodes).toBe(nodes);
    expect(styled.edges).toBe(edges);
  });

  it("keeps ancestors opaque, outlines emphasized nodes, and dims unrelated nodes", () => {
    const nodes = [node("pkg"), node("mod", "pkg"), node("run", "mod"), node("other", "mod")];
    const styled = emphasizeFlow(nodes, [], new Set(["run"])).nodes;
    expect(styled.find((n) => n.id === "pkg")?.style?.opacity).toBe(1);
    expect(styled.find((n) => n.id === "mod")?.style?.opacity).toBe(1);
    expect(styled.find((n) => n.id === "run")?.style?.boxShadow).toContain("#56C271");
    expect(styled.find((n) => n.id === "other")?.style?.opacity).toBe(0.35);
  });

  it("lights only edges whose rendered endpoints are both emphasized", () => {
    const edges = [edge("run", "leaf"), edge("run", "other")];
    const styled = emphasizeFlow([], edges, new Set(["run", "leaf"])).edges;
    expect(styled.find((e) => e.id === "run->leaf")?.style?.opacity).toBe(1);
    expect(styled.find((e) => e.id === "run->other")?.style?.opacity).toBe(0.14);
  });
});

describe("renderedIdsForFlowEmphasis", () => {
  it("uses rendered emphasized nodes directly", () => {
    const nodes = [node("pkg"), node("mod", "pkg"), node("run", "mod")];
    const parentOf = new Map([
      ["pkg", null],
      ["mod", "pkg"],
      ["run", "mod"],
    ]);

    expect(renderedIdsForFlowEmphasis(nodes, new Set(["run", "mod"]), parentOf)).toEqual(["run", "mod"]);
  });

  it("lifts hidden emphasized ids to their nearest rendered ancestor and dedupes", () => {
    const nodes = [node("pkg"), node("mod", "pkg")];
    const parentOf = new Map([
      ["pkg", null],
      ["mod", "pkg"],
      ["run", "mod"],
      ["helper", "mod"],
    ]);

    expect(renderedIdsForFlowEmphasis(nodes, new Set(["run", "helper", "missing"]), parentOf)).toEqual(["mod"]);
  });
});
