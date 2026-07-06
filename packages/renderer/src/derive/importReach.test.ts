/**
 * The blast-radius BFS: min hop-depth per reachable file, the maxDepth cap, unlimited walks, and the
 * cycle guard that keeps an import loop from hanging. Graphs are built directly since the walk only
 * reads `out`.
 */

import { describe, expect, it } from "vitest";
import type { ModuleGraph } from "./moduleGraph";
import { computeReach } from "./importReach";

function graphOf(adjacency: Record<string, string[]>): ModuleGraph {
  const out = new Map<string, Set<string>>();
  for (const [source, targets] of Object.entries(adjacency)) {
    out.set(source, new Set(targets));
  }
  return { fileIds: new Set(Object.keys(adjacency)), out, in: new Map(), weight: new Map() };
}

describe("computeReach", () => {
  it("stamps each file with its min hop-depth from the root", () => {
    const graph = graphOf({ A: ["B", "C"], B: ["D"], C: ["D"], D: [] });
    expect(computeReach(graph, "A", null)).toEqual(new Map([["A", 0], ["B", 1], ["C", 1], ["D", 2]]));
  });

  it("takes the shorter of two paths to the same file", () => {
    const graph = graphOf({ A: ["B", "C"], B: ["C"], C: [] });
    expect(computeReach(graph, "A", null).get("C")).toBe(1);
  });

  it("caps the walk at maxDepth", () => {
    const graph = graphOf({ A: ["B"], B: ["C"], C: ["D"], D: [] });
    expect(computeReach(graph, "A", 1)).toEqual(new Map([["A", 0], ["B", 1]]));
  });

  it("returns only the root at maxDepth 0", () => {
    const graph = graphOf({ A: ["B"], B: [] });
    expect(computeReach(graph, "A", 0)).toEqual(new Map([["A", 0]]));
  });

  it("walks the whole graph when maxDepth is null", () => {
    const graph = graphOf({ A: ["B"], B: ["C"], C: ["D"], D: [] });
    expect([...computeReach(graph, "A", null).keys()].sort()).toEqual(["A", "B", "C", "D"]);
  });

  it("terminates on an import cycle instead of hanging", () => {
    const graph = graphOf({ A: ["B"], B: ["A"] });
    expect(computeReach(graph, "A", null)).toEqual(new Map([["A", 0], ["B", 1]]));
  });

  it("keeps a root that imports nothing at depth 0", () => {
    expect(computeReach(graphOf({ A: [] }), "A", null)).toEqual(new Map([["A", 0]]));
  });
});
