import { describe, expect, it } from "vitest";
import { idsToExpand, idsToCollapse, type ExpandableNode } from "./scopedExpansion";

// A two-level containment tree, all collapsed to start:
//   root  (container)
//     ├─ a  (container)  ├─ leaf-a1
//     └─ b  (container)
// Visible = only what the expansion state exposes. These fixtures describe the CURRENT visible
// frontier, so a collapsed container appears with its children ABSENT (never walked).
function collapsedFrontier(): ExpandableNode[] {
  return [
    { id: "root", parentId: null, isContainer: true, isExpanded: false },
  ];
}

// root expanded, its two children present but themselves collapsed.
function rootOpen(): ExpandableNode[] {
  return [
    { id: "root", parentId: null, isContainer: true, isExpanded: true },
    { id: "a", parentId: "root", isContainer: true, isExpanded: false },
    { id: "b", parentId: "root", isContainer: true, isExpanded: false },
  ];
}

// root + a expanded; a's leaf child is a non-container.
function twoLevelsOpen(): ExpandableNode[] {
  return [
    { id: "root", parentId: null, isContainer: true, isExpanded: true },
    { id: "a", parentId: "root", isContainer: true, isExpanded: true },
    { id: "leaf-a1", parentId: "a", isContainer: false, isExpanded: false },
    { id: "b", parentId: "root", isContainer: true, isExpanded: false },
  ];
}

describe("idsToExpand", () => {
  it("root scope opens the shallowest collapsed containers (one level)", () => {
    expect(idsToExpand(collapsedFrontier(), [null])).toEqual(["root"]);
  });

  it("root scope opens every visible collapsed container at once (one level everywhere)", () => {
    expect(new Set(idsToExpand(rootOpen(), [null]))).toEqual(new Set(["a", "b"]));
  });

  it("returns nothing when everything visible is already open", () => {
    const allOpen: ExpandableNode[] = [
      { id: "root", parentId: null, isContainer: true, isExpanded: true },
      { id: "a", parentId: "root", isContainer: true, isExpanded: true },
      { id: "leaf", parentId: "a", isContainer: false, isExpanded: false },
    ];
    expect(idsToExpand(allOpen, [null])).toEqual([]);
  });

  it("scoping to a collapsed selected card opens just that card", () => {
    expect(idsToExpand(rootOpen(), ["a"])).toEqual(["a"]);
  });

  it("scoping to an expanded card opens its collapsed children only (not siblings)", () => {
    expect(idsToExpand(twoLevelsOpen(), ["a"])).toEqual([]); // a's only child is a leaf
    // b is a sibling, out of scope, so root-scope would include it but a-scope does not.
    expect(idsToExpand(twoLevelsOpen(), ["root"])).toEqual(["b"]);
  });

  it("multi-select unions the scopes", () => {
    const nodes: ExpandableNode[] = [
      { id: "root", parentId: null, isContainer: true, isExpanded: true },
      { id: "a", parentId: "root", isContainer: true, isExpanded: false },
      { id: "b", parentId: "root", isContainer: true, isExpanded: false },
    ];
    expect(new Set(idsToExpand(nodes, ["a", "b"]))).toEqual(new Set(["a", "b"]));
  });
});

describe("idsToCollapse", () => {
  it("root scope closes EVERY open container in one click (full collapse)", () => {
    // root + a both open → both close; b is collapsed and leaf is not a container.
    expect(new Set(idsToCollapse(twoLevelsOpen(), [null]))).toEqual(new Set(["root", "a"]));
  });

  it("closes the single open container when only one level is open", () => {
    expect(idsToCollapse(rootOpen(), [null])).toEqual(["root"]);
  });

  it("returns nothing when nothing in scope is expanded", () => {
    expect(idsToCollapse(collapsedFrontier(), [null])).toEqual([]);
  });

  it("scoping to a card collapses that card and everything open under it", () => {
    // scope `root`: root and a are open → both returned.
    expect(new Set(idsToCollapse(twoLevelsOpen(), ["root"]))).toEqual(new Set(["root", "a"]));
    // scope `a`: only a is open within a's subtree (its child is a leaf) → just a.
    expect(idsToCollapse(twoLevelsOpen(), ["a"])).toEqual(["a"]);
  });

  it("returns a default-open descendant alongside its explicitly opened parent", () => {
    // XOR-based surfaces can contain a child that is open by default rather than through their
    // expansion set. A full collapse still returns both containers so the caller can close both.
    const defaultOpenTree: ExpandableNode[] = [
      { id: "call", parentId: null, isContainer: true, isExpanded: true },
      { id: "loop", parentId: "call", isContainer: true, isExpanded: true },
      { id: "step", parentId: "loop", isContainer: false, isExpanded: false },
    ];
    expect(new Set(idsToCollapse(defaultOpenTree, [null]))).toEqual(new Set(["call", "loop"]));
  });
});
