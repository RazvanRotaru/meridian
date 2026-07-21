import { describe, expect, it } from "vitest";
import { expandedSelectionByOneHop, selectionExpansionCount } from "./selectionExpansion";

const nodes = (...ids: string[]) => ids.map((id) => ({ id }));

describe("one-hop selection expansion", () => {
  it("unions exactly one undirected hop and waits for the next click before traversing again", () => {
    const edges = [
      { source: "a", target: "b" },
      { source: "b", target: "c" },
      { source: "d", target: "a" },
    ];
    const first = expandedSelectionByOneHop(new Set(["a"]), nodes("a", "b", "c", "d"), edges);
    expect(first).toEqual(new Set(["a", "b", "d"]));
    expect(expandedSelectionByOneHop(first, nodes("a", "b", "c", "d"), edges)).toEqual(
      new Set(["a", "b", "c", "d"]),
    );
  });

  it("deduplicates diamonds, parallel edges, and self-loops", () => {
    const selected = new Set(["a", "b"]);
    const edges = [
      { source: "a", target: "c" },
      { source: "b", target: "c" },
      { source: "a", target: "c" },
      { source: "a", target: "a" },
    ];
    expect(selectionExpansionCount(selected, nodes("a", "b", "c"), edges)).toBe(1);
  });

  it("ignores edges with hidden endpoints while preserving temporarily absent picks", () => {
    const selected = new Set(["a", "remember-me"]);
    const edges = [
      { source: "a", target: "hidden" },
      { source: "remember-me", target: "b" },
    ];
    expect(expandedSelectionByOneHop(selected, nodes("a", "b"), edges)).toEqual(selected);
  });

  it("expands through a visible paint-synthesized group edge", () => {
    const selected = new Set(["ghost-group:workers"]);
    const edges = [{ source: "origin", target: "ghost-group:workers" }];
    expect(expandedSelectionByOneHop(
      selected,
      nodes("origin", "ghost-group:workers"),
      edges,
    )).toEqual(new Set(["ghost-group:workers", "origin"]));
  });
});
